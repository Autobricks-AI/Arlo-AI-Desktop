/**
 * WhatsApp over Baileys — the same protocol WhatsApp Web speaks. Several numbers can be
 * linked at once: each is a folder under WA_AUTH_DIR holding its label and its session,
 * and one live socket in this process.
 *
 * ponytail: the folder *is* the account record, so nothing can drift out of step with the
 * sessions actually on disk. Fine for a handful of numbers; it becomes a table the day
 * this has to be queried or shared between hosts.
 *
 * ---------------------------------------------------------------- what this reads
 *
 * **Every** conversation on the number, including the owner's personal ones. There is no
 * per-chat picker: a support number is linked to be read, and a message that never reaches
 * the inbox is a customer nobody answered.
 *
 * What decides whether anything is *said back* is the bot assigned to this connection on
 * the Chatbot page. With none assigned, the thread simply waits for a person.
 *
 * Only one process may hold a socket. WhatsApp enforces it — link the same session twice
 * and it kills one with a conflict — so every call that reaches a socket goes through
 * singleton(), which runs it in the cluster primary wherever it was called from.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import type { Conversation } from '../conversations.ts'
import { asSystem, withWorkspace } from '../db.ts'
import { byToken } from '../resources.ts'
import type { Sendable } from '../resources.ts'
import { identify } from '../customers.ts'
import { adoptBot, datePlacedFromMessages, markImported, open as openThread, record, removeConnection } from '../conversations.ts'
import { routeTo } from '../bot.ts'
import { add as attachFile } from '../attachments.ts'
import { live as holdsLiveLock, ownsSingletons, singleton } from '../singleton.ts'
import { handle as ask } from '../agent.ts'
import { MAX_BYTES } from '../attachments.ts'
import type { Incoming as File } from '../attachments.ts'

export const id = 'whatsapp'
export const label = 'WhatsApp'

const ROOT = process.env.WA_AUTH_DIR ?? '.wa-auth'
const LOGGED_OUT = 401

type Status = 'off' | 'starting' | 'qr' | 'online'

/** What we keep on disk about a link, beside the session Baileys writes. */
type Meta = {
  label: string
  phone: string | null
  workspace_id: number
  created_at: string
}

export type Account = Meta & {
  id: string
  status: Status
  /** A data: URL, present only while waiting to be scanned. */
  qr: string | null
  error: string | null
  /** When this number last had any traffic at all, and why the last message was not filed. */
  last_seen: string | null
  last_drop: string | null
}

// ---------------------------------------------------------------- on disk

const dir = (accountId: string) => path.join(ROOT, accountId)
const file = (accountId: string, name: string) => path.join(dir(accountId), name)

const readJson = <T>(p: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T
  } catch {
    return fallback
  }
}
const writeJson = (p: string, value: unknown) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(value, null, 2))
}

const readMeta = (accountId: string) => readJson<Meta | null>(file(accountId, 'meta.json'), null)
const writeMeta = (accountId: string, meta: Meta) => writeJson(file(accountId, 'meta.json'), meta)

/**
 * What the socket is doing, written down where another process can see it.
 *
 * The socket lives in one process — the cluster primary — and the page is rendered by
 * another. An in-memory status is therefore invisible to the reader: every worker reported
 * "off" and no QR, which the linking dialog correctly read as "that code expired", for a
 * code it had simply never been shown.
 *
 * So the owning process writes each change here and readers read it. The folder was
 * already the account record; this is one more file in it.
 */
type State = {
  status: Status
  qr: string | null
  error: string | null
  /** When this number last had *any* traffic, filed or not. */
  last_seen: string | null
  /** Why the last message was not filed, when it was not. The end of silent drops. */
  last_drop: string | null
}
const readState = (accountId: string) =>
  readJson<State>(file(accountId, 'state.json'), {
    status: 'off',
    qr: null,
    error: null,
    last_seen: null,
    last_drop: null,
  })
const writeState = (accountId: string, state: State) => writeJson(file(accountId, 'state.json'), state)

