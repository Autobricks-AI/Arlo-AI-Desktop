/**
 * Uploading a file, which is now a job rather than a request.
 *
 * The thing worth proving is the split: everything knowable without reading the file is
 * decided before `queue()` returns, and everything else is decided by the job and written
 * to the row. A page that polls is only as good as what the row says.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import { useSchema } from './helper.js'
const db_ = await useSchema('uploads')
const auth = await import('../src/server/auth.ts')
const uploads = await import('../src/server/uploads.ts')
const kb = await import('../src/server/kb.ts')
const { one } = await import('../src/server/db.ts')
test.after(() => db_.drop())

const bases = await import('../src/server/bases.ts')
const ws = (await auth.provisionUser('up@example.com')).workspaceId
const base = (await bases.first(ws)).id
const other = (await auth.provisionUser('up-other@example.com')).workspaceId

const file = (name, text, mime = 'text/plain') => ({ name, mime, bytes: Buffer.from(text) })

/** The job is started but not awaited, so a test that needs the outcome waits for it. */
const settled = async (id, workspaceId = ws) => {
  for (let i = 0; i < 200; i++) {
    const row = await uploads.get(workspaceId, id)
    if (row.status === 'ready' || row.status === 'failed') return row
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('the upload never finished')
}

// ---------------------------------------------------------------- accepting

test('accepting a file returns before it has been read', async () => {
  const row = await uploads.queue(ws, base, file('Hours.txt', 'We are open nine to five on weekdays.'))

  // The point of the change: a row exists and nothing has been parsed, chunked or embedded.
  assert.ok(row.id)
  assert.equal(row.filename, 'Hours.txt')
  assert.ok(['queued', 'running'].includes(row.status), `expected work still to be pending, got ${row.status}`)
  assert.equal(row.document_id, null)

  const done = await settled(row.id)
  assert.equal(done.status, 'ready')
  assert.ok(done.document_id, 'the job files a document and points the row at it')
  assert.ok(done.finished_at)
})

test('what is knowable without reading the file is refused on the spot', async () => {
  // Not "a row that fails a second later" — these are mistakes on the form, and the person
  // is still standing there.
  await assert.rejects(() => uploads.queue(ws, base, file('empty.txt', '')), /empty/)
  await assert.rejects(
    () => uploads.queue(ws, base, { name: 'big.txt', mime: 'text/plain', bytes: Buffer.alloc(uploads.MAX_BYTES + 1) }),
    /limit/,
  )
  await assert.rejects(() => uploads.queue(ws, base, file('sheet.xlsx', 'PK...', 'application/vnd.ms-excel')), /upload text/)

  assert.equal((await uploads.list(ws)).filter((u) => u.filename === 'sheet.xlsx').length, 0)
})

test('fifty megabytes is the ceiling', () => {
  assert.equal(uploads.MAX_BYTES, 50 * 1024 * 1024)
})

// ---------------------------------------------------------------- the job

test('a file that cannot be read says so on its own row, and stays downloadable', async () => {
  /*
   * A PDF with no text layer. Only discoverable by parsing it, so this is the job's to
   * report — and it has to land somewhere a person will see it, because the request that
   * started the upload returned long ago.
   */
  const row = await uploads.queue(ws, base, { name: 'Scan.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n') })
  const done = await settled(row.id)

  assert.equal(done.status, 'failed')
  assert.match(done.error, /no text layer|Nothing readable/i)
  assert.equal(done.document_id, null)

  // The file is still here. Failing to read it is not a reason to throw it away — that is
  // the copy somebody would want back to convert by hand.
  assert.ok((await uploads.fileOf(ws, row.id)).bytes.length)
})

test('the same file twice is one row, read again', async () => {
  const twice = file('Policy.txt', 'Returns are accepted within thirty days.')
  const first = await uploads.queue(ws, base, twice)
  await settled(first.id)
  const again = await uploads.queue(ws, base, twice)
  await settled(again.id)

  assert.equal(again.id, first.id, 'the same bytes are the same upload, as the same address is the same site')
  assert.equal((await uploads.list(ws)).filter((u) => u.filename === 'Policy.txt').length, 1)
})

