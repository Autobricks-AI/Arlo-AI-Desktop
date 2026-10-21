/**
 * The crawler's two jobs it must not get wrong: turning HTML into text an answer can be
 * built from, and refusing to be aimed at this server's own network.
 *
 * No database and no network — every address here is a literal, so nothing resolves.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { stripHtml, titleOf } from '../src/server/scrape.ts'
import { assertReachable, isPrivateAddress } from '../src/server/net.ts'

test('script and style content is not knowledge', () => {
  const html = `<p>Refund policy</p><script>var secret = "do not index me"</script><style>.a{color:red}</style>`
  const text = stripHtml(html)
  assert.match(text, /Refund policy/)
  assert.doesNotMatch(text, /do not index me/)
  assert.doesNotMatch(text, /color:red/)
})

test('block boundaries survive, because that is where the chunker prefers to cut', () => {
  const text = stripHtml('<h2>Refunds</h2><p>Five working days.</p><p>No exceptions.</p>')
  assert.match(text, /Refunds/)
  // A page flattened onto one line chunks at arbitrary points instead of at its headings.
  assert.ok(text.includes('\n'), `expected block breaks, got: ${JSON.stringify(text)}`)
  assert.match(text, /Five working days\./)
  assert.match(text, /No exceptions\./)
})

test('entities are decoded and whitespace is normalised', () => {
  assert.equal(stripHtml('<p>Ben &amp; Co&#39;s   terms&nbsp;apply</p>'), "Ben & Co's terms apply")
  assert.equal(stripHtml('<!-- hidden --><p>visible</p>'), 'visible')
})

test('hexadecimal entities are decoded too', () => {
  // What most template engines emit for an apostrophe. Left raw, every "Men's Health" is
  // indexed as "Men&#x27;s Health" — quoted back to customers that way, and split so the
  // page stops matching its own subject.
  assert.equal(stripHtml('<p>Men&#x27;s Health</p>'), "Men's Health")
  assert.equal(stripHtml('<p>caf&#xe9; &#x26; bar</p>'), 'café & bar')
  // Upper-case X and upper-case digits are both legal.
  assert.equal(stripHtml('<p>&#X27;&#x2014;</p>'), "'—")
})

test('the title is taken from the page, and falls back to the path', () => {
  assert.equal(titleOf('<html><head><title>Pricing &amp; plans</title></head>', '/x'), 'Pricing & plans')
  assert.equal(titleOf('<html><body>no title</body></html>', '/pricing'), '/pricing')
})

test('private, loopback and link-local addresses are recognised', () => {
  for (const ip of [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    // Where cloud instance credentials live. The single most valuable SSRF target there is.
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fe80::1',
    'fd00::1',
    '::ffff:10.0.0.1',
  ])
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`)

  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`)
})

test('a URL pointing inside our own network is refused', async () => {
  await assert.rejects(() => assertReachable('http://127.0.0.1:9102/admin'), /own network/)
  await assert.rejects(() => assertReachable('http://169.254.169.254/latest/meta-data/'), /own network/)
  await assert.rejects(() => assertReachable('http://[::1]/'), /own network/)
})

test('only http and https are fetchable', async () => {
  // file:// would read the server's disk; the others are just as much not a web page.
  for (const u of ['file:///etc/passwd', 'gopher://example.com/', 'data:text/html,<p>hi</p>'])
    await assert.rejects(() => assertReachable(u), /must start with http/)
  await assert.rejects(() => assertReachable('not a url at all'), /not a valid URL/)
})

test('a public address is allowed through', async () => {
  const url = await assertReachable('https://8.8.8.8/help')
  assert.equal(url.hostname, '8.8.8.8')
})

test('the allowlist is the escape hatch for a genuinely internal host', async () => {
  const before = process.env.SCRAPE_ALLOW_HOSTS
  process.env.SCRAPE_ALLOW_HOSTS = 'intranet.example.com, 10.0.0.5'
  try {
    // Named by an operator on the server, so it is a decision rather than a URL someone typed.
    await assertReachable('http://10.0.0.5/handbook')
    // Everything else on the same private network is still refused.
    await assert.rejects(() => assertReachable('http://10.0.0.6/handbook'), /own network/)
  } finally {
    if (before === undefined) delete process.env.SCRAPE_ALLOW_HOSTS
    else process.env.SCRAPE_ALLOW_HOSTS = before
  }
})
