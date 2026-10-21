/**
 * The query layer.
 *
 * Every read and write in the app goes through these calls. Postgres underneath, five
 * statement helpers over it, and one place that decides which tenant a query can see.
 *
 * What each call hides, and why it is a function rather than a line of SQL:
 *
 *   one/all/run   the statement. `?` placeholders are rewritten to $1..$n here, so the
 *                 SQL in the modules stays in one dialect wherever it was written.
 *   insert        `RETURNING id`, which is how Postgres answers "what id did that get".
 *   tx            BEGIN/COMMIT, which in Postgres must happen on one pinned connection.
 *
 * ---------------------------------------------------------------- the tenant boundary
 *
 * Row-level security decides what a query can see from `app.workspace_id`, a setting that
 * lives on the *connection*. A pool hands out a different connection per query, so the
 * scope has to be pinned for the length of a request — `withWorkspace()` checks out one
 * client, opens a transaction, sets the scope, and parks the client in AsyncLocalStorage
 * so that `one/all/run` find it without any call site passing it along.
 *
 * The safety property worth stating plainly: **a query outside any scope returns nothing.**
 * `current_setting('app.workspace_id', true)` is NULL when unset, `workspace_id = NULL` is
 * never true, and Postgres default-denies a table with RLS on and no matching policy. A
 * forgotten scope is an empty list, never another company's knowledge base.
 *
 * `asSystem()` is the deliberate exception, on a connection owned by the role that owns
 * the tables — owners bypass RLS. It exists for the places that genuinely have no
 * workspace yet: resolving a session, and a webhook working out which bot was called.
 * Every call site carries a comment saying which.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import fs from 'node:fs'

const { Pool, types } = pg

/*
 * Both of these come back as strings otherwise, and both fail silently: a numeric would
 * start concatenating instead of adding, and a bigint id would stop matching itself.
 */
types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v))) // numeric
types.setTypeParser(20, (v) => (v === null ? null : Number(v))) // int8

/*
 * Dates and times come back as text, because that is what every type in this app says they
 * are.
 *
 * Left alone, node-postgres hands back a JS Date. Every row type here declares these columns
 * as `string`, and tsc cannot catch the difference because the types are hand-written — so
 * the mismatch survives all the way to the browser, where the calendar page did
 * `entry.at.slice(0, 10)` and died with 'slice is not a function' the first time a board
 * actually had an entry in view.
 *
 * A plain date is worse than merely mistyped. Postgres sends '2026-08-24'; the driver reads
 * it in the server's zone, so east of UTC it becomes the 23rd at 16:00 and every date on
 * screen is a day early. catalogue.ts already writes `starts_on::text` on every query to
 * dodge exactly this, which is the workaround this replaces — one that every new query has
 * to remember.
 *
 * Timestamps are normalised to ISO rather than passed through as Postgres' own
 * space-separated text, because that is the shape the browser already received back when
 * these were Dates and JSON.stringify called toJSON on them. Nothing downstream changes.
 */
types.setTypeParser(1082, (v) => v) // date — the calendar day, as written
types.setTypeParser(1114, (v) => v) // timestamp, no zone to apply
types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString())) // timestamptz

/** Verify the server's certificate when a CA is supplied; refuse to guess otherwise. */
export function ssl() {
  const ca = process.env.DATABASE_CA_CERT
  if (ca) return { ca: fs.existsSync(ca) ? fs.readFileSync(ca, 'utf8') : ca, rejectUnauthorized: true }
  // The database container talks to the app over Compose's private network and nothing else
  // can reach it, so plaintext there is fine. A Postgres anywhere else should be carrying a
  // CA — see docs/DEPLOY.md.
  return false as const
}

const url = () => process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
/** The owner role. Only asSystem() and migrate() use it; falls back to the app role locally. */
const systemUrl = () => process.env.DATABASE_URL_OWNER ?? url()

/** Tests point every connection at their own schema so files cannot see each other. */
export const schema = () => process.env.DATABASE_SCHEMA ?? 'public'

const makePool = (connectionString: string) => {
  const p = new Pool({
    connectionString,
    ssl: ssl(),
    max: Number(process.env.DATABASE_POOL ?? 10),
    /*
     * search_path is set as part of establishing the connection, not afterwards. Doing it
     * in a `connect` handler races the first real query — pg does not await event
     * listeners — and a query that wins that race runs against the default path.
     *
     * `public` trails our own schema because that is where a locally-installed `vector`
     * type lands. Our tables always resolve first, so a test schema still cannot fall
     * through to a same-named table in public: the migrations just created every one of
     * them in the test schema.
     *
     * `extensions` trails both because some hosted Postgres keeps pgvector there, and every
     * `vector(1536)` in migrations/ is unqualified. Without it those migrations fail with
     * `type "vector" does not exist`, which reads like a missing extension and is not — it
     * is a missing schema on the path.
     *
     * This is a startup parameter, which is also why a *transaction* pooler cannot be used:
     * it does not carry `options` through, so the path would silently be wrong rather than
     * loudly absent. A session pooler or a direct connection both carry it.
     */
    options: `-c search_path=${schema()},public,extensions`,
  })
  // A pool that throws on an idle client's error takes the process with it.
  p.on('error', (e) => console.error('[db] idle client error:', e.message))
  return p
}

