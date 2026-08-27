import { all, asSystem, insert, one, run } from './db.ts'
import * as web from './channels/web.ts'
import * as bases from './bases.ts'
import * as catalogue from './catalogue.ts'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { SIGN_IN, enforce } from './throttle.ts'
import { seal } from './secrets.ts'
import { writeEnv } from './envfile.ts'
import { DEFAULT_PASSWORD, DEFAULT_USER } from '../types.ts'

export { close } from './db.ts'

/**
 * Who is signed in, and which workspace they are looking at.
 *
 * One account, on one machine, with a username and a password kept here — no identity
 * provider, and no network needed to reach one. Everything provider-specific is in this
 * file, so the workspace and membership tables never had to care which it was.
 *
 * ---------------------------------------------------------------- the default credential
 *
 * A fresh install is `arlo` / `arlo`, and that is a **known password on a shipped build**.
 * It is defensible only because of what surrounds it: the port publishes to loopback, the
 * app says so on every page until it is changed, and signing in is rate-limited so the
 * default cannot be found by grinding from somewhere else on the network. It is not a
 * substitute for a proxy that authenticates, and the README says so too.
 *
 * ---------------------------------------------------------------- one shape, two eras
 *
 * `requireSession()` is called from roughly 150 places, almost all of them only to get a
 * `workspaceId`. The `Session` shape has now outlived a hosted identity provider, no auth at
 * all, and the local password that replaced them, without any of those callers changing —
 * which is the whole reason it is worth keeping the shape stable through a change like this.
 *
 * `withWorkspace()` in src/server.ts still opens the tenant scope from the session it is
 * handed, and row-level security still governs every tenant table — a query that forgets
 * its scope reads zero rows rather than somebody else's, and test/rls.test.js proves it.
 */

const COOKIE = 'arlo_session'
const DAYS = 30

// ---------------------------------------------------------------- passwords

/**
 * scrypt, salt and hash in one column.
 *
 * Node's own `crypto`, so there is no dependency to add and nothing to keep patched. The
 * work factor is scrypt's default, which is deliberately slow — that is the point of it.
 */
const hash = (password: string, salt = randomBytes(16).toString('hex')) =>
  `${salt}:${scryptSync(password, salt, 64).toString('hex')}`

