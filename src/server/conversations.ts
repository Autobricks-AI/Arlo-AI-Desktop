/**
 * Threads and the messages in them.
 *
 * A conversation is identified by (channel, channel_ref) — the channel's own idea of a
 * thread. That is what lets a reply be delivered back to the right place, and what stops
 * a second message from the same person opening a second thread.
 */
import { all, insert, isUniqueViolation, one, run, tx } from './db.ts'
import { INBOX_PAGE } from '../types.ts'
import type { Status } from '../types.ts'

// One definition, in the file the browser is allowed to import.
export type { Status }

export type Conversation = {
  id: number
  customer_id: number
  channel: string
  channel_ref: string
  subject: string | null
  status: Status
  assignee: string | null
  /** Which bot answered. Null when nobody's bot did. */
  bot_id: number | null
  created_at: string
  last_at: string
  /**
   * When this thread was last read for training, and the line everything after it is
   * measured from — only messages newer than this can teach anything. NULL means never.
   */
  harvested_at: string | null
  /**
   * Answer this one thread, whatever mode the bot is in.
   *
   * For watching what a bot has learned without it answering every other customer at the same
   * time. `status` cannot say this: a draft-mode bot is happy to hold a thread and still send
   * nothing. Off unless somebody turned it on, and it stays on until somebody turns it off.
   */
  answers_live: boolean
}

export type Cite = { chunk_id: number; document_id: number; title: string; uri: string | null }

/** Who wrote a message. Recorded when it is filed, never inferred afterwards. */
export type Speaker = 'customer' | 'team' | 'bot'

export type Message = {
  id: number
  direction: 'in' | 'out'
  author: string | null
  /**
   * Which of the three wrote it.
   *
   * `author` is a display name — an email, "arlo", the label of a linked number. This is the
   * fact the learning extractor needs, and reading it off the author string is how a price
   * list sent from the phone came to be filed as though the bot had said it.
   */
  speaker: Speaker
  body: string
  media_type: string | null
  external_id: string | null
  /** Email only: the RFC Message-ID, which is what a reply has to quote to thread. */
  reply_ref: string | null
  cited: Cite[] | null
  created_at: string
}

/**
 * The thread for this channel and reference, opening one if there is none.
 *
 * The insert races: two messages from the same person arriving together would both find
 * nothing and both create a thread. The unique index decides, and losing that race means
 * reading the row the winner wrote — which is why this catches the violation rather than
 * locking anything.
 */
export async function open(
  workspaceId: number,
  customerId: number,
  channel: string,
  channelRef: string,
  subject?: string | null,
): Promise<Conversation> {
  const found = await find(workspaceId, channel, channelRef)
  if (found) return found

  try {
    const id = await insert(
      `INSERT INTO conversations (workspace_id, customer_id, channel, channel_ref, subject) VALUES (?,?,?,?,?)`,
      workspaceId,
      customerId,
      channel,
      channelRef,
      subject?.slice(0, 200) || null,
    )
    return (await get(workspaceId, id))!
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    return (await find(workspaceId, channel, channelRef))!
  }
}

export const find = (workspaceId: number, channel: string, channelRef: string) =>
  one<Conversation>(
    `SELECT * FROM conversations WHERE workspace_id = ? AND channel = ? AND channel_ref = ?`,
    workspaceId,
    channel,
    channelRef,
  )

export const get = (workspaceId: number, id: number) =>
  one<Conversation>(`SELECT * FROM conversations WHERE workspace_id = ? AND id = ?`, workspaceId, id)

/**
 * Combine two threads for the same person into one — for a conversation that split across
 * two different account IDs (the same WhatsApp number linked twice, dev and prod both live)
 * rather than closing on its own.
 *
 * `last_at`, `harvested_at`, and `judged_at` each take the greater of the two rows and never
 * NULL — Postgres's GREATEST() ignores a NULL side rather than propagating it, so "never
 * read" only wins when both sides are. Every other write to these three columns only ever
 * advances them; a merge that reset one to NULL would erase real history rather than combine
 * it, which is the mistake this replaces.
 */
