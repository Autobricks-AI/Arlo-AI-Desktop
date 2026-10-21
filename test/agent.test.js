/**
 * The loop, end to end: a question arrives, an answer goes back, a person takes over.
 *
 * The model is stubbed at `fetch` rather than by mocking a module, so everything between
 * the webhook and the wire is the real code — the prompt is built, the JSON schema is
 * sent, and the response is parsed back through Zod exactly as in production.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import { useSchema } from './helper.js'
const db_ = await useSchema('agent')
const auth = await import('../src/server/auth.ts')
const kb = await import('../src/server/kb.ts')
const agent = await import('../src/server/agent.ts')
const bots = await import('../src/server/bot.ts')
const convo = await import('../src/server/conversations.ts')
const customers = await import('../src/server/customers.ts')
const throttle = await import('../src/server/throttle.ts')
const { all, insert, one, run } = await import('../src/server/db.ts')
test.after(() => db_.drop())

const bases = await import('../src/server/bases.ts')
const ws = (await auth.provisionUser('agent@example.com')).workspaceId
const base = (await bases.first(ws)).id
/*
 * The widget these questions arrive on, pointed at the workspace's bot.
 *
 * Nothing answers a connection no bot is assigned to, so without this every test here
 * would prove only that an unassigned channel waits for a person.
 */
const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo', mode: 'live' }))
// Connected to the base as well as the widget. A workspace no longer arrives with a bot,
// so what it can read is this fixture's business rather than something it inherited.
await bots.save(ws, bot.id, { connections: [{ channel: 'web', connection_ref: 'w1' }], baseIds: [base] })
await kb.store(ws, { baseId: base,
  source: 'upload',
  uri: null,
  title: 'Refunds',
  mime: 'text/plain',
  text: 'Refunds are issued to the original payment method within five working days of approval.',
})

// ---------------------------------------------------------------- the stubbed model

const realFetch = globalThis.fetch
/** What the next model call will answer. Set per test. */
let nextAnswer = null
/** Every request the model was sent, so the prompt itself can be asserted on. */
let sent = []
/**
 * What the check on a claimed example answers -- its own call, so its own answer. True by
 * default, so a test about something else is not quietly also a test of this.
 */
let judgeSays = true
const judged = () => sent.filter((r) => r.body.response_format?.json_schema?.name === 'file_check')

function stubModel(answer) {
  nextAnswer = answer
  process.env.AUTOBRICKS_API_KEY = 'test-key'
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push({ url: String(url), body })
    if (nextAnswer === 'error') return new Response('upstream is down', { status: 502 })
    if (body.response_format?.json_schema?.name === 'file_check') {
      if (judgeSays === 'error') return new Response('upstream is down', { status: 502 })
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ gives: judgeSays }) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(nextAnswer) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

function noModel() {
  process.env.AUTOBRICKS_API_KEY = ''
  globalThis.fetch = realFetch
}

const good = (over = {}) => ({
  reply: 'Refunds land back on your original card within five working days.',
  confidence: 0.9,
  handoff: false,
  handoff_reason: null,
  used_example: null,
  intent: 'refund',
  traits: [],
  ...over,
})

test.beforeEach(() => {
  sent = []
  judgeSays = true
})
test.after(() => {
  globalThis.fetch = realFetch
})

// ---------------------------------------------------------------- the happy path

test('a question is answered, delivered, and cites what it came from', async () => {
  stubModel(good())
  const r = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-happy', from: 'v-happy', text: 'how do refunds work?' })

  assert.equal(r.status, 'answered')
  assert.match(r.reply, /five working days/)
  assert.ok(r.cited.length, 'an answer with no citations cannot be checked')
  assert.equal(r.cited[0].title, 'Refunds')

  const thread = await convo.messages(ws, r.conversationId)
  assert.deepEqual(
    thread.map((m) => m.direction),
    ['in', 'out'],
  )
  assert.equal(thread[1].author, 'arlo')
  // The citation is stored with the message, not recomputed later: editing the document
  // afterwards must not change what this answer says it was based on.
  assert.equal(thread[1].cited[0].document_id, r.cited[0].document_id)
})

