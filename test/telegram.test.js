import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
// No background loops in tests: the Telegram poller reads this too, and a long poll would
// hold the runner open waiting on a socket nobody is watching.
process.env.POLL_SECONDS = '0'
const db_ = await useSchema('telegram')
process.env.SECRET_KEY = 'test-secret-key-for-sealing-tokens'
const auth = await import('../src/server/auth.ts')
const tg = await import('../src/server/channels/telegram.ts')
const convo = await import('../src/server/conversations.ts')
const throttle = await import('../src/server/throttle.ts')
const { one } = await import('../src/server/db.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('tg@example.com')).workspaceId

// ---------------------------------------------------------------- the webhook

/** Telegram's API, stubbed. Returns what the real one returns for the calls we make. */
const realFetch = globalThis.fetch
let calls = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  // A file goes up as multipart, so the body is not always JSON any more. Recorded as it is
  // rather than parsed, so a test can assert on the form fields.
  const body = !init?.body ? null : init.body instanceof FormData ? init.body : JSON.parse(init.body)
  calls.push({ url: u, body })
  const method = u.split('/').pop()
  const result =
    method === 'getMe' ? { username: 'arlo_test_bot', first_name: 'Arlo' }
    : method === 'sendMessage' ? { message_id: 999 }
    : true
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
}
test.after(() => {
  globalThis.fetch = realFetch
})
test.beforeEach(() => {
  calls = []
})

const bot = await tg.add(ws, { label: 'Support', token: '123:ABC', base: 'https://arlo.example.com' })
const secret = (await one(`SELECT secret FROM telegram_bots WHERE id = ?`, bot.id)).secret
// Snapshot before beforeEach clears it — these are the calls add() itself made.
const addCalls = [...calls]

// ---------------------------------------------------------------- parse, which is pure

test('a plain text message is parsed', () => {
  const p = tg.parse({
    message: {
      message_id: 7,
      chat: { id: -100200 },
      from: { id: 4242, first_name: 'Ada', last_name: 'Lovelace' },
      text: '  how do refunds work?  ',
    },
  })
  assert.deepEqual(p, {
    chatId: '-100200',
    senderId: '4242',
    name: 'Ada Lovelace',
    text: 'how do refunds work?',
    // Scoped to the chat as well as the message, because Telegram's message_id is only
    // unique within a chat.
    messageId: 'telegram:-100200:7',
    at: null,
    file: null,
  })
})

/**
 * A file on its own is a message.
 *
 * Answering "you sent nothing" to a photo of a broken part is the wrong answer, so a
 * media-only message gets a body that says what arrived and carries the file with it.
 */
test('files are picked out of every shape Telegram sends one', () => {
  const doc = tg.parse({
    message: {
      message_id: 11,
      chat: { id: 5 },
      from: { id: 5, first_name: 'Ada' },
      caption: 'here is the receipt',
      document: { file_id: 'F1', file_name: 'receipt.pdf', mime_type: 'application/pdf', file_size: 4096 },
    },
  })
  assert.equal(doc.text, 'here is the receipt')
  assert.deepEqual(doc.file, { id: 'F1', name: 'receipt.pdf', mime: 'application/pdf', size: 4096 })

  // A photo arrives as a list of sizes; the last is the original and the rest are thumbs.
  const photo = tg.parse({
    message: {
      message_id: 12,
      chat: { id: 5 },
      from: { id: 5 },
      photo: [
        { file_id: 'small', file_size: 900 },
        { file_id: 'large', file_size: 90_000 },
      ],
    },
  })
  assert.equal(photo.file.id, 'large')
  assert.equal(photo.file.mime, 'image/jpeg')
  // No caption, so the body says what came rather than being empty.
  assert.ok(photo.text.startsWith('[sent '), photo.text)

  // Still nothing to answer when there is neither text nor a file.
  assert.equal(tg.parse({ message: { message_id: 13, chat: { id: 5 }, from: { id: 5 }, sticker: {} } }), null)
})

test('a photo caption counts as a question', () => {
  const p = tg.parse({ message: { message_id: 8, chat: { id: 5 }, from: { id: 5, username: 'kit' }, caption: 'is this covered?' } })
  assert.equal(p.text, 'is this covered?')
  assert.equal(p.name, 'kit')
})

