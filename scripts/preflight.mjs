/**
 * Check a database and an identity provider before trusting either.
 *
 *   npm run preflight
 *
 * Read-only, and deliberately so: it runs **before** `npm run migrate`, while the database
 * is still empty and a mistake costs nothing. It creates nothing, changes nothing, and
 * every failure it reports is cheaper to fix now than after tables exist.
 *
 * What it is really checking is the handful of things that fail *quietly*: a search path
 * missing a schema, a role that bypasses row-level security, a connection that negotiated
 * no TLS, sign-up still open at the project. Each of those leaves an app that appears to
 * work.
 *
 * Nothing here prints a password or a key. The output is safe to paste.
 */
import pg from 'pg'
import { scryptSync } from 'node:crypto'
import { ssl, schema, close } from '../src/server/db.ts'

let failures = 0
let warnings = 0

const ok = (what, detail = '') => console.log(`  ok    ${what}${detail ? `: ${detail}` : ''}`)
const bad = (what, detail) => {
  failures++
  console.log(`  FAIL  ${what}${detail ? `: ${detail}` : ''}`)
}
const warn = (what, detail) => {
  warnings++
  console.log(`  warn  ${what}${detail ? `: ${detail}` : ''}`)
}
const section = (name) => console.log(`\n${name}\n${'-'.repeat(name.length)}`)

/** Host and user only. Never the password, so this output can be shared. */
function describe(url) {
  try {
    const u = new URL(url)
    return `${u.username}@${u.hostname}:${u.port || 5432}${u.pathname}`
  } catch {
    return '(unparseable)'
  }
}

const connect = async (url, label) => {
  const client = new pg.Client({ connectionString: url, ssl: ssl(), options: `-c search_path=${schema()},public,extensions` })
  try {
    await client.connect()
    return client
  } catch (e) {
    bad(`connect as ${label}`, e.message)
    return null
  }
}

// ---------------------------------------------------------------- the environment

section('Environment')

const required = ['DATABASE_URL', 'DATABASE_URL_OWNER', 'DATABASE_SCHEMA']
for (const key of required) {
  if (process.env[key]) ok(key)
  else bad(key, 'not set')
}

if (process.env.DATABASE_CA_CERT) ok('DATABASE_CA_CERT')
else
  bad(
    'DATABASE_CA_CERT',
    'not set: the driver connects with NO TLS at all, which is fine on loopback and not anywhere else',
  )

if (process.env.PUBLIC_URL) ok('PUBLIC_URL', process.env.PUBLIC_URL)
else warn('PUBLIC_URL', 'not set: widget snippets and webhook addresses fall back to the request host')

/*
 * Pool sizing, said out loud rather than left to be discovered under load.
 *
 * The number is per pool, and there are two of them (app and owner) in every process:
 * the cluster parent plus each web worker. Nothing enforces the total, and the default of
 * 10 is a per-process figure from before this app forked workers, so on a four-worker box
 * it quietly asks for eighty server-side connections.
 */
const perPool = Number(process.env.DATABASE_POOL ?? 10)
const workers = Number(process.env.WEB_WORKERS ?? 0)
const processes = 1 + workers // the parent serves nothing but holds pools of its own
const ceiling = perPool * 2 * processes
const how = process.env.DATABASE_POOL ? `${perPool} per pool` : `${perPool} per pool (defaulted, not set)`
const shape = `${perPool} x 2 roles x ${processes} process${processes === 1 ? '' : 'es'} = up to ${ceiling}`

if (!process.env.DATABASE_POOL) warn('DATABASE_POOL', `${how}; ${shape}`)
else if (ceiling > 60) warn('DATABASE_POOL', `${how}; ${shape}: check this against the pooler's own limit`)
else ok('DATABASE_POOL', `${how}; ${shape}`)

// ---------------------------------------------------------------- the URLs themselves

section('Connection strings')

const appUrl = process.env.DATABASE_URL ?? ''
const ownerUrl = process.env.DATABASE_URL_OWNER ?? ''

console.log(`  app   ${describe(appUrl)}`)
console.log(`  owner ${describe(ownerUrl)}\n`)

