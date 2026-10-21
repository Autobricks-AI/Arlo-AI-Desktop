/**
 * The tenant boundary, proved rather than assumed.
 *
 * Every other test file connects as the owner, which bypasses row-level security — that
 * is deliberate, so they can exercise behaviour without opening a scope first. This one
 * connects as `arlo_app`, the NOBYPASSRLS role the application actually uses, and tries
 * to get past the policies.
 *
 * If this file ever fails, one workspace can read another company's knowledge base. There
 * is nothing in here that is safe to relax.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'

import { useSchema } from './helper.js'
const db_ = await useSchema('rls')
const auth = await import('../src/server/auth.ts')
const kb = await import('../src/server/kb.ts')

// Two tenants, set up as the owner, each with a document of its own.
const bases = await import('../src/server/bases.ts')
const alpha = await auth.provisionUser('alpha@example.com')
const beta = await auth.provisionUser('beta@example.com')
await kb.store(alpha.workspaceId, { baseId: (await bases.first(alpha.workspaceId)).id,
  source: 'upload',
  uri: null,
  title: 'alpha handbook',
  mime: 'text/plain',
  text: 'Alpha refunds take five working days.',
})
await kb.store(beta.workspaceId, { baseId: (await bases.first(beta.workspaceId)).id,
  source: 'upload',
  uri: null,
  title: 'beta handbook',
  mime: 'text/plain',
  text: 'Beta refunds take ten working days.',
})

/** A connection as the app role, in the test schema, optionally scoped to a workspace. */
async function asApp(workspaceId) {
  const c = new pg.Client({ connectionString: db_.appUrl })
  await c.connect()
  await c.query(`set search_path to ${db_.schema}, public`)
  if (workspaceId !== undefined) await c.query(`select set_config('app.workspace_id', $1, false)`, [String(workspaceId)])
  return c
}

test.after(() => db_.drop())

test('the app role cannot bypass row-level security', async () => {
  const c = await asApp()
  const { rows } = await c.query(`select rolbypassrls from pg_roles where rolname = current_user`)
  await c.end()
  // If this is ever true, every policy below is decoration.
  assert.equal(rows[0].rolbypassrls, false)
})

test('outside any scope, a tenant table reads as empty', async () => {
  const c = await asApp()
  for (const table of ['documents', 'chunks']) {
    const { rows } = await c.query(`select count(*)::int as n from ${table}`)
    assert.equal(rows[0].n, 0, `${table} leaked outside a scope`)
  }
  await c.end()
  // This is the property the whole design rests on: a query that forgets to open a scope
  // returns nothing, rather than returning everything.
})

test('inside a scope, you see your own rows and only your own', async () => {
  const c = await asApp(alpha.workspaceId)
  const docs = await c.query(`select title from documents`)
  assert.deepEqual(
    docs.rows.map((r) => r.title),
    ['alpha handbook'],
  )

  // Naming the other workspace explicitly does not help: the policy is applied before
  // the WHERE clause is ever consulted.
  const reach = await c.query(`select count(*)::int as n from documents where workspace_id = $1`, [beta.workspaceId])
  assert.equal(reach.rows[0].n, 0)

  const chunks = await c.query(`select count(*)::int as n from chunks`)
  assert.equal(chunks.rows[0].n, 1)
  await c.end()
})

test('you cannot write a row into somebody else s workspace', async () => {
  const c = await asApp(alpha.workspaceId)
  // WITH CHECK refuses the insert: the row it would create does not belong to the scope.
  await assert.rejects(
    () =>
      c.query(
        `insert into documents (workspace_id, source, title, text, hash) values ($1, 'upload', 'planted', 'x', 'h')`,
        [beta.workspaceId],
      ),
    /row-level security/,
  )
  await c.end()
})

test('you cannot move your own row into somebody else s workspace', async () => {
  const c = await asApp(alpha.workspaceId)
  // USING lets alpha touch its own row; WITH CHECK is what stops the row leaving.
  await assert.rejects(
    () => c.query(`update documents set workspace_id = $1`, [beta.workspaceId]),
    /row-level security/,
  )
  await c.end()
})

test('you cannot delete a row you cannot see', async () => {
  const c = await asApp(alpha.workspaceId)
  const { rowCount } = await c.query(`delete from documents where workspace_id = $1`, [beta.workspaceId])
  assert.equal(rowCount, 0)
  await c.end()

  // Still there, checked as the owner.
  const { all } = await import('../src/server/db.ts')
  const left = await all(`select title from documents where workspace_id = $1`.replace('$1', String(beta.workspaceId)))
  assert.equal(left.length, 1)
})

test('the app role cannot change the rules it is bound by', async () => {
  const c = await asApp(alpha.workspaceId)
  // No DDL: it must not be able to drop a policy it finds inconvenient, or turn RLS off.
  await assert.rejects(() => c.query(`alter table documents disable row level security`), /owner|permission|must be/i)
  await assert.rejects(() => c.query(`drop policy tenant_read on documents`), /owner|permission|must be/i)
  await assert.rejects(() => c.query(`create table sneaky (id int)`), /permission/i)
  await c.end()
})
