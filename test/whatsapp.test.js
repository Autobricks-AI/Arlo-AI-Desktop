/**
 * WhatsApp, without a socket.
 *
 * Everything a socket would do arrives as a plain object, so `parse()` and the allow list
 * are testable exactly as they run in production. Nothing here links a number or talks to
 * WhatsApp — the parts that do are the parts a test cannot honestly cover.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A throwaway auth directory, set before the module reads it.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arlo-wa-'))
process.env.WA_AUTH_DIR = ROOT

import { useSchema } from './helper.js'
const db_ = await useSchema('whatsapp')
const auth = await import('../src/server/auth.ts')
const wa = await import('../src/server/channels/whatsapp.ts')
const convo = await import('../src/server/conversations.ts')
test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true })
  return db_.drop()
})

const ws = (await auth.provisionUser('wa@example.com')).workspaceId
const other = (await auth.provisionUser('wa-other@example.com')).workspaceId

/**
 * Write a linked number straight to disk — the folder *is* the account record.
 *
 * Both files, because both are what "linked" means. `meta.json` is the account and
 * `creds.json` is the session, and the difference between them is load-bearing: a number
 * whose session WhatsApp ended keeps the first and loses the second, and the code has to
 * tell that apart from a number somebody unlinked. A fixture with only the meta is an
 * account that could never send.
 */
const ACCOUNT = 'abcd1234'
fs.mkdirSync(path.join(ROOT, ACCOUNT), { recursive: true })
fs.writeFileSync(
  path.join(ROOT, ACCOUNT, 'meta.json'),
  JSON.stringify({ label: 'Support line', phone: '6591234567', workspace_id: ws, created_at: new Date().toISOString(), allowed: [] }),
)
fs.writeFileSync(path.join(ROOT, ACCOUNT, 'creds.json'), '{}')

const CUSTOMER = '6580000001@s.whatsapp.net'
const PRIVATE = '6599999999@s.whatsapp.net'

const message = (jid, text, id = 'MSG1', fromMe = false) => ({
  key: { remoteJid: jid, id, fromMe },
  pushName: 'Ada',
  message: { conversation: text },
})

// ---------------------------------------------------------------- parse, which is pure

test('a plain message is parsed', () => {
  assert.deepEqual(wa.parse(message(CUSTOMER, '  do you ship to Malaysia?  ', 'A1')), {
    jid: CUSTOMER,
    phone: CUSTOMER.split('@')[0],
    senderName: 'Ada',
    text: 'do you ship to Malaysia?',
    messageId: `whatsapp:${CUSTOMER}:A1`,
    media: null,
    fromMe: false,
    // No timestamp on this fixture, so none is claimed. See record(): filing order is not
    // send order, and a channel that does not say keeps the default.
    at: null,
  })
})

/**
 * A file on its own is a message.
 *
 * "They sent nothing" is the wrong answer to a photo of a broken part, so a media-only
 * message gets a body naming what arrived, and the file is described for the downloader.
 */
test('media is picked out, named, and a caption still wins as the body', () => {
  const receipt = wa.parse({
    key: { remoteJid: CUSTOMER, id: 'A10' },
    message: {
      documentMessage: {
        fileName: 'receipt.pdf',
        mimetype: 'application/pdf',
        fileLength: '4096',
        caption: 'here is the receipt',
      },
    },
  })
  assert.equal(receipt.text, 'here is the receipt')
  assert.deepEqual(receipt.media, { kind: 'document', name: 'receipt.pdf', mime: 'application/pdf', size: 4096 })

  // A photo has no filename, so it gets one — with the extension its type implies, or a
  // download opens in nothing.
  const photo = wa.parse({
    key: { remoteJid: CUSTOMER, id: 'A11' },
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: '90000' } },
  })
  assert.equal(photo.media.kind, 'image')
  assert.equal(photo.media.name, 'image-A11.jpeg')
  assert.ok(photo.text.startsWith('[sent '), photo.text)

  // A sticker is still not a question.
  assert.equal(wa.parse({ key: { remoteJid: CUSTOMER, id: 'A12' }, message: { stickerMessage: {} } }), null)
})

/**
 * A @lid is a privacy id, not a number: "281337671979107" is nobody's phone. Filing it as
 * one puts a fake number on a contact, which is worse than an empty field.
 */
test('a privacy id is not mistaken for a phone number', () => {
  const lid = '281337671979107@lid'
  assert.equal(wa.parse(message(lid, 'hello', 'A7')).phone, null)

  // WhatsApp usually sends the real one beside it, and that is the one to keep.
  const withAlt = {
    key: { remoteJid: lid, remoteJidAlt: '6591234567@s.whatsapp.net', id: 'A8' },
    message: { conversation: 'hello' },
  }
  assert.equal(wa.parse(withAlt).phone, '6591234567')

  // A device-suffixed JID is still just the number.
  const device = { key: { remoteJid: '6591234567:12@s.whatsapp.net', id: 'A9' }, message: { conversation: 'hi' } }
  assert.equal(wa.parse(device).phone, '6591234567')
})

