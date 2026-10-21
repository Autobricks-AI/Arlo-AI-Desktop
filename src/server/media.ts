/**
 * Files, out of the database and smaller on the way.
 *
 * `attachments` is the fastest-growing table in the schema and most of what it holds is the
 * same file over again -- one brochure sent by hand to every enquiry, plus every photo and
 * video anybody has ever sent in. The bytes column was never meant to be the final home; it
 * is the staging area.
 *
 * Two jobs, both on the poller rather than the message path, because a customer waiting for a
 * reply must never be waiting on a video transcode:
 *
 *   move      compress what can be compressed, put it in Storage, clear the row
 *   forget    past the window, drop the object and leave the record
 *
 * A third, `thumbnail()`, is only the picture-making half — the sweep that drives it lives in
 * resources.ts, because it reads rows this module knows nothing about and resources.ts already
 * imports from here. The reverse would be a cycle.
 *
 * Bounded per tick. The poller runs its sweeps in sequence and skips rather than stacks when
 * one runs long, so this takes a few rows at a time and leaves the rest for the next pass —
 * the same claim-and-retry shape the crawl and upload sweeps already use.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { all, asSystem, run } from './db.ts'
import { pictures } from './pdfimages.ts'
import { getObject, putObject, removeObjects, storageConfigured } from './storage.ts'

/**
 * How many files one tick will move.
 *
 * Small on purpose. A 20 MB video is seconds of ffmpeg, and this sweep runs behind the ones
 * that answer customers — four at a time means a backlog drains over minutes rather than one
 * tick holding everything else up.
 */
const PER_TICK = 4

/** How long a file stays readable. After this the record remains and the bytes do not. */
const KEEP_DAYS = 30

/** Longest edge for a stored image. Past this is detail nobody looks at in an inbox. */
const IMAGE_EDGE = 1600

/** Longest edge for a card preview. 64 CSS pixels at 3x, with headroom. Around 10 kB of webp. */
const THUMB_EDGE = 320

/**
 * How many pages to look at before picking one.
 *
 * Every candidate is inflated and re-encoded on the way out of `pictures()`, so this is the
 * cost knob, not a quality one. Six is enough to get past a cover sheet without paying for a
 * sixty-page scan.
 */
const THUMB_CANDIDATES = 6

/** Give up on a converter rather than let it hold a sweep slot for ever. */
const CONVERT_TIMEOUT = 120_000

const isImage = (mime: string | null) => !!mime?.startsWith('image/') && !mime.includes('svg')
const isVideo = (mime: string | null) => !!mime?.startsWith('video/')

/**
 * Run ffmpeg over a buffer, through temporary files.
 *
 * Paths rather than pipes because ffmpeg cannot seek a pipe, which it needs to finish an mp4
 * container — and a temp file costs one write we were about to do over the network anyway.
 *
 * Null on any failure, which is the whole error policy: a file that will not convert is stored
 * as it arrived. Nothing here is worth losing a customer's receipt over, and a box with no
 * ffmpeg installed simply fills up more slowly rather than breaking.
 */
async function transcode(bytes: Buffer, args: (inPath: string, outPath: string) => string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'arlo-media-'))
  const inPath = join(dir, 'in.mp4')
  const outPath = join(dir, 'out.mp4')
  try {
    await writeFile(inPath, bytes)
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn('ffmpeg', args(inPath, outPath), { stdio: 'ignore' })
      const giveUp = setTimeout(() => child.kill('SIGKILL'), CONVERT_TIMEOUT)
      child.on('error', () => {
        clearTimeout(giveUp)
        resolve(false)
      })
      child.on('close', (code) => {
        clearTimeout(giveUp)
        resolve(code === 0)
      })
    })
    return ok ? await readFile(outPath) : null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 720p at most, never upscaled, both sides even — which is what H.264 insists on. */
const SCALE =
  "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2"

/**
 * Smaller, or exactly what arrived.
 *
 * A conversion that comes back *larger* is thrown away. That happens with an already-optimised
 * image, and storing the bigger one for the sake of consistency would be silly.
 */
