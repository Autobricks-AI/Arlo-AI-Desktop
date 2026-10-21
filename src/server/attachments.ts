/**
 * Files that came in, and files that went out.
 *
 * Every channel carries them — a photo of the broken part, a receipt, the PDF the team
 * sends back — and a thread that shows "see attached" with no attachment is one nobody can
 * answer. So each one is filed against the message that carried it and served back to the
 * inbox.
 *
 * Two rules worth stating, because both are load-bearing:
 *
 *   **The row exists even when the bytes do not.** A file over the cap, or one whose fetch
 *   failed, is still recorded with its name and size. "They sent a 60MB video we did not
 *   keep" is a fact somebody needs; silence looks like they sent nothing.
 *
 *   **Nothing here is public.** Resources are addressed by an unguessable token because
 *   they are sent to customers. An attachment is a customer's own file — a receipt, an ID
 *   photo — so it is only ever served to a signed-in member of the workspace it belongs to,
 *   through the ordinary session and the ordinary row-level security.
 */
import { createHash } from 'node:crypto'

import { all, one, run } from './db.ts'
import { getObject } from './storage.ts'

/** The same ceiling a resource has. Past this the row is kept and the bytes are not. */
export const MAX_BYTES = 25 * 1024 * 1024

export type Attachment = {
  id: number
  message_id: number
  name: string
  mime: string | null
  size_bytes: number
  /** False when it was too large or could not be fetched — there is nothing to download. */
  held: boolean
  /**
   * Where the bytes are, when they are not on this row.
   *
   * `resource:<token>` for a file the bot sent: the resource already holds it, and a second
   * copy per send would be gigabytes. Null for anything a customer sent us.
   */
  external_ref: string | null
  created_at: string
}

/**
 * Never selects `bytes`: a thread with ten photos in it would otherwise be a page load of them.
 *
 * `held` counts a resource pointer as held, because it is: an outbound file we sent stores
 * `resource:<token>` rather than a second copy of bytes that already exist. Reading `held`
 * off `bytes IS NOT NULL` alone would grey out every file the bot has ever sent as "not
 * kept", which is a lie the inbox would be telling about its own messages.
 */
/**
 * Whether the bytes are still reachable, as SQL.
 *
 * Exported because a second reader appeared and wrote its own version. `lessons.ts` tested
 * `bytes IS NOT NULL`, which was true of every row until 069 moved the files to Storage and
 * false of almost every row afterwards — so file training proposals silently stopped being
 * generated at all. One expression, one place, and the next reader imports it.
 */
export const held = (t = '') => {
  const c = t ? `${t}.` : ''
  return `(${c}bytes IS NOT NULL OR ${c}storage_key IS NOT NULL OR ${c}external_ref LIKE 'resource:%')`
}

const COLUMNS = `id, message_id, name, mime, size_bytes, external_ref,
  ${held()} AS held, created_at`

/**
 * One file that passed through conversations, however many times it did.
 *
 * Grouped by content, not listed by row. A brochure sent to two hundred and forty people is
 * two hundred and forty `attachments` rows and **one stored object** — the ingest path already
 * matches on sha256 and points every arrival at the same key. Listing the rows showed the same
 * file two hundred and forty times and implied a storage problem that does not exist.
 */
export type InConversation = {
  /** The row to open. Any of them resolves to the same bytes. */
  id: number
  name: string
  mime: string | null
  size_bytes: number
  /** Most recent appearance, which is what a list should be ordered by. */
  last_seen: string
  held: boolean
  /** How many messages carry it. */
  copies: number
  /** How many distinct threads it reached. */
  conversations: number
  /** One of them, to link to; null when it reached several. */
  conversation_id: number | null
  customer: string | null
  from_customer: boolean
  from_bot: boolean
  from_team: boolean
  from_library: boolean
  /**
   * Rows beyond one per message — the only genuinely redundant thing here.
   *
   * Everything else is a real event: the same file really was sent to two hundred people. A
   * second row against the *same* message is not an event, it is a double-recorded one, and it
   * is the only kind of duplicate worth offering to delete.
   */
  redundant: number
}