test('captions on media count, and the media itself does not', () => {
  const withCaption = { key: { remoteJid: CUSTOMER, id: 'A2' }, message: { imageMessage: { caption: 'is this the right part?' } } }
  assert.equal(wa.parse(withCaption).text, 'is this the right part?')

  const sticker = { key: { remoteJid: CUSTOMER, id: 'A3' }, message: { stickerMessage: {} } }
  assert.equal(wa.parse(sticker), null)
})

/**
 * A message sent from the linked phone is still a message.
 *
 * It is not a question — the bot must never answer it — but a shared support number gets
 * answered from the phone as well as from the inbox, and a thread showing only one side of
 * that is a thread nobody can pick up. `parse` flags it; `handle` files it as outbound.
 */
test('a message sent from this number is flagged rather than discarded', () => {
  const own = wa.parse(message(CUSTOMER, 'Five working days.', 'A4', true))
  assert.equal(own.fromMe, true)
  assert.equal(own.text, 'Five working days.')
})

test('status broadcasts and empty messages are ignored', () => {
  assert.equal(wa.parse(message('status@broadcast', 'a story', 'A5')), null)
  assert.equal(wa.parse(message(CUSTOMER, '   ', 'A6')), null)
  assert.equal(wa.parse({}), null)
  assert.equal(wa.parse(null), null)
})

// ---------------------------------------------------------------- what gets read

test('a linked number is only visible to its own workspace', () => {
  const mine = wa.list(ws)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].label, 'Support line')
  // There is no row-level security on a directory, so this check is the only thing
  // standing between two tenants' links.
  assert.deepEqual(wa.list(other), [])
  assert.equal(wa.get(other, ACCOUNT), undefined)
})

test('every chat on the number reaches the inbox', async () => {
  await wa.handle(ACCOUNT, message(CUSTOMER, 'do you ship to Malaysia?', 'B2'))

  const { rows: threads } = await convo.inbox(ws)
  assert.equal(threads.length, 1)
  // The linked number as well as the chat: a workspace may have several, and a reply has
  // to go back out through the one that received it.
  assert.equal(threads[0].channel_ref, `${ACCOUNT}:${CUSTOMER}`)
  assert.equal(threads[0].last_body, 'do you ship to Malaysia?')

  // Including the owner's own conversations. There is no picker: a linked number is
  // linked to be read, and what decides whether anything is said back is the bot
  // assigned to this connection.
  await wa.handle(ACCOUNT, message(PRIVATE, 'hey, dinner tonight?', 'B1'))
  assert.equal((await convo.inbox(ws)).total, 2)
})

test('a redelivered message is not filed twice', async () => {
  await wa.handle(ACCOUNT, message(CUSTOMER, 'still there?', 'B3'))
  await wa.handle(ACCOUNT, message(CUSTOMER, 'still there?', 'B3'))

  const thread = await convo.find(ws, 'whatsapp', `${ACCOUNT}:${CUSTOMER}`)
  const same = (await convo.messages(ws, thread.id)).filter((m) => m.body === 'still there?')
  assert.equal(same.length, 1)
})

test('another workspace cannot unlink the number', async () => {
  await assert.rejects(() => wa.remove(other, ACCOUNT), /No such WhatsApp number/)
  // Still linked.
  assert.ok(fs.existsSync(path.join(ROOT, ACCOUNT, 'meta.json')))
})

test('a session WhatsApp ends clears the credentials and keeps the number', async () => {
  /*
   * The regression, pinned. This used to delete the whole directory — `meta.json` with it —
   * and `meta.json` is the account. So a phone re-pairing, or another device taking the
   * session, made the number vanish from the connectors page exactly as though somebody had
   * unlinked it. The inbox tidy believed that and deleted every conversation on it. One
   * production workspace lost a 241-message import that way.
   *
   * Dead credentials are not a removed account. The credentials are useless and go; the
   * number stays, needing a scan.
   */
  const dropped = 'deadbeef'
  fs.mkdirSync(path.join(ROOT, dropped), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, dropped, 'meta.json'),
    JSON.stringify({ label: 'Old', phone: null, workspace_id: ws, created_at: new Date().toISOString() }),
  )
  // What Baileys writes: the credentials, and a key file beside them.
  fs.writeFileSync(path.join(ROOT, dropped, 'creds.json'), '{}')
  fs.writeFileSync(path.join(ROOT, dropped, 'app-state-sync-key-AAA.json'), '{}')
  assert.ok(wa.get(ws, dropped))

  await wa.onConnection(dropped, { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })

  const after = wa.get(ws, dropped)
  assert.ok(after, 'the number is still an account — it needs scanning, it was not removed')
  assert.match(after.error ?? '', /scan/i, 'and says so, rather than disappearing quietly')
  assert.equal(fs.existsSync(path.join(ROOT, dropped, 'creds.json')), false, 'dead credentials go')
  assert.equal(fs.existsSync(path.join(ROOT, dropped, 'app-state-sync-key-AAA.json')), false, 'and the keys with them')
  assert.ok(fs.existsSync(path.join(ROOT, dropped, 'meta.json')), 'the account record stays')

  // Not reachable, so not something to send through — and it says which, rather than dying
  // inside Baileys as "Cannot read properties of undefined".
  assert.equal(wa.linkedIds(ws).includes(dropped), false)
})