test('the same file can go into two knowledge bases, and stays in both', async () => {
  /*
   * The dedupe key is (workspace, base, sha) rather than (workspace, sha), and getting that
   * wrong broke uploading entirely: the ON CONFLICT named a constraint that did not exist,
   * so every upload failed with "no unique or exclusion constraint matching".
   *
   * The behaviour underneath is the reason for the key. A price list belongs in the public
   * base and in the internal one. Workspace-wide, adding it to the second would not copy it
   * — it would move it, and a bot connected only to the first would quietly stop being able
   * to answer from it.
   */
  const second = (await bases.create(ws, 'Second base')).id
  const shared = file('Shared.txt', 'The same words, filed in two places on purpose.')

  const a = await uploads.queue(ws, base, shared)
  const b = await uploads.queue(ws, second, shared)
  assert.notEqual(a.id, b.id, 'one file in two bases is two uploads, not one that moved')

  const doneA = await settled(a.id)
  const doneB = await settled(b.id)
  assert.equal(doneA.status, 'ready')
  assert.equal(doneB.status, 'ready')
  assert.notEqual(doneA.document_id, doneB.document_id, 'each base holds its own copy to search')

  // And both are still there — the second did not take the first's row.
  assert.equal((await uploads.list(ws, base)).filter((u) => u.filename === 'Shared.txt').length, 1)
  assert.equal((await uploads.list(ws, second)).filter((u) => u.filename === 'Shared.txt').length, 1)
})

test('an upload being read is not started a second time', async () => {
  const row = await uploads.queue(ws, base, file('Slow.txt', 'a'.repeat(4000)))
  // Only meaningful while it is still working; if it already finished, re-queueing is fine.
  const fresh = await uploads.get(ws, row.id)
  if (fresh.status === 'queued' || fresh.status === 'running')
    await assert.rejects(() => uploads.queue(ws, base, file('Slow.txt', 'a'.repeat(4000))), /already being read/)
  await settled(row.id)
})

// ---------------------------------------------------------------- the file itself

test('the bytes are stored compressed and come back identical', async () => {
  // Text is what compresses, and text is most of what a knowledge base is given.
  const text = 'The starter plan is ten dollars a month. '.repeat(400)
  const row = await uploads.queue(ws, base, file('Plans.txt', text))
  await settled(row.id)

  const stored = await one(`SELECT length(bytes) AS packed, size_bytes FROM uploads WHERE id = ?`, row.id)
  assert.equal(Number(stored.size_bytes), Buffer.byteLength(text))
  assert.ok(
    Number(stored.packed) < Buffer.byteLength(text) / 4,
    `expected real compression, stored ${stored.packed} of ${Buffer.byteLength(text)}`,
  )
  // Compression is only worth having if it is invisible.
  assert.equal((await uploads.fileOf(ws, row.id)).bytes.toString(), text)
})

test('a download carries the name and type it arrived with', async () => {
  const row = await uploads.queue(ws, base, { name: 'Guide.html', mime: 'text/html', bytes: Buffer.from('<h1>Hi</h1>') })
  await settled(row.id)

  const got = await uploads.fileOf(ws, row.id)
  assert.equal(got.filename, 'Guide.html')
  assert.equal(got.mime, 'text/html')
  // The original, not the extracted text — the tags are still there.
  assert.match(got.bytes.toString(), /<h1>/)
})

test('a file filed before uploads were kept has nothing to hand back', async () => {
  // What the migration adopts: a document, an upload row, and no bytes.
  const filed = await kb.store(ws, { baseId: base,
    source: 'upload',
    uri: null,
    title: 'Ancient.txt',
    mime: 'text/plain',
    text: 'Filed before this table existed.',
  })
  const { insert } = await import('../src/server/db.ts')
  const id = await insert(
    `INSERT INTO uploads (workspace_id, base_id, filename, mime, bytes, size_bytes, sha, status, document_id)
     VALUES (?,?,?,?,?,0,?, 'ready', ?)`,
    ws,
    base,
    'Ancient.txt',
    'text/plain',
    Buffer.alloc(0),
    'legacy:' + filed.documentId,
    filed.documentId,
  )
  assert.equal(await uploads.fileOf(ws, id), undefined, 'no bytes means no Download button, not a broken one')
})

// ---------------------------------------------------------------- removing

test('removing a file removes what was indexed from it', async () => {
  const row = await uploads.queue(ws, base, file('Doomed.txt', 'This will not be here for long.'))
  const done = await settled(row.id)
  const documentId = done.document_id

  await uploads.remove(ws, row.id)
  assert.equal(await uploads.get(ws, row.id), undefined)
  assert.equal(await kb.getDocument(ws, documentId), undefined, 'the knowledge goes with the file')
  assert.equal(await one(`SELECT 1 FROM chunks WHERE document_id = ?`, documentId), undefined)
})

