import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('kb')
const auth = await import('../src/server/auth.ts')
const kb = await import('../src/server/kb.ts')
const { retrieve } = await import('../src/server/retrieve.ts')
const { configured } = await import('../src/server/embed.ts')
test.after(() => db_.drop())

const bases = await import('../src/server/bases.ts')
const ws = (await auth.provisionUser('kb@example.com')).workspaceId
const base = (await bases.first(ws)).id

test('the harness leaves us on the offline path', () => {
  // Everything below is the no-embeddings behaviour: full-text search, NULL vectors.
  // If this ever flips, these tests would start making network calls.
  assert.equal(configured(), false)
})

test('a document is filed, chunked, and findable by what it says', async () => {
  const filed = await kb.store(ws, { baseId: base,
    source: 'upload',
    uri: null,
    title: 'Refunds policy',
    mime: 'text/plain',
    text: 'Refunds are issued to the original payment method within five working days.\n\nShipping is free above fifty dollars.',
  })
  assert.equal(filed.status, 'created')
  assert.ok(filed.chunks >= 1)

  const hits = await retrieve(ws, 'how long do refunds take')
  assert.ok(hits.length, 'nothing came back')
  assert.match(hits[0].text, /five working days/)
  // A passage carries where it came from, so an answer can be traced back to a document.
  assert.equal(hits[0].title, 'Refunds policy')
  assert.equal(hits[0].document_id, filed.documentId)
})

test('with no embeddings provider, chunks are stored without vectors', async () => {
  const s = await kb.stats(ws)
  assert.ok(s.chunks > 0)
  assert.equal(s.embedded, 0)
})

test('filing the same text twice does not file it twice', async () => {
  const text = 'Our support hours are nine to five, Monday to Friday.'
  const first = await kb.store(ws, { baseId: base, source: 'upload', uri: null, title: 'Hours', mime: 'text/plain', text })
  const again = await kb.store(ws, { baseId: base, source: 'upload', uri: null, title: 'Hours copy', mime: 'text/plain', text })

  assert.equal(first.status, 'created')
  assert.equal(again.status, 'unchanged')
  assert.equal(again.documentId, first.documentId)
})

test('a page that changed replaces itself rather than stacking up', async () => {
  const uri = 'https://example.com/pricing'
  const v1 = await kb.store(ws, { baseId: base, source: 'url', uri, title: 'Pricing', mime: 'text/html', text: 'The starter plan is ten dollars a month.' })
  const v2 = await kb.store(ws, { baseId: base, source: 'url', uri, title: 'Pricing', mime: 'text/html', text: 'The starter plan is twelve dollars a month.' })

  assert.equal(v2.status, 'updated')
  assert.equal(v2.documentId, v1.documentId)

  const hits = await retrieve(ws, 'starter plan price')
  // The old price must be gone, not merely outranked — a stale chunk is a wrong answer
  // waiting to be retrieved.
  assert.ok(hits.some((h) => /twelve/.test(h.text)))
  assert.ok(!hits.some((h) => /ten dollars/.test(h.text)))
})

test('an empty document is refused rather than filed', async () => {
  await assert.rejects(
    () => kb.store(ws, { baseId: base, source: 'upload', uri: null, title: 'Blank', mime: 'text/plain', text: '   \n\n  ' }),
    /Nothing readable/,
  )
})

test('a question nothing answers comes back empty, not wrong', async () => {
  assert.deepEqual(await retrieve(ws, 'what is the airspeed velocity of an unladen swallow'), [])
  assert.deepEqual(await retrieve(ws, '   '), [])
})

test('punctuation a customer typed does not break the search', async () => {
  // websearch_to_tsquery has to accept whatever arrives — a customer question is not a
  // query language, and plainto_tsquery would throw on some of this.
  for (const q of ['refunds???', '"five working days"', 'refunds -shipping', 'what & when?', "it's late!"])
    await retrieve(ws, q)
})