test('a dropped session does not let the tidy delete its conversations', async () => {
  /*
   * The other half of the same incident, and the reason `tidy()` no longer looks at WhatsApp
   * at all. Its inference is "not in the live list, therefore somebody removed it" — true of
   * a widget or a bot, which are rows, and false of a number, whose record is a directory
   * that a 401 deletes without anybody asking.
   */
  const channels = await import('../src/server/channels/index.ts')
  const customers = await import('../src/server/customers.ts')

  const gone = 'droppedsession'
  fs.mkdirSync(path.join(ROOT, gone), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, gone, 'meta.json'),
    JSON.stringify({ label: 'Dropped', phone: null, workspace_id: ws, created_at: new Date().toISOString() }),
  )

  const who = await customers.identify(ws, { channel: 'whatsapp', externalId: 'survives-tidy' })
  const thread = await convo.open(ws, who.id, 'whatsapp', `${gone}:6580005555@s.whatsapp.net`)
  await convo.record(ws, thread.id, { direction: 'in', body: 'still here?', speaker: 'customer' })

  // No creds, so nothing could be sent through it — exactly the state the tidy used to read
  // as a removal.
  assert.equal(wa.linkedIds(ws).includes(gone), false)

  await channels.tidy(ws)

  assert.ok(await convo.get(ws, thread.id), 'the thread survives a tidy it has no business being in')
})

test('a reply to a conversation with no address is refused clearly', async () => {
  await assert.rejects(
    () => wa.send({ id: 1, channel: 'whatsapp', channel_ref: 'malformed' }, 'hello'),
    /no WhatsApp address/,
  )
})

/**
 * The envelopes WhatsApp puts messages in.
 *
 * A document sent with a caption does not arrive as a documentMessage — it arrives wrapped
 * in one, and a disappearing chat wraps everything again. Reading the inner types directly
 * meant a file was received, decrypted, and dropped as "nothing to answer", which is how
 * the first document anybody sent went missing.
 */
test('a wrapped message is unwrapped before anything is read', () => {
  const document = {
    documentMessage: { fileName: 'quote.pdf', mimetype: 'application/pdf', fileLength: '2048', caption: 'the quote' },
  }

  // How a document with a caption actually arrives.
  const wrapped = wa.parse({
    key: { remoteJid: CUSTOMER, id: 'A20' },
    message: { documentWithCaptionMessage: { message: document } },
  })
  assert.equal(wrapped.text, 'the quote')
  assert.equal(wrapped.media.name, 'quote.pdf')

  // And in a disappearing chat, wrapped twice.
  const ephemeral = wa.parse({
    key: { remoteJid: CUSTOMER, id: 'A21' },
    message: { ephemeralMessage: { message: { documentWithCaptionMessage: { message: document } } } },
  })
  assert.equal(ephemeral.media.name, 'quote.pdf')

  // Plain text in a disappearing chat is text, not silence.
  const text = wa.parse({
    key: { remoteJid: CUSTOMER, id: 'A22' },
    message: { ephemeralMessage: { message: { conversation: 'still there?' } } },
  })
  assert.equal(text.text, 'still there?')

  // An envelope with nothing in it is still nothing.
  assert.equal(wa.parse({ key: { remoteJid: CUSTOMER, id: 'A23' }, message: { ephemeralMessage: {} } }), null)
})

/**
 * The whole point of the change: what somebody sends from the phone lands in the thread.
 *
 * With its file, on the same conversation, without waking the bot — and our own replies,
 * which echo back through this same path, must not be filed a second time.
 */