const ids = () => {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------- in memory

type Live = {
  sock: any
  /** The copy of this module that opened `sock`. See GEN. */
  gen: number
  qr: string | null
  status: Status
  error: string | null
  last_seen: string | null
  last_drop: string | null
  attempts: number
  starting: Promise<void> | null
  retry: NodeJS.Timeout | null
}

/**
 * On globalThis so a dev hot-reload does not start a second socket for the same number —
 * which WhatsApp would answer by killing one of them.
 */
const live: Map<string, Live> = ((globalThis as any).__arloWa ??= new Map())

/**
 * Which copy of this module opened a socket.
 *
 * Surviving a reload is the point of `live`, and also its trap: the socket's event handlers
 * were registered by the *previous* copy of this file and keep running its code — against a
 * database the migrations have since moved on. The symptom is a message that arrives,
 * never appears anywhere, and leaves an error on the card naming a column nobody has used
 * for an hour.
 *
 * So each copy stamps what it opens, and a socket stamped by an older copy is dead to this
 * one: it is closed and replaced, which is also what makes WhatsApp redeliver whatever it
 * queued while we were not listening.
 */
const GEN: number = ((globalThis as any).__arloWaGen = (((globalThis as any).__arloWaGen as number) ?? 0) + 1)

const runtime = (accountId: string): Live => {
  let l = live.get(accountId)
  if (!l)
    live.set(
      accountId,
      (l = {
        sock: null,
        gen: GEN,
        qr: null,
        status: 'off',
        error: null,
        last_seen: null,
        last_drop: null,
        attempts: 0,
        starting: null,
        retry: null,
      }),
    )
  return l
}

/**
 * Change what the socket is doing, in memory and on disk in one go.
 *
 * Every write to status, qr or error goes through here. A change that only lands in the
 * map is a change no other process — which is to say, no page — can see.
 */
function mark(accountId: string, patch: Partial<State>) {
  const l = runtime(accountId)
  Object.assign(l, patch)
  writeState(accountId, {
    status: l.status,
    qr: l.qr,
    error: l.error,
    last_seen: l.last_seen ?? null,
    last_drop: l.last_drop ?? null,
  })
}

/**
 * Say what happened to a message, always.
 *
 * Every silent `return` in this file cost an evening: a file was sent, nothing appeared, and
 * there was no way from outside the process to tell a dropped message from one that never
 * arrived. A message we decline to file is a decision, and a decision that leaves no trace
 * is indistinguishable from a bug.
 */
function trace(accountId: string, what: string, detail?: Record<string, unknown>) {
  const at = new Date().toISOString()
  console.log(`[whatsapp] ${accountId} ${what}${detail ? ' ' + JSON.stringify(detail) : ''}`)
  mark(accountId, { last_seen: at, last_drop: what.startsWith('dropped') ? what : null })
}

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))
const now = () => new Date().toISOString()

/** Baileys is chatty and none of it is ours. */
const quiet = { level: 'silent', child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} } as any

let wa: any = null

// ---------------------------------------------------------------- reading

/**
 * Synchronous, off disk, so a web worker can render the page without asking the primary —
 * and so it sees the same status the process holding the socket does.
 */
export const list = (workspaceId: number): Account[] =>
  ids()
    .map((accountId) => {
      const meta = readMeta(accountId)
      if (!meta || meta.workspace_id !== workspaceId) return null
      return { ...meta, id: accountId, ...readState(accountId) }
    })
    .filter((a): a is Account => !!a)

export const get = (workspaceId: number, accountId: string) => list(workspaceId).find((a) => a.id === accountId)

/**
 * The numbers that could actually carry a message — or `null` when that cannot be known.
 *
 * For the inbox tidy, which deletes threads whose connection is gone. Two things make this
 * stricter than `list()`, and both are the difference between cleaning up and losing data.
 *
 * **A folder is not a link.** `list()` reports any directory with a `meta.json`, and a
 * credential-less one is a real state: it is what an unlinked number leaves behind. Those
 * threads are exactly the ones being cleaned up, so `creds.json` is the test.
 *
 * **`null` is not `[]`.** `ids()` answers every failure with an empty list, so "nothing is
 * linked" and "the folder could not be read" are the same answer — and a tidy that trusted it
 * would answer one bad `readdir` by deleting every WhatsApp thread in the workspace. A
 * *missing* root is genuinely empty (nothing has ever been linked); anything else is unknown,
 * and unknown means touch nothing.
 */
export function linkedIds(workspaceId: number): string[] | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return []
    return null
  }
  return entries.filter((accountId) => {
    const meta = readMeta(accountId)
    return !!meta && meta.workspace_id === workspaceId && fs.existsSync(file(accountId, 'creds.json'))
  })
}


// ---------------------------------------------------------------- the socket

/** Idempotent — calling this while a socket is up or opening does nothing. */
/**
 * What to do when a start nobody awaited fails.
 *
 * All three callers below fire `start()` and walk away — a scheduled reconnect, a resume at
 * boot, and the one behind `add()`. `start()` rejects synchronously when `meta.json` is gone,
 * which the resume path can hit on its own: it gates on `creds.json` existing, and a folder
 * with credentials but a torn or missing `meta.json` is what a partial delete or a crash
 * mid-write leaves behind. Unawaited, that rejection is an unhandledRejection, and Node's
 * default is to kill the process — the *primary*, which holds every workspace's socket and
 * every advisory-lock singleton. One unlinked number would have taken the lot down.
 */
const whyStartFailed = (accountId: string) => (e: unknown) =>
  console.error(`[whatsapp] could not start ${accountId}:`, e instanceof Error ? e.message : e)

export function start(accountId: string): Promise<void> {
  /*
   * An account that does not exist is not one to open a socket for.
   *
   * `open()` reaches `useMultiFileAuthState(dir(accountId))`, which *creates* the directory
   * it is handed — so starting a removed account rebuilt its folder, wrote a `state.json`
   * through `mark()`, and left a credential-less zombie that `list()` then reported as a
   * number. Worse, the socket it opened was unauthenticated: a reply sent through it did not
   * fail cleanly but died somewhere inside Baileys reading `.id` of nothing, which reached
   * the inbox as "Cannot read properties of undefined".
   *
   * `meta.json` is what makes an account real — `addImpl` writes it before ever calling
   * here, and `removeFiles` takes it away — so its absence is the honest test.
   */
  if (!readMeta(accountId)) return Promise.reject(new Error('That WhatsApp number has been unlinked'))

  const l = runtime(accountId)
  // A socket an older copy of this module opened is not ours and is not trustworthy.
  if (l.sock && l.gen !== GEN) stop(accountId)
  if (l.sock) return Promise.resolve()
  if (l.starting) return l.starting
  // 'starting' before any awaiting happens: a dialog that polls must not read the
  // not-yet-opened socket as a link that failed.
  mark(accountId, { status: 'starting', error: null })
  l.starting = open(accountId)
    .catch((e) => mark(accountId, { status: 'off', error: say(e) }))
    .finally(() => {
      l.starting = null
    })
  return l.starting
}

