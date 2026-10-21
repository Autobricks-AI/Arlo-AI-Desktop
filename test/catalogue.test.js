/**
 * What the company sells, and the dates it keeps.
 *
 * Both are structured so a person can edit them as themselves, and mirrored into the
 * knowledge base so the bot reads them the way it reads everything else. The mirror is the
 * part worth pinning: a price that is right in the table and stale in the document is worse
 * than no table at all.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('catalogue')
const auth = await import('../src/server/auth.ts')
const catalogue = await import('../src/server/catalogue.ts')
const kb = await import('../src/server/kb.ts')
const { retrieve } = await import('../src/server/retrieve.ts')
const bases = await import('../src/server/bases.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('catalogue@example.com')).workspaceId
/** Somebody else entirely, for the one test about not reaching into their calendar. */
const nextDoor = (await auth.provisionUser('catalogue-next-door@example.com')).workspaceId

const documentNamed = async (title) => (await kb.listDocuments(ws)).find((d) => d.title === title)

// ---------------------------------------------------------------- products

test('a product is listed, priced, and readable as a document', async () => {
  await catalogue.addProduct(ws, {
    name: 'Vita-Boost',
    sku: 'VB-0034',
    price: 45,
    currency: 'SGD',
    unit: 'per tub',
    description: 'Ninety tablets, for water balance.',
  })
  await catalogue.addProduct(ws, { name: 'Consultation', description: 'A half hour with a coach.' })

  const rows = await catalogue.products(ws)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].price, 45)
  assert.equal(rows[1].price, null, 'no price is "on request", which 0 would not be')

  /*
   * Config, not a document.
   *
   * It used to be mirrored into the knowledge base so it could be cited. That was a loop:
   * reading a price list PDF into these rows wrote the same products straight back into
   * the base the PDF came from, leaving two copies of one price list in one base and the
   * generated one impossible to delete, because editing any product recreated it.
   */
  assert.equal(await documentNamed('Products and prices'), undefined, 'no document is generated')

  const list = await catalogue.priceList(ws)
  assert.match(list, /SGD 45[.]00 per tub/, 'the price is in the prompt, whole')
  assert.match(list, /Consultation — price on request/, 'and no price says so rather than nought')
})

test('a corrected price replaces the old one rather than sitting beside it', async () => {
  const [first] = await catalogue.products(ws)
  await catalogue.editProduct(ws, first.id, { price: 52 })

  const list = await catalogue.priceList(ws)
  assert.match(list, /52[.]00/)
  assert.ok(!/45[.]00/.test(list), 'and the old figure is gone, not kept alongside')
  // Still nothing in the knowledge base to disagree with it.
  assert.equal((await kb.listDocuments(ws)).filter((x) => x.title === 'Products and prices').length, 0)
})

test('hiding a product takes it out of what the bot reads, and keeps the row', async () => {
  const [first] = await catalogue.products(ws)
  await catalogue.editProduct(ws, first.id, { active: false })

  assert.equal((await catalogue.products(ws)).length, 2, 'a discontinued line still answers old questions')
  assert.ok(!/Vita-Boost/.test(await catalogue.priceList(ws)), 'but the bot stops quoting it')

  await catalogue.editProduct(ws, first.id, { active: true })
})

// ---------------------------------------------------------------- dates

test('a date is kept as a date and read back as a sentence', async () => {
  await catalogue.addEvent(ws, {
    title: 'Closed for Chinese New Year',
    starts_on: '2027-02-06',
    ends_on: '2027-02-08',
    detail: 'Orders placed after the 4th ship when we reopen.',
  })

  const [e] = await catalogue.events(ws)
  assert.equal(e.starts_on, '2027-02-06')
  assert.equal(e.ends_on, '2027-02-08')
  assert.equal(e.repeats, 'once')

  // Words, not ISO strings: "are you open on the 7th" is answerable from a sentence.
  const hits = await retrieve(ws, 'are you open for Chinese New Year')
  assert.ok(hits.some((h) => /6 February 2027 to 8 February 2027/.test(h.text)))
})