export async function merge(workspaceId: number, keepId: number, dropId: number): Promise<void> {
  await tx(async () => {
    await run(
      `UPDATE messages SET conversation_id = ? WHERE workspace_id = ? AND conversation_id = ?`,
      keepId,
      workspaceId,
      dropId,
    )
    const { changes } = await run(
      `UPDATE conversations k
          SET last_at = GREATEST(k.last_at, d.last_at),
              harvested_at = GREATEST(k.harvested_at, d.harvested_at),
              judged_at = GREATEST(k.judged_at, d.judged_at)
         FROM conversations d
        WHERE k.workspace_id = ? AND k.id = ? AND d.workspace_id = ? AND d.id = ?`,
      workspaceId,
      keepId,
      workspaceId,
      dropId,
    )
    if (!changes) throw new Error('No such conversation')
    const { changes: dropped } = await run(`DELETE FROM conversations WHERE workspace_id = ? AND id = ?`, workspaceId, dropId)
    if (!dropped) throw new Error('No such conversation')
  })
}

/**
 * Add a message to a thread.
 *
 * `external_id` is the redelivery guard. Every channel redelivers — a webhook that did not
 * get its 200 in time, a socket that reconnected — and without this the customer sees
 * their question answered twice. Returns null when the message has already been filed,
 * which the caller reads as "nothing to do".
 *
 * `at` is when the *channel* says it was sent, and it matters more than it looks. Filing
 * order is not send order: WhatsApp hands over a batch in whatever order it likes, and a
 * socket that reconnects replays what it missed all at once. Stamped with our own clock,
 * a thread reads back shuffled. Channels that do not tell us keep the default, which is
 * when we filed it.
 */
export async function record(
  workspaceId: number,
  conversationId: number,
  msg: {
    direction: 'in' | 'out'
    body: string
    author?: string | null
    mediaType?: string | null
    externalId?: string | null
    replyRef?: string | null
    cited?: Cite[] | null
    /** When the channel says it was sent. Defaults to now. */
    at?: Date | string | null
    /** Who wrote it. Defaults from the direction: inbound is the customer, outbound the bot. */
    speaker?: Speaker
  },
): Promise<Message | null> {
  try {
    const at = msg.at ? new Date(msg.at) : null
    const sentAt = at && !Number.isNaN(at.getTime()) ? at.toISOString() : null

    const id = await insert(
      `INSERT INTO messages (workspace_id, conversation_id, direction, author, speaker, body, media_type, external_id, reply_ref, cited, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, COALESCE(?::timestamptz, now()))`,
      workspaceId,
      conversationId,
      msg.direction,
      msg.author ?? null,
      msg.speaker ?? (msg.direction === 'in' ? 'customer' : 'bot'),
      msg.body,
      msg.mediaType ?? null,
      msg.externalId ?? null,
      msg.replyRef ?? null,
      msg.cited ? JSON.stringify(msg.cited) : null,
      sentAt,
    )
    /*
     * GREATEST, so replaying an old message does not drag a live thread back down the inbox.
     *
     * The attempt counter resets because the thread has moved on: a harvest that found
     * nothing in a greeting should not stop the same thread being read once it contains a
     * real answer.
     */
    await run(
      `UPDATE conversations SET last_at = GREATEST(last_at, COALESCE(?::timestamptz, now())),
              harvest_attempts = 0
        WHERE workspace_id = ? AND id = ?`,
      sentAt,
      workspaceId,
      conversationId,
    )
    return (await one<Message>(`SELECT * FROM messages WHERE id = ?`, id))!
  } catch (e) {
    if (isUniqueViolation(e)) return null // already filed; a redelivery
    throw e
  }
}

/**
 * The most recent messages on a thread, oldest first.
 *
 * The limit takes the **newest**, and that is the whole point of the subquery. It used to
 * order ascending and cut at the limit, which quietly kept the *oldest* 200 — so the moment a
 * thread passed two hundred messages the newest one stopped appearing, and every message
 * after that was invisible too. A real thread hit 201 and looked frozen an hour in the past:
 * the list showed a reply nobody could find in the conversation, and the thread could not be
 * scrolled to it because it was never sent to the browser.
 *
 * Reversed back to ascending afterwards, because a conversation reads downwards.
 */
