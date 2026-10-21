/**
 * Files on a conversation.
 *
 * The two rules that matter: a file we could not keep is still recorded, and a file is only
 * ever readable by the workspace that received it — an attachment is a customer's own
 * document, not something addressed by a public token the way a resource is.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('attachments')
const auth = await import('../src/server/auth.ts')
const files = await import('../src/server/attachments.ts')
const convo = await import('../src/server/conversations.ts')
const customers = await import('../src/server/customers.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('files@example.com')).workspaceId
const other = (await auth.provisionUser('files-other@example.com')).workspaceId

const thread = async () => {
  const person = await customers.identify(ws, { channel: 'web', externalId: 'v'.repeat(24) })
  const c = await convo.open(ws, person.id, 'web', `w1:${'v'.repeat(24)}`)
  return (await convo.record(ws, c.id, { direction: 'in', body: 'see attached' })).id
}

test('a file is filed against its message and read back without its bytes', async () => {
  const messageId = await thread()
  await files.add(ws, messageId, { name: ' receipt.pdf ', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x') })

  const [filed] = await files.forMessages(ws, [messageId])
  assert.equal(filed.name, 'receipt.pdf')
  assert.equal(filed.mime, 'application/pdf')
  assert.equal(filed.size_bytes, 10)
  assert.equal(filed.held, true)
  // The listing must never carry the bytes: a thread of ten photos would be a page load of them.
  assert.equal('bytes' in filed, false)

  const opened = await files.open(ws, filed.id)
  assert.equal(opened.bytes.toString(), '%PDF-1.4 x')
})

test('a file too large to keep is still recorded, with what it was', async () => {
  const messageId = await thread()
  await files.add(ws, messageId, {
    name: 'holiday.mp4',
    mime: 'video/mp4',
    bytes: Buffer.alloc(files.MAX_BYTES + 1),
    externalRef: 'gmail-att-1',
  })

  const filed = (await files.forMessages(ws, [messageId])).at(-1)
  // "They sent a 25MB video we did not keep" is a fact somebody needs. Silence is not.
  assert.equal(filed.name, 'holiday.mp4')
  assert.equal(filed.held, false)
  assert.ok(filed.size_bytes > files.MAX_BYTES)
  assert.equal((await files.open(ws, filed.id)).bytes, null)
})

test('a file known but not fetched records its name and size', async () => {
  const messageId = await thread()
  await files.add(ws, messageId, { name: 'quote.docx', size: 4096, externalRef: 'graph-att-9' })

  const filed = (await files.forMessages(ws, [messageId])).at(-1)
  assert.equal(filed.size_bytes, 4096)
  assert.equal(filed.held, false)
})

test('another workspace cannot list or open somebody else s files', async () => {
  const messageId = await thread()
  await files.add(ws, messageId, { name: 'private.pdf', bytes: Buffer.from('secret') })
  const [filed] = await files.forMessages(ws, [messageId])

  assert.deepEqual(await files.forMessages(other, [messageId]), [])
  assert.equal(await files.open(other, filed.id), undefined)
})

test('no messages is not a query', async () => {
  assert.deepEqual(await files.forMessages(ws, []), [])
})

// ---------------------------------------------------------------- a file we sent

test('a file we sent is a pointer, and still opens and still reads as held', async () => {
  /*
   * An outbound file is recorded against the message but stored once, on the resource.
   * Copying the bytes per send would be twelve gigabytes for one price list sent five
   * hundred times — in a table whose migration already sets `storage external` because that
   * worry was live when it was written.
   *
   * Two things have to survive that: opening it must follow the pointer, and `held` must not
   * read off `bytes IS NOT NULL` alone, or the inbox greys out every file the bot ever sent
   * as "not kept" — a lie it would be telling about its own messages.
   */
  const { insert } = await import('../src/server/db.ts')
  const pdf = Buffer.from('%PDF-1.4 sent to a customer')
  await insert(
    `INSERT INTO resources (workspace_id, kind, title, description, mime, bytes, size_bytes, token)
     VALUES (?, 'file', ?, '', ?, ?, ?, ?)`,
    ws, 'price-list.pdf', 'application/pdf', pdf, pdf.length, 'tok-att-pointer-0000000000',
  )

  const messageId = await thread()
  await files.add(ws, messageId, {
    name: 'price-list.pdf',
    mime: 'application/pdf',
    size: pdf.length,
    externalRef: 'resource:tok-att-pointer-0000000000',
  })

  const [row] = await files.forMessages(ws, [messageId])
  assert.equal(row.name, 'price-list.pdf')
  assert.equal(row.held, true, 'a file we sent showed as not kept')
  assert.equal(row.size_bytes, pdf.length)

  const opened = await files.open(ws, row.id)
  assert.equal(opened.bytes.toString(), pdf.toString(), 'opening did not follow the pointer')
})