async function open(accountId: string) {
  wa ??= await import('@whiskeysockets/baileys')
  const { state: auth, saveCreds } = await wa.useMultiFileAuthState(dir(accountId))

  const l = runtime(accountId)
  mark(accountId, { status: 'starting', error: null })

  const sock = wa.default({
    auth,
    logger: quiet,
    // Shows on the phone as "Arlo AI (Mac OS)". The OS slot is a conventional value that
    // WhatsApp maps; it is not a claim about this server.
    browser: wa.Browsers.macOS('Arlo AI'),
    /*
     * Ask for what is already on the phone.
     *
     * This was false, because linking must not replay years of chats *through the agent* —
     * which was the right worry and the wrong lever. The danger was never the history
     * arriving; it was the history reaching `ask()`. It no longer can: the listener below
     * files with `answer: false`, which stops short of the agent by construction.
     *
     * WhatsApp sends this once, as part of pairing. A number that is already linked has had
     * its one chance, which is why importing old chats means unlinking and scanning again.
     */
    syncFullHistory: true,
    // Leave notifications going to the owner's phone.
    markOnlineOnConnect: false,
  })
  l.sock = sock
  l.gen = GEN

  /** A socket we have already replaced must not write over its successor's state. */
  const current = () => runtime(accountId).sock === sock

  /*
   * Serialised, and guarded by `current()` like every other handler on this socket.
   *
   * `saveCreds` rewrites files under the account's directory, and Baileys emits `creds.update`
   * in bursts during a handshake — two overlapping writes can interleave and leave a
   * `creds.json` that parses as nothing, which is a linked number that silently stops working
   * and can only be fixed by scanning again. Chaining onto the previous save makes them run in
   * order at the cost of nothing; without `current()` a socket already replaced would write
   * over its successor's state, which is the same reason every handler below has it.
   */
  let saving: Promise<void> = Promise.resolve()
  sock.ev.on('creds.update', () => {
    if (!current()) return
    saving = saving
      .then(() => saveCreds())
      .catch((e) => console.error(`[whatsapp] could not save credentials for ${accountId}:`, e instanceof Error ? e.message : e))
  })
  sock.ev.on('connection.update', (u: any) => current() && void onConnection(accountId, u))
  /*
   * The backfill, in chunks, newest first.
   *
   * Awaited inside the handler rather than fired off: chunks arrive faster than they can be
   * filed, and letting them overlap would have several imports interleaving inserts for the
   * same chat.
   */
  sock.ev.on('messaging-history.set', async ({ messages, progress, syncType }: any) => {
    if (!current()) return
    const filed = await importHistory(accountId, messages ?? []).catch((e) => {
      mark(accountId, { error: say(e) })
      return 0
    })
    trace(accountId, 'history: filed a chunk', {
      of: messages?.length ?? 0,
      filed,
      progress: progress ?? null,
      syncType: syncType ?? null,
    })
  })

  /* Told outright when the backfill is done, rather than inferred from chunks stopping. */
  sock.ev.on('messaging-history.status', ({ syncType, status }: any) => {
    if (!current()) return
    trace(accountId, `history: ${status}`, { syncType: syncType ?? null })
  })

  sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
    if (!current()) return
    // 'append' is history backfill. Only 'notify' is genuinely new — but say so, because
    // "nothing arrived" and "something arrived and was skipped" look identical otherwise.
    if (type !== 'notify') return trace(accountId, `dropped: ${type} is not new mail`, { count: messages?.length ?? 0 })
    for (const m of messages) await handle(accountId, m).catch((e) => mark(accountId, { error: say(e) }))
  })
}

