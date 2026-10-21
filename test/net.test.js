/**
 * The two things `boundedFetch` gained for media, both of which are only observable from
 * outside the function.
 *
 * **A credential does not follow a redirect off its own origin.** `fetch` carries custom
 * headers across a cross-origin redirect, so a URL that arrived in a webhook body and
 * answers `302 Location: https://somewhere-else/` is handed this instance's access token by
 * whatever host it names. The assertion is on the headers the *second hop* received, not on
 * the response — a response says nothing about what was sent to get it.
 *
 * **The bytes come back as bytes.** The function used to end in `new TextDecoder().decode`,
 * which mangles every image, audio file and PDF it touches, and a caller had no way to ask
 * for the original.
 *
 * No database and no network: every hostname here is in SCRAPE_ALLOW_HOSTS, so nothing
 * resolves, and `fetch` is stubbed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

process.env.SCRAPE_ALLOW_HOSTS = 'a.test, b.test'
const { boundedFetch } = await import('../src/server/net.ts')

const realFetch = globalThis.fetch
let hops = []
/** What each hop answers, in order. */
let script = []

globalThis.fetch = async (url, init) => {
  hops.push({ url: String(url), headers: new Headers(init?.headers) })
  return script.shift() ?? new Response('done')
}
test.after(() => {
  globalThis.fetch = realFetch
})
test.beforeEach(() => {
  hops = []
  script = []
})

const moved = (to) => new Response(null, { status: 302, headers: { location: to } })

test('a credential header is dropped when a hop changes origin', async () => {
  script = [moved('https://b.test/photo.jpg'), new Response('bytes')]

  await boundedFetch('https://a.test/media/1', {
    headers: { authorization: 'Bearer a-live-access-token', 'x-api-key': 'the-instance-key', cookie: 'session=abc', accept: 'image/*' },
  })

  assert.equal(hops.length, 2)
  assert.equal(hops[0].headers.get('authorization'), 'Bearer a-live-access-token')
  // The host named by the Location header must never see any of the three.
  assert.equal(hops[1].headers.get('authorization'), null)
  assert.equal(hops[1].headers.get('x-api-key'), null)
  assert.equal(hops[1].headers.get('cookie'), null)
  // Everything that merely describes the request survives, or the second hop is a
  // different request rather than the same one somewhere else.
  assert.equal(hops[1].headers.get('accept'), 'image/*')
})

test('a redirect within the same origin keeps them, because nothing new can read them', async () => {
  script = [moved('/photo-2.jpg'), new Response('bytes')]

  await boundedFetch('https://a.test/media/1', { headers: { authorization: 'Bearer a-live-access-token' } })

  assert.equal(hops[1].url, 'https://a.test/photo-2.jpg')
  assert.equal(hops[1].headers.get('authorization'), 'Bearer a-live-access-token')
})

test('once dropped, a header stays dropped for every hop after it', async () => {
  script = [moved('https://b.test/x'), moved('https://a.test/y'), new Response('bytes')]

  await boundedFetch('https://a.test/media/1', { headers: { authorization: 'Bearer a-live-access-token' } })

  assert.equal(hops.length, 3)
  // Back on the first origin, but through a host that could have chosen where to send us.
  assert.equal(hops[2].headers.get('authorization'), null)
})

test('the bytes come back as bytes, and the text is computed only if asked for', async () => {
  // A PNG header: NUL bytes and a 0x89 that no decoder can round-trip through UTF-8.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  script = [new Response(new Uint8Array(png))]

  const { bytes, body } = await boundedFetch('https://a.test/photo.jpg')

  assert.ok(Buffer.isBuffer(bytes))
  assert.deepEqual([...bytes], [...png], 'an image must survive byte for byte')
  // What every caller had before, and what an image must not be stored as.
  assert.notEqual(Buffer.from(body, 'utf8').length, png.length)
})

test('text callers are unchanged, including a response with no body at all', async () => {
  script = [new Response('Refunds take five working days.')]
  const page = await boundedFetch('https://a.test/policy')
  assert.equal(page.body, 'Refunds take five working days.')
  assert.equal(page.res.status, 200)

  script = [new Response(null, { status: 204 })]
  const empty = await boundedFetch('https://a.test/nothing')
  assert.equal(empty.body, '')
  assert.equal(empty.bytes.length, 0)
})

/*
 * The SSRF guard, and the spelling that got past it.
 *
 * `docs/SECURITY-AUDIT.md` recorded C1 as fixed. It was fixed for `::ffff:169.254.169.254`
 * and not for `::ffff:a9fe:a9fe`, which is the same address written the other legal way:
 * `isIP()` answers 6, so the IPv4 branch never ran, and no IPv6 prefix matches a string
 * beginning `::ffff:`, so the cloud metadata endpoint came back judged public. A tenant could
 * put that in a crawl URL and read the instance's cloud credentials out of its own knowledge
 * base afterwards.
 *
 * Both spellings are asserted, and so are the public addresses — a guard that blocks
 * everything is not a fix.
 */
test('a private address is private in either IPv4-mapped spelling', async () => {
  const { isPrivateAddress } = await import('../src/server/net.ts')

  for (const [ip, what] of [
    ['169.254.169.254', 'cloud metadata, plain'],
    ['::ffff:169.254.169.254', 'cloud metadata, mapped and dotted'],
    ['::ffff:a9fe:a9fe', 'cloud metadata, mapped and hex'],
    ['::ffff:7f00:1', 'loopback, hex'],
    ['::ffff:0a00:0001', 'RFC1918, hex'],
    ['::ffff:ac10:1', '172.16/12, hex'],
    ['::ffff:c0a8:1', '192.168/16, hex'],
    ['::ffff:6440:1', 'the tailnet, hex'],
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} is ${what} and must be refused`)
  }

  for (const [ip, what] of [
    ['8.8.8.8', 'an ordinary public address'],
    ['::ffff:08080808', 'the same one, mapped — still public'],
    ['2606:4700::1', 'public IPv6'],
  ]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} is ${what} and must still be reachable`)
  }
})
