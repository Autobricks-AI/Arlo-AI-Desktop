/**
 * Answering from the inbox.
 *
 * The rule being proved is the one that decides whether a customer gets talked over: a
 * person who replies owns the thread from then on, and Arlo does not chime in behind them
 * until somebody hands it back.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('inbox')
const auth = await import('../src/server/auth.ts')
const channels = await import('../src/server/channels/index.ts')
const convo = await import('../src/server/conversations.ts')
const customers = await import('../src/server/customers.ts')
const bots = await import('../src/server/bot.ts')
const { run } = await import('../src/server/db.ts')
const throttle = await import('../src/server/throttle.ts')
const resources = await import('../src/server/resources.ts')
const attachments = await import('../src/server/attachments.ts')
const { BOT_AUTHOR } = await import('../src/types.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('inbox@example.com')).workspaceId
const other = (await auth.provisionUser('inbox-other@example.com')).workspaceId

/** A thread with one question in it, on the web widget — whose "send" is the recording. */
let visitors = 0
async function threadWith(text) {
  await throttle.reset()
  // A visitor of its own per thread: one reused id is one reused conversation, and a test
  // that silently shares a thread with the one before it proves nothing.
  const visitor = String(++visitors).padStart(24, 'v')
  const customer = await customers.identify(ws, { channel: 'web', externalId: visitor })
  const conversation = await convo.open(ws, customer.id, 'web', `w1:${visitor}`)
  await convo.record(ws, conversation.id, { direction: 'in', body: text })
  return conversation
}

test('a person replying takes the thread over', async () => {
  const conversation = await threadWith('do you ship to Malaysia?')
  assert.equal(conversation.status, 'bot')

  await channels.replyAsPerson(ws, conversation.id, '  We do, three days.  ', 'kit@example.com')

  const after = await convo.get(ws, conversation.id)
  assert.equal(after.status, 'human')
  assert.equal(after.assignee, 'kit@example.com')

  const last = (await convo.messages(ws, conversation.id)).at(-1)
  assert.equal(last.direction, 'out')
  assert.equal(last.body, 'We do, three days.')
  // Attributed to the person, not to Arlo: the thread has to show who actually said it.
  assert.equal(last.author, 'kit@example.com')
})

/**
 * Sending a file from the inbox.
 *
 * The empty body is the part worth pinning down. This used to stand the filename in as a
 * caption, because the socket channels put a text message out before the attachment and an
 * empty one is a refused send — but that reached the customer as a second message naming a
 * document that already showed its name. The channels skip the text send instead, so what
 * has to hold here is that nothing is invented: a file on its own records no body at all,
 * and is still filed against the message.
 */
test('a file sent with nothing typed goes on its own, with no invented caption', async () => {
  const conversation = await threadWith('can you send me the price list?')
  const id = await resources.addFile(ws, {
    name: 'prices.pdf',
    mime: 'application/pdf',
    bytes: Buffer.from('%PDF-1.4 two dollars'),
  })
  const file = await resources.get(ws, id)

  await channels.replyAsPerson(ws, conversation.id, '   ', 'kit@example.com', [file])

  const last = (await convo.messages(ws, conversation.id)).at(-1)
  assert.equal(last.body, '', 'nothing was typed, so nothing is invented to stand in for it')
  assert.equal(last.author, 'kit@example.com')

  // Filed against the message as a pointer at the resource, so the thread shows the file
  // without a second copy of the bytes.
  const filed = await attachments.forMessages(ws, [last.id])
  assert.equal(filed.length, 1)
  assert.equal(filed[0].name, 'prices.pdf')
  assert.equal(filed[0].external_ref, `resource:${file.token}`)

  // And nothing at all is still refused: a send needs either words or a file, and neither
  // is neither.
  await assert.rejects(
    () => channels.replyAsPerson(ws, conversation.id, '  ', 'kit@example.com', []),
    /Nothing to send/,
  )
})

/**
 * Who the thread says wrote it.
 *
 * `speaker` is the column the learning extractor reads, and it used to be inferred inside
 * deliver() from the author string: `author === BOT_AUTHOR ? 'bot' : 'team'`. BOT_AUTHOR is
 * 'arlo', and so is DEFAULT_USER — the account every fresh install signs in as. So on a
 * default install a person's own replies were filed as the bot's, and harvest(), whose
 * first rule is that a fact may only come from the team, found nothing to learn in a thread
 * full of the team's words. It returned 0 without ever making a model call, which looks
 * exactly like "nothing here was worth teaching".
 */