test('a pointer to a resource that is gone reads as not held rather than throwing', async () => {
  // Deleting a resource is a workspace-wide act and it cascades nothing here on purpose:
  // the thread should still say a file was sent, and say that it is no longer kept.
  const messageId = await thread()
  await files.add(ws, messageId, { name: 'gone.pdf', mime: 'application/pdf', size: 10, externalRef: 'resource:tok-att-missing-000000000' })

  const row = (await files.forMessages(ws, [messageId])).find((f) => f.name === 'gone.pdf')
  const opened = await files.open(ws, row.id)
  assert.equal(opened.bytes, null)
  assert.equal(opened.name, 'gone.pdf')
})

// ---------------------------------------------------------------- the same file, once

test('the same file arriving again points at the copy already stored', async () => {
  /*
   * One popular file can end up as most of the table. A team sending the same brochure by
   * hand to each enquiry comes in through the ingest path, which had no way to know the
   * workspace already held it.
   */
  const { run, one } = await import('../src/server/db.ts')
  const brochure = Buffer.from('%PDF-1.4 the course brochure, 1.9 MB of it')

  const first = await thread()
  await files.add(ws, first, { name: 'brochure.pdf', mime: 'application/pdf', bytes: brochure })
  const [stored] = await files.forMessages(ws, [first])

  // Stand in for the sweep having moved it: bytes out, key in.
  await run(`UPDATE attachments SET bytes = NULL, storage_key = 'media/1/abc' WHERE id = ?`, stored.id)

  const second = await thread()
  await files.add(ws, second, { name: 'brochure.pdf', mime: 'application/pdf', bytes: brochure })
  const [again] = await files.forMessages(ws, [second])

  const row = await one(`SELECT bytes, storage_key, sha256 FROM attachments WHERE id = ?`, again.id)
  assert.equal(row.bytes, null, 'the second copy of the bytes was never written')
  assert.equal(row.storage_key, 'media/1/abc', 'it points at the one already stored')
  assert.ok(row.sha256, 'and carries the hash that matched it')

  // And it still reads as a file we hold, or the inbox would call its own brochure "not kept".
  assert.equal(again.held, true)
})

test('a different file is not mistaken for it', async () => {
  const { one } = await import('../src/server/db.ts')
  const messageId = await thread()
  await files.add(ws, messageId, { name: 'brochure.pdf', mime: 'application/pdf', bytes: Buffer.from('something else') })
  const [filed] = await files.forMessages(ws, [messageId])

  const row = await one(`SELECT bytes, storage_key FROM attachments WHERE id = ?`, filed.id)
  assert.ok(row.bytes, 'same name, different bytes — it keeps its own')
  assert.equal(row.storage_key, null)
})

test('a file in storage reads as held, not as one we lost', async () => {
  // `held` used to be bytes-or-a-resource-pointer. Every file the sweep moved would have gone
  // grey and said "not kept" — a lie the inbox would be telling about files it still has.
  const { run } = await import('../src/server/db.ts')
  const messageId = await thread()
  await files.add(ws, messageId, { name: 'photo.jpg', mime: 'image/jpeg', bytes: Buffer.from('jpegdata') })
  const [filed] = await files.forMessages(ws, [messageId])
  await run(`UPDATE attachments SET bytes = NULL, storage_key = 'media/1/xyz' WHERE id = ?`, filed.id)

  const [after] = await files.forMessages(ws, [messageId])
  assert.equal(after.held, true)
  assert.equal(after.size_bytes, 8, 'and still says how big it is')
})