let pool: pg.Pool | null = null
let systemPool: pg.Pool | null = null
const appPool = () => (pool ??= makePool(url()))
/**
 * The owner connection. When it is the same credentials as the app's — which is the case
 * locally and in the tests — it is the same pool, because two pools to one role is just
 * twice the connections. In production they differ and stay apart, which is the point.
 */
const ownerPool = () => (systemUrl() === url() ? appPool() : (systemPool ??= makePool(systemUrl())))

type Scope = { client: pg.PoolClient }
const als = new AsyncLocalStorage<Scope>()

/**
 * `?` to `$1..$n`, leaving anything inside a string literal or a comment alone.
 *
 * Comments are skipped for the same reason literals are, and the reason is an apostrophe: a
 * `-- refuses a stage from somebody else's board` opened a quote that never closed, so every
 * `?` after it was left as a literal `?` and the statement failed on the next keyword. The
 * query is written by us and the comment is prose — prose has apostrophes in it.
 */
const positional = (sql: string) => {
  let out = ''
  let n = 0
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      out += ch
      continue
    }
    // `-- to end of line` and `/* to the matching close */`, copied through untouched.
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      out += end === -1 ? sql.slice(i) : sql.slice(i, end)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      out += end === -1 ? sql.slice(i) : sql.slice(i, end + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    out += ch === '?' ? `$${++n}` : ch
  }
  return out
}

const cache = new Map<string, string>()
const sqlOf = (sql: string) => {
  let t = cache.get(sql)
  if (t === undefined) cache.set(sql, (t = positional(sql)))
  return t
}

/**
 * Postgres `text` cannot hold a NUL byte. Not "should not" — the encoding has no
 * representation for it, and a parameter carrying one fails the whole statement with
 * `invalid byte sequence for encoding "UTF8": 0x00`.
 *
 * There is no case where a NUL in a string parameter is meant, and several where one
 * arrives by accident: a PDF whose text is really glyph numbers, a log file with a corrupt
 * region, a scraped page served as UTF-16. Dropping it here rather than at each of those
 * is the difference between one rule and an unbounded number of them — and the alternative
 * is not "cleaner data", it is a crash with the real content thrown away.
 *
 * Buffers pass through untouched: `bytea` holds NUL perfectly well, and an uploaded file
 * must come back byte-identical.
 */
const NUL = '\u0000'

const denul = (args: unknown[]) =>
  args.map((a) => (typeof a === 'string' && a.includes(NUL) ? a.replaceAll(NUL, '') : a))

/** Run against the scoped client if there is one, otherwise a pooled app connection. */
const query = async <T extends pg.QueryResultRow>(sql: string, args: unknown[]) => {
  const scope = als.getStore()
  const text = sqlOf(sql)
  const safe = denul(args)
  return scope ? scope.client.query<T>(text, safe) : appPool().query<T>(text, safe)
}

/** One row, or undefined. */
export const one = async <T>(sql: string, ...args: unknown[]): Promise<T | undefined> =>
  (await query<pg.QueryResultRow>(sql, args)).rows[0] as T | undefined

/** Every row. */
export const all = async <T>(sql: string, ...args: unknown[]): Promise<T[]> =>
  (await query<pg.QueryResultRow>(sql, args)).rows as T[]

/** A write. `changes` is how many rows it touched. */
export const run = async (sql: string, ...args: unknown[]): Promise<{ changes: number }> => ({
  changes: (await query(sql, args)).rowCount ?? 0,
})

/** A write that creates a row, returning its id. */
export const insert = async (sql: string, ...args: unknown[]): Promise<number> => {
  const text = /returning/i.test(sql) ? sql : `${sql} RETURNING id`
  const r = await query<{ id: number }>(text, args)
  return Number(r.rows[0]?.id)
}

/**
 * Run several writes as one, rolling back if any of them throws.
 *
 * Inside an existing scope this joins that transaction rather than opening a second one —
 * Postgres has no nested BEGIN, and withWorkspace() has usually opened one already.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  const scope = als.getStore()
  if (scope) return fn() // already inside withWorkspace/asSystem's transaction

  const client = await appPool().connect()
  try {
    await client.query('begin')
    const out = await als.run({ client }, fn)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** What a scope needs to know. A full Session satisfies it; a webhook builds one by hand. */
export type ScopeInput = { workspaceId: number }