test('a person whose account is named after the bot still writes as the team', async () => {
  const conversation = await threadWith('what are your delivery times?')

  await channels.replyAsPerson(ws, conversation.id, 'Three working days, anywhere in the country.', BOT_AUTHOR)

  const last = (await convo.messages(ws, conversation.id)).at(-1)
  assert.equal(last.author, BOT_AUTHOR, 'the display name is still what signed in')
  assert.equal(last.speaker, 'team', 'but a person typed it, whatever they are called')
})

test('replying to a closed thread reopens it rather than sending into nothing', async () => {
  const conversation = await threadWith('one more thing')
  await convo.setStatus(ws, conversation.id, 'closed')

  await channels.replyAsPerson(ws, conversation.id, 'Go on?', 'kit@example.com')
  assert.equal((await convo.get(ws, conversation.id)).status, 'human')
})

test('an empty reply and another workspace s thread are both refused', async () => {
  const conversation = await threadWith('hello?')

  await assert.rejects(() => channels.replyAsPerson(ws, conversation.id, '   ', 'kit@example.com'), /Nothing to send/)
  await assert.rejects(
    () => channels.replyAsPerson(other, conversation.id, 'hello', 'nosy@example.com'),
    /No such conversation/,
  )
  // Neither attempt left anything in the thread, and neither took it over.
  assert.equal((await convo.get(ws, conversation.id)).status, 'bot')
  assert.equal((await convo.messages(ws, conversation.id)).length, 1)
})

test('the inbox lists every channel, newest first', async () => {
  const web = await threadWith('from the website')
  const customer = await customers.identify(ws, { channel: 'telegram', externalId: '4242' })
  const tg = await convo.open(ws, customer.id, 'telegram', 'bot1:777')
  await convo.record(ws, tg.id, { direction: 'in', body: 'from telegram' })

  const { rows } = await convo.inbox(ws)
  assert.equal(rows[0].id, tg.id, 'the most recent thread comes first')
  assert.ok(rows.some((r) => r.id === web.id && r.channel === 'web'))
  assert.equal(rows.find((r) => r.id === tg.id).last_body, 'from telegram')

  // Another workspace sees none of it.
  assert.deepEqual((await convo.inbox(other)).rows, [])
})

test('the inbox can be narrowed to one bot, counts and all', async () => {
  /*
   * What the Messages button on a bot card opens. Filtered on the stamp the conversation
   * carries rather than by re-running the routing rules — a widget reassigned last week must
   * not rewrite who answered the threads from before it moved.
   */
  const { run } = await import('../src/server/db.ts')
  const bots = await import('../src/server/bot.ts')
  const sales = await bots.create(ws, { name: 'Sales', mode: 'live' })

  const theirs = await threadWith('a question for sales')
  await run(`UPDATE conversations SET bot_id = ? WHERE id = ?`, sales.id, theirs.id)

  const filtered = (await convo.inbox(ws, { botId: sales.id })).rows
  assert.deepEqual(filtered.map((r) => r.id), [theirs.id], 'only that bot s threads')
  assert.ok((await convo.inbox(ws)).total > filtered.length, 'and the unfiltered list is still everything')

  /*
   * The counts move with it. A chip reading "6" above a list showing one is not a count,
   * it is a bug report from the person looking at it.
   */
  const narrow = await convo.counts(ws, sales.id)
  const all = await convo.counts(ws)
  assert.equal(narrow.bot + narrow.human + narrow.closed, 1)
  assert.ok(all.bot + all.human + all.closed > 1)

  await bots.remove(ws, sales.id)
})

/**
 * Handing a thread back to the bot.
 *
 * The person doing it is looking straight at the customer's unanswered message, so the
 * one thing it must not do is wait for that customer to write in again.
 */
const agent = await import('../src/server/agent.ts')

/** A model that answers anything, confidently. */
const realFetch = globalThis.fetch
function stubModel(over = {}) {
  process.env.AUTOBRICKS_API_KEY = 'test-key'
  const answer = { reply: 'Thirty days.', confidence: 0.95, handoff: false, handoff_reason: null, used_example: null, traits: [], ...over }
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
}
test.after(() => {
  globalThis.fetch = realFetch
  process.env.AUTOBRICKS_API_KEY = ''
})

