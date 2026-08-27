/**
 * Crawled sites, and the job that fills them.
 *
 * A site is one address somebody submitted. It is both the parent every crawled page hangs
 * off and the record of the crawl itself — status, progress, and what went wrong.
 *
 * ---------------------------------------------------------------- why it runs elsewhere
 *
 * Crawling twenty-five pages takes tens of seconds. Doing it inside the request that asked
 * for it means a spinner, a browser that may give up, and a proxy timeout deciding how big
 * a site can be. So `queue()` writes the row and returns, and the work happens in the
 * process that owns the singletons — reached over the same cluster IPC the WhatsApp
 * sockets use, so it starts immediately rather than waiting for the next poller tick.
 *
 * The browser then polls the row. That is the whole progress mechanism: the crawler writes
 * `pages_done` as it goes and the page reads it.
 */
import { all, asSystem, insert, one, run, withWorkspace } from './db.ts'
import { crawl } from './scrape.ts'
import { assertReachable } from './net.ts'
import { store } from './kb.ts'
import { ownsSingletons, singleton } from './singleton.ts'

export type Failure = { url: string; error: string }

export type Status = 'queued' | 'running' | 'done' | 'failed'

export type Site = {
  id: number
  /** The knowledge base it was crawled into. */
  base_id: number
  root_url: string
  follow: boolean
  max_pages: number
  status: Status
  pages_done: number
  pages_queued: number
  truncated: boolean
  /** Pages this crawl could not turn into a document, and why. */
  failures: Failure[]
  /** Set only when the crawl itself failed. Page-level problems live in `failures`. */
  error: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}

/** How many pages a crawl may fetch, whatever the form says. */
const CAP = 250
const DEFAULT_PAGES = 25

export const clampPages = (n: unknown) => {
  const asked = Math.floor(Number(n))
  if (!Number.isFinite(asked) || asked < 1) return DEFAULT_PAGES
  return Math.min(asked, CAP)
}

// ---------------------------------------------------------------- reading

export const list = (workspaceId: number, baseId?: number) =>
  all<Site & { pages: number; passages: number }>(
    `SELECT s.*,
            (SELECT count(*)::int FROM documents d WHERE d.site_id = s.id) AS pages,
            (SELECT count(*)::int FROM chunks c
               JOIN documents d ON d.id = c.document_id WHERE d.site_id = s.id) AS passages
       FROM sites s
      WHERE s.workspace_id = ? AND (?::int IS NULL OR s.base_id = ?)
      ORDER BY s.created_at DESC`,
    workspaceId,
    baseId ?? null,
    baseId ?? null,
  )

export const get = (workspaceId: number, siteId: number) =>
  one<Site>(`SELECT * FROM sites WHERE workspace_id = ? AND id = ?`, workspaceId, siteId)

/** True while anything is still working — what tells the page whether to keep polling. */
export const anyRunning = async (workspaceId: number) =>
  !!(await one(`SELECT 1 FROM sites WHERE workspace_id = ? AND status IN ('queued','running')`, workspaceId))

// ---------------------------------------------------------------- queueing

/**
 * Accept a crawl and hand it off. Returns as soon as the row exists.
 *
 * The address is checked here rather than in the background, because a typo or an address
 * pointing inside our own network should be an error on the form — not a job that appears
 * in the list and fails a second later with nobody looking.
 */