// ---------------------------------------------------------------- smaller on the way out

test('an oversized image is shrunk before it is stored', async () => {
  /*
   * 959 photos were 179 MB of the database, at 191 KB each, every one of them at whatever
   * resolution a phone camera produces. An inbox never shows them larger than a thumbnail.
   */
  const media = await import('../src/server/media.ts')
  const sharp = (await import('sharp')).default

  // A photo-shaped image, deliberately bigger than the ceiling and noisy enough that it does
  // not simply compress to nothing.
  const wide = await sharp({
    create: { width: 3000, height: 2000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } },
  })
    .jpeg({ quality: 95 })
    .toBuffer()

  const out = await media.shrink(wide, 'image/jpeg')
  assert.ok(out.bytes.length < wide.length, 'it got smaller')
  assert.equal(out.mime, 'image/webp')

  const after = await sharp(out.bytes).metadata()
  assert.ok(after.width <= 1600 && after.height <= 1600, `still ${after.width}x${after.height}`)
})

test('a small image is left exactly as it was', () => {
  // Re-encoding something already small risks making it bigger, and a conversion that grows a
  // file is thrown away rather than stored for the sake of consistency.
  return (async () => {
    const media = await import('../src/server/media.ts')
    const sharp = (await import('sharp')).default
    const tiny = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .webp({ quality: 80 })
      .toBuffer()

    const out = await media.shrink(tiny, 'image/webp')
    assert.equal(out.bytes.length, tiny.length, 'untouched')
  })()
})

test('a PDF is never re-encoded', async () => {
  // Already compressed. Re-encoding buys nothing and can quietly ruin a file somebody needs.
  const media = await import('../src/server/media.ts')
  const pdf = Buffer.from('%PDF-1.4 a document that must come back byte for byte')
  const out = await media.shrink(pdf, 'application/pdf')
  assert.equal(out.bytes.toString(), pdf.toString())
  assert.equal(out.mime, 'application/pdf')
})

test('the storage key is the content, so the same file lands in one place', async () => {
  const media = await import('../src/server/media.ts')
  const a = media.keyFor(7, 'abc123', 'application/pdf')
  const b = media.keyFor(7, 'abc123', 'application/pdf')
  assert.equal(a, b, 'the same content is the same object, however often it arrives')
  assert.notEqual(a, media.keyFor(8, 'abc123', 'application/pdf'), 'but never across workspaces')
  assert.match(media.keyFor(7, 'abc123', 'image/jpeg'), /\.webp$/, 'an image is stored as what it became')

  // A preview shares the keyspace and must never share an address: writing one over the file
  // it was cut from would replace a brochure with a 10 kB picture of its cover.
  assert.equal(media.thumbKeyFor(7, 'abc123'), media.thumbKeyFor(7, 'abc123'))
  assert.notEqual(media.thumbKeyFor(7, 'abc123'), media.thumbKeyFor(8, 'abc123'))
  for (const mime of ['application/pdf', 'image/jpeg', null])
    assert.notEqual(media.thumbKeyFor(7, 'abc123'), media.keyFor(7, 'abc123', mime), `collides for ${mime}`)
})