/**
 * Every distinct file in this workspace that went through a conversation, newest first.
 *
 * The join to `messages` is the only way to answer "who sent this": `attachments` records what
 * a file is and nothing about which way it went. `speaker` is used rather than `direction`
 * because the same join carries it and `bot` versus `team` is a real distinction to somebody
 * reading a list — Arlo answered, or a person here did.
 *
 * Grouped on the hash, falling back to name and size for rows that arrived before `sha256`
 * existed or were never held. That fallback can only ever merge two things that share a name
 * and a byte count exactly, which is the same bet the lesson-promotion path already makes.
 *
 * ponytail: grouped in SQL, paged on the groups, and ordered on an unindexed `created_at`. The
 * biggest workspace here is 1091 rows and this is a sub-millisecond scan. Add
 * `(workspace_id, created_at desc)` when one passes six figures.
 */
export async function inConversations(
  workspaceId: number,
  opts: { page?: number; size?: number } = {},
): Promise<{ rows: InConversation[]; total: number }> {
  const size = Math.min(Math.max(1, opts.size ?? 50), 200)
  const at = Math.max(0, opts.page ?? 0)

  const FP = `coalesce(a.sha256, a.name || ':' || a.size_bytes::text)`

  const counted = await one<{ n: number }>(
    `SELECT count(DISTINCT ${FP})::int AS n FROM attachments a WHERE a.workspace_id = ?`,
    workspaceId,
  )

  const rows = await all<InConversation>(
    `SELECT (array_agg(a.id ORDER BY a.id))[1]                    AS id,
            max(a.name)                                           AS name,
            max(a.mime)                                           AS mime,
            max(a.size_bytes)                                     AS size_bytes,
            max(a.created_at)                                     AS last_seen,
            bool_or(${held('a')})                                 AS held,
            count(*)::int                                         AS copies,
            count(DISTINCT m.conversation_id)::int                AS conversations,
            CASE WHEN count(DISTINCT m.conversation_id) = 1
                 THEN min(m.conversation_id) END                  AS conversation_id,
            CASE WHEN count(DISTINCT m.conversation_id) = 1
                 THEN min(cu.name) END                            AS customer,
            bool_or(m.speaker = 'customer')                       AS from_customer,
            bool_or(m.speaker = 'bot')                            AS from_bot,
            bool_or(m.speaker = 'team')                           AS from_team,
            bool_or(a.external_ref LIKE 'resource:%')             AS from_library,
            (count(*) - count(DISTINCT a.message_id))::int        AS redundant
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       LEFT JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE a.workspace_id = ?
      GROUP BY ${FP}
      ORDER BY max(a.created_at) DESC
      LIMIT ? OFFSET ?`,
    workspaceId,
    size,
    at * size,
  )
  return { rows, total: counted?.n ?? 0 }
}

/**
 * Delete the rows that record one file twice against one message.
 *
 * **Not a deduplicator**, and the distinction is the whole reason this is narrow. The same file
 * sent to two hundred people is two hundred real events sharing one stored object; deleting any
 * of those rows would erase the record of what was sent to whom and free nothing at all. A
 * second row against the *same* message is different — nothing happened twice, something was
 * written down twice — and that is all this removes.
 *
 * Keeps the lowest id of each group, which is the one anything else already points at.
 */