test('handing back answers the message that was left outstanding', async () => {
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo', mode: 'live' }))
  await bots.save(ws, bot.id, { connections: [{ channel: 'web', connection_ref: 'w1' }], strict_kb: false })
  stubModel()

  const conversation = await threadWith('how long is the warranty?')
  await channels.replyAsPerson(ws, conversation.id, 'Let me check.', 'kit@example.com')
  // The customer writes again while a person owns it; nothing answers.
  await convo.record(ws, conversation.id, { direction: 'in', body: 'still there?' })

  const r = await agent.handBack(ws, conversation.id)
  assert.equal(r.status, 'answered')

  const thread = await convo.messages(ws, conversation.id)
  assert.equal(thread.at(-1).direction, 'out')
  assert.equal(thread.at(-1).author, 'arlo')
  assert.equal((await convo.get(ws, conversation.id)).status, 'bot')
})

test('with nothing outstanding, handing back only waits for the next message', async () => {
  stubModel()
  const conversation = await threadWith('one question')
  await channels.replyAsPerson(ws, conversation.id, 'Answered.', 'kit@example.com')

  const before = (await convo.messages(ws, conversation.id)).length
  const r = await agent.handBack(ws, conversation.id)
  assert.equal(r.status, 'waiting')
  // Nothing was said into a conversation that had nothing to answer.
  assert.equal((await convo.messages(ws, conversation.id)).length, before)
  assert.equal((await convo.get(ws, conversation.id)).status, 'bot')
})

test('handing back is refused when no chatbot answers that connection', async () => {
  const conversation = await threadWith('hello?')
  await convo.setStatus(ws, conversation.id, 'human', 'kit@example.com')
  // A different widget, which no bot is assigned to.
  await run(`UPDATE conversations SET channel_ref = ? WHERE workspace_id = ? AND id = ?`, 'w2:nobody', ws, conversation.id)

  await assert.rejects(() => agent.handBack(ws, conversation.id), /Assign one on Chatbots/)
  // Still with the person who had it, rather than parked on a bot nothing routes to.
  assert.equal((await convo.get(ws, conversation.id)).status, 'human')
})

test('handing back a sleeping bot asks first, then wakes it and takes the thread', async () => {
  /*
   * Handing back used to go through on a learning bot: the thread became the bot's, the bot
   * answered once, and the next customer message hit the learning check and returned to a
   * person immediately. From the inbox that reads as the bot rejecting the conversation over
   * and over for no reason — when the mode is doing exactly what it says.
   *
   * Asked rather than refused or done quietly, because going live changes what the bot does
   * on every channel it answers, not only on the thread somebody happens to be looking at.
   * One question, then both halves of the job.
   */
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo', mode: 'live' }))
  await bots.save(ws, bot.id, { connections: [{ channel: 'web', connection_ref: 'w1' }], mode: 'learning' })
  stubModel()

  const conversation = await threadWith('are you open on Sunday?')
  await channels.replyAsPerson(ws, conversation.id, 'Checking.', 'kit@example.com')
  // Left outstanding, so handing back has something to answer rather than only a thread to
  // take ownership of.
  await convo.record(ws, conversation.id, { direction: 'in', body: 'still there?' })

  // Asked, not done and not refused. Nothing has changed yet.
  const asked = await agent.handBack(ws, conversation.id)
  assert.equal(asked.status, 'asleep')
  assert.equal(asked.bot.mode, 'learning')
  assert.equal(asked.reply, null)
  assert.equal((await convo.get(ws, conversation.id)).status, 'human', 'the thread moved before anybody agreed')
  assert.equal((await bots.get(ws, bot.id)).mode, 'learning', 'the bot woke before anybody agreed')

  // Answering yes does both halves: the bot goes live, and it takes the thread.
  const done = await agent.handBack(ws, conversation.id, { wake: true })
  assert.equal(done.status, 'answered')
  assert.equal((await bots.get(ws, bot.id)).mode, 'live')
  assert.equal((await convo.get(ws, conversation.id)).status, 'bot')

  // And a bot that is already live is never asked about.
  await channels.replyAsPerson(ws, conversation.id, 'Mine again.', 'kit@example.com')
  await convo.record(ws, conversation.id, { direction: 'in', body: 'and on Monday?' })
  assert.notEqual((await agent.handBack(ws, conversation.id)).status, 'asleep')
})