test('removing the document removes the file it came from', async () => {
  // The other direction, which the schema does rather than the code: a document deleted
  // from the knowledge base must not leave its bytes behind with nothing pointing at them.
  const row = await uploads.queue(ws, base, file('Linked.txt', 'Deleted from the other end.'))
  const done = await settled(row.id)

  await kb.removeDocument(ws, done.document_id)
  assert.equal(await uploads.get(ws, row.id), undefined)
})

// ---------------------------------------------------------------- the boundary

test('one workspace never reaches another one s uploads', async () => {
  const mine = (await uploads.list(ws)).find((u) => u.status === 'ready')

  assert.deepEqual(await uploads.list(other), [])
  assert.equal(await uploads.get(other, mine.id), undefined)
  // The download route resolves the id against the caller's own workspace, so a guessed id
  // finds nothing rather than somebody else's file.
  assert.equal(await uploads.fileOf(other, mine.id), undefined)
  await assert.rejects(() => uploads.remove(other, mine.id), /No such upload/)
})

test('a restart mid-read resumes the file rather than asking for it again', async () => {
  /*
   * A deploy, or a dev server reloading on a saved file. The bytes are already in the row,
   * so there is nothing lost and nothing for anybody to decide — "add it again to finish"
   * was asking a person to press a button on the machine's behalf.
   */
  const { insert, run } = await import('../src/server/db.ts')
  const id = await insert(
    `INSERT INTO uploads (workspace_id, base_id, filename, mime, bytes, size_bytes, sha, status, attempts)
     VALUES (?,?,?,?,?,?,?, 'running', 1)`,
    ws,
    base,
    'Interrupted.txt',
    'text/plain',
    gzipSync(Buffer.from('The server restarted halfway through reading this.')),
    50,
    'interrupted-sha',
  )

  await uploads.recover()
  const done = await settled(id)
  assert.equal(done.status, 'ready', `expected it to finish itself, got ${done.status}: ${done.error}`)
  assert.ok(done.document_id, 'and to have filed what it read')
})

test('a file that keeps ending the process is left alone, and says why', async () => {
  /*
   * The reason resuming needs a bound. A file whose reading kills the process would
   * otherwise restart, resume, kill it again, and do that on every deploy forever — one
   * bad PDF turning into a boot loop.
   */
  const CURSED = Buffer.from('Something about this one ends the read.')
  const { insert } = await import('../src/server/db.ts')
  const id = await insert(
    `INSERT INTO uploads (workspace_id, base_id, filename, mime, bytes, size_bytes, sha, status, attempts)
     VALUES (?,?,?,?,?,?,?, 'running', 3)`,
    ws,
    base,
    'Cursed.txt',
    'text/plain',
    gzipSync(CURSED),
    CURSED.length,
    // The real hash of the bytes, so re-choosing the same file finds this row rather than
    // filing a second copy of it.
    createHash('sha256').update(CURSED).digest('hex'),
  )

  await uploads.recover()
  const row = await uploads.get(ws, id)
  assert.equal(row.status, 'failed')
  assert.match(row.error, /interrupted 3 times/)

  // And choosing the file again is a fresh decision, so it gets a fresh count rather than
  // failing immediately on somebody's second attempt.
  const again = await uploads.queue(ws, base, { name: 'Cursed.txt', mime: 'text/plain', bytes: CURSED })
  assert.equal(again.id, id)
  assert.equal((await settled(id)).status, 'ready', 'a person retrying starts from zero')
})

test('the poller picks up an upload whose hand-off never landed', async () => {
  // What a restart mid-hand-off leaves behind. Without the sweep it would sit queued
  // forever, which is a progress bar that never moves.
  const { insert } = await import('../src/server/db.ts')
  const id = await insert(
    `INSERT INTO uploads (workspace_id, base_id, filename, mime, bytes, size_bytes, sha)
     VALUES (?,?,?,?,?,?,?)`,
    ws,
    base,
    'Stranded.txt',
    'text/plain',
    gzipSync(Buffer.from('Nobody started reading this one.')),
    31,
    'stranded-sha',
  )

  await uploads.sweep()
  assert.equal((await settled(id)).status, 'ready')
})