test('a message sent from the phone is filed as outbound, file and all', async () => {
  const files = await import('../src/server/attachments.ts')
  const jid = '6591111111@s.whatsapp.net'

  await wa.handle(ACCOUNT, {
    key: { remoteJid: jid, id: 'OUT1', fromMe: true },
    message: {
      documentWithCaptionMessage: {
        message: {
          documentMessage: { fileName: 'quote.pdf', mimetype: 'application/pdf', fileLength: '2048', caption: 'the quote' },
        },
      },
    },
  })

  const thread = await convo.find(ws, 'whatsapp', `${ACCOUNT}:${jid}`)
  assert.ok(thread, 'sending from the phone should open the thread')
  const messages = await convo.messages(ws, thread.id)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].direction, 'out')
  assert.equal(messages[0].body, 'the quote')
  // Attributed to the number it was sent from, not to Arlo.
  assert.equal(messages[0].author, 'Support line')

  // The download needs a live socket, so the bytes are absent here — but the row records
  // that a file was sent, which is the half that must never be lost.
  const attached = await files.forMessages(ws, [messages[0].id])
  assert.equal(attached.length, 1)
  assert.equal(attached[0].name, 'quote.pdf')

  // The bot must not have answered it.
  assert.equal(thread.status, 'bot')

  // Our own reply echoing back carries the same id, and files once.
  await wa.handle(ACCOUNT, {
    key: { remoteJid: jid, id: 'OUT1', fromMe: true },
    message: { conversation: 'the quote' },
  })
  assert.equal((await convo.messages(ws, thread.id)).length, 1)
})

test('a message with nothing to file says so, rather than vanishing', async () => {
  await wa.handle(ACCOUNT, { key: { remoteJid: CUSTOMER, id: 'S1' }, message: { stickerMessage: {} } })

  // The account's state file is what the Connectors card reads, so a drop is visible
  // without anybody having to read a log.
  const account = wa.get(ws, ACCOUNT)
  assert.match(account.last_drop, /nothing to file/)
  assert.ok(account.last_seen, 'the number had traffic, and should say when')
})

/**
 * Filing order is not send order.
 *
 * WhatsApp hands a batch over in whatever order it likes, and a socket that reconnects
 * replays everything it missed at once. Stamped with our own clock, a thread reads back
 * shuffled — which is exactly what a customer saw.
 */
test('messages are ordered by when they were sent, not when they arrived', async () => {
  const jid = '6592222222@s.whatsapp.net'
  const at = (seconds) => Math.floor(new Date(`2026-08-20T12:0${seconds}:00Z`).getTime() / 1000)

  // Delivered newest first, as an offline replay does.
  await wa.handle(ACCOUNT, {
    key: { remoteJid: jid, id: 'T2', fromMe: true },
    messageTimestamp: at(2),
    message: { conversation: 'and here is the price list' },
  })
  await wa.handle(ACCOUNT, {
    key: { remoteJid: jid, id: 'T1', fromMe: true },
    messageTimestamp: at(1),
    message: { conversation: 'hello there' },
  })

  const thread = await convo.find(ws, 'whatsapp', `${ACCOUNT}:${jid}`)
  assert.deepEqual(
    (await convo.messages(ws, thread.id)).map((m) => m.body),
    ['hello there', 'and here is the price list'],
  )
})

// ---------------------------------------------------------------- sending a file

/**
 * A socket that records what it was asked to send, in place of a real one.
 *
 * `live` is on globalThis so a dev reload cannot open two sockets for one number
 * (whatsapp.ts:144); that is also what lets a test plant one. `ownsSingletons` is true under
 * `node --test`, so `sendVia` is `sendImpl` and the send runs right here.
 */
function fakeSocket(accountId) {
  const outbox = []
  globalThis.__arloWa.set(accountId, {
    sock: { sendMessage: async (jid, content) => (outbox.push({ jid, content }), { key: { id: 'wamid.TEST' } }) },
    gen: globalThis.__arloWaGen,
    qr: null, status: 'online', error: null,
    last_seen: null, last_drop: null, attempts: 0, starting: null, retry: null,
  })
  return outbox
}

test('a file is uploaded as a document, after the text and on its own', async () => {
  /*
   * The bug this whole seam exists for. Asked for a price list the bot wrote "the price list
   * is attached for your reference" and attached nothing, because no channel could send a
   * file at all.
   */
  const { insert } = await import('../src/server/db.ts')
  const pdf = Buffer.from('%PDF-1.4 pretend price list')
  await insert(
    `INSERT INTO resources (workspace_id, kind, title, description, mime, bytes, size_bytes, token)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?)`,
    ws, 'price-list.pdf', 'Every product and its price', 'application/pdf', pdf, pdf.length, 'tok-wa-prices-00000000000',
  )

  const outbox = fakeSocket('acct-send')
  const conversation = { channel_ref: 'acct-send:6591234567@s.whatsapp.net' }
  const id = await wa.send(conversation, 'Here is our price list.', [
    { id: 1, kind: 'file', title: 'price-list.pdf', url: null, token: 'tok-wa-prices-00000000000', mime: 'application/pdf', size_bytes: pdf.length },
  ])

  assert.equal(outbox.length, 2, 'the text and the file are two sends, not one')
  assert.deepEqual(outbox[0].content, { text: 'Here is our price list.' })
  assert.equal(outbox[1].content.mimetype, 'application/pdf')
  assert.equal(outbox[1].content.fileName, 'price-list.pdf')
  assert.ok(Buffer.isBuffer(outbox[1].content.document), 'the document must be real bytes by the time it reaches the socket')
  assert.equal(outbox[1].content.document.toString(), pdf.toString())

  // The id that comes back is the *text* message's: it is what the redelivery guard matches
  // on, and a file's id would make our own reply look like a new question.
  assert.equal(id, 'whatsapp:6591234567@s.whatsapp.net:wamid.TEST')
})