test('everything that is not a person asking something is ignored', () => {
  for (const update of [
    {},
    { message: {} },
    { edited_message: { text: 'typo fixed' } },
    { message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: '   ' } },
    { message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, sticker: {} } },
    // Our own reply coming back to us. Without this the bot answers itself, forever.
    { message: { message_id: 1, chat: { id: 1 }, from: { id: 9, is_bot: true }, text: 'hello' } },
  ])
    assert.equal(tg.parse(update), null, JSON.stringify(update))
})

const message = (text, senderId = 4242, messageId = 1) => ({
  message: { message_id: messageId, chat: { id: 777 }, from: { id: senderId, first_name: 'Ada' }, text },
})

test('connecting a bot registers a webhook and drops the backlog', () => {
  // getMe first: a typo should be an error on the form, not a bot row that silently
  // never receives anything.
  assert.ok(addCalls[0].url.endsWith('/getMe'))

  const hook = addCalls.find((c) => c.url.endsWith('/setWebhook'))
  assert.equal(hook.body.url, `https://arlo.example.com/api/telegram/${bot.id}`)
  assert.ok(hook.body.secret_token.length >= 20)
  // An unused token has a queue of everything ever sent to it. Without this the first
  // thing a new connection does is answer a month of old messages at once.
  assert.equal(hook.body.drop_pending_updates, true)

  assert.ok(bot.id.length >= 16, 'the webhook id must not be guessable')
  assert.equal(bot.label, 'Support')
  // Empty allow list: a bot username is discoverable, so open-by-default would hand the
  // model budget to the first stranger who finds it.
  assert.deepEqual(bot.allowed, [])
})

test('the token is not stored in the clear', async () => {
  const row = await one(`SELECT token_enc FROM telegram_bots WHERE id = ?`, bot.id)
  assert.ok(row.token_enc.startsWith('enc:'), 'a database dump must not be a working bot token')
  assert.ok(!row.token_enc.includes('123:ABC'))
})

test('a request without the right secret header is refused', async () => {
  assert.deepEqual(await tg.handle(bot.id, null, message('hello')), { status: 'ignored', reason: 'bad secret' })
  assert.deepEqual(await tg.handle(bot.id, 'wrong', message('hello')), { status: 'ignored', reason: 'bad secret' })
  // The webhook URL is public by construction, so this header is the whole authentication.
})

test('an unknown bot id is ignored rather than erroring', async () => {
  assert.deepEqual(await tg.handle('deadbeefdeadbeef', secret, message('hello')), {
    status: 'ignored',
    reason: 'no such bot',
  })
})

test('a sender who is not on the allow list is refused and remembered', async () => {
  const r = await tg.handle(bot.id, secret, message('hello', 4242))
  assert.deepEqual(r, { status: 'refused', sender: '4242' })

  // Remembering them is what makes the allow list usable: it is the only practical way to
  // discover your own numeric Telegram id.
  const after = await tg.get(ws, bot.id)
  assert.equal(after.pending.length, 1)
  assert.equal(after.pending[0].id, '4242')
  assert.equal(after.pending[0].name, 'Ada')

  // Nothing was filed as a conversation.
  assert.deepEqual((await convo.inbox(ws)).rows, [])
})

test('the pending list keeps the last five and does not repeat a sender', async () => {
  for (let i = 0; i < 8; i++) await tg.handle(bot.id, secret, message('hi', 5000 + i, i))
  await tg.handle(bot.id, secret, message('again', 5007, 99))

  const after = await tg.get(ws, bot.id)
  assert.equal(after.pending.length, 5)
  assert.equal(new Set(after.pending.map((p) => p.id)).size, 5)
})

test('an allowed sender gets through, and their message becomes a conversation', async () => {
  await tg.allow(ws, bot.id, '4242')
  const after = await tg.get(ws, bot.id)
  assert.deepEqual(after.allowed, ['4242'])
  // Allowing somebody clears them from pending — they are decided, not waiting.
  assert.ok(!after.pending.some((p) => p.id === '4242'))

  const r = await tg.handle(bot.id, secret, message('how do refunds work?', 4242, 200))
  assert.equal(r.status, 'handled')

  const thread = await convo.get(ws, r.conversationId)
  assert.equal(thread.channel, 'telegram')
  assert.equal(thread.channel_ref, bot.id + ":777")
  // No model configured in the harness, so it goes to a person rather than being dropped.
  assert.equal(thread.status, 'human')
  assert.equal((await convo.messages(ws, r.conversationId))[0].body, 'how do refunds work?')
})

