/**
 * A private Postgres schema per test file.
 *
 * `create schema test_kb_1234`, put it first on the search_path, run the migrations into
 * it, and drop it at the end. Files stay independent and run in parallel against one
 * server, which is what `node --test` does by default.
 *
 * The connection is the **owner** role on purpose. Owners bypass row-level security, so
 * these tests exercise the SQL and the behaviour without every one of them having to open
 * a workspace scope first. The policies themselves are proven separately, by rls.test.js,
 * which connects as the app role and tries to get past them.
 */
import pg from 'pg'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOST = process.env.TEST_PG_URL ?? 'postgresql://arlo_owner:owner_dev@127.0.0.1:54339/arlo'
const APP = process.env.TEST_PG_APP_URL ?? 'postgresql://arlo_app:app_dev@127.0.0.1:54339/arlo'

/**
 * Call before importing any server module — they read these variables when their pool is
 * first used, and the schema has to exist by then.
 */
export async function useSchema(name) {
  const schema = `test_${name}_${process.pid}`

  const admin = new pg.Client({ connectionString: HOST })
  await admin.connect()
  await admin.query(`drop schema if exists ${schema} cascade`)
  await admin.query(`create schema ${schema}`)
  // The app role needs to reach into the schema the policies live in.
  await admin.query(`grant usage on schema ${schema} to arlo_app`)
  await admin.end()

  process.env.DATABASE_URL = HOST
  process.env.DATABASE_URL_OWNER = HOST
  process.env.DATABASE_SCHEMA = schema
  /*
   * Small pools on purpose. The suite runs a process per file, each opening an app pool
   * and an owner pool — at the default size that is well past Postgres's 100-connection
   * limit, and the file that loses the race fails for a reason that has nothing to do
   * with what it was testing.
   */
  process.env.DATABASE_POOL = '3'
  // Nothing in the tests should reach the network. Blank keys put the LLM on its refusal
  // path and retrieval on full-text search, both of which are the offline behaviour we
  // want covered anyway.
  process.env.AUTOBRICKS_API_KEY = ''
  process.env.EMBEDDINGS_KEY = ''
  /*
   * The address too, not just the keys, because embed.ts borrows the chat key when an
   * endpoint has been named: `viaOpenRouter()` is true whenever EMBEDDINGS_URL is set and
   * EMBEDDINGS_KEY is not. A dev shell that exports EMBEDDINGS_URL therefore re-arms
   * embeddings the moment a test sets OPENROUTER_API_KEY to exercise the model path —
   * agent.test.js and bot.test.js both do — and 43 tests fail on a real call to
   * OpenRouter carrying a fake key. Blanking the key here is not enough on its own.
   */
  process.env.EMBEDDINGS_URL = ''
  // OCR downloads a language model on first use and takes seconds a page. Off here, so a
  // test run never reaches the network and never reads a picture.
  process.env.OCR_LANGS = ''
  /*
   * Saving a provider key writes it back to `.env` (see src/server/envfile.ts). Pointed at a
   * throwaway path here, because it otherwise rewrites the developer's own file — which it
   * did, appending a commented line for every key any test ever saved, seventy of them in one
   * run. Tests must not edit the config of the machine they run on.
   */
  process.env.ENV_FILE = join(tmpdir(), `arlo-test-${process.pid}.env`)
  /*
   * No file store, so the suite keeps its files in Postgres and never writes to disk.
   *
   * This is the same state the tests were written against, when the store was object storage
   * nobody had keys for -- `storageConfigured()` false, the sweeps no-ops, `addFile` keeping
   * bytes in the column. What changed is only that the store is now a directory and therefore
   * always *available*, which would quietly turn a dozen tests about the degrade path into
   * tests of the happy one, and leave files under the repo while doing it.
   *
   * `storage.test.js` sets its own temporary root and covers the store itself.
   */
  process.env.MEDIA_DIR = ''

  const { migrate, close } = await import('../src/server/db.ts')
  await migrate()

  return {
    schema,
    /** The app role's connection string, for the tests that must be subject to RLS. */
    appUrl: APP,
    async drop() {
      await close()
      const c = new pg.Client({ connectionString: HOST })
      await c.connect()
      await c.query(`drop schema if exists ${schema} cascade`)
      await c.end()
    },
  }
}