export async function queue(
  workspaceId: number,
  baseId: number,
  rootUrl: string,
  { follow = true, maxPages = DEFAULT_PAGES }: { follow?: boolean; maxPages?: number } = {},
): Promise<Site> {
  const url = await assertReachable(rootUrl)
  const pages = follow ? clampPages(maxPages) : 1

  /*
   * One row per address, per base. The same help centre can legitimately be crawled into
   * two bases — a public one and an internal one that also holds the handbook — and the
   * guard on `status` is what stops two people (or two impatient clicks) starting the same
   * crawl twice.
   */
  const existing = await one<{ id: number; status: Status }>(
    `SELECT id, status FROM sites WHERE workspace_id = ? AND base_id = ? AND root_url = ?`,
    workspaceId,
    baseId,
    url.href,
  )
  if (existing?.status === 'queued' || existing?.status === 'running')
    throw new Error('That site is already being crawled.')

  const siteId =
    existing?.id ??
    (await insert(
      `INSERT INTO sites (workspace_id, base_id, root_url, follow, max_pages) VALUES (?,?,?,?,?)`,
      workspaceId,
      baseId,
      url.href,
      follow,
      pages,
    ))

  await run(
    `UPDATE sites SET follow = ?, max_pages = ?, status = 'queued', pages_done = 0, pages_queued = 0,
            truncated = false, failures = '[]'::jsonb, error = NULL, attempts = 0,
            started_at = NULL, finished_at = NULL
      WHERE workspace_id = ? AND id = ?`,
    follow,
    pages,
    workspaceId,
    siteId,
  )

  /*
   * Deliberately not awaited past the hand-off. `begin()` starts the crawl in the owning
   * process and returns; awaiting the crawl itself would put us back where we started, and
   * the singleton RPC has a one-minute deadline a real crawl would blow through.
   *
   * A failure to hand off is not a failure to accept: the row is queued and the poller's
   * sweep will pick it up. Losing the instant start is a slower crawl, not a lost one.
   */
  void begin(siteId, workspaceId).catch((e) =>
    console.error('[sites] could not start crawl', siteId, e instanceof Error ? e.message : e),
  )

  return (await get(workspaceId, siteId))!
}

export async function remove(workspaceId: number, siteId: number) {
  // The documents go with it, and their chunks follow from documents' own cascade.
  const { changes } = await run(`DELETE FROM sites WHERE workspace_id = ? AND id = ?`, workspaceId, siteId)
  if (!changes) throw new Error('No such site')
}

// ---------------------------------------------------------------- the job

/**
 * Claim a queued site and crawl it, in whichever process owns the singletons.
 *
 * The claim is a conditional UPDATE: two callers racing the same site produce exactly one
 * winner, so an instant hand-off and a poller sweep arriving together cannot double-crawl.
 */
const beginImpl = async (siteId: number, workspaceId: number) => {
  const claimed = await withWorkspace({ workspaceId }, () =>
    one<{ id: number }>(
      `UPDATE sites SET status = 'running', started_at = now(), pages_done = 0, error = NULL,
              attempts = attempts + 1
        WHERE id = ? AND status = 'queued' RETURNING id`,
      siteId,
    ),
  )
  if (!claimed) return { started: false }

  // Not awaited: this returns to the caller over IPC while the crawl carries on here.
  void runCrawl(siteId, workspaceId)
  return { started: true }
}

/** Reached from any process; runs in the one that owns the sockets and the timers. */
export const begin = singleton('kb.crawl', beginImpl)