test('a range that ends before it starts is one day, and a bad date is refused', async () => {
  await catalogue.addEvent(ws, { title: 'Stocktake', starts_on: '2027-03-01', ends_on: '2027-02-01' })
  const stocktake = (await catalogue.events(ws)).find((e) => e.title === 'Stocktake')
  assert.equal(stocktake.ends_on, null, 'a backwards range is a typo, not a span')

  await assert.rejects(() => catalogue.addEvent(ws, { title: 'Whenever', starts_on: 'next Tuesday' }), /YYYY-MM-DD/)
  await assert.rejects(() => catalogue.addEvent(ws, { title: '  ', starts_on: '2027-01-01' }), /name/)
})

test('removing a date takes it out of the document too', async () => {
  const stocktake = (await catalogue.events(ws)).find((e) => e.title === 'Stocktake')
  await catalogue.removeEvent(ws, stocktake.id)

  const hits = await retrieve(ws, 'stocktake')
  assert.ok(!hits.some((h) => /Stocktake/.test(h.text)))
})

test('every event has a start and an end, and an hour is the default gap', async () => {
  await catalogue.addEvent(ws, { title: 'Open day', starts_on: '2027-06-01', start_time: '14:00' })
  const open = (await catalogue.events(ws)).find((e) => e.title === 'Open day')
  assert.equal(open.start_time, '14:00')
  assert.equal(open.end_time, '15:00', 'an hour, which is what anybody assumes')

  // Nothing said at all, on a single day: a working hour rather than midnight.
  await catalogue.addEvent(ws, { title: 'Deadline', starts_on: '2027-06-02' })
  const deadline = (await catalogue.events(ws)).find((e) => e.title === 'Deadline')
  assert.equal(deadline.start_time, '09:00')
  assert.equal(deadline.end_time, '10:00')

  // A span of days with no times is a whole-day thing, and says so rather than reading as
  // something that starts at midnight.
  await catalogue.addEvent(ws, { title: 'Renovation', starts_on: '2027-07-01', ends_on: '2027-07-08' })
  const reno = (await catalogue.events(ws)).find((e) => e.title === 'Renovation')
  assert.equal(reno.start_time, '00:00')
  assert.equal(reno.end_time, '23:59')

  // And the times reach what the bot reads.
  const hits = await retrieve(ws, 'what time is the open day')
  assert.ok(hits.some((h) => /from 14:00 to 15:00/.test(h.text)))
})

// ---------------------------------------------------------------- calendars

test('a workspace has one calendar to start with, and dates land on it', async () => {
  const [only] = await catalogue.calendars(ws)
  assert.equal(only.is_default, true, 'where a learned date goes when nobody said which')
  assert.ok(only.events > 0, 'and everything recorded so far is on it')
})

test('a second calendar keeps its dates, and its own document', async () => {
  /*
   * The reason there is more than one: a delivery cut-off and a workshop are answers to
   * different questions, and one merged document puts them in the same passage.
   */
  const workshops = await catalogue.addCalendar(ws, 'Workshops', 'Every session we run, and where', 'plum')
  await catalogue.addEvent(ws, {
    title: 'Knife skills evening',
    starts_on: '2027-09-14',
    start_time: '18:30',
    detail: 'Six places, at the Bras Basah studio.',
    calendar_id: workshops,
  })

  const mine = await catalogue.events(ws, workshops)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].calendar_id, workshops)

  // Everything, when no calendar is named.
  assert.ok((await catalogue.events(ws)).length > 1)

  // Its own document, named after it, so a citation says which calendar it came from.
  const doc = (await kb.listDocuments(ws)).find((d) => d.title === 'Workshops')
  assert.ok(doc, 'filed under its own name')
  const hits = await retrieve(ws, 'when is the knife skills evening')
  assert.ok(hits.some((h) => /18:30/.test(h.text)))
})

test('the default calendar cannot be deleted out from under a learned date', async () => {
  const [first] = await catalogue.calendars(ws)
  await assert.rejects(() => catalogue.removeCalendar(ws, first.id), /Make another one the default/)
})

test('deleting a calendar takes its dates and its document with it', async () => {
  const scratch = await catalogue.addCalendar(ws, 'Scratch', 'Temporary')
  await catalogue.addEvent(ws, { title: 'Nothing much', starts_on: '2027-10-01', calendar_id: scratch })
  assert.ok((await kb.listDocuments(ws)).some((d) => d.title === 'Scratch'))

  await catalogue.removeCalendar(ws, scratch)

  assert.equal((await catalogue.calendars(ws)).filter((c) => c.name === 'Scratch').length, 0)
  assert.equal((await catalogue.events(ws)).filter((e) => e.title === 'Nothing much').length, 0, 'cascaded')
  // Or the bot goes on quoting a calendar nobody can see.
  assert.ok(!(await kb.listDocuments(ws)).some((d) => d.title === 'Scratch'))
  const hits = await retrieve(ws, 'Nothing much')
  assert.ok(!hits.some((h) => /Nothing much/.test(h.text)))
})

