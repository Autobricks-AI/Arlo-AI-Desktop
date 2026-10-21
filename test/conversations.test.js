/**
 * Threads: opening one, filing into it, and merging two into one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('conversations')
const auth = await import('../src/server/auth.ts')
const convo = await import('../src/server/conversations.ts')
const customers = await import('../src/server/customers.ts')
const { run } = await import('../src/server/db.ts')

const ws = (await auth.provisionUser('conversations@example.com')).workspaceId

test.after(() => db_.drop())

let n = 0
/** One person, split across two threads the way a duplicated account splits them. */
async function split() {
  const customer = await customers.identify(ws, { channel: 'web', externalId: `merge-${++n}` })
  const keep = await convo.open(ws, customer.id, 'web', `a${n}`)
  const drop = await convo.open(ws, customer.id, 'web', `b${n}`)
  await convo.record(ws, keep.id, { direction: 'in', body: 'hey' })
  await convo.record(ws, drop.id, { direction: 'in', body: 'hey again' })
  return { keep, drop }
}

test('merging takes the later watermark from either side, and never nulls it', async () => {
  // The dropped conversation was read for training more recently than the one that survives.
  const { keep, drop } = await split()
  await run(`UPDATE conversations SET harvested_at = '2026-01-01T00:00:00Z' WHERE id = ?`, keep.id)
  await run(`UPDATE conversations SET harvested_at = '2026-06-01T00:00:00Z' WHERE id = ?`, drop.id)

  await convo.merge(ws, keep.id, drop.id)

  const merged = await convo.get(ws, keep.id)
  assert.equal(new Date(merged.harvested_at).toISOString(), '2026-06-01T00:00:00.000Z', 'should take the later of the two, not the keeper\'s own')
  assert.equal(await convo.get(ws, drop.id), undefined, 'the dropped conversation should be gone')
  assert.equal((await convo.messages(ws, keep.id)).length, 2, 'both threads\' messages should now be on the survivor')
})

test('merging never nulls a real watermark, even when the dropped side never had one', async () => {
  const { keep, drop } = await split()
  await run(`UPDATE conversations SET harvested_at = '2026-01-01T00:00:00Z' WHERE id = ?`, keep.id)
  // drop.harvested_at stays NULL — never read.

  await convo.merge(ws, keep.id, drop.id)

  const merged = await convo.get(ws, keep.id)
  assert.equal(new Date(merged.harvested_at).toISOString(), '2026-01-01T00:00:00.000Z', 'a real watermark must survive a merge with a never-read side')
})

/**
 * Finding one thread in a full inbox.
 *
 * The box has to answer a name and a number with the same keystrokes, because the person
 * using it does not know which field a number is filed under — and for a customer nobody
 * has filled in a CRM record for, the number is only in the thread's own address.
 */
test('the inbox can be searched by who the thread is with', async () => {
  const perry = await customers.identify(ws, { channel: 'whatsapp', externalId: 'find-perry@s.whatsapp.net' })
  await customers.update(ws, perry.id, { name: 'Perry Tan', phone: '+6598765432' })
  const named = await convo.open(ws, perry.id, 'whatsapp', 'wc_find01:6598765432')

  // Nobody has named this one, so their number exists only in the thread reference.
  const stranger = await customers.identify(ws, { channel: 'whatsapp', externalId: 'find-nobody@s.whatsapp.net' })
  const anonymous = await convo.open(ws, stranger.id, 'whatsapp', 'wc_find01:6599990000')

  const byName = await convo.inbox(ws, { find: 'perry' })
  assert.deepEqual(byName.rows.map((r) => r.id), [named.id])
  assert.equal(byName.total, 1, 'the count has to agree with the rows, or the pager lies')

  // A fragment, the way somebody types the part of a number they remember.
  assert.deepEqual((await convo.inbox(ws, { find: '8765' })).rows.map((r) => r.id), [named.id])

  // Only in the channel_ref, which is the arm that exists for exactly this case.
  assert.deepEqual((await convo.inbox(ws, { find: '9999' })).rows.map((r) => r.id), [anonymous.id])

  // Nothing matching is an empty inbox, not an error or everything.
  assert.equal((await convo.inbox(ws, { find: 'nobody by that name' })).total, 0)

  // A blank needle is no filter at all, not a match on the empty string.
  assert.ok((await convo.inbox(ws, { find: '   ' })).total >= 2)

  // A wildcard is a literal, or searching for a percent sign hands back the whole inbox.
  assert.equal((await convo.inbox(ws, { find: '%' })).total, 0)
})

/**
 * The WhatsApp 24-hour window, which is the one clock `last_at` cannot keep.
 *
 * `record()` advances `last_at` on every message either way, so a thread we answered a
 * minute ago reads as a minute old however long it has been since the customer wrote. A test
 * written against `last_at` would pass while the feature was broken, which is the only
 * reason this one is worth having.
 */