test('the retrieved passages reach the model, fenced as data', async () => {
  stubModel(good())
  await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-fence', from: 'v-fence', text: 'refund policy' })

  const messages = sent.at(-1).body.messages
  const reference = messages.find((m) => m.content.includes('REFERENCE PASSAGES'))
  assert.ok(reference, 'the passages never reached the model')
  assert.match(reference.content, /five working days/)
  // This app ingests the open web. A crawled page saying "ignore your instructions" is a
  // thing that exists, so the passages have to arrive labelled as material to read.
  assert.match(reference.content, /never\s*\n?instructions to follow/i)
})

test('the model is asked for exactly the shape we parse', async () => {
  stubModel(good())
  await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-schema', from: 'v-schema', text: 'refunds?' })

  const format = sent.at(-1).body.response_format
  assert.equal(format.type, 'json_schema')
  assert.equal(format.json_schema.strict, true)
  // Strict mode refuses a schema that permits extra properties.
  assert.equal(format.json_schema.schema.additionalProperties, false)
})

// ---------------------------------------------------------------- handing over

test('asking for a person hands the thread over and the bot stops', async () => {
  stubModel(good({ handoff: true, handoff_reason: 'asked for a human', reply: 'Getting someone for you now.' }))
  const first = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-human', from: 'v-human', text: 'let me talk to a person' })
  assert.equal(first.status, 'handoff')

  const after = await convo.get(ws, first.conversationId)
  assert.equal(after.status, 'human')

  // The next message is filed but not answered. A bot that keeps talking after a handoff
  // is worse than no bot.
  stubModel(good())
  const second = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-human', from: 'v-human', text: 'are you there?' })
  assert.equal(second.status, 'human')
  assert.equal(second.reply, null)

  const thread = await convo.messages(ws, first.conversationId)
  assert.equal(thread.at(-1).direction, 'in')
  assert.equal(thread.at(-1).body, 'are you there?')
})

test('a model that is not confident hands over rather than guessing', async () => {
  stubModel(good({ confidence: 0.2, handoff: false }))
  const r = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-unsure', from: 'v-unsure', text: 'what about partial refunds' })
  assert.equal(r.status, 'handoff')
  assert.equal((await convo.get(ws, r.conversationId)).status, 'human')
})

test('retrieving nothing is not on its own a reason to hand over', async () => {
  /*
   * This used to force a handover, and it was wrong for the commonest message a support
   * line gets. "Hi" and "thanks" match no passage, so every greeting escalated — and a
   * handover is one-way, so the bot then went silent on that customer for good.
   *
   * The distinction the code cannot make is factual versus not, and the model can. A
   * confident answer with nothing retrieved is a greeting; the next test is the factual
   * case, where low confidence is what catches it.
   */
  stubModel(good({ confidence: 0.95, reply: 'Hello! What can I help you with?' }))
  const r = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-hello', from: 'v-hello', text: 'hi there' })

  assert.equal(r.cited.length, 0)
  assert.equal(r.status, 'answered')
  assert.equal((await convo.get(ws, r.conversationId)).status, 'bot')
})

test('an unsupported factual answer still hands over, on confidence', async () => {
  // The model is told to ground factual answers and to report how well the passages
  // carried it. Nothing retrieved and it says so → the floor catches it.
  stubModel(good({ confidence: 0.1 }))
  const r = await agent.handle(ws, {
    channel: 'web',
    channelRef: 'w1:v-unknown',
    from: 'v-unknown',
    text: 'zzzz quantum entanglement pricing',
  })
  assert.equal(r.cited.length, 0)
  assert.equal(r.status, 'handoff')
})

// ---------------------------------------------------------------- failure is not silence

test('with no model configured the message is filed and a person gets it', async () => {
  noModel()
  const r = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-nomodel', from: 'v-nomodel', text: 'anyone there?' })

  assert.equal(r.status, 'unavailable')
  assert.equal(r.reply, null)
  // An unconfigured deployment must never swallow a customer's question.
  assert.equal((await convo.get(ws, r.conversationId)).status, 'human')
  assert.equal((await convo.messages(ws, r.conversationId))[0].body, 'anyone there?')
})

test('a provider outage is a handoff, not a lost message', async () => {
  stubModel('error')
  const r = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-down', from: 'v-down', text: 'refunds?' })
  assert.equal(r.status, 'unavailable')
  assert.equal((await convo.get(ws, r.conversationId)).status, 'human')
})