export async function shrink(bytes: Buffer, mime: string | null): Promise<{ bytes: Buffer; mime: string | null }> {
  if (isImage(mime)) {
    try {
      const sharp = (await import('sharp')).default
      const out = await sharp(bytes)
        // Before the resize, or a portrait photo with its orientation in EXIF comes out
        // sideways once the tag is dropped.
        .rotate()
        .resize({ width: IMAGE_EDGE, height: IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
      if (out.length < bytes.length) return { bytes: out, mime: 'image/webp' }
    } catch {
      // No sharp, or an image it cannot read. Stored as it came.
    }
    return { bytes, mime }
  }

  if (isVideo(mime)) {
    const out = await transcode(bytes, (i, o) => [
      '-y',
      '-i',
      i,
      '-vf',
      SCALE,
      '-c:v',
      'libx264',
      '-crf',
      '28',
      '-preset',
      'veryfast',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      // Metadata at the front, so a browser can start playing before it has the whole file.
      '-movflags',
      '+faststart',
      o,
    ])
    if (out && out.length < bytes.length) return { bytes: out, mime: 'video/mp4' }
    return { bytes, mime }
  }

  // A PDF, a document, a spreadsheet. Already compressed; re-encoding buys nothing and can
  // quietly ruin a file somebody needs to read.
  return { bytes, mime }
}

/** Where a file lives. The hash, so the same content always lands on the same object. */
export const keyFor = (workspaceId: number, sha: string, mime: string | null) =>
  `media/${workspaceId}/${sha}${isImage(mime) ? '.webp' : ''}`

/**
 * Where its preview lives: beside it, in the same content-addressed keyspace.
 *
 * Derived from the hash rather than the row id, so two library entries holding the same
 * brochure share one preview object, and re-uploading a file we have already looked at costs
 * nothing. The suffix is what keeps it off `keyFor`'s own address.
 */
export const thumbKeyFor = (workspaceId: number, sha: string) => `media/${workspaceId}/${sha}.thumb.webp`

/**
 * A picture of what is inside a file, or null when there is nothing worth showing.
 *
 * PDFs only, and deliberately. An image is its own thumbnail — the rule the inbox already
 * follows — so generating a second copy of one would be work that buys a card nothing.
 *
 * What this can do is bounded by `pictures()`, which reads image XObjects out of the file
 * rather than rendering pages: a brochure, an EDM or a scan has its artwork embedded and comes
 * back with something, a contract drawn entirely in text comes back empty. Empty is a real
 * answer here, not a failure — the card falls back to its badge, which is what it shows today.
 *
 * The *largest* candidate rather than the first. `pictures()` has no page tree, so file order is
 * not page order; on a real library the first image was a header strip twice out of four, and
 * the largest was the page artwork every time. Measured, not assumed.
 *
 * ponytail: still not necessarily page one. Getting the actual cover needs a PDF parser with a
 * page tree, which is a new dependency. A picture from inside the document is still a picture
 * of the document.
 *
 * Webp unconditionally, because the route that serves these says `image/webp` and must not be
 * lying. No sharp, or artwork it cannot read, means no preview rather than a wrong content-type.
 */
export async function thumbnail(bytes: Buffer, mime: string | null): Promise<Buffer | null> {
  if (mime !== 'application/pdf') return null

  const { found } = await pictures(bytes, THUMB_CANDIDATES)
  if (!found.length) return null
  // Width and height come off the PDF dictionary, so choosing costs no decode.
  const best = found.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a))

  try {
    const sharp = (await import('sharp')).default
    return await sharp(best.bytes)
      .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer()
  } catch {
    // No sharp, or a picture it cannot read. The card keeps its badge.
    return null
  }
}

type Pending = { id: number; workspace_id: number; sha256: string | null; mime: string | null; bytes: Buffer }

/**
 * Did the bytes we just wrote actually land somewhere we can read them? Throws if not.
 *
 * `putObject` returning without throwing means the write succeeded *somewhere* -- which is not
 * the same as the store this deployment reads from. A mount that has gone away, a bucket that
 * accepts writes but will not serve them back, a store belonging to a different database: in
 * every one of those the write returns cleanly and the only copy is gone.
 *
 * So the question is not "did the write return" but "can I get it back", and the hash makes
 * that a real comparison rather than a presence check.
 *
 * Compared against what was *written*, not against `row.sha256`: `shrink()` re-encodes images,
 * so the stored bytes are legitimately not the bytes the row arrived with, and checking against
 * the row's own hash would fail on every photo.
 *
 * Its own function so it can be tested without a working store -- the branch that matters is
 * the failing one, and arranging a store that writes but cannot read is not something the
 * filesystem will do on request.
 */
