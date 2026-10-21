/**
 * Where a vector comes from, and what fills in the ones that are missing.
 *
 * Two things are being pinned down. First, which key goes to which host: one key now does
 * chat and embeddings, and a key sent to the wrong endpoint is a 401 that looks like a
 * broken feature. Second, the backfill — because switching embeddings on used to make
 * retrieval quietly *worse*, one newly-embedded document hiding an entire corpus that had
 * none.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('embed')
const auth = await import('../src/server/auth.ts')
const bases = await import('../src/server/bases.ts')
const kb = await import('../src/server/kb.ts')
const embed = await import('../src/server/embed.ts')
const { all, asSystem, run } = await import('../src/server/db.ts')

const ws = (await auth.provisionUser('embed@example.com')).workspaceId
const base = (await bases.first(ws)).id

// ---------------------------------------------------------------- a stubbed provider

const realFetch = globalThis.fetch
let sent = []
/** Whatever width the provider is pretending to have this test. */
let width = 1536

function stubProvider(w = 1536) {
  width = w
  sent = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push({ url: String(url), auth: init.headers.authorization, body })
    return new Response(
      JSON.stringify({
        data: body.input.map((_, index) => ({ index, embedding: Array(width).fill(0.01) })),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

/** The environment the harness leaves behind, so each test starts from nothing. */
const clearEnv = () => {
  process.env.EMBEDDINGS_KEY = ''
  process.env.EMBEDDINGS_URL = ''
  process.env.EMBEDDINGS_MODEL = ''
  process.env.EMBEDDINGS_DIMS = ''
}

test.beforeEach(clearEnv)
test.after(() => {
  globalThis.fetch = realFetch
  clearEnv()
  return db_.drop()
})

// ---------------------------------------------------------------- which key, which host

test('with nothing configured there is no provider and no request', async () => {
  stubProvider()
  assert.equal(embed.configured(), false)
  assert.equal(await embed.embed(['anything']), null)
  assert.equal(sent.length, 0, 'the whole product works offline, and quietly')
})

test('both, or neither — a key alone is not permission to send it somewhere', async () => {
  /*
   * This is the one call in the app that can be pointed at a provider other than Autobricks,
   * so it fires only when somebody has written down both halves: a key on its own, or an
   * address on its own, does nothing.
   *
   * It used to borrow whatever chat key was lying around, which was one variable away from
   * quietly posting the workspace's own credential to a third party nobody named.
   */
  stubProvider()
  process.env.EMBEDDINGS_KEY = 'sk-own'
  assert.equal(embed.configured(), false, 'a key with nowhere to send it')

  process.env.EMBEDDINGS_KEY = ''
  process.env.EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
  assert.equal(embed.configured(), false, 'an address with nothing to send')

  process.env.EMBEDDINGS_KEY = 'sk-own'
  assert.equal(embed.configured(), true)

  await embed.embed(['hello'])
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://api.openai.com/v1/embeddings')
  assert.equal(sent[0].auth, 'Bearer sk-own')
  assert.equal(
    sent[0].body.model,
    'autobricksai/text-embedding-3-small',
    'the default names the provider this build ships pointed at, not the URL that was set',
  )
})

test('a provider that spells the model differently is told which one', async () => {
  // OpenRouter serves the same model as `openai/text-embedding-3-small`. Nothing infers that
  // from the URL — the name sits beside the address in .env, and both are written down.
  stubProvider()
  process.env.EMBEDDINGS_KEY = 'or-key'
  process.env.EMBEDDINGS_URL = 'https://openrouter.ai/api/v1/embeddings'
  process.env.EMBEDDINGS_MODEL = 'openai/text-embedding-3-small'

  await embed.embed(['hello'])
  assert.equal(sent[0].auth, 'Bearer or-key')
  assert.equal(sent[0].body.model, 'openai/text-embedding-3-small')
})

test('dimensions are only asked for when somebody asked for them', async () => {
  stubProvider()
  process.env.EMBEDDINGS_KEY = 'sk-own'
  process.env.EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'

  // OpenRouter does not document the field, and the model is natively the right width.
  await embed.embed(['hello'])
  assert.equal('dimensions' in sent[0].body, false)

  process.env.EMBEDDINGS_DIMS = '1536'
  await embed.embed(['hello'])
  assert.equal(sent[1].body.dimensions, 1536)
})

test('a model of the wrong width is refused in a sentence', async () => {
  // Otherwise this arrives as a pgvector type error from inside a transaction, which says
  // nothing about the model anybody actually picked.
  stubProvider(768)
  process.env.EMBEDDINGS_KEY = 'sk-own'
  process.env.EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
  process.env.EMBEDDINGS_MODEL = 'some/768-model'

  await assert.rejects(() => embed.embed(['hello']), /768-wide vectors and this database stores 1536/)
})

// ---------------------------------------------------------------- the backfill

test('what was stored without a key is embedded once there is one', async () => {
  // Filed while offline: a real chunk, and no vector.
  const doc = await kb.store(ws, {
    baseId: base,
    source: 'upload',
    uri: null,
    title: 'Delivery',
    mime: 'text/plain',
    text: 'Orders within Singapore arrive in two to three working days.',
  })
  assert.ok(doc.chunks > 0)
  const empty = await asSystem(() => all(`SELECT id FROM chunks WHERE embedding IS NULL`))
  assert.ok(empty.length > 0, 'nothing has a vector yet')

  stubProvider()
  process.env.EMBEDDINGS_KEY = 'sk-own'
  process.env.EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
  await embed.sweepEmbeddings()

  assert.deepEqual(await asSystem(() => all(`SELECT id FROM chunks WHERE embedding IS NULL`)), [])
  assert.ok(sent.length > 0)
})

test('approved examples are backfilled too, and resources are left alone', async () => {
  const bots = await import('../src/server/bot.ts')
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo' }))
  await asSystem(() =>
    run(
      `INSERT INTO lessons (workspace_id, bot_id, kind, question, answer, status)
       VALUES (?,?, 'example', 'Do you deliver?', 'Yes, in two to three days.', 'approved'),
              (?,?, 'resource', 'the price list', 'prices.pdf', 'approved'),
              (?,?, 'fact', 'Nope', 'Something turned down.', 'rejected')`,
      ws,
      bot.id,
      ws,
      bot.id,
      ws,
      bot.id,
    ),
  )

  stubProvider()
  process.env.EMBEDDINGS_KEY = 'sk-own'
  process.env.EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings'
  await embed.sweepEmbeddings()

  const rows = await asSystem(() =>
    all(`SELECT kind, status, (embedding IS NOT NULL) AS embedded FROM lessons ORDER BY id`),
  )
  const kindOf = (k) => rows.find((r) => r.kind === k)
  assert.equal(kindOf('example').embedded, true, 'or it can never be retrieved once a key exists')
  // Chosen by its description at answer time, so it has no embedding to be missing.
  assert.equal(kindOf('resource').embedded, false)
  // Turned down, and staying that way. No reason to spend a token on it.
  assert.equal(kindOf('fact').embedded, false)
})

test('the backfill does nothing at all without a provider', async () => {
  await asSystem(() => run(`UPDATE chunks SET embedding = NULL`))
  stubProvider()

  await embed.sweepEmbeddings()
  assert.equal(sent.length, 0)
  assert.ok((await asSystem(() => all(`SELECT id FROM chunks WHERE embedding IS NULL`))).length > 0)
})