export const messages = (workspaceId: number, conversationId: number, limit = 200) =>
  all<Message>(
    `SELECT * FROM (
        SELECT * FROM messages WHERE workspace_id = ? AND conversation_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ?
      ) recent ORDER BY created_at, id`,
    workspaceId,
    conversationId,
    limit,
  )

/**
 * The window before a message, for the thread that does not fit in one.
 *
 * A transcript is not a table and does not get page numbers — it gets a "load older" control
 * at the top, which is the only shape that keeps a conversation reading downwards. A thread
 * that has run for months holds thousands of messages; without this, everything past the
 * window was simply absent from the UI with no way to ask for it.
 *
 * Keyset, not OFFSET, and that is not a preference: new messages arrive at the *newest* end
 * while somebody reads backwards from a fixed point, so an offset counted from the top would
 * shift under every reply and quietly re-show or skip a message. A cursor of
 * `(created_at, id)` is anchored to a message rather than to a position.
 *
 * `id` is in the cursor because `created_at` is not unique — a bot answering fast files two
 * messages in the same millisecond, and a cursor on the timestamp alone would either loop on
 * them forever or step over one.
 */
export const before = (
  workspaceId: number,
  conversationId: number,
  cursor: { at: string; id: number },
  limit = 200,
) =>
  all<Message>(
    `SELECT * FROM (
        SELECT * FROM messages
         WHERE workspace_id = ? AND conversation_id = ?
           AND (created_at, id) < (?::timestamptz, ?)
         ORDER BY created_at DESC, id DESC LIMIT ?
      ) older ORDER BY created_at, id`,
    workspaceId,
    conversationId,
    cursor.at,
    cursor.id,
    limit,
  )

/** How many messages a thread holds, so the UI can say whether there are older ones. */
export const messageCount = async (workspaceId: number, conversationId: number) =>
  (
    await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages WHERE workspace_id = ? AND conversation_id = ?`,
      workspaceId,
      conversationId,
    )
  )?.n ?? 0

/** The last few turns, oldest first — what the model is given as the conversation so far. */
export const recent = async (workspaceId: number, conversationId: number, turns = 10) =>
  (
    await all<Message>(
      `SELECT * FROM messages WHERE workspace_id = ? AND conversation_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      workspaceId,
      conversationId,
      turns,
    )
  ).reverse()

export async function setStatus(workspaceId: number, id: number, status: Status, assignee?: string | null) {
  const { changes } = await run(
    /*
     * A person claiming the thread turns the override off with it.
     *
     * Somebody who takes a conversation over should not leave a switch armed behind them: the
     * reply gate would keep out anyway while `assignee` is set, but the moment the thread was
     * handed back the bot would start answering again for a reason nobody remembered choosing.
     * Only a real claim clears it -- the bot handing a thread on sets `assignee` to null, and
     * that is most of what draft mode does all day.
     */
    `UPDATE conversations SET status = ?, assignee = ?,
            answers_live = CASE WHEN ?::text IS NULL THEN answers_live ELSE false END
      WHERE workspace_id = ? AND id = ?`,
    status,
    assignee ?? null,
    assignee ?? null,
    workspaceId,
    id,
  )
  if (!changes) throw new Error('No such conversation')
}

/**
 * Answer this one thread live, or stop.
 *
 * Deliberately its own call rather than a flag on setStatus: turning it on is not a change of
 * who holds the conversation, and the two get written at different moments.
 */
export async function setAnswersLive(workspaceId: number, id: number, on: boolean) {
  const { changes } = await run(
    `UPDATE conversations SET answers_live = ? WHERE workspace_id = ? AND id = ?`,
    on,
    workspaceId,
    id,
  )
  if (!changes) throw new Error('No such conversation')
}