test('a model that ignores the schema is treated as a failure, not parsed loosely', async () => {
  stubModel({ reply: 'sure thing', confidence: 'very high' })
  const r = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-bad', from: 'v-bad', text: 'refunds?' })
  assert.equal(r.status, 'unavailable')
})

// ---------------------------------------------------------------- the boring guards

test('a redelivered message is not answered twice', async () => {
  stubModel(good())
  const first = await agent.handle(ws, {
    channel: 'web', channelRef: 'w1:v-dupe', from: 'v-dupe', text: 'refunds?', externalId: 'msg-1',
  })
  assert.equal(first.status, 'answered')

  const again = await agent.handle(ws, {
    channel: 'web', channelRef: 'w1:v-dupe', from: 'v-dupe', text: 'refunds?', externalId: 'msg-1',
  })
  assert.equal(again.status, 'duplicate')
  assert.equal(again.reply, null)

  // Two messages, not four: the question once and the answer once.
  assert.equal((await convo.messages(ws, first.conversationId)).length, 2)
})

test('two messages from the same visitor stay in one thread', async () => {
  stubModel(good())
  const a = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-same', from: 'v-same', text: 'refunds?' })
  const b = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-same', from: 'v-same', text: 'and shipping?' })
  assert.equal(a.conversationId, b.conversationId)
})

test('the same person on two channels is one customer', async () => {
  stubModel(good())
  await agent.handle(ws, {
    channel: 'web', channelRef: 'w1:v-merge', from: 'v-merge', text: 'refunds?', email: 'Sam@Example.com',
  })
  await agent.handle(ws, {
    channel: 'telegram', channelRef: '55', from: '55', text: 'refunds again?', email: 'sam@example.com',
  })

  const found = (await customers.list(ws)).rows
  const sam = found.filter((c) => c.email === 'sam@example.com')
  assert.equal(sam.length, 1, 'the same email should be one customer, not two')
  assert.deepEqual([...sam[0].channels].sort(), ['telegram', 'web'])
  assert.equal(sam[0].conversations, 2)
})

test('traits the model observed are remembered, trimmed and capped', async () => {
  stubModel(good({ traits: [{ key: '  Plan  ', value: 'Pro' }, { key: 'seats', value: 'x'.repeat(400) }] }))
  const r = await agent.handle(ws, { channel: 'web', channelRef: 'w1:v-traits', from: 'v-traits', text: 'refunds?', email: 'kit@example.com' })

  // The list no longer carries traits — a contact list does not draw them and they were
  // crossing the wire per row. The full record still has them.
  const listed = (await customers.list(ws)).rows.find((x) => x.email === 'kit@example.com')
  const c = await customers.get(ws, listed.id)
  assert.equal(c.traits.plan, 'Pro')
  assert.equal(c.traits.seats.length, 200)
  assert.ok(r.conversationId)
})

test('outbound is rate limited per workspace', async () => {
  await throttle.reset()
  stubModel(good())
  // REPLY.max is 60 a minute. Burn the budget on one thread, then prove another cannot
  // send — a loop or a hostile sender must not be able to run up the model bill.
  const conversation = await convo.open(ws, (await customers.list(ws)).rows[0].id, 'web', 'v-flood')
  const { deliver } = await import('../src/server/channels/index.ts')
  for (let i = 0; i < 60; i++) await deliver(ws, conversation, `burst ${i}`)

  const refused = await deliver(ws, conversation, 'one too many')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /Rate limited/)
  await throttle.reset()
})

test('one workspace never sees another one s conversations', async () => {
  const other = (await auth.provisionUser('agent-other@example.com')).workspaceId
  assert.deepEqual((await convo.inbox(other)).rows, [])
  // Same channel ref, different workspace: a separate thread, not a shared one.
  assert.equal(await convo.find(other, 'web', 'w1:v-happy'), undefined)
  assert.ok(await convo.find(ws, 'web', 'w1:v-happy'))
  assert.ok(await one(`SELECT 1 FROM conversations WHERE workspace_id = ?`, ws))
})

test('an answer with nothing to attach goes out as written', async () => {
  // Files are appended only when something chose one — `send_resource` during the tool loop.
  // A stray link on every answer would be worse than the bug that appending fixes.
  stubModel(good({ reply: 'Within five working days.' }))
  const r = await agent.handle(ws, {
    channel: 'web',
    channelRef: `w1:plain`,
    from: 'plain',
    text: 'how long do refunds take?',
  })
  assert.equal(r.reply, 'Within five working days.')
})

