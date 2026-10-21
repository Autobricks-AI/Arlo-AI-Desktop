/**
 * Email, as a pull channel.
 *
 * Gmail and Outlook are one code path with a table of differences, because they are the
 * same shape: OAuth for consent, a refresh token kept sealed, a timer that lists what is
 * new, and a send endpoint. The alternative — two modules — is how one of them quietly
 * stops being maintained.
 *
 * ---------------------------------------------------------------- what is bounded, and why
 *
 * A mailbox is unbounded input from strangers. So every sweep is capped at a page, only
 * looks at mail after `since`, and checks what is already filed *before* fetching a
 * message body. Connecting a ten-year-old mailbox must not import a decade of it, and a
 * mailing list must not cost a model call per message.
 */
import { all, asSystem, insert, one, run, withWorkspace } from '../db.ts'
import { openOrNull, seal } from '../secrets.ts'
import { issue, redeem } from '../oauthstate.ts'
import { handle as ask } from '../agent.ts'
import { stripHtml } from '../scrape.ts'
import type { Conversation } from '../conversations.ts'
import { removeConnection } from '../conversations.ts'
import { byToken } from '../resources.ts'
import type { Sendable } from '../resources.ts'
import { randomBytes } from 'node:crypto'
import { MAX_BYTES, add as attach } from '../attachments.ts'
import type { Incoming as File } from '../attachments.ts'
import { EMAIL_IDS } from '../../types.ts'
import type { EmailId } from '../../types.ts'

export const id = 'email'
export const label = 'Email'

/*
 * ---------------------------------------------------------------- how big a file may be
 *
 * This was one flat number, 3MB, and it was wrong. 3MB is Graph's limit on a *simple*
 * attachment; quoting it at Gmail too — which carries 35MB through its media endpoint —
 * meant a 4MB price list degraded to a link on an account that would have delivered it.
 *
 * So the two providers get their own numbers, and neither is a refusal any more. Above
 * `GRAPH_SIMPLE_MAX` a file does not stop, it goes up an upload session instead: the
 * constant chooses a strategy, which is what it always should have done.
 */

/** Above this, Graph wants an upload session rather than one POST. */
const GRAPH_SIMPLE_MAX = 3 * 1024 * 1024

/**
 * How much goes up per PUT.
 *
 * Graph requires every chunk but the last to be a multiple of 320 KiB and recommends staying
 * under 4MB. Ten of them is 3.125MB, which satisfies both without arithmetic at the call site.
 */
const GRAPH_CHUNK = 10 * 320 * 1024

/** What each provider will actually carry, once the right upload path is used. */
const CEILING: Record<Provider, number> = {
  // `/upload/gmail/v1/...?uploadType=multipart`.
  gmail: 35 * 1024 * 1024,
  // An upload session, in GRAPH_CHUNK pieces.
  outlook: 150 * 1024 * 1024,
}

/**
 * The ceiling for *this* conversation, which means for this mailbox's provider.
 *
 * A function rather than a constant because the answer depends on which mailbox the thread is
 * on, and `deliver()` needs it before the channel has looked anything up. Falls back to the
 * smaller of the two when the mailbox cannot be read: guessing high would promise delivery we
 * cannot make.
 */
export async function maxFile(conversation: Conversation): Promise<number> {
  const mailboxId = conversation.channel_ref.split(':')[0]
  const mailbox = await one<{ provider: Provider }>(`SELECT provider FROM mailboxes WHERE id = ?`, mailboxId)
  return CEILING[mailbox?.provider as Provider] ?? GRAPH_SIMPLE_MAX
}

export type Provider = EmailId
export const PROVIDERS: Provider[] = [...EMAIL_IDS]

/** How many messages one sweep looks at, per mailbox. A ceiling on a minute of new mail. */
const PER_SWEEP = 20

/**
 * How many list pages one sweep will walk looking for messages it has not filed.
 *
 * ponytail: a bound rather than a watermark. Ten pages of PER_SWEEP is two hundred messages
 * looked at per mailbox per tick, which drains a year of history in a few hours of ticks and
 * costs nothing on a mailbox that is up to date, where the first page is enough. The upgrade
 * path, if a backlog is ever large enough to matter, is a per-mailbox cursor rather than a
 * higher number here.
 */
const MAX_PAGES = 10