export type Threaded = Conversation & {
  customer_name: string | null
  customer_email: string | null
  last_body: string | null
  unread: number
  /**
   * When the customer last wrote. Null when they never have.
   *
   * Not `last_at`, which our own replies advance — the WhatsApp 24-hour window runs on this
   * and only this, so a thread answered a minute ago can still be hours past it. Derived
   * rather than stored; see 075_window.sql for why there is no column.
   */
  last_in_at: string | null
}

/**
 * The last thing the customer said, as a scalar.
 *
 * One expression, three call sites — the inbox list, the open thread and the cold filter.
 * Written down once because a partial index is only used when the predicate matches, and
 * `messages_inbound` is partial on `direction = 'in'`.
 */
const LAST_IN = `(SELECT max(m.created_at) FROM messages m
                    WHERE m.conversation_id = v.id AND m.direction = 'in')`

/**
 * How long WhatsApp carries a free reply after the customer's last message.
 *
 * Meta's number, and Meta stays the authority — nothing here refuses a send. See
 * 075_window.sql, and 059_whatsapp_cloud.sql:30 for why there is no column.
 */
export const WINDOW = '24 hours'

/**
 * Past the window, so only an approved template will now reach them.
 *
 * WhatsApp Business alone. A linked handset is the same `whatsapp` channel and has no window
 * at all, so the `wc_` test is not a detail — a connector that cannot go cold must never be
 * filtered as though it could. A thread with no inbound message never opened a window, hence
 * the epoch.
 */
export const coldSql = `split_part(v.channel_ref, ':', 1) LIKE 'wc\\_%'
   AND coalesce(${LAST_IN}, 'epoch'::timestamptz) < now() - interval '${WINDOW}'`



/**
 * The inbox: threads, with who each is with and what was last said.
 *
 * It used to take the newest 200 and stop, with no page and no notice — thread 201 was simply
 * unreachable and nobody was told. Worse, the page then filtered those 200 again in the
 * browser by status and channel while `counts()` counted the whole table, so the chips and the
 * list disagreed the moment a workspace passed the cap. The comment on `counts()` already said
 * why that is unacceptable; this is that comment being honoured.
 *
 * So both filters are here now, beside the count that has to agree with them, and the caller
 * gets a total rather than a silent truncation.
 *
 * The order ends in `id`. `last_at` is not unique — an import stamps a whole history at once —
 * and without a tiebreaker an OFFSET page can repeat or skip threads. See 065_paging.sql.
 */
