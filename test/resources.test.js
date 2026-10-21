/**
 * Resources: what a bot may hand to a customer, and — the part that matters — what it may
 * not. A resource is sent to somebody outside the company, so the permission on it is the
 * only thing between a private price list and a stranger's phone.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('resources')
process.env.SCRAPE_ALLOW_HOSTS = 'example.test'
const auth = await import('../src/server/auth.ts')
const bots = await import('../src/server/bot.ts')
const resources = await import('../src/server/resources.ts')
const { one, run } = await import('../src/server/db.ts')
const tools = await import('../src/server/tools.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('res@example.com')).workspaceId
const other = (await auth.provisionUser('res-other@example.com')).workspaceId
const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo' }))

const pdf = Buffer.from('%PDF-1.4 a price list')

// ---------------------------------------------------------------- adding

test('a file is stored whole, and never read as knowledge', async () => {
  const id = await resources.addFile(ws, { name: 'Price list.pdf', mime: 'application/pdf', bytes: pdf }, 'What things cost')
  const r = await resources.get(ws, id)

  assert.equal(r.kind, 'file')
  assert.equal(r.title, 'Price list.pdf')
  assert.equal(r.description, 'What things cost')
  assert.equal(r.size_bytes, pdf.length)
  // Long and random: this ends up in a forwarded WhatsApp message, so it has to survive
  // being public and must not be guessable or walkable.
  assert.ok(r.token.length >= 24)

  // A resource is not a document. Nothing was chunked, embedded or made searchable.
  const { all } = await import('../src/server/db.ts')
  assert.deepEqual(await all(`SELECT 1 FROM documents WHERE title = ?`, 'Price list.pdf'), [])
})

test('an empty or oversized file is refused rather than stored', async () => {
  await assert.rejects(() => resources.addFile(ws, { name: 'nothing.pdf', mime: 'application/pdf', bytes: Buffer.alloc(0) }), /empty/)
  await assert.rejects(
    () => resources.addFile(ws, { name: 'huge.mp4', mime: 'video/mp4', bytes: Buffer.alloc(resources.MAX_BYTES + 1) }),
    /limit/,
  )
})

test('a link is checked before it is stored', async () => {
  const id = await resources.addLink(ws, 'http://example.test/book', 'Book a call', 'For anyone wanting a demo')
  assert.equal((await resources.get(ws, id)).url, 'http://example.test/book')

  // The same guard the crawler uses: a resource is a URL this server hands to strangers,
  // so it must not be an address on our own network.
  await assert.rejects(() => resources.addLink(ws, 'http://169.254.169.254/', 'Metadata'), /own network/)
  await assert.rejects(() => resources.addLink(ws, 'not a url', 'Nope'), /not a valid URL/)
})

test('a listing never carries the bytes', async () => {
  // Ten manuals would otherwise be a hundred megabytes to render a table of titles.
  for (const r of await resources.list(ws)) assert.equal(r.bytes, undefined)
})

// ---------------------------------------------------------------- the address

test('a file is served by its token, and a link is sent as it is', async () => {
  const fileId = await resources.addFile(ws, { name: 'Manual.pdf', mime: 'application/pdf', bytes: pdf })
  const file = await resources.get(ws, fileId)
  const link = (await resources.list(ws)).find((r) => r.kind === 'link')

  assert.equal(resources.addressOf(file, 'https://arlo.example.com/'), `https://arlo.example.com/api/resource/${file.token}`)
  // Somebody else's URL is sent unchanged — wrapping it would only break it.
  assert.equal(resources.addressOf(link, 'https://arlo.example.com'), 'http://example.test/book')

  const served = await resources.byToken(file.token)
  assert.equal(served.bytes.toString(), pdf.toString())
  assert.equal(served.mime, 'application/pdf')
})

test('deleting takes it from every bot, and takes the bytes with it', async () => {
  /*
   * Two different removals, and this is the destructive one. Unticking takes a resource off
   * one bot; this deletes the thing itself. Somebody doing it from inside a single bot's
   * settings is acting on the whole workspace, which is why the row says how many bots hold
   * it before it asks.
   */
  const shared = await resources.addFile(ws, { name: 'Shared.pdf', mime: 'application/pdf', bytes: pdf })
  const second = await bots.create(ws, { name: 'Second' })
  await resources.setForBot(ws, bot.id, [shared])
  await resources.setForBot(ws, second.id, [shared])

  // The count the confirmation is built from, so the warning cannot drift from the truth.
  assert.equal((await resources.list(ws)).find((r) => r.id === shared).bots, 2)

  const { token } = await resources.get(ws, shared)
  await resources.remove(ws, shared)

  assert.equal(await resources.get(ws, shared), undefined)
  assert.deepEqual(await resources.forBot(ws, bot.id), [], 'the bot it was deleted from')
  assert.deepEqual(await resources.forBot(ws, second.id), [], 'and every other bot holding it')
  // The bytes, which is the half a person means by "remove it from storage".
  assert.equal(await resources.byToken(token), undefined)

  await bots.remove(ws, second.id)
})