type Spec = {
  authorize: string
  token: string
  scopes: string
  /** Extra parameters the provider needs on the consent URL. */
  extra: Record<string, string>
  env: { id: string; secret: string }
}

const SPEC: Record<Provider, Spec> = {
  gmail: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    // access_type=offline plus prompt=consent is the only combination Google reliably
    // returns a refresh token for — without it a reconnect silently yields none, and the
    // mailbox stops syncing an hour later for no visible reason.
    extra: { access_type: 'offline', prompt: 'consent' },
    env: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  },
  outlook: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: 'offline_access User.Read Mail.Read Mail.Send',
    extra: {},
    env: { id: 'OUTLOOK_CLIENT_ID', secret: 'OUTLOOK_CLIENT_SECRET' },
  },
}

export const redirectUrl = (base: string, provider: Provider) =>
  `${base.replace(/\/+$/, '')}/api/oauth/${provider}`

const credentials = (provider: Provider) => {
  const { env } = SPEC[provider]
  const clientId = process.env[env.id]
  const clientSecret = process.env[env.secret]
  if (!clientId || !clientSecret)
    throw new Error(`${provider} is not configured on this server — set ${env.id} and ${env.secret}`)
  return { clientId, clientSecret }
}

export const configured = (provider: Provider) =>
  !!process.env[SPEC[provider].env.id] && !!process.env[SPEC[provider].env.secret]

export type Mailbox = {
  id: string
  provider: Provider
  address: string
  since: string
  last_sync: string | null
  last_error: string | null
}

export const list = (workspaceId: number) =>
  all<Mailbox>(
    // `since` as a plain date: it is shown and edited as one, and a timestamp with a zone
    // on it would round-trip through the date input as a different day.
    `SELECT id, provider, address, to_char(since, 'YYYY-MM-DD') AS since, last_sync, last_error FROM mailboxes
      WHERE workspace_id = ? ORDER BY provider, address`,
    workspaceId,
  )

/**
 * How far back this mailbox is read.
 *
 * The only setting a mailbox has, and the one nobody can guess for you: it is the
 * difference between reading this month and reading the last three years. Widening it is
 * safe — already-filed mail is recognised by its id and never filed twice — so the
 * validation here is only about dates that cannot mean anything.
 */
