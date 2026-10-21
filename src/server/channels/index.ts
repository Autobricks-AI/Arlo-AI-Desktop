/**
 * Getting a reply back out.
 *
 * A support product is the loop, not the filing — answering is what makes it one. So
 * delivery is a first-class thing with one shape per channel and one place that picks
 * between them.
 *
 * `deliver()` is the only way a message leaves this system. It records the outbound
 * message first and hands it to the channel second, so a delivery that fails leaves a
 * visible message in the thread marked as undelivered rather than a silence nobody can
 * explain.
 */
import type { Cite, Conversation } from '../conversations.ts'
import { get, record, removeUnreachable, setStatus } from '../conversations.ts'
import { all, run } from '../db.ts'
import { REPLY, take } from '../throttle.ts'
import * as email from './email.ts'
import * as telegram from './telegram.ts'
import * as whatsapp from './whatsapp.ts'
import * as web from './web.ts'
import { add as attach } from '../attachments.ts'
import { addressOf } from '../resources.ts'
import type { Sendable } from '../resources.ts'
import { BOT_AUTHOR } from '../../types.ts'

export type Channel = {
  id: string
  label: string
  /**
   * Put this text in front of the customer. Returns the channel's own message id when it
   * has one, which is what makes a redelivery recognisable later.
   *
   * A channel that throws is a delivery failure, not a bug: the network is allowed to be
   * down. deliver() catches it.
   */
  send(conversation: Conversation, text: string, files?: Sendable[]): Promise<string | null>

  /**
   * The biggest file this channel will carry, when something binds.
   *
   * Absent means nothing does — our own 25MB resource cap is below every channel's real
   * ceiling once its media path exists. A channel that has not grown one yet says `0`, and
   * everything degrades to an address in the body.
   *
   * A function when one number cannot tell the truth. Email is the reason: a mailbox is
   * Gmail or Outlook, their ceilings are nothing like each other, and which one this
   * conversation is on is not known until the mailbox is looked up. Quoting the lower of the
   * two at both is how a 4MB file that Gmail would have carried became a dead link.
   */
  maxFile?: number | ((conversation: Conversation) => number | Promise<number>)
}

/**
 * What can go as a file, and what has to go as an address.
 *
 * A link has no bytes and never could. A file over the channel's ceiling is the same problem
 * arriving a different way, and it gets the same answer: name it in the body, because a
 * customer told nothing goes looking for an attachment that is not there.
 *
 * Pure on purpose — this is where the whole oversize rule lives, so it can be proved without
 * a channel or a database anywhere near it.
 */
export const partition = (files: Sendable[], cap = Infinity) => ({
  attach: files.filter((f) => f.kind === 'file' && !!f.token && f.size_bytes <= cap),
  asText: files.filter((f) => f.kind !== 'file' || !f.token || f.size_bytes > cap),
})

/**
 * Name the things that could not be attached, with somewhere to get them.
 *
 * Skips any address the reply already contains: a model that pasted the link itself must not
 * be made to say it twice.
 */
export function append(text: string, files: Sendable[]): string {
  const base = (process.env.PUBLIC_URL || 'http://127.0.0.1:9005').replace(/\/+$/, '')
  const lines = files
    .map((f) => ({ title: f.title, address: addressOf(f as never, base) }))
    .filter((f) => f.address && !text.includes(f.address))
    .map((f) => `${f.title}: ${f.address}`)
  return lines.length ? `${text}\n\n${lines.join('\n')}` : text
}

/**
 * Every channel that can carry a reply.
 *
 * ponytail: a plain object, not a registry with registration calls. There will be four or
 * five of these ever, and they are all in this directory.
 */
const CHANNELS: Record<string, Channel> = { web, telegram, whatsapp, email }

export const channelFor = (id: string): Channel | undefined => CHANNELS[id]
export const channels = () => Object.values(CHANNELS)

export type Delivered = {
  ok: boolean
  messageId: number | null
  error?: string
  /**
   * What actually went out.
   *
   * Not the same string the caller passed in: deliver() appends addresses for anything the
   * channel could not carry natively. A caller that echoed its own input back to an operator
   * — the inbox does — would otherwise show something the customer never saw.
   */
  body?: string
}

/**
 * Record and send one outbound message.
 *
 * The rate limit is per workspace and it is not decoration. Two things it stops: an agent
 * that ends up answering its own message, and a hostile sender running up the model bill
 * or getting a WhatsApp number banned for spam. It refuses *before* the send, so the
 * refusal costs nothing.
 */
