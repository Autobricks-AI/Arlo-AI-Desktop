/**
 * Reading a website into the knowledge base.
 *
 * `fetch` plus string handling, deliberately: no headless browser and no parser
 * dependency. A marketing site, a docs site and a help centre are all server-rendered
 * HTML, which is the overwhelming majority of what anyone points this at.
 *
 * ponytail: no JavaScript execution, so a page that renders entirely client-side comes
 * back empty. The upgrade is a headless browser, which is a container and a queue and
 * about 300MB — worth it only once somebody actually has such a site.
 */
import { assertReachable, boundedFetch } from './net.ts'

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
}

/**
 * HTML to text, keeping the block breaks.
 *
 * The breaks matter more here than they would for display: they are where the chunker
 * prefers to cut, so a page flattened to one line chunks at arbitrary points instead of
 * at its own headings.
 */
export const stripHtml = (s: string) =>
  s
    /*
     * Script, style and head are not content, and their text would otherwise be indexed as
     * if it were.
     *
     * `head` matters more than it looks: it holds the <title>, which is stored on the
     * document in its own right. Leaving it in the text duplicated every title into the
     * first passage — and, worse, made a page that renders entirely in the browser look
     * like it had content, so it was filed as a document consisting of nothing but its own
     * title instead of being reported as unreadable.
     *
     * nav and footer are left alone: on a docs site they carry real navigation text.
     */
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|tr|li|h[1-6]|table|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/?(h[1-6])[^>]*>/gi, '\n\n')
    /*
     * Inline tags leave nothing behind; everything else leaves a space.
     *
     * One rule, and it is the difference between "ship to Malaysia?" and "ship to
     * Malaysia ?". A tag wrapping part of a sentence is not a word boundary, and turning
     * it into one detaches punctuation, splits hyphenated names, and ruins the tokens
     * full-text search is about to stem.
     */
    .replace(/<\/?(a|b|i|u|s|em|strong|span|code|small|sub|sup|mark|abbr|cite|q|time|label|font|big|kbd|var|samp)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, (m) => ENTITIES[m])
    /*
     * Numeric entities, decimal and hexadecimal.
     *
     * The hex form is not an edge case: `&#x27;` is what most template engines emit for an
     * apostrophe, so without this every "Men's Health" was indexed — and would have been
     * quoted back to a customer — as "Men&#x27;s Health". It also splits the word for the
     * tokeniser, so the page stopped matching its own subject.
     */
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) =>
      String.fromCodePoint(n[0].toLowerCase() === 'x' ? Number.parseInt(n.slice(1), 16) : Number(n)),
    )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const titleOf = (html: string, fallback: string) =>
  stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').slice(0, 200) || fallback

/** Links worth following: same origin, a page rather than a file, no fragment. */
const SKIP = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|zip|gz|mp[34]|woff2?|ttf)$/i

function linksIn(html: string, base: URL): string[] {
  const out = new Set<string>()
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let u: URL
    try {
      u = new URL(m[1], base)
    } catch {
      continue
    }
    if (u.origin !== base.origin) continue
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    if (SKIP.test(u.pathname)) continue
    // A fragment is the same page. Query strings are kept: on many sites they are the page.
    u.hash = ''
    out.add(u.href)
  }
  return [...out]
}

/**
 * The paths robots.txt asks us not to fetch, for `User-agent: *`.
 *
 * ponytail: prefix matching only — no wildcards, no Allow, no crawl-delay, no per-agent
 * sections beyond `*`. That covers what a normal site's robots.txt actually says. It is
 * etiquette rather than a security control, but a crawler that ignores it entirely is the
 * kind of thing that gets a customer's IP blocked.
 */
async function disallowed(origin: string): Promise<string[]> {
  try {
    const { res, body } = await boundedFetch(`${origin}/robots.txt`, { timeoutMs: 8_000, maxBytes: 256 * 1024 })
    if (!res.ok) return []
    const rules: string[] = []
    let applies = false
    for (const raw of body.split('\n')) {
      const line = raw.split('#')[0].trim()
      const [key, ...rest] = line.split(':')
      const value = rest.join(':').trim()
      if (/^user-agent$/i.test(key)) applies = value === '*'
      else if (applies && /^disallow$/i.test(key) && value) rules.push(value)
    }
    return rules
  } catch {
    // No robots.txt, or it would not load. Neither is a reason to refuse the crawl.
    return []
  }
}

/**
 * A shell rather than a page: very little text out of a great deal of markup.
 *
 * The two together are the signal — either alone is not. A short page is allowed to be short,
 * and a large page is allowed to be large; what no real page does is serve a megabyte of
 * markup carrying a couple of sentences.
 *
 * Measured against a real one: a Wix site's youth-academy page served 1,310,472 bytes
 * containing 597 characters of text — its own navigation menu, and none of the page. Roughly
 * one twentieth of one percent, where a page with content on it runs in the several percent.
 */
const SHELL_TEXT = 1_200
const SHELL_HTML = 100_000

/**
 * Why this page is not worth a document, or null if it is.
 *
 * A page that yields only its own navigation is worse than a page that fails outright. It is
 * filed, it is retrievable, and it will be cited — so a customer asking about the youth
 * academy gets answered with the words "About · Contact · Cert Pathways". Refusing it is the
 * kinder outcome, and saying *why* is what makes it actionable rather than baffling: the
 * person who added the URL can open it in a browser and see the content perfectly well.
 */