test('moving a date between calendars rewrites both documents', async () => {
  const [home] = await catalogue.calendars(ws)
  const other = await catalogue.addCalendar(ws, 'Deliveries', 'Cut-offs and collection days', 'sky')

  const id = await catalogue.addEvent(ws, { title: 'Last post before Christmas', starts_on: '2027-12-18', calendar_id: home.id })
  await catalogue.editEvent(ws, id, { calendar_id: other })

  const moved = (await catalogue.events(ws)).find((e) => e.id === id)
  assert.equal(moved.calendar_id, other)

  const hits = await retrieve(ws, 'last post before Christmas')
  assert.ok(hits.some((h) => /Deliveries|Cut-offs/.test(h.title + h.text)), 'it reads from the new one')
})

test('a bot reads only the calendars it was given', async () => {
  /*
   * Every calendar publishes itself as an ordinary document in an ordinary knowledge base,
   * which is what makes dates answerable at all — and also what would let a bot connected
   * to that base read every calendar in it. The exclusion is by the document's own address.
   */
  const bots = await import('../src/server/bot.ts')
  const agent = await import('../src/server/agent.ts')

  const bot = await bots.create(ws, { name: 'Front desk' })
  const [home] = await catalogue.calendars(ws)
  const private_ = await catalogue.addCalendar(ws, 'Maintenance', 'When the machines are down')
  await catalogue.addEvent(ws, {
    title: 'Compressor service',
    starts_on: '2027-11-04',
    start_time: '08:00',
    calendar_id: private_,
  })

  // Everything, while it may read everything.
  await bots.save(ws, bot.id, { calendarIds: [home.id, private_], baseIds: (await bases.list(ws)).map((b) => b.id) })
  const wide = await agent.scopeFor(ws, bot.id)
  assert.ok(!(wide.notUris ?? []).includes(`catalogue:events:${private_}`))
  assert.ok((await retrieve(ws, 'compressor service', { scope: wide })).some((h) => /Compressor/.test(h.text)))

  // Take it away and the same question finds nothing, though the document still exists.
  await bots.save(ws, bot.id, { calendarIds: [home.id] })
  const narrow = await agent.scopeFor(ws, bot.id)
  // Every calendar it was not given, which by now is more than the one this test made.
  assert.ok(narrow.notUris.includes(`catalogue:events:${private_}`))
  assert.ok(!narrow.notUris.includes(`catalogue:events:${home.id}`))
  assert.ok(!(await retrieve(ws, 'compressor service', { scope: narrow })).some((h) => /Compressor/.test(h.text)))

  // And what it does have is still readable — the exclusion is one document, not a blanket.
  assert.ok((await retrieve(ws, 'open day', { scope: narrow })).length > 0)
})

test('a calendar keeps a record of what was done to it, including what is gone', async () => {
  const cal = await catalogue.addCalendar(ws, 'Openings', 'When the doors are unlocked')

  const id = await catalogue.addEvent(ws, {
    title: 'Late night Thursday',
    starts_on: '2027-05-06',
    start_time: '18:00',
    end_time: '21:00',
    calendar_id: cal,
    actor: 'sam@example.com',
  })
  await catalogue.editEvent(ws, id, { end_time: '22:00', actor: 'sam@example.com' })
  await catalogue.removeEvent(ws, id, 'someone@example.com')

  const log = await catalogue.history(ws, cal)
  assert.deepEqual(log.map((l) => l.action), ['removed', 'edited', 'added'], 'newest first')
  assert.equal(log[2].actor, 'sam@example.com')
  assert.equal(log[0].actor, 'someone@example.com')
  assert.match(log[1].detail, /18:00–22:00/, 'what it looked like after the change')

  // The event is gone and its history is not — which is the question a log gets asked.
  assert.equal((await catalogue.events(ws, cal)).length, 0)
  assert.equal(log[0].title, 'Late night Thursday')
  assert.equal(log[0].event_id, null, 'the row outlived it')
})