export async function setSince(workspaceId: number, mailboxId: string, since: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('Date must be YYYY-MM-DD')
  const parsed = new Date(`${since}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== since)
    throw new Error(`${since} is not a real date`)
  if (since > new Date().toISOString().slice(0, 10))
    throw new Error('That date is in the future — nothing would ever sync')

  const { changes } = await run(
    `UPDATE mailboxes SET since = ?::timestamptz WHERE workspace_id = ? AND id = ?`,
    since,
    workspaceId,
    mailboxId,
  )
  if (!changes) throw new Error('No such mailbox')
}

// ---------------------------------------------------------------- consent

/** Where to send somebody to grant access. */
export async function authUrl(workspaceId: number, provider: Provider, base: string) {
  const { clientId } = credentials(provider)
  const { state, challenge } = await issue(workspaceId, provider)

  const url = new URL(SPEC[provider].authorize)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUrl(base, provider))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SPEC[provider].scopes)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(SPEC[provider].extra)) url.searchParams.set(k, v)
  return url.href
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number }

async function exchange(provider: Provider, body: Record<string, string>): Promise<Tokens> {
  const { clientId, clientSecret } = credentials(provider)
  const res = await fetch(SPEC[provider].token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await res.json()) as Tokens & { error_description?: string; error?: string }
  if (!res.ok || !json.access_token)
    throw new Error(json.error_description || json.error || `${provider} refused the token request`)
  return json
}

/**
 * The callback. Returns which workspace was connected, and the mailbox.
 *
 * `state` is checked before the code is spent: an unrecognised one means this callback is
 * not a flow we started, and spending the code anyway is precisely the attack the state
 * exists to stop.
 *
 * The workspace comes from the state rather than from the caller, because the state is the
 * only thing that actually knows: it was written when somebody signed in to that workspace
 * pressed Connect, and it survives a browser that will not send a cookie back from the
 * provider's site.
 */
export async function callback(provider: Provider, code: string, state: string | null, base: string) {
  const flow = await redeem(state, provider)
  if (!flow) throw new Error('That sign-in link has expired or was not started here. Try connecting again.')
  const workspaceId = flow.workspaceId

  const tokens = await exchange(provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUrl(base, provider),
    code_verifier: flow.verifier,
  })
  if (!tokens.refresh_token)
    throw new Error(`${provider} did not return a refresh token. Remove this app's access and connect again.`)

  const address = await whoami(provider, tokens.access_token)
  const refresh = seal(tokens.refresh_token)

  /*
   * The scope is opened here rather than around the whole call: redeeming the state has to
   * happen before the workspace is known, and mailboxes are behind row-level security.
   */
  const mailboxId = await withWorkspace({ workspaceId }, async () => {
    // One row per address per provider. Reconnecting replaces the token rather than
    // creating a second mailbox that syncs the same mail twice.
    const existing = await one<{ id: string }>(
      `SELECT id FROM mailboxes WHERE workspace_id = ? AND provider = ? AND lower(address) = lower(?)`,
      workspaceId,
      provider,
      address,
    )
    if (existing) {
      await run(`UPDATE mailboxes SET refresh_enc = ?, last_error = NULL WHERE id = ?`, refresh, existing.id)
      return existing.id
    }

    const id = randomBytes(8).toString('hex')
    await run(
      `INSERT INTO mailboxes (id, workspace_id, provider, address, refresh_enc) VALUES (?,?,?,?,?)`,
      id,
      workspaceId,
      provider,
      address,
      refresh,
    )
    return id
  })

  return { workspaceId, mailboxId, address }
}

async function whoami(provider: Provider, accessToken: string) {
  const url =
    provider === 'gmail'
      ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
      : 'https://graph.microsoft.com/v1.0/me'
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Could not read the account: ${provider} said ${res.status}`)
  const json = (await res.json()) as { emailAddress?: string; mail?: string; userPrincipalName?: string }
  const address = json.emailAddress ?? json.mail ?? json.userPrincipalName
  if (!address) throw new Error('That account has no email address')
  return address
}

/**
 * A fresh access token.
 *
 * Never stored: they last an hour, so keeping them would mean a second thing to keep in
 * step and a second thing to leak. The refresh token is the only credential at rest.
 */
async function accessTokenFor(mailbox: { id: string; provider: Provider; refresh_enc: string }) {
  const refresh = openOrNull(mailbox.refresh_enc)
  if (!refresh) throw new Error('That mailbox token cannot be read — check SECRET_KEY')
  const tokens = await exchange(mailbox.provider, { grant_type: 'refresh_token', refresh_token: refresh })
  // Google sometimes rotates the refresh token; Microsoft always does.
  if (tokens.refresh_token && tokens.refresh_token !== refresh)
    await run(`UPDATE mailboxes SET refresh_enc = ? WHERE id = ?`, seal(tokens.refresh_token), mailbox.id)
  return tokens.access_token
}

export async function disconnect(workspaceId: number, mailboxId: string) {
  // Looked up rather than inferred from the delete's row count, so the threads can go first.
  const found = await one<{ id: string }>(
    `SELECT id FROM mailboxes WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    mailboxId,
  )
  if (!found) throw new Error('No such mailbox')

  // The threads that arrived in this mailbox. Disconnecting drops the refresh token, so
  // nothing can be fetched or replied to on them again. This order leaves the mailbox still
  // listed if it fails, which is retryable; the reverse leaves unanswerable threads behind.
  await removeConnection(workspaceId, id, mailboxId)
  await run(`DELETE FROM mailboxes WHERE workspace_id = ? AND id = ?`, workspaceId, mailboxId)
}

// ---------------------------------------------------------------- inbound

export type Incoming = {
  externalId: string
  threadId: string
  /** When it was sent, per the provider. Mail is swept in batches; filing order is not it. */
  at?: Date | null
  /** What came with it. Filled in by the sweep, which is what holds the credentials. */
  attachments?: File[]
  /**
   * The RFC 5322 `Message-ID` header, which is the only id other mail systems thread on.
   *
   * Not the same as the provider's own id in `externalId`: putting that in `In-Reply-To`
   * threads nothing anywhere, and Gmail quietly starts a new conversation instead of
   * adding to the one it was told to.
   */
  replyRef: string | null
  from: string
  name: string | null
  subject: string
  text: string
}

