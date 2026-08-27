/**
 * Writing one value back into `.env`.
 *
 * The app rewriting its own configuration is unusual enough to say why: the Autobricks key
 * is pasted into Settings, and a copy that lived only in the database would disappear with
 * the volume — `docker compose down -v` would take every bot's ability to answer with it,
 * silently, until somebody found the key again. So the key is saved in both places, and this
 * is the half that outlives the container.
 *
 * ---------------------------------------------------------------- what it will not do
 *
 * One variable, by exact name, and nothing else. It does not parse `.env` into a structure
 * and write it back out: that file is mostly comments explaining why each value is what it
 * is, and a round trip through a parser would flatten all of it. Every line it is not asked
 * about is copied through byte for byte.
 *
 * The previous value is commented out rather than dropped, which is the rule for this file
 * — a key that turns out to have been the working one should be recoverable by uncommenting
 * it, not by remembering it.
 *
 * ---------------------------------------------------------------- when it does nothing
 *
 * Absent file, or one that cannot be written — a container without the bind mount, a
 * read-only filesystem — is **not** an error. The database copy is what answers calls, so a
 * failure here costs durability, not function, and taking down "save your key" because a
 * mount is missing would be the wrong trade. It says so in the log and carries on.
 */
import { readFile, writeFile } from 'node:fs/promises'

/** Where `.env` is, relative to the process — the same place `--env-file` looked. */
const PATH = process.env.ENV_FILE || '.env'

/**
 * Values are written raw, so a newline in one would forge a second variable. The keys this
 * is called with are provider credentials, which are never multi-line — checked rather than
 * assumed, because "never" is doing a lot of work in that sentence.
 */
const oneLine = (v: string) => !/[\r\n]/.test(v)

export async function writeEnv(name: string, value: string) {
  if (!oneLine(value)) throw new Error('That value contains a line break')

  let text: string
  try {
    text = await readFile(PATH, 'utf8')
  } catch {
    console.warn(`[env] no ${PATH} to update — ${name} is saved in the database only`)
    return false
  }

  const line = `${name}=${value}`
  const active = new RegExp(`^${name}=.*$`, 'm')

  let next: string
  if (active.test(text)) {
    // Keep what was there, commented, above the new one.
    next = text.replace(active, (old) => `# ${old}   # replaced ${new Date().toISOString().slice(0, 10)}\n${line}`)
  } else {
    next = text.endsWith('\n') ? `${text}${line}\n` : `${text}\n${line}\n`
  }

  try {
    await writeFile(PATH, next, 'utf8')
    return true
  } catch (e) {
    // Read-only mount, or no mount at all. Worth knowing about, not worth failing over.
    console.warn(`[env] could not write ${PATH}:`, e instanceof Error ? e.message : e)
    return false
  }
}