test('correcting the text is what the bot then answers from', async () => {
  /*
   * The reason this exists: OCR misreads a word, a crawl drags in a navigation menu, and
   * the wrong version is what gets quoted to a customer until somebody can fix it.
   */
  const filed = await kb.store(ws, {
    baseId: base,
    source: 'upload',
    uri: null,
    title: 'Delivery',
    mime: 'text/plain',
    text: 'Delivery to Singapore takes twoo to three workingg days.',
  })
  assert.ok((await retrieve(ws, 'workingg')).length, 'the misreading is what is searchable to begin with')

  const chunks = await kb.saveText(ws, filed.documentId, 'Delivery to Singapore takes two to three working days.')
  assert.ok(chunks >= 1)

  // The passages are rebuilt, so the old wording is gone rather than sitting alongside.
  const passages = await kb.passagesOf(ws, filed.documentId)
  assert.ok(passages.every((p) => !p.text.includes('workingg')), 'the misreading survived in a passage')
  assert.match(passages.map((p) => p.text).join(' '), /three working days/)

  const hits = await retrieve(ws, 'how long does delivery take')
  assert.ok(hits.some((h) => h.text.includes('three working days')), 'the correction is what retrieval finds')
})

test('an edit is refused rather than silently emptying a document', async () => {
  const filed = await kb.store(ws, {
    baseId: base,
    source: 'upload',
    uri: null,
    title: 'Not to be emptied',
    mime: 'text/plain',
    text: 'There is something here worth keeping.',
  })
  // Clearing the box is far more likely to be a slip than a decision, and the decision it
  // would be has its own button.
  await assert.rejects(() => kb.saveText(ws, filed.documentId, '   \n  '), /cannot be empty/)

  // And an edit is scoped like every other read: another workspace cannot reach in and
  // rewrite what a bot over there will quote.
  const stranger = (await auth.provisionUser('kb-stranger@example.com')).workspaceId
  await assert.rejects(() => kb.saveText(stranger, filed.documentId, 'stolen'), /No such document/)

  assert.match((await kb.getDocument(ws, filed.documentId)).text, /worth keeping/)
})

test('reindexing rebuilds the chunks from the stored text', async () => {
  const filed = await kb.store(ws, { baseId: base,
    source: 'upload',
    uri: null,
    title: 'Warranty',
    mime: 'text/plain',
    text: 'Every device carries a two year warranty against manufacturing defects.',
  })
  const before = (await kb.listDocuments(ws)).find((d) => d.id === filed.documentId).chunks
  const after = await kb.reindex(ws, filed.documentId)
  assert.equal(after, before)

  const hits = await retrieve(ws, 'warranty length')
  assert.ok(hits.some((h) => /two year warranty/.test(h.text)))
})

test('deleting a document takes its chunks with it', async () => {
  const filed = await kb.store(ws, { baseId: base,
    source: 'upload',
    uri: null,
    title: 'Temporary',
    mime: 'text/plain',
    text: 'This paragraph mentions xylophones and nothing else does.',
  })
  assert.ok((await retrieve(ws, 'xylophones')).length)

  await kb.removeDocument(ws, filed.documentId)
  // The cascade is the schema's job; this is the test that says we rely on it.
  assert.deepEqual(await retrieve(ws, 'xylophones'), [])
  await assert.rejects(() => kb.removeDocument(ws, filed.documentId), /No such document/)
})

test('an upload of an unreadable type is refused with a useful message', async () => {
  await assert.rejects(
    () => kb.textOf({ name: 'logo.png', mime: 'image/png', bytes: Buffer.from([0x89, 0x50]) }),
    /upload text, Markdown, HTML or a PDF/,
  )
})

test('a PDF with no text layer is refused rather than filed empty', async () => {
  // A scan. Filing it would put a document in the knowledge base that can never be an
  // answer, and give no sign why.
  await assert.rejects(
    () => kb.textOf({ name: 'scan.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%%EOF\n') }),
    /no text layer/,
  )
})