export async function deliver(
  workspaceId: number,
  conversation: Conversation,
  text: string,
  {
    author = BOT_AUTHOR,
    cited = null,
    speaker,
    files = [],
  }: { author?: string; cited?: Cite[] | null; speaker?: 'team' | 'bot'; files?: Sendable[] } = {},
): Promise<Delivered> {
  const wait = await take(`reply:${workspaceId}`, REPLY)
  if (wait)
    return { ok: false, messageId: null, error: `Rate limited: ${Math.ceil(wait / 1000)}s before the next reply` }

  const channel = channelFor(conversation.channel)
  if (!channel) return { ok: false, messageId: null, error: `No channel called "${conversation.channel}"` }

  /*
   * Split before anything is written, so the body already names whatever cannot go natively
   * by the time it is recorded. A link resource, a file over this channel's ceiling and a
   * channel with no media path yet are three causes of one situation, and they get one
   * answer: say where it is, rather than promise a file that never arrives.
   */
  // Resolved once, and only when there is something to weigh: a channel that asks the
  // database which mailbox this is should not be doing it on every text-only reply.
  const cap = !files.length
    ? Infinity
    : typeof channel.maxFile === 'function'
      ? await channel.maxFile(conversation)
      : (channel.maxFile ?? Infinity)

  const { attach: attachable, asText } = partition(files, cap)
  const body = append(text, asText)

  // Recorded first. If the send then fails, the thread shows what we tried to say — which
  // is what somebody picking the conversation up needs to know.
  /*
   * Anything not sent under the bot's own name was typed by a person, and the learning
   * extractor depends on knowing the difference — a fact may only come from the company's
   * own words.
   */
  const message = await record(workspaceId, conversation.id, {
    direction: 'out',
    body,
    author,
    cited,
    speaker: speaker ?? (author === BOT_AUTHOR ? 'bot' : 'team'),
  })

  /*
   * A pointer, not a copy.
   *
   * The bytes already exist once, on the resource. Copying them here would put twelve
   * gigabytes in `attachments` for one price list sent five hundred times — in a table whose
   * migration already sets `storage external` because that worry was live when it was
   * written. `attachments.open()` follows the ref when somebody asks for the file.
   *
   * Filed whether or not the channel then manages to send it, so the inbox shows what was
   * meant to go out rather than quietly disagreeing with the customer.
   */
  if (message)
    for (const f of attachable)
      await attach(workspaceId, message.id, {
        name: f.title,
        mime: f.mime,
        size: f.size_bytes,
        externalRef: `resource:${f.token}`,
      })

  try {
    const externalId = await channel.send(conversation, body, attachable)
    // Stamped after the fact, because it does not exist until the channel has accepted the
    // message. It is what makes our own message recognisable when the channel echoes it
    // back to us — otherwise the socket channels file their own replies as new questions.
    if (externalId && message)
      await run(`UPDATE messages SET external_id = ? WHERE workspace_id = ? AND id = ?`, externalId, workspaceId, message.id)
    return { ok: true, messageId: message?.id ?? null, body }
  } catch (e) {
    return {
      ok: false,
      messageId: message?.id ?? null,
      error: e instanceof Error ? e.message : String(e),
      body,
    }
  }
}

/**
 * A person answering, from the inbox.
 *
 * Sending takes the thread over. A bot talking underneath a human is the worst failure
 * this product has, and somebody who has typed a reply has plainly decided to own it —
 * including on a closed thread, where answering is what reopens it. Handing it back to
 * Arlo is one button, and it is the only way back.
 */
export async function replyAsPerson(
  workspaceId: number,
  conversationId: number,
  text: string,
  author: string,
  files: Sendable[] = [],
) {
  /*
   * A file sent with nothing typed goes on its own.
   *
   * It used to be captioned with its own filename, because the socket channels put a text
   * message out before the attachment and an empty one is a refused send. But that caption
   * arrives as a *second* message sitting above a document that already shows its name, so
   * the recipient reads the filename twice and nobody wrote either of them. The channels
   * skip the text send instead when there is nothing to say -- see telegram.ts and
   * whatsapp.ts, which then report the file's own id so the send still counts as delivered.
   */
  const body = text.trim()
  if (!body && !files.length) throw new Error('Nothing to send')

  const conversation = await get(workspaceId, conversationId)
  if (!conversation) throw new Error('No such conversation')

  if (conversation.status !== 'human') await setStatus(workspaceId, conversationId, 'human', author)

  /*
   * `speaker` said outright, not left to be guessed from the author string.
   *
   * `deliver()` falls back to `author === BOT_AUTHOR ? 'bot' : 'team'`, and BOT_AUTHOR is
   * 'arlo' — which is also DEFAULT_USER, the account every fresh install signs in as. So on
   * a default install every word a person typed was filed as the bot's own, and the learning
   * extractor, whose first rule is that a fact may only come from the team, could never see
   * anything to learn: `harvest()` returned 0 before it spent a single call.
   *
   * This function is the person's path by definition. It knows, so it says.
   */
  const result = await deliver(workspaceId, conversation, body, { author, speaker: 'team', files })
  // deliver() records before it sends, so a failure here means "it is in the thread but
  // did not go out" — which the person who typed it has to be told.
  if (!result.ok) throw new Error(result.error ?? 'That did not send')
  return result
}

/**
 * How much has come in, per channel and per connection.
 *
 * One query rather than one per card: the connection id is the first segment of the
 * thread reference on every channel — bot, linked number, mailbox, widget — so grouping on
 * it gives both numbers at once. A reference from before a channel carried its connection
 * id groups under itself, which reads as an unknown connection rather than vanishing.
 */
