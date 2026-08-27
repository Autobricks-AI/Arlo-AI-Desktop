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
import { all, one, run } from './db.ts'

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
const COLUMNS = `id, message_id, name, mime, size_bytes, external_ref,
  (bytes IS NOT NULL OR external_ref LIKE 'resource:%') AS held, created_at`

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
  const bytes = tooBig ? null : (file.bytes ?? null)

  await run(
    `INSERT INTO attachments (workspace_id, message_id, name, mime, size_bytes, bytes, external_ref)
     VALUES (?,?,?,?,?,?,?)`,
    workspaceId,
    messageId,
    file.name.trim().slice(0, 200) || 'file',
    file.mime?.slice(0, 120) ?? null,
    file.bytes?.length ?? file.size ?? 0,
    bytes,
    file.externalRef ?? null,
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
  const row = await one<{ name: string; mime: string | null; bytes: Buffer | null; external_ref: string | null }>(
    `SELECT name, mime, bytes, external_ref FROM attachments WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!row || row.bytes) return row

  const token = row.external_ref?.startsWith('resource:') ? row.external_ref.slice(9) : null
  if (!token) return row

  const held = await one<{ bytes: Buffer | null }>(
    `SELECT bytes FROM resources WHERE workspace_id = ? AND token = ? AND kind = 'file'`,
    workspaceId,
    token,
  )
  return { ...row, bytes: held?.bytes ?? null }
}