for (const [url, label] of [
  [appUrl, 'app'],
  [ownerUrl, 'owner'],
]) {
  let u
  try {
    u = new URL(url)
  } catch {
    continue
  }

  // A pooler in *transaction* mode voids the transaction-local set_config the tenant scope
  // uses, and drops the `options` that carry the schema. Both fail silently, so the common
  // transaction-mode ports are worth naming rather than diagnosing later.
  if (['6543', '6432'].includes(u.port))
    bad(`${label} port`, `${u.port} is usually a transaction pooler: use a session pooler or a direct connection`)
  else ok(`${label} port`, u.port || '5432')

  // A superuser silently voids every policy in the migrations. The authoritative check is
  // rolsuper/rolbypassrls below; this one catches it before a connection is even opened.
  const role = decodeURIComponent(u.username).split('.')[0]
  if (role === 'postgres')
    bad(`${label} role`, `${role} bypasses row-level security: this must be arlo_app / arlo_owner`)
  else ok(`${label} role`, role)
}

if (appUrl && appUrl === ownerUrl)
  warn('two roles', 'app and owner are the same connection: the owner bypasses RLS, so this is dev-only')
else if (appUrl && ownerUrl) ok('two roles', 'app and owner are separate')

// ---------------------------------------------------------------- the database

section('Database')

const app = appUrl ? await connect(appUrl, 'arlo_app') : null
const owner = ownerUrl ? await connect(ownerUrl, 'arlo_owner') : null

if (app) {
  const { rows } = await app.query('select current_user, current_database(), version()')
  ok('connected as app', `${rows[0].current_user} on ${rows[0].current_database}`)
  console.log(`        ${rows[0].version.split(',')[0]}`)

  // Encryption, asked of the server rather than assumed from the config.
  try {
    const tls = await app.query('select ssl, version from pg_stat_ssl where pid = pg_backend_pid()')
    if (tls.rows[0]?.ssl) ok('TLS', tls.rows[0].version)
    else bad('TLS', 'this connection is NOT encrypted')
  } catch {
    warn('TLS', 'pg_stat_ssl not readable here; could not confirm')
  }

  const path = await app.query('show search_path')
  ok('search_path', path.rows[0].search_path)

  // ------------------------------------------------ roles
  const roles = await app.query(
    `select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('arlo_app','arlo_owner') order by rolname`,
  )
  if (!roles.rows.length) bad('roles', 'neither arlo_app nor arlo_owner exists: setup/00-roles.sql has not run')
  for (const r of roles.rows) {
    if (r.rolsuper || r.rolbypassrls)
      bad(`role ${r.rolname}`, `superuser=${r.rolsuper} bypassrls=${r.rolbypassrls}: every policy would be void`)
    else ok(`role ${r.rolname}`, 'not superuser, does not bypass RLS')
  }

  // ------------------------------------------------ the schema
  const ns = await app.query(`select nspname, nspowner::regrole::text as owner from pg_namespace where nspname = $1`, [
    schema(),
  ])
  if (!ns.rows.length) bad(`schema ${schema()}`, 'does not exist: setup/00-roles.sql has not run')
  else {
    ok(`schema ${schema()}`, `owned by ${ns.rows[0].owner}`)
    const priv = await app.query(
      `select has_schema_privilege('arlo_owner', $1, 'CREATE') as owner_create,
              has_schema_privilege('arlo_app',   $1, 'CREATE') as app_create,
              has_schema_privilege('arlo_app',   $1, 'USAGE')  as app_usage`,
      [schema()],
    )
    const p = priv.rows[0]
    p.owner_create ? ok('owner may create tables') : bad('owner may create tables', 'migrations will fail')
    p.app_usage ? ok('app may use the schema') : bad('app may use the schema', 'every query will fail')
    p.app_create
      ? bad('app may NOT create tables', 'it can: the app role has DDL rights it should not have')
      : ok('app may NOT create tables')
  }

  // ------------------------------------------------ pgvector, the Arlo-specific one
  const ext = await app.query(`select extnamespace::regnamespace::text as schema from pg_extension where extname='vector'`)
  if (!ext.rows.length) bad('pgvector', 'not installed: run `create extension vector;` as postgres')
  else {
    ok('pgvector installed in', ext.rows[0].schema)
    try {
      // The check that matters: every vector(1536) in migrations/ is unqualified, so this
      // is what says the type resolves through the search path the app actually connects with.
      await app.query(`select '[1,2,3]'::vector`)
      ok('vector type resolves', 'through the app connection')
    } catch (e) {
      bad('vector type resolves', `${e.message}: add its schema to options in src/server/db.ts`)
    }
  }

  // ------------------------------------------------ what migrate would do
  const applied = await app
    .query(`select count(*)::int as n from schema_migrations`)
    .then((r) => r.rows[0].n)
    .catch(() => null)
  if (applied === null) ok('migrations', 'none applied yet: this is a fresh database')
  else ok('migrations', `${applied} already applied`)

  const tables = await app.query(`select count(*)::int as n from pg_tables where schemaname = $1`, [schema()])
  console.log(`        ${tables.rows[0].n} table(s) in ${schema()}`)

  /*
   * What is actually open, rather than what the arithmetic above allows. Behind a pooler
   * these are the pooler's own server-side connections, so the number is what the database
   * sees from every process at once: the honest version of the ceiling.
   */
  try {
    const live = await app.query(
      `select count(*)::int as total,
              count(*) filter (where state = 'active')::int as active,
              count(*) filter (where state = 'idle in transaction')::int as in_tx
         from pg_stat_activity where usename in ('arlo_app','arlo_owner')`,
    )
    const l = live.rows[0]
    console.log(`        ${l.total} connection(s) open now: ${l.active} active, ${l.in_tx} idle in transaction`)
    // Held-open transactions are the shape of the problem worth catching: every request
    // keeps one for the length of its render, so a stuck one pins a connection for good.
    if (l.in_tx > 2) warn('idle in transaction', `${l.in_tx}: a request is holding a transaction open`)
  } catch {
    warn('connection count', 'pg_stat_activity not readable through this connection')
  }
}