export type Stat = { channel: string; connection: string; threads: number; last_at: string }

export const stats = (workspaceId: number) =>
  all<Stat>(
    `SELECT channel, split_part(channel_ref, ':', 1) AS connection, count(*)::int AS threads, max(last_at) AS last_at
       FROM conversations WHERE workspace_id = ? GROUP BY 1, 2`,
    workspaceId,
  )

/**
 * Every live connection, named the way a person would name it.
 *
 * The inbox needs this because a channel is not an account: "email" does not say which
 * mailbox a question arrived in, and a workspace with a support address and a sales one
 * cannot be worked from a row that says only "email". The connection id is already the
 * first segment of every thread reference, so this is the lookup that turns it into
 * "Gmail · support@acme.com".
 *
 * `connector` is narrower than `channel` on purpose: both mailbox providers are the
 * `email` channel, and they are Gmail and Outlook on screen.
 */
export type Connection = { channel: string; connection: string; connector: string; label: string }

export async function connections(workspaceId: number): Promise<Connection[]> {
  const [widgets, bots, mailboxes] = await Promise.all([
    web.list(workspaceId),
    telegram.list(workspaceId),
    email.list(workspaceId),
  ])

  return [
    ...widgets.map((w) => ({ channel: 'web', connection: w.id, connector: 'web', label: w.label })),
    ...bots.map((b) => ({
      channel: 'telegram',
      connection: b.id,
      connector: 'telegram',
      label: b.username ? `${b.label} (@${b.username})` : b.label,
    })),
    // Synchronous: WhatsApp accounts are folders on disk, not rows.
    ...whatsapp.list(workspaceId).map((a) => ({
      channel: 'whatsapp',
      connection: a.id,
      connector: 'whatsapp',
      label: a.phone ? `${a.label} (+${a.phone})` : a.label,
    })),
    ...mailboxes.map((m) => ({ channel: 'email', connection: m.id, connector: m.provider, label: m.address })),
  ]
}

/** The connection half of a thread reference — the same split every channel writes. */
export { connectionOf } from '../../types.ts'

/**
 * Delete threads that arrived on a connection somebody removed.
 *
 * A conversation carries the connection it arrived on. Remove the widget, the bot or the
 * mailbox and those threads cannot be answered — no key, no token, no address behind them —
 * so they sit in the inbox as rows whose only possible outcome is an error.
 *
 * **WhatsApp is deliberately not here, and that is the whole point of this comment.**
 *
 * It used to be, and it cost a production workspace every conversation on a number. The
 * inference this function makes is "not in the live list, therefore somebody removed it".
 * For a widget, a bot or a mailbox that holds: those are rows, and a row only disappears
 * when a person deletes it. A WhatsApp link is a *directory*, and `onConnection` deletes
 * that directory by itself when WhatsApp closes a socket with 401 — a conflict from another
 * device, a re-pair, the phone dropping the session. Nobody removed anything. The number
 * simply needed scanning again, and instead the next press of Refresh read the absent folder
 * as a removal and deleted the lot.
 *
 * Nothing is lost by leaving it out: `whatsapp.removeImpl` deletes a number's conversations
 * when somebody actually unlinks it, behind a dialog that says so. That is the case this was
 * covering, and it is covered better there — at the moment of the decision, by the code that
 * knows a decision was made.
 *
 * **Fail-closed per channel** for the three that remain: a channel whose query throws is
 * skipped rather than treated as empty, because a database that is briefly unhappy is not a
 * database with no widgets in it.
 *
 * Not on the inbox loader. The inbox polls every ten seconds, and a destructive sweep six
 * times a minute per open tab is a great deal of chance for one read to be wrong. It runs
 * from the Refresh button, where somebody asked for it.
 */
export async function tidy(workspaceId: number): Promise<number> {
  /** A channel's live connection ids, or null when it could not say. */
  const live: Record<string, string[] | null> = {}

  for (const [channel, read] of [
    ['web', () => web.list(workspaceId)],
    ['telegram', () => telegram.list(workspaceId)],
    ['email', () => email.list(workspaceId)],
  ] as const) {
    try {
      live[channel] = (await read()).map((c) => c.id)
    } catch (e) {
      // Unknown, so untouched. Logged because a channel silently opting out of the tidy
      // forever would look like the tidy not working.
      console.error(`[channels] tidy skipped ${channel}:`, e instanceof Error ? e.message : e)
      live[channel] = null
    }
  }

  let removed = 0
  for (const [channel, refs] of Object.entries(live)) {
    if (!refs) continue
    const { changes } = await removeUnreachable(workspaceId, channel, refs)
    // Said out loud, per channel. A destructive sweep that reports nothing is one nobody can
    // audit afterwards — which is exactly the position this function put us in.
    if (changes) console.log(`[channels] tidy removed ${changes} ${channel} thread(s) in workspace ${workspaceId}`)
    removed += changes
  }
  return removed
}