/**
 * Switching a bot to Live, which is not only a label.
 *
 * Every thread a person took over stays theirs until something hands it back, so a bot set
 * live went on saying nothing in exactly the conversations it was switched on for.
 *
 * Three things have to hold. All of them come back. Only the ones actually waiting on an
 * answer get one -- a thread that ended on "thanks" is taken back in silence, because
 * replying to a goodbye on forty threads at once is the one thing nobody wants from this
 * button. And running twice answers nobody twice: `save()` fires this without awaiting it,
 * so two saves in quick succession overlap, and both runs used to see the same unclaimed
 * rows and both reply -- which reached the customer as two differently worded answers to one
 * message.
 */
test('going live hands every held thread back, and answers only the ones waiting on one', async () => {
  stubModel(good({ reply: 'Three working days.' }))

  const open = async (ref) =>
    (await agent.handle(ws, { channel: 'web', channelRef: `w1:${ref}`, from: ref, text: 'how do refunds work?' }))
      .conversationId

  const waiting = await open('v-live-waiting')
  const goodbye = await open('v-live-goodbye')
  const ourMove = await open('v-live-ourmove')

  // Whatever the tests above left behind, so this one asserts its own three.
  const before = await agent.liveTakeover(ws, bot.id)

  // No assignee: a thread somebody explicitly claimed is theirs to keep, and is left alone.
  for (const id of [waiting, goodbye, ourMove]) await convo.setStatus(ws, id, 'human')
  // `ourMove` keeps the bot's own answer as its last message: nobody is waiting on us.
  await convo.record(ws, waiting, { direction: 'in', body: 'and how long does it take?' })
  await convo.record(ws, goodbye, { direction: 'in', body: 'ok thanks!' })

  const asked = await agent.liveTakeover(ws, bot.id)
  assert.equal(asked.threads, before.threads + 3, 'all three are with a person')
  assert.equal(asked.answering, before.answering + 1, 'only one of them is waiting on an answer')

  const said = async (id) => (await convo.messages(ws, id)).filter((m) => m.direction === 'out').length
  const outBefore = await said(waiting)

  // Twice, at once, which is what two saves in quick succession actually do.
  await Promise.all([agent.handOverBacklog(ws, bot.id), agent.handOverBacklog(ws, bot.id)])

  for (const id of [waiting, goodbye, ourMove])
    assert.equal((await convo.get(ws, id)).status, 'bot', 'every held thread goes back')

  assert.equal(await said(waiting), outBefore + 1, 'answered once, not once per run')
  assert.equal(
    (await convo.messages(ws, goodbye)).at(-1).body,
    'ok thanks!',
    'a goodbye is taken back without a reply',
  )
  // Nothing at all is left with a person -- including the threads the tests above left
  // behind, which this bot also owns. That emptiness is what makes a second press a no-op.
  assert.deepEqual(await agent.liveTakeover(ws, bot.id), { threads: 0, answering: 0 })
})

/**
 * What the model can see of the files in a conversation, in both directions.
 *
 * Neither half was visible to it. A file that arrived was stored and never mentioned, so a
 * customer who sent one back and asked "what is this?" was told there was no file. And the
 * closest example's files go out whatever the reply says -- a person ticked them -- but the
 * model was never told, so it wrote about one thing while a song left alongside it.
 */
test('a file that arrived is named in the transcript the model reads', async () => {
  stubModel(good())
  await agent.handle(ws, {
    channel: 'web',
    channelRef: 'w1:v-sawfile',
    from: 'v-sawfile',
    text: 'what is this?',
    attachments: [{ name: 'quote.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 x') }],
  })

  const asked = JSON.stringify(sent.at(-1).body)
  assert.match(asked, /They attached/, 'the model has to know something came with the message')
  assert.match(asked, /quote\.pdf/)
  // The bytes are still not read. Naming it is the whole of this change.
  assert.doesNotMatch(asked, /%PDF/)
})

/**
 * An example's files go out when the reply follows that example, and only then.
 *
 * They used to ride on the example *matching*: whichever ranked first, every time. So when
 * the passages answered better and the model wrote its own reply, the file a person had
 * ticked onto a different answer left alongside it -- a question about the company got its
 * courses described and a song attached, with nothing in the text to say why.
 *
 * Both halves matter. Following the example must still guarantee the file, because a person
 * ticked it and the model gets no vote on that. Not following it must send nothing.
 */
