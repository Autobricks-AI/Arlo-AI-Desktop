import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('customers')
const auth = await import('../src/server/auth.ts')
const customers = await import('../src/server/customers.ts')
const { run } = await import('../src/server/db.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('crm@example.com')).workspaceId

test('the same channel identity always returns the same customer', async () => {
  const first = await customers.identify(ws, { channel: 'web', externalId: 'tok-1', name: 'Ada' })
  const again = await customers.identify(ws, { channel: 'web', externalId: 'tok-1' })
  assert.equal(again.id, first.id)
  assert.equal(again.name, 'Ada')
})

test('a shared email merges two channels into one person', async () => {
  const web = await customers.identify(ws, { channel: 'web', externalId: 'tok-2', email: 'Rae@Example.com' })
  const wa = await customers.identify(ws, { channel: 'whatsapp', externalId: '+6591234567', email: 'rae@example.com' })

  assert.equal(wa.id, web.id, 'the same email should be one customer')
  const ids = await customers.identitiesOf(ws, web.id)
  assert.deepEqual(
    ids.map((i) => i.channel).sort(),
    ['web', 'whatsapp'],
  )
})

test('phone numbers are deliberately not merged on', async () => {
  // They arrive in half a dozen formats and a wrong merge joins two people's
  // conversations together — a far worse failure than one person as two records.
  const a = await customers.identify(ws, { channel: 'whatsapp', externalId: '+6580000001', phone: '+65 8000 0001' })
  const b = await customers.identify(ws, { channel: 'telegram', externalId: '9001', phone: '+65 8000 0001' })
  assert.notEqual(a.id, b.id)
})

test('a channel never overwrites what a person typed', async () => {
  const c = await customers.identify(ws, { channel: 'web', externalId: 'tok-3', name: 'auto name' })
  await customers.update(ws, c.id, { name: 'Real Name' })
  await customers.addPoint(ws, c.id, 'email', 'real@example.com')

  // The channel reports a display name and another address on the next message. Neither
  // wins: the name stands, and the address joins the list without becoming the primary.
  const again = await customers.identify(ws, { channel: 'web', externalId: 'tok-3', name: 'auto name', email: 'other@example.com' })
  assert.equal(again.name, 'Real Name')
  assert.equal(again.email, 'real@example.com')
  assert.deepEqual(
    (await customers.points(ws, c.id)).filter((p) => p.kind === 'email').map((p) => p.value).sort(),
    ['other@example.com', 'real@example.com'],
  )
})

test('a blank field is filled in by whichever channel first knows it', async () => {
  const c = await customers.identify(ws, { channel: 'web', externalId: 'tok-4' })
  assert.equal(c.email, null)
  const later = await customers.identify(ws, { channel: 'web', externalId: 'tok-4', email: 'late@example.com' })
  assert.equal(later.email, 'late@example.com')
})

test('traits merge, newest wins per key, and both are bounded', async () => {
  const c = await customers.identify(ws, { channel: 'web', externalId: 'tok-5' })
  await customers.learn(ws, c.id, { plan: 'Starter', seats: '3' })
  await customers.learn(ws, c.id, { plan: 'Pro' })

  const after = await customers.get(ws, c.id)
  assert.equal(after.traits.plan, 'Pro')
  assert.equal(after.traits.seats, '3', 'an untouched key must survive the merge')

  // These come from a model reading a customer's message, so they are trimmed rather
  // than trusted — an unbounded one would happily store a paragraph as a key.
  await customers.learn(ws, c.id, { ['  INDUSTRY  ']: '  retail  ', ['x'.repeat(100)]: 'y'.repeat(500) })
  const bounded = await customers.get(ws, c.id)
  assert.equal(bounded.traits.industry, 'retail')
  assert.equal(Object.keys(bounded.traits).find((k) => k.startsWith('xxx')).length, 40)
  assert.equal(bounded.traits['x'.repeat(40)].length, 200)
})

test('empty traits are ignored rather than written as blanks', async () => {
  const c = await customers.identify(ws, { channel: 'web', externalId: 'tok-6' })
  await customers.learn(ws, c.id, { '': 'nothing', spaces: '   ' })
  assert.deepEqual((await customers.get(ws, c.id)).traits, {})
})

test('updating somebody who is not yours is refused', async () => {
  const other = (await auth.provisionUser('crm-other@example.com')).workspaceId
  const mine = await customers.identify(ws, { channel: 'web', externalId: 'tok-7' })
  await assert.rejects(() => customers.update(other, mine.id, { name: 'stolen' }), /No such customer/)
  // And they are invisible in the listing, quite apart from the policies.
  assert.deepEqual((await customers.list(other)).rows, [])
})

test('the same external id in two workspaces is two different people', async () => {
  const other = (await auth.provisionUser('crm-third@example.com')).workspaceId
  const a = await customers.identify(ws, { channel: 'web', externalId: 'shared-token' })
  const b = await customers.identify(other, { channel: 'web', externalId: 'shared-token' })
  assert.notEqual(a.id, b.id)
})

/**
 * The contacts page reads two things: everyone, and one person's threads. Neither may
 * cross a workspace, and both are what makes "have we spoken before" answerable.
 */
test('a contact exists the moment somebody writes in, on any channel', async () => {
  const convo = await import('../src/server/conversations.ts')
  const fresh = (await auth.provisionUser('contacts@example.com')).workspaceId

  assert.deepEqual((await customers.list(fresh)).rows, [])

  const person = await customers.identify(fresh, { channel: 'whatsapp', externalId: '6591234567@s.whatsapp.net', name: 'Mei Ling' })
  const web = await convo.open(fresh, person.id, 'web', 'w1:visitor-aaaaaaaaaaaaaaaa')
  const wa = await convo.open(fresh, person.id, 'whatsapp', 'acct1:6591234567@s.whatsapp.net')
  await convo.record(fresh, wa.id, { direction: 'in', body: 'do you deliver?' })

  const [listed] = (await customers.list(fresh)).rows
  assert.equal(listed.name, 'Mei Ling')
  assert.equal(listed.conversations, 2)
  assert.deepEqual(listed.channels, ['whatsapp'])

  // Both threads, newest first, with the last thing said in each.
  const threads = await convo.byCustomer(fresh, person.id)
  assert.deepEqual(threads.map((t) => t.id), [wa.id, web.id])
  assert.equal(threads[0].last_body, 'do you deliver?')
  assert.equal(threads[0].messages, 1)

  // Editing by hand is allowed to blank a field; identify() never is.
  await customers.update(fresh, person.id, { name: 'Mei Ling Tan', first_name: 'Mei Ling', last_name: 'Tan' })
  await customers.addPoint(fresh, person.id, 'email', '  MEI@example.com ')
  const saved = await customers.get(fresh, person.id)
  assert.equal(saved.name, 'Mei Ling Tan')
  assert.equal(saved.email, 'mei@example.com')

  // And none of it is visible to anybody else.
  const other = (await auth.provisionUser('contacts-other@example.com')).workspaceId
  assert.deepEqual((await customers.list(other)).rows, [])
  assert.equal(await customers.get(other, person.id), undefined)
  assert.deepEqual(await convo.byCustomer(other, person.id), [])
  await assert.rejects(() => customers.update(other, person.id, { name: 'stolen' }), /No such customer/)
})

/**
 * A contact a salesperson can work from: several ways of reaching one person, and the
 * fields nobody can get from a push name.
 */
test('one person can have several addresses, numbers and handles', async () => {
  const ws2 = (await auth.provisionUser('points@example.com')).workspaceId
  const person = await customers.identify(ws2, { channel: 'web', externalId: 'v'.repeat(24), email: 'Kit@Example.com ' })

  // What the channel knew is already a way of reaching them, and it is the primary.
  const first = await customers.points(ws2, person.id)
  assert.deepEqual(first.map((p) => [p.kind, p.value, p.is_primary]), [['email', 'kit@example.com', true]])

  await customers.addPoint(ws2, person.id, 'email', 'KIT@work.example.com', 'work')
  await customers.addPoint(ws2, person.id, 'phone', '+65 9123 4567')
  await customers.addPoint(ws2, person.id, 'telegram', '@kitsune')
  // The same address twice is a mistake, not a second way to reach somebody.
  await customers.addPoint(ws2, person.id, 'email', 'kit@example.com')

  const points = await customers.points(ws2, person.id)
  assert.equal(points.filter((p) => p.kind === 'email').length, 2)
  assert.equal(points.filter((p) => p.kind === 'phone').length, 1)

  // The customer row keeps the primary of each kind, because a reply needs exactly one.
  assert.equal((await customers.get(ws2, person.id)).email, 'kit@example.com')
  assert.equal((await customers.get(ws2, person.id)).phone, '+65 9123 4567')

  // Promoting the work address moves what a reply is addressed to.
  const work = points.find((p) => p.value === 'kit@work.example.com')
  await customers.makePrimary(ws2, person.id, work.id)
  assert.equal((await customers.get(ws2, person.id)).email, 'kit@work.example.com')

  // Removing the primary falls back to what is left rather than leaving a gap.
  await customers.removePoint(ws2, person.id, work.id)
  assert.equal((await customers.get(ws2, person.id)).email, 'kit@example.com')

  // Another workspace can neither read nor touch any of it.
  const nosy = (await auth.provisionUser('points-other@example.com')).workspaceId
  assert.deepEqual(await customers.points(nosy, person.id), [])
  await assert.rejects(() => customers.addPoint(nosy, person.id, 'email', 'x@y.z'), /No such customer/)
  await assert.rejects(() => customers.removePoint(nosy, person.id, first[0].id), /No such contact detail/)
})

test('the fields a channel can never know are written by hand, and only the ones sent', async () => {
  const ws2 = (await auth.provisionUser('details@example.com')).workspaceId
  const person = await customers.identify(ws2, { channel: 'whatsapp', externalId: '65911@s.whatsapp.net', name: 'Mei Ling' })

  await customers.update(ws2, person.id, {
    first_name: '  Mei Ling ',
    last_name: 'Tan',
    company: 'Acme',
    date_of_birth: '1990-04-01',
    country: 'Singapore',
    tags: [' vip ', 'wholesale', 'vip', ''],
    marketing_consent: true,
  })

  let saved = await customers.get(ws2, person.id)
  assert.equal(saved.first_name, 'Mei Ling')
  assert.equal(saved.company, 'Acme')
  assert.equal(saved.marketing_consent, true)
  // Trimmed, de-duplicated, and empties dropped: tags are for filtering.
  assert.deepEqual(saved.tags, ['vip', 'wholesale'])

  // A form that shows half the record must not blank the other half by omission.
  await customers.update(ws2, person.id, { notes: 'Prefers WhatsApp.' })
  saved = await customers.get(ws2, person.id)
  assert.equal(saved.notes, 'Prefers WhatsApp.')
  assert.equal(saved.company, 'Acme')
  assert.equal(saved.first_name, 'Mei Ling')

  // The display name the channel gave us is left alone by all of it.
  assert.equal(saved.name, 'Mei Ling')
})

test('a card keeps a record of what was written to it, and by which hand', async () => {
  const who = await customers.identify(ws, { channel: 'web', externalId: 'log:1', name: 'Mei Lin' })

  await customers.update(ws, who.id, { company: 'Acme', city: 'Penang' }, { actor: 'sam@example.com' })
  // A save that submits every field writes only what moved.
  await customers.update(ws, who.id, { company: 'Acme', city: 'Ipoh' }, { actor: 'sam@example.com' })
  await customers.update(ws, who.id, { job_title: 'Buyer' }, { source: 'learned' })

  const log = await customers.history(ws, who.id)
  assert.deepEqual(
    log.map((l) => [l.action, l.field]),
    [
      ['updated', 'job_title'],
      ['updated', 'city'],
      ['updated', 'city'],
      ['updated', 'company'],
      ['created', null],
    ],
    'newest first, and the unchanged company on the second save is not a row',
  )

  const moved = log.find((l) => l.field === 'city')
  assert.equal(moved.was, 'Penang')
  assert.equal(moved.became, 'Ipoh')
  assert.equal(moved.actor, 'sam@example.com')

  // The three hands are told apart, which is the point of keeping it.
  assert.equal(log.find((l) => l.field === 'job_title').source, 'learned')
  assert.equal(log.find((l) => l.field === 'job_title').actor, null)
  assert.equal(log.at(-1).source, 'channel', 'the connector made the card')
})

// ---------------------------------------------------------------- the race

test('two concurrent messages from a brand-new identity still make one customer', async () => {
  /*
   * The bug found in the wild: a customer's own message and a WhatsApp from-me mirror (a
   * human forwarding something from the connected phone moments later) each opened their own
   * withWorkspace() transaction and called identify() for the same never-before-seen
   * identity. Both ran the SELECT before either had committed, both saw nothing, both
   * inserted a customer row — one of them a name-less, conversation-less duplicate that sat
   * in Contacts forever, because customer_identities' primary key stops the identity itself
   * splitting but nothing stopped the losing customers row from surviving.
   *
   * Reproduced here for real: one call holds its transaction open past its own identify(),
   * the way a slow retrieval-plus-model-call naturally does, while a second call for the
   * exact same identity runs concurrently. Without the advisory lock in identify(), the
   * second call's SELECT races the first call's still-open INSERT and this test fails.
   */
  const { withWorkspace } = await import('../src/server/db.ts')
  const before = (await customers.list(ws)).total

  const slow = withWorkspace({ workspaceId: ws }, async () => {
    const c = await customers.identify(ws, { channel: 'whatsapp', externalId: 'race-jid', name: 'Racer' })
    await new Promise((r) => setTimeout(r, 300))
    return c
  })
  // Fired while the first transaction is still open, mimicking the from-me mirror arriving
  // seconds into the bot's own answer.
  await new Promise((r) => setTimeout(r, 30))
  const fast = withWorkspace({ workspaceId: ws }, () =>
    customers.identify(ws, { channel: 'whatsapp', externalId: 'race-jid' }),
  )

  const [a, b] = await Promise.all([slow, fast])
  assert.equal(a.id, b.id, 'the two calls resolved to different customers')
  assert.equal((await customers.list(ws)).total, before + 1, 'a duplicate customer was created')
})

// ---------------------------------------------------------------- paging and search
//
// The contacts list used to return every row and the browser filtered it. What is proved here
// is the two things that broke when that moved into SQL: that a page boundary is stable, and
// that the search still matches the way people actually use it.

/** A workspace of its own, so the row counts here are not at the mercy of the tests above. */
const paged = (await auth.provisionUser('paging@example.com')).workspaceId

test('a page is the size asked for, and total counts everything', async () => {
  for (let i = 0; i < 12; i++)
    await customers.identify(paged, { channel: 'web', externalId: `p-${i}`, name: `Person ${i}` })

  const first = await customers.list(paged, { size: 5, page: 0 })
  assert.equal(first.rows.length, 5)
  // The total is of everything matching, not of what came back — a count that only counts the
  // visible page is the number people plan around and it would be wrong.
  assert.equal(first.total, 12)

  const last = await customers.list(paged, { size: 5, page: 2 })
  assert.equal(last.rows.length, 2)
  assert.equal(last.total, 12)
})

test('pages do not repeat or skip a row when contacts share a timestamp', async () => {
  // The failure this guards: an import backfills a phone's whole history and hands hundreds of
  // contacts the same last_seen_at. Ordering on that alone lets Postgres return equal rows in
  // any order, and any order twice — so page two skips the first N of a *different*
  // arrangement and somebody's contact silently vanishes.
  const same = (await auth.provisionUser('ties@example.com')).workspaceId
  for (let i = 0; i < 20; i++)
    await customers.identify(same, { channel: 'web', externalId: `t-${i}`, name: `Tie ${i}` })
  await run(`UPDATE customers SET last_seen_at = now() WHERE workspace_id = ?`, same)

  const seen = []
  for (let page = 0; page < 4; page++) {
    const { rows } = await customers.list(same, { size: 5, page })
    seen.push(...rows.map((r) => r.id))
  }
  assert.equal(seen.length, 20)
  assert.equal(new Set(seen).size, 20, 'every contact appears exactly once across the pages')
})

test('an out-of-range page clamps to the last one rather than coming back empty', async () => {
  // A stale ?page=900 in somebody's URL, or a filter that shrank the list under an open page.
  // An empty table with a disabled "next" is a dead end that reads as lost data.
  const far = await customers.list(paged, { size: 5, page: 900 })
  assert.equal(far.rows.length, 2, 'the last page, not nothing')
  assert.equal(far.total, 12)
})

test('search matches a substring, not just a whole word', async () => {
  const s = (await auth.provisionUser('search@example.com')).workspaceId
  await customers.identify(s, { channel: 'web', externalId: 's-1', name: 'Jasper Chen', email: 'jasper@northwind.example' })
  await customers.identify(s, { channel: 'whatsapp', externalId: '6580001111', phone: '6580001111' })
  await customers.update(s, (await customers.identify(s, { channel: 'web', externalId: 's-3', name: 'Ana' })).id, {
    company: 'Northwind Nutrition',
  })

  // A phone fragment. This is the case a tsvector would have failed, which is why the index is
  // a trigram one.
  assert.equal((await customers.list(s, { find: '8000' })).total, 1)
  // Part of an address.
  assert.equal((await customers.list(s, { find: '@northwind' })).total, 1)
  // Mid-word inside a company name.
  assert.equal((await customers.list(s, { find: 'orthwind' })).total, 2)
  // Case does not matter.
  assert.equal((await customers.list(s, { find: 'JASPER' })).total, 1)
})

test('search and paging agree on the total', async () => {
  const s = (await auth.provisionUser('agree@example.com')).workspaceId
  for (let i = 0; i < 7; i++)
    await customers.identify(s, { channel: 'web', externalId: `a-${i}`, name: `Match ${i}` })
  await customers.identify(s, { channel: 'web', externalId: 'other', name: 'Nobody' })

  const { rows, total } = await customers.list(s, { find: 'match', size: 3, page: 0 })
  assert.equal(total, 7, 'the count is of everything matching, not of the page')
  assert.equal(rows.length, 3)
})

test('a wildcard in the search is a character, not a wildcard', async () => {
  // Otherwise somebody searching for "50%" gets the whole table back and it looks like search
  // is broken rather than too clever.
  const s = (await auth.provisionUser('escape@example.com')).workspaceId
  await customers.identify(s, { channel: 'web', externalId: 'e-1', name: 'Fifty' })
  assert.equal((await customers.list(s, { find: '%' })).total, 0)
  assert.equal((await customers.list(s, { find: '_' })).total, 0)
})

test('an empty search is no search at all', async () => {
  const all = await customers.list(paged, { find: '   ' })
  assert.equal(all.total, 12, 'whitespace must not be treated as a needle every row contains')
})

test('the list carries what the table draws and not the whole record', async () => {
  // The point of the change: a 31-column row with an AI summary on it was crossing the wire
  // per contact, for a table that shows eight columns.
  const { rows } = await customers.list(paged, { size: 1 })
  const row = rows[0]
  assert.ok('name' in row && 'company' in row && 'conversations' in row && 'channels' in row)
  for (const heavy of ['summary', 'summary_points', 'traits', 'notes'])
    assert.equal(heavy in row, false, `${heavy} has no business on a list page`)
})
