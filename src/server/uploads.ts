/**
 * Uploaded files, and the job that reads them.
 *
 * ---------------------------------------------------------------- why it runs elsewhere
 *
 * Reading a file into the knowledge base is not one thing, it is four: parse the text out
 * of it, cut it into passages, embed every passage, then ask a model what it is about. On
 * a fifty-megabyte manual that is minutes. Doing it inside the request that uploaded it
 * means a frozen page, a browser that gives up, and a proxy timeout quietly deciding how
 * big a document is allowed to be.
 *
 * So this is the same shape as sites.ts: `queue()` writes the row and returns, the work
 * happens in the process that owns the singletons, and the browser polls the row. A file
 * and an address are the same problem — something slow, started by a click.
 *
 * ---------------------------------------------------------------- why the bytes are kept
 *
 * The knowledge base stores extracted text, which is not the file. You cannot print it,
 * forward it to a colleague, or open it in the program that made it. So the original is
 * kept too, gzipped, and there is a button to get it back.
 */
import { createHash } from 'node:crypto'
import { gunzip, gzip } from 'node:zlib'
import { promisify } from 'node:util'

// Async, not the *Sync pair: these run on libuv's threadpool instead of the event loop,
// so unpacking somebody's fifty-megabyte manual no longer stops every other request this
// worker is holding. Same options, same errors — only the thread differs.
const gzipP = promisify(gzip)
const gunzipP = promisify(gunzip)
import { all, asSystem, insert, one, run, withWorkspace } from './db.ts'
import { addUpload, kindOf, unreadable } from './kb.ts'
import { ownsSingletons, singleton } from './singleton.ts'
import { MAX_UPLOAD_MB } from '../types.ts'

/**
 * One file's ceiling.
 *
 * Big enough for a real product manual, and bounded because the bytes go through this
 * process's memory three times over — read off the request, gzipped, then sent to
 * Postgres. That is the number to revisit first if it ever needs raising again.
 */
export const MAX_BYTES = MAX_UPLOAD_MB * 1024 * 1024

export type Status = 'queued' | 'running' | 'ready' | 'failed'