export async function tidyDuplicates(workspaceId: number, attachmentId: number): Promise<number> {
  const row = await one<{ sha256: string | null; name: string; size_bytes: number }>(
    `SELECT sha256, name, size_bytes FROM attachments WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    attachmentId,
  )
  if (!row) throw new Error('No such file.')

  const gone = await all<{ id: number }>(
    `DELETE FROM attachments a
      WHERE a.workspace_id = ?
        AND coalesce(a.sha256, a.name || ':' || a.size_bytes::text) = coalesce(?::text, ?::text)
        AND a.id > (
          SELECT min(b.id) FROM attachments b
           WHERE b.workspace_id = a.workspace_id
             AND b.message_id = a.message_id
             AND coalesce(b.sha256, b.name || ':' || b.size_bytes::text)
                 = coalesce(a.sha256, a.name || ':' || a.size_bytes::text)
        )
      RETURNING a.id`,
    workspaceId,
    row.sha256,
    `${row.name}:${row.size_bytes}`,
  )
  return gone.length
}
export type Incoming = {
  name: string
  mime?: string | null
  /** Absent when the file is known but not held — see the note about rows without bytes. */
  bytes?: Buffer | null
  /** How big it is, when we know without holding it. */
  size?: number
  /** The provider's own id, so something skipped today can still be fetched tomorrow. */
  externalRef?: string | null
}

/**
 * File one attachment against a message.
 *
 * Never throws for an oversized file: a message that arrives with a 60MB video must still
 * be filed and answered. The row records what it was and that we do not hold it.
 */
export async function add(workspaceId: number, messageId: number, file: Incoming) {
  const tooBig = !!file.bytes && file.bytes.length > MAX_BYTES
  const keep = tooBig ? null : (file.bytes ?? null)

  /*
   * The same file, recognised as the same file.
   *
   * A team sending one brochure by hand to every enquiry wrote a fresh copy of it each time,
   * and a popular file can end up as most of the table. `deliver()` already files a pointer
   * when Arlo sends a resource, but a message sent from a linked phone comes in through the
   * ingest path instead, which had no way to know the workspace already held it.
   *
   * So the bytes are hashed on the way in. If that content is already in the store, this row
   * points at the same object and carries nothing of its own -- every send after the first
   * costs one row. If it is not, the bytes stay here and the sweep moves them out; two
   * copies arriving before the first is uploaded is a race worth losing, because the sweep
   * uploads to a key derived from the hash and the second write lands on the first.
   */
  const sha = keep ? createHash('sha256').update(keep).digest('hex') : null
  const already = sha
    ? await one<{ storage_key: string }>(
        `SELECT storage_key FROM attachments
          WHERE workspace_id = ? AND sha256 = ? AND storage_key IS NOT NULL LIMIT 1`,
        workspaceId,
        sha,
      )
    : null

  await run(
    `INSERT INTO attachments (workspace_id, message_id, name, mime, size_bytes, bytes, external_ref, sha256, storage_key)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    workspaceId,
    messageId,
    file.name.trim().slice(0, 200) || 'file',
    file.mime?.slice(0, 120) ?? null,
    file.bytes?.length ?? file.size ?? 0,
    already ? null : keep,
    file.externalRef ?? null,
    sha,
    already?.storage_key ?? null,
  )
}

/** What a thread's messages carried, without the bytes. Empty ids is not a query. */
export const forMessages = (workspaceId: number, messageIds: number[]) =>
  messageIds.length
    ? all<Attachment>(
        `SELECT ${COLUMNS} FROM attachments
          WHERE workspace_id = ? AND message_id = ANY(?::int[]) ORDER BY id`,
        workspaceId,
        messageIds,
      )
    : Promise.resolve([])

/**
 * One file, bytes and all. Only the route that serves it to a signed-in person calls this.
 *
 * Follows a `resource:` pointer when the row has no bytes of its own — an outbound file the
 * bot sent is recorded against the message but stored once, on the resource. The fallback
 * lives here rather than in the route so that everything reading an attachment gets it.
 */
export async function open(workspaceId: number, id: number) {
  const row = await one<{
    name: string
    mime: string | null
    bytes: Buffer | null
    external_ref: string | null
    storage_key: string | null
  }>(
    `SELECT name, mime, bytes, external_ref, storage_key FROM attachments WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!row || row.bytes) return row

  /*
   * Moved out of the database, which is where every file ends up a tick or two after it
   * arrives. Null back means the object is gone -- past its window, or never uploaded -- and
   * the route renders that as a file we do not hold rather than an error.
   */
  if (row.storage_key) return { ...row, bytes: await getObject(row.storage_key) }

  const token = row.external_ref?.startsWith('resource:') ? row.external_ref.slice(9) : null
  if (!token) return row

  const held = await one<{ bytes: Buffer | null; storage_key: string | null }>(
    `SELECT bytes, storage_key FROM resources WHERE workspace_id = ? AND token = ? AND kind = 'file'`,
    workspaceId,
    token,
  )
  /*
   * A library file lives wherever that file lives — including on the store, once the sweep
   * has moved it off the row. Reading only the column was the same mistake the `storage_key`
   * branch above already corrects one level up, and it was invisible for the same reason:
   * the bytes are in the column for the first minute or two of a file's life, which is
   * exactly how long a new install gets tested for.
   *
   * It surfaced as approving a learned file saying "that file is no longer held" about a
   * file sitting in the store — and, because promoteFile throws there, the proposal was
   * marked approved while the resource was never connected to the bot.
   */
  if (held?.bytes) return { ...row, bytes: held.bytes }
  return { ...row, bytes: held?.storage_key ? await getObject(held.storage_key) : null }
}
