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
import { createHash, randomBytes } from 'node:crypto'
import { all, asSystem, insert, one, run } from './db.ts'
import { open as openAttachment } from './attachments.ts'
import { keyFor, shrink, thumbKeyFor, thumbnail } from './media.ts'
import { assertReachable } from './net.ts'
import { MAX_RESOURCE_MB } from '../types.ts'
import { getObject, putObject, removeObjects, storageConfigured } from './storage.ts'

/** Big enough for a manual or a short video; small enough to sit in a row. */
export const MAX_BYTES = MAX_RESOURCE_MB * 1024 * 1024

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
  /** How it got here. Null on everything added before 071 recorded it. */
  source: string | null
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

/**
 * Never selects `bytes`. A list of ten manuals would otherwise be a hundred megabytes.
 *
 * `thumb_key` is not here either, and that one is a rule rather than an economy: it is a storage
 * address, and the browser has no business holding one. `list()` derives a boolean from it
 * instead. Nor would it survive the trip — `forBot()` below rewrites this string by splitting on
 * ', ', which mangles any expression with a comma in it.
 */
const COLUMNS = `id, kind, title, description, url, mime, size_bytes, token, created_at, source`

export const list = (workspaceId: number) =>
  all<Resource & { bots: number; thumb: boolean }>(
    // How many bots may send it. Deleting one is a workspace-wide act, and somebody about
    // to do it from inside a single bot's settings deserves to know that.
    `SELECT ${COLUMNS.split(', ')
      .map((c) => `r.${c}`)
      .join(', ')},
            (SELECT count(*)::int FROM bot_resources br WHERE br.resource_id = r.id) AS bots,
            -- Whether there is a preview, not where it is. Folds both of the "no" states --
            -- never looked at, and looked at with nothing in it -- into the one answer a card
            -- needs, which is whether to draw a picture or a badge.
            coalesce(r.thumb_key, '') <> '' AS thumb
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

/**
 * Keep a file, and give it a public address.
 *
 * The bytes go to the file store under the same content-addressed key `attachments` uses,
 * so the same file arriving in a conversation and sent from the library is one object. The
 * row keeps the key; `byToken()` is what turns it back into bytes.
 *
 * **Falls back to the column when there is no store.** That is not a convenience: every test
 * run has `MEDIA_DIR` blank, and a resource that could not be created would take the chatbot
 * editor with it. `byToken()` reads both shapes, so the
 * two states coexist for as long as they need to.
 */
export async function addFile(
  workspaceId: number,
  file: { name: string; mime: string; bytes: Buffer },
  description = '',
  source: 'upload' | 'lesson' | 'chat' | null = null,
) {
  if (!file.bytes.length) throw new Error(`${file.name} is empty`)
  if (file.bytes.length > MAX_BYTES)
    throw new Error(`${file.name} is ${Math.round(file.bytes.length / 1048576)}MB, over the ${MAX_BYTES / 1048576}MB limit`)

  let bytes: Buffer | null = file.bytes
  let mime = file.mime || 'application/octet-stream'
  let sha: string | null = null
  let key: string | null = null

  if (storageConfigured()) {
    try {
      // Same treatment attachments get: an oversized photo becomes a webp, and anything the
      // shrink made bigger is kept as it was.
      const small = await shrink(file.bytes, mime)
      sha = createHash('sha256').update(small.bytes).digest('hex')
      mime = small.mime ?? mime
      key = keyFor(workspaceId, sha, mime)
      await putObject(key, small.bytes, mime)
      bytes = null
    } catch (e) {
      /*
       * Storage refused, so the file goes in the column instead.
       *
       * **Losing somebody’s upload is not an acceptable answer to a misconfigured bucket.**
       * The column still works, `byToken()` reads either shape, and the row can be moved out
       * later — so the cost of carrying on is a larger database and the cost of not carrying
       * on is a file the person has to find and upload again.
       *
       * Loud, because this is exactly the kind of fallback that becomes permanent in silence:
       * the symptom is a database quietly growing again, which is the thing 069 and 071 were
       * written to stop.
       */
      console.error(
        `[resources] storage refused ${file.name}, keeping it in the database instead:`,
        e instanceof Error ? e.message : e,
      )
      bytes = file.bytes
      sha = null
      key = null
    }
  }

  return insert(
    `INSERT INTO resources
       (workspace_id, kind, title, description, mime, bytes, size_bytes, token, sha256, storage_key, source)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    workspaceId,
    file.name.slice(0, 200),
    description.slice(0, 500),
    mime,
    bytes,
    file.bytes.length,
    randomBytes(24).toString('base64url'),
    sha,
    key,
    source,
  )
}

