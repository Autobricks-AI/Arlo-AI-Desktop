/**
 * Apply any migrations that have not run yet.
 *
 *   npm run migrate
 *
 * The server does this at boot too, so this is for running it deliberately, before a
 * deploy, or to check what a new checkout would apply. Connects as DATABASE_URL_OWNER,
 * because the app role is not allowed to create tables.
 */
import { migrate, close } from '../src/server/db.ts'

try {
  const applied = await migrate()
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date')
} catch (e) {
  console.error('migration failed:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await close()
}
