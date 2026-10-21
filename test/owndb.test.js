/**
 * Refusing to run against another Arlo's database.
 *
 * Desktop brings its own. Where somebody points it is their business; whose it is, is not.
 * The check is arithmetic on two lists -- the migrations applied here, and the migrations this
 * build ships -- so it is testable without any other Arlo being present: a row in
 * `schema_migrations` naming a file this build does not have is exactly what a foreign
 * database looks like from the inside.
 *
 * The real shape it defends against, measured on the live pair: Cloud has 98 applied starting
 * `001_identity.sql` and no `001_schema.sql`; Desktop has 12 and its baseline *is*
 * `001_schema.sql`. So every name differs, not merely the count.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('owndb')
const { assertOwnDatabase, asSystem, run } = await import('../src/server/db.ts')
test.after(() => db_.drop())

test('a database this build migrated is accepted', async () => {
  // useSchema() has already run every migration this build ships into this schema.
  await assertOwnDatabase()
})

test('a ledger naming migrations this build does not ship is refused', async () => {
  await asSystem(() => run(`INSERT INTO schema_migrations (name) VALUES ('001_identity.sql')`))
  await assert.rejects(() => assertOwnDatabase(), /built by a different Arlo/)

  // And it says what it found, so somebody can act on it rather than guess.
  const why = await assertOwnDatabase().catch((e) => e.message)
  assert.match(why, /001_identity\.sql/, 'names the migration it did not recognise')
  assert.match(why, /nothing has been read or written/, 'and says the database was left alone')

  await asSystem(() => run(`DELETE FROM schema_migrations WHERE name = '001_identity.sql'`))
  await assertOwnDatabase() // back to ours, accepted again
})

test('it counts them rather than stopping at the first', async () => {
  const strangers = ['001_identity.sql', '002_grants.sql', '003_kb.sql', '004_graph.sql', '005_crm.sql', '006_x.sql']
  for (const name of strangers) await asSystem(() => run(`INSERT INTO schema_migrations (name) VALUES (?)`, name))

  const why = await assertOwnDatabase().catch((e) => e.message)
  assert.match(why, /6 of its \d+ applied migrations/, 'reports how many disagreed')
  assert.match(why, /and 1 more/, 'shows the first five and counts the rest')

  for (const name of strangers) await asSystem(() => run(`DELETE FROM schema_migrations WHERE name = ?`, name))
})

/*
 * The two states that must NOT refuse, because refusing them would break a first boot and
 * every test run respectively.
 */
test('an empty ledger is a first boot, not a foreign database', async () => {
  const kept = await asSystem(() => run(`CREATE TEMP TABLE kept AS SELECT * FROM schema_migrations`))
  void kept
  await asSystem(() => run(`DELETE FROM schema_migrations`))
  await assertOwnDatabase()
  await asSystem(() => run(`INSERT INTO schema_migrations (name, applied_at) SELECT name, applied_at FROM kept`))
  await assertOwnDatabase()
})

test('a schema with no ledger at all is a first boot too', async () => {
  // What `migrate()` sees before it has created anything: to_regclass answers null and the
  // check gets out of the way rather than throwing on a missing table.
  const bare = `test_owndb_bare_${process.pid}`
  await asSystem(() => run(`CREATE SCHEMA IF NOT EXISTS ${bare}`))
  const was = process.env.DATABASE_SCHEMA
  process.env.DATABASE_SCHEMA = bare
  try {
    await assertOwnDatabase()
  } finally {
    process.env.DATABASE_SCHEMA = was
    await asSystem(() => run(`DROP SCHEMA IF EXISTS ${bare} CASCADE`))
  }
})
