/**
 * Signing in, and what it takes to get past it.
 *
 * The password check is the only thing standing between a stranger who can reach the port
 * and everything in here, and it ships with a published default — so the parts worth
 * proving are the refusals, not the happy path: a wrong password, an empty one, a hash that
 * has been changed underneath an open session, and the limiter that stops somebody simply
 * trying until one works.
 *
 * `signIn` writes a cookie through the request context, which these tests do not have, so
 * they call it and then read the session row directly. What is being checked is the
 * credential logic; the cookie is TanStack's to set.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('session')
// Every other file in the suite drops its schema; this one discarded the handle, so a
// run left test_session_<pid> behind in the dev database and the next run left another.
test.after(() => db_.drop())
const auth = await import('../src/server/auth.ts')
const { one, all, run } = await import('../src/server/db.ts')
const { DEFAULT_PASSWORD, DEFAULT_USER } = await import('../src/types.ts')

const userCount = async () => Number((await one(`SELECT count(*)::int AS n FROM users`)).n)

/*
 * A fresh caller every time, so the per-IP bucket never carries between tests.
 *
 * The per-*username* bucket still does, and it is only ten attempts in five minutes — which
 * is the limiter doing its job, and enough to lock this file out of its own fixture. So the
 * tests that are not about rate limiting clear the table first, and the one that is has a
 * username to itself.
 */
const attempt = (u, p) => auth.signIn(u, p, `test-${Math.random()}`)
const clearLimits = () => run(`DELETE FROM rate_limits`)

test('a fresh database makes the default account on the first attempt', async () => {
  await clearLimits()
  assert.equal(await userCount(), 0)

  await attempt(DEFAULT_USER, DEFAULT_PASSWORD)

  assert.equal(await userCount(), 1, 'one account, not one per attempt')
  const row = await one(`SELECT email FROM users ORDER BY id LIMIT 1`)
  assert.equal(row.email, DEFAULT_USER)
  assert.ok(await auth.usingDefaultPassword(), 'and it says so, so the banner can warn')
})

test('the account it made has a workspace, seeded and usable', async () => {
  await clearLimits()
  const s = await auth.sessionFrom(new Request('http://x/', { headers: {} }))
  assert.equal(s, null, 'no cookie, no session')

  // The session row signIn wrote is the proof the workspace exists and is joined.
  const row = await one(`SELECT workspace_id FROM sessions ORDER BY expires_at DESC LIMIT 1`)
  assert.ok(row.workspace_id > 0)
  const widgets = await one(`SELECT count(*)::int AS n FROM web_widgets WHERE workspace_id = ?`, row.workspace_id)
  assert.ok(Number(widgets.n) > 0, 'a workspace is not just a row — createWorkspace seeds it')
})

test('a wrong password is refused, and says nothing about which half was wrong', async () => {
  await clearLimits()
  await assert.rejects(() => attempt(DEFAULT_USER, 'not-it'), /Wrong username or password/)
  // The same sentence for a username that does not exist. On a one-account build, telling
  // the two apart is telling somebody the whole answer.
  await assert.rejects(() => attempt('nobody', 'not-it'), /Wrong username or password/)
})

test('an empty password never passes, whatever is stored', async () => {
  await clearLimits()
  await assert.rejects(() => attempt(DEFAULT_USER, ''), /Wrong username or password/)
})

test('changing the password requires the current one, and ends other sessions', async () => {
  await clearLimits()
  const user = await one(`SELECT id FROM users ORDER BY id LIMIT 1`)

  await assert.rejects(
    () => auth.changeCredentials(user.id, 'wrong', { password: 'somethingelse' }),
    /not the current password/,
  )

  const before = (await all(`SELECT token FROM sessions WHERE user_id = ?`, user.id)).length
  assert.ok(before > 0, 'there is a session to invalidate')

  await auth.changeCredentials(user.id, DEFAULT_PASSWORD, { password: 'a-better-one' })

  assert.equal(
    (await all(`SELECT token FROM sessions WHERE user_id = ?`, user.id)).length,
    0,
    'every session was started with the old password',
  )
  assert.equal(await auth.usingDefaultPassword(), false, 'and the warning stops')

  await assert.rejects(() => attempt(DEFAULT_USER, DEFAULT_PASSWORD), /Wrong username or password/)
  await attempt(DEFAULT_USER, 'a-better-one')
})

test('the username can change, and the old one stops working', async () => {
  await clearLimits()
  const user = await one(`SELECT id FROM users ORDER BY id LIMIT 1`)
  await auth.changeCredentials(user.id, 'a-better-one', { username: 'sam' })

  await attempt('sam', 'a-better-one')
  await assert.rejects(() => attempt(DEFAULT_USER, 'a-better-one'), /Wrong username or password/)
})

test('a short password is refused rather than stored', async () => {
  await clearLimits()
  const user = await one(`SELECT id FROM users ORDER BY id LIMIT 1`)
  await assert.rejects(() => auth.changeCredentials(user.id, 'a-better-one', { password: 'no' }), /four characters/)
  // Still the old one, so the refusal did not half-apply.
  await attempt('sam', 'a-better-one')
})

test('signing in is rate limited, so a published default cannot just be tried', async () => {
  await clearLimits()
  // Same caller, same username, over and over — which is exactly what guessing looks like.
  const ip = 'one-persistent-caller'
  let refused = ''
  for (let i = 0; i < 40; i++) {
    try {
      await auth.signIn('sam', 'wrong-every-time', ip)
    } catch (e) {
      refused = e.message
      if (!/Wrong username or password/.test(refused)) break
    }
  }
  assert.match(refused, /too many|try again|wait/i, `expected a rate-limit refusal, got: ${refused}`)
})

test('an expired session is not a session', async () => {
  await clearLimits()
  await attempt('sam', 'a-better-one')
  const row = await one(`SELECT token FROM sessions ORDER BY expires_at DESC LIMIT 1`)

  await one(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token = ? RETURNING token`, row.token)
  const req = new Request('http://x/', { headers: { cookie: `arlo_session=${row.token}` } })
  assert.equal(await auth.sessionFrom(req), null, 'expiry is checked on read, not only swept')

  await auth.purgeExpiredSessions()
  assert.equal(await one(`SELECT count(*)::int AS n FROM sessions WHERE token = ?`, row.token).then((r) => Number(r.n)), 0)
})

test('a valid cookie resolves to the workspace it was issued for', async () => {
  await clearLimits()
  await attempt('sam', 'a-better-one')
  const row = await one(`SELECT token, workspace_id FROM sessions ORDER BY expires_at DESC LIMIT 1`)

  const req = new Request('http://x/', { headers: { cookie: `arlo_session=${row.token}` } })
  const s = await auth.sessionFrom(req)
  assert.ok(s)
  assert.equal(s.workspaceId, row.workspace_id)
  assert.equal(s.email, 'sam')
  assert.equal(s.isAdmin, true)

  // A token nobody issued is nobody.
  const forged = new Request('http://x/', { headers: { cookie: 'arlo_session=made-up' } })
  assert.equal(await auth.sessionFrom(forged), null)
})