test('the stock escalation rules do not send a sale to a human', async () => {
  /*
   * The list used to open with "anything involving money". The intent was "do not commit the
   * company's money" — a refund, a discount, a charge. What a model reads is "is this about
   * money", and "how do I buy this?" is about money, so the most valuable message a sales bot
   * gets was escalated every time — after it had already answered correctly.
   *
   * Escalation is one-way, so the customer's next message then got nothing at all. Each line
   * has to name an action only a person can take.
   */
  const { BOT_DEFAULTS } = await import('../src/types.ts')
  const rules = BOT_DEFAULTS.escalate.split('\n').map((l) => l.toLowerCase())

  assert.ok(!rules.some((r) => r === 'anything involving money'), 'a rule this broad escalates every sale')
  for (const vague of ['anything involving money', 'anything where being wrong would cost the customer'])
    assert.ok(!rules.includes(vague), `"${vague}" is not an action a person can take`)

  // What is left names things only a person can actually do something about — and holds for
  // a clinic or an agency as much as for a shop, which the order-shaped version did not.
  assert.ok(rules.some((r) => r.includes('refund')))
  assert.ok(rules.some((r) => r.includes('existing order')))
  assert.ok(rules.some((r) => r.includes('speak to a person')))
  // Somebody in trouble is handed to a person, never refused as an off-limits topic.
  assert.ok(rules.some((r) => r.includes('harm to themselves')))
})

test('the stock prompt tells a bot to send information rather than offer it', async () => {
  /*
   * "If you need help finding a distributor or the website link, I can assist with that."
   * The customer had already asked. Offering to answer is a round trip that buys nothing and
   * loses people at the moment they were ready to buy.
   */
  const { BOT_DEFAULTS } = await import('../src/types.ts')
  const p = BOT_DEFAULTS.base_prompt.toLowerCase()

  assert.ok(p.includes('give the information, do not offer it'), 'the rule is not in the prompt')
  assert.ok(p.includes('offering counts as not answering'))
  // And the purchase question is named as answerable, since that is the one it kept escalating.
  assert.ok(p.includes('how to buy'), 'purchase questions must be named as answering, not escalating')
})

test('the assembled system prompt carries both rules to the model', async () => {
  // The defaults are only worth anything if they reach the prompt the model actually sees.
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo', mode: 'live' }))
  const prompt = bots.prompt(bot)

  assert.ok(prompt.toLowerCase().includes('do not offer it'), 'the answering rule never reaches the model')
  assert.ok(!prompt.toLowerCase().includes('anything involving money'), 'the broad money rule is still being sent')
})

test('a long thread shows its newest messages, not its oldest', async () => {
  /*
   * A real thread reached 201 messages and appeared to stop an hour in the past: the list
   * showed a reply that could not be found in the conversation, and no amount of scrolling
   * reached it, because it was never sent to the browser.
   *
   * The query ordered ascending and cut at the limit, which keeps the *oldest* 200. Every
   * message after the two hundredth was invisible, and would have stayed invisible for the
   * life of the thread.
   */
  const person = await customers.identify(ws, { channel: 'web', externalId: 'long-1' })
  const c = await convo.open(ws, person.id, 'web', 'w1:long-1')

  const start = Date.parse('2026-01-01T00:00:00Z')
  for (let i = 0; i < 205; i++)
    await convo.record(ws, c.id, {
      direction: 'in',
      body: `message ${i}`,
      speaker: 'customer',
      at: new Date(start + i * 60_000).toISOString(),
    })

  const shown = await convo.messages(ws, c.id)
  assert.equal(shown.length, 200, 'still bounded')
  assert.equal(shown.at(-1).body, 'message 204', 'the newest is the one you must not lose')
  assert.equal(shown[0].body, 'message 5', 'and the oldest five are what fall off instead')

  // Read downwards, oldest first — a conversation is not a stack.
  assert.ok(
    shown.every((m, i) => i === 0 || new Date(m.created_at) >= new Date(shown[i - 1].created_at)),
    'ascending',
  )
})

// -------------------------------------------- answering one thread without waking the bot