async function runCrawl(siteId: number, workspaceId: number) {
  /*
   * Every write opens its own short scope rather than wrapping the crawl in one.
   *
   * withWorkspace holds a pooled connection inside an open transaction for as long as its
   * callback runs — fine for a request, ruinous for something that spends a minute waiting
   * on somebody else's web server. One scope per page keeps the connection borrowed for
   * milliseconds at a time.
   */
  const scope = <T>(fn: () => Promise<T>) => withWorkspace({ workspaceId }, fn)

  const site = await scope(() => get(workspaceId, siteId))
  if (!site) return

  /** Documents this crawl actually saw, so the ones it did not can be considered. */
  const seen = new Set<number>()

  try {
    const { failed, truncated } = await crawl(site.root_url, {
      maxPages: site.follow ? site.max_pages : 1,
      onPage: async (page) => {
        await scope(async () => {
          const filed = await store(workspaceId, {
            source: 'url',
            uri: page.url,
            title: page.title,
            mime: 'text/html',
            text: page.text,
            siteId,
            baseId: site.base_id,
          })
          seen.add(filed.documentId)
        })
      },
      onProgress: async ({ done, queued }) => {
        await scope(() =>
          run(`UPDATE sites SET pages_done = ?, pages_queued = ? WHERE id = ?`, done, queued, siteId),
        )
      },
    })

    await scope(async () => {
      /*
       * Pages that were here last time and are not here now.
       *
       * Only pruned when the crawl exhausted the site. If the page cap cut it short, the
       * pages we did not see are almost certainly beyond the limit rather than deleted
       * from the site — and removing them would quietly shrink the knowledge base every
       * time somebody crawled a site bigger than their cap.
       */
      if (!truncated && seen.size) {
        await run(
          `DELETE FROM documents WHERE workspace_id = ? AND site_id = ? AND NOT (id = ANY(?::int[]))`,
          workspaceId,
          siteId,
          [...seen],
        )
      }

      /*
       * Sites this crawl has taken over from.
       *
       * A page can only have one parent, so crawling a root that reaches pages previously
       * added on their own leaves those single-page sites holding nothing. The condition is
       * deliberately narrow — no pages of its own, *and* the page at its own root now
       * belongs to somebody else — so a crawl that legitimately found nothing readable
       * keeps its row and its explanation.
       */
      await run(
        `DELETE FROM sites s
          WHERE s.workspace_id = ? AND s.base_id = ? AND s.id <> ?
            AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.site_id = s.id)
            AND EXISTS (SELECT 1 FROM documents d
                         WHERE d.base_id = s.base_id AND d.uri = s.root_url AND d.site_id IS NOT NULL)`,
        workspaceId,
        site.base_id,
        siteId,
      )

      await run(
        `UPDATE sites SET status = 'done', truncated = ?, pages_queued = 0, finished_at = now(),
                failures = ?::jsonb, error = NULL
          WHERE id = ?`,
        truncated,
        /*
         * Which pages, not how many.
         *
         * `error` stays null: the crawl worked. A site where half the pages would not load
         * is a knowledge base with holes in it, and the holes are worth showing — but
         * colouring a successful crawl red taught people to ignore the colour.
         *
         * Each reason is truncated because it can carry a remote server's response body.
         */
        JSON.stringify(failed.map((f) => ({ url: f.url, error: f.error.slice(0, 300) }))),
        siteId,
      )
    })
  } catch (e) {
    await scope(() =>
      run(
        `UPDATE sites SET status = 'failed', finished_at = now(), error = ? WHERE id = ?`,
        String(e instanceof Error ? e.message : e).slice(0, 300),
        siteId,
      ),
    ).catch(() => {})
  }
}

/**
 * How many interruptions before a crawl is left alone. The bound exists for the crawl that
 * ends the process: without it, that restarts, resumes, and ends it again forever.
 */
const MAX_ATTEMPTS = 3

/**
 * Boot only, in the process that owns the crawls.
 *
 * A row still marked `running` at boot cannot be running — nothing was — so it goes back in
 * the queue and starts again. Everything it needs is already in the row, so asking somebody
 * to press the button again would be asking for a decision they do not have to make.
 *
 * This must NOT be on the poller: a tick arriving mid-crawl would restart a job that is
 * working perfectly, and it would never finish.
 */
export async function recover() {
  if (!ownsSingletons) return

  await asSystem(async () => {
    // Interrupted this many times is no longer bad luck. Said plainly rather than tried
    // again, because a crawl that ends the process would otherwise loop with every deploy.
    await run(
      `UPDATE sites SET status = 'failed', finished_at = now(),
              error = 'Stopped after being interrupted ' || attempts || ' times. Crawl it again to retry.'
        WHERE status = 'running' AND attempts >= ?`,
      MAX_ATTEMPTS,
    )
    // Everything needed to finish is still in the row — the address, the page limit — so a
    // crawl caught by a restart goes back in the queue rather than asking somebody to
    // re-type what the row already knows.
    await run(`UPDATE sites SET status = 'queued' WHERE status = 'running'`)
  })

  await sweep()
}

/**
 * Start anything still queued. Safe on a timer: `queued` is by definition not started, and
 * the claim inside beginImpl decides the winner if a hand-off arrives at the same moment.
 *
 * This is the backstop for a hand-off that never landed — the owner was restarting, or the
 * IPC failed. Without it such a crawl would sit queued forever.
 */
export async function sweep() {
  if (!ownsSingletons) return

  // Enumerating across workspaces: the sweep has no session, like the rest of the poller.
  const waiting = await asSystem(() =>
    all<{ id: number; workspace_id: number }>(`SELECT id, workspace_id FROM sites WHERE status = 'queued'`),
  )
  for (const row of waiting) await beginImpl(row.id, row.workspace_id)
}