/**
 * Give a file from a conversation a public address.
 *
 * **A pointer, not a copy.** Both stores key on `media/<workspace>/<sha256>`, so the resource
 * row carries the attachment’s own `storage_key` and the two refer to one object. That is what
 * makes the sweep in media.ts able to see that the library is holding it — the retention
 * exemption is a fact about the data rather than a flag somebody has to remember to set.
 *
 * It is also what makes this a real decision rather than a filing action. The attachment stays
 * exactly where it was, in the private bucket behind a signed-in route; the resource row is
 * what adds a second, public door onto the same bytes. `source` records that it came from a
 * conversation so that a file nobody can place later can still be accounted for.
 *
 * Falls back to copying the bytes when there is no key to point at — a row still holding its
 * own bytes, or an instance with no Storage configured.
 */
export async function shareAttachment(workspaceId: number, attachmentId: number, description = '') {
  const row = await one<{
    name: string
    mime: string | null
    size_bytes: number
    sha256: string | null
    storage_key: string | null
  }>(
    `SELECT name, mime, size_bytes, sha256, storage_key FROM attachments
      WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    attachmentId,
  )
  if (!row) throw new Error('No such file.')

  if (row.storage_key)
    return insert(
      `INSERT INTO resources
         (workspace_id, kind, title, description, mime, size_bytes, token, sha256, storage_key, source)
       VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, 'chat')`,
      workspaceId,
      row.name.slice(0, 200),
      description.slice(0, 500),
      row.mime ?? 'application/octet-stream',
      row.size_bytes,
      randomBytes(24).toString('base64url'),
      row.sha256,
      row.storage_key,
    )

  // No key to point at. `open()` resolves bytes, storage and the `resource:` pointer, so this
  // also covers a file the bot itself sent, which is already a resource under another name.
  const held = await openAttachment(workspaceId, attachmentId)
  if (!held?.bytes?.length) throw new Error('That file is no longer held, so it cannot be shared.')
  return addFile(
    workspaceId,
    { name: held.name, mime: held.mime ?? 'application/octet-stream', bytes: held.bytes },
    description,
    'chat',
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
  const gone = await one<{ thumb_key: string | null }>(
    `DELETE FROM resources WHERE workspace_id = ? AND id = ? RETURNING thumb_key`,
    workspaceId,
    id,
  )
  if (!gone) throw new Error('No such resource')

  /*
   * The preview goes with it, and only the preview.
   *
   * `storage_key` is deliberately left alone: `shareAttachment` points a resource row at an
   * attachment's own object, so deleting that here would take a file out of somebody's inbox
   * because the library tidied up. `forgetOldMedia` owns that key's lifetime.
   *
   * A preview is ours alone — but it is content-addressed, so two rows holding the same
   * brochure share one, and it only goes when the last of them does. The empty-string sentinel
   * is falsy, which is the whole reason it is the empty string rather than the word "none".
   */
  if (gone.thumb_key && !(await one(`SELECT 1 AS n FROM resources WHERE thumb_key = ?`, gone.thumb_key)))
    await removeObjects([gone.thumb_key])
}

/**
 * A file's contents, by its public token.
 *
 * The token alone is the authority — there is no session behind a customer opening a link
 * we sent them — so this is a genuine system read and the token has to carry the whole
 * decision. That is why it is 24 random bytes and why deleting is the only revocation.
 */
/**
 * Whether that token still names a file, without reading it.
 *
 * Only `byToken` can answer a request, and it selects `bytes` — which is the whole file. This
 * is for the one caller that needs to know a token is still live and already has the contents:
 * a conditional request. Four megabytes out of a `bytea` to answer "yes, unchanged" is the
 * thing worth avoiding.
 */
export const liveToken = (token: string) =>
  one<{ n: number }>(`SELECT 1 AS n FROM resources WHERE token = ? AND kind = 'file'`, token)

/**
 * The bytes behind a token, wherever they are.
 *
 * The fallback lives here rather than in the route because `byToken` has five callers — the
 * public route and the four channels that upload a file natively — and every one of them
 * reads `.bytes`. Putting it anywhere else would mean changing all five and remembering the
 * fifth. Exactly the arrangement `attachments.open()` already uses, for the same reason.
 *
 * Null bytes back means the object is gone, and the route renders that as a file we no longer
 * hold rather than as an error.
 */
export async function byToken(token: string) {
  const row = await one<{
    mime: string | null
    bytes: Buffer | null
    title: string
    storage_key: string | null
  }>(
    `SELECT mime, bytes, title, storage_key FROM resources WHERE token = ? AND kind = 'file'`,
    token,
  )
  if (!row || row.bytes) return row
  if (!row.storage_key) return row

  /*
   * One retry on the read, here rather than in each of the six callers.
   *
   * Every one of them — the public token route, and the four channels that upload a file
   * natively — does `if (!held?.bytes?.length) throw 'no longer held'`, and a 4MB download
   * that fails once makes all of them say a file is gone while it sits in the library where
   * somebody left it. A library file is not the swept-attachment case: the object is meant
   * to be there, so asking twice before concluding otherwise is the honest reading.
   *
   * One, not a backoff. Either the second read works or something is actually wrong, and
   * there is a customer waiting at the other end of every one of these call sites.
   */
  const bytes = (await getObject(row.storage_key)) ?? (await getObject(row.storage_key))
  return { ...row, bytes }
}

/**
 * The preview for a token, or null.
 *
 * Its own query rather than a flag on `byToken`, because that one has five callers and every
 * one of them wants the whole file. No `storageConfigured()` guard: with no Storage the sweep
 * never runs, so `thumb_key` is never anything but NULL and this returns before it asks.
 */
export async function thumbByToken(token: string): Promise<Buffer | null> {
  const row = await one<{ thumb_key: string | null }>(
    `SELECT thumb_key FROM resources WHERE token = ? AND kind = 'file'`,
    token,
  )
  return row?.thumb_key ? await getObject(row.thumb_key) : null
}

/**
 * Two at a time. Each one is a regex over a whole PDF, an inflate and a re-encode.
 */
const PREVIEWS_PER_TICK = 2

/**
 * Give the library something to look at.
 *
 * On the poller rather than the upload path, for the reason media.ts gives about transcodes:
 * nobody should wait on an image decode to finish putting a file somewhere. `thumb_key IS NULL`
 * is the queue, so a new file joins it by existing and the rows that predate the column need no
 * backfill script.
 *
 * **Every row looked at is claimed, including the ones with nothing in them.** A row left NULL
 * comes back next tick; a text-only PDF left NULL comes back every tick for ever, paying full
 * extraction each time to rediscover the same nothing. That is why the empty string is written
 * as deliberately as a key is.
 *
 * ponytail: a transient Storage failure makes `getObject` return null, which is
 * indistinguishable here from a file that is genuinely gone, so it gets claimed as "nothing to
 * show". The cost is one card missing its picture, and
 * `UPDATE resources SET thumb_key = NULL WHERE id = ...` re-queues it. A retry counter would be
 * another column and another policy for a missing thumbnail.
 */
export async function sweepThumbs() {
  if (!storageConfigured()) return

  const waiting = await asSystem(() =>
    all<{ id: number; workspace_id: number; token: string; sha256: string | null }>(
      `SELECT id, workspace_id, token, sha256 FROM resources
        WHERE thumb_key IS NULL AND mime = 'application/pdf' AND kind = 'file'
        ORDER BY id LIMIT ?`,
      PREVIEWS_PER_TICK,
    ),
  )

  for (const row of waiting) {
    try {
      // byToken resolves bytes-in-the-row and bytes-in-Storage. That resolution lives in one
      // place on purpose, so this does not repeat it.
      const held = await asSystem(() => byToken(row.token))
      const picture = held?.bytes ? await thumbnail(held.bytes, held.mime) : null

      let key = ''
      if (picture && held?.bytes) {
        // Content-addressed, so the hash is the name. Computed here when the row has none:
        // rows older than 071, and anything that fell back to the bytes column, have no sha.
        const sha = row.sha256 ?? createHash('sha256').update(held.bytes).digest('hex')
        key = thumbKeyFor(row.workspace_id, sha)
        await putObject(key, picture, 'image/webp')
      }
      // The object first, then the claim. The other order points a card at nothing.
      await asSystem(() => run(`UPDATE resources SET thumb_key = ? WHERE id = ?`, key, row.id))
    } catch (e) {
      // Left NULL and retried next tick. One unreadable PDF must not stop the queue behind it.
      console.error(`[resources] no preview for ${row.id}:`, e instanceof Error ? e.message : e)
    }
  }
}

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