export async function inbox(
  workspaceId: number,
  opts: {
    status?: Status
    channel?: string
    /**
     * Which connections, by the id in front of every `channel_ref`.
     *
     * One mechanism for two questions a person actually asks — "only this number" is a list
     * of one, and "only WhatsApp Business" is the list of connections that connector owns.
     * The caller resolves which, because it is the side that knows what a connector is.
     */
    connections?: string[]
    /** Name, number, address — anything the contacts box already matches on. */
    find?: string
    /** Only the threads past the WhatsApp 24-hour window, or only the ones inside it. */
    cold?: boolean
    botId?: number
    page?: number
    size?: number
  } = {},
): Promise<{ rows: Threaded[]; total: number }> {
  const size = Math.min(Math.max(1, opts.size ?? INBOX_PAGE), 200)
  const status = opts.status ?? null
  const channel = opts.channel ?? null
  /*
   * Which bot's threads. Filtered on the stamp the conversation carries rather than by
   * re-running the routing rules: a widget reassigned to another bot last week must not
   * rewrite who answered the conversations before it moved.
   */
  const botId = opts.botId ?? null

  // Empty means no filter rather than no rows: an absent list and a list of nothing are the
  // same request, and the second is what a caller sends by accident.
  const connections = opts.connections?.length ? opts.connections : null

  /*
   * The same haystack the contacts box searches, and for the same reason it was built.
   *
   * `customers.search` is a stored, trigram-indexed column over name, company, email, phone
   * and the rest — so "find Perry's thread" and "find the thread for 8852" are one clause
   * here rather than a second search implementation that drifts out of step with the first.
   * `channel_ref` is the extra arm: a number that wrote in before anybody filled in the CRM
   * record is in the thread's address and nowhere else yet.
   *
   * % and _ escaped, so somebody searching for "50%" is not handed the whole inbox.
   */
  const find = opts.find?.trim().toLowerCase() || null
  const like = find ? `%${find.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null

  const cold = opts.cold ?? null

  const from = `conversations v JOIN customers c ON c.id = v.customer_id`
  const where = `v.workspace_id = ? AND (?::text IS NULL OR v.status = ?)
                   AND (?::text IS NULL OR v.channel = ?)
                   AND (?::int IS NULL OR v.bot_id = ?)
                   AND (?::text[] IS NULL OR split_part(v.channel_ref, ':', 1) = ANY(?::text[]))
                   AND (?::text IS NULL OR c.search LIKE ? ESCAPE '\\' OR lower(v.channel_ref) LIKE ? ESCAPE '\\')
                   AND (?::bool IS NULL OR (${coldSql}) = ?)`
  const args = [workspaceId, status, status, channel, channel, botId, botId, connections, connections, like, like, like, cold, cold]

  const totals = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${from} WHERE ${where}`,
    ...args,
  )
  const total = totals?.n ?? 0

  const pages = Math.max(1, Math.ceil(total / size))
  const at = Math.min(Math.max(0, opts.page ?? 0), pages - 1)

  const rows = await all<Threaded>(
    `SELECT v.*, c.name AS customer_name, c.email AS customer_email,
            (SELECT m.body FROM messages m WHERE m.conversation_id = v.id
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = v.id) AS unread,
            ${LAST_IN} AS last_in_at
       FROM ${from}
      WHERE ${where}
      ORDER BY v.last_at DESC, v.id DESC
      LIMIT ? OFFSET ?`,
    ...args,
    size,
    at * size,
  )

  return { rows, total }
}

/**
 * Every thread with one person, newest first.
 *
 * A customer is a person rather than an account on a channel, so this is deliberately not
 * filtered by channel: the point of the contact page is seeing that the WhatsApp number
 * complaining today is the address that emailed last week.
 */
export const byCustomer = (workspaceId: number, customerId: number) =>
  all<Conversation & { last_body: string | null; messages: number }>(
    `SELECT v.*,
            (SELECT m.body FROM messages m WHERE m.conversation_id = v.id
              ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_body,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = v.id) AS messages
       FROM conversations v
      WHERE v.workspace_id = ? AND v.customer_id = ?
      ORDER BY v.last_at DESC`,
    workspaceId,
    customerId,
  )

/**
 * The numbers on the status chips.
 *
 * Takes the same bot filter the list does, and has to: a chip reading "6" above a list
 * showing two is not a count, it is a bug report from the user's point of view.
 */
/**
 * When the customer last wrote on one thread.
 *
 * The same fact `inbox()` derives per row, for the thread somebody has open — which is often
 * not on the page the list is showing, so it cannot borrow the row's value. One indexed
 * lookup on `messages_inbound`.
 */
export const lastInboundAt = async (workspaceId: number, conversationId: number) =>
  (
    await one<{ at: string | null }>(
      `SELECT max(created_at) AS at FROM messages
        WHERE workspace_id = ? AND conversation_id = ? AND direction = 'in'`,
      workspaceId,
      conversationId,
    )
  )?.at ?? null