/** Exported so the close-handling rules are testable without a live socket. */
export async function onConnection(accountId: string, u: any) {
  const l = runtime(accountId)

  if (u.qr) {
    mark(accountId, { status: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }) })
  }

  if (u.connection === 'open') {
    mark(accountId, { status: 'online', qr: null, error: null })
    l.attempts = 0

    // Remember the number, so the card can name it even while the socket is down.
    const phone = l.sock?.user?.id?.split(':')[0] ?? null
    const meta = readMeta(accountId)
    if (meta && phone && meta.phone !== phone) writeMeta(accountId, { ...meta, phone })
  }

  if (u.connection === 'close') {
    const code = u.lastDisconnect?.error?.output?.statusCode
    l.sock = null
    mark(accountId, { status: 'off', qr: null })

    /*
     * The session is dead: the credentials will never open a socket again, so retrying with
     * them would spin forever.
     *
     * But dead credentials are not a removed account, and conflating the two cost a
     * production workspace every conversation on a number. This used to call `removeFiles`,
     * which deletes the whole directory — `meta.json` with it, and `meta.json` *is* the
     * account. So a phone re-pairing, or another device taking the session, made the number
     * vanish from the connectors page as though somebody had unlinked it, and the next
     * press of Refresh believed that and deleted its threads.
     *
     * So: the credentials go, the account stays. It shows on the page as a number that needs
     * scanning again, which is the truth, and `list()` still reports it so nothing downstream
     * mistakes it for a removal. Unlinking is a decision, and it has its own button.
     */
    if (code === LOGGED_OUT) {
      // Loud, because this path was silent and that is why it took an evening to find. The
      // file's own rule: a decision that leaves no trace is indistinguishable from a bug.
      trace(accountId, 'session ended by WhatsApp — credentials cleared, number kept', { code })
      dropCredentials(accountId)
      mark(accountId, {
        status: 'off',
        qr: null,
        error: 'WhatsApp ended this session. Scan the code again to reconnect this number.',
      })
      return
    }

    /*
     * Everything else is worth retrying: a dropped network, a restart at the other end.
     * Backed off and capped, because a number that is genuinely unreachable must not
     * become a reconnect loop in the logs.
     */
    l.attempts++
    if (l.attempts > 8) {
      mark(accountId, { error: 'Gave up reconnecting. Reload the page to try again.' })
      return
    }
    const wait = Math.min(30_000, 2 ** l.attempts * 500)
    l.retry = setTimeout(() => void start(accountId).catch(whyStartFailed(accountId)), wait)
    l.retry.unref?.()
  }
}

function stop(accountId: string) {
  const l = live.get(accountId)
  if (l?.retry) {
    clearTimeout(l.retry)
    l.retry = null
  }
  const sock = l?.sock
  if (!l || !sock) return
  // Cleared first: the guard in open() keeps this socket's dying events from writing over
  // its replacement's state.
  l.sock = null
  mark(accountId, { status: 'off', qr: null })
  try {
    sock.end?.(undefined)
  } catch {}
}

const removeFiles = (accountId: string) => {
  stop(accountId)
  live.delete(accountId)
  fs.rmSync(dir(accountId), { recursive: true, force: true })
}

/**
 * Forget how to open the socket, without forgetting the number.
 *
 * For a session WhatsApp has ended. Everything Baileys wrote goes — `creds.json` and the
 * `*.json` key files beside it, none of which will authenticate again — while `meta.json`
 * and `state.json` stay, because those are the account and what it is doing, not the
 * session.
 *
 * The distinction is the fix for a real incident: `removeFiles` here took `meta.json` too,
 * so a number whose session dropped disappeared from the connectors page exactly as though
 * somebody had unlinked it, and the inbox tidy then deleted its conversations on that
 * reading. An account that needs re-scanning must still look like an account.
 */
const dropCredentials = (accountId: string) => {
  stop(accountId)
  const l = runtime(accountId)
  l.sock = null

  try {
    for (const name of fs.readdirSync(dir(accountId))) {
      // Everything Baileys owns. `meta.json` and `state.json` are ours and are kept.
      if (name === 'meta.json' || name === 'state.json') continue
      fs.rmSync(path.join(dir(accountId), name), { recursive: true, force: true })
    }
  } catch (e) {
    // A directory that cannot be read is one there is nothing to clear in. The account row
    // matters more than the tidiness of the folder, so this never throws into the caller.
    trace(accountId, 'could not clear the dead session', { error: say(e) })
  }
}

// ---------------------------------------------------------------- inbound

/**
 * The message inside the envelope.
 *
 * WhatsApp rarely sends a bare message any more. A document with a caption arrives as a
 * `documentWithCaptionMessage` wrapping the real one; a disappearing chat wraps everything
 * in `ephemeralMessage`; view-once and edited messages have their own. Reading the inner
 * types directly means a file arrives, decrypts, and is dropped as "no text" — which is
 * exactly what happened to the first document anybody sent.
 *
 * The list mirrors Baileys' own `normalizeMessageContent`, kept here rather than imported
 * so `parse` stays pure and every shape is testable without the library.
 */
export function unwrap(content: any): any {
  // Bounded, because a hostile or broken message must not become an infinite loop.
  for (let depth = 0; depth < 5 && content; depth++) {
    const inner =
      content.ephemeralMessage ??
      content.viewOnceMessage ??
      content.documentWithCaptionMessage ??
      content.viewOnceMessageV2 ??
      content.viewOnceMessageV2Extension ??
      content.editedMessage ??
      content.associatedChildMessage ??
      content.groupStatusMessage ??
      content.groupStatusMessageV2
    if (!inner?.message) return content
    content = inner.message
  }
  return content
}

/** What WhatsApp calls a media message, and what we would file it as. */
export type Media = { kind: string; name: string; mime: string | null; size: number }

export type Parsed = {
  jid: string
  /**
   * Sent *by* this number rather than to it.
   *
   * Not a reason to discard it. A shared support number gets answered from the phone as
   * well as from the inbox, and a thread that shows only one side of that is a thread
   * nobody can pick up. `handle` files these as outbound; the bot never sees them.
   */
  fromMe: boolean
  /**
   * Their actual number, when WhatsApp tells us.
   *
   * A JID is usually the number — except a @lid, which is a privacy id whose digits mean
   * nothing to anybody: "281337671979107" is not a phone number and never was. WhatsApp
   * sends the real one alongside as `remoteJidAlt`, and where it does not, the session
   * holds a lid-to-number mapping we can ask. Both are best effort; a contact with no
   * number is honest, a contact with a fake one is not.
   */
  phone: string | null
  senderName: string | null
  text: string
  messageId: string
  /** When WhatsApp says it was sent, not when we got round to it. */
  at: Date | null
  /**
   * The file on this message, described but not downloaded.
   *
   * Downloading needs the socket, which `parse` deliberately does not have — this stays
   * pure so every shape WhatsApp sends is testable without one.
   */
  media: Media | null
}