export function thinness(text: string, htmlBytes: number): string | null {
  const chars = text.trim().length
  if (!chars) return 'No readable text — the page probably renders in the browser'
  if (chars >= SHELL_TEXT || htmlBytes <= SHELL_HTML) return null

  return (
    `renders its content in the browser — ${chars.toLocaleString()} characters of text in ` +
    `${(htmlBytes / 1_000_000).toFixed(1)} MB of markup. Nothing here can be indexed. Paste the ` +
    `content in as a note, or upload it as a file.`
  )
}

/*
 * There is deliberately no "too few characters" rule.
 *
 * One was written and taken out again: a floor of 200 characters rejected eight of this
 * crawler's own test pages, which is exactly the point — a short page is allowed to be short.
 * "Call us on 6591234567" is a whole answer. Only the pair of signals is safe to act on:
 * very little text out of a great deal of markup, which no page with content on it produces.
 */

export type Page = { url: string; title: string; text: string }

/**
 * Fetch one page. Throws for anything the caller should see — a bad address, a private
 * one, a response that is not HTML.
 */
export async function fetchPage(raw: string): Promise<Page & { links: string[]; thin: string | null }> {
  const url = await assertReachable(raw)
  const { res, body } = await boundedFetch(url.href, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'ArloAI/1.0 (+knowledge base crawler)' },
  })
  if (!res.ok) throw new Error(`${url.href} answered ${res.status}`)

  const type = res.headers.get('content-type') ?? ''
  if (!/html|xml|text\/plain/i.test(type)) throw new Error(`${url.href} is ${type.split(';')[0] || 'not a page'}`)

  const text = /html|xml/i.test(type) ? stripHtml(body) : body.trim()
  return {
    // res.url, not the input: a redirect means the content belongs to where it landed.
    url: res.url || url.href,
    title: titleOf(body, url.pathname),
    text,
    // Judged here, where both halves are still in hand: the caller sees only the text and
    // cannot tell a short page from a megabyte of markup that produced one.
    thin: thinness(text, body.length),
    links: /html/i.test(type) ? linksIn(body, new URL(res.url || url.href)) : [],
  }
}

/**
 * Walk a site from one address, breadth-first, staying on the same origin.
 *
 * Bounded by page count rather than by depth: depth is a property of how the site is
 * linked and says nothing about how long this will take, whereas `maxPages` is exactly
 * what somebody watching a progress bar wants to reason about.
 *
 * A page that fails does not stop the crawl — one dead link should not lose the other
 * nineteen pages. What failed is returned, so the UI can say so rather than quietly
 * indexing less than was asked for.
 */
export type Progress = {
  /** Pages fetched so far, whether or not they had any text. */
  done: number
  /** Discovered and not yet fetched. With `done` this is an honest bar before the end. */
  queued: number
}

export async function crawl(
  start: string,
  {
    maxPages = 25,
    onPage,
    onProgress,
  }: {
    maxPages?: number
    onPage?: (p: Page) => Promise<void>
    onProgress?: (p: Progress) => Promise<void>
  } = {},
): Promise<{ pages: Page[]; failed: { url: string; error: string }[]; truncated: boolean }> {
  const first = await assertReachable(start)
  const skip = await disallowed(first.origin)

  const queue = [first.href]
  const seen = new Set(queue)
  const pages: Page[] = []
  const failed: { url: string; error: string }[] = []
  let done = 0

  while (queue.length && done < maxPages) {
    const next = queue.shift()!
    try {
      const page = await fetchPage(next)
      if (!page.thin) {
        pages.push({ url: page.url, title: page.title, text: page.text })
        await onPage?.({ url: page.url, title: page.title, text: page.text })
      } else {
        /*
         * Fetched fine, and carried nothing worth keeping. Reported rather than passed over
         * in silence: a page that produces no document is exactly the page somebody will
         * later ask why Arlo has never heard of, and "it loaded but was empty" is a
         * different problem with a different fix than a dead link.
         *
         * This used to test `page.text` for emptiness, which let a page through on any text
         * at all — so a site whose whole body is painted by JavaScript filed its navigation
         * menu as though that were the page.
         */
        failed.push({ url: page.url, error: page.thin })
      }
      for (const link of page.links) {
        if (seen.has(link) || seen.size >= maxPages * 8) continue
        if (skip.some((rule) => new URL(link).pathname.startsWith(rule))) continue
        seen.add(link)
        queue.push(link)
      }
    } catch (e) {
      failed.push({ url: next, error: e instanceof Error ? e.message : String(e) })
    }
    /*
     * Counted per page fetched, not per page filed. A page that 404s or turns out to be a
     * PDF still cost a request and still moves the bar — a progress bar that only counts
     * successes stalls on a run of dead links and looks hung.
     */
    done++
    await onProgress?.({ done, queued: Math.min(queue.length, maxPages - done) })
  }

  /*
   * Did the cap cut this short, or did we genuinely run out of site?
   *
   * The caller uses this to decide whether pages it did *not* see this time are gone from
   * the site or merely beyond the limit — and therefore whether deleting them is tidying
   * up or throwing away a customer's knowledge base.
   */
  return { pages, failed, truncated: done >= maxPages && queue.length > 0 }
}
