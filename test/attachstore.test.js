/**
 * A pointer at a library file, after the sweep has moved that file.
 *
 * Its own file because the store has to be configured before `storage.ts` is first imported
 * — it reads `MEDIA_DIR` once, into a module constant — and the rest of the suite runs with
 * no store at all on purpose (see helper.js).
 *
 * What is being pinned down is the second hop. `deliver()` files a resource a person sent as
 * a pointer rather than a copy, and the sweep then moves the resource's own bytes onto the
 * store a minute or two later. Between those two facts sits a window where a file is held in
 * neither column anything was reading, and `open()` answered null — which every caller
 * reports as "that file is no longer held" about a file that is sitting in the store.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('attachstore')

// After useSchema, which blanks it, and before anything below pulls in storage.ts.
const root = await mkdtemp(join(tmpdir(), 'arlo-attachstore-'))
process.env.MEDIA_DIR = root

const auth = await import('../src/server/auth.ts')
const files = await import('../src/server/attachments.ts')
const convo = await import('../src/server/conversations.ts')
const customers = await import('../src/server/customers.ts')
const resources = await import('../src/server/resources.ts')
const { run } = await import('../src/server/db.ts')
const { putObject, storageConfigured } = await import('../src/server/storage.ts')

test.after(async () => {
  await db_.drop()
  await rm(root, { recursive: true, force: true })
})

const ws = (await auth.provisionUser('attachstore@example.com')).workspaceId

test('the store is configured here, unlike the rest of the suite', () => {
  assert.equal(storageConfigured(), true, 'otherwise the test below proves nothing')
})

test('a pointer at a library file still opens once the sweep has moved that file', async () => {
  const bytes = Buffer.from('a song, in bytes')
  const id = await resources.addFile(ws, { name: 'song.mp3', mime: 'audio/mpeg', bytes }, 'her favourite')
  const res = await resources.get(ws, id)

  // The sweep's end state: object in the store, key on the row, column empty.
  const key = `media/${ws}/moved.mp3`
  await putObject(key, bytes, 'audio/mpeg')
  await run(`UPDATE resources SET bytes = NULL, storage_key = ? WHERE workspace_id = ? AND id = ?`, key, ws, id)

  // What deliver() files when a person sends a library file: a pointer, never a copy.
  const person = await customers.identify(ws, { channel: 'web', externalId: 'z'.repeat(24) })
  const c = await convo.open(ws, person.id, 'web', `w1:${'z'.repeat(24)}`)
  const messageId = (await convo.record(ws, c.id, { direction: 'out', body: 'here you go' })).id
  await files.add(ws, messageId, {
    name: 'song.mp3',
    mime: 'audio/mpeg',
    size: bytes.length,
    externalRef: `resource:${res.token}`,
  })

  const [filed] = await files.forMessages(ws, [messageId])
  const opened = await files.open(ws, filed.id)
  assert.deepEqual(opened.bytes, bytes, 'the pointer has to follow the file onto the store')
})