test('one workspace never retrieves another one s knowledge', async () => {
  const other = (await auth.provisionUser('other-kb@example.com')).workspaceId
  const otherBase = (await bases.first(other)).id
  await kb.store(other, { baseId: otherBase,
    source: 'upload',
    uri: null,
    title: 'Their handbook',
    mime: 'text/plain',
    text: 'Refunds are issued in cash at the counter.',
  })

  // This connection is the owner and bypasses RLS, so what keeps these apart here is the
  // explicit workspace argument. rls.test.js proves the second layer, as the app role.
  const mine = await retrieve(ws, 'refunds')
  assert.ok(mine.length)
  assert.ok(!mine.some((h) => /at the counter/.test(h.text)))
})

test('what the team taught leads the passages it is retrieved beside', async () => {
  /*
   * The complaint this exists for: asked how to buy, a bot answered "through our official
   * website or a distributor near you" out of a years-old brochure, while the shop link its
   * team hands out every day sat further down the same result set.
   */
  await kb.store(ws, {
    baseId: base,
    source: 'upload',
    uri: null,
    title: 'Brochure',
    mime: 'text/plain',
    text: 'To buy, visit our official website or contact a distributor near you.',
  })
  await kb.store(ws, {
    baseId: base,
    source: 'reply',
    uri: 'learned:bot-1',
    title: 'Learned by Arlo',
    mime: 'text/plain',
    text: 'Shop link — customers buy directly at https://shop.example.com',
  })

  const hits = await retrieve(ws, 'how to buy')
  assert.ok(hits.length >= 2, 'both should match')
  assert.equal(hits[0].source, 'reply', 'the taught passage has to lead')
  assert.match(hits[0].text, /shop\.example\.com/)
})

test('a passage somebody typed is filed like anything else', async () => {
  /*
   * The third way in, and the one that was missing: not everything a company knows is on a
   * website or in a PDF. "We are closed on public holidays" is one sentence, and the only
   * way to get it in used to be writing a file and uploading it.
   */
  const filed = await kb.saveNote(ws, base, 'Public holidays', 'We are closed on public holidays and reply the next working day.')
  assert.equal(filed.status, 'created')
  assert.ok(filed.chunks > 0, 'chunked, so it can be retrieved')

  const [doc] = (await kb.listDocuments(ws, base)).filter((d) => d.title === 'Public holidays')
  assert.equal(doc.source, 'text', 'neither crawled nor uploaded — which is how the page lists it')
  assert.equal(doc.uri, null, 'it came from nowhere; that is the point of it')

  const hits = await retrieve(ws, 'are you open on a public holiday')
  assert.ok(hits.some((h) => /public holidays/i.test(h.text)), 'and it answers questions')
})

test('a passage with nothing in it is refused rather than filed empty', async () => {
  await assert.rejects(() => kb.saveNote(ws, base, 'Empty', '   \n  '), /Nothing readable/)
})

/*
 * Removing a passage used to be impossible, and said the opposite.
 *
 * `writeChunks` prefixes every chunk with the document's title, because retrieval searches
 * `chunks` and never `documents.title` — so a title that is not in the passage text is not
 * searchable at all. `removePassage` then looked for that prefixed text inside the unprefixed
 * document, never found it, and refused with "no longer part of this document" every single
 * time, on a document nobody had touched.
 */
