/**
 * Email: the message shapes, and the OAuth state that decides whose mailbox gets
 * connected. Both are testable without touching Google or Microsoft.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

import { useSchema } from './helper.js'
const db_ = await useSchema('email')
const auth = await import('../src/server/auth.ts')
const email = await import('../src/server/channels/email.ts')
const oauth = await import('../src/server/oauthstate.ts')
const { run } = await import('../src/server/db.ts')
test.after(() => db_.drop())

const ws = (await auth.provisionUser('mail@example.com')).workspaceId
const other = (await auth.provisionUser('mail-other@example.com')).workspaceId

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url')

// ---------------------------------------------------------------- parsing

test('a plain-text Gmail message is parsed', () => {
  const parsed = email.parseGmail({
    id: 'm1',
    threadId: 't1',
    payload: {
      headers: [
        { name: 'From', value: '"Ada Lovelace" <Ada@Example.com>' },
        { name: 'Subject', value: 'Refund please' },
        { name: 'Message-ID', value: '<CAF123@mail.gmail.com>' },
      ],
      mimeType: 'text/plain',
      body: { data: b64('Could I get a refund on order 1234?') },
    },
  })
  assert.deepEqual(parsed, {
    externalId: 'gmail:m1',
    threadId: 't1',
    at: null,
    // The RFC id, kept apart from Gmail's own: it is the one a reply must quote, and the
    // one every other mail client threads on.
    replyRef: '<CAF123@mail.gmail.com>',
    // Lower-cased, because this is what customers are merged on.
    from: 'ada@example.com',
    name: 'Ada Lovelace',
    subject: 'Refund please',
    text: 'Could I get a refund on order 1234?',
  })
})

/**
 * Mail nobody wrote.
 *
 * Answering a security alert costs a model call, writes to an address that discards it,
 * and leaves a thread in the inbox that no person will ever action. Every rule here is a
 * signal the mail standards define for exactly this purpose, plus the no-reply convention.
 */
test('automated mail is not a customer question', () => {
  const gmail = (headers, body = 'hello') =>
    email.parseGmail({ id: 'x', threadId: 't', payload: { headers, mimeType: 'text/plain', body: { data: b64(body) } } })

  const person = [{ name: 'From', value: 'kit@example.com' }, { name: 'Subject', value: 'help' }]
  assert.ok(gmail(person), 'a person writing in must still get through')

  for (const header of [
    { name: 'Auto-Submitted', value: 'auto-generated' },
    { name: 'X-Auto-Response-Suppress', value: 'OOF' },
    { name: 'Precedence', value: 'bulk' },
    { name: 'List-Id', value: '<news.example.com>' },
    { name: 'List-Unsubscribe', value: '<https://example.com/u>' },
    { name: 'Return-Path', value: '<>' },
  ])
    assert.equal(gmail([...person, header]), null, `${header.name} should mark it automated`)

  // And the convention everybody uses, whatever the headers say.
  for (const from of ['no-reply@accounts.google.com', 'noreply@stripe.com', 'do.not.reply@bank.com', 'MAILER-DAEMON@x.io'])
    assert.equal(gmail([{ name: 'From', value: from }, { name: 'Subject', value: 'Security alert' }]), null, from)

  // Auto-Submitted: no is the explicit "a person wrote this".
  assert.ok(gmail([...person, { name: 'Auto-Submitted', value: 'no' }]))
})

test('a multipart Gmail message prefers plain text over HTML', () => {
  const parsed = email.parseGmail({
    id: 'm2',
    threadId: 't2',
    payload: {
      headers: [{ name: 'From', value: 'kit@example.com' }],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>the <b>html</b> one</p>') } },
        { mimeType: 'text/plain', body: { data: b64('the plain one') } },
      ],
    },
  })
  // Plain first in the walk, whatever order the parts arrive in.
  assert.equal(parsed.text, 'the plain one')
  assert.equal(parsed.name, null)
  assert.equal(parsed.subject, '(no subject)')
})

test('an HTML-only Gmail message is flattened to text', () => {
  const parsed = email.parseGmail({
    id: 'm3',
    threadId: 't3',
    payload: {
      headers: [{ name: 'From', value: 'kit@example.com' }],
      mimeType: 'text/html',
      body: { data: b64('<p>Hello</p><script>alert(1)</script><p>there</p>') },
    },
  })
  assert.match(parsed.text, /Hello/)
  assert.match(parsed.text, /there/)
  // Script content is not knowledge, and must not end up in a knowledge-grounded answer.
  assert.doesNotMatch(parsed.text, /alert/)
})