export async function proveStored(key: string, wrote: Buffer): Promise<void> {
  const back = await getObject(key)
  if (!back) throw new Error(`wrote ${key} but could not read it back, so the row keeps its bytes`)
  const a = createHash('sha256').update(back).digest('hex')
  const b = createHash('sha256').update(wrote).digest('hex')
  if (a !== b) throw new Error(`${key} read back as different bytes (${a.slice(0, 12)} not ${b.slice(0, 12)})`)
}

/**
 * Move what has arrived, and forget what is past its window.
 *
 * Does nothing at all without a store configured, rather than half-moving a corpus: an
 * install with `MEDIA_DIR` blank keeps its files in the database exactly as before.
 */
export async function sweepMedia() {
  if (!storageConfigured()) return

  const waiting = await asSystem(() =>
    all<Pending>(
      `SELECT id, workspace_id, sha256, mime, bytes FROM attachments
        WHERE bytes IS NOT NULL AND storage_key IS NULL
        ORDER BY id LIMIT ?`,
      PER_TICK,
    ),
  )

  for (const row of waiting) {
    try {
      const { bytes, mime } = await shrink(row.bytes, row.mime)
      const sha = row.sha256 ?? createHash('sha256').update(row.bytes).digest('hex')
      const key = keyFor(row.workspace_id, sha, mime)
      await putObject(key, bytes, mime)
      await proveStored(key, bytes)
      /*
       * The row loses its bytes only once the object is up and proven readable. The other
       * order would lose a file to a failed upload, and there is no second copy to go back to.
       */
      await asSystem(() =>
        run(
          `UPDATE attachments SET bytes = NULL, storage_key = ?, sha256 = ?, mime = ?, size_bytes = ?
            WHERE id = ?`,
          key,
          sha,
          mime,
          bytes.length,
          row.id,
        ),
      )
    } catch (e) {
      // Left exactly as it was, to be picked up next tick. One unreadable file must not stop
      // the queue behind it.
      console.error(`[media] attachment ${row.id} not moved:`, e instanceof Error ? e.message : e)
    }
  }

  await forgetOldMedia()
}

/**
 * Past the window: the object goes, the record stays.
 *
 * Only dropped when nothing *inside* the window still points at that key — the same brochure
 * sits on a thread from August and one from this morning, and the August row ageing out must
 * not take the file away from the newer one.
 */
async function forgetOldMedia() {
  const stale = await asSystem(() =>
    all<{ storage_key: string }>(
      `SELECT DISTINCT a.storage_key FROM attachments a
        WHERE a.storage_key IS NOT NULL
          AND a.created_at < now() - make_interval(days => ?)
          AND NOT EXISTS (
            SELECT 1 FROM attachments b
             WHERE b.storage_key = a.storage_key
               AND b.created_at >= now() - make_interval(days => ?)
          )
          /*
           * And not one the library is holding.
           *
           * A resource points at the same object when somebody shares a file out of a
           * conversation — one object, two referrers, which is the whole point of a content
           * -addressed key. Without this clause the attachment ages out on day 30, takes the
           * object with it, and the public link already forwarded to customers starts
           * answering 404 with nothing in the logs to say why.
           *
           * This clause is also the entire retention rule for the library: in it means kept,
           * and there is no flag or expiry column anywhere because the sweep can simply see it.
           */
          AND NOT EXISTS (
            SELECT 1 FROM resources r WHERE r.storage_key = a.storage_key
          )
        LIMIT 50`,
      KEEP_DAYS,
      KEEP_DAYS,
    ),
  )
  if (!stale.length) return

  const keys = stale.map((s) => s.storage_key)
  await removeObjects(keys)
  await asSystem(() => run(`UPDATE attachments SET storage_key = NULL WHERE storage_key = ANY(?::text[])`, keys))
}