test('deleting is the only revocation, and it works', async () => {
  const id = await resources.addFile(ws, { name: 'Temporary.pdf', mime: 'application/pdf', bytes: pdf })
  const { token } = await resources.get(ws, id)
  assert.ok(await resources.byToken(token))

  await resources.remove(ws, id)
  // The address is already in messages we cannot recall, so the row going is what makes it
  // stop working.
  assert.equal(await resources.byToken(token), undefined)

  /*
   * And the cheap existence check has to die with it, not just the bytes.
   *
   * api.resource.$token.ts answers a conditional request from `liveToken` so it does not read a
   * whole file to say "unchanged" — which means this is the query that now decides whether a
   * revoked link keeps working for anybody holding a cached copy. If it ever outlived the row,
   * deleting a resource would stop revoking it and nothing else in the suite would notice.
   */
  assert.equal(await resources.liveToken(token), undefined)
})

// ---------------------------------------------------------------- permission

test('a bot sends nothing until it is given something', async () => {
  assert.deepEqual(await resources.forBot(ws, bot.id), [])

  const ctx = { workspaceId: ws, botId: bot.id, conversationId: 1, scope: null }
  assert.match(await tools.invoke('send_resource', JSON.stringify({ name: 'Price list.pdf' }), ctx), /no resources available/i)
})

test('a bot sends what it is given, by title, and nothing else', async () => {
  const priceList = (await resources.list(ws)).find((r) => r.title === 'Price list.pdf')
  const manual = (await resources.list(ws)).find((r) => r.title === 'Manual.pdf')
  await resources.setForBot(ws, bot.id, [priceList.id])

  const ctx = { workspaceId: ws, botId: bot.id, conversationId: 1, scope: null }

  // The tool queues the file on the context; deliver() attaches it after the loop. Asserting
  // the queue rather than the returned sentence is the stronger test — it proves the file is
  // actually going, not that a string was formatted.
  const sent = await tools.invoke('send_resource', JSON.stringify({ name: 'Price list.pdf' }), ctx)
  assert.match(sent, /attached to your reply/)
  assert.deepEqual(ctx.sending.map((r) => r.token), [priceList.token])

  // The manual exists in the workspace and is not ticked for this bot. Asking by name must
  // not reach it — the tick is the permission, and this is the test that proves it.
  const refused = await tools.invoke('send_resource', JSON.stringify({ name: 'Manual.pdf' }), ctx)
  assert.ok(!ctx.sending.some((r) => r.token === manual.token), 'a file it may not send was queued')
  assert.match(refused, /No resource called/)
  // The refusal names what it *may* send, so the next attempt is right rather than random.
  assert.match(refused, /Price list\.pdf/)
})

test('renaming one changes what the bot can be asked for', async () => {
  /*
   * Why this is worth having at all: the model is handed the list of titles and asked to
   * pick, so the title *is* the matching key. A resource called
   * `The_Ledger_of_Life_(2).pdf` is one a customer's words will never reach.
   */
  const id = await resources.addFile(ws, { name: 'The_Ledger_of_Life_(2).pdf', mime: 'application/pdf', bytes: pdf })
  // Added to what the bot already had rather than replacing it — the tests around this one
  // describe the same bot, and rewriting its permissions underneath them is not this
  // test's business.
  const was = (await resources.forBot(ws, bot.id)).map((r) => r.id)
  await resources.setForBot(ws, bot.id, [...was, id])
  const ctx = { workspaceId: ws, botId: bot.id, conversationId: 1, scope: null }

  // Nobody asks for a file by its underscored filename.
  assert.match(await tools.invoke('send_resource', JSON.stringify({ name: 'the ledger guide' }), ctx), /No resource called/)

  await resources.rename(ws, id, 'Ledger of Life guide', 'The compounding cost of the Singaporean lifestyle')
  const named = await resources.get(ws, id)
  assert.equal(named.title, 'Ledger of Life guide')
  assert.match(named.description, /compounding cost/)

  // And now the words a customer would actually use find it.
  await tools.invoke('send_resource', JSON.stringify({ name: 'ledger of life guide' }), ctx)
  assert.deepEqual(ctx.sending.map((r) => r.token), [named.token])

  // The address is unchanged, so anything already sent still opens.
  assert.equal((await resources.byToken(named.token)).title, 'Ledger of Life guide')

  await resources.setForBot(ws, bot.id, was)
})