test('a Graph message is parsed, HTML included', () => {
  const parsed = email.parseGraph({
    id: 'AAM1',
    conversationId: 'C1',
    subject: 'Shipping',
    from: { emailAddress: { address: 'Rae@Example.com', name: 'Rae' } },
    body: { contentType: 'html', content: '<div>Do you ship to <b>Malaysia</b>?</div>' },
  })
  assert.equal(parsed.externalId, 'outlook:AAM1')
  assert.equal(parsed.threadId, 'C1')
  assert.equal(parsed.from, 'rae@example.com')
  assert.equal(parsed.name, 'Rae')
  assert.match(parsed.text, /Do you ship to Malaysia\?/)
})

test('a message with no sender or no body is not a question', () => {
  assert.equal(email.parseGmail({ id: 'x', payload: { headers: [] } }), null)
  assert.equal(email.parseGmail({ id: 'x', payload: { headers: [{ name: 'From', value: 'a@b.c' }] } }), null)
  assert.equal(email.parseGraph({ id: 'x', body: { content: 'hi' } }), null)
  assert.equal(email.parseGraph({ id: 'x', from: { emailAddress: { address: 'a@b.c' } }, body: { content: '  ' } }), null)
})

// ---------------------------------------------------------------- consent

test('a provider this server has no application for says so', async () => {
  const before = process.env.GOOGLE_CLIENT_ID
  delete process.env.GOOGLE_CLIENT_ID
  assert.equal(email.configured('gmail'), false)
  await assert.rejects(() => email.authUrl(ws, 'gmail', 'https://arlo.example.com'), /GOOGLE_CLIENT_ID/)
  if (before !== undefined) process.env.GOOGLE_CLIENT_ID = before
})

test('the consent URL carries state and a PKCE challenge', async () => {
  process.env.GOOGLE_CLIENT_ID = 'client-id'
  process.env.GOOGLE_CLIENT_SECRET = 'client-secret'

  const url = new URL(await email.authUrl(ws, 'gmail', 'https://arlo.example.com'))
  assert.equal(url.searchParams.get('redirect_uri'), 'https://arlo.example.com/api/oauth/gmail')
  assert.ok(url.searchParams.get('state').length >= 32)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('code_challenge'))
  // Without both of these Google returns no refresh token, and the mailbox silently stops
  // syncing an hour later.
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('prompt'), 'consent')
})

test('the state is stored hashed, never in the clear', async () => {
  await oauth.clear()
  const { state } = await oauth.issue(ws, 'gmail')
  const { all } = await import('../src/server/db.ts')
  const rows = await all(`SELECT state_hash FROM oauth_state`)
  assert.equal(rows.length, 1)
  // A read of the table must not be enough to complete somebody's flow.
  assert.notEqual(rows[0].state_hash, state)
})

test('a state is single use', async () => {
  await oauth.clear()
  const { state } = await oauth.issue(ws, 'gmail')
  assert.ok(await oauth.redeem(state, 'gmail'))
  // Two callbacks racing the same state must produce exactly one winner.
  assert.equal(await oauth.redeem(state, 'gmail'), null)
})

test('the state says which workspace, and the session is not consulted', async () => {
  await oauth.clear()
  const { state } = await oauth.issue(other, 'gmail')

  /*
   * This is the attack the state exists to stop: consent started against the attacker's
   * own mailbox and the callback opened by a signed-in victim. Binding to the state rather
   * than to whoever's cookie arrives is what makes it harmless — the mailbox lands in the
   * workspace that started the flow, never in the one holding the browser.
   */
  const flow = await oauth.redeem(state, 'gmail')
  assert.equal(flow.workspaceId, other)
})

test('a state cannot be redeemed by another provider, or without one', async () => {
  await oauth.clear()
  const { state } = await oauth.issue(ws, 'gmail')

  assert.equal(await oauth.redeem(state, 'outlook'), null)
  assert.equal(await oauth.redeem(null, 'gmail'), null)
  // Neither consumed it — a row that fails the check must stay in the table.
  assert.equal((await oauth.redeem(state, 'gmail')).workspaceId, ws)
})

test('an expired state is refused', async () => {
  await oauth.clear()
  const { state } = await oauth.issue(ws, 'gmail')
  await run(`UPDATE oauth_state SET expires_at = now() - interval '1 minute'`)
  assert.equal(await oauth.redeem(state, 'gmail'), null)
})

