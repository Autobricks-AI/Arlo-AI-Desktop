/**
 * Telegram, as a push channel.
 *
 * One bot per row, each with its own webhook address and its own secret. The address is
 * public by construction — Telegram has to be able to reach it — so what makes a request
 * provably from Telegram is the secret header, not the URL.
 *
 * The shape is the one every channel in this directory follows:
 *   parse()   pure, so message shapes are unit-testable without a network or a database
 *   handle()  decide, then file
 *   send()    the reply path
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { all, asSystem, one, run, withWorkspace } from '../db.ts'
import { ownsSingletons, singleton } from '../singleton.ts'
import { openOrNull, seal } from '../secrets.ts'
import { WEBHOOK, take } from '../throttle.ts'
import { handle as ask } from '../agent.ts'
import { MAX_BYTES } from '../attachments.ts'
import type { Incoming as File } from '../attachments.ts'
import { byToken } from '../resources.ts'
import type { Sendable } from '../resources.ts'
import type { Conversation } from '../conversations.ts'
import { removeConnection } from '../conversations.ts'

export const id = 'telegram'
export const label = 'Telegram'

const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`

export type Pending = { id: string; name: string; at: string }
export type Bot = {
  id: string
  label: string
  /** The @handle, which is how a person finds this bot. Null for bots connected before it was kept. */
  username: string | null
  /** Telegram sender ids allowed to talk to this bot. Empty means nobody. */
  allowed: string[]
  /** Senders turned away recently, so the allow list can be filled in with one click. */
  pending: Pending[]
  /** 'webhook' when Telegram pushes to us, 'polling' when we fetch. See register(). */
  mode: string
  last_error: string | null
  created_at: string
}

type Row = Bot & { workspace_id: number; token_enc: string; secret: string }

/** Where Telegram should send this bot's updates. */
export const webhookUrl = (base: string, botId: string) => `${base.replace(/\/+$/, '')}/api/telegram/${botId}`

/**
 * The same API, for the calls that carry a file.
 *
 * Multipart rather than handing Telegram a URL to fetch, which is the other way its API
 * accepts a document: `PUBLIC_URL` is often a private address Telegram's servers cannot
 * reach. The bytes have to go up the wire.
 *
 * A separate function rather than a branch in `telegram()` because every existing caller —
 * and the test stub — depends on that one being JSON.
 */
async function upload<T>(token: string, method: string, form: FormData): Promise<T> {
  // No content-type header: fetch sets it, with the boundary, which cannot be written by hand.
  const res = await fetch(API(token, method), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  })
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
  if (!json.ok) throw new Error(json.description || `Telegram refused ${method}`)
  return json.result as T
}

async function telegram<T>(token: string, method: string, body?: object): Promise<T> {
  const res = await fetch(API(token, method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  })
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string }
  // Telegram answers 200 with ok:false for most failures, so the status alone says nothing.
  if (!json.ok) throw new Error(json.description || `Telegram refused ${method}`)
  return json.result as T
}

// ---------------------------------------------------------------- managing bots

export const list = (workspaceId: number) =>
  all<Bot>(
    `SELECT id, label, username, allowed, pending, mode, last_error, created_at FROM telegram_bots
      WHERE workspace_id = ? ORDER BY created_at`,
    workspaceId,
  )

