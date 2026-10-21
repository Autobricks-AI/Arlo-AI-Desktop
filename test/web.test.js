/**
 * Web chat, once a workspace can run more than one site.
 *
 * What matters here is the key: it is public, it is in the page source of every visitor,
 * and it is the only thing that decides which workspace an anonymous question opens. So
 * one key must name exactly one widget, removing a widget must take its key with it, and
 * two widgets must not share a thread just because a visitor has one browser.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('web')
const auth = await import('../src/server/auth.ts')
const web = await import('../src/server/channels/web.ts')
const convo = await import('../src/server/conversations.ts')
const customers = await import('../src/server/customers.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('web@example.com')).workspaceId

test('a new workspace starts with one working snippet', async () => {
  const widgets = await web.list(ws)
  assert.equal(widgets.length, 1)
  assert.equal(widgets[0].label, 'Website')
  assert.ok(widgets[0].key.length >= 16, 'the public key must not be guessable')
})

test('a second site gets its own key, and each key resolves to its own widget', async () => {
  const { id } = await web.add(ws, 'Docs site')
  const widgets = await web.list(ws)
  assert.equal(widgets.length, 2)
  assert.equal(new Set(widgets.map((w) => w.key)).size, 2)

  for (const w of widgets) {
    const found = await web.forKey(w.key)
    assert.equal(found.id, w.id)
    assert.equal(found.workspace_id, ws)
  }
  assert.equal(widgets.find((w) => w.id === id).label, 'Docs site')
})

test('one visitor on two sites is two conversations', async () => {
  const [a, b] = await web.list(ws)
  const visitor = 'v'.repeat(24)
  const customer = await customers.identify(ws, { channel: 'web', externalId: visitor })

  const first = await convo.open(ws, customer.id, 'web', `${a.id}:${visitor}`)
  const second = await convo.open(ws, customer.id, 'web', `${b.id}:${visitor}`)
  assert.notEqual(first.id, second.id)
})

test('removing a site takes its key with it, and leaves the others alone', async () => {
  const [a, b] = await web.list(ws)
  await web.remove(ws, b.id)
  assert.ok(!(await web.forKey(b.key)), 'a removed widget key must stop resolving')
  assert.equal((await web.forKey(a.key)).id, a.id)
})

test('another workspace cannot remove this one\'s widget', async () => {
  const other = (await auth.provisionUser('web-other@example.com')).workspaceId
  const [mine] = await web.list(ws)
  await assert.rejects(() => web.remove(other, mine.id), /No such widget/)
  // Its own default widget is all it can see.
  assert.deepEqual((await web.list(other)).map((w) => w.label), ['Website'])
})

test('removing a widget takes its chats and leaves the other widget alone', async () => {
  /*
   * A conversation carries the connection it arrived on. Remove the widget and the key stops
   * resolving, so those threads cannot be answered or reopened — they used to stay in the
   * inbox anyway, as rows whose only possible outcome was an error.
   *
   * The second widget is the point of the test: the delete is scoped by connection, and a
   * predicate that got that wrong would take the whole workspace's chats with it.
   */
  const { one } = await import('../src/server/db.ts')

  const doomed = await web.add(ws, 'Going')
  const spared = await web.add(ws, 'Staying')
  const who = await customers.identify(ws, { channel: 'web', externalId: 'widget-remove' })

  const a = await convo.open(ws, who.id, 'web', `${doomed.id}:visitor-1`)
  const b = await convo.open(ws, who.id, 'web', `${spared.id}:visitor-2`)
  await convo.record(ws, a.id, { direction: 'in', body: 'on the doomed widget', speaker: 'customer' })
  await convo.record(ws, b.id, { direction: 'in', body: 'on the other one', speaker: 'customer' })

  await web.remove(ws, doomed.id)

  assert.equal(await convo.get(ws, a.id), undefined, 'its own chats go')
  assert.ok(await convo.get(ws, b.id), 'and only its own')
  assert.equal(
    (await one(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ?`, a.id)).n,
    0,
    'messages cascade with the conversation',
  )

  // The person is not the widget they happened to write in on.
  assert.ok(await customers.get(ws, who.id))
})
