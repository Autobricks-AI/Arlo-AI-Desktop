/**
 * Things a bot can hand to a customer: a price list, a manual, a video, a booking link.
 *
 * Deliberately not the knowledge base, and the difference is what happens to them. A
 * knowledge document is *read* — chunked, embedded, quoted back in pieces with a citation.
 * A resource is *sent*, whole and unread. A brochure nobody has extracted text from is
 * useless as knowledge and perfectly good as an attachment.
 *
 * ---------------------------------------------------------------- how one is delivered
 *
 * As a link, on every channel. A file gets an address of ours and the bot sends that.
 *
 * The alternative — native attachments per channel — is four separate media pipelines
 * (Telegram sendDocument, Baileys media upload, a MIME part for mail, something for the
 * widget) for an outcome the customer can barely tell apart from a URL. A link works
 * everywhere today, including the channels nobody has built yet.
 */
import { randomBytes } from 'node:crypto'
import { all, insert, one, run } from './db.ts'
import { assertReachable } from './net.ts'

/** Big enough for a manual or a short video; small enough to sit in a row. */
export const MAX_BYTES = 25 * 1024 * 1024

export type Resource = {
  id: number
  kind: 'file' | 'link'
  title: string
  description: string
  url: string | null
  mime: string | null
  size_bytes: number
  token: string
  created_at: string
}

/**
 * Enough to send one, and no bytes.
 *
 * Every outbound file is a resource — the send_resource tool and a tick on an example both
 * resolve to one, and nothing else in the app can produce one. So a file in flight is this
 * much metadata, about a hundred bytes, and the contents are read once by whichever process
 * is actually about to upload them.
 */
export type Sendable = Pick<Resource, 'id' | 'kind' | 'title' | 'url' | 'token' | 'mime' | 'size_bytes'>

/** Never selects `bytes`. A list of ten manuals would otherwise be a hundred megabytes. */
const COLUMNS = `id, kind, title, description, url, mime, size_bytes, token, created_at`

export const list = (workspaceId: number) =>
  all<Resource & { bots: number }>(
    // How many bots may send it. Deleting one is a workspace-wide act, and somebody about
    // to do it from inside a single bot's settings deserves to know that.
    `SELECT ${COLUMNS.split(', ')
      .map((c) => `r.${c}`)
      .join(', ')},
            (SELECT count(*)::int FROM bot_resources br WHERE br.resource_id = r.id) AS bots
       FROM resources r WHERE r.workspace_id = ? ORDER BY r.created_at DESC`,
    workspaceId,
  )

export const get = (workspaceId: number, id: number) =>
  one<Resource>(`SELECT ${COLUMNS} FROM resources WHERE workspace_id = ? AND id = ?`, workspaceId, id)

/**
 * The address a customer is given.
 *
 * A link is somebody else's URL and is sent as it is. A file is ours, and its address is
 * built from the token — public by necessity, since it ends up in a forwarded message.
 */
export const addressOf = (r: Resource, base: string) =>
  r.kind === 'link' ? (r.url ?? '') : `${base.replace(/\/+$/, '')}/api/resource/${r.token}`

export async function addFile(
  workspaceId: number,
  file: { name: string; mime: string; bytes: Buffer },
  description = '',
) {
  if (!file.bytes.length) throw new Error(`${file.name} is empty`)
  if (file.bytes.length > MAX_BYTES)
    throw new Error(`${file.name} is ${Math.round(file.bytes.length / 1048576)}MB, over the ${MAX_BYTES / 1048576}MB limit`)

  return insert(
    `INSERT INTO resources (workspace_id, kind, title, description, mime, bytes, size_bytes, token)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?)`,
    workspaceId,
    file.name.slice(0, 200),
    description.slice(0, 500),
    file.mime || 'application/octet-stream',
    file.bytes,
    file.bytes.length,
    randomBytes(24).toString('base64url'),
  )
}

export async function addLink(workspaceId: number, rawUrl: string, title: string, description = '') {
  // The same guard the crawler uses. A resource is a URL somebody typed that this server
  // will hand to strangers, so it must not be an address on our own network.
  const url = await assertReachable(rawUrl)
  return insert(
    `INSERT INTO resources (workspace_id, kind, title, description, url, token)
     VALUES (?, 'link', ?, ?, ?, ?)`,
    workspaceId,
    (title.trim() || url.hostname).slice(0, 200),
    description.slice(0, 500),
    url.href,
    randomBytes(24).toString('base64url'),
  )
}

/**
 * Rename one, and say what it is for.
 *
 * Not cosmetic. The title is what the model matches a customer's request against — it is
 * given the list and asked to pick — so a resource called `The_Ledger_of_Life_(2).pdf` is
 * one the bot will struggle to choose, and `Ledger of Life guide` is one it will not. The
 * description is the tiebreaker between two things with similar names.
 *
 * A filename is what a browser happened to send. It is a starting point, not a decision.
 */
export async function rename(workspaceId: number, id: number, title: string, description: string) {
  const clean = title.trim().slice(0, 200)
  if (!clean) throw new Error('Give it a name — it is what the bot matches a request against.')

  const { changes } = await run(
    `UPDATE resources SET title = ?, description = ? WHERE workspace_id = ? AND id = ?`,
    clean,
    description.trim().slice(0, 500),
    workspaceId,
    id,
  )
  if (!changes) throw new Error('No such resource')
}

export async function remove(workspaceId: number, id: number) {
  // Deleting the row is what revokes the address: nothing else can, because the address is
  // in messages already sent and out of our hands.
  const { changes } = await run(`DELETE FROM resources WHERE workspace_id = ? AND id = ?`, workspaceId, id)
  if (!changes) throw new Error('No such resource')
}

/**
 * A file's contents, by its public token.
 *
 * The token alone is the authority — there is no session behind a customer opening a link
 * we sent them — so this is a genuine system read and the token has to carry the whole
 * decision. That is why it is 24 random bytes and why deleting is the only revocation.
 */
export const byToken = (token: string) =>
  one<{ mime: string | null; bytes: Buffer; title: string }>(
    `SELECT mime, bytes, title FROM resources WHERE token = ? AND kind = 'file'`,
    token,
  )

// ---------------------------------------------------------------- per bot

/** What this bot is allowed to send. Empty is the default and means nothing. */
export const forBot = (workspaceId: number, botId: number) =>
  all<Resource>(
    `SELECT r.${COLUMNS.split(', ').join(', r.')}
       FROM bot_resources br JOIN resources r ON r.id = br.resource_id
      WHERE br.workspace_id = ? AND br.bot_id = ?
      ORDER BY r.title`,
    workspaceId,
    botId,
  )

export async function setForBot(workspaceId: number, botId: number, resourceIds: number[]) {
  await run(`DELETE FROM bot_resources WHERE workspace_id = ? AND bot_id = ?`, workspaceId, botId)
  for (const id of [...new Set(resourceIds)])
    // The SELECT is what refuses a resource belonging to another workspace.
    await run(
      `INSERT INTO bot_resources (bot_id, resource_id, workspace_id)
         SELECT ?, r.id, ? FROM resources r WHERE r.workspace_id = ? AND r.id = ?
         ON CONFLICT DO NOTHING`,
      botId,
      workspaceId,
      workspaceId,
      id,
    )
}