test('a thread knows when the customer last wrote, which our own replies do not change', async () => {
  const them = await customers.identify(ws, { channel: 'whatsapp', externalId: 'window-1@s.whatsapp.net' })
  const thread = await convo.open(ws, them.id, 'whatsapp', 'wc_win01:6580000011')
  await convo.record(ws, thread.id, { direction: 'in', body: 'are you open Saturday?', at: '2026-10-01T02:00:00Z' })

  const asked = (await convo.inbox(ws, { find: '6580000011' })).rows[0]
  assert.equal(new Date(asked.last_in_at).toISOString(), '2026-10-01T02:00:00.000Z')

  // Answering moves last_at and must not move this. The whole window turns on the difference.
  await convo.record(ws, thread.id, { direction: 'out', body: 'We are.', speaker: 'team' })
  const after = (await convo.inbox(ws, { find: '6580000011' })).rows[0]
  assert.equal(new Date(after.last_in_at).toISOString(), '2026-10-01T02:00:00.000Z')
  assert.ok(new Date(after.last_at) > new Date(after.last_in_at), 'last_at followed the reply')
})

test('the cold filter is WhatsApp Business only, and counts what it lists', async () => {
  const old = '2026-01-01T00:00:00Z'

  const a = await customers.identify(ws, { channel: 'whatsapp', externalId: 'cold-biz@s.whatsapp.net' })
  const biz = await convo.open(ws, a.id, 'whatsapp', 'wc_win02:6580000012')
  await convo.record(ws, biz.id, { direction: 'in', body: 'hello?', at: old })

  // The same channel on a linked handset. WhatsApp Web enforces no window at all, so this
  // one is not cold however long ago they wrote — the connector decides, not the channel.
  const b = await customers.identify(ws, { channel: 'whatsapp', externalId: 'cold-handset@s.whatsapp.net' })
  const handset = await convo.open(ws, b.id, 'whatsapp', 'fed0d934:6580000013')
  await convo.record(ws, handset.id, { direction: 'in', body: 'hello?', at: old })

  // A Business thread nobody has ever written in on: a window was never opened, so only a
  // template has ever reached them — which is what cold means.
  const c = await customers.identify(ws, { channel: 'whatsapp', externalId: 'cold-silent@s.whatsapp.net' })
  const silent = await convo.open(ws, c.id, 'whatsapp', 'wc_win02:6580000014')
  await convo.record(ws, silent.id, { direction: 'out', body: 'a broadcast', speaker: 'team' })

  // And one inside the window.
  const d = await customers.identify(ws, { channel: 'whatsapp', externalId: 'cold-warm@s.whatsapp.net' })
  const warm = await convo.open(ws, d.id, 'whatsapp', 'wc_win02:6580000015')
  await convo.record(ws, warm.id, { direction: 'in', body: 'just now' })

  const gone = await convo.inbox(ws, { cold: true })
  const ids = gone.rows.map((r) => r.id)
  assert.ok(ids.includes(biz.id), 'a Business thread past 24 hours is cold')
  assert.ok(ids.includes(silent.id), 'so is one that never had an inbound message')
  assert.ok(!ids.includes(handset.id), 'a linked handset has no window to be past')
  assert.ok(!ids.includes(warm.id), 'and neither has one answered an hour ago')
  assert.equal(gone.total, ids.length, 'the count and the rows have to agree, or the pager lies')

  // The other way round, which is the same clause and must not be the same answer.
  const live = (await convo.inbox(ws, { cold: false })).rows.map((r) => r.id)
  assert.ok(live.includes(warm.id) && live.includes(handset.id))
  assert.ok(!live.includes(biz.id))
})

test('the inbox can be narrowed to particular connections', async () => {
  /*
   * One mechanism for two questions: "only this number" is a list of one, and "only WhatsApp
   * Business" is the list of connections that connector owns. Both are the id in front of a
   * `channel_ref`, which is the only thing the conversation itself records.
   */
  const customers = await import('../src/server/customers.ts')
  const person = await customers.identify(ws, { channel: 'whatsapp', externalId: 'conn-filter@s.whatsapp.net' })

  const cloud = await convo.open(ws, person.id, 'whatsapp', 'wc_abc123:6598765432')
  const handset = await convo.open(ws, person.id, 'whatsapp', 'fed0d934:6598765433')

  const onlyCloud = await convo.inbox(ws, { connections: ['wc_abc123'] })
  const ids = onlyCloud.rows.map((r) => r.id)
  assert.ok(ids.includes(cloud.id), 'the Business thread is there')
  assert.ok(!ids.includes(handset.id), 'the handset thread is not')

  // Both connectors are the same channel, so a channel filter cannot tell them apart — which is
  // the whole reason this filter exists.
  const byChannel = await convo.inbox(ws, { channel: 'whatsapp' })
  const both = byChannel.rows.map((r) => r.id)
  assert.ok(both.includes(cloud.id) && both.includes(handset.id))

  // An empty list is the same request as no list, not a request for nothing.
  const unfiltered = await convo.inbox(ws, { connections: [] })
  assert.ok(unfiltered.total >= byChannel.total)
})