test('a redelivered webhook does not file the message twice', async () => {
  const first = await tg.handle(bot.id, secret, message('twice please', 4242, 300))
  const again = await tg.handle(bot.id, secret, message('twice please', 4242, 300))
  assert.equal(first.status, 'handled')
  assert.equal(again.status, 'handled')

  const bodies = (await convo.messages(ws, first.conversationId)).filter((m) => m.body === 'twice please')
  assert.equal(bodies.length, 1)
})

test('revoking puts somebody back outside', async () => {
  await tg.revoke(ws, bot.id, '4242')
  assert.deepEqual((await tg.get(ws, bot.id)).allowed, [])
  const r = await tg.handle(bot.id, secret, message('still there?', 4242, 400))
  assert.equal(r.status, 'refused')
})

test('a flood is deferred rather than dropped', async () => {
  await throttle.reset()
  await tg.allow(ws, bot.id, '4242')
  let deferred = 0
  for (let i = 0; i < 130; i++) {
    const r = await tg.handle(bot.id, secret, message('flood', 4242, 1000 + i))
    if (r.status === 'deferred') {
      deferred++
      // The route turns this into Retry-After, so a constant or a zero would be a retry
      // straight back into the same refusal.
      assert.ok(r.retryAfterMs > 0, 'the caller is told how long to wait')
    }
  }
  assert.ok(deferred > 0, 'a flood should eventually be deferred')
  /*
   * `deferred`, not `ignored`. This used to be `ignored` and the route answered 200, so
   * Telegram considered the update delivered and never sent it again — every message past the
   * limit was lost with one console line. The limiter exists to slow a flood down, not to
   * delete it.
   */
  await throttle.reset()
})

test('a reply goes back out through the bot', async () => {
  const conversation = await convo.find(ws, 'telegram', bot.id + ':777')
  calls = []
  const externalId = await tg.send(conversation, 'Five working days.')

  const sent = calls.find((c) => c.url.endsWith('/sendMessage'))
  assert.ok(sent, 'sendMessage was never called')
  assert.equal(sent.body.chat_id, '777')
  assert.equal(sent.body.text, 'Five working days.')
  // Our own message id, so the echo Telegram sends back is recognisable as ours.
  assert.equal(externalId, 'telegram:777:999')
})

test('another workspace cannot see or change this bot', async () => {
  const other = (await auth.provisionUser('tg-other@example.com')).workspaceId
  assert.deepEqual(await tg.list(other), [])
  assert.equal(await tg.get(other, bot.id), undefined)
  await assert.rejects(() => tg.allow(other, bot.id, '1'), /No such bot/)
  await assert.rejects(() => tg.remove(other, bot.id), /No such bot/)
})

/**
 * The reason the bot id is on the conversation rather than the chat id alone: a bot can
 * only message a chat it is itself in, so answering through whichever bot was connected
 * first is a delivery failure the moment there are two.
 */
test('with two bots connected, a reply goes out through the one that received it', async () => {
  await throttle.reset()
  const second = await tg.add(ws, { label: 'Sales', token: '999:XYZ', base: 'https://arlo.example.com' })
  const secondSecret = (await one(`SELECT secret FROM telegram_bots WHERE id = ?`, second.id)).secret
  await tg.allow(ws, second.id, '4242')

  const r = await tg.handle(second.id, secondSecret, {
    message: { message_id: 500, chat: { id: 888 }, from: { id: 4242, first_name: 'Ada' }, text: 'do you ship?' },
  })
  assert.equal(r.status, 'handled')

  const thread = await convo.get(ws, r.conversationId)
  assert.equal(thread.channel_ref, `${second.id}:888`)

  calls = []
  const externalId = await tg.send(thread, 'We do.')
  const sent = calls.find((c) => c.url.endsWith('/sendMessage'))
  assert.ok(sent.url.includes('/bot999:XYZ/'), 'the reply used the wrong bot token')
  assert.equal(sent.body.chat_id, '888')
  assert.equal(externalId, 'telegram:888:999')
})

// ---------------------------------------------------------------- sending a file

/** A resource with real bytes in it, ready to be sent. */
async function aFile(title, mime, body) {
  const { insert } = await import('../src/server/db.ts')
  const bytes = Buffer.from(body)
  const token = `tok-tg-${title.replace(/\W/g, '')}`.padEnd(24, '0').slice(0, 32)
  await insert(
    `INSERT INTO resources (workspace_id, kind, title, description, mime, bytes, size_bytes, token)
     VALUES (?, 'file', ?, '', ?, ?, ?, ?)`,
    ws, title, mime, bytes, bytes.length, token,
  )
  return { id: 1, kind: 'file', title, url: null, token, mime, size_bytes: bytes.length, bytes }
}