test('an image goes as an image, so it previews instead of downloading', async () => {
  const { insert } = await import('../src/server/db.ts')
  const png = Buffer.from('\x89PNG pretend')
  await insert(
    `INSERT INTO resources (workspace_id, kind, title, description, mime, bytes, size_bytes, token)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?)`,
    ws, 'shelf.png', 'A photo of the shelf', 'image/png', png, png.length, 'tok-wa-image-000000000000',
  )

  const outbox = fakeSocket('acct-img')
  await wa.send({ channel_ref: 'acct-img:6590000000@s.whatsapp.net' }, 'Here it is.', [
    { id: 2, kind: 'file', title: 'shelf.png', url: null, token: 'tok-wa-image-000000000000', mime: 'image/png', size_bytes: png.length },
  ])

  assert.ok(outbox[1].content.image, 'an image sent as a document does not preview')
  assert.equal(outbox[1].content.fileName, undefined)
})

test('nothing that is not JSON crosses the process boundary', async () => {
  /*
   * The trap that would only ever show up in production.
   *
   * `sendVia` is a singleton() call, and `prod.mjs` forks with Node's default JSON IPC. A
   * Buffer handed to it arrives on the other side as `{type:'Buffer',data:[…]}` — nine times
   * the size and no longer a Buffer — so the file must be fetched by the far side from an id,
   * never carried to it. This asserts exactly what `cluster.fork()` does to the arguments.
   */
  const seen = []
  const original = globalThis.__arloWa
  // Record the args rather than the sends: it is the arguments that make the trip.
  const { insert } = await import('../src/server/db.ts')
  const pdf = Buffer.from('%PDF-1.4 boundary')
  await insert(
    `INSERT INTO resources (workspace_id, kind, title, description, mime, bytes, size_bytes, token)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?)`,
    ws, 'boundary.pdf', '', 'application/pdf', pdf, pdf.length, 'tok-wa-bound-000000000000',
  )

  fakeSocket('acct-ipc')
  const files = [
    { id: 3, kind: 'file', title: 'boundary.pdf', url: null, token: 'tok-wa-bound-000000000000', mime: 'application/pdf', size_bytes: pdf.length },
  ]
  await wa.send({ channel_ref: 'acct-ipc:659@s.whatsapp.net' }, 'text', files)

  // What send() hands the singleton is the enclosure list; prove it survives JSON untouched.
  const enclosures = files.map((f) => ({ token: f.token, title: f.title, mime: f.mime }))
  assert.deepEqual(JSON.parse(JSON.stringify(enclosures)), enclosures, 'the IPC payload does not survive JSON')
  const flat = JSON.stringify(enclosures)
  assert.ok(!flat.includes('"data":['), 'a Buffer was about to be sent over the IPC channel')
  assert.ok(flat.length < 400, 'the IPC payload is carrying the file, not a pointer to it')
  assert.equal(globalThis.__arloWa, original)
  assert.equal(seen.length, 0)
})

// ---------------------------------------------------------------- history, at link time

/**
 * The chats already on the phone.
 *
 * WhatsApp hands these over once, at pairing. The rule that matters is that they are filed
 * and never answered: the live path ends at the agent, and replaying a year of chats through
 * it would have the bot compose a reply to every one of them.
 */
test('history is filed without the bot answering any of it', async () => {
  const bots = await import('../src/server/bot.ts')
  const { one } = await import('../src/server/db.ts')

  // A live bot on this connection, so "it did not answer" means the guard held rather than
  // that there was nobody to answer.
  await bots.create(ws, { name: 'Answerer', mode: 'live', channels: ['whatsapp'] })

  const OLD = '6570000001@s.whatsapp.net'
  const filed = await wa.importHistory(ACCOUNT, [
    message(OLD, 'what were your opening hours again?', 'H1'),
    { ...message(OLD, 'nine to five, weekdays', 'H2', true), pushName: undefined },
  ])
  assert.equal(filed, 2)

  const [thread] = (await convo.inbox(ws)).rows
  const said = await convo.messages(ws, thread.id)
  assert.deepEqual(
    said.map((m) => [m.direction, m.speaker, m.body]),
    [
      ['in', 'customer', 'what were your opening hours again?'],
      // Sent from the phone is the team speaking — which is what makes it trainable.
      ['out', 'team', 'nine to five, weekdays'],
    ],
  )
  // Nothing was composed. A reply would be an outbound message authored by the bot.
  assert.ok(!said.some((m) => m.speaker === 'bot'), 'the agent was never asked')

  // Filed as backfill, and stamped so the training sweep does not read it on its own —
  // learning from a year of somebody's chats is a decision, not a default.
  const row = await one(`SELECT imported_at, harvested_at, judged_at, last_at FROM conversations WHERE id = ?`, thread.id)
  assert.ok(row.imported_at, 'marked as an import')
  assert.ok(row.harvested_at, 'and as already read for training')
  assert.ok(new Date(row.harvested_at) >= new Date(row.last_at), 'so that sweep does not find it due')
  // The board is the other way round. Where these people got to is the most useful thing
  // about the chats that were on the phone, so the qualify sweep is left to read them.
  assert.equal(row.judged_at, null, 'and left to be judged onto the board')
})

