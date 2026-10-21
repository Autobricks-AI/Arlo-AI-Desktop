/**
 * Moving files out of the database, which is the one sweep that deletes the only copy.
 *
 * `test/helper.js` blanks `MEDIA_DIR` for every other file, so `sweepMedia()` returns early
 * and had no coverage at all. This file gives it a real store instead.
 *
 * The order below is the whole trick and it is easy to get wrong. `useSchema()` is what blanks
 * the variable, and `storage.ts` reads it once into a `const` when it is first imported. So the
 * store has to be named *after* the helper has run and *before* anything imports the store --
 * setting it at the top of the file looks right and silently does nothing.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('media')

const root = await mkdtemp(join(tmpdir(), 'arlo-media-'))
process.env.MEDIA_DIR = root

const auth = await import('../src/server/auth.ts')
const files = await import('../src/server/attachments.ts')
const convo = await import('../src/server/conversations.ts')
const customers = await import('../src/server/customers.ts')
const media = await import('../src/server/media.ts')
const { all, asSystem } = await import('../src/server/db.ts')
const { getObject, putObject } = await import('../src/server/storage.ts')

test.after(async () => {
  await db_.drop()
  await rm(root, { recursive: true, force: true })
})

const ws = (await auth.provisionUser('media@example.com')).workspaceId

/** A message to hang an attachment on. */
const message = async (who) => {
  const person = await customers.identify(ws, { channel: 'web', externalId: who.padEnd(24, 'x') })
  const c = await convo.open(ws, person.id, 'web', `w1:${who.padEnd(24, 'x')}`)
  return (await convo.record(ws, c.id, { direction: 'in', body: 'see attached' })).id
}

const row = (id) => asSystem(() => all(`SELECT * FROM attachments WHERE id = ?`, id)).then((r) => r[0])

test('the store is configured for this file, unlike every other test file', () => {
  assert.notEqual(process.env.MEDIA_DIR, '')
})

test('a file moves to the store, and the row keeps the key instead of the bytes', async () => {
  const body = Buffer.from('%PDF-1.4 a quotation for the roof')
  const messageId = await message('mover')
  await files.add(ws, messageId, { name: 'quote.pdf', mime: 'application/pdf', bytes: body })

  const [before] = await asSystem(() => all(`SELECT id, bytes, storage_key FROM attachments WHERE message_id = ?`, messageId))
  assert.ok(before.bytes, 'starts in the database')
  assert.equal(before.storage_key, null, 'and nowhere else')

  await media.sweepMedia()

  const after = await row(before.id)
  assert.equal(after.bytes, null, 'the database copy is gone')
  assert.ok(after.storage_key, 'and the row says where the file is now')
  assert.equal(after.size_bytes, body.length)

  /*
   * Read it back through the store rather than off the disk, because that is the path the app
   * uses and the one the sweep now checks before it deletes anything.
   */
  const back = await getObject(after.storage_key)
  assert.deepEqual(back, body, 'the same bytes came back')
  // And on disk under the root, since the key is a path: the store is inspectable by hand.
  assert.deepEqual(await readFile(join(root, after.storage_key)), body)
})

test('the key is the content hash, so the same file twice is one object', async () => {
  const body = Buffer.from('%PDF-1.4 the very same quotation')
  const sha = createHash('sha256').update(body).digest('hex')

  for (const who of ['twinA', 'twinB']) {
    const messageId = await message(who)
    await files.add(ws, messageId, { name: 'same.pdf', mime: 'application/pdf', bytes: body })
  }
  await media.sweepMedia()

  const moved = await asSystem(() =>
    all(`SELECT storage_key, sha256 FROM attachments WHERE sha256 = ? AND storage_key IS NOT NULL`, sha),
  )
  assert.equal(moved.length, 2, 'two rows')
  assert.equal(new Set(moved.map((m) => m.storage_key)).size, 1, 'one object between them')
  assert.match(moved[0].storage_key, new RegExp(sha), 'and the key is the hash of the contents')
})

/*
 * The guard this file exists for, tested on its own.
 *
 * `proveStored` is what stands between a misconfigured store and an irreversible delete, so
 * the branch worth testing is the one that refuses. Called directly rather than through the
 * sweep, because a store that writes successfully and then cannot read is not a state the
 * filesystem will enter on request -- and mocking the store would put the whole suite behind
 * an experimental Node flag, which is a poor trade for one test.
 */
test('a key that is not in the store is refused, so the bytes are never deleted', async () => {
  await assert.rejects(
    () => media.proveStored('media/1/never-written', Buffer.from('irreplaceable')),
    /could not read it back/,
  )
})

test('a key holding different bytes than we wrote is refused too', async () => {
  const key = 'media/1/swapped'
  await putObject(key, Buffer.from('what is actually in the store'), 'text/plain')
  await assert.rejects(() => media.proveStored(key, Buffer.from('what we think we wrote')), /different bytes/)
})

test('and the same bytes pass, or nothing would ever move', async () => {
  const key = 'media/1/agrees'
  const body = Buffer.from('written and read back')
  await putObject(key, body, 'text/plain')
  await media.proveStored(key, body)
})

test('a row whose object is missing from the store keeps its key, so the file is findable', async () => {
  const body = Buffer.from('%PDF-1.4 do not lose me')
  const messageId = await message('kept')
  await files.add(ws, messageId, { name: 'keep.pdf', mime: 'application/pdf', bytes: body })
  const [mine] = await asSystem(() => all(`SELECT id FROM attachments WHERE message_id = ?`, messageId))

  await media.sweepMedia()
  const moved = await row(mine.id)
  assert.equal(moved.bytes, null, 'it moved, as the happy path above')

  /*
   * Now put it back in the state the incident left three rows in: a key, and no object. Then
   * prove the app can tell -- `getObject` answers null rather than throwing, which is why the
   * sweep has to check the answer rather than trust the write.
   */
  await rm(join(root, moved.storage_key), { force: true })
  assert.equal(await getObject(moved.storage_key), null, 'the store no longer has it')

  /*
   * And prove the sweep will not pick it up again and make it worse: it selects on
   * `bytes IS NOT NULL AND storage_key IS NULL`, so a row in this state is simply not its
   * business. Recovering it means putting the object back, which is what the key is for.
   */
  await media.sweepMedia()
  const still = await row(mine.id)
  assert.equal(still.storage_key, moved.storage_key, 'the key is untouched, so the file is findable again')
})