/**
 * The media on a message, whatever kind it is.
 *
 * A sticker is not a question and never was, so it stays out. Everything else a person can
 * deliberately attach — a photo of a broken part, a receipt, a voice note — is a message
 * even when they send it without a word.
 */
export function mediaOf(content: any, messageId: string): Media | null {
  const candidates: [string, any][] = [
    ['document', content?.documentMessage],
    ['image', content?.imageMessage],
    ['video', content?.videoMessage],
    ['audio', content?.audioMessage],
  ]
  for (const [kind, node] of candidates) {
    if (!node) continue
    const mime: string | null = node.mimetype ?? null
    // Only documents carry a filename; the rest get one that says what they are, with the
    // extension their mime type implies so a download opens in the right thing.
    const ext = mime?.split('/')[1]?.split(';')[0]
    return {
      kind,
      name: node.fileName ?? `${kind}-${messageId}${ext ? `.${ext}` : ''}`,
      mime,
      size: Number(node.fileLength ?? 0),
    }
  }
  return null
}

/** The digits of a phone JID, or null for anything that is not one. */
const digits = (jid: string | undefined | null) =>
  jid && jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : null

/**
 * Pull what we need out of a Baileys message. Pure, so every shape WhatsApp sends is
 * testable without a socket.
 *
 * Returns null for our own messages, for empty ones, and for anything that is not text —
 * a sticker is not a question.
 */
export function parse(m: any): Parsed | null {
  if (!m) return null
  const jid: string = m.key?.remoteJid ?? ''
  if (!jid || jid === 'status@broadcast') return null

  const content = unwrap(m.message ?? {})
  const text: string =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ''

  const media = mediaOf(content, m.key?.id ?? '')
  // A file on its own is a message; a sticker with no caption still is not.
  if (!text.trim() && !media) return null

  return {
    jid,
    fromMe: !!m.key?.fromMe,
    // Seconds since the epoch, and sometimes a Long rather than a number.
    at: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : null,
    // The chat's own JID first; for a @lid chat, the alternate one WhatsApp sends with it.
    phone: digits(jid) ?? digits(m.key?.remoteJidAlt) ?? digits(m.key?.senderPn),
    senderName: m.pushName ?? null,
    text: text.trim() || `[sent ${media!.name}]`,
    messageId: `whatsapp:${jid}:${m.key?.id ?? ''}`,
    media,
  }
}

/**
 * Pull the bytes down off WhatsApp.
 *
 * Media is encrypted on their servers and Baileys does the decryption, which is why this
 * needs the library rather than a fetch. Best effort: an expired or unreachable file leaves
 * a row that names it, which is what somebody needs before asking the customer to resend.
 */
async function downloadMedia(accountId: string, m: any, media: Media): Promise<File> {
  const record: File = { name: media.name, mime: media.mime, size: media.size }
  if (media.size > MAX_BYTES) return record

  try {
    wa ??= await import('@whiskeysockets/baileys')
    const sock = runtime(accountId).sock
    const bytes = await wa.downloadMediaMessage(
      m,
      'buffer',
      {},
      { logger: quiet, reuploadRequest: sock?.updateMediaMessage },
    )
    if (bytes?.length) record.bytes = Buffer.from(bytes)
  } catch {
    // Left without bytes on purpose — see attachments.ts.
  }
  return record
}

/**
 * Ask the session what number is behind a @lid.
 *
 * Baileys keeps the mapping with the credentials — it is how it addresses these chats at
 * all — so this is a local lookup, not a request to WhatsApp. Best effort by design: an
 * unmapped lid means a contact without a number, which is the truth.
 */
async function phoneFor(accountId: string, jid: string): Promise<string | null> {
  if (!jid.endsWith('@lid')) return null
  const lid = jid.split('@')[0]

  try {
    const mapped = await runtime(accountId).sock?.signalRepository?.lidMapping?.getPNForLID?.(jid)
    const found = onlyDigits(mapped)
    if (found) return found
  } catch {
    // No socket, or a Baileys that keeps the mapping somewhere else. The file below is
    // the same data and does not need a connection — which is the case that matters,
    // because a replayed message arrives before anything else is ready.
  }

  /*
   * The mapping, straight off the session.
   *
   * Baileys writes it beside the credentials as `lid-mapping-<lid>_reverse`: it needs the
   * number to address the chat at all, so it is always there for a chat we can reply to.
   */
  return onlyDigits(readJson<string | null>(file(accountId, `lid-mapping-${lid}_reverse.json`), null))
}

/** A phone number out of whatever shape it arrived in, or null if there is none in it. */
const onlyDigits = (value: unknown) =>
  typeof value === 'string' ? (digits(value) ?? (value.replace(/\D/g, '') || null)) : null