export const get = (workspaceId: number, botId: string) =>
  one<Bot>(
    `SELECT id, label, username, allowed, pending, mode, last_error, created_at FROM telegram_bots
      WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    botId,
  )

/**
 * Connect a bot.
 *
 * The token is checked with getMe before anything is stored: a typo should be an error on
 * the form, not a bot row that silently never receives anything.
 *
 * `drop_pending_updates` matters. A bot token that has been sitting unused has a queue of
 * everything anyone sent it, and without this the first thing a new connection does is
 * answer a month of old messages at once.
 */
export async function add(workspaceId: number, { label, token, base }: { label?: string; token: string; base: string }) {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('Paste the bot token from BotFather')

  const me = await telegram<{ username: string; first_name: string }>(trimmed, 'getMe')

  const botId = randomBytes(8).toString('hex')
  const secret = randomBytes(24).toString('base64url')

  const mode = await register(trimmed, botId, secret, base)

  await run(
    `INSERT INTO telegram_bots (id, workspace_id, label, username, token_enc, secret, mode) VALUES (?,?,?,?,?,?,?)`,
    botId,
    workspaceId,
    label?.trim() || `@${me.username}`,
    me.username,
    seal(trimmed),
    secret,
    mode,
  )
  const added = (await get(workspaceId, botId))!
  /*
   * Through the singleton wrapper, which is the whole point: this runs inside an HTTP
   * request, and in production that is a forked web worker where `ownsSingletons` is false.
   * Calling the loop directly here did nothing at all — the bot connected, the card said it
   * was receiving by polling, and nothing arrived until the next restart.
   */
  if (mode === 'polling') void startPolling(botId)
  return added
}

/**
 * Point Telegram at us, whichever direction that turns out to mean.
 *
 * A webhook needs a hostname Telegram's servers can resolve and reach over HTTPS. On a
 * laptop, in a container, or behind any NAT, that is simply not true — `setWebhook` answers
 * "Failed to resolve host" and the bot cannot be added at all. That is not an error worth
 * showing somebody; it is a fact about their network, and there is another way to receive.
 *
 * So: try the webhook, and fall back to polling when Telegram will not take it. Nothing to
 * configure and nothing to know in advance. `TELEGRAM_POLLING` skips the attempt for
 * installs where the answer is already known — the shipped `docker-compose.yml` among them,
 * since its PUBLIC_URL is loopback and a doomed `setWebhook` on every add is just noise.
 *
 * `deleteWebhook` before polling is not optional: Telegram refuses `getUpdates` with a 409
 * while a webhook is registered, so a bot changing direction must clear the old one first.
 */
async function register(token: string, botId: string, secret: string, base: string): Promise<'webhook' | 'polling'> {
  const forced = process.env.TELEGRAM_POLLING === '1' || process.env.TELEGRAM_POLLING === 'true'

  if (!forced) {
    try {
      await telegram(token, 'setWebhook', {
        url: webhookUrl(base, botId),
        secret_token: secret,
        drop_pending_updates: true,
        allowed_updates: ['message'],
      })
      return 'webhook'
    } catch (e) {
      console.log(
        `[telegram] ${botId}: no usable webhook (${e instanceof Error ? e.message : e}) — receiving by polling instead`,
      )
    }
  }

  await telegram(token, 'deleteWebhook', { drop_pending_updates: true }).catch(() => {})
  return 'polling'
}

export async function remove(workspaceId: number, botId: string) {
  const row = await one<Row>(`SELECT * FROM telegram_bots WHERE workspace_id = ? AND id = ?`, workspaceId, botId)
  if (!row) throw new Error('No such bot')

  // Whichever direction it was receiving from, it stops now. The loop reads the row each
  // pass and would exit on its own once the row is gone, but this ends it at once rather
  // than leaving one more `getUpdates` in flight against a bot nobody has any more.
  stopPolling(botId)

  const token = openOrNull(row.token_enc)
  // Best effort: a token that no longer works, or a Telegram that is down, must not stop
  // somebody disconnecting a bot from their own workspace.
  if (token) await telegram(token, 'deleteWebhook', {}).catch(() => {})

  // The threads first, then the bot. A conversation carries the connection it arrived on,
  // and one whose bot is gone cannot be answered — no token, no webhook, nothing behind it.
  // This order so a failure leaves the bot still listed, which is a state somebody can retry
  // from; the other way round leaves threads in the inbox with nothing to answer them.
  await removeConnection(workspaceId, id, botId)
  await run(`DELETE FROM telegram_bots WHERE workspace_id = ? AND id = ?`, workspaceId, botId)
}

/**
 * Register the webhook again, for a bot whose registration failed or was cleared.
 *
 * The token is already stored and already verified, so a retry must not mean pasting it
 * again — the usual cause is that this instance was unreachable for a moment, or that
 * PUBLIC_URL was wrong when the bot was connected and is right now.
 */
export async function retry(workspaceId: number, botId: string, base: string) {
  const row = await one<Row>(`SELECT * FROM telegram_bots WHERE workspace_id = ? AND id = ?`, workspaceId, botId)
  if (!row) throw new Error('No such bot')

  const token = openOrNull(row.token_enc)
  if (!token) throw new Error('That bot token cannot be read — check SECRET_KEY')

  // The same choice `add()` makes, for the same reason: this is the button somebody presses
  // when receiving has stopped working, and "the webhook cannot be registered" is a state it
  // should recover from rather than report again.
  const mode = await register(token, botId, row.secret, base)

  await run(
    `UPDATE telegram_bots SET last_error = NULL, mode = ? WHERE workspace_id = ? AND id = ?`,
    mode,
    workspaceId,
    botId,
  )
  if (mode === 'polling') void startPolling(botId)
  else stopPolling(botId)

  return (await get(workspaceId, botId))!
}

/** Let a sender through, and drop them from the pending list. */
export async function allow(workspaceId: number, botId: string, sender: string) {
  const bot = await get(workspaceId, botId)
  if (!bot) throw new Error('No such bot')
  const allowed = [...new Set([...bot.allowed, String(sender)])]
  await run(
    `UPDATE telegram_bots SET allowed = ?::jsonb, pending = ?::jsonb WHERE workspace_id = ? AND id = ?`,
    JSON.stringify(allowed),
    JSON.stringify(bot.pending.filter((p) => p.id !== String(sender))),
    workspaceId,
    botId,
  )
  return (await get(workspaceId, botId))!
}

export async function revoke(workspaceId: number, botId: string, sender: string) {
  const bot = await get(workspaceId, botId)
  if (!bot) throw new Error('No such bot')
  await run(
    `UPDATE telegram_bots SET allowed = ?::jsonb WHERE workspace_id = ? AND id = ?`,
    JSON.stringify(bot.allowed.filter((a) => a !== String(sender))),
    workspaceId,
    botId,
  )
  return (await get(workspaceId, botId))!
}

// ---------------------------------------------------------------- inbound

export type Parsed = {
  chatId: string
  senderId: string
  name: string | null
  text: string
  messageId: string
  /** When Telegram says it was sent. Seconds since the epoch. */
  at: Date | null
  /**
   * The file on this message, if any — its id and what it is, not its bytes.
   *
   * Downloading needs the bot token, which `parse` deliberately does not have: this stays
   * pure so every shape Telegram sends can be tested without a network.
   */
  file: { id: string; name: string; mime: string | null; size: number } | null
}

/**
 * What Telegram calls a file, in the six shapes it sends one.
 *
 * A photo is an array of sizes; the last is the largest, and the largest is the one worth
 * keeping — the others are thumbnails of it.
 */
function fileOf(m: Record<string, any>): Parsed['file'] {
  const photo = Array.isArray(m.photo) ? m.photo.at(-1) : null
  const candidate = m.document ?? photo ?? m.video ?? m.audio ?? m.voice ?? m.video_note ?? null
  if (!candidate?.file_id) return null

  const kind = m.document ? 'document' : photo ? 'photo' : m.video ? 'video' : m.audio ? 'audio' : m.voice ? 'voice' : 'file'
  return {
    id: candidate.file_id,
    // Only documents and audio carry a name; the rest get one that says what they are.
    name: candidate.file_name ?? `${kind}-${m.message_id}${photo ? '.jpg' : ''}`,
    mime: candidate.mime_type ?? (photo ? 'image/jpeg' : null),
    size: candidate.file_size ?? 0,
  }
}

/**
 * Pull the bits we need out of an update. Pure — no network, no database — which is what
 * makes every message shape Telegram can send testable in one file.
 *
 * Returns null for everything that is not a text message from a person: edits, joins,
 * stickers, photos without a caption. Those are not questions.
 */
export function parse(update: unknown): Parsed | null {
  const m = (update as { message?: Record<string, any> })?.message
  if (!m || typeof m !== 'object') return null

  const from = m.from ?? {}
  if (from.is_bot) return null // our own echo, or another bot talking to us

  const file = fileOf(m)
  const text: string = m.text ?? m.caption ?? ''
  // A file on its own is a message. Answering "they sent nothing" to a photo of a broken
  // part is the wrong answer, so the body says what arrived and the file is filed with it.
  if (!text.trim() && !file) return null

  const chatId = m.chat?.id
  const senderId = from.id ?? chatId
  if (chatId === undefined || senderId === undefined) return null

  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null
  return {
    chatId: String(chatId),
    senderId: String(senderId),
    name,
    text: text.trim() || `[sent ${file!.name}]`,
    messageId: `telegram:${chatId}:${m.message_id}`,
    at: m.date ? new Date(m.date * 1000) : null,
    file,
  }
}

/**
 * Fetch what a message carried.
 *
 * Two calls, because Telegram will not hand over a file without being asked where it is
 * first. Best effort throughout: a message with an unfetchable file is still a message.
 */
async function download(token: string, file: NonNullable<Parsed['file']>): Promise<File> {
  const record: File = { name: file.name, mime: file.mime, size: file.size, externalRef: file.id }
  if (file.size > MAX_BYTES) return record

  try {
    const where = await telegram<{ file_path: string }>(token, 'getFile', { file_id: file.id })
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${where.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    })
    if (res.ok) record.bytes = Buffer.from(await res.arrayBuffer())
  } catch {
    // The row still says a file came and what it was called.
  }
  return record
}

export type Handled =
  | { status: 'ignored'; reason: string }
  | { status: 'refused'; sender: string }
  | { status: 'handled'; conversationId: number }

/**
 * `!==` on a secret bails out on the first differing byte, and a stranger who can measure
 * the difference gets one bit of the secret per query. `timingSafeEqual` closes that, but
 * throws rather than answering false on two buffers of different length — so the length is
 * checked first. That comparison itself is not constant-time, but a secret's *length* is
 * not the part worth protecting; every valid one here is the same length regardless.
 */
function sameSecret(given: string, real: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(real)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * A webhook delivery.
 *
 * No session and no scope: the URL names the bot, so resolving it is a genuine system
 * read. Everything after that runs inside the bot's own workspace.
 *
 * This never throws for an ordinary refusal. Telegram retries anything that is not a 2xx,
 * so an exception here becomes a delivery loop — the route answers 200 whatever this
 * returns, and the return value is for the logs.
 */
export async function handle(botId: string, secret: string | null, update: unknown): Promise<Handled> {
  // System read: which bot was called is precisely what decides the workspace.
  const row = await asSystem(() => one<Row>(`SELECT * FROM telegram_bots WHERE id = ?`, botId))
  if (!row) return { status: 'ignored', reason: 'no such bot' }

  // The URL is public. This header is what makes the request provably from Telegram.
  // Constant-time: `!==` on a secret this shape leaks nothing practical given 192 bits of
  // entropy, but the comparison is one line either way and this is the pattern to reach
  // for by habit rather than re-derive each time it matters more.
  if (!secret || !sameSecret(secret, row.secret)) return { status: 'ignored', reason: 'bad secret' }

  return accept(row, update)
}

/**
 * One update, after we are satisfied it is really from Telegram.
 *
 * Split from `handle()` because the secret above answers a question only a webhook has: the
 * URL is public, so anybody can POST to it, and the header is the proof. An update we
 * fetched ourselves through `getUpdates` came down a connection we opened to Telegram over
 * TLS — there is no third party to impersonate anyone, and no header to check.
 *
 * Everything that actually decides what happens to a message lives here, so both transports
 * get the same treatment: the rate limit, the allow list, the download, the agent. A polling
 * bot is exactly as reachable by strangers as a webhook one, and the allow list is what
 * stands between a discoverable @username and the workspace's model budget.
 */
async function accept(row: Row, update: unknown): Promise<Handled> {
  const botId = row.id

  const wait = await take(`telegram:${botId}`, WEBHOOK)
  if (wait) return { status: 'ignored', reason: 'rate limited' }

  const parsed = parse(update)
  if (!parsed) return { status: 'ignored', reason: 'not a text message' }

  /*
   * The allow list, and it is empty by default.
   *
   * A bot's username is discoverable and anyone can message it. Open by default would mean
   * the first stranger to find it gets to spend the workspace's model budget and read
   * whatever the knowledge base knows.
   */
  if (!row.allowed.includes(parsed.senderId)) {
    await remember(row, parsed)
    return { status: 'refused', sender: parsed.senderId }
  }

  const token = openOrNull(row.token_enc)
  const attachments = parsed.file && token ? [await download(token, parsed.file)] : undefined

  return withWorkspace({ workspaceId: row.workspace_id }, async () => {
    const result = await ask(row.workspace_id, {
      channel: 'telegram',
      attachments,
      // Which bot as well as which chat. A workspace can run several, a chat is only
      // reachable by the bot that is in it, and the reply has to go back out the way the
      // question came in.
      channelRef: `${botId}:${parsed.chatId}`,
      from: parsed.senderId,
      name: parsed.name,
      text: parsed.text,
      externalId: parsed.messageId,
      at: parsed.at,
    })
    return { status: 'handled' as const, conversationId: result.conversationId }
  })
}

/** Keep the last few refused senders, so the allow list can be filled in from the UI. */
async function remember(row: Row, parsed: Parsed) {
  const seen = row.pending.filter((p) => p.id !== parsed.senderId)
  const pending = [{ id: parsed.senderId, name: parsed.name ?? parsed.senderId, at: new Date().toISOString() }, ...seen].slice(0, 5)
  // System write, for the same reason as the read above: there is no session behind a webhook.
  await asSystem(() => run(`UPDATE telegram_bots SET pending = ?::jsonb WHERE id = ?`, JSON.stringify(pending), row.id))
}

// ---------------------------------------------------------------- outbound

/**
 * Deliver a reply, through the bot the question arrived on.
 *
 * That bot is named in the conversation's reference, because any other one would be wrong:
 * a bot can only message a chat it is itself in, so with two connected, answering through
 * whichever was connected first fails with "chat not found" — or, worse, succeeds into a
 * chat that happens to contain both.
 *
 * A reference with no bot in it predates that and belongs to a workspace that only ever
 * had one bot, so the oldest is the one it came from.
 */
export async function send(conversation: Conversation, text: string, files: Sendable[] = []): Promise<string | null> {
  const [botId, ...rest] = conversation.channel_ref.split(':')
  const chatId = rest.join(':') || botId

  const row = rest.length
    ? await one<Row>(`SELECT * FROM telegram_bots WHERE id = ?`, botId)
    : await one<Row>(`SELECT * FROM telegram_bots ORDER BY created_at LIMIT 1`)
  if (!row) throw new Error('No Telegram bot is connected')

  const token = openOrNull(row.token_enc)
  if (!token) throw new Error('That bot token cannot be read — check SECRET_KEY')

  const sent = await telegram<{ message_id: number }>(token, 'sendMessage', { chat_id: chatId, text })

  /*
   * The text first, then a send per file.
   *
   * The returned id stays the text message's: that is what the redelivery guard matches on.
   * Each upload is caught on its own — the answer is the message and the file is an
   * enclosure, so losing the enclosure and keeping the answer beats losing both.
   */
  for (const f of files) {
    try {
      const held = await byToken(f.token)
      if (!held?.bytes) continue
      const mime = f.mime ?? 'application/octet-stream'
      const image = mime.startsWith('image/')
      const form = new FormData()
      form.set('chat_id', chatId)
      // An image goes as a photo so it previews in the chat; everything else keeps its name.
      form.set(image ? 'photo' : 'document', new Blob([new Uint8Array(held.bytes)], { type: mime }), f.title)
      await upload(token, image ? 'sendPhoto' : 'sendDocument', form)
    } catch (e) {
      console.error('[telegram] could not send', f.title, e instanceof Error ? e.message : e)
    }
  }

  return `telegram:${chatId}:${sent.message_id}`
}

// ---------------------------------------------------------------- long polling

/**
 * The bots this process is currently polling for, so a second start is a no-op.
 *
 * On globalThis for the same reason the WhatsApp sockets are: a dev hot-reload would
 * otherwise leave the previous copy's loop running beside the new one, and two loops on one
 * bot means Telegram handing each update to whichever asked first — duplicate answers, and
 * an offset that goes backwards.
 */
const polling: Map<string, { stop: boolean; gen: number }> = ((globalThis as any).__arloTgPoll ??= new Map())
const POLL_GEN: number = ((globalThis as any).__arloTgPollGen = (((globalThis as any).__arloTgPollGen as number) ?? 0) + 1)

/**
 * How long Telegram holds the connection open with nothing to say.
 *
 * The whole point of long polling: 25 seconds of silence costs one request, where a
 * one-second poll would cost 25 and still be slower to deliver. It must stay comfortably
 * below the fetch timeout below, or our own client aborts the call every single time and
 * every message looks like a network failure.
 */
const POLL_SECONDS = 25
const POLL_TIMEOUT_MS = (POLL_SECONDS + 10) * 1000

/**
 * `getUpdates`, with a deadline long enough to let it wait.
 *
 * Not the shared `telegram()` helper, which aborts at 20 seconds — a sensible ceiling for a
 * call that should answer at once, and fatal for one designed to say nothing for 25.
 */
async function getUpdates(token: string, offset: number | null) {
  const res = await fetch(API(token, 'getUpdates'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      timeout: POLL_SECONDS,
      allowed_updates: ['message'],
      ...(offset === null ? {} : { offset }),
    }),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  })
  const json = (await res.json()) as { ok: boolean; result?: { update_id: number }[]; description?: string }
  if (!json.ok) throw new Error(json.description || 'Telegram refused getUpdates')
  return json.result ?? []
}

/**
 * Fetch this bot's updates until told to stop.
 *
 * Only ever called by the process that owns the singletons. Two processes polling one bot is
 * the same mistake as two WhatsApp sockets on one number: Telegram answers 409, and whichever
 * call wins takes updates the other will never see.
 *
 * The offset is the contract. Asking for `last + 1` is simultaneously "give me what is new"
 * and "I am finished with everything before this", so it is written back after each batch —
 * in the database, because the alternative is replaying the last batch after every restart
 * and answering a customer twice.
 */
async function loop(botId: string) {
  if (!ownsSingletons) return
  /*
   * The same switch the mail poller reads, and for the same reason: `POLL_SECONDS=0` is how
   * a process says it does no background work. Tests and one-off scripts set it, and a loop
   * that ignored it would hold them open forever waiting on a socket nobody is watching.
   */
  if (Number(process.env.POLL_SECONDS ?? 60) <= 0) return
  const existing = polling.get(botId)
  // A loop an older copy of this module started is running that copy's code against a
  // database the migrations may have moved on.
  if (existing && existing.gen === POLL_GEN) return
  if (existing) existing.stop = true

  const me = { stop: false, gen: POLL_GEN }
  polling.set(botId, me)

  let failures = 0
  while (!me.stop) {
    try {
      const row = await asSystem(() =>
        one<Row & { mode: string; poll_offset: string | null }>(`SELECT * FROM telegram_bots WHERE id = ?`, botId),
      )
      // Removed, or switched back to a webhook. Either way this loop is finished.
      if (!row || row.mode !== 'polling') break

      const token = openOrNull(row.token_enc)
      if (!token) break

      const updates = await getUpdates(token, row.poll_offset === null ? null : Number(row.poll_offset) + 1)
      failures = 0

      /*
       * Asked to stop while that was in flight.
       *
       * A long poll holds for 25 seconds, which is a wide window for the bot to be removed
       * underneath it — and `row` was read before the wait, so filing these would create
       * conversations for a bot that no longer exists, immediately after `remove()` deleted
       * the ones it had.
       */
      if (me.stop) break

      /*
       * Read again, because `row` is now up to twenty-five seconds old and one of its columns
       * decides whether a message is answered at all.
       *
       * Letting somebody in is a person watching a bot say nothing, clicking allow, and
       * sending another message immediately. That message arrives on a poll that was already
       * in flight when they clicked, so the stale `allowed` turned them away again and put
       * them back in the pending list they had just been let out of. It came right on the
       * next message, which is a miserable way to find out the button worked.
       */
      const fresh = updates.length
        ? ((await asSystem(() =>
            one<Row & { mode: string; poll_offset: string | null }>(`SELECT * FROM telegram_bots WHERE id = ?`, botId),
          )) ?? row)
        : row

      for (const update of updates) {
        // One bad update must not cost the batch, and must not stall the offset behind it.
        try {
          await accept(fresh, update)
        } catch (e) {
          console.error(`[telegram] ${botId}: could not handle update:`, e instanceof Error ? e.message : e)
        }
      }

      if (updates.length) {
        const newest = Math.max(...updates.map((u) => u.update_id))
        await asSystem(() => run(`UPDATE telegram_bots SET poll_offset = ? WHERE id = ?`, newest, botId))
      }
    } catch (e) {
      /*
       * Backed off and capped, like the WhatsApp reconnect. A bot whose token was revoked
       * would otherwise be a request every few milliseconds forever, and the log would be
       * nothing else.
       */
      failures++
      const wait = Math.min(60_000, 2 ** Math.min(failures, 6) * 500)
      console.error(
        `[telegram] ${botId}: polling failed (retry in ${wait / 1000}s):`,
        e instanceof Error ? e.message : e,
      )
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  if (polling.get(botId) === me) polling.delete(botId)
}

/**
 * Start and stop, from wherever they are called.
 *
 * These have to cross a process boundary and it is easy to miss that they do. `add()`,
 * `retry()` and `remove()` all run inside an HTTP request, which in production is a forked
 * web worker — and `ownsSingletons` is false there, so a loop started from one would simply
 * not start. That is exactly what happened: a bot connected, said it was receiving by
 * polling, and received nothing until the next restart, when `resumePolling()` finally ran
 * in the primary. The `singleton()` wrapper is what the WhatsApp socket calls already use
 * for the same reason.
 *
 * `begin` returns the moment the loop is launched rather than awaiting it. The loop runs
 * until stopped, so an RPC that waited for it would hold the request open until the
 * singleton deadline and then report a timeout for work that had started perfectly well.
 */
const begin = async (botId: string) => {
  void loop(botId)
}

const end = async (botId: string) => {
  const live = polling.get(botId)
  if (live) live.stop = true
}

/** Start fetching for one bot, in whichever process owns the loops. */
export const startPolling = singleton('tg.poll.start', begin)

/** Stop — it was removed, or moved back to a webhook. */
export const stopPolling = singleton('tg.poll.stop', end)

/**
 * Start a loop for every bot that receives this way.
 *
 * Called at boot beside the WhatsApp resume, by the one process that owns the singletons. A
 * bot added later starts its own loop from `add()`.
 */
export async function resumePolling() {
  if (!ownsSingletons) return
  const rows = await asSystem(() => all<{ id: string }>(`SELECT id FROM telegram_bots WHERE mode = 'polling'`))
  // Not awaited: each loop runs until stopped, so awaiting the first would mean never
  // starting the second.
  for (const r of rows) void loop(r.id)
}