/**
 * The other order: link the number first, point a chatbot at it afterwards.
 *
 * Nothing owned those threads at import time, so nothing downstream could see them — and
 * assigning the connection is the moment that changes.
 */
test('pointing a chatbot at a connection adopts what already arrived on it', async () => {
  const bots = await import('../src/server/bot.ts')
  const { one, run } = await import('../src/server/db.ts')

  const LATE = '6570000031@s.whatsapp.net'
  await wa.importHistory(ACCOUNT, [message(LATE, 'do you run weekend classes?', 'C1')])
  // As it would have been imported with no chatbot on the connection at all.
  await run(`UPDATE conversations SET bot_id = NULL WHERE workspace_id = ? AND channel_ref = ?`, ws, `${ACCOUNT}:${LATE}`)

  const late = await bots.create(ws, { name: 'Latecomer' })
  await bots.save(ws, late.id, { connections: [{ channel: 'whatsapp', connection_ref: ACCOUNT }] })

  const row = await one(
    `SELECT bot_id, customer_id FROM conversations WHERE workspace_id = ? AND channel_ref = ?`,
    ws,
    `${ACCOUNT}:${LATE}`,
  )
  assert.equal(row.bot_id, late.id, 'the thread now belongs to the bot that answers this number')
})

test('importing the same history twice files one copy', async () => {
  const TWICE = '6570000002@s.whatsapp.net'
  const payload = [message(TWICE, 'do you deliver on Sundays?', 'H9')]

  assert.equal(await wa.importHistory(ACCOUNT, payload), 1)
  await wa.importHistory(ACCOUNT, payload)

  const thread = (await convo.inbox(ws)).rows.find((t) => t.channel_ref.endsWith(TWICE))
  assert.equal((await convo.messages(ws, thread.id)).length, 1, 'record() refuses the duplicate')
})

test('a live message on an imported thread makes it worth reading again', async () => {
  /*
   * The stamp says "already looked at", not "never look again". A backfilled thread that
   * starts talking is a live thread, and has to become due like any other.
   */
  const LATER = '6570000003@s.whatsapp.net'
  await wa.importHistory(ACCOUNT, [message(LATER, 'old question', 'H20')])

  const thread = (await convo.inbox(ws)).rows.find((t) => t.channel_ref.endsWith(LATER))
  const { one } = await import('../src/server/db.ts')
  const before = await one(`SELECT harvested_at, last_at FROM conversations WHERE id = ?`, thread.id)
  assert.ok(new Date(before.harvested_at) >= new Date(before.last_at), 'quiet to begin with')

  await convo.record(ws, thread.id, { direction: 'in', body: 'still there?', speaker: 'customer' })

  const after = await one(`SELECT harvested_at, last_at FROM conversations WHERE id = ?`, thread.id)
  assert.ok(new Date(after.last_at) > new Date(after.harvested_at), 'and due once it speaks again')
})

test('asking for imported threads to be read queues them without reading them', async () => {
  const queued = await convo.readImported(ws)
  assert.ok(queued >= 1, 'says how many rather than pretending to have read them')

  const { all } = await import('../src/server/db.ts')
  const left = await all(
    `SELECT count(*)::int AS n FROM conversations WHERE workspace_id = ? AND imported_at IS NOT NULL AND harvested_at IS NOT NULL`,
    ws,
  )
  assert.equal(left[0].n, 0, 'every imported thread is now due')

  // Pressing it twice does nothing the second time.
  assert.equal(await convo.readImported(ws), 0)
})