const verify = (password: string, stored: string) => {
  const [salt, key] = stored.split(':')
  if (!salt || !key) return false
  const a = Buffer.from(key, 'hex')
  const b = scryptSync(password, salt, 64)
  // timingSafeEqual throws on a length mismatch, which is itself a leak-free "no".
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---------------------------------------------------------------- workspaces

export type Workspace = { id: number; name: string; ingest_token: string; created_at: string }

const token = () => randomBytes(32).toString('base64url')

/**
 * A new workspace, and the few things it cannot be useful without.
 *
 * All of it on one connection in one transaction, which is not a detail.
 *
 * It used to insert the workspace, then open a *separate* scope to seed it — and
 * `withWorkspace` checks out its own connection rather than joining the caller's. So the seed
 * ran somewhere that could not necessarily see the row it was seeding, and the first insert
 * that referenced it died on
 * "insert or update on table web_widgets violates foreign key constraint". Worse than the
 * error: the workspace row itself had already committed, so the failure left a workspace with
 * no widget, no knowledge bases and no board — one that looks real on the list and does
 * nothing.
 *
 * `asSystem` rather than `withWorkspace` because there is genuinely no workspace yet — this
 * is the call that makes one, so there is nothing for RLS to scope to until it returns. Every
 * insert below names its workspace explicitly and none of them reads `app_workspace()`.
 */
export async function createWorkspace(name: string, ownerId: number) {
  return asSystem(async () => {
    const id = await insert(
      `INSERT INTO workspaces (name, ingest_token) VALUES (?, ?)`,
      name.trim() || 'Untitled workspace',
      token(),
    )
    await join(ownerId, id, 'owner')
    // The one channel that needs nothing from anybody else, so a new workspace has a
    // working snippet to paste before it has connected a thing. More on Connectors.
    await web.add(id, 'Website')

    /*
     * Somewhere to put knowledge, before anybody has any.
     *
     * Empty categories rather than one empty heap: the hard part of setting this up is not
     * uploading a file, it is knowing what to upload, and a row that says "Policies —
     * returns, refunds, warranty" is a question somebody can answer.
     */
    await bases.seed(id)

    // Same reason again: a date somebody teaches the bot, or a customer asks about, needs
    // somewhere to land before anybody has thought to make a calendar for it.
    await catalogue.defaultCalendar(id)

    /*
     * Deliberately no chatbot.
     *
     * There used to be one called Arlo, connected to the customer-facing bases, so the
     * widget snippet worked the moment it was pasted. The cost of that convenience is a bot
     * nobody decided to have: it carries the product's name rather than the company's, it is
     * pointed at bases somebody else chose, and it starts answering strangers before anyone
     * has read a word of what it will say. A workspace that has not made a chatbot has not
     * agreed to have one talking.
     *
     * Nothing breaks in the meantime. `routeTo` only ever returns an explicitly assigned
     * bot, so an unassigned widget files the question and waits for a person — which is
     * exactly what should happen until somebody sets one up.
     */

    return id
  })
}

export const join = (userId: number, workspaceId: number, role = 'member') =>
  run(
    `INSERT INTO memberships (user_id, workspace_id, role) VALUES (?,?,?) ON CONFLICT DO NOTHING`,
    userId,
    workspaceId,
    role,
  )

/**
 * What the Settings page shows: which provider, and whether a key is already on file.
 * Never the key itself.
 *
 * `hasKey` has to answer the same question `resolveProvider` in `llm.ts` does, which is
 * "will a question get answered", not "is there a row in this column". Those came apart on
 * a rebuilt container: `.env` is bind-mounted and the volume is not, so a key saved before
 * the rebuild still answers every question while the database column is empty. Settings
 * said to paste a key that was already working.
 *
 * `fromEnv` is the difference between the two, and the page says so rather than claiming
 * the environment copy was "saved encrypted here" — it was not, and Save is what makes it so.
 */
export async function providerSettings(
  workspaceId: number,
): Promise<{ provider: 'default' | 'autobricks'; hasKey: boolean; fromEnv: boolean }> {
  const ws = await one<{ llm_provider: string; autobricks_key_enc: string | null }>(
    `SELECT llm_provider, autobricks_key_enc FROM workspaces WHERE id = ?`,
    workspaceId,
  )
  const stored = !!ws?.autobricks_key_enc
  const inEnv = !!process.env.AUTOBRICKS_API_KEY
  return {
    provider: ws?.llm_provider === 'autobricks' || inEnv ? 'autobricks' : 'default',
    hasKey: stored || inEnv,
    fromEnv: !stored && inEnv,
  }
}

/**
 * Save the Autobricks key.
 *
 * Two places, deliberately. The database copy is encrypted with SECRET_KEY and is what
 * `llm.ts` reads on every call. The `.env` copy is what survives `docker compose down -v`,
 * and what somebody looking at their own configuration expects to find — a key that existed
 * only inside a volume would vanish with the volume and take every bot with it.
 *
 * The cost of the second copy, said plainly: the key is then in plaintext on disk. That is
 * the same file already holding the database passwords, on a machine whose owner is the only
 * account — but it is a real difference from encrypted-at-rest, and the reason `.env` is
 * gitignored twice over.
 */
export async function setProvider(workspaceId: number, autobricksKey: string) {
  const key = autobricksKey.trim()
  if (!key) throw new Error('Paste a key')
  await run(
    `UPDATE workspaces SET llm_provider = 'autobricks', autobricks_key_enc = ? WHERE id = ?`,
    seal(key),
    workspaceId,
  )
  await writeEnv('AUTOBRICKS_API_KEY', key)
}

// ---------------------------------------------------------------- the account

const normalise = (email: string) => email.trim().toLowerCase()


/**
 * Make an account and the workspace that belongs to it.
 *
 * Kept exported, and kept at this exact signature, because the test suite uses it in 27
 * files to get a workspace without standing anything up. `auth_user_id` still carries a
 * uuid: the column outlived the identity provider it was added for, and defaulting it here
 * costs nothing while dropping it would mean a migration and 27 files' worth of churn.
 *
 * The password is optional because most of those 27 callers only want a workspace to put
 * rows in, and never sign in as anybody.
 */
export async function provisionUser(email: string, authUserId: string = randomUUID(), password?: string) {
  const e = normalise(email)
  const userId = await insert(
    `INSERT INTO users (email, auth_user_id, password_hash) VALUES (?,?,?)`,
    e,
    authUserId,
    password ? hash(password) : null,
  )
  const workspaceId = await createWorkspace(`${e.split('@')[0]}'s workspace`, userId)
  return { userId, workspaceId }
}

/**
 * Whether the instance is still on the credential it shipped with.
 *
 * Read by the boot notice, by the banner in the app, and by the sign-in form to decide
 * whether to print the default. A password everybody knows is only survivable while
 * somebody is being told about it.
 *
 * **No account yet counts as true.** The account is not written until the first sign-in
 * attempt, so a genuinely fresh install has an empty `users` table — and that is precisely
 * the moment somebody is staring at a password box nobody has given them a password for.
 * Reading the row alone answered "false" there, which hid the hint exactly when it was the
 * only thing on screen worth saying.
 */
export async function usingDefaultPassword() {
  const row = await one<{ password_hash: string | null }>(
    `SELECT password_hash FROM users ORDER BY id LIMIT 1`,
  )
  if (!row) return true
  return !!row.password_hash && verify(DEFAULT_PASSWORD, row.password_hash)
}

/**
 * Change either credential, or both. The current password is required for either.
 *
 * Checked here rather than trusted from the page: a server function is reachable by POST
 * without the settings page ever having rendered, so "they were already signed in" is not
 * the same as "they know the password".
 */
export async function changeCredentials(
  userId: number,
  currentPassword: string,
  next: { username?: string; password?: string },
) {
  const row = await one<{ password_hash: string | null }>(`SELECT password_hash FROM users WHERE id = ?`, userId)
  if (!row?.password_hash || !verify(currentPassword, row.password_hash))
    throw new Error('That is not the current password')

  const username = next.username?.trim().toLowerCase()
  if (username !== undefined && username !== '') {
    if (username.length < 2) throw new Error('A username needs at least two characters')
    if (await one(`SELECT 1 FROM users WHERE lower(email) = ? AND id <> ?`, username, userId))
      throw new Error('That username is taken')
    await run(`UPDATE users SET email = ? WHERE id = ?`, username, userId)
  }

  if (next.password !== undefined && next.password !== '') {
    if (next.password.length < 4) throw new Error('Use at least four characters')
    await run(`UPDATE users SET password_hash = ? WHERE id = ?`, hash(next.password), userId)
    // Every other session is now one somebody signed into with the old password.
    await run(`DELETE FROM sessions WHERE user_id = ?`, userId)
  }
}

// ---------------------------------------------------------------- sessions

/**
 * Behind a reverse proxy the request this process sees is plain http on a loopback port,
 * however the browser reached us — so deciding from `url.protocol` alone would get this
 * wrong on an https site. Trust the proxy's header first.
 *
 * Nothing here rides on it any more now that there are no session cookies; it is what
 * src/server.ts uses to decide whether promising HSTS makes sense.
 */
export function secureCookies(request: Request) {
  const proto =
    request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || new URL(request.url).protocol.slice(0, -1)
  return proto === 'https'
}

export type Session = {
  userId: number
  workspaceId: number
  email: string
  workspaceName: string
  /** This workspace's webhook secret, shown on the channels page. */
  ingestToken: string
  /** Always true here: the person running this instance is the only person in it. */
  isAdmin: boolean
}

const expiry = () => new Date(Date.now() + DAYS * 864e5).toISOString()

function setCookie(value: string | null) {
  const request = getRequest()
  const secure = secureCookies(request) ? '; Secure' : ''
  setResponseHeader(
    'set-cookie',
    value
      ? `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${secure}`
      : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  )
}

const readCookie = (request: Request) =>
  request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === COOKIE)?.[1] ?? null