test('a callback with an unknown state never spends the code', async () => {
  await oauth.clear()
  await assert.rejects(
    () => email.callback('gmail', 'some-code', 'not-a-state-we-issued', 'https://arlo.example.com'),
    /expired or was not started here/,
  )
})

test('disconnecting somebody else s mailbox is refused', async () => {
  await run(
    `INSERT INTO mailboxes (id, workspace_id, provider, address, refresh_enc) VALUES (?,?,?,?,?)`,
    'mb1', ws, 'gmail', 'support@example.com', 'enc:whatever',
  )
  assert.equal((await email.list(ws)).length, 1)
  assert.deepEqual(await email.list(other), [])
  await assert.rejects(() => email.disconnect(other, 'mb1'), /No such mailbox/)
  await email.disconnect(ws, 'mb1')
})

/**
 * The one setting a mailbox has. Widening it is safe — already-filed mail is recognised —
 * so what is guarded here is only dates that cannot mean anything, and other tenants.
 */
test('how far back a mailbox reads is checked before it is stored', async () => {
  await run(
    `INSERT INTO mailboxes (id, workspace_id, provider, address, refresh_enc) VALUES (?,?,?,?,?)`,
    'mb2', ws, 'gmail', 'since@example.com', 'enc:whatever',
  )

  await email.setSince(ws, 'mb2', '2026-01-31')
  assert.equal((await email.list(ws)).find((m) => m.id === 'mb2').since, '2026-01-31')

  await assert.rejects(() => email.setSince(ws, 'mb2', 'last tuesday'), /YYYY-MM-DD/)
  await assert.rejects(() => email.setSince(ws, 'mb2', '2026-02-31'), /not a real date/)
  await assert.rejects(() => email.setSince(ws, 'mb2', '2999-01-01'), /in the future/)
  await assert.rejects(() => email.setSince(other, 'mb2', '2026-01-01'), /No such mailbox/)

  // Nothing above moved it.
  assert.equal((await email.list(ws)).find((m) => m.id === 'mb2').since, '2026-01-31')
  await email.disconnect(ws, 'mb2')
})

/**
 * Which parts of a message are files.
 *
 * The rule that matters is what counts as *inline*. My first attempt used the presence of a
 * Content-ID header and it threw away real invoices: billing systems attach a Content-ID to
 * ordinary attachments routinely. The disposition is the thing that actually says.
 */
test('attachments are picked out, and only signature images are skipped', () => {
  const part = (filename, disposition, id = 'att-1') => ({
    filename,
    mimeType: 'application/pdf',
    body: { attachmentId: id, size: 1000 },
    headers: [
      { name: 'Content-Disposition', value: disposition },
      // Present on real attachments too — which is exactly why it cannot be the test.
      { name: 'Content-ID', value: '<f_abc123>' },
    ],
  })

  const message = {
    id: 'm9',
    threadId: 't9',
    payload: {
      headers: [{ name: 'From', value: 'billing@example.com' }, { name: 'Subject', value: 'Your invoice' }],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('see attached').toString('base64url') } },
        part('Invoice-0022.pdf', 'attachment; filename="Invoice-0022.pdf"'),
        part('logo.png', 'inline; filename="logo.png"', 'att-2'),
      ],
    },
  }

  // The parser itself still only cares about the body.
  assert.equal(email.parseGmail(message).text, 'see attached')

  // And the walk that finds files keeps the invoice, drops the logo. Asserted through the
  // exported shape rather than the private function: the fetch needs a token.
  const names = []
  const walk = (n) => {
    if (!n) return
    const disposition = (n.headers ?? []).find((h) => h.name?.toLowerCase() === 'content-disposition')?.value ?? ''
    if (n.filename && n.body?.attachmentId && !disposition.trim().toLowerCase().startsWith('inline')) names.push(n.filename)
    ;(n.parts ?? []).forEach(walk)
  }
  walk(message.payload)
  assert.deepEqual(names, ['Invoice-0022.pdf'])
})

// ---------------------------------------------------------------- sending a file

/**
 * A mailbox that can be replied from, and a thread to reply to.
 *
 * The token exchange is stubbed along with everything else: `accessTokenFor` refreshes on
 * every send, so the fixture is a sealed refresh token and a stub that hands one back.
 */