export type Upload = {
  id: number
  /** The knowledge base it was added to. */
  base_id: number
  filename: string
  mime: string | null
  /** The size before compression — what a person recognises as the size of their file. */
  size_bytes: number
  status: Status
  error: string | null
  /** Pages read so far, and how many there are. Both zero when there is no honest count. */
  pages_done: number
  pages_total: number
  document_id: number | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

/** Never selects `bytes`. A list of ten manuals would otherwise be half a gigabyte. */
const COLUMNS = `id, base_id, filename, mime, size_bytes, status, error, pages_done, pages_total, document_id, started_at, finished_at, created_at`

// ---------------------------------------------------------------- reading

export const list = (workspaceId: number, baseId?: number) =>
  all<Upload & { chunks: number; embedded: number }>(
    `SELECT ${COLUMNS.split(', ')
      .map((c) => `u.${c}`)
      .join(', ')},
            (SELECT count(*)::int FROM chunks c WHERE c.document_id = u.document_id)                          AS chunks,
            (SELECT count(*)::int FROM chunks c WHERE c.document_id = u.document_id AND c.embedding IS NOT NULL) AS embedded
       FROM uploads u
      WHERE u.workspace_id = ? AND (?::int IS NULL OR u.base_id = ?)
      ORDER BY u.created_at DESC`,
    workspaceId,
    baseId ?? null,
    baseId ?? null,
  )

export const get = (workspaceId: number, id: number) =>
  one<Upload>(`SELECT ${COLUMNS} FROM uploads WHERE workspace_id = ? AND id = ?`, workspaceId, id)

/** True while anything is still being read — what tells the page whether to keep polling. */
export const anyRunning = async (workspaceId: number) =>
  !!(await one(`SELECT 1 FROM uploads WHERE workspace_id = ? AND status IN ('queued','running')`, workspaceId))

/**
 * The file back, as it was uploaded.
 *
 * Decompressed here rather than served with `content-encoding: gzip`, which would save the
 * work: that header is a promise about the transfer, and one proxy that re-encodes or
 * strips it hands somebody a file their computer cannot open. A gunzip is milliseconds.
 */
export async function fileOf(workspaceId: number, id: number) {
  const row = await one<{ filename: string; mime: string | null; bytes: Buffer; size_bytes: number }>(
    `SELECT filename, mime, bytes, size_bytes FROM uploads WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  // size_bytes 0 is a row adopted by the migration: filed before files were kept, so there
  // is a document but no original to hand back.
  if (!row?.size_bytes) return undefined
  return { filename: row.filename, mime: row.mime ?? 'application/octet-stream', bytes: await gunzipP(row.bytes) }
}

// ---------------------------------------------------------------- queueing

/**
 * Accept a file and hand it off. Returns as soon as the row exists.
 *
 * Everything knowable without reading the file is checked here, because a file that is too
 * big or of a type we cannot read is a mistake on the form — it should be an error next to
 * the picker, not a row that appears in the list and fails a second later with nobody
 * looking at it. Whether a PDF has a text layer is not knowable without parsing it, so
 * that one is the job's to report.
 */
export async function queue(
  workspaceId: number,
  baseId: number,
  file: { name: string; mime: string; bytes: Buffer },
): Promise<Upload> {
  if (!file.bytes.length) throw new Error(`${file.name} is empty`)
  if (file.bytes.length > MAX_BYTES)
    throw new Error(
      `${file.name} is ${Math.round(file.bytes.length / 1048576)}MB, over the ${MAX_BYTES / 1048576}MB limit`,
    )
  if (!kindOf(file)) throw new Error(unreadable(file))

  const sha = createHash('sha256').update(file.bytes).digest('hex')

  // One row per file per base — the same handbook can belong in two bases — and the guard
  // on `status` is what stops two impatient clicks reading it twice.
  const existing = await one<{ id: number; status: Status }>(
    `SELECT id, status FROM uploads WHERE workspace_id = ? AND base_id = ? AND sha = ?`,
    workspaceId,
    baseId,
    sha,
  )
  if (existing?.status === 'queued' || existing?.status === 'running')
    throw new Error(`${file.name} is already being read.`)

  const id = await insert(
    `INSERT INTO uploads (workspace_id, base_id, filename, mime, bytes, size_bytes, sha)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (workspace_id, base_id, sha) DO UPDATE
        SET filename = excluded.filename, mime = excluded.mime, bytes = excluded.bytes,
            size_bytes = excluded.size_bytes, status = 'queued', error = NULL,
            pages_done = 0, pages_total = 0, attempts = 0,
            started_at = NULL, finished_at = NULL
     RETURNING id`,
    workspaceId,
    baseId,
    file.name.slice(0, 300),
    file.mime || null,
    await gzipP(file.bytes),
    file.bytes.length,
    sha,
  )

  /*
   * Deliberately not awaited. `begin()` starts the work in the owning process and returns;
   * awaiting the reading itself would put us back where we started, and the singleton RPC
   * has a one-minute deadline a real file would blow through.
   *
   * A failure to hand off is not a failure to accept: the row is queued and the poller's
   * sweep picks it up. Losing the instant start is a slower upload, not a lost one.
   */
  void begin(id, workspaceId).catch((e) =>
    console.error('[uploads] could not start reading', id, e instanceof Error ? e.message : e),
  )

  return (await get(workspaceId, id))!
}

/**
 * Forget a file, and the knowledge that came out of it.
 *
 * Removing an upload removes its document, because to the person clicking Remove those are
 * one thing — the file they added. The exception is a document two uploads share, which
 * happens when two differently-named files hold identical text: the last one out takes it.
 */
export async function remove(workspaceId: number, id: number) {
  const row = await get(workspaceId, id)
  if (!row) throw new Error('No such upload')

  await run(`DELETE FROM uploads WHERE workspace_id = ? AND id = ?`, workspaceId, id)
  if (row.document_id)
    await run(
      `DELETE FROM documents d
        WHERE d.workspace_id = ? AND d.id = ?
          AND NOT EXISTS (SELECT 1 FROM uploads u WHERE u.document_id = d.id)`,
      workspaceId,
      row.document_id,
    )
}

// ---------------------------------------------------------------- the job

/**
 * Claim a queued upload and read it, in whichever process owns the singletons.
 *
 * The claim is a conditional UPDATE: two callers racing the same row produce exactly one
 * winner, so an instant hand-off and a poller sweep arriving together cannot double-read.
 */
const beginImpl = async (uploadId: number, workspaceId: number) => {
  const claimed = await withWorkspace({ workspaceId }, () =>
    one<{ id: number }>(
      `UPDATE uploads SET status = 'running', started_at = now(), error = NULL, pages_done = 0, pages_total = 0,
              attempts = attempts + 1
        WHERE id = ? AND status = 'queued' RETURNING id`,
      uploadId,
    ),
  )
  if (!claimed) return { started: false }

  // Not awaited: this returns to the caller over IPC while the reading carries on here.
  void runJob(uploadId, workspaceId)
  return { started: true }
}

/** Reached from any process; runs in the one that owns the timers. */
export const begin = singleton('kb.upload', beginImpl)

async function runJob(uploadId: number, workspaceId: number) {
  /*
   * Short scopes, as in sites.ts: withWorkspace holds a pooled connection inside an open
   * transaction for as long as its callback runs. Parsing a PDF must not be inside one.
   *
   * ponytail: the filing scope is not short — store() embeds inside its transaction, so a
   * document with hundreds of passages holds a connection for the length of that. It is
   * the same as the crawler's per-page write and has not bitten yet; the fix, when it
   * does, is to embed before opening the transaction rather than inside it.
   */
  const scope = <T>(fn: () => Promise<T>) => withWorkspace({ workspaceId }, fn)

  try {
    const row = await scope(() =>
      one<{ filename: string; mime: string | null; bytes: Buffer; base_id: number }>(
        `SELECT filename, mime, bytes, base_id FROM uploads WHERE id = ?`,
        uploadId,
      ),
    )
    if (!row) return

    // Unpacked outside any scope: this is CPU and it is the whole file.
    const bytes = await gunzipP(row.bytes)

    /*
     * Progress, but only where there is an honest number to report.
     *
     * Reading a text file has no denominator — the passages are not countable until it has
     * been chunked — so the bar stays indeterminate for those. A scan is a known number of
     * pages at seconds each, which is both a real fraction and the case where somebody
     * most needs one, since sixty pages is minutes of waiting.
     *
     * Written outside the scope's transaction and deliberately not awaited in step with the
     * work: a page that fails to record its progress must not fail the upload.
     */
    const onPage = (done: number, total: number) => {
      void scope(() =>
        run(`UPDATE uploads SET pages_done = ?, pages_total = ? WHERE id = ?`, done, total, uploadId),
      ).catch(() => {})
    }

    const filed = await scope(() =>
      addUpload(workspaceId, row.base_id, { name: row.filename, mime: row.mime ?? '', bytes }, onPage),
    )

    await scope(() =>
      run(
        `UPDATE uploads SET status = 'ready', document_id = ?, finished_at = now(), error = NULL WHERE id = ?`,
        filed.documentId,
        uploadId,
      ),
    )
  } catch (e) {
    /*
     * The failure is written to the row, not thrown. There is nobody to throw to — the
     * request that started this returned long ago — and the message is the entire point:
     * "no text layer, it is probably a scan" is what tells somebody what to do next.
     */
    await scope(() =>
      run(
        `UPDATE uploads SET status = 'failed', finished_at = now(), error = ? WHERE id = ?`,
        String(e instanceof Error ? e.message : e).slice(0, 300),
        uploadId,
      ),
    ).catch(() => {})
  }
}

/**
 * How many interruptions before a file is left alone.
 *
 * The bound exists for one case: a file whose reading kills the process. Without it that
 * restarts, resumes, kills the process again, and does so forever — a deploy loop caused by
 * one bad PDF. Three is enough that an unlucky deploy costs nobody anything.
 */
const MAX_ATTEMPTS = 3

/**
 * Boot only, in the process that owns the work.
 *
 * A row still marked `running` at boot cannot be running — nothing was. Everything needed
 * to finish it is still in the row, including the file itself, so it goes back in the queue
 * and picks up where it left off rather than asking somebody to press the button again for
 * a decision they do not have to make.
 *
 * This must NOT be on the poller: a tick arriving mid-read would restart a job that is
 * working perfectly, and on a sixty-page scan it would never finish.
 */
export async function recover() {
  if (!ownsSingletons) return

  await asSystem(async () => {
    // Tried and interrupted too many times. Said plainly, because at this point it is not
    // bad luck — something about this file is stopping the process that reads it.
    await run(
      `UPDATE uploads SET status = 'failed', finished_at = now(),
              error = 'Stopped after being interrupted ' || attempts || ' times. Something about this file ends the read.'
        WHERE status = 'running' AND attempts >= ?`,
      MAX_ATTEMPTS,
    )
    await run(`UPDATE uploads SET status = 'queued' WHERE status = 'running'`)
  })

  await sweep()
}

/**
 * Start anything still queued. Safe on a timer: `queued` is by definition not started, and
 * the claim inside beginImpl decides the winner if a hand-off arrives at the same moment.
 *
 * The backstop for a hand-off that never landed — the owner was restarting, or the IPC
 * failed. Without it such an upload would sit queued forever.
 */
export async function sweep() {
  if (!ownsSingletons) return

  // Enumerating across workspaces: the sweep has no session, like the rest of the poller.
  const waiting = await asSystem(() =>
    all<{ id: number; workspace_id: number }>(`SELECT id, workspace_id FROM uploads WHERE status = 'queued'`),
  )
  for (const row of waiting) await beginImpl(row.id, row.workspace_id)
}