test('a file in Storage still counts as held — the predicate that stopped training working', async () => {
  /*
   * 069 moved bytes out of the row and `lessons.ts` went on testing `bytes IS NOT NULL`, so
   * file training proposals silently stopped being generated: the query matched nothing and
   * nothing anywhere said so. `held()` is the one definition both readers now share.
   */
  const { one, run } = await import('../src/server/db.ts')
  const messageId = await thread()
  await files.add(ws, messageId, { name: 'moved.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF moved') })
  const [row] = await files.forMessages(ws, [messageId])

  // What the sweep leaves behind: the bytes are in the bucket, the row keeps the key.
  await run(
    `UPDATE attachments SET bytes = NULL, storage_key = ?, sha256 = ? WHERE workspace_id = ? AND id = ?`,
    'media/1/deadbeef',
    'deadbeef',
    ws,
    row.id,
  )

  const still = await one(
    `SELECT ${files.held()} AS held FROM attachments WHERE workspace_id = ? AND id = ?`,
    ws,
    row.id,
  )
  assert.equal(still.held, true, 'a file in Storage is still a file we hold')

  // And the alias form, which is what a join needs.
  const joined = await one(
    `SELECT ${files.held('a')} AS held FROM attachments a WHERE a.workspace_id = ? AND a.id = ?`,
    ws,
    row.id,
  )
  assert.equal(joined.held, true)
})

test('the conversations listing says who put each file there', async () => {
  const messageId = await thread()
  await files.add(ws, messageId, { name: 'from-them.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF in') })

  const got = await files.inConversations(ws, { size: 100 })
  const mine = got.rows.find((r) => r.name === 'from-them.pdf')
  // `thread()` records an inbound message, so the customer is who sent it.
  assert.equal(mine.from_customer, true)
  assert.equal(mine.from_team, false)
  assert.equal(mine.held, true)
  assert.ok(got.total >= 1)
})

test('one file sent many times is one card, not many rows', async () => {
  /*
   * The thing the row-per-message listing got wrong, and the reason this is grouped.
   *
   * A brochure sent to two hundred people is two hundred rows and **one stored object** — the
   * ingest path matches on sha256 and points every arrival at the same key. Listing the rows
   * showed the same file two hundred times and implied a storage problem that does not exist.
   */
  const { one } = await import('../src/server/db.ts')
  const pdf = Buffer.from('%PDF one course brochure, sent over and over')
  const messages = []
  for (let i = 0; i < 3; i++) {
    const m = await thread()
    messages.push(m)
    await files.add(ws, m, { name: 'course-edm.pdf', mime: 'application/pdf', bytes: pdf })
  }

  const got = await files.inConversations(ws, { size: 100 })
  const card = got.rows.filter((r) => r.name === 'course-edm.pdf')
  assert.equal(card.length, 1, 'three sends, one card')
  assert.equal(card[0].copies, 3)
  assert.equal(card[0].redundant, 0, 'three messages, three rows — nothing redundant')

  // And the bytes really are stored once, which is what makes the card honest.
  const held = await one(
    `SELECT count(DISTINCT sha256)::int AS hashes, count(*)::int AS rows
       FROM attachments WHERE workspace_id = ? AND name = 'course-edm.pdf'`,
    ws,
  )
  assert.equal(held.rows, 3)
  assert.equal(held.hashes, 1)
})

test('the same file twice on one message is the only duplicate worth removing', async () => {
  const { all } = await import('../src/server/db.ts')
  const messageId = await thread()
  const ics = Buffer.from('BEGIN:VCALENDAR')
  await files.add(ws, messageId, { name: 'invite.ics', mime: 'text/calendar', bytes: ics })
  await files.add(ws, messageId, { name: 'invite.ics', mime: 'text/calendar', bytes: ics })

  const before = await files.inConversations(ws, { size: 100 })
  const card = before.rows.find((r) => r.name === 'invite.ics')
  assert.equal(card.copies, 2)
  assert.equal(card.redundant, 1, 'nothing happened twice — it was written down twice')

  const removed = await files.tidyDuplicates(ws, card.id)
  assert.equal(removed, 1)

  const after = await files.inConversations(ws, { size: 100 })
  const still = after.rows.find((r) => r.name === 'invite.ics')
  assert.equal(still.copies, 1, 'the file stays, the second record of it goes')
  assert.equal(still.redundant, 0)

  // The surviving row is the one anything else already points at.
  const left = await all(
    `SELECT id FROM attachments WHERE workspace_id = ? AND name = 'invite.ics' AND message_id = ?`,
    ws,
    messageId,
  )
  assert.equal(left.length, 1)
  assert.equal(left[0].id, card.id)
})