const sentWith = async (conversationId) => {
  const last = (await convo.messages(ws, conversationId)).filter((m) => m.direction === 'out').at(-1)
  const files = await import('../src/server/attachments.ts')
  return (await files.forMessages(ws, [last.id])).map((f) => f.name)
}

async function workshopExample() {
  const resources = await import('../src/server/resources.ts')
  const fileId = await resources.addFile(
    ws,
    { name: 'rates.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 rates') },
    'Our current rates',
  )
  const lessonId = await insert(
    `INSERT INTO lessons (workspace_id, bot_id, kind, question, answer, status)
     VALUES (?,?, 'example', ?, ?, 'approved')`,
    ws,
    bot.id,
    'What does a workshop cost?',
    'It depends on the length -- the rates are attached.',
  )
  await run(`INSERT INTO lesson_resources (lesson_id, resource_id, workspace_id) VALUES (?,?,?)`, lessonId, fileId, ws)
}

test('following an example sends the files ticked onto it', async () => {
  await workshopExample()
  stubModel(good({ reply: 'It depends on the length -- here are our rates.', used_example: 1 }))
  const r = await agent.handle(ws, {
    channel: 'web',
    channelRef: 'w1:v-followed',
    from: 'v-followed',
    text: 'what does a workshop cost?',
  })
  assert.deepEqual(await sentWith(r.conversationId), ['rates.pdf'], 'a person ticked it onto this answer')

  // Read once, deterministically, with both halves in front of it.
  assert.equal(judged().length, 1, 'one check for one claimed example with files')
  assert.equal(judged()[0].body.temperature, 0)
  const asked = JSON.stringify(judged()[0].body.messages)
  assert.match(asked, /rates are attached/, 'the example answer it is judging against')
  assert.match(asked, /here are our rates/, 'and the reply being judged')
})

test('a reply that follows no example sends none of their files', async () => {
  // The example from the test above still matches this question. Matching is not using.
  stubModel(good({ reply: 'Workshops are priced by length; I can get you a quote.', used_example: null }))
  const ignored = await agent.handle(ws, {
    channel: 'web',
    channelRef: 'w1:v-ignored',
    from: 'v-ignored',
    text: 'what does a workshop cost?',
  })
  assert.deepEqual(await sentWith(ignored.conversationId), [], 'retrieved is not the same as followed')
  assert.equal(judged().length, 0, 'nothing claimed, so nothing to check and nothing spent')

  // Named, but not given -- what the real model did on a question about the company, and then
  // again with a reply saying it had no information at all. The claim picks which example to
  // read against; the reading decides.
  sent = []
  judgeSays = false
  stubModel(good({ reply: "I don't have information about workshop pricing.", used_example: 1 }))
  const claimed = await agent.handle(ws, {
    channel: 'web',
    channelRef: 'w1:v-claimed',
    from: 'v-claimed',
    text: 'what does a workshop cost?',
  })
  assert.deepEqual(await sentWith(claimed.conversationId), [], 'naming an example is not giving its answer')
  assert.equal(judged().length, 1)

  // A number with no example behind it is a guess, and a guess sends nothing -- unread.
  sent = []
  judgeSays = true
  stubModel(good({ reply: 'Workshops are priced by length.', used_example: 7 }))
  const guessed = await agent.handle(ws, {
    channel: 'web',
    channelRef: 'w1:v-guessed',
    from: 'v-guessed',
    text: 'what does a workshop cost?',
  })
  assert.deepEqual(await sentWith(guessed.conversationId), [])
  assert.equal(judged().length, 0)
})

test('a check that cannot be made keeps the file back', async () => {
  // The provider failing on the check is not a yes. Sending a file nobody can account for is
  // what all of this exists to stop, so when the question cannot be asked, the answer is no.
  judgeSays = 'error'
  stubModel(good({ reply: 'It depends on the length -- here are our rates.', used_example: 1 }))
  const r = await agent.handle(ws, {
    channel: 'web',
    channelRef: 'w1:v-unchecked',
    from: 'v-unchecked',
    text: 'what does a workshop cost?',
  })
  assert.equal(r.status, 'answered', 'the answer itself still goes')
  assert.deepEqual(await sentWith(r.conversationId), [], 'but not the file')
})