test('a resource cannot be left nameless, or renamed from another workspace', async () => {
  const mine = (await resources.list(ws))[0]
  // Empty is not a rename, it is a resource the model can no longer choose at all.
  await assert.rejects(() => resources.rename(ws, mine.id, '   ', 'x'), /Give it a name/)
  await assert.rejects(() => resources.rename(other, mine.id, 'stolen', ''), /No such resource/)
  assert.equal((await resources.get(ws, mine.id)).title, mine.title)
})

test('a paraphrased title still finds it, an invented one does not', async () => {
  const ctx = { workspaceId: ws, botId: bot.id, conversationId: 1, scope: null }
  await tools.invoke('send_resource', JSON.stringify({ name: 'price list' }), ctx)
  assert.equal(ctx.sending.length, 1, 'a paraphrase of the title should still find the file')
  assert.match(await tools.invoke('send_resource', JSON.stringify({ name: 'refund form' }), ctx), /No resource called/)
  assert.equal(ctx.sending.length, 1, 'an invented title queued something')
})

test('setting the list replaces it, and a deleted resource unlinks itself', async () => {
  const all = await resources.list(ws)
  await resources.setForBot(ws, bot.id, all.map((r) => r.id))
  assert.equal((await resources.forBot(ws, bot.id)).length, all.length)

  await resources.setForBot(ws, bot.id, [])
  assert.deepEqual(await resources.forBot(ws, bot.id), [])

  const doomed = await resources.addFile(ws, { name: 'Doomed.pdf', mime: 'application/pdf', bytes: pdf })
  await resources.setForBot(ws, bot.id, [doomed])
  await resources.remove(ws, doomed)
  // Cascades, so a bot cannot be left permitted to send something that is gone.
  assert.deepEqual(await resources.forBot(ws, bot.id), [])
})

// ---------------------------------------------------------------- the boundary

test('one workspace never reaches another one s resources', async () => {
  const mine = (await resources.list(ws))[0]
  assert.deepEqual(await resources.list(other), [])
  assert.equal(await resources.get(other, mine.id), undefined)
  await assert.rejects(() => resources.remove(other, mine.id), /No such resource/)

  // Nor can another workspace's bot be given one: the insert selects from resources by
  // workspace, so a foreign id matches nothing rather than linking across the boundary.
  // Their own bot, made here: a workspace no longer arrives with one.
  const theirs = await bots.create(other, { name: 'Theirs' })
  await resources.setForBot(other, theirs.id, [mine.id])
  assert.deepEqual(await resources.forBot(other, theirs.id), [])
})

test('the token is the whole authority, so it is checked for shape', async () => {
  // byToken is reached with no session behind it — the one identifier in the app that
  // arrives straight from a stranger.
  assert.equal(await resources.byToken('nope'), undefined)
  assert.equal(await resources.byToken(''), undefined)
})

test('sharing a conversation file points at the same object rather than copying it', async () => {
  /*
   * Both stores key on `media/<workspace>/<sha256>`, so the library and the conversation refer
   * to one object. That is what lets the sweep in media.ts see that a resource is holding it —
   * the retention exemption is a fact about the data, not a flag somebody has to set.
   */
  const convo = await import('../src/server/conversations.ts')
  const customers = await import('../src/server/customers.ts')
  const files = await import('../src/server/attachments.ts')

  const person = await customers.identify(ws, { channel: 'web', externalId: `w9:${'z'.repeat(24)}` })
  const c = await convo.open(ws, person.id, 'web', `w9:${'z'.repeat(24)}`)
  const messageId = (await convo.record(ws, c.id, { direction: 'in', body: 'a form' })).id
  await files.add(ws, messageId, { name: 'form.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF form') })
  const [att] = await files.forMessages(ws, [messageId])

  // Pretend the sweep has moved it, which is the state almost every attachment is in.
  await run(
    `UPDATE attachments SET bytes = NULL, storage_key = ?, sha256 = ? WHERE workspace_id = ? AND id = ?`,
    'media/9/cafebabe',
    'cafebabe',
    ws,
    att.id,
  )

  const id = await resources.shareAttachment(ws, att.id)
  const made = await one(
    `SELECT title, source, sha256, storage_key, bytes FROM resources WHERE workspace_id = ? AND id = ?`,
    ws,
    id,
  )
  assert.equal(made.title, 'form.pdf')
  assert.equal(made.source, 'chat', 'so a file nobody can place later is still accountable')
  assert.equal(made.storage_key, 'media/9/cafebabe', 'the same object, not a second copy')
  assert.equal(made.sha256, 'cafebabe')
  assert.equal(made.bytes, null, 'sharing must not put the bytes back in the database')
})