if (owner && ownerUrl !== appUrl) {
  const { rows } = await owner.query('select current_user')
  ok('connected as owner', rows[0].current_user)
}

// ---------------------------------------------------------------- identity

section('Sign-in')

/*
 * One account, one password, kept in this database: see src/server/auth.ts. So there are
 * two questions worth asking here, and neither of them is about a provider: is the port
 * private, and is the password still the one in the README?
 */
const host = process.env.HOST ?? '127.0.0.1'
if (['127.0.0.1', 'localhost', '::1'].includes(host)) ok('reachable from', `${host} only`)
else
  warn(
    'HOST',
    `${host}: reachable beyond this machine. There is one account and no roles, so put something in front of it that authenticates.`,
  )

try {
  if (!owner) throw new Error('no owner connection')
  const { rows } = await owner.query(`select password_hash from ${schema()}.users order by id limit 1`)
  const stored = rows[0]?.password_hash
  if (!stored) warn('password', 'no account yet: it is created, with the default password, on the first sign-in')
  else {
    // The same scrypt check auth.ts makes, so this cannot drift from it.
    const [salt, key] = stored.split(':')
    const same = salt && key && scryptSync('arlo', salt, 64).toString('hex') === key
    if (same) bad('password', 'still the default (arlo/arlo), which is published in the README. Change it in Settings.')
    else ok('password', 'changed from the default')
  }
} catch (e) {
  warn('password', `could not check: ${e.message}`)
}

// ----------------------------------------------------------------

section('Result')

for (const c of [app, owner]) if (c) await c.end().catch(() => {})
await close().catch(() => {})

if (failures) {
  console.log(`\n  ${failures} failure(s), ${warnings} warning(s). Fix the failures before running migrate.\n`)
  process.exitCode = 1
} else {
  console.log(`\n  All checks passed${warnings ? `, ${warnings} warning(s)` : ''}. Safe to run: npm run migrate\n`)
}