/**
 * The account and its workspace, made on first use.
 *
 * Here rather than in the migration because a workspace is not just a row: `createWorkspace`
 * seeds the web widget, the knowledge bases and the default calendar, and SQL cannot call
 * any of that.
 *
 * ponytail: one in-process guard, so the first two requests of a fresh install do not both
 * try to create it. Two cluster workers could still race; the loser leaves an unused row
 * rather than a split brain, because everything below picks the lowest id. A Postgres
 * advisory lock (see singleton.ts) if that ever actually happens.
 */
let bootstrap: Promise<unknown> | null = null

async function theAccount() {
  const found = () => one<{ id: number }>(`SELECT id FROM users ORDER BY id LIMIT 1`)
  let row = await found()
  if (!row) {
    await (bootstrap ??= provisionUser(DEFAULT_USER, undefined, DEFAULT_PASSWORD).finally(() => {
      bootstrap = null
    }))
    row = await found()
  }
  return row
}

/**
 * Check a username and password, and open a session if they are right.
 *
 * Rate-limited per username *and* per caller before the hash is even computed. With a
 * documented default credential that is not a nicety: it is what stops somebody who can
 * reach the port from simply trying.
 *
 * The same refusal either way. Saying which half was wrong tells somebody probing whether
 * a username exists, and on a one-account build that is the whole question.
 *
 * Returns the token rather than writing the cookie, and `startSession` below does that —
 * the same split `mintCode` and the admin functions used, and for the same reason: a
 * function that reaches for the request itself cannot be tested without faking one, and
 * this is the function most worth testing in the file.
 */