test('answering just this conversation leaves the bot watching everywhere else', async () => {
  /*
   * The whole feature, and the assertion that matters is the one about the bot's own mode.
   *
   * Before this there were two choices for somebody wanting to see what a bot had learned:
   * leave it silent, or switch it live and have it answer every customer on every channel it
   * holds. One thread is the thing they actually wanted.
   */
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo', mode: 'live' }))
  await bots.save(ws, bot.id, { connections: [{ channel: 'web', connection_ref: 'w1' }], mode: 'learning' })
  stubModel()

  const watched = await threadWith('are you open on Sunday?')
  await channels.replyAsPerson(ws, watched.id, 'Checking.', 'kit@example.com')
  await convo.record(ws, watched.id, { direction: 'in', body: 'still there?' })

  const done = await agent.handBack(ws, watched.id, { here: true })
  assert.equal(done.status, 'answered', 'it answers this thread')
  assert.equal((await bots.get(ws, bot.id)).mode, 'learning', 'and the bot is still only watching')
  assert.equal((await convo.get(ws, watched.id)).answers_live, true)

  // The next message on this thread is answered too, not handed back to a person.
  const again = await agent.handle(ws, {
    channel: 'web',
    channelRef: watched.channel_ref,
    from: watched.channel_ref.split(':')[1],
    text: 'and on Monday?',
  })
  assert.equal(again.status, 'answered', 'it keeps answering here, rather than once')

  // Every other conversation is untouched by it.
  const other = await threadWith('do you deliver?')
  const elsewhere = await agent.handle(ws, {
    channel: 'web',
    channelRef: other.channel_ref,
    from: other.channel_ref.split(':')[1],
    text: 'do you deliver?',
  })
  assert.equal(elsewhere.status, 'learning', 'another thread on the same bot still goes to a person')
  assert.equal((await convo.messages(ws, other.id)).filter((m) => m.direction === 'out').length, 0)
})

test('a person taking the thread over turns it off behind them', async () => {
  /*
   * The reply gate keeps out while `assignee` is set, so the bot is quiet either way. The
   * danger is later: hand the thread back and it would start answering again for a reason
   * nobody remembered choosing. Claiming a conversation clears the switch with it.
   */
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo', mode: 'live' }))
  await bots.save(ws, bot.id, { connections: [{ channel: 'web', connection_ref: 'w1' }], mode: 'learning' })
  stubModel()

  const conversation = await threadWith('are you open on Sunday?')
  await channels.replyAsPerson(ws, conversation.id, 'Checking.', 'kit@example.com')
  await convo.record(ws, conversation.id, { direction: 'in', body: 'still there?' })
  await agent.handBack(ws, conversation.id, { here: true })
  assert.equal((await convo.get(ws, conversation.id)).answers_live, true)

  await convo.setStatus(ws, conversation.id, 'human', 'kit@example.com')
  assert.equal((await convo.get(ws, conversation.id)).answers_live, false, 'a claim clears it')

  /*
   * And with it off, the bot stays out even once the thread is unclaimed again -- which it
   * reports as 'human' rather than 'learning', because a person's thread is turned away at
   * the gate above before the mode is ever consulted. What matters is that nothing was said.
   */
  await convo.setStatus(ws, conversation.id, 'human', null)
  const r = await agent.handle(ws, {
    channel: 'web',
    channelRef: conversation.channel_ref,
    from: conversation.channel_ref.split(':')[1],
    text: 'hello?',
  })
  assert.equal(r.status, 'human')
  assert.equal(r.reply, null, 'nothing reached the customer once the switch was off')
})

test('a paused bot is never answered out of, however the thread is set', async () => {
  // Paused means stop. A switch on one conversation must not make that promise negotiable --
  // and routing declines a paused bot anyway, which is the belt this is the braces for.
  const bot = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo', mode: 'live' }))
  await bots.save(ws, bot.id, { connections: [{ channel: 'web', connection_ref: 'w1' }], mode: 'paused' })
  stubModel()

  const conversation = await threadWith('are you open on Sunday?')
  await convo.setAnswersLive(ws, conversation.id, true)
  const r = await agent.handle(ws, {
    channel: 'web',
    channelRef: conversation.channel_ref,
    from: conversation.channel_ref.split(':')[1],
    text: 'anyone there?',
  })
  assert.notEqual(r.status, 'answered')
  assert.equal((await convo.messages(ws, conversation.id)).filter((m) => m.direction === 'out').length, 0)
})