/** Everything a request does, inside one transaction scoped to one workspace. */
export async function withWorkspace<T>(scope: ScopeInput, fn: () => Promise<T>): Promise<T> {
  const client = await appPool().connect()
  try {
    await client.query('begin')
    // set_config takes parameters; `set local app.x = $1` is not valid syntax, and
    // building that string by hand would be an injection site.
    await client.query(`select set_config('app.workspace_id', $1, true)`, [String(scope.workspaceId)])
    const out = await als.run({ client }, fn)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Cross-workspace access, on the owner connection, which bypasses RLS.
 *
 * For the places that genuinely have no workspace yet: resolving a session (the query
 * that decides which workspace this is), and a webhook resolving which bot was called.
 * Nothing else may use it, and every call site says which case it is.
 */
export async function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  const client = await ownerPool().connect()
  try {
    await client.query('begin')
    const out = await als.run({ client }, fn)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * A connection from the app pool, checked out and handed over rather than auto-released.
 *
 * Every other export here returns to the pool the moment a query finishes. This is for the
 * one caller that cannot work that way: a session-scoped advisory lock has to sit on the
 * same backend connection for as long as it is held, which for `tryOwnLiveSingletons()` in
 * `singleton.ts` is the process's whole life. The caller owns release/destroy from here.
 */
export const rawClient = () => appPool().connect()

/** Did this write collide with a unique index? By error code, never by message. */
export const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === '23505'

// ---------------------------------------------------------------- migrations

/**
 * Refuse to run against a database this build did not build.
 *
 * Arlo brings its own database. Where you point it is your business -- the container in
 * docker-compose.yml, Postgres on your NAS, a managed instance you pay for -- but it has to be
 * *yours*. The case this exists for is a connection string copied out of the wrong .env: a
 * build that ships a different schema starts applying its migrations to a database somebody
 * else's install is using, and neither side can tell until something is already broken.
 *
 * The test needs no configuration and no list of known hosts:
 *
 *     every migration already applied must be one this build ships
 *
 * Which resolves by itself in all three states. A database with nothing applied is a first
 * boot and proceeds. A database this build made has only names it ships and proceeds. One
 * built by a different install presents a ledger full of filenames this build has never heard
 * of, and that is not a judgement call -- it is arithmetic on two lists.
 *
 * Deliberately not a version comparison and not a whitelist of hostnames. A version check
 * needs somewhere to write the version, which is the database we are refusing to touch; a
 * hostname check would refuse the NAS and wave through anything reached down a tunnel.
 * The migration ledger is already there, already authoritative about which build wrote this
 * schema, and already read at boot.
 *
 * Reads one table and writes nothing, so a refusal leaves the database exactly as it was.
 */
export async function assertOwnDatabase(dir = 'migrations') {
  const client = await ownerPool().connect()
  try {
    await client.query(`set search_path to ${schema()}, public`)

    /*
     * to_regclass rather than catching the error: a missing table here is the ordinary first
     * boot, and `migrate()` is about to create it. Only a *populated* ledger can disagree
     * with us.
     */
    const present = await client.query<{ ok: boolean }>(`select to_regclass('schema_migrations') is not null as ok`)
    if (!present.rows[0]?.ok) return

    const applied = (await client.query<{ name: string }>(`select name from schema_migrations order by name`)).rows.map(
      (r) => r.name,
    )
    if (!applied.length) return

    const ours = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.sql')))
    const strangers = applied.filter((name) => !ours.has(name))
    if (!strangers.length) return

    const shown = strangers.slice(0, 5).join(', ')
    const more = strangers.length > 5 ? `, and ${strangers.length - 5} more` : ''
    throw new Error(
      `This database was built by a different Arlo than this one, so nothing has been read or written.\n\n` +
        `  ${strangers.length} of its ${applied.length} applied migrations are files this build does not ship: ${shown}${more}.\n` +
        `  This build ships ${ours.size}, starting at ${[...ours].sort()[0]}.\n\n` +
        `Point DATABASE_URL and DATABASE_URL_OWNER at this install's own database -- ` +
        `docker-compose.yml starts one -- or, if this database is the right one, you are running the wrong build against it.`,
    )
  } finally {
    client.release()
  }
}

/**
 * Apply every migration that has not run yet, in filename order.
 *
 * Runs as the owner, because it creates the tables whose policies the app then cannot
 * escape. Called at boot and by the test harness — the schema is never created as a side
 * effect of importing a module.
 */
export async function migrate(dir = 'migrations') {
  const client = await ownerPool().connect()
  try {
    await client.query(`set search_path to ${schema()}, public`)
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`)
    const done = new Set(
      (await client.query<{ name: string }>(`select name from schema_migrations`)).rows.map((r) => r.name),
    )
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    const applied: string[] = []
    for (const f of files) {
      if (done.has(f)) continue
      const sql = fs.readFileSync(`${dir}/${f}`, 'utf8')
      // Each migration is its own transaction: a failure leaves the ones before it applied.
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query(`insert into schema_migrations (name) values ($1)`, [f])
        await client.query('commit')
        applied.push(f)
      } catch (e) {
        await client.query('rollback')
        throw new Error(`migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return applied
  } finally {
    client.release()
  }
}

/** Release every handle. Only the tests and a clean shutdown need this. */
export const close = async () => {
  await pool?.end().catch(() => {})
  await systemPool?.end().catch(() => {})
  pool = null
  systemPool = null
  cache.clear()
}
