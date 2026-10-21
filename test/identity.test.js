/**
 * Working out whose support desk this is.
 *
 * The failure it exists to stop: a greeting retrieves nothing, so a bot with an empty base
 * prompt answers "I am an AI support agent for this company" — to a customer who is
 * standing on that company's website.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('identity')
const auth = await import('../src/server/auth.ts')
const kb = await import('../src/server/kb.ts')
const bots = await import('../src/server/bot.ts')
const { companyIdentity } = await import('../src/server/identity.ts')
const { one } = await import('../src/server/db.ts')
test.after(() => db_.drop())

const bases = await import('../src/server/bases.ts')
const ws = (await auth.provisionUser('identity@example.com')).workspaceId
const base = (await bases.first(ws)).id

// ---------------------------------------------------------------- the stubbed model

const realFetch = globalThis.fetch
let calls = 0
let answer = { name: 'Brightbar Nutrition', summary: 'sells protein bars in Singapore' }

function stubModel() {
  process.env.AUTOBRICKS_API_KEY = 'test-key'
  calls = 0
  globalThis.fetch = async (_url, init) => {
    // Storing a document also asks the model to extract a graph, so only the call this
    // file is about is counted — and the other one is answered with something valid.
    const asked = JSON.parse(init.body).response_format?.json_schema?.name
    if (asked === 'identity') calls++
    const content = asked === 'identity' ? JSON.stringify(answer) : JSON.stringify({ entities: [], edges: [] })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
test.after(() => {
  globalThis.fetch = realFetch
  process.env.AUTOBRICKS_API_KEY = ''
})

const store = (title, text) => kb.store(ws, { baseId: base, source: 'upload', uri: null, title, mime: 'text/plain', text })

test('an empty knowledge base has no identity, and is not asked about twice', async () => {
  stubModel()
  assert.equal(await companyIdentity(ws), null)
  // Stamped even when the answer is nothing, or every message would pay for a model call.
  assert.equal(calls, 0, 'there was nothing to read, so nothing should have been sent')
  assert.ok((await one(`SELECT identity_at FROM workspaces WHERE id = ?`, ws)).identity_at)
})

test('the company is read out of its own documents, and then cached', async () => {
  stubModel()
  await store('About us', 'Brightbar Nutrition makes protein bars in Singapore. We ship across South East Asia.')

  assert.equal(await companyIdentity(ws), 'Brightbar Nutrition — sells protein bars in Singapore')
  assert.equal(calls, 1)

  // Second call is the cache, not the model.
  assert.equal(await companyIdentity(ws), 'Brightbar Nutrition — sells protein bars in Singapore')
  assert.equal(calls, 1, 'the summary was derived twice for an unchanged knowledge base')
})

test('filing something new makes it stale, and it is worked out again', async () => {
  stubModel()
  answer = { name: 'Brightbar Nutrition', summary: 'sells protein bars and shakes in Singapore' }
  await store('Products', 'Our shakes come in three flavours.')

  assert.equal(await companyIdentity(ws), 'Brightbar Nutrition — sells protein bars and shakes in Singapore')
  assert.equal(calls, 1, 'a changed knowledge base should be re-read exactly once')
})

test('material that never names the company yields nothing rather than a guess', async () => {
  stubModel()
  answer = { name: '   ', summary: 'a company that sells things' }
  await store('Shipping', 'Orders ship within two days.')

  // "A company that sells things" is worse than saying nothing: it reads as knowledge.
  assert.equal(await companyIdentity(ws), null)
})

test('the identity reaches the system prompt, as background rather than as evidence', async () => {
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo' }))
  const withIdentity = bots.prompt(bot, 'Brightbar Nutrition — sells protein bars in Singapore')

  assert.match(withIdentity, /on behalf of Brightbar Nutrition/)
  // It must not become something the bot answers questions from.
  assert.match(withIdentity, /never present it/i)
  // And without one, nothing is invented in its place.
  assert.match(bots.prompt(bot, null), /on behalf of this company/)
})

test('another workspace derives its own, and never sees this one s', async () => {
  stubModel()
  answer = { name: 'Other Co', summary: 'does something else' }
  const other = (await auth.provisionUser('identity-other@example.com')).workspaceId
  const otherBase = (await bases.first(other)).id
  await kb.store(other, { baseId: otherBase, source: 'upload', uri: null, title: 'About', mime: 'text/plain', text: 'Other Co does something else.' })

  const before = (await one(`SELECT identity FROM workspaces WHERE id = ?`, ws)).identity

  assert.equal(await companyIdentity(other), 'Other Co — does something else')
  // One workspace working out who it is must not touch what another one knows.
  assert.equal((await one(`SELECT identity FROM workspaces WHERE id = ?`, ws)).identity, before)
})

test('a paragraph that restates the name is cut down to an introduction', async () => {
  const { tighten } = await import('../src/server/identity.ts')

  // What a model actually returns when asked for one sentence.
  assert.equal(
    tighten('Brightbar Nutrition', 'Brightbar Nutrition is a company that sells protein bars in Singapore. It also ships to Malaysia.'),
    'a company that sells protein bars in Singapore',
  )
  // A sentence that does not open with the name is left alone.
  assert.equal(tighten('Brightbar Nutrition', 'Makes protein bars in Singapore.'), 'Makes protein bars in Singapore')
  // And nothing is ever long enough to crowd the passages out of the prompt.
  assert.ok(tighten('X', 'y '.repeat(400)).length <= 160)
})

test('an identity somebody typed is never overwritten by the documents', async () => {
  const { setCompanyIdentity, useDerived } = await import('../src/server/identity.ts')
  stubModel()
  answer = { name: 'Derived Co', summary: 'sells whatever the crawl said' }

  assert.equal(await setCompanyIdentity(ws, '  Brightbar  —  the bar people  '), 'Brightbar — the bar people')

  // A crawl lands. The typed line stands, and no model call is made to second-guess it.
  await store('New page', 'Another page about the company.')
  assert.equal(await companyIdentity(ws), 'Brightbar — the bar people')
  assert.equal(calls, 0)

  // Asking for the guess back reads the knowledge base again, once.
  assert.equal(await useDerived(ws), 'Derived Co — sells whatever the crawl said')
  assert.equal(calls, 1)
})

test('clearing the box means read it again, not answer for nobody', async () => {
  const { setCompanyIdentity } = await import('../src/server/identity.ts')
  stubModel()
  answer = { name: 'Read Again Co', summary: 'is back to being derived' }

  await setCompanyIdentity(ws, 'Typed')
  assert.equal(await setCompanyIdentity(ws, '   '), 'Read Again Co — is back to being derived')
  assert.equal((await one(`SELECT identity_manual FROM workspaces WHERE id = ?`, ws)).identity_manual, false)
})
