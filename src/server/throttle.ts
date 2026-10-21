/**
 * A small limiter for the endpoints anyone can reach without being signed in.
 *
 * Sign-in has no lockout and no backoff, so a password is only as good as how fast an
 * attacker can try the next one — and 30-day sessions mean one success is durable. The
 * webhooks are the same shape: a token guesser has unlimited attempts.
 *
 * The buckets live in `rate_limits` rather than in a Map, because the app runs as several
 * processes and a per-process counter would quietly multiply every limit by the worker
 * count. Still deliberately not a dependency: this is forty lines and one UPSERT.
 */
import { one, run } from './db.ts'

export type Limit = {
  /** How many attempts inside the window. */
  max: number
  /** The window, in milliseconds. */
  windowMs: number
}

/** Sign-in: slow enough to make guessing pointless, loose enough to survive a typo. */
export const SIGN_IN: Limit = { max: 10, windowMs: 5 * 60_000 }
/** Webhooks: a token is 256 bits, so this is about noise, not about guessing. */
export const WEBHOOK: Limit = { max: 120, windowMs: 60_000 }
/**
 * Outbound replies, per workspace. Two loops this stops: an agent answering its own
 * message, and a hostile sender running up the model bill or getting a WhatsApp number
 * banned for spam. Generous for a human conversation, cheap for a runaway one.
 */
export const REPLY: Limit = { max: 60, windowMs: 60_000 }

/**
 * Registration. Tighter than sign-in, because there is no honest reason to redeem codes
 * in a burst — a person does this once — and every success provisions a workspace.
 */
export const REGISTER: Limit = { max: 5, windowMs: 15 * 60_000 }

/**
 * Joining the waitlist, per address. Nobody puts the same address down four times in a
 * quarter of an hour, and this is the bucket that stops one entry being replayed until its
 * `seen_count` means nothing.
 */
export const WAITLIST: Limit = { max: 3, windowMs: 15 * 60_000 }

/**
 * The same form, per caller — and a different number, which is why it is a second constant
 * rather than REGISTER's one used twice.
 *
 * REGISTER gets away with sharing a limit because both of its buckets mean "one person,
 * once". This one does not: an office behind one NAT is many honest people at one address,
 * and a launch is exactly when several of them turn up in the same hour. Loose enough to
 * survive that, tight enough that a script filling the table is throttled long before an
 * administrator has to look at it.
 */
export const WAITLIST_CALLER: Limit = { max: 20, windowMs: 60 * 60_000 }

/**
 * Count one attempt against `key`. Returns how long to wait, or 0 when it is allowed.
 *
 * The whole thing is one statement on purpose. Read-then-write would let two workers both
 * see the ninth attempt and both write the tenth, which is exactly the race that moving
 * out of process memory was supposed to close. `on conflict do update` makes the read,
 * the decision and the write one atomic act, and `returning` hands back the result of it.
 *
 * The window is fixed rather than sliding: cheaper, and the difference only matters to an
 * attacker who is already being told to wait.
 */
export async function take(key: string, limit: Limit): Promise<number> {
  const now = Date.now()
  const until = now + limit.windowMs

  const row = await one<{ hits: number; until_ms: number }>(
    `INSERT INTO rate_limits (key, hits, until_ms) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       -- An expired bucket is a new window, not a continuation of the old one.
       hits     = CASE WHEN rate_limits.until_ms <= ? THEN 1 ELSE rate_limits.hits + 1 END,
       until_ms = CASE WHEN rate_limits.until_ms <= ? THEN ? ELSE rate_limits.until_ms END
     RETURNING hits, until_ms`,
    key,
    until,
    now,
    now,
    until,
  )

  // Opportunistic sweep: without it the table keeps every key it has ever seen. One in a
  // hundred calls, because it is housekeeping and nothing depends on it having run.
  if (Math.random() < 0.01) await run(`DELETE FROM rate_limits WHERE until_ms <= ?`, now)

  if (!row) return 0
  return row.hits > limit.max ? row.until_ms - now : 0
}

/** The caller that wants an exception rather than a number. */
export async function enforce(key: string, limit: Limit, what = 'attempts') {
  const wait = await take(key, limit)
  if (wait) throw new Error(`Too many ${what}. Try again in ${Math.ceil(wait / 1000)} seconds.`)
}

/** Only the tests need this. */
export const reset = async () => {
  await run(`DELETE FROM rate_limits`)
}

/**
 * Who is asking, for the limits that count callers rather than addresses.
 *
 * The header order is not arbitrary and getting it wrong is worse than not limiting at
 * all — every request would share one bucket and the first ten sign-ins of the day would
 * lock out the eleventh person.
 *
 * `cf-connecting-ip` comes first because some reverse proxies **replace**
 * `x-forwarded-for` with their own address on the way in, so by the time it reaches this
 * process that header reads as one private address for everybody. Cloudflare's own header is
 * the only one still carrying the client. The other two are for running behind an ordinary
 * proxy, or none.
 *
 * Trusting a header at all is only safe because nothing reaches this process except
 * through the proxy — the app binds a private address. Exposed directly, any of these can
 * be typed by the caller, and this has to become an allowlist of proxy addresses.
 */
export function callerIp(request: Request): string {
  const h = request.headers
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null
  return first(h.get('cf-connecting-ip')) ?? first(h.get('x-forwarded-for')) ?? first(h.get('x-real-ip')) ?? 'unknown'
}
