/**
 * Some things must exist exactly once, however many processes serve requests.
 *
 * WhatsApp is the reason. Baileys holds one socket per linked number, and WhatsApp itself
 * enforces the "one" — link the same session twice and it kills one of them with a
 * conflict. The mailbox poller and the reminder sweep are the same shape for a duller
 * reason: four workers would run each of them four times.
 *
 * So the process that forks the web workers keeps those to itself, and a worker that
 * needs one asks for it. The transport is the IPC channel `cluster` already opens between
 * a worker and its parent — no port, no auth, nothing to configure, and it dies with the
 * process it belongs to.
 *
 * The read path deliberately does NOT come through here. A worker reads WhatsApp's status
 * off disk, which is why `list`/`get`/`chats` stay synchronous and their callers were left
 * alone. This is only for the handful of calls that have to reach the live socket.
 *
 * Outside a cluster — `vite dev`, `npm test`, a one-off script — `ownsSingletons` is true
 * and every wrapper calls straight through. The indirection costs nothing and exists
 * nowhere but production.
 */
import cluster from 'node:cluster'
import { rawClient } from './db.ts'

/**
 * Does this process own the singletons?
 *
 * True in the cluster primary, and true in any process that is not clustered at all.
 * False only in a forked web worker, which is exactly where the RPC is needed.
 */
export const ownsSingletons = !cluster.isWorker

/** ARLO in hex — see `tryOwnLiveSingletons()`. Any constant would do; this one is legible in `pg_locks`. */
const LIVE_SINGLETONS_KEY = 0x41726c6f

let owner: Awaited<ReturnType<typeof rawClient>> | null = null

/**
 * Cross-process version of `ownsSingletons`: is this the one live process, across every
 * `vite dev`, prod primary, or one-off script pointed at this database — not just within
 * one's own cluster?
 *
 * Tried once, non-blocking, on a connection kept open for the process's whole life.
 * Session-scoped (`pg_try_advisory_lock`, not the `_xact_` form `customers.identify()`
 * uses), because this has to outlive any single transaction. The first process to call this
 * wins and holds the lock until it exits or crashes: Postgres frees a session-level advisory
 * lock the instant the connection that took it closes, so a killed owner needs no cleanup
 * and blocks nothing on its way out. A process that does not win is not an error — it serves
 * pages exactly as before, and simply never becomes a second WhatsApp client or a second
 * timer.
 *
 * A fixed key, not a computed one: unlike `identify()`'s per-identity lock, there is exactly
 * one thing being protected here. It shares Postgres's one per-database advisory-lock space
 * with `identify()`'s hashed keys, but sits far from a uniformly-hashed 64-bit value, so a
 * real collision is not a practical concern.
 *
 * ponytail: holds one pooled connection for the process's whole life, so DATABASE_POOL
 * effectively shrinks by one on the winner — fine at the default of 10, worth minding if
 * that is ever turned down near 1. And if the connection drops out from under it (a network
 * blip) without the process itself dying, Postgres releases the lock but this process never
 * finds out and keeps believing it owns WhatsApp and the poller. No heartbeat/reacquire here
 * — the same "no automatic promotion" ceiling the plan already names for a hard process
 * death, just reached by a different door.
 */
export async function tryOwnLiveSingletons(): Promise<boolean> {
  const client = await rawClient()
  const { rows } = await client.query<{ got: boolean }>('select pg_try_advisory_lock($1) as got', [
    LIVE_SINGLETONS_KEY,
  ])
  if (rows[0]?.got) {
    owner = client // held forever on purpose — releasing this connection is what frees the lock
    return true
  }
  client.release()
  return false
}

/**
 * Give up ownership early, by destroying the held connection rather than unlocking it — the
 * same way a killed process would. Not called by the app itself; a live process holds this
 * for its whole life. Exists so a test can prove the lock releases on disconnect.
 *
 * Waits for the socket to actually close rather than returning the moment `.release(true)`
 * is called: the pool tears the connection down on its own schedule
 * (`pg-pool`'s `_remove` calls `client.end()` with a callback, not inline), so a caller that
 * did not wait could race a very next `tryOwnLiveSingletons()` against a lock Postgres has
 * not finished dropping yet — which is exactly what a busy CI box turned up here.
 */
export function releaseLiveSingletons(): Promise<void> {
  if (!owner) return Promise.resolve()
  const client = owner
  owner = null
  return new Promise((resolve) => {
    client.once('end', () => resolve())
    client.release(true) // destroy rather than return to the pool — this is what frees the lock
  })
}

type Fn = (...args: any[]) => Promise<any>

/** name → the real implementation. Only ever consulted in the owning process. */
const registry = new Map<string, Fn>()

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }
const waiting = new Map<number, Pending>()
let seq = 0

/**
 * A call that has to reach the socket is a call that can hang, so it gets a deadline.
 * Long enough for WhatsApp to open a connection and produce a code; short enough that a
 * wedged primary shows up as an error rather than as a spinner nobody can explain.
 *
 * Doubled when replies grew attachments: a send now reads a file out of Postgres and uploads
 * it to WhatsApp's media servers before it returns, and a 25MB manual on a slow line has no
 * business failing at sixty seconds when it was going to succeed at seventy.
 */
const TIMEOUT_MS = 120_000

function callOwner(name: string, args: unknown[]): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error(`${name} is unavailable: no IPC channel`))

    const id = ++seq
    waiting.set(id, { resolve, reject })

    const timer = setTimeout(() => {
      if (waiting.delete(id)) reject(new Error(`${name} timed out after ${TIMEOUT_MS / 1000}s`))
    }, TIMEOUT_MS)
    // Housekeeping must not be what keeps the worker alive.
    timer.unref?.()

    process.send({ __singleton: { id, name, args } })
  })
}

/**
 * Register an implementation, and get back a function that is safe to call from any
 * process: it runs the implementation where the implementation lives, and returns the
 * result where it was called.
 *
 * Arguments and results cross a process boundary, so they have to survive a structured
 * clone. Everything routed through here is plain data — ids, labels, and the account and
 * chat records, which are already what the browser is sent.
 */
export function singleton<T extends Fn>(name: string, fn: T): T {
  registry.set(name, fn)
  if (ownsSingletons) return fn
  return ((...args: unknown[]) => callOwner(name, args)) as T
}

// A worker's side of the conversation: match a reply to the call that is waiting for it.
if (cluster.isWorker) {
  process.on('message', (m: any) => {
    const reply = m?.__singletonReply
    if (!reply) return
    const pending = waiting.get(reply.id)
    if (!pending) return // timed out already, or not ours
    waiting.delete(reply.id)
    if (reply.error) pending.reject(new Error(reply.error))
    else pending.resolve(reply.value)
  })
}

/**
 * The owner's side. Call this once per worker, from the process that forked it.
 *
 * Errors are sent back as a message rather than thrown here: the worker is holding a
 * promise open, and a rejection it can surface to the user beats a primary that dies
 * because somebody typed a bad label.
 */
export function serveSingletons(worker: { on: Function; send: Function }) {
  worker.on('message', async (m: any) => {
    const call = m?.__singleton
    if (!call) return

    const send = (reply: object) => {
      // The worker may be gone by the time a slow call finishes; that is not an error.
      try {
        worker.send({ __singletonReply: { id: call.id, ...reply } })
      } catch {}
    }

    const fn = registry.get(call.name)
    if (!fn) return send({ error: `No singleton named ${call.name}` })

    try {
      send({ value: await fn(...call.args) })
    } catch (e) {
      send({ error: e instanceof Error ? e.message : String(e) })
    }
  })
}