/**
 * A message arrived. Decide, then file.
 *
 * The socket has no session, so the workspace comes from the folder's meta.json — which
 * is why a link records which workspace it belongs to at the moment it is created.
 *
 * `answer: false` files and stops there, which is what makes importing history possible at
 * all. The live path ends in `ask()` — the agent — so replaying a year of chats through this
 * function would have the bot compose a reply to every one of them. Backfill uses the same
 * parsing, the same identify/open/record, and the same rule that a message sent from the
 * phone is the *team* speaking; it simply never reaches the agent.
 *
 * `media: false` for the same reason at a different scale: downloading every attachment in a
 * full history is gigabytes and a very long stall, and old media keys frequently no longer
 * resolve. The message, its caption and its media type are filed; the bytes are not.
 */
export async function handle(
  accountId: string,
  m: any,
  { answer = true, media = true }: { answer?: boolean; media?: boolean } = {},
) {
  const meta = readMeta(accountId)
  if (!meta) return trace(accountId, 'dropped: no such linked number')

  const parsed = parse(m)
  if (!parsed) {
    const kinds = Object.keys(unwrap(m?.message ?? {}) ?? {})
    // A sticker, a reaction, a receipt: real traffic, nothing to file. Said out loud so
    // "nothing arrived" and "arrived, nothing to file" stop looking the same.
    return trace(accountId, 'dropped: nothing to file', { kinds, jid: m?.key?.remoteJid })
  }

  // Looked up before the scope opens: it reads the session on disk, not the database.
  const phone = parsed.phone ?? (await phoneFor(accountId, parsed.jid))
  const attachments = parsed.media && media ? [await downloadMedia(accountId, m, parsed.media)] : undefined

  trace(accountId, parsed.fromMe ? 'filed: sent from this number' : 'filed: inbound', {
    jid: parsed.jid,
    file: parsed.media?.name ?? null,
  })

  /*
   * Sent from the phone rather than to it.
   *
   * Filed as an outbound message on the same thread and nothing else: the customer is the
   * chat, not the sender, so the thread is opened against the counterparty exactly as an
   * inbound message would. The agent is never called — a person answering from their phone
   * is not a question, and the status stays where it was so nothing is silently handed over.
   *
   * Our own replies echo back here too. They carry the external id we stored when sending,
   * and `record` refuses a duplicate, so they file once.
   */
  if (parsed.fromMe)
    return withWorkspace({ workspaceId: meta.workspace_id }, async () => {
      const customer = await identify(meta.workspace_id, {
        channel: 'whatsapp',
        externalId: parsed.jid,
        phone,
      })
      const conversation = await openThread(
        meta.workspace_id,
        customer.id,
        'whatsapp',
        `${accountId}:${parsed.jid}`,
      )
      const filed = await record(meta.workspace_id, conversation.id, {
        direction: 'out',
        body: parsed.text,
        author: meta.label,
        // Only a person can send from the phone, so this is the company speaking — which is
        // what makes it something the bot may learn from.
        speaker: 'team',
        externalId: parsed.messageId,
        at: parsed.at,
      })
      // Null means this is our own reply coming back. Its files are already filed with it.
      if (!filed) return conversation.id
      for (const file of attachments ?? []) await attachFile(meta.workspace_id, filed.id, file)
      // The id, so an import can stamp the threads it touched.
      return conversation.id
    })

  /*
   * Backfill: file it against the same thread the live path would, and stop.
   *
   * The thread is opened the same way, so a chat that later writes in lands on the history
   * already imported rather than starting again beside it.
   */
  if (!answer)
    return withWorkspace({ workspaceId: meta.workspace_id }, async () => {
      const customer = await identify(meta.workspace_id, {
        channel: 'whatsapp',
        externalId: parsed.jid,
        name: parsed.senderName,
        phone,
      })
      const conversation = await openThread(
        meta.workspace_id,
        customer.id,
        'whatsapp',
        `${accountId}:${parsed.jid}`,
      )
      await record(meta.workspace_id, conversation.id, {
        direction: 'in',
        body: parsed.text,
        speaker: 'customer',
        externalId: parsed.messageId,
        at: parsed.at,
      })
      return conversation.id
    })

  await withWorkspace({ workspaceId: meta.workspace_id }, () =>
    ask(meta.workspace_id, {
      channel: 'whatsapp',
      // Which linked number as well as which chat: a workspace may have several, and a
      // reply has to go back out through the one that received it.
      channelRef: `${accountId}:${parsed.jid}`,
      from: parsed.jid,
      name: parsed.senderName,
      // The number on the message, or the one the session has mapped to this lid.
      phone,
      text: parsed.text,
      externalId: parsed.messageId,
      at: parsed.at,
      attachments,
    }),
  )
}

// ---------------------------------------------------------------- outbound

export async function send(conversation: Conversation, text: string, files: Sendable[] = []): Promise<string | null> {
  const [accountId, ...rest] = conversation.channel_ref.split(':')
  const jid = rest.join(':')
  if (!accountId || !jid) throw new Error('That conversation has no WhatsApp address')
  /*
   * Tokens, never bytes.
   *
   * This call crosses an IPC boundary to the process holding the sockets, and `prod.mjs`
   * forks with Node's default JSON serialization — a Buffer arrives on the other side as
   * `{type:'Buffer',data:[…]}`, nine times the size and no longer a Buffer. So the id makes
   * the trip and the primary, which has its own database access, fetches the file itself.
   */
  return sendVia(accountId, jid, text, files.map((f) => ({ token: f.token, title: f.title, mime: f.mime })))
}

