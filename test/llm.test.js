/**
 * Which provider answers, per workspace, and what got spent doing it.
 *
 * The model call itself is stubbed at `fetch` — same as every other test that touches an LLM
 * in this repo — so what's actually under test is provider resolution (which endpoint, which
 * key) and usage recording, not the network.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('llm')
process.env.SECRET_KEY = 'test-secret-key-for-sealing-tokens'
const auth = await import('../src/server/auth.ts')
const llm = await import('../src/server/llm.ts')

const ws = (await auth.provisionUser('llm@example.com')).workspaceId

const realFetch = globalThis.fetch
let requests = []
function stub(content, usage) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}
test.beforeEach(() => {
  requests = []
})
test.after(() => {
  globalThis.fetch = realFetch
  return db_.drop()
})
test('with no key anywhere there is no model, and nothing reaches the network', async () => {
  process.env.AUTOBRICKS_API_KEY = ''
  assert.equal(await llm.available(ws), false)
  assert.equal(await llm.chat(ws, [{ role: 'user', content: 'hi' }]), null)
  assert.equal(requests.length, 0, 'not configured must not reach the network')
})

test('the workspace key is used, and it goes to Autobricks', async () => {
  await auth.setProvider(ws, 'my-autobricks-key')
  assert.equal(await llm.available(ws), true)

  stub('hi from autobricks', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
  const reply = await llm.chat(ws, [{ role: 'user', content: 'hi' }])
  assert.equal(reply, 'hi from autobricks')
  assert.equal(requests[0].url, 'https://api.autobricksai.com/v1/chat/completions')
  assert.equal(requests[0].headers.authorization, 'Bearer my-autobricks-key')
})

test('the environment key answers only until a workspace saves its own', async () => {
  /*
   * Both exist so a fresh container can answer before anybody opens Settings — the key comes
   * in from .env — and so saving one in Settings takes over without a restart. The saved one
   * has to win, or pasting a new key would appear to do nothing until the process was
   * bounced, which is the exact confusion it is pasted to end.
   */
  const { run } = await import('../src/server/db.ts')
  await run(`UPDATE workspaces SET autobricks_key_enc = NULL WHERE id = ?`, ws)

  process.env.AUTOBRICKS_API_KEY = 'from-the-environment'
  stub('a')
  await llm.chat(ws, [{ role: 'user', content: 'hi' }])
  assert.equal(requests.at(-1).headers.authorization, 'Bearer from-the-environment')

  await auth.setProvider(ws, 'saved-in-settings')
  stub('a')
  await llm.chat(ws, [{ role: 'user', content: 'hi' }])
  assert.equal(requests.at(-1).headers.authorization, 'Bearer saved-in-settings', 'the saved key wins')
})

test('Settings knows about a key it did not save', async () => {
  /*
   * The bug this pins: `.env` is bind-mounted and the database volume is not, so rebuilding
   * the container leaves a key that answers every question beside a workspaces row with
   * nothing in it. Settings read the row, found it empty, and offered to "Paste your key"
   * while the bots were already answering on the one in the environment.
   *
   * So `hasKey` has to mean what `resolveProvider` means. `fromEnv` is what the page needs to
   * avoid the opposite lie — calling an environment key "saved encrypted here".
   */
  const { run } = await import('../src/server/db.ts')
  await run(`UPDATE workspaces SET autobricks_key_enc = NULL, llm_provider = 'default' WHERE id = ?`, ws)

  process.env.AUTOBRICKS_API_KEY = ''
  assert.deepEqual(await auth.providerSettings(ws), { provider: 'default', hasKey: false, fromEnv: false })

  process.env.AUTOBRICKS_API_KEY = 'survived-the-rebuild'
  assert.deepEqual(
    await auth.providerSettings(ws),
    { provider: 'autobricks', hasKey: true, fromEnv: true },
    'a key only in the environment still counts as a key',
  )

  await auth.setProvider(ws, 'pasted-in-settings')
  assert.deepEqual(
    await auth.providerSettings(ws),
    { provider: 'autobricks', hasKey: true, fromEnv: false },
    'saving one makes it this workspace\'s own',
  )
})

