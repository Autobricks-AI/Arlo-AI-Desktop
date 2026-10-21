/**
 * Where bytes live: a directory on this machine.
 *
 * Attachments, resources and their previews are too big for Postgres -- they are what makes a
 * database grow without anybody adding a record -- so they go to a store and the row keeps
 * only a key. Here that store is a directory, which is all one machine needs; the four
 * functions below are the seam, so a deployment that wants object storage instead replaces
 * this one file and nothing else.
 *
 * Four functions are the contract, and the callers in `attachments.ts`, `resources.ts` and
 * `media.ts` know nothing beyond them. Keys are content-addressed already
 * (`media/<workspace>/<sha256>.<ext>`, `keyFor` in `media.ts`), so they are a path shape as
 * much as a key shape and this file just puts a root in front of them.
 *
 * ---------------------------------------------------------------- the volume is the point
 *
 * `MEDIA_DIR` is a **named volume** in docker-compose.yml, beside the WhatsApp session and the
 * OCR cache. That is load-bearing rather than tidy: the README tells people `docker compose
 * down` keeps their data, and a file written into the container's own writable layer does not
 * survive it. A move out of the database that lands somewhere a rebuild erases is worse than
 * never moving at all, because the database copy is deleted once the write succeeds.
 *
 * Which is also why `putObject` fails loudly instead of swallowing anything: `media.ts` nulls
 * the `bytes` column only after this resolves, and a throw leaves the row exactly as it was
 * for the sweep to try again on the next tick.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

/*
 * No default, deliberately.
 *
 * A relative default -- `?? '.media'` -- makes any process with a working directory into a
 * file store, and that cannot be made safe, because what is wrong about it is not visible
 * from inside the store. `./.media` is a correct answer to "where can I write" and a
 * disastrous answer to "where does this database keep its files", and the move reads only the
 * first question. A process started somewhere else writes somewhere else, succeeds, and the
 * database copy is deleted on the strength of it.
 *
 * So the store is named deliberately or not at all. Unset means nowhere to put bytes, and the
 * sweeps then leave every file in the database exactly where it is -- the right behaviour for
 * a process nobody told where the files live.
 *
 * docker-compose.yml sets it explicitly, pointing at the volume.
 */
const ROOT = process.env.MEDIA_DIR ?? ''

export const storageConfigured = () => !!ROOT

/**
 * The absolute path for a key, and a refusal if the key tries to leave the root.
 *
 * Every key this is called with today is built by `keyFor()` out of a workspace id and a
 * hex digest, so none of them can contain `..` or an absolute path. This checks anyway: it
 * is the boundary between a database column and the filesystem, the check costs one string
 * comparison, and the day somebody adds a key built from a filename is the day it matters.
 */
function pathFor(key: string): string {
  const root = resolve(ROOT)
  const full = resolve(root, key)
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`Refusing a storage key outside the root: ${key}`)
  return full
}

/**
 * Put bytes at a key, overwriting whatever is there.
 *
 * Overwriting is the de-duplication: the key is the content hash, so writing the same file
 * twice writes the same bytes twice and the second is free. It also makes a retry after a
 * failure half way through harmless.
 *
 * `mime` is accepted and ignored. A filesystem has nowhere to record it and the row already
 * carries it; the parameter stays so this and the object-storage implementation are the same
 * four signatures.
 */
export async function putObject(key: string, bytes: Buffer, _mime: string | null) {
  const full = pathFor(key)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, bytes)
}

/**
 * The bytes back, or null if there are none to read.
 *
 * **Null does not mean gone.** A file swept after its window and a read that failed on the
 * way both arrive here as null, and a caller that reads it as "no longer held" will tell
 * somebody their file is missing while it sits on disk. Still null rather than a throw,
 * because the swept case is ordinary and a caller that has to catch is a caller that will
 * not -- but the two are told apart in the log, because only one of them is a fault.
 */
export async function getObject(key: string): Promise<Buffer | null> {
  // Outside the try on purpose. A key that climbs out of the root is a refusal, not a miss:
  // swallowed into the null below it would read as "that file is gone" and be indistinguishable
  // from an attachment past its window, which is the one thing this function must not confuse.
  const full = pathFor(key)
  try {
    return await readFile(full)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.error(`[storage] could not read ${key}:`, e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Drop objects.
 *
 * Failure is swallowed on purpose: the caller has already decided these bytes are past their
 * window, and a file left behind costs disk but breaks nothing, while a throw here would stop
 * the sweep that was tidying up after it.
 */
export async function removeObjects(keys: string[]) {
  if (!keys.length) return
  for (const key of keys) {
    try {
      await rm(pathFor(key), { force: true })
    } catch (e) {
      console.error(`[storage] could not remove ${key}:`, e instanceof Error ? e.message : e)
    }
  }
}