/** What survives the hop: enough to find the file and name it, and nothing that is bytes. */
type Enclosure = { token: string; title: string; mime: string | null }

/** Runs in whichever process holds the sockets. */
const sendImpl = async (
  accountId: string,
  jid: string,
  text: string,
  files: Enclosure[] = [],
): Promise<string | null> => {
  const l = runtime(accountId)
  if (!l.sock) {
    /*
     * No credentials, no session to open — checked here rather than after `start()`.
     *
     * `start()` is allowed to run without them: that is how linking works, and the socket it
     * opens is what produces the QR. But an unauthenticated socket is still a socket, so the
     * check below would pass and `sendMessage` then dies inside Baileys reading `.id` of
     * nothing — reaching the inbox as "Cannot read properties of undefined", which tells
     * nobody anything.
     *
     * Only on this branch. A socket we are already holding is authenticated by definition,
     * and re-deriving that from the filesystem would refuse sends that were about to work.
     *
     * Reachable since a dead session stopped taking its account with it — which is right,
     * the number needs re-scanning rather than erasing, and this is what says so.
     */
    if (!fs.existsSync(file(accountId, 'creds.json')))
      throw new Error('That WhatsApp number is not connected. Scan the code again to reconnect it.')

    /*
     * Only the process holding the live lock may open a socket from credentials on disk.
     *
     * `ownsSingletons` is true in every primary, including one that asked for the cross-process
     * lock and lost — and a losing primary still serves its workers' singleton RPCs. Without
     * this, a send arriving there found no socket, saw `creds.json`, and opened a second
     * Baileys session for a number the winning process already holds. WhatsApp resolves that
     * by closing both, which is the conflict the lock exists to prevent, reached from the one
     * direction the lock does not itself cover.
     */
    if (!holdsLiveLock())
      throw new Error('That WhatsApp number is held by another process on this database. Try again shortly.')

    await start(accountId)
    if (!runtime(accountId).sock) throw new Error('That WhatsApp number is not connected')
  }
  // Only when something was typed: a file sent on its own arrives on its own, rather than
  // under a message repeating the name the attachment already carries.
  const sent = text ? await runtime(accountId).sock.sendMessage(jid, { text }) : null

  /*
   * The text first, then the files, and each one on its own.
   *
   * The id that comes back is the text message's where there is one and the first file's
   * where there is not — that is what the redelivery guard and the `external_id` stamp are
   * for, and a files-only send is still a delivered one. Each upload is caught on its own
   * because the answer is the message and the file is an enclosure: losing the enclosure and
   * keeping the answer beats losing both.
   */
  let id: string | null = sent?.key?.id ?? null
  for (const f of files) {
    try {
      // asSystem, because the primary has no request and no workspace scope, and byToken is
      // behind RLS. The same read, for the same reason, as the public resource route.
      const held = await asSystem(() => byToken(f.token))
      if (!held?.bytes) continue
      const mime = f.mime ?? 'application/octet-stream'
      const up = await runtime(accountId).sock.sendMessage(
        jid,
        mime.startsWith('image/')
          ? { image: held.bytes, mimetype: mime }
          : { document: held.bytes, mimetype: mime, fileName: f.title },
      )
      id ??= up?.key?.id ?? null
    } catch (e) {
      console.error('[whatsapp] could not send', f.title, e instanceof Error ? e.message : e)
    }
  }
  return id == null ? null : `whatsapp:${jid}:${id}`
}

// ---------------------------------------------------------------- managing links

const addImpl = async (workspaceId: number, label: string): Promise<Account> => {
  const accountId = crypto.randomBytes(4).toString('hex')
  writeMeta(accountId, { label: label.trim() || 'WhatsApp', phone: null, workspace_id: workspaceId, created_at: now() })
  // Opened immediately so the QR exists by the time the page asks for it.
  void start(accountId).catch(whyStartFailed(accountId))
  return get(workspaceId, accountId)!
}

const removeImpl = async (workspaceId: number, accountId: string) => {
  // The workspace check has to happen where the files are, since there is no policy on a
  // directory — this is the only thing standing between two tenants' links.
  if (!get(workspaceId, accountId)) throw new Error('No such WhatsApp number')

  /*
   * The threads go with the number.
   *
   * A conversation's `channel_ref` carries the account id it arrived on, and that id is
   * minted per link — so re-linking the same phone produces a new one and every old thread
   * points at a connection that no longer exists. They cannot be answered and cannot be
   * reached again: the inbox was left showing conversations whose only possible outcome was
   * an error, on a number the person had already disconnected.
   *
   * Before the files, deliberately. If this throws, the number is still linked and the
   * threads still match it — which is a state somebody can retry from. The other order
   * leaves a disconnected number whose threads are still in the inbox, which is exactly the
   * mess being cleaned up.
   */
  await withWorkspace({ workspaceId }, () => removeConnection(workspaceId, id, accountId))

  removeFiles(accountId)
}