export const counts = async (workspaceId: number, botId?: number) =>
  (await one<{ bot: number; human: number; closed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'bot')::int    AS bot,
            count(*) FILTER (WHERE status = 'human')::int  AS human,
            count(*) FILTER (WHERE status = 'closed')::int AS closed
       FROM conversations WHERE workspace_id = ? AND (?::int IS NULL OR bot_id = ?)`,
    workspaceId,
    botId ?? null,
    botId ?? null,
  ))!

/**
 * Mark these threads as backfill, and as already read for training.
 *
 * `imported_at` says the thread came from a phone's history rather than from live traffic —
 * the inbox shows it, and a bulk "read these for training" acts on it. `harvested_at` is
 * what keeps the import quiet: the training sweep asks whether anything has happened since
 * it last looked, so stamping it now means a thread whose newest message is older than this
 * moment is not due.
 *
 * `judged_at` used to be stamped here too and is not any more. It made linking a phone
 * import several hundred conversations, create several hundred contacts, and leave the
 * sales board empty — every one of them marked as already judged before anything had read a
 * word. Where these people got to is the most useful thing about them, they are put on the
 * board at import time, and the qualify sweep works through them twenty at a time. Training
 * on what was said stays opt-in; sorting the board does not.
 *
 * Deliberately not "never read these". A live message on an imported thread pushes `last_at`
 * past the stamp and it becomes due like any other, which is what should happen — the
 * backfill is old, the new message is not.
 */
export const markImported = (workspaceId: number, ids: number[]) =>
  run(
    `UPDATE conversations
        SET imported_at = COALESCE(imported_at, now()),
            harvested_at = GREATEST(COALESCE(harvested_at, now()), now())
      WHERE workspace_id = ? AND id = ANY(?::int[])`,
    workspaceId,
    ids,
  )

/**
 * Everything that arrived on one connection, gone.
 *
 * For unlinking. A `channel_ref` is `<connection>:<thread>`, and the connection half is an
 * id minted when a number was linked — so re-linking the same phone mints a *new* one and
 * the old threads point at a connection that no longer exists. They cannot be answered
 * (there is no socket behind that id) and they cannot be reached again, which left the inbox
 * showing conversations whose only possible outcome was an error.
 *
 * `split_part` rather than a `LIKE '<id>:%'`, so an id containing a wildcard cannot match
 * more than its own threads.
 *
 * What goes with them is worth knowing before calling this: `messages` are
 * `on delete cascade` and are destroyed. `lessons`, `customer_dates` and `llm_usage` are
 * `on delete set null` and survive — so an answer somebody wrote outlives the number the
 * question came in on, which is the half that matters. The customer rows themselves are
 * untouched; a person is not their WhatsApp thread.
 */
export const removeConnection = async (workspaceId: number, channel: string, connectionRef: string) => {
  const gone = await all<{ customer_id: number }>(
    `DELETE FROM conversations
      WHERE workspace_id = ? AND channel = ? AND split_part(channel_ref, ':', 1) = ?
      RETURNING customer_id`,
    workspaceId,
    channel,
    connectionRef,
  )
  return { changes: gone.length }
}

/**
 * Put a backfilled thread back where it belongs in time.
 *
 * The inbox sorts on `last_at`, and for an imported thread that column was the moment of
 * the import rather than the moment of the newest message. A phone's whole history landed
 * with the same timestamp to the second, so the list came back in no meaningful order at
 * all — a conversation from March sat above one from yesterday because they were written a
 * few milliseconds apart.
 *
 * The true times were never lost: `record()` stores each message's own `created_at` from
 * what the channel reported. What could not survive was the conversation's summary of them,
 * because `record()` moves `last_at` with `GREATEST` — right for live traffic, where a
 * redelivered old message must not drag a thread down the list, and wrong for a backfill,
 * where the newest message genuinely is in the past and the row was created just now.
 *
 * So this is a correction rather than something `record()` should have done: take the newest
 * message each thread actually has and let that be its place in the list.
 *
 * Threads with no messages are left alone — `max()` would be null and a thread cannot be
 * older than nothing.
 */
export const datePlacedFromMessages = (workspaceId: number, ids: number[]) =>
  run(
    `UPDATE conversations c
        SET last_at = m.newest
       FROM (
         SELECT conversation_id, max(created_at) AS newest
           FROM messages
          WHERE workspace_id = ? AND conversation_id = ANY(?::int[])
          GROUP BY conversation_id
       ) m
      WHERE c.workspace_id = ? AND c.id = m.conversation_id AND c.last_at <> m.newest`,
    workspaceId,
    ids,
    workspaceId,
  )


/**
 * Threads on one channel whose connection is not in the list of live ones.
 *
 * The list must be *known*, not merely empty — an empty array here means "this channel has
 * no connections at all", which legitimately deletes every thread on it. A caller that
 * cannot tell must not call this; see `channels.tidy()`.
 *
 * `<> ALL` rather than `NOT IN`, because `NOT IN` against an empty set is a different
 * question in SQL and one that quietly matches nothing.
 */
export const removeUnreachable = async (workspaceId: number, channel: string, live: string[]) => {
  const gone = await all<{ customer_id: number }>(
    `DELETE FROM conversations
      WHERE workspace_id = ? AND channel = ?
        AND split_part(channel_ref, ':', 1) <> ALL(?::text[])
      RETURNING customer_id`,
    workspaceId,
    channel,
    live,
  )
  return { changes: gone.length }
}

/**
 * Give backfilled threads the bot that owns the connection they arrived on.
 *
 * The live path stamps `bot_id` in `agent.ts`, on the thread the bot actually answered.
 * Backfill never answers — `answer: false` is the point — so without this nothing owns the
 * thread, and `lessons.sweep()`'s `JOIN bots` drops it before any other condition is read.
 *
 * Only where it is null, and only for threads that came from an import: an answered thread
 * belongs to whoever answered it, whatever routing says today.
 */
export const adoptBot = (workspaceId: number, ids: number[], botId: number) =>
  run(
    `UPDATE conversations SET bot_id = ?
      WHERE workspace_id = ? AND id = ANY(?::int[]) AND bot_id IS NULL`,
    botId,
    workspaceId,
    ids,
  )

/**
 * Give ownerless threads the bot that answers their connection now.
 *
 * `bot_id` is normally stamped by the agent, on the thread it actually answered
 * (`agent.ts`). A backfilled thread is never answered — that is exactly what `answer: false`
 * is for — so nothing stamps it when the number is linked before anybody assigns it to a
 * chatbot, which is the ordinary order to do those two things in.
 *
 * Everything downstream joins on that column: `lessons.sweep()` for training, `sweepQualify`
 * for the board. An inner join drops a null silently, so those threads sat there owned by
 * nobody, read by nothing, and their contacts never reached a board. Assigning the
 * connection is the moment the answer changes, so `bot.ts` calls this from the save.
 *
 * Resolved per thread rather than per workspace, because a workspace may have several
 * numbers on several bots. `channel_ref` is `<connection>:<thread>`, and `bot_channels` maps
 * the connection half to its bot — the same lookup `bots.routeTo()` does, in one statement
 * rather than a query per thread.
 *
 * Only where it is null. A thread that has been answered belongs to the bot that answered
 * it, and routing is a setting somebody may have changed since — the same reason `agent.ts`
 * records the answering bot rather than recomputing it.
 */
export const claimThreads = (workspaceId: number) =>
  run(
    `UPDATE conversations c
        SET bot_id = k.bot_id
       FROM bot_channels k
      WHERE c.workspace_id = ? AND c.bot_id IS NULL
        AND k.workspace_id = c.workspace_id
        AND k.channel = c.channel
        AND k.connection_ref = split_part(c.channel_ref, ':', 1)`,
    workspaceId,
  )

/**
 * Let the training sweep read imported threads after all.
 *
 * Clearing the harvest stamp rather than reading them here: reading is a model call per
 * thread and there may be hundreds, so this queues them and the sweep works through them at
 * its own pace. The same shape as `projects.recheck()`, and for the same reason — a button
 * that holds a request open for three hundred model calls is a button that times out.
 *
 * Only the harvest stamp, because only that one is set against an import. The board is not
 * opt-in in the same way: an imported thread is left due for the qualify sweep when it is
 * filed, so these people are already on a board and already sorted by the time anybody
 * decides whether the bot should learn from what was said.
 */
export async function readImported(workspaceId: number): Promise<number> {
  // An owner first, or clearing the stamp achieves nothing — the sweep joins on `bot_id`.
  await claimThreads(workspaceId)

  const { changes } = await run(
    `UPDATE conversations SET harvested_at = NULL, harvest_attempts = 0
      WHERE workspace_id = ? AND imported_at IS NOT NULL AND harvested_at IS NOT NULL`,
    workspaceId,
  )
  return changes
}