/**
 * Mail that nobody wrote and nobody reads.
 *
 * Security alerts, receipts, newsletters, bounces, out-of-office. Answering one is worse
 * than useless — it spends a model call to write to an address that discards it, and it
 * fills the inbox with threads no person will ever action.
 *
 * The signals are the ones the mail standards define for exactly this, plus the sender
 * convention everybody uses. Kept pure so each rule can be tested against a real header.
 */
export function isAutomated(from: string, header: (name: string) => string): boolean {
  // RFC 3834: what an auto-responder sets so other auto-responders do not answer it.
  const auto = header('auto-submitted').toLowerCase()
  if (auto && auto !== 'no') return true
  if (header('x-auto-response-suppress')) return true

  // Bulk mail and mailing lists announce themselves.
  const precedence = header('precedence').toLowerCase()
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true
  if (header('list-id') || header('list-unsubscribe')) return true

  // A null return path is a bounce, by definition.
  if (header('return-path').trim() === '<>') return true

  // And the convention: an address that says not to reply to it.
  const local = from.split('@')[0].toLowerCase().replace(/[._-]/g, '')
  return ['noreply', 'donotreply', 'nreply', 'mailerdaemon', 'postmaster', 'bounce', 'bounces'].some((p) =>
    local.startsWith(p),
  )
}