const restartImpl = async (workspaceId: number, accountId: string): Promise<Account> => {
  if (!get(workspaceId, accountId)) throw new Error('No such WhatsApp number')
  stop(accountId)
  runtime(accountId).attempts = 0
  await start(accountId)
  return get(workspaceId, accountId)!
}

/**
 * The socket-touching calls, routed to the process that owns them.
 *
 * Reads stay off disk and out of here on purpose: `list` and `get` are synchronous in any
 * process, which is what keeps the page render free of IPC.
 */
export const add = singleton('wa.add', addImpl)
export const remove = singleton('wa.remove', removeImpl)
export const restart = singleton('wa.restart', restartImpl)
const sendVia = singleton('wa.send', sendImpl)

/**
 * Reconnect every already-linked number at boot.
 *
 * A message must arrive without anybody having opened the UI first — a support number
 * that only works while somebody is looking at a dashboard is not a support number.
 * Only the process that owns the sockets does this.
 */
export function resume() {
  if (!ownsSingletons) return
  for (const accountId of ids()) {
    if (fs.existsSync(file(accountId, 'creds.json'))) void start(accountId).catch(whyStartFailed(accountId))
    // Nothing to reconnect to, so whatever the state file last said is from before this
    // process existed — a QR code left there would be offered forever and never work.
    else mark(accountId, { status: 'off', qr: null })
  }
}

// ---------------------------------------------------------------- history, at link time

/**
 * The chats that were already on the phone.
 *
 * WhatsApp hands these over once, as part of pairing — which is why a number that is already
 * linked has to be unlinked and scanned again to get them. Baileys delivers them in chunks on
 * `messaging-history.set`, newest first, and the chunks keep arriving for a while.
 *
 * Filed, never answered. `handle(..., { answer: false })` shares the parsing, the identify /
 * open / record path and the rule that a message sent from the phone is the team speaking —
 * and stops short of the agent. Replaying a year of chats through the live path would have
 * the bot compose a reply to every one of them, which is the danger the old
 * `syncFullHistory: false` was written to avoid.
 *
 * ponytail: one message at a time, so identify/open/record run per message rather than once
 * per chat — roughly six queries each. Fine for a few thousand and slow for a hundred
 * thousand; the upgrade is to resolve the customer and thread once per jid and loop the
 * inserts inside one transaction. Left simple deliberately: the rules that must not drift
 * between live and backfill live in parse() and record(), and both paths go through them.
 */
export async function importHistory(accountId: string, messages: any[]): Promise<number> {
  const meta = readMeta(accountId)
  if (!meta) return 0

  const touched = new Set<number>()
  let filed = 0

  for (const m of messages) {
    try {
      const conversationId = await handle(accountId, m, { answer: false, media: false })
      if (typeof conversationId === 'number') {
        touched.add(conversationId)
        filed++
      }
    } catch (e) {
      // One unreadable message must not end an import of thousands.
      trace(accountId, 'history: could not file one', { error: say(e) })
    }
  }

  /*
   * Marked as backfill, and marked as already read for training.
   *
   * `imported_at` is what tells the inbox these were not live traffic and what a bulk "read
   * these for training" acts on. `harvested_at` is what keeps the import quiet: the training
   * sweep asks whether anything has happened since it last looked, so a thread whose newest
   * message is older than the stamp is not due. Without it, importing a few hundred chats
   * would spend a model call on every one of them and produce a review queue nobody could
   * face — and what the bot should learn from a year of chats is a decision, not a default.
   *
   * The board is the other way round, and that is the change here. `judged_at` used to be
   * stamped alongside it, which meant linking a phone imported six hundred conversations,
   * created six hundred contacts, and left the sales board empty — the qualify sweep was
   * told they had all already been judged. Where somebody got to is exactly what you want to
   * know about the chats that were on the phone before Arlo arrived, so they are enrolled
   * below and left due. The sweep reads them twenty at a time, at its own pace.
   *
   * A live message on one of these threads still makes it due for both, because that moves
   * `last_at` past the stamp. Which is right: the backfill is old, the new message is not.
   */
  if (touched.size)
    await withWorkspace({ workspaceId: meta.workspace_id }, async () => {
      const ids = [...touched]
      /*
       * Whose threads these are, recorded now rather than left to the agent that will never
       * see them. Without an owner the training sweep cannot read them at all — it joins
       * conversations to bots on this column — so importing chats to learn from would file
       * them and then quietly never learn anything.
       *
       * Null when the number has no bot yet, which is an ordinary way to arrive here: link
       * first, assign afterwards. `readImported()` resolves it again for exactly that case,
       * so nothing is lost by it being null now.
       */
      const bot = await routeTo(meta.workspace_id, 'whatsapp', accountId)
      if (bot) await adoptBot(meta.workspace_id, ids, bot.id)

      /*
       * Where each thread belongs in the list, which is not where filing it just put it.
       *
       * `record()` moves `last_at` with GREATEST, so a message from March could not pull a
       * row created a second ago backwards — correct for live traffic and wrong for a whole
       * history arriving at once. Every imported thread ended up stamped with the import,
       * within the same second, and the inbox sorted them by nothing.
       *
       * Before `markImported`, which reads `last_at` when it decides what the sweeps should
       * consider due.
       */
      await datePlacedFromMessages(meta.workspace_id, ids)

      await markImported(meta.workspace_id, ids)
    })

  return filed
}