export async function signIn(username: string, password: string, ip = 'unknown') {
  const u = normalise(username)
  await enforce(`signin:${u}`, SIGN_IN, 'sign-in attempts')
  await enforce(`signin:ip:${ip}`, SIGN_IN, 'sign-in attempts')

  // Makes the account on a fresh install, so the very first sign-in has something to check.
  await theAccount()

  const row = await one<{ id: number; password_hash: string | null }>(
    `SELECT id, password_hash FROM users WHERE lower(email) = ?`,
    u,
  )
  if (!row?.password_hash || !verify(password, row.password_hash)) throw new Error('Wrong username or password')

  const member = await one<{ workspace_id: number }>(
    `SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY workspace_id LIMIT 1`,
    row.id,
  )
  if (!member) throw new Error('That account is in no workspace')

  const token = randomBytes(32).toString('base64url')
  await run(
    `INSERT INTO sessions (token, user_id, workspace_id, expires_at) VALUES (?,?,?,?)`,
    token,
    row.id,
    member.workspace_id,
    expiry(),
  )
  return { userId: row.id, workspaceId: member.workspace_id, token }
}

/** Put the token in the browser. Separate from `signIn` because this one needs a request. */
export const startSession = (token: string) => setCookie(token)

export async function signOut() {
  const t = readCookie(getRequest())
  if (t) await run(`DELETE FROM sessions WHERE token = ?`, t)
  setCookie(null)
}

/**
 * Who this request is, or null.
 *
 * Runs on the ordinary app connection with no scope open, which works because these four
 * tables carry no RLS policy. They carry none precisely so that resolving the scope can
 * happen before there is a scope.
 */
export async function sessionFrom(request: Request): Promise<Session | null> {
  const t = readCookie(request)
  if (!t) return null

  const row = await one<{
    user_id: number
    workspace_id: number
    email: string
    workspace_name: string
    ingest_token: string
  }>(
    `SELECT s.user_id, s.workspace_id, u.email, w.name AS workspace_name, w.ingest_token
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.token = ? AND s.expires_at > now()`,
    t,
  )
  if (!row) return null

  return {
    userId: row.user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    workspaceName: row.workspace_name,
    ingestToken: row.ingest_token,
    isAdmin: true,
  }
}

/**
 * Resolve the session. Called once per request from src/server.ts.
 *
 * The request comes back untouched and the cookie list is always empty: a session is
 * started by `signIn` writing its own header, and there is no short-lived token to renew
 * mid-request. Both are kept so the one caller need not know that.
 */
export async function authenticate(
  request: Request,
): Promise<{ request: Request; session: Session | null; cookies: string[] }> {
  return { request, session: await sessionFrom(request), cookies: [] }
}

export const currentSession = () => sessionFrom(getRequest())

/** Every workspace-scoped query goes through this, so none of them can forget. */
export async function requireSession(): Promise<Session> {
  const s = await currentSession()
  if (!s) throw new Error('Not signed in')
  return s
}
/** Clears what nobody came back for. Called from the poller's sweep. */
export const purgeExpiredSessions = () => run(`DELETE FROM sessions WHERE expires_at <= now()`)