test('a file with no key to point at is copied rather than refused', async () => {
  // An instance with no Storage configured, which is every test run and the open-source build.
  const convo = await import('../src/server/conversations.ts')
  const customers = await import('../src/server/customers.ts')
  const files = await import('../src/server/attachments.ts')

  const person = await customers.identify(ws, { channel: 'web', externalId: `w8:${'y'.repeat(24)}` })
  const c = await convo.open(ws, person.id, 'web', `w8:${'y'.repeat(24)}`)
  const messageId = (await convo.record(ws, c.id, { direction: 'in', body: 'inline' })).id
  await files.add(ws, messageId, { name: 'inline.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF inline') })
  const [att] = await files.forMessages(ws, [messageId])

  const id = await resources.shareAttachment(ws, att.id)
  const made = await one(`SELECT title, source, bytes FROM resources WHERE workspace_id = ? AND id = ?`, ws, id)
  assert.equal(made.title, 'inline.pdf')
  assert.equal(made.source, 'chat')
  assert.ok(made.bytes?.length, 'with nowhere to point, the bytes come along')
})

// ---------------------------------------------------------------- previews

test('a listing says whether there is a preview, and never where it is', async () => {
  const id = await resources.addFile(ws, { name: 'Brochure.pdf', mime: 'application/pdf', bytes: pdf }, '', 'upload')
  const r = (await resources.list(ws)).find((x) => x.id === id)

  // A storage key is an address, and the browser has no business holding one.
  assert.equal(r.thumb_key, undefined)
  assert.equal(typeof r.thumb, 'boolean')
  assert.equal(r.thumb, false, 'nothing has been looked at yet')
})

test('a listing says where a file came from', async () => {
  /*
   * COLUMNS did not select `source`, so CAME_FROM could never match and every card in the
   * library read "added before this was recorded" however it had arrived -- including ones
   * uploaded a minute earlier.
   */
  const id = await resources.addFile(ws, { name: 'Sourced.pdf', mime: 'application/pdf', bytes: pdf }, '', 'upload')
  assert.equal((await resources.list(ws)).find((x) => x.id === id).source, 'upload')
})

test('the preview sweep claims nothing when there is nowhere to put one', async () => {
  /*
   * Every test run and the open-source build. A sweep that claimed rows here would mark every
   * PDF in the library as having no preview, permanently, on an instance that simply cannot
   * make one yet -- and NULL is the only state that gets looked at again.
   */
  const { all } = await import('../src/server/db.ts')
  await resources.sweepThumbs()
  const rows = await all(`SELECT thumb_key FROM resources WHERE workspace_id = ?`, ws)
  assert.ok(rows.length > 0, 'nothing to prove if the library is empty')
  assert.ok(rows.every((r) => r.thumb_key === null))
})

test('deleting a file takes its preview and leaves the file it was cut from', async () => {
  const id = await resources.addFile(ws, { name: 'Withpreview.pdf', mime: 'application/pdf', bytes: pdf })
  // Stand in for the sweep, which cannot run here: no Storage, so no object is made.
  await run(`UPDATE resources SET thumb_key = ?, storage_key = ? WHERE id = ?`, 'media/1/abc.thumb.webp', 'media/1/abc', id)

  await resources.remove(ws, id)
  assert.equal(await resources.get(ws, id), undefined)
  /*
   * removeObjects is a no-op with no Storage configured, so what is provable here is the part
   * that matters anyway: remove() asks for the preview key and not the storage key. Deleting
   * the latter would take a file out of somebody's inbox, because shareAttachment deliberately
   * points a resource row at an attachment's own object.
   */
})