test('a document is uploaded as multipart, after the text', async () => {
  /*
   * Multipart and not a URL: the other way Telegram's API takes a document is to fetch one
   * itself, and `PUBLIC_URL` is often a private address its servers cannot reach. The JSON-only
   * helper cannot express this, which is why there are two.
   */
  const f = await aFile('price-list.pdf', 'application/pdf', '%PDF-1.4 prices')
  const id = await tg.send({ channel_ref: `${bot.id}:4242` }, 'Here is our price list.', [f])

  const text = calls.find((c) => c.url.endsWith('/sendMessage'))
  const doc = calls.find((c) => c.url.endsWith('/sendDocument'))
  assert.ok(text, 'the text was never sent')
  assert.ok(doc, 'the file was never sent')
  assert.ok(doc.body instanceof FormData, 'a document must go up as multipart, not JSON')

  const part = doc.body.get('document')
  assert.equal(part.name, 'price-list.pdf', 'the file must arrive with its own name')
  assert.equal(part.type, 'application/pdf')
  assert.equal(await part.text(), '%PDF-1.4 prices')
  assert.equal(doc.body.get('chat_id'), '4242')

  // The id is the text message's — it is what the redelivery guard matches on, and a file's
  // id would make our own reply look like a new question coming back at us.
  assert.equal(id, 'telegram:4242:999')
})

test('an image goes as a photo, so it previews in the chat', async () => {
  const f = await aFile('shelf.png', 'image/png', 'PNG pretend')
  await tg.send({ channel_ref: `${bot.id}:4242` }, 'Here it is.', [f])

  assert.ok(calls.find((c) => c.url.endsWith('/sendPhoto')), 'an image sent as a document does not preview')
  assert.ok(!calls.find((c) => c.url.endsWith('/sendDocument')))
})

test('a file that cannot be read does not cost the answer', async () => {
  // The message is the answer; the file is an enclosure. Losing the enclosure and keeping
  // the answer beats losing both.
  const id = await tg.send({ channel_ref: `${bot.id}:4242` }, 'Here is our price list.', [
    { id: 9, kind: 'file', title: 'gone.pdf', url: null, token: 'tok-tg-does-not-exist-00000', mime: 'application/pdf', size_bytes: 10 },
  ])
  assert.equal(id, 'telegram:4242:999')
  assert.ok(calls.find((c) => c.url.endsWith('/sendMessage')))
  assert.ok(!calls.find((c) => c.url.endsWith('/sendDocument')))
})

// ---------------------------------------------------------------- receiving without a public URL

test('a webhook Telegram will not accept falls back to polling rather than refusing', async () => {
  /*
   * The failure this exists for. A webhook is Telegram calling us, so it needs a hostname
   * their servers can resolve over HTTPS — which a laptop is not, and which the shipped
   * container is not either: docker-compose defaults PUBLIC_URL to 127.0.0.1. Adding a bot
   * answered "Bad Request: bad webhook: Failed to resolve host" and stopped there.
   *
   * That is a fact about somebody's network, not a reason they cannot use Telegram.
   */
  const saved = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const method = u.split('/').pop()
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    if (method === 'setWebhook')
      return new Response(
        JSON.stringify({ ok: false, description: 'Bad Request: bad webhook: Failed to resolve host: Name or service not known' }),
        { headers: { 'content-type': 'application/json' } },
      )
    const result = method === 'getMe' ? { username: 'local_bot', first_name: 'Local' } : true
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
  }

  try {
    const local = await tg.add(ws, { label: 'Laptop', token: '456:DEF', base: 'http://my-laptop:9005' })
    assert.ok(local, 'the bot is connected rather than the add being refused')

    const row = await one(`SELECT mode FROM telegram_bots WHERE id = ?`, local.id)
    assert.equal(row.mode, 'polling', 'and recorded as receiving the other way')
    assert.equal(local.mode, 'polling', 'which the page can read, so it can say so')

    // Mutually exclusive: Telegram refuses getUpdates with a 409 while a webhook is set, so
    // moving to polling has to clear whatever was there.
    assert.ok(
      calls.some((c) => c.url.endsWith('/deleteWebhook')),
      'the webhook is cleared before anything polls',
    )
  } finally {
    globalThis.fetch = saved
  }
})