test('a passage can actually be removed from its document', async () => {
  const filed = await kb.store(ws, {
    source: 'text',
    uri: null,
    title: 'Returns policy',
    mime: null,
    baseId: base,
    // Long enough to chunk into several passages — SIZE is 1200, and a document that fits in
    // one chunk has no passage to remove that is not the whole thing.
    text: [
      `Refunds take five days once the parcel is back with us. ${'The team checks the item over before anything is released. '.repeat(14)}`,
      `Shipping is never refunded. ${'That applies to every order regardless of how it was placed or what it cost. '.repeat(14)}`,
      `Gift cards are final. ${'They cannot be returned, exchanged, or converted back into a payment of any kind. '.repeat(14)}`,
    ].join('\n\n'),
  })

  const passages = await kb.passagesOf(ws, filed.documentId)
  const target = passages.find((p) => /Refunds take five days/.test(p.text))
  assert.ok(target, 'the passage to remove is there to start with')
  // The stored passage carries the heading; the document text does not. That gap was the bug.
  assert.ok(target.text.startsWith('Returns policy'), 'chunks are stored with the title prefixed')

  await kb.removePassage(ws, target.id)

  const after = await kb.getDocument(ws, filed.documentId)
  assert.doesNotMatch(after.text, /Refunds take five days/, 'the passage is gone from the text')
  assert.match(after.text, /Gift cards are final/, 'and the rest of the document is not')
})

// ---------------------------------------------------------------- edited by hand

/** Read the flag straight off the row: this is about the column, not about a view of it. */
const editedAt = async (id) => {
  const { one } = await import('../src/server/db.ts')
  return (await one(`SELECT edited_at FROM documents WHERE id = ?`, id)).edited_at
}

test('editing a crawled page marks it, and reindexing it does not', async () => {
  /*
   * The second half is the point. The cheap detector for "edited by hand" is
   * updated_at > the crawl's finished_at, and reindex() bumps updated_at without changing a
   * word -- so every page in a base would read as edited the moment anybody reindexed, and a
   * warning that fires on nothing is the warning people click through.
   */
  const filed = await kb.store(ws, {
    source: 'url',
    uri: 'https://example.test/programmes',
    title: 'Programmes',
    mime: 'text/html',
    baseId: base,
    text: 'We run a Diploma in Fashion Business. We also run the AI-Mastery Workshop.',
  })
  assert.equal(await editedAt(filed.documentId), null, 'a freshly crawled page is not an edit')

  await kb.saveText(ws, filed.documentId, 'We run a Diploma in Fashion Business.')
  const marked = await editedAt(filed.documentId)
  assert.ok(marked, 'editing the text should mark the page')

  await kb.reindex(ws, filed.documentId)
  assert.deepEqual(await editedAt(filed.documentId), marked, 'reindexing is not an edit')
})

test('crawling the page again clears the mark, because the edit is gone with it', async () => {
  const filed = await kb.store(ws, {
    source: 'url',
    uri: 'https://example.test/fees',
    title: 'Fees',
    mime: 'text/html',
    baseId: base,
    text: 'The fee is four hundred dollars and the course runs for three days.',
  })
  await kb.saveText(ws, filed.documentId, 'The course runs for three days.')
  assert.ok(await editedAt(filed.documentId), 'set up: the page is edited')

  // The same address, the live text back. This is the branch a re-crawl takes.
  await kb.store(ws, {
    source: 'url',
    uri: 'https://example.test/fees',
    title: 'Fees',
    mime: 'text/html',
    baseId: base,
    text: 'The fee is four hundred dollars and the course runs for three days.',
  })
  assert.equal(
    await editedAt(filed.documentId),
    null,
    'a crawl replaced the text, so the page is no longer carrying an edit',
  )
})

test('cutting a passage out counts as editing the page', async () => {
  // removePassage ends in saveText, so this should follow for free -- and if somebody ever
  // gives it its own UPDATE, this is what notices.
  const filed = await kb.store(ws, {
    source: 'url',
    uri: 'https://example.test/about',
    title: 'About',
    mime: 'text/html',
    baseId: base,
    /*
     * Comfortably over the 1200-character chunk size, so this is cut into more than one
     * passage. removePassage refuses to empty a document, so a single-passage one cannot
     * exercise this at all — which is what the assertion below is guarding.
     */
    text: [
      `We opened in 1998. ${'We have taught apparel design, footwear design and fashion business ever since. '.repeat(12)}`,
      `We run the AI-Mastery Workshop every weekend. ${'It is for freelancers and solopreneurs building a one-person business. '.repeat(12)}`,
      `Our trainers come from industry. ${'Most of them still practise, which keeps the coursework close to what studios ask for. '.repeat(12)}`,
    ].join('\n\n'),
  })
  const passages = await kb.passagesOf(ws, filed.documentId)
  assert.ok(passages.length > 1, `needs more than one passage to cut from, got ${passages.length}`)
  await kb.removePassage(ws, passages[0].id)
  assert.ok(await editedAt(filed.documentId), 'cutting a passage edits the document text')
})

