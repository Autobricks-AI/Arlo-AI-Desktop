/**
 * Credentials at rest.
 *
 * Anything a connector stores that would let someone else into a third-party account
 * goes through here first, so a copy of the database — a backup, a dump, a
 * laptop someone walks off with — is not a copy of everyone's access.
 *
 * One implementation, shared by every connector. Two implementations of an encryption
 * routine is how one of them quietly stops being used.
 *
 * ponytail: one key in the environment, no rotation. It sits on the same host as the
 * database, so it defends against the file leaving, not against the host being owned.
 * Upgrade path when that matters: a KMS or the OS keychain behind these same two calls.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const KEY = process.env.SECRET_KEY ? createHash('sha256').update(process.env.SECRET_KEY).digest() : null


export const seal = (plain: string) => {
  if (!KEY) return plain
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', KEY, iv)
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `enc:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`
}

export const open = (stored: string) => {
  // Values written before SECRET_KEY was set stay readable — the prefix is the marker,
  // so turning encryption on is not a migration.
  if (!stored.startsWith('enc:')) return stored
  if (!KEY) throw new Error('SECRET_KEY is not set, but stored credentials are encrypted with one')
  const raw = Buffer.from(stored.slice(4), 'base64')
  const d = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12))
  d.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
}

/** An unreadable secret reads as absent rather than taking the whole page down. */
export const openOrNull = (stored: string | null | undefined) => {
  if (!stored) return null
  try {
    return open(stored)
  } catch {
    return null
  }
}
