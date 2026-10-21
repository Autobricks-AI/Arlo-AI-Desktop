/**
 * The file store, which is a directory.
 *
 * Needs no database, so it sets its own root and imports the module directly rather than
 * going through `useSchema`. `MEDIA_DIR` is read when the module is first used, so it is set
 * before the import and not after.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const root = await mkdtemp(join(tmpdir(), 'arlo-store-'))
process.env.MEDIA_DIR = root

const { getObject, putObject, removeObjects, storageConfigured } = await import('../src/server/storage.ts')

test.after(() => rm(root, { recursive: true, force: true }))

test('a directory is somewhere to put bytes', () => {
  assert.equal(storageConfigured(), true)
})

test('bytes come back as they went in, from a key with directories in it', async () => {
  const key = 'media/12/abc123.png'
  await putObject(key, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png')

  const back = await getObject(key)
  assert.deepEqual(back, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'the same four bytes')
  // The key is the path under the root, which is what makes the store inspectable by hand.
  assert.deepEqual(await readFile(join(root, 'media', '12', 'abc123.png')), back)
})

test('writing the same key twice is the second write winning, not a failure', async () => {
  const key = 'media/12/same.bin'
  await putObject(key, Buffer.from('first'), null)
  await putObject(key, Buffer.from('second'), null)
  assert.equal((await getObject(key)).toString(), 'second')
})

test('a key that was never written reads as null rather than throwing', async () => {
  assert.equal(await getObject('media/12/never.bin'), null)
})

test('removing is idempotent, because a sweep must not fail on what is already gone', async () => {
  const key = 'media/12/temporary.bin'
  await putObject(key, Buffer.from('bye'), null)
  await removeObjects([key])
  assert.equal(await getObject(key), null)
  // Again, and on a key that never existed. Neither throws: the caller has already decided
  // these bytes are past their window, and a throw would stop the sweep mid-tidy.
  await removeObjects([key, 'media/12/imaginary.bin'])
})

test('an empty list of keys is not a round trip to the filesystem', async () => {
  await removeObjects([])
})

/*
 * The boundary. Every key today is built from a workspace id and a hex digest, so none of
 * them can look like this -- which is exactly why it is worth a test: the check costs one
 * string comparison and the day somebody builds a key from a filename is the day it earns
 * its place.
 */
test('a key that climbs out of the root is refused, and writes nothing', async () => {
  const outside = join(root, '..', 'escaped.txt')
  await rm(outside, { force: true })

  await assert.rejects(() => putObject('../escaped.txt', Buffer.from('nope'), null), /outside the root/)
  await assert.rejects(() => getObject('../../escaped.txt'), /outside the root/)

  assert.equal(await readFile(outside).then(() => true).catch(() => false), false, 'nothing was written above the root')
})

test('an absolute key is refused for the same reason', async () => {
  await assert.rejects(() => putObject('/etc/arlo-test', Buffer.from('nope'), null), /outside the root/)
})

test('with no store configured, nothing is configured', async () => {
  /*
   * A separate module instance, because ROOT is read once at import. Node caches by resolved
   * path, so the query string is what gets a second copy -- the only way to exercise both
   * states of a module-level constant in one file.
   */
  process.env.MEDIA_DIR = ''
  const off = await import('../src/server/storage.ts?off')
  assert.equal(off.storageConfigured(), false)
  process.env.MEDIA_DIR = root
})

test('a file left in the store by hand is readable through it', async () => {
  // Proves the store is a plain directory and not a format: somebody restoring a backup by
  // copying files in gets them back out.
  await writeFile(join(root, 'dropped.txt'), 'by hand')
  assert.equal((await getObject('dropped.txt')).toString(), 'by hand')
})