test('TELEGRAM_POLLING skips the doomed attempt entirely', async () => {
  // For an install where the answer is known in advance — the container, whose PUBLIC_URL is
  // loopback — a setWebhook that cannot succeed is noise on every add.
  process.env.TELEGRAM_POLLING = '1'
  try {
    const forced = await tg.add(ws, { label: 'Docker', token: '789:GHI', base: 'http://127.0.0.1:9005' })
    assert.equal(forced.mode, 'polling')
    assert.equal(
      calls.some((c) => c.url.endsWith('/setWebhook')),
      false,
      'no webhook was attempted at all',
    )
  } finally {
    delete process.env.TELEGRAM_POLLING
  }
})

test('a bot added where a webhook works is left on the webhook', async () => {
  // The cloud path, unchanged. Falling back is for when Telegram refuses, not a new default.
  const hosted = await tg.add(ws, { label: 'Cloud', token: '321:XYZ', base: 'https://arlo.autobricks.ai' })
  assert.equal(hosted.mode, 'webhook')
  assert.ok(calls.some((c) => c.url.endsWith('/setWebhook')))
})

// ---------------------------------------------------------------- open to everyone

/**
 * The other half of the choice. A support bot is meant to be found, and its owner cannot
 * name every customer in advance — so the allow list has a switch, and closed is the default.
 */
test('a bot connects closed, which is the safe half of the choice', async () => {
  const fresh = await tg.add(ws, { label: 'Fresh', token: '111:AAA', base: 'https://arlo.example.com' })
  assert.equal(fresh.open, false)
})

test('an open bot answers a stranger who was never allowed', async () => {
  await throttle.reset()
  const open = await tg.setOpen(ws, bot.id, true)
  assert.equal(open.open, true)

  // 9001 is on nobody's list, and that is the point.
  const r = await tg.handle(bot.id, secret, message('do you ship to Malaysia?', 9001, 900))
  assert.equal(r.status, 'handled')
  // All these fixtures share chat 777, so it lands in the existing thread rather than a new one.
  const said = await convo.messages(ws, r.conversationId)
  assert.ok(said.some((m) => m.body === 'do you ship to Malaysia?'), 'the stranger was answered, not turned away')

  // Nothing is waiting to be let in when the door is not shut.
  assert.ok(!(await tg.get(ws, bot.id)).pending.some((p) => p.id === '9001'))
})

test('closing it again turns the same stranger away, with the old list intact', async () => {
  await throttle.reset()
  await tg.allow(ws, bot.id, '4242')
  await tg.setOpen(ws, bot.id, true)

  // Opening keeps the list rather than clearing it: closing should restore the people who
  // were let in by hand, not ask for them a second time.
  const closed = await tg.setOpen(ws, bot.id, false)
  assert.equal(closed.open, false)
  assert.deepEqual(closed.allowed, ['4242'])

  assert.equal((await tg.handle(bot.id, secret, message('hello again', 9001, 901))).status, 'refused')
  await throttle.reset()
  assert.equal((await tg.handle(bot.id, secret, message('and me?', 4242, 902))).status, 'handled')
})

test('an open bot is still rate limited, so a crowd cannot outspend one person', async () => {
  await throttle.reset()
  await tg.setOpen(ws, bot.id, true)

  // A different sender every time, which is the case the allow list used to cover for free.
  // The limiter is keyed on the bot rather than the sender, so a crowd is throttled as one —
  // key it per sender and an open bot would have no ceiling at all. WEBHOOK.max is 120.
  let refused = false
  for (let i = 0; i < 130 && !refused; i++) {
    const r = await tg.handle(bot.id, secret, message('flood', 9100 + i, 910 + i))
    refused = r.status === 'deferred'
  }
  assert.ok(refused, 'the per-bot limit applies to everyone, not per sender')

  await throttle.reset()
  await tg.setOpen(ws, bot.id, false)
})

test('another workspace cannot open this bot', async () => {
  await tg.setOpen(ws, bot.id, false)
  const other = (await auth.provisionUser('tg-open-other@example.com')).workspaceId

  await assert.rejects(() => tg.setOpen(other, bot.id, true), /No such bot/)
  assert.equal((await tg.get(ws, bot.id)).open, false, 'and it is still closed')
})