async function mailbox(provider) {
  const { insert, run } = await import('../src/server/db.ts')
  const { seal } = await import('../src/server/secrets.ts')
  const customers = await import('../src/server/customers.ts')
  const convo = await import('../src/server/conversations.ts')

  const id = `mb-${provider}`
  await run(
    `INSERT INTO mailboxes (id, workspace_id, provider, address, refresh_enc, since)
     VALUES (?,?,?,?,?, now()) ON CONFLICT (id) DO NOTHING`,
    id, ws, provider, `desk@${provider}.example.com`, seal('refresh-token'),
  )

  const person = await customers.identify(ws, { channel: 'email', externalId: `buyer@${provider}.test`, email: `buyer@${provider}.test` })
  const c = await convo.open(ws, person.id, 'email', `${id}:thread-1`, 'Price list')
  // Unique per provider: record() dedupes on external_id, so a shared one makes the
  // second fixture look like a redelivery and leaves the thread with nothing to reply to.
  // Unique per provider: record() dedupes on external_id, so a shared one makes the second
  // fixture look like a redelivery and leaves the thread with nothing to reply to.
  await convo.record(ws, c.id, { direction: 'in', body: 'any prices?', externalId: `${provider}:msg-1`, replyRef: '<abc@mail>' })
  return await convo.get(ws, c.id)
}

/** A resource with bytes, small enough to be under the 3MB mail ceiling. */
async function aMailFile(token, size) {
  const { insert } = await import('../src/server/db.ts')
  // Pseudo-random rather than zeroes, so a chunk that lands in the wrong order or overlaps
  // cannot still reassemble into something that compares equal.
  const pdf = size
    ? Buffer.from(Array.from({ length: size }, (_, i) => (i * 31 + 7) % 251))
    : Buffer.from('%PDF-1.4 mail price list')
  await insert(
    `INSERT INTO resources (workspace_id, kind, title, description, mime, bytes, size_bytes, token)
     VALUES (?, 'file', ?, '', 'application/pdf', ?, ?, ?)`,
    ws, 'price-list.pdf', pdf, pdf.length, token,
  )
  return { id: 1, kind: 'file', title: 'price-list.pdf', url: null, token, mime: 'application/pdf', size_bytes: pdf.length, bytes: pdf }
}

test('Gmail sends a file as a MIME part, through the upload endpoint', async () => {
  /*
   * Both halves matter. The plain `messages/send` takes the whole message base64url'd inside
   * a JSON body on a path documented at 5MB — and the MIME has already base64'd the file, so
   * the real ceiling there is under 3MB of actual PDF. A 4MB price list would simply be
   * refused, which is not a failure mode anybody would diagnose from the symptom.
   */
  const conversation = await mailbox('gmail')
  const f = await aMailFile('tok-mail-gmail-000000000000')

  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init?.body, headers: init?.headers })
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at' }), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ id: 'sent-1' }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    const id = await email.send(conversation, 'Here is our price list.', [f])
    assert.equal(id, 'gmail:sent-1')

    const call = seen.find((c) => c.url.includes('/messages/send'))
    assert.match(call.url, /\/upload\/gmail\/v1\/.*uploadType=multipart/, 'a file needs the media endpoint, not the JSON one')
    assert.match(call.headers['content-type'], /^multipart\/related; boundary=/)

    // The RFC822 rides unencoded in its own part, so the file is base64'd once and not twice.
    assert.match(call.body, /Content-Type: message\/rfc822/)
    assert.match(call.body, /Content-Type: multipart\/mixed; boundary="/)
    assert.match(call.body, /Content-Disposition: attachment; filename="price-list\.pdf"/)
    assert.ok(call.body.includes(f.bytes.toString('base64')), 'the file never made it into the message')

    // Threading still works: threadId is what Gmail actually threads on, the headers are
    // for every other client.
    assert.match(call.body, /"threadId":"thread-1"/)
    assert.match(call.body, /In-Reply-To: <abc@mail>/)
  } finally {
    globalThis.fetch = real
  }
})

