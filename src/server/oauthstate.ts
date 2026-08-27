/**
 * The `state` that ties an OAuth callback back to the person who started it.
 *
 * Without one, the callback takes whatever `code` arrives and binds the mailbox it belongs
 * to onto whichever session's cookie came with the request. An attacker starts a consent
 * flow against their *own* mailbox, gets a signed-in user to open the resulting callback
 * URL — a top-level GET, so SameSite=Lax sends the cookie — and their mailbox is now
 * connected to the victim's workspace, quietly feeding chosen messages into it.
 *
 * The fix is the one the spec has always described: mint a random value, remember what it
 * was for, and refuse a callback that does not carry it back.
 *
 * PKCE rides along. It protects a different thing — a code intercepted between the
 * provider and us — and costs one hash, so there is no reason not to.
 *
 * These live in a table rather than a Map because the app runs as several processes:
 * consent would start on one worker and come back to another, and a flow that failed
 * depending on which worker answered would be the worst kind of intermittent.
 *
 * What is stored is a hash of the state, not the state. A read of the table is then not
 * enough to complete somebody's flow; you would need the preimage, which only ever existed
 * in the redirect URL.
 */
import { createHash, randomBytes } from 'node:crypto'
import { one, run } from './db.ts'

/** Long enough that a slow consent still works, short enough to bound the window. */
const TTL_MS = 10 * 60 * 1000

const b64url = (b: Buffer) => b.toString('base64url')
const sha256 = (s: string) => createHash('sha256').update(s).digest()
const hash = (state: string) => b64url(sha256(state))

const sweep = () => run(`DELETE FROM oauth_state WHERE expires_at < now()`)

/** Start a consent: returns the state to send and the challenge to send with it. */
export async function issue(workspaceId: number, provider: string) {
  await sweep()

  const state = b64url(randomBytes(32))
  const verifier = b64url(randomBytes(32))

  await run(
    `INSERT INTO oauth_state (state_hash, workspace_id, provider, verifier, expires_at)
     VALUES (?,?,?,?, now() + interval '10 minutes')`,
    hash(state),
    workspaceId,
    provider,
    verifier,
  )

  return {
    state,
    verifier,
    // S256: the provider only ever sees the hash, so an intercepted code is not enough.
    challenge: b64url(sha256(verifier)),
  }
}

/**
 * Redeem a callback's state. Returns what the flow was for — including **which workspace**
 * — or null if it is not one we started, has already been used, or has expired.
 *
 * Single use, and that is the delete's job rather than a later cleanup's: `delete …
 * returning` is one statement, so two callbacks racing the same state produce exactly one
 * winner. A read followed by a delete would let both through.
 *
 * The workspace comes *out* of this rather than being passed in, and that is the point:
 * the row is what proves which workspace started the flow. Taking it from the session
 * instead is the attack described at the top of this file, and it also breaks the ordinary
 * case — a callback arrives from the provider's own site, and any browser that declines to
 * send the cookie on that hop (a changed origin, a stricter setting) would otherwise lose a
 * consent the person just granted.
 */
export async function redeem(state: string | null, provider: string) {
  if (!state) return null

  const found = await one<{ workspace_id: number; provider: string; verifier: string }>(
    `DELETE FROM oauth_state
      WHERE state_hash = ? AND provider = ? AND expires_at >= now()
      RETURNING workspace_id, provider, verifier`,
    hash(state),
    provider,
  )
  if (!found) return null

  return { workspaceId: found.workspace_id, provider: found.provider, verifier: found.verifier }
}

/** Only the tests need this. */
export const clear = async () => {
  await run(`DELETE FROM oauth_state`)
}

