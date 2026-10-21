/**
 * Crawl jobs: the parent row, the progress it reports, and what a re-crawl is allowed to
 * delete.
 *
 * The web is stubbed at `fetch`, so the crawler, the scoping and the job bookkeeping are
 * all the real code — only the pages are invented.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('sites')
// A public address: net.ts refuses anything resolving inside our own network, and that
// check is not what these tests are about.
process.env.SCRAPE_ALLOW_HOSTS = 'example.test'
const auth = await import('../src/server/auth.ts')
const sites = await import('../src/server/sites.ts')
const kb = await import('../src/server/kb.ts')
const { all, one, run, withWorkspace } = await import('../src/server/db.ts')

const bases = await import('../src/server/bases.ts')
const ws = (await auth.provisionUser('sites@example.com')).workspaceId
const base = (await bases.first(ws)).id
const other = (await auth.provisionUser('sites-other@example.com')).workspaceId
const otherBase = (await bases.first(other)).id

// ---------------------------------------------------------------- a stubbed website

const ROOT = 'http://example.test/'
/** path -> {links, body}. Reassigned per test to change what the site looks like. */
let SITE = {}
let fetched = []

const realFetch = globalThis.fetch
globalThis.fetch = async (url) => {
  const href = String(url)
  fetched.push(href)
  if (href.endsWith('/robots.txt')) return new Response('', { status: 404 })

  const page = SITE[href]
  if (!page) return new Response('gone', { status: 404 })
  const links = (page.links ?? []).map((l) => `<a href="${l}">x</a>`).join('')
  return new Response(`<html><head><title>${page.title}</title></head><body><p>${page.body}</p>${links}</body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
}
test.after(() => {
  globalThis.fetch = realFetch
  return db_.drop()
})

/** queue() hands off to a background job; the tests need to know when it has finished. */
const settle = async (siteId) => {
  for (let i = 0; i < 200; i++) {
    const s = await withWorkspace({ workspaceId: ws }, () => sites.get(ws, siteId))
    if (s.status === 'done' || s.status === 'failed') return s
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('the crawl never finished')
}

const pagesOf = (siteId) =>
  all(`SELECT uri, title FROM documents WHERE site_id = ? ORDER BY uri`, siteId)

test.beforeEach(() => {
  fetched = []
})

// ---------------------------------------------------------------- queueing

test('the page cap is clamped, never trusted', () => {
  assert.equal(sites.clampPages(25), 25)
  assert.equal(sites.clampPages('7'), 7)
  // A form is not a promise. Nonsense falls back to the default, and a huge number is
  // capped rather than letting one submission crawl for an hour.
  assert.equal(sites.clampPages(0), 25)
  assert.equal(sites.clampPages(-3), 25)
  assert.equal(sites.clampPages('lots'), 25)
  assert.equal(sites.clampPages(99999), 250)
})

test('a bad address is refused up front, not filed as a job that fails later', async () => {
  await assert.rejects(() => sites.queue(ws, base, 'not a url'), /not a valid URL/)
  // Aiming the crawler at our own network is the attack net.ts exists to stop.
  await assert.rejects(() => sites.queue(ws, base, 'http://169.254.169.254/'), /own network/)
  assert.deepEqual(await sites.list(ws), [])
})

test('queueing returns immediately, before anything is crawled', async () => {
  SITE = { [ROOT]: { title: 'Home', body: 'Refunds take five working days.', links: [] } }
  const site = await sites.queue(ws, base, ROOT, { follow: false })

  // The row exists and says so. This is what the browser renders a progress bar from.
  assert.ok(site.id)
  assert.equal(site.root_url, ROOT)
  assert.match(site.status, /queued|running/)
  assert.equal(site.pages_done, 0)

  const done = await settle(site.id)
  assert.equal(done.status, 'done')
  assert.equal(done.pages_done, 1)
  assert.ok(done.finished_at)
})

test('a single page still gets a parent, so the list has one shape', async () => {
  const [site] = await sites.list(ws)
  assert.equal(site.follow, false)
  assert.equal(site.max_pages, 1)
  assert.equal(site.pages, 1)
  assert.ok(site.passages > 0)
})

test('the same address cannot be crawled twice at once', async () => {
  SITE = { [ROOT]: { title: 'Home', body: 'Slow page.', links: [] } }
  const site = await sites.queue(ws, base, ROOT, { follow: false })
  // Two impatient clicks, or two people. The second is refused rather than doubling
  // every page and racing itself for the same rows.
  await assert.rejects(() => sites.queue(ws, base, ROOT, { follow: false }), /already being crawled/)
  await settle(site.id)
})

// ---------------------------------------------------------------- crawling

test('following links fills one site with many pages', async () => {
  SITE = {
    [ROOT]: { title: 'Home', body: 'Welcome to the shop.', links: ['/help', '/pricing'] },
    'http://example.test/help': { title: 'Help', body: 'Refunds take five working days.', links: ['/pricing'] },
    'http://example.test/pricing': { title: 'Pricing', body: 'The starter plan is ten dollars.', links: [] },
  }
  const site = await sites.queue(ws, base, ROOT, { follow: true, maxPages: 10 })
  const done = await settle(site.id)

  assert.equal(done.status, 'done')
  assert.equal(done.pages_done, 3)
  // It ran out of site rather than out of budget, so nothing was cut short.
  assert.equal(done.truncated, false)

  const pages = await pagesOf(site.id)
  assert.deepEqual(pages.map((p) => p.title).sort(), ['Help', 'Home', 'Pricing'])
})

test('the page cap stops the crawl and says that it did', async () => {
  SITE = {
    'http://example.test/a': { title: 'A', body: 'first page of many', links: ['/b', '/c'] },
    'http://example.test/b': { title: 'B', body: 'second page here', links: ['/c'] },
    'http://example.test/c': { title: 'C', body: 'third page here', links: [] },
  }
  const site = await sites.queue(ws, base, 'http://example.test/a', { follow: true, maxPages: 2 })
  const done = await settle(site.id)

  assert.equal(done.pages_done, 2)
  // The difference matters: it decides whether unseen pages are gone or merely unreached.
  assert.equal(done.truncated, true)
  assert.equal((await pagesOf(site.id)).length, 2)
})

test('a crawl that exhausts the site prunes pages that are gone', async () => {
  SITE = {
    'http://example.test/shop': { title: 'Shop', body: 'Everything we sell.', links: ['/shop/old', '/shop/new'] },
    'http://example.test/shop/old': { title: 'Old', body: 'A discontinued product page.', links: [] },
    'http://example.test/shop/new': { title: 'New', body: 'A current product page.', links: [] },
  }
  const first = await sites.queue(ws, base, 'http://example.test/shop', { follow: true, maxPages: 10 })
  await settle(first.id)
  assert.equal((await pagesOf(first.id)).length, 3)

  // The old page is taken down.
  delete SITE['http://example.test/shop/old']
  SITE['http://example.test/shop'].links = ['/shop/new']

  const again = await sites.queue(ws, base, 'http://example.test/shop', { follow: true, maxPages: 10 })
  await settle(again.id)

  const pages = await pagesOf(again.id)
  // A stale page is a wrong answer waiting to be retrieved, so it goes.
  assert.deepEqual(pages.map((p) => p.title).sort(), ['New', 'Shop'])
})

test('a truncated crawl never prunes, because unseen is not the same as gone', async () => {
  SITE = {
    'http://example.test/big': { title: 'Big', body: 'An index page.', links: ['/big/1', '/big/2'] },
    'http://example.test/big/1': { title: 'One', body: 'The first article.', links: [] },
    'http://example.test/big/2': { title: 'Two', body: 'The second article.', links: [] },
  }
  const first = await sites.queue(ws, base, 'http://example.test/big', { follow: true, maxPages: 10 })
  await settle(first.id)
  assert.equal((await pagesOf(first.id)).length, 3)

  // Somebody lowers the limit. The pages beyond it are still on the site.
  const again = await sites.queue(ws, base, 'http://example.test/big', { follow: true, maxPages: 2 })
  const done = await settle(again.id)
  assert.equal(done.truncated, true)
  // Silently shrinking the knowledge base because the cap changed would be the worst
  // possible reading of "crawl again".
  assert.equal((await pagesOf(again.id)).length, 3)
})

test('a page that would not load is named, not just counted', async () => {
  SITE = {
    'http://example.test/part': { title: 'Part', body: 'This one works.', links: ['/part/missing'] },
  }
  const site = await sites.queue(ws, base, 'http://example.test/part', { follow: true, maxPages: 10 })
  const done = await settle(site.id)

  assert.equal(done.status, 'done')
  // One dead link must not lose the pages that did load.
  assert.equal((await pagesOf(site.id)).length, 1)

  // The crawl worked, so this is not a job failure — the hole is in `failures`, and it
  // says which page and why. A count alone leaves nobody able to act on it.
  assert.equal(done.error, null)
  assert.equal(done.failures.length, 1)
  assert.equal(done.failures[0].url, 'http://example.test/part/missing')
  assert.match(done.failures[0].error, /404/)
})

test('a page that loads but says nothing is a hole too, and is named', async () => {
  SITE = {
    'http://example.test/idx': { title: 'Index', body: 'The index page has real words on it.', links: ['/spa'] },
    // The shell of an app that draws itself in the browser: a title, and an empty body.
    'http://example.test/spa': { title: 'App', body: '', links: [] },
  }
  const site = await sites.queue(ws, base, 'http://example.test/idx', { follow: true, maxPages: 10 })
  const done = await settle(site.id)

  assert.equal((await pagesOf(site.id)).length, 1)
  // Fetched fine, filed nothing. Passing over it in silence is how somebody ends up
  // asking why Arlo has never heard of their home page.
  assert.equal(done.failures.length, 1)
  assert.equal(done.failures[0].url, 'http://example.test/spa')
  assert.match(done.failures[0].error, /renders in the browser/)
})

test('a page title is indexed on purpose, and only once', async () => {
  SITE = {
    'http://example.test/titled': { title: 'A Very Distinctive Title', body: 'The body says something else.', links: [] },
  }
  const site = await sites.queue(ws, base, 'http://example.test/titled', { follow: false })
  await settle(site.id)

  const doc = await one(`SELECT id, title, text FROM documents WHERE uri = ?`, 'http://example.test/titled')
  assert.equal(doc.title, 'A Very Distinctive Title')

  // The stored text is the page's content. The <head> is not content, and letting the
  // title leak in through it is what made an empty page look like it had some.
  assert.equal(doc.text, 'The body says something else.')

  // The passage carries the title anyway — deliberately, because retrieval searches
  // chunks and nothing else, so a title absent from the passage is not searchable at all.
  const [passage] = await kb.passagesOf(ws, doc.id)
  assert.equal(passage.text, 'A Very Distinctive Title\n\nThe body says something else.')
  // Exactly once. Prefixing text that already opens with its own title would double it.
  assert.equal(passage.text.split('A Very Distinctive Title').length - 1, 1)
})

test('text that already opens with its own title is not given a second one', async () => {
  // Markdown uploads routinely start with their own heading.
  const filed = await kb.store(ws, { baseId: base,
    source: 'upload',
    uri: null,
    title: 'Returns Policy',
    mime: 'text/markdown',
    text: 'Returns Policy\n\nWe accept returns within thirty days of delivery for any reason.',
  })
  const [passage] = await kb.passagesOf(ws, filed.documentId)
  assert.equal(passage.text.split('Returns Policy').length - 1, 1)
})

test('a root that produces nothing says so without pretending the job died', async () => {
  SITE = {}
  const site = await sites.queue(ws, base, 'http://example.test/nothing', { follow: false })
  const done = await settle(site.id)
  assert.equal(done.status, 'done')
  assert.equal(done.pages_done, 1)
  assert.equal((await pagesOf(site.id)).length, 0)
  assert.equal(done.error, null)
  assert.deepEqual(
    done.failures.map((f) => f.url),
    ['http://example.test/nothing'],
  )
})

test('crawling again clears the previous run s failures', async () => {
  SITE = {
    'http://example.test/fixed': { title: 'Fixed', body: 'The page works now.', links: ['/fixed/broken'] },
  }
  const first = await sites.queue(ws, base, 'http://example.test/fixed', { follow: true, maxPages: 10 })
  assert.equal((await settle(first.id)).failures.length, 1)

  // The dead link is repaired. A stale failure list would keep flagging a hole that is
  // no longer there.
  SITE['http://example.test/fixed/broken'] = { title: 'Broken', body: 'Now it has content.', links: [] }
  const again = await sites.queue(ws, base, 'http://example.test/fixed', { follow: true, maxPages: 10 })
  assert.deepEqual((await settle(again.id)).failures, [])
})

test('a site taken over by a wider crawl does not linger as an empty row', async () => {
  SITE = {
    'http://example.test/docs/page': { title: 'Page', body: 'A page added on its own.', links: [] },
  }
  const alone = await sites.queue(ws, base, 'http://example.test/docs/page', { follow: false })
  await settle(alone.id)
  assert.equal((await pagesOf(alone.id)).length, 1)

  // Now the whole section is crawled, and it reaches that same page.
  SITE['http://example.test/docs'] = { title: 'Docs', body: 'The documentation index.', links: ['/docs/page'] }
  const wider = await sites.queue(ws, base, 'http://example.test/docs', { follow: true, maxPages: 10 })
  await settle(wider.id)

  assert.equal((await pagesOf(wider.id)).length, 2)
  // The page has one parent, so the old single-page site owns nothing and is cleared away.
  assert.equal(await sites.get(ws, alone.id), undefined)
})

// ---------------------------------------------------------------- housekeeping

test('removing a site takes its pages and their passages with it', async () => {
  SITE = { 'http://example.test/temp': { title: 'Temp', body: 'A page about xylophones.', links: [] } }
  const site = await sites.queue(ws, base, 'http://example.test/temp', { follow: false })
  await settle(site.id)

  const [page] = await pagesOf(site.id)
  assert.ok(page)
  const doc = await one(`SELECT id FROM documents WHERE uri = ?`, 'http://example.test/temp')
  assert.ok((await kb.passagesOf(ws, doc.id)).length)

  await sites.remove(ws, site.id)
  assert.equal(await sites.get(ws, site.id), undefined)
  // One delete, nothing orphaned: documents cascade from the site, chunks from documents.
  assert.equal(await one(`SELECT 1 FROM documents WHERE id = ?`, doc.id), undefined)
  assert.equal((await all(`SELECT 1 FROM chunks WHERE document_id = ?`, doc.id)).length, 0)
})

test('passages are what retrieval searches, and can be read back', async () => {
  SITE = { 'http://example.test/policy': { title: 'Policy', body: 'Refunds are issued within five working days.', links: [] } }
  const site = await sites.queue(ws, base, 'http://example.test/policy', { follow: false })
  await settle(site.id)

  const doc = await one(`SELECT id FROM documents WHERE uri = ?`, 'http://example.test/policy')
  const rows = await kb.passagesOf(ws, doc.id)
  assert.ok(rows.length)
  assert.equal(rows[0].ord, 0)
  assert.match(rows[0].text, /five working days/)
  // The harness has no embeddings key, so nothing carries a vector — and the modal says so
  // rather than implying everything is searchable by meaning.
  assert.equal(rows[0].embedded, false)
})

test('anyRunning is what tells the page whether to keep polling', async () => {
  assert.equal(await sites.anyRunning(ws), false)
  await run(`UPDATE sites SET status = 'running' WHERE workspace_id = ? AND id = (SELECT min(id) FROM sites WHERE workspace_id = ?)`, ws, ws)
  assert.equal(await sites.anyRunning(ws), true)
  await run(`UPDATE sites SET status = 'done' WHERE workspace_id = ?`, ws)
  assert.equal(await sites.anyRunning(ws), false)
})

test('one workspace never sees or touches another one s sites', async () => {
  const mine = (await sites.list(ws))[0]
  assert.deepEqual(await sites.list(other), [])
  assert.equal(await sites.get(other, mine.id), undefined)
  await assert.rejects(() => sites.remove(other, mine.id), /No such site/)
  assert.equal(await sites.anyRunning(other), false)
})

// ---------------------------------------------------------------- pages that carry nothing

test('a page whose body is painted by JavaScript is refused, with the reason', async () => {
  /*
   * The real one this was written for. A Wix site served 1,310,472 bytes containing 623
   * characters of text — its own navigation menu, and none of the page, because the content
   * is fetched from Wix's API after load. It was filed as a document, so "About · Contact ·
   * Cert Pathways" became a citable source about a youth academy.
   *
   * The old test was `if (page.text)`: any text at all counted as a page.
   */
  const { thinness } = await import('../src/server/scrape.ts')

  const why = thinness('About Contact Cert Pathways '.repeat(22), 1_310_472)
  assert.match(why, /renders its content in the browser/)
  assert.match(why, /1\.3 MB of markup/, 'the numbers, so it is diagnosable rather than baffling')
})


test('the two signals only count together', async () => {
  const { thinness } = await import('../src/server/scrape.ts')

  assert.equal(thinness('Call us on 6591234567', 8_000), null, 'a short page in a small document is a page')
  assert.equal(thinness('x'.repeat(4_000), 900_000), null, 'a big document with real content is a page')
  assert.equal(thinness('x'.repeat(1_200), 2_000_000), null, 'enough text is enough, however heavy the markup')
  assert.match(thinness('x'.repeat(300), 400_000), /renders its content/, 'little text, much markup')
})

test('a shell page is reported and filed nowhere, while its siblings still index', async () => {
  /*
   * The wiring, not just the rule. The predicate can be perfect and still unused: this is the
   * test that fails if `crawl()` goes back to asking whether there is *any* text.
   *
   * The shell is a sentence of navigation followed by a great deal of markup carrying
   * nothing — a comment here, Wix's case in life. stripHtml drops it, so the text stays tiny
   * while the document stays huge, which is exactly the pair of signals.
   */
  SITE = {
    'http://example.test/home': {
      title: 'Home',
      body: 'Everything you need to know about our opening hours and where to find us.',
      links: ['/shell'],
    },
    'http://example.test/shell': {
      title: 'Youth Academy',
      body: `About Contact Cert Pathways<!--${'x'.repeat(200_000)}-->`,
      links: [],
    },
  }

  const site = await sites.queue(ws, base, 'http://example.test/home', { follow: true, maxPages: 10 })
  const done = await settle(site.id)

  const filed = await pagesOf(site.id)
  assert.equal(filed.length, 1, 'the real page is indexed and the shell is not')
  assert.ok(!filed.some((d) => d.uri.endsWith('/shell')), 'no document for the shell')

  assert.equal(done.failures.length, 1)
  assert.equal(done.failures[0].url, 'http://example.test/shell')
  assert.match(done.failures[0].error, /renders its content in the browser/)
})