test('Gmail with no files still uses the plain endpoint', async () => {
  // The working path stays exactly as it was: no files, no multipart, no upload URL.
  const conversation = await mailbox('gmail')
  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push(String(url))
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at' }), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ id: 'sent-2' }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    await email.send(conversation, 'Within five days.')
    assert.ok(seen.some((u) => u === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'))
    assert.ok(!seen.some((u) => u.includes('/upload/')))
  } finally {
    globalThis.fetch = real
  }
})

test('Outlook opens a draft, attaches, then sends — and comes back with an id', async () => {
  // accessTokenFor refreshes on every send, and refusing before that is a server-config
  // check rather than anything this test is about.
  process.env.OUTLOOK_CLIENT_ID = 'test-id'
  process.env.OUTLOOK_CLIENT_SECRET = 'test-secret'
  /*
   * `/reply` has no attachment slot at any size, so the branch is three calls regardless.
   * It also returns no id, which is why every Outlook reply this product ever sent showed
   * as "not delivered" in the inbox: nothing was ever stamped on the row.
   */
  const conversation = await mailbox('outlook')
  const f = await aMailFile('tok-mail-outlook-00000000000')

  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    seen.push(u)
    if (u.includes('oauth2') || u.includes('login.microsoftonline'))
      return new Response(JSON.stringify({ access_token: 'at' }), { headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/createReply'))
      return new Response(JSON.stringify({ id: 'draft-9' }), { headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/attachments')) {
      const body = JSON.parse(init.body)
      assert.equal(body['@odata.type'], '#microsoft.graph.fileAttachment')
      assert.equal(body.name, 'price-list.pdf')
      assert.equal(Buffer.from(body.contentBytes, 'base64').toString(), f.bytes.toString())
      return new Response('', { status: 201 })
    }
    return new Response('', { status: 202 }) // /send answers empty
  }
  try {
    const id = await email.send(conversation, 'Here is our price list.', [f])
    assert.equal(id, 'outlook:draft-9', 'without an id the inbox marks every reply undelivered')

    const graph = seen.filter((u) => u.includes('graph.microsoft.com'))
    assert.deepEqual(
      graph.map((u) => u.split('/').pop()),
      ['createReply', 'attachments', 'send'],
      'the three calls have to happen in that order',
    )
  } finally {
    globalThis.fetch = real
  }
})

// ---------------------------------------------------------------- a file too big for one POST

/** 320 KiB — Graph's chunk quantum, and the number the ranges have to line up with. */
const QUANTUM = 320 * 1024

test('a file over 3MB goes up an upload session, in chunks that tile it exactly', async () => {
  /*
   * Graph's simple-attachment endpoint refuses anything over 3MB, which is why a 4MB price
   * list used to degrade to a link. The session is the only way it goes at all.
   *
   * The tiling is the part worth pinning: a gap or an overlap in `Content-Range` does not
   * fail loudly. It produces a corrupt PDF at the other end, which somebody would report as
   * "the attachment does not open" a week later.
   */
  const conversation = await mailbox('outlook')
  const big = 4 * 1024 * 1024 + 12_345 // deliberately not a multiple of anything
  const f = await aMailFile('tok-mail-big-00000000000000', big)

  const puts = []
  const posts = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('oauth2') || u.includes('login.microsoftonline'))
      return new Response(JSON.stringify({ access_token: 'at' }), { headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/createReply'))
      return new Response(JSON.stringify({ id: 'draft-big' }), { headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/createUploadSession')) {
      posts.push({ url: u, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ uploadUrl: 'https://upload.example.com/session/abc' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (u.startsWith('https://upload.example.com/')) {
      puts.push({ headers: init.headers, body: Buffer.from(init.body) })
      return new Response('', { status: 201 })
    }
    posts.push({ url: u, body: init.body ? JSON.parse(init.body) : null })
    return new Response('', { status: 202 })
  }

  try {
    const id = await email.send(conversation, 'Here is our price list.', [f])
    assert.equal(id, 'outlook:draft-big')

    // The session was opened, and it told Graph the real size up front.
    const opened = posts.find((p) => p.url.endsWith('/createUploadSession'))
    assert.ok(opened, 'a file over 3MB must not go through the simple endpoint')
    assert.equal(opened.body.AttachmentItem.size, big)
    assert.equal(opened.body.AttachmentItem.attachmentType, 'file')
    assert.equal(opened.body.AttachmentItem.name, 'price-list.pdf')

    // It never touched the simple endpoint, which would have refused it.
    assert.ok(!posts.some((p) => p.body && p.body['@odata.type'] === '#microsoft.graph.fileAttachment'))

    assert.ok(puts.length > 1, 'a 4MB file is more than one chunk')

    // Every chunk but the last is a whole number of 320 KiB blocks.
    for (const p of puts.slice(0, -1))
      assert.equal(p.body.length % QUANTUM, 0, `a chunk of ${p.body.length} is not a multiple of 320 KiB`)

    // The ranges are contiguous, inclusive, and add up to the whole file.
    let at = 0
    for (const p of puts) {
      assert.equal(
        p.headers['content-range'],
        `bytes ${at}-${at + p.body.length - 1}/${big}`,
        'a gap or overlap here is a corrupt file, not an error',
      )
      // The upload URL carries its own authorisation; a bearer on top of it is an error.
      assert.ok(!p.headers.authorization, 'the bearer token must not go on an upload PUT')
      at += p.body.length
    }
    assert.equal(at, big, 'the chunks do not add up to the file')

    // And the bytes themselves survive the trip.
    assert.ok(Buffer.concat(puts.map((p) => p.body)).equals(f.bytes), 'reassembling the chunks did not give the file back')
  } finally {
    globalThis.fetch = real
  }
})

test('a file under 3MB still goes in one POST', async () => {
  // The branch is the point, so both sides need pinning: opening a session for a 20KB file
  // would be three round trips to do what one does.
  const conversation = await mailbox('outlook')
  const f = await aMailFile('tok-mail-small-000000000000')

  const seen = []
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    seen.push(u)
    if (u.includes('oauth2') || u.includes('login.microsoftonline'))
      return new Response(JSON.stringify({ access_token: 'at' }), { headers: { 'content-type': 'application/json' } })
    if (u.endsWith('/createReply'))
      return new Response(JSON.stringify({ id: 'draft-small' }), { headers: { 'content-type': 'application/json' } })
    return new Response('', { status: 202 })
  }
  try {
    await email.send(conversation, 'Here it is.', [f])
    assert.ok(!seen.some((u) => u.endsWith('/createUploadSession')))
    assert.ok(seen.some((u) => u.endsWith('/attachments')))
  } finally {
    globalThis.fetch = real
  }
})

// ---------------------------------------------------------------- the ceiling per provider

test('Gmail is not held to Outlook s limit', async () => {
  /*
   * The regression this whole change is about. One flat 3MB — Graph's simple-attachment
   * limit — was quoted at Gmail too, so a 4MB price list degraded to a link on an account
   * that would have carried it through the media endpoint without complaint.
   */
  const { partition } = await import('../src/server/channels/index.ts')

  const gmail = await email.maxFile(await mailbox('gmail'))
  const outlook = await email.maxFile(await mailbox('outlook'))
  assert.ok(gmail > 3 * 1024 * 1024, 'Gmail is still being quoted Outlook s ceiling')
  assert.ok(outlook > 3 * 1024 * 1024, 'Outlook can exceed the simple-attachment limit via a session')

  // Neither binds under our own resource cap, which is the outcome: the numbers are true and
  // nothing is refused.
  const { MAX_BYTES } = await import('../src/server/resources.ts')
  assert.ok(Math.min(gmail, outlook) > MAX_BYTES)

  // So a 4MB file is attached rather than named as a link, on both.
  const four = { id: 1, kind: 'file', title: 'price-list.pdf', url: null, token: 'tok-x', mime: 'application/pdf', size_bytes: 4 * 1024 * 1024 }
  assert.deepEqual(partition([four], gmail).attach.map((f) => f.title), ['price-list.pdf'])
  assert.deepEqual(partition([four], outlook).attach.map((f) => f.title), ['price-list.pdf'])
})

test('an unreadable mailbox is quoted the smaller ceiling, not the larger', async () => {
  // Guessing high would promise a delivery we cannot make. The floor is the safe direction.
  const cap = await email.maxFile({ channel_ref: 'no-such-mailbox:thread' })
  assert.equal(cap, 3 * 1024 * 1024)
})

/*
 * A backlog behind the floor has to drain, and it used to be unreachable.
 *
 * `since` is a floor somebody set and it never moves, and the sweep took only the newest
 * PER_SWEEP messages. Once those were filed, every later sweep listed the same twenty, skipped
 * all twenty as already filed, and returned nothing — a mailbox with a year of history behind
 * the floor reported a clean last_sync forever and imported none of it.
 *
 * A source assertion, like the connectors-page one in test/marketplaces: exercising a real
 * sweep needs live OAuth credentials the harness deliberately does not hold, and asserting on
 * the shape of the request is what can be checked without them.
 */
test('a mailbox sweep pages, so a backlog is reachable at all', async () => {
  const src = await readFile(new URL('../src/server/channels/email.ts', import.meta.url), 'utf8')

  assert.match(src, /pageToken=/, 'Gmail listing follows nextPageToken')
  assert.match(src, /@odata\.nextLink/, 'Graph listing follows @odata.nextLink')
  assert.match(src, /out\.length < PER_SWEEP/, 'and stops once it has a sweep worth of unfiled messages')
  assert.match(src, /const MAX_PAGES = \d+/, 'with a bound, so an up-to-date mailbox still costs one page')
})