/** The shape each provider's list call comes back in, normalised. Pure and testable. */
export function parseGmail(message: any): Incoming | null {
  const headers: { name: string; value: string }[] = message?.payload?.headers ?? []
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? ''

  /*
   * `From` is either `someone@example.com` or `"Ada Lovelace" <ada@example.com>`. The
   * display name only exists in the second form — taking the whole header otherwise would
   * file the address as the person's *name*, so every customer record would read
   * "kit@example.com" twice and nobody would ever look like they had a name.
   */
  const from = header('from')
  const bracketed = /<([^>]+)>/.exec(from)
  const address = bracketed?.[1] ?? from.trim()
  if (!address) return null

  const text = bodyOf(message?.payload).trim()
  if (!text) return null

  // Nothing a person wrote, so nothing to answer.
  if (isAutomated(address.toLowerCase(), header)) return null

  return {
    externalId: `gmail:${message.id}`,
    threadId: String(message.threadId ?? message.id),
    // Milliseconds, as a string.
    at: message.internalDate ? new Date(Number(message.internalDate)) : null,
    replyRef: header('message-id') || null,
    from: address.toLowerCase(),
    name: bracketed ? from.slice(0, bracketed.index).replace(/"/g, '').trim() || null : null,
    subject: header('subject') || '(no subject)',
    text,
  }
}

/**
 * Walk a Gmail payload for the best text we can find.
 *
 * Two passes, and the order matters: a multipart/alternative message carries the same
 * words as both plain text and HTML, and MIME lists them least-rich first — so a single
 * pass that returns the first hit prefers whichever the sender happened to put first.
 * Flattened HTML is always noisier than the plain part the sender already wrote, and that
 * noise ends up in the retrieval index and in the model's context.
 */
function bodyOf(part: any): string {
  const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8')

  const find = (node: any, want: string): string => {
    if (!node) return ''
    if (node.mimeType === want && node.body?.data) return decode(node.body.data)
    for (const child of node.parts ?? []) {
      const found = find(child, want)
      if (found) return found
    }
    return ''
  }

  const plain = find(part, 'text/plain')
  if (plain.trim()) return plain
  const html = find(part, 'text/html')
  return html ? stripHtml(html) : ''
}

export function parseGraph(message: any): Incoming | null {
  const address: string = message?.from?.emailAddress?.address ?? message?.sender?.emailAddress?.address ?? ''
  if (!address) return null

  const raw: string = message?.body?.content ?? message?.bodyPreview ?? ''
  const text = (message?.body?.contentType === 'html' ? stripHtml(raw) : raw).trim()
  if (!text) return null

  // Graph hands the headers over as a list, and only when they are asked for by name.
  const list: { name: string; value: string }[] = message?.internetMessageHeaders ?? []
  const header = (name: string) => list.find((h) => h.name?.toLowerCase() === name)?.value ?? ''
  if (isAutomated(address.toLowerCase(), header)) return null

  return {
    externalId: `outlook:${message.id}`,
    threadId: String(message.conversationId ?? message.id),
    at: message.receivedDateTime ? new Date(message.receivedDateTime) : null,
    replyRef: message?.internetMessageId ?? null,
    from: address.toLowerCase(),
    name: message?.from?.emailAddress?.name ?? null,
    subject: message.subject || '(no subject)',
    text,
  }
}

/**
 * The files on one Gmail message.
 *
 * A part is an attachment when it has a filename; everything else in the tree is the body
 * in one of its forms.
 *
 * What is skipped is what `Content-Disposition` calls inline — a signature logo, filed forty
 * times, is noise rather than evidence. Not `Content-ID`, which was the first thing I tried
 * and is wrong: ordinary attachments carry one routinely, and an invoice PDF from a billing
 * system arrived with both a Content-ID and a disposition of "attachment".
 *
 * One failure does not lose the message — the mail is worth filing without its files.
 */
async function gmailAttachments(message: any, messageId: string, token: string): Promise<File[]> {
  const found: File[] = []

  const walk = (node: any) => {
    if (!node) return
    const filename: string = node.filename ?? ''
    const disposition: string =
      (node.headers ?? []).find((h: any) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''
    const inline = disposition.trim().toLowerCase().startsWith('inline')
    if (filename && node.body?.attachmentId && !inline)
      found.push({
        name: filename,
        mime: node.mimeType ?? null,
        size: node.body.size ?? 0,
        externalRef: node.body.attachmentId,
      })
    for (const child of node.parts ?? []) walk(child)
  }
  walk(message?.payload)

  for (const file of found) {
    // Over the cap, so the row records what it was and we never spend the bandwidth.
    if ((file.size ?? 0) > MAX_BYTES) continue
    try {
      const part = await fetchJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${file.externalRef}`,
        token,
      )
      if (part?.data) file.bytes = Buffer.from(part.data, 'base64url')
    } catch {
      // Left without bytes: the thread still shows that a file came, and its name.
    }
  }
  return found
}

/** The same for Graph, where the bytes arrive base64 in the attachment itself. */
async function graphAttachments(messageId: string, token: string): Promise<File[]> {
  try {
    const listed = await fetchJson(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments`, token)
    return (listed.value ?? [])
      // Item attachments are whole emails or calendar items, not files.
      .filter((a: any) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && !a.isInline)
      .map((a: any) => ({
        name: a.name ?? 'file',
        mime: a.contentType ?? null,
        size: a.size ?? 0,
        externalRef: a.id ?? null,
        bytes: a.contentBytes && a.size <= MAX_BYTES ? Buffer.from(a.contentBytes, 'base64') : null,
      }))
  } catch {
    return []
  }
}

async function fetchJson(url: string, accessToken: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json() as Promise<any>
}

/**
 * One mailbox's sweep.
 *
 * Reads the list first and the bodies second, with the already-filed check in between —
 * so a re-sync of an unchanged mailbox costs one request rather than one per message.
 */
async function sweepOne(mailbox: { id: string; workspace_id: number; provider: Provider; address: string; since: string; refresh_enc: string }) {
  const token = await accessTokenFor(mailbox)
  const since = new Date(mailbox.since)
  let filed = 0

  const incoming: Incoming[] =
    mailbox.provider === 'gmail'
      ? await (async () => {
          // Gmail's query language takes whole days only, so the precise floor is applied
          // again below — this just keeps the list request small.
          const q = `in:inbox after:${Math.floor(since.getTime() / 1000)}`
          const out: Incoming[] = []
          let page: string | undefined
          /*
           * Paged until PER_SWEEP messages nobody has filed are found, rather than taking the
           * newest PER_SWEEP and stopping.
           *
           * `since` is a floor somebody set and it never moves, so one page of the newest
           * twenty was all a mailbox could ever reach: after the first sweep filed them, every
           * later sweep listed the same twenty, skipped all twenty as already filed, and
           * returned nothing. A mailbox with a year of history behind that floor reported a
           * clean last_sync forever and imported none of it. Walking the pages is what makes
           * the sweep after this one see something new.
           */
          for (let i = 0; i < MAX_PAGES && out.length < PER_SWEEP; i++) {
            const listed = await fetchJson(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${PER_SWEEP}&q=${encodeURIComponent(q)}` +
                (page ? `&pageToken=${encodeURIComponent(page)}` : ''),
              token,
            )
            for (const stub of listed.messages ?? []) {
              if (out.length >= PER_SWEEP) break
              if (await alreadyFiled(mailbox.workspace_id, `gmail:${stub.id}`)) continue
              const full = await fetchJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`, token)
              const parsed = parseGmail(full)
              if (!parsed) continue
              parsed.attachments = await gmailAttachments(full, stub.id, token)
              out.push(parsed)
            }
            page = listed.nextPageToken
            if (!page) break
          }
          return out
        })()
      : await (async () => {
          const filter = `receivedDateTime gt ${since.toISOString()}`
          // internetMessageHeaders and internetMessageId are only returned when named.
          const select =
            'id,conversationId,internetMessageId,internetMessageHeaders,from,sender,subject,body,bodyPreview,receivedDateTime,hasAttachments'
          const out: Incoming[] = []
          // Same paging, and for the same reason — see the Gmail branch above.
          let next: string | undefined =
            `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${PER_SWEEP}&$select=${select}` +
            `&$orderby=receivedDateTime desc&$filter=${encodeURIComponent(filter)}`
          for (let i = 0; i < MAX_PAGES && next && out.length < PER_SWEEP; i++) {
            const listed = await fetchJson(next, token)
            for (const m of listed.value ?? []) {
              if (out.length >= PER_SWEEP) break
              if (await alreadyFiled(mailbox.workspace_id, `outlook:${m.id}`)) continue
              const parsed = parseGraph(m)
              if (!parsed) continue
              if (m.hasAttachments) parsed.attachments = await graphAttachments(m.id, token)
              out.push(parsed)
            }
            next = listed['@odata.nextLink']
          }
          return out
        })()

  for (const message of incoming) {
    // Our own outgoing mail coming back through the inbox rule of a shared mailbox.
    if (message.from === mailbox.address.toLowerCase()) continue
    await ask(mailbox.workspace_id, {
      channel: 'email',
      channelRef: `${mailbox.id}:${message.threadId}`,
      from: message.from,
      email: message.from,
      name: message.name,
      subject: message.subject,
      text: message.text,
      externalId: message.externalId,
      replyRef: message.replyRef,
      at: message.at,
      attachments: message.attachments,
    })
    filed++
  }

  await run(`UPDATE mailboxes SET last_sync = now(), last_error = NULL WHERE id = ?`, mailbox.id)
  return filed
}

const alreadyFiled = async (workspaceId: number, externalId: string) =>
  !!(await one(`SELECT 1 FROM messages WHERE workspace_id = ? AND external_id = ?`, workspaceId, externalId))

/**
 * Every mailbox on the instance, in sequence.
 *
 * Enumerating mailboxes across workspaces is a genuine system read — the poller has no
 * session and no workspace of its own. Each mailbox's actual work then runs inside its own
 * scope, so nothing but this listing crosses the boundary.
 */
export async function sweepAll() {
  const mailboxes = await asSystem(() =>
    all<{ id: string; workspace_id: number; provider: Provider; address: string; since: string; refresh_enc: string }>(
      `SELECT id, workspace_id, provider, address, since, refresh_enc FROM mailboxes`,
    ),
  )

  let filed = 0
  for (const mailbox of mailboxes) {
    try {
      filed += await withWorkspace({ workspaceId: mailbox.workspace_id }, () => sweepOne(mailbox))
    } catch (e) {
      // One mailbox failing must not stop the others. The error is recorded on the row so
      // the channels page can say what is wrong rather than showing a silent stall.
      await asSystem(() =>
        run(`UPDATE mailboxes SET last_sync = now(), last_error = ? WHERE id = ?`, String(e instanceof Error ? e.message : e).slice(0, 300), mailbox.id),
      )
    }
  }
  return filed
}

/** Only the channels page needs this: sync one mailbox now rather than waiting for the timer. */
export async function syncNow(workspaceId: number, mailboxId: string) {
  const mailbox = await one<{ id: string; workspace_id: number; provider: Provider; address: string; since: string; refresh_enc: string }>(
    `SELECT id, workspace_id, provider, address, since, refresh_enc FROM mailboxes WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    mailboxId,
  )
  if (!mailbox) throw new Error('No such mailbox')
  try {
    return await sweepOne(mailbox)
  } catch (e) {
    await run(`UPDATE mailboxes SET last_error = ? WHERE id = ?`, String(e instanceof Error ? e.message : e).slice(0, 300), mailboxId)
    throw e
  }
}

// ---------------------------------------------------------------- outbound

export async function send(conversation: Conversation, text: string, files: Sendable[] = []): Promise<string | null> {
  const [mailboxId, ...rest] = conversation.channel_ref.split(':')
  const threadId = rest.join(':')

  const mailbox = await one<{ id: string; provider: Provider; address: string; refresh_enc: string }>(
    `SELECT id, provider, address, refresh_enc FROM mailboxes WHERE id = ?`,
    mailboxId,
  )
  if (!mailbox) throw new Error('That mailbox is no longer connected')

  const token = await accessTokenFor(mailbox as any)

  /*
   * Reply to the last thing they actually sent, so the mail threads in their client rather
   * than arriving as an unrelated message.
   *
   * Two ids, and they are not interchangeable. `reply_ref` is the RFC Message-ID, which is
   * what In-Reply-To and References must carry and what every mail client threads on. The
   * provider's own id is a different string, useful only for addressing Graph's endpoint.
   */
  const last = await one<{ external_id: string; reply_ref: string | null }>(
    `SELECT external_id, reply_ref FROM messages
      WHERE conversation_id = ? AND direction = 'in' AND external_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    conversation.id,
  )
  const providerMessageId = last?.external_id?.split(':').slice(1).join(':')
  // The angle brackets are part of the header's syntax; providers store it both ways.
  const replyRef = last?.reply_ref
    ? last.reply_ref.startsWith('<')
      ? last.reply_ref
      : `<${last.reply_ref}>`
    : null

  if (mailbox.provider === 'outlook') {
    if (!providerMessageId) throw new Error('Nothing to reply to in this thread')

    /*
     * A draft, then the files, then send.
     *
     * `/reply` sends immediately and has no attachment slot at any size, so the whole branch
     * is three calls rather than one. That is not only how a file gets out: `/reply` also
     * returns no id, so `external_id` was never stamped and the inbox printed "not
     * delivered" under every Outlook reply this product has ever sent. `createReply` hands
     * back a draft, which has one.
     */
    const draft = await graph<{ id: string }>(
      token,
      `https://graph.microsoft.com/v1.0/me/messages/${providerMessageId}/createReply`,
      { comment: text },
    )
    if (!draft?.id) throw new Error('Outlook would not open a reply to that message')

    for (const p of await bodies(files)) await attachToDraft(token, draft.id, p)

    await graph(token, `https://graph.microsoft.com/v1.0/me/messages/${draft.id}/send`, {})
    return `outlook:${draft.id}`
  }

  const to = await recipientOf(conversation.id)
  const subject = conversation.subject?.startsWith('Re:') ? conversation.subject : `Re: ${conversation.subject ?? ''}`.trim()

  const parts = await bodies(files)
  const boundary = `arlo-${randomBytes(12).toString('hex')}`
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    // Gmail checks these against the threadId it is handed. Missing or wrong, and it files
    // the reply as a new conversation instead — which is exactly what the customer saw.
    ...(replyRef ? [`In-Reply-To: ${replyRef}`, `References: ${replyRef}`] : []),
  ]

  const raw = parts.length
    ? [
        ...headers,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        text,
        ...parts.flatMap((p) => [
          `--${boundary}`,
          `Content-Type: ${p.mime}; name="${p.name}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${p.name}"`,
          '',
          // Wrapped at 76: RFC 2045 puts a hard limit at 998 and mail servers in the middle
          // have been known to enforce the softer one.
          p.bytes.toString('base64').replace(/(.{76})/g, '$1\r\n'),
        ]),
        `--${boundary}--`,
        '',
      ].join('\r\n')
    : [...headers, 'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n')

  const res = parts.length
    ? await sendUpload(token, threadId, raw)
    : await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        // threadId is what actually threads it in Gmail; the headers are for everyone else.
        body: JSON.stringify({ raw: Buffer.from(raw, 'utf8').toString('base64url'), threadId }),
        signal: AbortSignal.timeout(30_000),
      })

  if (!res.ok) throw new Error(`Gmail refused the reply: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const sent = (await res.json()) as { id?: string }
  return sent.id ? `gmail:${sent.id}` : null
}

/**
 * The bytes of everything being attached, base64'd once.
 *
 * Reads the resource rather than the attachment row, because the row is a pointer to this
 * and because we are inside the request's workspace scope here.
 */
async function bodies(files: Sendable[]) {
  const out: { name: string; mime: string; bytes: Buffer }[] = []
  for (const f of files) {
    const held = await byToken(f.token)
    if (!held?.bytes) continue
    out.push({
      // A quote or a newline in a filename would break out of the MIME header it lands in.
      name: f.title.replace(/["\\\r\n]/g, ''),
      mime: f.mime ?? 'application/octet-stream',
      bytes: held.bytes,
    })
  }
  return out
}

type Body = { name: string; mime: string; bytes: Buffer }

/**
 * Put one file on a Graph draft, whichever way its size demands.
 *
 * Under 3MB Graph takes the whole thing in one POST. Over it that endpoint simply refuses,
 * and the file has to go up an upload session in pieces — which is the difference between a
 * 4MB price list arriving and a customer being sent a link they cannot open.
 */
async function attachToDraft(token: string, draftId: string, file: Body) {
  const base = `https://graph.microsoft.com/v1.0/me/messages/${draftId}/attachments`

  if (file.bytes.length <= GRAPH_SIMPLE_MAX) {
    await graph(token, base, {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: file.name,
      contentType: file.mime,
      contentBytes: file.bytes.toString('base64'),
    })
    return
  }

  const session = await graph<{ uploadUrl: string }>(token, `${base}/createUploadSession`, {
    AttachmentItem: { attachmentType: 'file', name: file.name, size: file.bytes.length, contentType: file.mime },
  })
  if (!session?.uploadUrl) throw new Error(`Outlook would not open an upload for ${file.name}`)

  /*
   * Chunked, and the ranges have to be exact.
   *
   * No authorization header on these: the upload URL carries its own, and adding the bearer
   * token is an error rather than merely redundant. `Content-Range` is inclusive at both
   * ends, and a gap or an overlap does not fail loudly — it produces a corrupt file at the
   * other end, which is why the test asserts the chunks tile the original exactly.
   */
  for (let at = 0; at < file.bytes.length; at += GRAPH_CHUNK) {
    const slice = file.bytes.subarray(at, Math.min(at + GRAPH_CHUNK, file.bytes.length))
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(slice.length),
        'content-range': `bytes ${at}-${at + slice.length - 1}/${file.bytes.length}`,
      },
      body: new Uint8Array(slice),
      signal: AbortSignal.timeout(120_000),
    })
    // 200/202 for every chunk but the last, 201 for the last.
    if (!res.ok)
      throw new Error(`Outlook refused a chunk of ${file.name}: ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
}

/**
 * Send a message with attachments, through Gmail's media endpoint.
 *
 * The ordinary `messages/send` takes the whole message base64url'd inside a JSON body, on a
 * path documented at 5MB — and the MIME above has *already* base64'd the file, so the real
 * ceiling on that path is under 3MB of actual PDF. A 4MB price list would simply be refused.
 *
 * `uploadType=multipart` puts the RFC822 in its own part, unencoded, and raises the limit to
 * 35MB. `threadId` still rides in the JSON part, and it is what actually threads the reply.
 */
async function sendUpload(token: string, threadId: string, raw: string) {
  const boundary = `arlo-envelope-${randomBytes(12).toString('hex')}`
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify({ threadId }),
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    raw,
    `--${boundary}--`,
    '',
  ].join('\r\n')

  return fetch('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(120_000),
  })
}

/** Whoever this conversation is with, as an address. */
async function recipientOf(conversationId: number) {
  const row = await one<{ email: string | null; external_id: string }>(
    `SELECT c.email, i.external_id
       FROM conversations v
       JOIN customers c ON c.id = v.customer_id
       LEFT JOIN customer_identities i
              ON i.customer_id = c.id AND i.channel = 'email'
      WHERE v.id = ? LIMIT 1`,
    conversationId,
  )
  const to = row?.email ?? row?.external_id
  if (!to) throw new Error('No address to reply to')
  return to
}

/**
 * One Graph POST, with the answer parsed when there is one.
 *
 * Graph answers 202 with an empty body for `/send`, and 201 with the draft for
 * `createReply`, so the JSON parse has to be conditional rather than assumed.
 */
async function graph<T = unknown>(token: string, url: string, body: object): Promise<T | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`Outlook refused ${url.split('/').pop()}: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const text = await res.text()
  return text ? (JSON.parse(text) as T) : null
}