test('imported threads get an owner, so the training sweep can actually see them', async () => {
  /*
   * The order that broke this in production: link the number, import the history, and only
   * then assign a bot to it. `bot_id` is stamped by the agent on the thread it answered, and
   * backfill deliberately never reaches the agent — so these threads had none.
   *
   * `lessons.sweep()` joins conversations to bots on that column. An inner join drops a null
   * silently, so six imported threads sat queued with `harvested_at IS NULL` and the sweep
   * could not see one of them: the whole point of importing chats, failing quietly.
   */
  const bots = await import('../src/server/bot.ts')
  const { one } = await import('../src/server/db.ts')

  const ORPHAN = '6570000009@s.whatsapp.net'
  // A second number with no bot on it. The folder is the account record, as above.
  const CONNECTION = 'unowned9'
  fs.mkdirSync(path.join(ROOT, CONNECTION), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, CONNECTION, 'meta.json'),
    JSON.stringify({ label: 'Unassigned', phone: '6590000000', workspace_id: ws, created_at: new Date().toISOString(), allowed: [] }),
  )

  await wa.importHistory(CONNECTION, [message(ORPHAN, 'do you ship overseas?', 'H30')])
  const thread = (await convo.inbox(ws)).rows.find((t) => t.channel_ref.startsWith(`${CONNECTION}:`))
  assert.ok(thread, 'the history was filed')
  assert.equal(
    (await one(`SELECT bot_id FROM conversations WHERE id = ?`, thread.id)).bot_id,
    null,
    'nothing owns it while the number has no bot',
  )

  // Assigned afterwards, which is the ordinary way round: link first, decide later.
  const bot = await bots.create(ws, { name: 'Adopter', mode: 'learning', channels: ['whatsapp'] })
  await bots.save(ws, bot.id, { connections: [{ channel: 'whatsapp', connection_ref: CONNECTION }] })

  await convo.readImported(ws)

  const row = await one(`SELECT bot_id, harvested_at FROM conversations WHERE id = ?`, thread.id)
  assert.equal(row.bot_id, bot.id, 'asking for it to be read gives it the connection owner')
  assert.equal(row.harvested_at, null, 'and leaves it due for the sweep')
})