// ---------------------------------------------------------------- finding the sentence

test('searching the base finds the passage that says it, and says which page', async () => {
  const filed = await kb.store(ws, {
    source: 'url',
    uri: 'https://example.test/catalogue',
    title: 'Course catalogue',
    mime: 'text/html',
    baseId: base,
    text: `Part Time: a 64-hour immersive programme. ${'Every intake is taught in the evening by working practitioners. '.repeat(20)}`,
  })

  const { hits, more } = await kb.findPassages(ws, base, '64-hour')
  assert.equal(more, false)
  assert.ok(hits.length >= 1, 'the words are in there, so they should be found')
  assert.equal(hits[0].document_id, filed.documentId, 'and the hit names the page holding them')
  assert.equal(hits[0].title, 'Course catalogue')
  assert.equal(hits[0].uri, 'https://example.test/catalogue')
  assert.match(hits[0].excerpt, /64-hour/, 'with the matched words in what it shows')

  const none = await kb.findPassages(ws, base, 'kayaking in Norway')
  assert.deepEqual(none, { hits: [], more: false }, 'and nothing it does not say')
})

test('a page is found by its title as well as its words', async () => {
  await kb.store(ws, {
    source: 'text',
    uri: null,
    title: 'Refund timelines',
    mime: null,
    baseId: base,
    // Not a word of the title in the body: a title-only match has to be its own path.
    text: `Money is back with the customer inside five working days. ${'We confirm the parcel first. '.repeat(20)}`,
  })
  const { hits } = await kb.findPassages(ws, base, 'Refund timelines')
  assert.ok(
    hits.some((h) => h.title === 'Refund timelines'),
    'the page somebody named after the thing should be findable by that name',
  )
})

test('a percent sign is searched for, not treated as a wildcard', async () => {
  /*
   * This was broken and silent. The query was ILIKE with the needle's % and _ escaped by
   * hand, and both the escaping and the ESCAPE clause were wrong -- Postgres reads ESCAPE ''
   * as "no escape character" rather than rejecting it, so "50%" matched everything and the
   * page reported passages that did not contain it.
   */
  await kb.store(ws, {
    source: 'text',
    uri: null,
    title: 'Deposit',
    mime: null,
    baseId: base,
    text: `A deposit of 50% holds a place. ${'The balance is due before the first session begins. '.repeat(20)}`,
  })

  const real = await kb.findPassages(ws, base, '50%')
  assert.ok(
    real.hits.length >= 1 && real.hits.every((h) => /50%/.test(h.excerpt)),
    'the characters somebody typed are the characters that are matched',
  )

  const wild = await kb.findPassages(ws, base, 'depos%t')
  assert.equal(wild.hits.length, 0, 'a percent in the middle matches nothing, because it is a percent')
})

test('a search stays inside the base it was run in', async () => {
  const other = await bases.create(ws, 'Somewhere else', '')
  await kb.store(ws, {
    source: 'text',
    uri: null,
    title: 'Other base',
    mime: null,
    baseId: other.id,
    text: `The password is hunter2 and it is written down nowhere else. ${'This sentence is here to make the document long enough to chunk. '.repeat(20)}`,
  })

  assert.equal((await kb.findPassages(ws, base, 'hunter2')).hits.length, 0, 'one base cannot read another one')
  assert.ok((await kb.findPassages(ws, other.id, 'hunter2')).hits.length >= 1, 'and the base holding it can')
})