test('the saved key is never readable in the clear', async () => {
  await auth.setProvider(ws, 'a-real-secret')
  const { one } = await import('../src/server/db.ts')
  const row = await one(`SELECT autobricks_key_enc FROM workspaces WHERE id = ?`, ws)
  assert.ok(row.autobricks_key_enc.startsWith('enc:'))
})

test('a bot may name its own model, and anything blank falls back', async () => {
  process.env.AUTOBRICKS_MODEL = ''
  await auth.setProvider(ws, 'ab-key')

  stub('a')
  await llm.chat(ws, [{ role: 'user', content: 'hi' }])
  assert.equal(requests.at(-1).body.model, 'autobricksai/gpt-4.1-mini', 'budget tier, so a new account still answers')

  stub('a')
  await llm.chat(ws, [{ role: 'user', content: 'hi' }], { model: 'autobricksai/claude-opus-4.7' })
  assert.equal(requests.at(-1).body.model, 'autobricksai/claude-opus-4.7', 'what the bot chose is what is sent')
})

// ------------------------------------------------- which model, and which list to pick from

/** Answer /v1/models with this catalogue; anything else is a completion. */
function stubModels(data, status = 200) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null })
    if (String(url).endsWith('/models'))
      return new Response(JSON.stringify({ object: 'list', data }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('linking autobricks changes the list to that account s own catalogue', async () => {
  await auth.setProvider(ws, 'ab-key')
  stubModels([
    { id: 'autobricksai/gpt-4.1-mini', display_name: 'GPT-4.1 Mini', tier: 'budget' },
    { id: 'autobricksai/claude-opus-4.7', display_name: 'Claude Opus 4.7', tier: 'premium' },
  ])

  const c = await llm.catalogue(ws)
  assert.equal(c.provider, 'autobricks')
  assert.equal(c.live, true)
  assert.equal(c.fallback, 'autobricksai/gpt-4.1-mini')
  assert.deepEqual(c.models.map((m) => m.id), ['autobricksai/gpt-4.1-mini', 'autobricksai/claude-opus-4.7'])
  assert.equal(c.models[1].tier, 'premium', 'tier is shown, because premium needs credit on that account')
  assert.equal(requests.at(-1).url, 'https://api.autobricksai.com/v1/models')
  assert.equal(requests.at(-1).headers.Authorization ?? requests.at(-1).headers.authorization, 'Bearer ab-key')
})

test('a dead catalogue call still offers something to pick', async () => {
  // Their API being down must leave the chatbot page usable rather than empty.
  await auth.setProvider(ws, 'other-key')
  stubModels([], 500)
  const down = await llm.catalogue(ws)
  assert.equal(down.live, false)
  assert.ok(down.models.length, 'a picker with nothing in it makes every bot look unconfigurable')
  assert.equal(down.fallback, 'autobricksai/gpt-4.1-mini')
})

test('usage is summed, tokens and recency both', async () => {
  await auth.setProvider(ws, 'ab-key')
  const before = (await llm.usage(ws)).find((u) => u.provider === 'autobricks')?.tokens ?? 0

  stub('a', { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 })
  await llm.chat(ws, [{ role: 'user', content: 'hi' }])
  stub('b', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 })
  await llm.chat(ws, [{ role: 'user', content: 'hi again' }])

  const row = (await llm.usage(ws)).find((u) => u.provider === 'autobricks')
  assert.equal(row.tokens - before, 30)
  assert.ok(Date.now() - new Date(row.last_at).getTime() < 5000, 'last_at should be right now')
})

test('a usage row says what the call was for, and which thread it belonged to', async () => {
  /*
   * The gap this closes, in one test. `llm_usage` recorded tokens and a provider and nothing
   * else, so the only question anybody asks of it — "why did that cost so much?" — had to be
   * answered by reading timestamps beside prompt sizes and guessing. That guess was made for
   * real, and it was wrong.
   */
  const { all } = await import('../src/server/db.ts')
  const customers = await import('../src/server/customers.ts')
  const convo = await import('../src/server/conversations.ts')

  process.env.AUTOBRICKS_API_KEY = 'shared-key'
  const who = await customers.identify(ws, { channel: 'web', externalId: 'spend-1' })
  const thread = await convo.open(ws, who.id, 'web', 'spend-widget')

  stub('{"ok":true}', { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 })
  const z = await import('zod')
  await llm.structured(ws, z.object({ ok: z.boolean() }), [{ role: 'user', content: 'hi' }], {
    name: 'answer',
    conversationId: thread.id,
  })

  const rows = await all(
    `SELECT purpose, conversation_id, total_tokens FROM llm_usage WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
    ws,
  )
  assert.equal(rows[0].purpose, 'answer', 'the name it was called with is what it is for')
  assert.equal(rows[0].conversation_id, thread.id, 'and the thread it belonged to, so an answer can be added up')
  assert.equal(rows[0].total_tokens, 440)
})

test('a call that says nothing about itself still records, rather than being lost', async () => {
  // Attribution is worth having and is not worth losing a usage row over. An unlabelled call
  // is still money spent, and a total that quietly omits it is worse than one that admits it.
  const { all } = await import('../src/server/db.ts')
  process.env.AUTOBRICKS_API_KEY = 'shared-key'
  stub('hi', { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 })

  await llm.chat(ws, [{ role: 'user', content: 'hi' }])

  const rows = await all(
    `SELECT purpose, conversation_id FROM llm_usage WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
    ws,
  )
  assert.equal(rows[0].purpose, 'chat', 'the default, not null')
  assert.equal(rows[0].conversation_id, null, 'and no thread invented for it')
})

test('spend is attributed to the model that ran and the bot that owns the thread', async () => {
  /*
   * Two questions the totals could not answer: which model ran, and whose bot spent it.
   *
   * The model is recorded rather than derived because `modelFor()` overrides a bot's choice
   * when it belongs to the other provider — so what was *asked for* and what *ran* differ in
   * exactly the case worth catching. The bot is derived, through the conversation, because
   * `conversations.bot_id` already holds that fact and a column here would be a third copy.
   */
  const { all } = await import('../src/server/db.ts')
  const customers = await import('../src/server/customers.ts')
  const convo = await import('../src/server/conversations.ts')
  const bots = await import('../src/server/bot.ts')

  process.env.AUTOBRICKS_API_KEY = 'shared-key'
  process.env.AUTOBRICKS_MODEL = ''

  const bot = await bots.create(ws, { name: 'Spender' })
  const who = await customers.identify(ws, { channel: 'web', externalId: 'attributed' })
  const thread = await convo.open(ws, who.id, 'web', 'attributed-widget')
  const { run } = await import('../src/server/db.ts')
  await run(`UPDATE conversations SET bot_id = ? WHERE id = ?`, bot.id, thread.id)

  stub('hi', { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 })
  await llm.chat(ws, [{ role: 'user', content: 'hi' }], { purpose: 'answer', conversationId: thread.id })

  // What actually went on the wire is what got logged.
  assert.equal(requests.at(-1).body.model, 'autobricksai/gpt-4.1-mini')
  const row = (await all(`SELECT model FROM llm_usage WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`, ws))[0]
  assert.equal(row.model, 'autobricksai/gpt-4.1-mini', 'the resolved model, not the one requested')

  const models = await llm.byModel(ws)
  const mine = models.find((m) => m.model === 'autobricksai/gpt-4.1-mini')
  assert.ok(mine, 'the model shows up in the report')
  assert.ok(mine.purposes.includes('answer'), 'and says what it was doing')

  const perBot = await llm.byBot(ws)
  const row2 = perBot.find((b) => b.bot_id === bot.id)
  assert.ok(row2, 'the thread carried the spend back to its bot')
  assert.equal(row2.name, 'Spender')
  assert.ok(row2.tokens >= 1000)
})

test('a call with no conversation belongs to no bot, rather than to an arbitrary one', async () => {
  // Reading a knowledge base or working out what the company does is workspace-wide work.
  // Spreading it across bots would invent a number; leaving it out is what the page explains.
  process.env.AUTOBRICKS_API_KEY = 'shared-key'
  stub('{}', { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 })

  const before = (await llm.byBot(ws)).reduce((n, b) => n + b.tokens, 0)
  await llm.chat(ws, [{ role: 'user', content: 'hi' }], { purpose: 'identity' })
  const after = (await llm.byBot(ws)).reduce((n, b) => n + b.tokens, 0)

  assert.equal(after, before, 'nothing without a thread landed on a bot')
})

test('what the provider charged is kept, not re-derived from the tokens later', async () => {
  /*
   * The real numbers from a live call, because the gap between them is the whole point: eight
   * prompt tokens and ten completion tokens cost $0.0000192 of model time and were billed one
   * credit -- a cent -- because the provider rounds every request up to a whole one. Pricing
   * the tokens here would have reported about five hundredth of what was actually charged.
   */
  const { all } = await import('../src/server/db.ts')
  process.env.AUTOBRICKS_API_KEY = 'shared-key'
  stub('hi', { prompt_tokens: 8, completion_tokens: 10, total_tokens: 18, cost: 1.92e-5, credits_used: 1 })

  await llm.chat(ws, [{ role: 'user', content: 'hi' }])

  const rows = await all(
    `SELECT cost_usd::float8 AS cost_usd, credits FROM llm_usage WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
    ws,
  )
  assert.equal(rows[0].cost_usd, 1.92e-5, 'stored as given, at the precision it was given')
  assert.equal(rows[0].credits, 1, 'and the charge, which is the figure that reconciles')
})

test('a provider that reports a cost but no charge records the one it gave', async () => {
  // The state before the provider learned to report its own charge. The cost is still worth
  // keeping, and a missing charge has to be null rather than nought: the page tells them apart.
  const { all } = await import('../src/server/db.ts')
  process.env.AUTOBRICKS_API_KEY = 'shared-key'
  stub('hi', { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost: 4.2e-6 })

  await llm.chat(ws, [{ role: 'user', content: 'hi' }])

  const rows = await all(
    `SELECT cost_usd::float8 AS cost_usd, credits FROM llm_usage WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
    ws,
  )
  assert.equal(rows[0].cost_usd, 4.2e-6)
  assert.equal(rows[0].credits, null, 'null, so the page knows to price this row from its tokens')
})

test('a provider that reports neither still records the call', async () => {
  // Tokens are what every provider reports and money is what only some do. A call whose cost
  // is unknown is still a call, and dropping the row would hide it from the total entirely.
  const { all } = await import('../src/server/db.ts')
  process.env.AUTOBRICKS_API_KEY = 'shared-key'
  stub('hi', { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 })

  await llm.chat(ws, [{ role: 'user', content: 'hi' }])

  const rows = await all(
    `SELECT total_tokens, cost_usd, credits FROM llm_usage WHERE workspace_id = ? ORDER BY id DESC LIMIT 1`,
    ws,
  )
  assert.equal(rows[0].total_tokens, 9, 'the row is there')
  assert.equal(rows[0].cost_usd, null)
  assert.equal(rows[0].credits, null)
})

test('the reports add up the charges, and say nothing where there were none', async () => {
  /*
   * `sum()` over no values is null, and that is load-bearing rather than incidental: it is how
   * a report says "nothing here was ever priced" as distinct from "this cost nothing", which
   * is what decides whether the page shows a charge or falls back to an estimate.
   */
  const fresh = (await auth.provisionUser('charges@example.com')).workspaceId
  process.env.AUTOBRICKS_API_KEY = 'shared-key'

  stub('a', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
  await llm.chat(fresh, [{ role: 'user', content: 'a' }])
  const unpriced = (await llm.usage(fresh)).find((u) => u.provider === 'autobricks')
  assert.equal(unpriced.credits, null, 'no charge reported by anything yet')
  assert.equal(unpriced.cost_usd, null)

  stub('b', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 1e-5, credits_used: 1 })
  await llm.chat(fresh, [{ role: 'user', content: 'b' }])
  stub('c', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 2e-5, credits_used: 3 })
  await llm.chat(fresh, [{ role: 'user', content: 'c' }])

  const row = (await llm.usage(fresh)).find((u) => u.provider === 'autobricks')
  assert.equal(row.credits, 4, 'the two that were charged, added')
  assert.ok(Math.abs(row.cost_usd - 3e-5) < 1e-12, 'and their cost, which is a separate total')
  assert.equal(row.tokens, 36, 'all three calls still count toward the tokens')
})