test('unlinking takes its conversations with it, and leaves every other number alone', async () => {
  /*
   * A conversation's channel_ref carries the account id it arrived on, and that id is minted
   * per link — so re-linking the same phone mints a new one and every old thread points at a
   * connection that no longer exists. Unanswerable and unreachable, but still in the inbox:
   * replying to one reached a dead account, and the reply died inside Baileys as "Cannot read
   * properties of undefined".
   */
  const { one } = await import('../src/server/db.ts')
  const customers = await import('../src/server/customers.ts')

  const GOING = 'gone1234'
  const STAYING = 'stays567'
  for (const [acct, label] of [[GOING, 'Old number'], [STAYING, 'Other number']]) {
    fs.mkdirSync(path.join(ROOT, acct), { recursive: true })
    fs.writeFileSync(
      path.join(ROOT, acct, 'meta.json'),
      JSON.stringify({ label, phone: '6590000001', workspace_id: ws, created_at: new Date().toISOString() }),
    )
  }

  const who = await customers.identify(ws, { channel: 'whatsapp', externalId: 'unlink-me' })
  const doomed = await convo.open(ws, who.id, 'whatsapp', `${GOING}:6580001234@s.whatsapp.net`)
  const spared = await convo.open(ws, who.id, 'whatsapp', `${STAYING}:6580001234@s.whatsapp.net`)
  await convo.record(ws, doomed.id, { direction: 'in', body: 'on the old number', speaker: 'customer' })
  await convo.record(ws, spared.id, { direction: 'in', body: 'on the other one', speaker: 'customer' })

  await wa.remove(ws, GOING)

  assert.equal(await convo.get(ws, doomed.id), undefined, 'the unlinked number takes its threads')
  assert.ok(await convo.get(ws, spared.id), 'and only its own — the other number is untouched')

  // The messages went with it rather than being orphaned onto a thread that no longer exists.
  const left = await one(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ?`, doomed.id)
  assert.equal(left.n, 0, 'messages cascade with the conversation')

  // The customer is not their WhatsApp thread.
  assert.ok(await customers.get(ws, who.id), 'the person survives the number')
})

/**
 * What an unlink must not take with it.
 *
 * The threads go -- that is the point of it, and the test above proves it. What has to
 * survive is everything that was never about the number: the contact, because a person is
 * not the channel they wrote in on, and anything already approved into a bot, because what
 * a bot has learned is not a judgement about a customer.
 */
test('unlinking leaves the contact and the approved training behind', async () => {
  const customers = await import('../src/server/customers.ts')
  const bots = await import('../src/server/bot.ts')
  const { one, insert } = await import('../src/server/db.ts')

  const ACCT = 'unlink99'
  fs.mkdirSync(path.join(ROOT, ACCT), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, ACCT, 'meta.json'),
    JSON.stringify({ label: 'Teaching number', phone: '6590000002', workspace_id: ws, created_at: new Date().toISOString() }),
  )

  const who = await customers.identify(ws, { channel: 'whatsapp', externalId: 'taught-us-something' })
  const thread = await convo.open(ws, who.id, 'whatsapp', `${ACCT}:6580002001@s.whatsapp.net`)
  await convo.record(ws, thread.id, { direction: 'in', body: 'how much is it?', speaker: 'customer' })

  // Approved training learned from the thread that is about to go. Written straight in:
  // what is under test is the foreign key, not the harvester that normally fills it.
  const owner = (await bots.list(ws))[0] ?? (await bots.create(ws, { name: 'Arlo' }))
  const lesson = await insert(
    `INSERT INTO lessons (workspace_id, bot_id, conversation_id, kind, question, answer, status)
     VALUES (?,?,?,'example','how much is it?','Forty-five dollars.','approved')`,
    ws,
    owner.id,
    thread.id,
  )

  await wa.remove(ws, ACCT)

  assert.equal(await convo.get(ws, thread.id), undefined, 'the thread went, as it should')

  // The two halves the confirmation dialog promises.
  assert.ok(await customers.get(ws, who.id), 'the contact survives')
  const kept = await one(`SELECT conversation_id FROM lessons WHERE id = ?`, lesson)
  assert.ok(kept, 'the approved training survives')
  assert.equal(kept.conversation_id, null, 'orphaned rather than deleted with the thread')
})

test('a reply to an unlinked number fails in words, not inside Baileys', async () => {
  /*
   * `start()` reaches useMultiFileAuthState, which *creates* the directory it is handed — so
   * starting a removed account rebuilt its folder, left a credential-less zombie that list()
   * reported as a real number, and opened an unauthenticated socket whose sendMessage died
   * reading `.id` of nothing.
   */
  const DEAD = 'dead9999'
  await assert.rejects(() => wa.start(DEAD), /unlinked/)
  assert.equal(fs.existsSync(path.join(ROOT, DEAD)), false, 'and it did not recreate the folder')
})

test('the tidy keeps its hands off a channel it cannot read', async () => {
  /*
   * The safety this whole feature rests on. `ids()` answers every failure with an empty
   * list, so "no numbers are linked" and "the folder could not be read" are the same value —
   * and a tidy that trusted it would answer one bad readdir by deleting every WhatsApp
   * thread in the workspace. So the reachable list is allowed to say "I do not know", and
   * unknown means touch nothing.
   *
   * A *missing* root is different and genuinely empty: nothing has ever been linked.
   */
  const real = process.env.WA_AUTH_DIR

  // A path that cannot be read as a directory, which is not the same as one that is absent.
  const notADir = path.join(ROOT, 'definitely-a-file')
  fs.writeFileSync(notADir, 'not a directory')
  process.env.WA_AUTH_DIR = notADir
  const fresh = await import(`../src/server/channels/whatsapp.ts?tidy=${Date.now()}`)
  assert.equal(fresh.linkedIds(ws), null, 'an unreadable root is unknown, not empty')

  process.env.WA_AUTH_DIR = path.join(ROOT, 'never-created')
  const missing = await import(`../src/server/channels/whatsapp.ts?tidy=${Date.now()}b`)
  assert.deepEqual(missing.linkedIds(ws), [], 'a root that does not exist is genuinely empty')

  process.env.WA_AUTH_DIR = real
})

test('a folder without credentials is not a linked number', async () => {
  // What an unlink leaves behind, and what the old resurrect-on-send bug created. Its threads
  // are exactly the ones the tidy exists to remove, so it must not count as reachable.
  const SHELL = 'shell123'
  fs.mkdirSync(path.join(ROOT, SHELL), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, SHELL, 'meta.json'),
    JSON.stringify({ label: 'Shell', phone: null, workspace_id: ws, created_at: new Date().toISOString() }),
  )

  assert.ok(wa.list(ws).some((a) => a.id === SHELL), 'list() still reports it, which is why list() is not the test')
  assert.equal(wa.linkedIds(ws).includes(SHELL), false, 'but nothing could be sent through it')
})

test('imported threads are ordered by when they were last spoken in, not when they were filed', async () => {
  // Filing order deliberately the reverse of send order: WhatsApp hands the history over in
  // whatever order it likes, and every one of these rows is created within the same second.
  // If the inbox sorted on the import, the answer would be this array backwards.
  const MARCH = '6570000041@s.whatsapp.net'
  const JUNE = '6570000042@s.whatsapp.net'
  const AUGUST = '6570000043@s.whatsapp.net'
  const at = (iso) => Math.floor(new Date(iso).getTime() / 1000)

  await wa.importHistory(ACCOUNT, [
    { ...message(AUGUST, 'is the sale still on?', 'H41'), messageTimestamp: at('2026-08-01T09:00:00Z') },
    { ...message(MARCH, 'do you take bank transfer?', 'H42'), messageTimestamp: at('2026-03-01T09:00:00Z') },
    { ...message(JUNE, 'what are your hours?', 'H43'), messageTimestamp: at('2026-06-01T09:00:00Z') },
  ])

  const order = (await convo.inbox(ws)).rows
    .filter((t) => [MARCH, JUNE, AUGUST].some((jid) => t.channel_ref.endsWith(jid)))
    .map((t) => t.channel_ref.split(':').pop())
  assert.deepEqual(order, [AUGUST, JUNE, MARCH], 'newest conversation first')
})
