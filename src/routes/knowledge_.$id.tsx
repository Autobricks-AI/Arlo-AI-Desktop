import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { NotFound } from '../components/NotFound'
import { requireSession } from '../server/auth'
import * as bases from '../server/bases'
import { findPassages, getDocument, listDocuments, passagesOf, reindex, removeDocument, removePassage, saveNote, saveText, stats } from '../server/kb'
import { configured } from '../server/embed'
import * as sites from '../server/sites'
import * as uploads from '../server/uploads'
import { MAX_UPLOAD_MB } from '../types'
import { lightDismiss } from '../components/Modal'

/**
 * One knowledge base: everything in it, and what became of each thing.
 *
 * Every read here is scoped to the base, not the workspace. That is the whole distinction —
 * two bases in one workspace are two separate bodies of knowledge, and a page that showed
 * the workspace's sources under one base's heading would be lying about which bot can read
 * what.
 */
const load = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data: baseId }) => {
    const s = await requireSession()
    const base = await bases.get(s.workspaceId, baseId)
    if (!base) return null
    return {
      base,
      sites: await sites.list(s.workspaceId, baseId),
      uploads: await uploads.list(s.workspaceId, baseId),
      documents: await listDocuments(s.workspaceId, baseId),
      stats: await stats(s.workspaceId, baseId),
      /** Whether answers can be found by meaning, or only by keyword. Shown, not hidden. */
      embeddings: configured(),
      /**
       * While true the page keeps polling. Cheaper to decide here than to infer in the UI,
       * and it covers both kinds of slow work — a crawl and a file being read are the same
       * thing to somebody watching the page.
       */
      busy: (await sites.anyRunning(s.workspaceId)) || (await uploads.anyRunning(s.workspaceId)),
    }
  })

/**
 * Accept a crawl. Returns the moment the row exists — the crawling happens elsewhere.
 *
 * The browser gets a row back in milliseconds and watches it fill, rather than holding a
 * request open for a minute and hoping.
 */
const startCrawl = createServerFn({ method: 'POST' })
  .validator((d: { baseId: number; url: string; follow: boolean; maxPages: number }) => d)
  .handler(async ({ data }) => {
    // The workspace comes from the session. A server function is reachable by POST
    // without this page's loader ever having run — so the base id is checked against it.
    const s = await requireSession()
    if (!(await bases.get(s.workspaceId, data.baseId))) throw new Error('No such knowledge base')
    try {
      const site = await sites.queue(s.workspaceId, data.baseId, data.url, {
        follow: data.follow,
        maxPages: data.maxPages,
      })
      return { ok: true as const, siteId: site.id }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

const recrawl = createServerFn({ method: 'POST' })
  .validator((d: { id: number; maxPages: number }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const site = await sites.get(s.workspaceId, data.id)
    if (!site) throw new Error('No such site')
    try {
      /*
       * The page count is the follow control. Asking for more than one page is asking it to
       * follow links — otherwise a site added as a single page could never be widened, and
       * raising its limit would silently do nothing.
       */
      await sites.queue(s.workspaceId, site.base_id, site.root_url, {
        follow: data.maxPages > 1,
        maxPages: data.maxPages,
      })
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

const dropSite = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => sites.remove((await requireSession()).workspaceId, data))

/**
 * Accept a file. Returns the moment the row exists — the reading happens elsewhere.
 *
 * Same shape as starting a crawl, for the same reason: a fifty-megabyte manual is minutes
 * of parsing and embedding, and none of that belongs inside the request that uploaded it.
 */
const fromFile = createServerFn({ method: 'POST' })
  .validator((d: FormData) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const file = data.get('file')
    if (!(file instanceof File)) return { ok: false as const, error: 'No file was attached' }
    const baseId = Number(data.get('baseId'))
    if (!(await bases.get(s.workspaceId, baseId))) return { ok: false as const, error: 'No such knowledge base' }
    try {
      const row = await uploads.queue(s.workspaceId, baseId, {
        name: file.name,
        mime: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      })
      return { ok: true as const, uploadId: row.id }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

/**
 * A passage somebody typed, filed as a document of its own.
 *
 * The third way in, and the one that was missing: everything a company knows is not on its
 * website and not in a PDF. "We are closed on public holidays" is one sentence, and until
 * now the only way to get it in here was to write a file and upload it.
 *
 * Chunked and embedded like anything else — `store()` does not care where text came from
 * once it has it — and editable afterwards through the same passages sheet.
 */
const fromText = createServerFn({ method: 'POST' })
  .validator((d: { baseId: number; title: string; text: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    if (!(await bases.get(s.workspaceId, data.baseId))) return { ok: false as const, error: 'No such knowledge base' }
    const title = data.title.trim().slice(0, 200)
    if (!title) return { ok: false as const, error: 'Give it a title — it is what a citation will say.' }
    try {
      const filed = await saveNote(s.workspaceId, data.baseId, title, data.text)
      return { ok: true as const, chunks: filed.chunks }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

const dropUpload = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => uploads.remove((await requireSession()).workspaceId, data))

const drop = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => removeDocument((await requireSession()).workspaceId, data))

const rebuild = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => reindex((await requireSession()).workspaceId, data))

/** What a document was actually indexed as: the passages retrieval searches. */
const indexed = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    return { passages: await passagesOf(s.workspaceId, data) }
  })

/** Cut one passage out of the document it came from, for good. */
const dropPassage = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => removePassage((await requireSession()).workspaceId, data))

/**
 * The extracted text itself — what the passages were cut from, and the thing worth
 * correcting when a scan was misread or a page came through with its navigation attached.
 */
const fullText = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const doc = await getDocument(s.workspaceId, data)
    if (!doc) throw new Error('No such document')
    return { text: doc.text, title: doc.title, uri: doc.uri, fromCrawl: !!doc.site_id }
  })

const saveDocText = createServerFn({ method: 'POST' })
  .validator((d: { id: number; text: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    try {
      return { ok: true as const, chunks: await saveText(s.workspaceId, data.id, data.text) }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

/**
 * Where in this base does it say that?
 *
 * The question that follows a bot saying something surprising. It used to be unanswerable
 * without opening pages one at a time: a bot offered a course that had been discontinued, and
 * finding the sentence meant reading nineteen crawled pages by hand. Each hit names its page
 * and opens straight into the editor, so finding it and fixing it are the same trip.
 */
const findText = createServerFn({ method: 'POST' })
  .validator((d: { baseId: number; q: string }) => d)
  .handler(async ({ data }) => findPassages((await requireSession()).workspaceId, data.baseId, data.q))

/** The three ways in, as the three lists. Same order as the Add a source sheet. */
const VIEWS = [
  { id: 'written', label: 'Written here' },
  { id: 'files', label: 'Files' },
  { id: 'sites', label: 'Sites' },
] as const
type View = (typeof VIEWS)[number]['id']

export const Route = createFileRoute('/knowledge_/$id')({
  // In the URL like every other tabbed page, so a base open on its files is a link
  // somebody can send. Unknown values fall back rather than rendering nothing.
  validateSearch: (q: Record<string, unknown>): { view?: View } =>
    VIEWS.some((v) => v.id === q.view) ? { view: q.view as View } : {},
  loader: ({ params }) => load({ data: Number(params.id) }),
  component: Knowledge,
})

type Data = NonNullable<Awaited<ReturnType<typeof load>>>
type Doc = Data['documents'][number]
type Up = Data['uploads'][number]

/** Enough of a document to head the passages sheet. A page and a file both qualify. */
type Viewable = { id: number; title: string; uri: string | null }

/** The three ways knowledge gets in here. Typing first: it is the one nobody expects. */
const SOURCE_TABS = [
  { id: 'text', label: 'Write a passage' },
  { id: 'file', label: 'Upload a file' },
  { id: 'url', label: 'Crawl a website' },
] as const

/** Sizes people recognise. A knowledge base has files from a kilobyte to fifty megabytes. */
const size = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * Hook-free on purpose: `KnowledgeView` below runs a long stretch of hooks straight off
 * `data`'s fields, and a conditional return in front of only some of them — rather than
 * here, in front of all of it — would change how many hooks run the moment the loader data
 * flips from null to real between two renders of the *same* mounted route (a different id,
 * not a different page).
 */
function Knowledge() {
  const data = Route.useLoaderData()
  if (!data) return <NotFound what="knowledge base" to="/knowledge" label="Back to the list." />
  return <KnowledgeView data={data} />
}

function KnowledgeView({ data }: { data: Data }) {
  const router = useRouter()
  const crawlFn = useServerFn(startCrawl)
  const fileFn = useServerFn(fromFile)
  const textFn = useServerFn(fromText)

  const [url, setUrl] = useState('')
  const [follow, setFollow] = useState(true)
  const [maxPages, setMaxPages] = useState(25)
  const [busy, setBusy] = useState('')
  const dropDocFn = useServerFn(drop)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const [openFile, setOpenFile] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [source, setSource] = useState<(typeof SOURCE_TABS)[number]['id']>('text')
  const [noteTitle, setNoteTitle] = useState('')
  const [noteText, setNoteText] = useState('')
  const [viewing, setViewing] = useState<Viewable | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  /*
   * The box holds what you typed; `searched` holds what was asked for.
   *
   * Two things, because a keystroke costs a round trip. A quarter of a second after you stop
   * typing, same as the contacts search. `found === null` while a query is in flight is what
   * makes the panel say "searching" instead of flashing the previous answer under the new
   * query -- the wrong hits under the right words is worse than a pause.
   */
  const [typed, setTyped] = useState('')
  const [searched, setSearched] = useState('')
  const [found, setFound] = useState<Awaited<ReturnType<typeof findText>> | null>(null)
  const findFn = useServerFn(findText)

  useEffect(() => {
    const t = setTimeout(() => setSearched(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])

  useEffect(() => {
    if (searched.length < 2) return
    let live = true
    setFound(null)
    void findFn({ data: { baseId: data.base.id, q: searched } })
      .then((r) => live && setFound(r))
      .catch(() => live && setFound({ hits: [], more: false }))
    // Cancelled on the next query so a slow search cannot land on top of a fast later one.
    return () => {
      live = false
    }
  }, [searched, data.base.id, findFn])


  /*
   * Poll while anything is crawling, and stop the moment nothing is.
   *
   * `router.invalidate()` re-runs the loader, so progress, the page list and the counts all
   * move together — no second endpoint to keep in step with the first. Two seconds is fast
   * enough to feel live and slow enough that a 25-page crawl costs a dozen queries.
   */
  useEffect(() => {
    if (!data.busy) return
    const timer = setInterval(() => void router.invalidate(), 2000)
    return () => clearInterval(timer)
  }, [data.busy, router])

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setErr('')
    try {
      const r = (await fn()) as { ok?: boolean; error?: string } | undefined
      if (r && r.ok === false) setErr(r.error ?? 'That did not work')
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const pagesOf = (siteId: number) => data.documents.filter((d) => d.site_id === siteId)
  // Neither crawled nor uploaded: what a bot was taught, and anything typed straight in.
  const written = data.documents.filter((d) => d.source !== 'url' && d.source !== 'upload')
  const { view = 'written' } = Route.useSearch()
  // This route's own navigate, so the $id param comes along and the search is typed.
  const navigate = Route.useNavigate()

  return (
    <>
      <Link to="/knowledge" className="backlink">← Knowledge bases</Link>

      <div className="pagehead">
        <div className="titles">
          <h1>{data.base.name}</h1>
          <p className="lede">
            {data.base.description ||
              'What Arlo is allowed to answer from. Every answer cites the passage it came from.'}
          </p>
        </div>
        {/*
          One button instead of two permanent forms. The forms were the first thing on the
          page and the thing you need least often — everything below is what you came to
          look at, and it was pushed under a fold by a file picker you use once a week.
        */}
        <div className="actions">
          <button className="primary" onClick={() => setAdding(true)}>
            Add source
          </button>
        </div>
      </div>

      <div className="grid" style={{ marginBottom: 28 }}>
        <div className="card stat">
          <small>Documents</small>
          {data.stats.documents}
        </div>
        <div className="card stat">
          <small>Passages</small>
          {data.stats.chunks}
        </div>
        <div className="card stat">
          <small>Searchable</small>
          {data.embeddings ? `${data.stats.embedded}/${data.stats.chunks}` : '—'}
          <span className="cap">
            {data.embeddings ? 'searchable by meaning' : 'no embeddings key — searching by keyword'}
          </span>
        </div>
      </div>

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      {/*
        Both ways of adding something, in one sheet. A native <dialog>, like the passages
        sheet: the backdrop, the focus trap and Escape-to-close come from the platform.
      */}
      {adding && (
        <dialog className="sheet" ref={(el) => el?.showModal()} onClick={lightDismiss} onClose={() => setAdding(false)}>
          <div className="row" style={{ alignItems: 'flex-start', marginBottom: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h3 style={{ fontSize: 17 }}>Add a source</h3>
              <p className="note" style={{ margin: 0 }}>
                Into <strong>{data.base.name}</strong>. Crawling and reading happen in the background, so
                this can be closed as soon as it starts.
              </p>
            </div>
            <form method="dialog">
              <button className="ghost small">Close</button>
            </form>
          </div>

          {/*
            Three ways in, one at a time.

            Side by side, two of them were a form each and the third had nowhere to go — a
            textarea worth writing a paragraph into does not fit beside a URL box. They are
            also not a choice you make by comparing: you already know whether you are
            pasting a link, picking a file, or typing something out.
          */}
          <div className="seg small" role="tablist" aria-label="Kind of source" style={{ marginTop: 14 }}>
            {SOURCE_TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={source === t.id}
                className={source === t.id ? 'on' : ''}
                onClick={() => {
                  setSource(t.id)
                  setErr('')
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div>
        {source === 'text' && (
        <div>
          <h3>Write it out</h3>
          <p className="note" style={{ marginTop: 0 }}>
            Something true about the company that is not on a page and not in a document — opening hours,
            a policy, the answer you keep giving. It is chunked, embedded and cited exactly like anything
            else here, and editable afterwards.
          </p>
          <label htmlFor="notetitle">Title</label>
          <input
            id="notetitle"
            placeholder="Public holiday hours"
            value={noteTitle}
            onChange={(e) => setNoteTitle(e.target.value)}
          />
          <p className="note" style={{ margin: '4px 0 12px' }}>
            What a citation will say when the bot quotes this.
          </p>
          <label htmlFor="notebody">Passage</label>
          <textarea
            id="notebody"
            rows={9}
            placeholder="We are closed on public holidays, and reply the next working day."
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
          />
          <button
            style={{ marginTop: 14 }}
            disabled={!noteTitle.trim() || !noteText.trim() || !!busy}
            onClick={() =>
              run('text', async () => {
                const r = await textFn({ data: { baseId: data.base.id, title: noteTitle, text: noteText } })
                if (r.ok) {
                  setNoteTitle('')
                  setNoteText('')
                  setAdding(false)
                }
                return r
              })
            }
          >
            {busy === 'text' ? 'Filing…' : 'Add passage'}
          </button>
        </div>
        )}

        {source === 'url' && (
        <div>
          <h3>From the web</h3>
          <p className="note" style={{ marginTop: 0 }}>
            A page, or the whole site it belongs to. Same origin only, and pages that render entirely in the
            browser come back empty. Crawling happens in the background — you can leave this page.
          </p>
          <label htmlFor="url">Address</label>
          <input
            id="url"
            type="url"
            placeholder="https://example.com/help"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <div className="row" style={{ marginTop: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, fontWeight: 400 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
              />
              Follow links on the same site
            </label>
            {follow && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: 0, fontWeight: 400 }}>
                up to
                <input
                  type="number"
                  min={1}
                  max={250}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                  style={{ width: 80 }}
                />
                pages
              </label>
            )}
          </div>
          <button
            style={{ marginTop: 14 }}
            disabled={!url || !!busy}
            onClick={() =>
              run('url', async () => {
                const r = await crawlFn({ data: { baseId: data.base.id, url, follow, maxPages } })
                if (r.ok) {
                  setUrl('')
                  // Closed on success: the row is already in the list behind this, with a
                  // progress bar on it, which is a better place to watch it than here.
                  setAdding(false)
                }
                return r
              })
            }
          >
            {busy === 'url' ? 'Starting…' : 'Add'}
          </button>
        </div>
        )}

        {source === 'file' && (
        <div>
          <h3>From a file</h3>
          <p className="note" style={{ marginTop: 0 }}>
            Text, Markdown, HTML or a PDF, up to {MAX_UPLOAD_MB}MB. A scan has no text layer to read, so it
            is put through OCR instead — a few seconds a page, and the progress bar counts them. Reading
            happens in the background either way, so you can leave this page.
          </p>
          <input
            ref={filePicker}
            type="file"
            accept=".txt,.md,.markdown,.csv,.json,.yaml,.yml,.log,.html,.htm,.pdf,text/*,application/pdf"
            disabled={!!busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              const clear = () => {
                // Otherwise picking the same file again fires no change event.
                if (filePicker.current) filePicker.current.value = ''
              }
              if (!file) return
              // Checked here as well as on the server: uploading sixty megabytes to be told
              // it is too big wastes a minute to reach an answer we already have.
              if (file.size > MAX_UPLOAD_MB * 1048576) {
                setErr(`${file.name} is ${Math.round(file.size / 1048576)}MB, over the ${MAX_UPLOAD_MB}MB limit`)
                clear()
                return
              }
              const body = new FormData()
              body.set('file', file)
              body.set('baseId', String(data.base.id))
              run('file', () => fileFn({ data: body }))
                .then(() => setAdding(false))
                .finally(clear)
            }}
          />
          {busy === 'file' && <p className="note">Uploading…</p>}
        </div>
        )}
          </div>
        </dialog>
      )}

      {/*
        One list at a time, counted in the strip.

        Stacked, a base with a hundred crawled pages buried the two files under them and the
        typed passages under those — and the three are not a sequence to read, they are three
        answers to "where did this come from".
      */}
      {/*
        Find the sentence, then fix it.

        Search sits above the three lists rather than inside one, because the question it
        answers does not know where the words are -- that is what it is for. A hit names its
        page and opens the same editor the page's own Open button does, so correcting
        something found here is one click, not a hunt back through the right tab.
      */}
      {(data.documents.length > 0 || typed) && (
        <input
          className="search"
          aria-label="Search this knowledge base"
          placeholder="Search for a word or phrase in here"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          style={{ marginBottom: 0 }}
        />
      )}

      {searched.length >= 2 && (
        <div className="card" style={{ marginTop: 12 }}>
          {found === null ? (
            <p className="note" style={{ margin: 0 }}>
              Searching…
            </p>
          ) : found.hits.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>
              Nothing in this base contains “{searched}”. Those exact characters, anywhere in a
              passage or a page title — a bot can still paraphrase something it never says
              word for word.
            </p>
          ) : (
            <>
              <p className="note" style={{ margin: '0 0 8px' }}>
                {found.more
                  ? `The first ${found.hits.length} passages containing “${searched}” — there are more.`
                  : `${found.hits.length} passage${found.hits.length === 1 ? '' : 's'} contain “${searched}”.`}
              </p>
              {found.hits.map((h) => (
                <div key={h.id} className="lessonrow">
                  <span className="body">
                    <p className="said">
                      {h.title}
                      {/*
                        Which hits came out of a page somebody has corrected. Without it, the
                        wording that looks wrong here may be wording already fixed somewhere
                        else, and the obvious next move is to edit it twice.
                      */}
                      {h.edited_at && <span className="pill warn" style={{ marginLeft: 6 }}>edited by hand</span>}
                    </p>
                    <p className="note" style={{ margin: '2px 0 0' }}>
                      passage {h.ord + 1}
                      {h.uri && (
                        <>
                          {' · '}
                          <a href={h.uri} target="_blank" rel="noreferrer">
                            {h.uri}
                          </a>
                        </>
                      )}
                    </p>
                    <p className="note" style={{ margin: '4px 0 0', color: 'var(--ink)' }}>
                      {highlight(h.excerpt, searched)}
                    </p>
                  </span>
                  <button
                    className="ghost small"
                    onClick={() => setViewing({ id: h.document_id, title: h.title, uri: h.uri })}
                  >
                    Open
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div className="seg small" role="tablist" aria-label="What is in here" style={{ marginTop: 24 }}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            className={view === v.id ? 'on' : ''}
            onClick={() => navigate({ search: v.id === 'written' ? {} : { view: v.id }, replace: true })}
          >
            {v.label} ({v.id === 'sites' ? data.sites.length : v.id === 'files' ? data.uploads.length : written.length})
          </button>
        ))}
      </div>

      {view === 'sites' && (
      <>
      {data.sites.length === 0 ? (
        <p className="note">Nothing crawled yet.</p>
      ) : (
        data.sites.map((site) => (
          <SiteRow
            key={site.id}
            site={site}
            pages={pagesOf(site.id)}
            open={open === site.id}
            busy={busy}
            onToggle={() => setOpen(open === site.id ? null : site.id)}
            onView={setViewing}
            run={run}
          />
        ))
      )}

      </>
      )}

      {view === 'files' && (
      <>
      {data.uploads.length === 0 ? (
        <p className="note">Nothing uploaded yet.</p>
      ) : (
        data.uploads.map((u) => (
          <UploadRow
            key={u.id}
            upload={u}
            open={openFile === u.id}
            busy={busy}
            onToggle={() => setOpenFile(openFile === u.id ? null : u.id)}
            onView={setViewing}
            run={run}
          />
        ))
      )}
      </>
      )}

      {/*
        Everything in this base that did not arrive as a crawl or an upload: what the bot was
        taught in the inbox, and anything typed straight in.

        This list not existing was the page lying by omission — a base holding one learned
        document reported "1 document" at the top and then "nothing crawled yet, nothing
        uploaded yet", so the approval that filed it looked like it had done nothing.
      */}
      {view === 'written' && (
        <>
          {written.length === 0 && (
            <p className="note">Nothing yet.</p>
          )}
          {written.map((d) => (
            <div key={d.id} className="lessonrow">
              <span className="body">
                <p className="said">{d.title}</p>
                <p className="note" style={{ margin: '2px 0 0' }}>
                  {d.chunks} passage{d.chunks === 1 ? '' : 's'} · updated {new Date(d.updated_at).toLocaleDateString()}
                </p>
              </span>
              <button className="ghost small" onClick={() => setViewing(d)}>
                Open
              </button>
              {/*
                Crawled pages and uploads have had a Remove since they existed; the things
                written here never did, so a document filed by an approval could be read and
                not got rid of. Open shows what is in it, and this takes the whole thing —
                one passage at a time is inside, under Open.
              */}
              <button
                className="ghost small bad"
                disabled={!!busy}
                title="Remove this document and everything indexed from it"
                onClick={() => {
                  if (!confirm(`Remove "${d.title}" and its ${d.chunks} passage(s)? This cannot be undone.`)) return
                  void run(`rm-${d.id}`, () => dropDocFn({ data: d.id }))
                }}
              >
                {busy === `rm-${d.id}` ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
        </>
      )}

      {viewing && <PassagesModal doc={viewing} onClose={() => setViewing(null)} />}
    </>
  )
}

/**
 * The searched words, marked, so a 220-character excerpt is scannable rather than readable.
 *
 * Index arithmetic rather than a regex: the needle is whatever somebody typed, and a regex
 * built out of that reads their brackets and dots as syntax. `<mark>` because the browser
 * already knows what a search hit looks like.
 */
function highlight(text: string, needle: string): ReactNode[] {
  // indexOf('') is 0 for ever. The caller will not pass one, and this does not depend on that.
  if (!needle) return [text]
  const hay = text.toLowerCase()
  const find = needle.toLowerCase()
  const out: ReactNode[] = []
  let at = 0
  for (let i = hay.indexOf(find, at); i !== -1; i = hay.indexOf(find, at)) {
    if (i > at) out.push(text.slice(at, i))
    out.push(<mark key={i}>{text.slice(i, i + needle.length)}</mark>)
    at = i + needle.length
  }
  out.push(text.slice(at))
  return out
}

// ---------------------------------------------------------------- one site

type Runner = (what: string, fn: () => Promise<unknown>) => Promise<void>

function SiteRow({
  site,
  pages,
  open,
  busy,
  onToggle,
  onView,
  run,
}: {
  site: Data['sites'][number]
  pages: Doc[]
  open: boolean
  busy: string
  onToggle: () => void
  onView: (d: Viewable) => void
  run: Runner
}) {
  const recrawlFn = useServerFn(recrawl)
  const dropFn = useServerFn(dropSite)
  const [limit, setLimit] = useState(site.max_pages)
  const working = site.status === 'queued' || site.status === 'running'

  return (
    <div className="card site" style={{ marginBottom: 10 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <button className="ghost small disclose" aria-expanded={open} onClick={onToggle}>
          {open ? '▾' : '▸'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row">
            <span className="pill">web</span>
            <strong style={{ overflowWrap: 'anywhere' }}>{site.root_url}</strong>
            <SiteStatus site={site} />
          </div>

          {working ? (
            <Progress site={site} />
          ) : (
            <p className="note" style={{ margin: '6px 0 0' }}>
              {site.pages} page(s), {site.passages} passage(s)
              {site.finished_at && ` · ${new Date(site.finished_at).toLocaleString()}`}
              {site.truncated && ` · stopped at the ${site.max_pages}-page limit`}
            </p>
          )}

          {/*
            Pages somebody has corrected by hand.

            Standing, not only at the moment somebody reaches for Crawl again, because it says two
            things and only one of them is about crawling. These pages no longer match the live
            site -- which is the point when a site is wrong and cannot be fixed at source, and is
            a quiet liability on a site that does change. Either way it is worth being able to see
            without pressing anything.
          */}
          {site.edited > 0 && (
            <p className="note warn" style={{ margin: '4px 0 0' }}>
              {site.edited} page{site.edited === 1 ? '' : 's'} here{' '}
              {site.edited === 1 ? 'has' : 'have'} been edited by hand and no longer match the live
              site. {site.edited === 1 ? 'It' : 'They'} will not pick up changes to the website
              until this is crawled again — and crawling again would undo the edits.
            </p>
          )}

          {/* The crawl itself died. Red, because nothing was filed and somebody must act. */}
          {site.error && <p className="note" style={{ color: 'var(--bad-ink)', margin: '4px 0 0' }}>{site.error}</p>}

          {/*
            Pages that produced nothing. Not an error — the crawl worked — but a hole in the
            knowledge base, so it says which pages and opens the row that names them.
          */}
          {site.failures.length > 0 && (
            <p style={{ margin: '4px 0 0' }}>
              <button className="linky warn" onClick={onToggle}>
                {site.failures.length} page{site.failures.length === 1 ? '' : 's'} could not be read
              </button>
            </p>
          )}
        </div>

        <div className="row">
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontWeight: 400 }}>
            <input
              type="number"
              min={1}
              max={250}
              value={limit}
              disabled={working}
              onChange={(e) => setLimit(Number(e.target.value))}
              style={{ width: 76 }}
              title="How many pages the next crawl may fetch. More than one follows links."
            />
            pages
          </label>
          <button
            className="ghost small"
            disabled={working || !!busy}
            onClick={() => {
              /*
               * Only asks when there is something to lose. A confirm on every crawl is the
               * cry-wolf failure that makes people click through the one that mattered.
               */
              if (
                site.edited > 0 &&
                !confirm(
                  `${site.edited} page(s) on this site have been edited by hand.

` +
                    `Crawling again replaces them with whatever the live site says now, and those edits are lost.

` +
                    `Continue?`,
                )
              )
                return
              void run(`re-${site.id}`, () => recrawlFn({ data: { id: site.id, maxPages: limit } }))
            }}
          >
            Crawl again
          </button>
          <button
            className="ghost small"
            disabled={!!busy}
            title="Removes the site and every page under it"
            onClick={() => {
              // The typed-note Remove already asks. This one takes far more and asked nothing.
              if (
                !confirm(
                  `Remove ${site.root_url} and all ${site.pages} page(s) it brought in?` +
                    (site.edited > 0 ? `

${site.edited} of them have been edited by hand.` : '') +
                    `

This cannot be undone.`,
                )
              )
                return
              void run(`rm-${site.id}`, () => dropFn({ data: site.id }))
            }}
          >
            Remove
          </button>
        </div>
      </div>

      {open && site.failures.length > 0 && (
        <div className="failures">
          <h3>Could not be read</h3>
          <p className="note" style={{ marginTop: 0 }}>
            Fetched, but nothing was filed. These are the gaps in what Arlo knows about this site.
          </p>
          <table>
            <tbody>
              {site.failures.map((f) => (
                <tr key={f.url}>
                  <td style={{ overflowWrap: 'anywhere' }}>
                    <a href={f.url} target="_blank" rel="noreferrer noopener">
                      {f.url}
                    </a>
                  </td>
                  <td className="note" style={{ width: '42%' }}>
                    {f.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <table style={{ marginTop: 14 }}>
          <thead>
            <tr>
              <th>Page</th>
              <th className="num">Passages</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pages.length === 0 ? (
              <tr>
                <td colSpan={4} className="note">
                  {working ? 'Nothing filed yet.' : 'No pages — the crawl found nothing readable.'}
                </td>
              </tr>
            ) : (
              pages.map((d) => <DocRow key={d.id} doc={d} busy={busy} onView={onView} run={run} showUri />)
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

function SiteStatus({ site }: { site: Data['sites'][number] }) {
  if (site.status === 'queued') return <span className="pill warn">queued</span>
  if (site.status === 'running') return <span className="pill warn">crawling</span>
  if (site.status === 'failed') return <span className="pill bad">failed</span>
  return <span className="pill ok">done</span>
}

/**
 * A crawl does not know its own size until it ends, so the bar is against what is known:
 * pages fetched, out of fetched-plus-queued, capped by the limit. It moves monotonically
 * and never claims to be finished before it is.
 */
function Progress({ site }: { site: Data['sites'][number] }) {
  const total = Math.min(site.max_pages, Math.max(site.pages_done + site.pages_queued, 1))
  return (
    <div style={{ marginTop: 8 }}>
      <progress value={site.pages_done} max={total} />
      <span className="note" style={{ marginLeft: 10 }}>
        {site.status === 'queued'
          ? 'waiting to start…'
          : `${site.pages_done} of up to ${site.max_pages} page(s)${site.pages_queued ? `, ${site.pages_queued} queued` : ''}`}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------- one uploaded file

/**
 * A file, and what became of it.
 *
 * Deliberately the same shape as a site rather than a table row: an upload is a job now, so
 * it has the same four states, the same progress while it works, the same disclosure into
 * what it produced, and the same red line when it goes wrong.
 */
function UploadRow({
  upload,
  open,
  busy,
  onToggle,
  onView,
  run,
}: {
  upload: Up
  open: boolean
  busy: string
  onToggle: () => void
  onView: (d: Viewable) => void
  run: Runner
}) {
  const dropFn = useServerFn(dropUpload)
  const rebuildFn = useServerFn(rebuild)
  const working = upload.status === 'queued' || upload.status === 'running'

  return (
    <div className="card site" style={{ marginBottom: 10 }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <button
          className="ghost small disclose"
          aria-expanded={open}
          disabled={!upload.document_id}
          title={upload.document_id ? 'Show what this was indexed as' : 'Nothing indexed yet'}
          onClick={onToggle}
        >
          {open ? '▾' : '▸'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row">
            <span className="pill">file</span>
            <strong style={{ overflowWrap: 'anywhere' }}>{upload.filename}</strong>
            <UploadStatus status={upload.status} />
          </div>

          {working ? (
            /*
             * A real fraction when there is one, and an indeterminate bar when there is not.
             *
             * Most files have no honest denominator — the passages are not countable until
             * the text has been chunked — so the bar only claims that something is
             * happening. A scan is the exception and the one that needs it: a known number
             * of pages at seconds each, which is minutes of waiting.
             */
            <div style={{ marginTop: 8 }}>
              {upload.pages_total > 0 ? (
                <>
                  <progress value={upload.pages_done} max={upload.pages_total} />
                  <span className="note" style={{ marginLeft: 10 }}>
                    OCR: reading page {upload.pages_done} of {upload.pages_total} — this PDF has no text layer,
                    so the words are being recognised from each page
                  </span>
                </>
              ) : (
                <>
                  <progress />
                  <span className="note" style={{ marginLeft: 10 }}>
                    {upload.status === 'queued' ? 'waiting to start…' : 'reading, chunking and indexing…'}
                  </span>
                </>
              )}
            </div>
          ) : (
            <p className="note" style={{ margin: '6px 0 0' }}>
              {upload.chunks} passage(s)
              {upload.size_bytes > 0 && ` · ${size(upload.size_bytes)}`}
              {upload.finished_at && ` · ${new Date(upload.finished_at).toLocaleString()}`}
            </p>
          )}

          {/* Nothing was filed and somebody has to do something about it, so: red. */}
          {upload.error && (
            <p className="note" style={{ color: 'var(--bad-ink)', margin: '4px 0 0' }}>
              {upload.error}
            </p>
          )}
        </div>

        <div className="row">
          {/*
            A plain link, not a button: the browser already knows how to download one, and
            the server has already said `attachment`. Absent for files filed before uploads
            were kept — there is a document but no original to hand back.
          */}
          {upload.size_bytes > 0 && (
            <a className="button small" href={`/api/upload/${upload.id}`} download={upload.filename}>
              Download
            </a>
          )}
          {upload.document_id && (
            <button
              className="ghost small"
              disabled={working || !!busy}
              title="Re-chunk and re-embed from the stored text"
              onClick={() => run(`re-${upload.id}`, () => rebuildFn({ data: upload.document_id! }))}
            >
              Reindex
            </button>
          )}
          <button
            className="ghost small"
            disabled={!!busy}
            title="Removes the file and everything indexed from it"
            onClick={() => run(`rm-${upload.id}`, () => dropFn({ data: upload.id }))}
          >
            Remove
          </button>
        </div>
      </div>

      {open && upload.document_id && (
        <Indexed
          documentId={upload.document_id}
          onView={() => onView({ id: upload.document_id!, title: upload.filename, uri: null })}
        />
      )}
    </div>
  )
}

function UploadStatus({ status }: { status: Up['status'] }) {
  if (status === 'queued') return <span className="pill warn">queued</span>
  if (status === 'running') return <span className="pill warn">reading</span>
  if (status === 'failed') return <span className="pill bad">failed</span>
  return <span className="pill ok">indexed</span>
}

/**
 * What one document turned into, inline: the things it is about, and the passages it was
 * cut into.
 *
 * Fetched when it is opened rather than with the page. Passage text is the biggest thing in
 * the database, and a knowledge base of thirty files would ship all of it to render a list
 * nobody has expanded.
 */
function Indexed({ documentId, onView }: { documentId: number; onView: () => void }) {
  const fetchIndexed = useServerFn(indexed)
  const [data, setData] = useState<Awaited<ReturnType<typeof indexed>> | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    let live = true
    fetchIndexed({ data: documentId })
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [documentId, fetchIndexed])

  if (err)
    return (
      <p className="err" style={{ marginTop: 14 }} role="alert">
        {err}
      </p>
    )
  if (!data) return <p className="note" style={{ marginTop: 14 }}>Loading…</p>

  return (
    <div style={{ marginTop: 14 }}>
      <h3>Passages</h3>
      {data.passages.length === 0 ? (
        <p className="note" style={{ marginTop: 0 }}>
          Nothing here can be retrieved — try Reindex.
        </p>
      ) : (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            {data.passages.length} passage(s) · {data.passages.filter((p) => p.embedded).length} with a vector ·{' '}
            <button className="linky" onClick={onView}>
              read and correct them
            </button>
          </p>
          <table>
            <thead>
              <tr>
                <th style={{ width: 60 }}>#</th>
                <th>Starts</th>
                <th className="num">Characters</th>
                <th>Searchable by</th>
              </tr>
            </thead>
            <tbody>
              {/* Any row opens the sheet. The natural thing to do with a passage that reads
                  wrongly is to look at it, and the next thing is to fix it. */}
              {data.passages.map((p) => (
                <tr key={p.id} className="click" onClick={onView} title="Read it in full, and correct it">
                  <td className="note">{p.ord + 1}</td>
                  <td>{p.text.slice(0, 120).replace(/\s+/g, ' ')}…</td>
                  <td className="num">{p.text.length}</td>
                  <td className="note">{p.embedded ? 'meaning' : 'keyword only'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- one document

function DocRow({
  doc,
  busy,
  onView,
  run,
  showUri = false,
}: {
  doc: Doc
  busy: string
  onView: (d: Viewable) => void
  run: Runner
  showUri?: boolean
}) {
  const dropFn = useServerFn(drop)
  const rebuildFn = useServerFn(rebuild)

  return (
    <tr>
      <td>
        <button className="linky" onClick={() => onView(doc)} title="Show the passages this was cut into">
          {doc.title}
        </button>
        {showUri && (
          <div className="note" style={{ overflowWrap: 'anywhere' }}>
            {doc.uri}
          </div>
        )}
        {/* Which page, not merely that one of them was. The site row says how many. */}
        {doc.edited_at && (
          <div className="note warn">edited by hand — no longer what the page says</div>
        )}
      </td>
      <td className="num">{doc.chunks}</td>
      <td className="note">{new Date(doc.updated_at).toLocaleString()}</td>
      <td>
        <div className="row">
          <button
            className="ghost small"
            disabled={!!busy}
            title="Re-chunk and re-embed from the stored text"
            onClick={() => run(`re-${doc.id}`, () => rebuildFn({ data: doc.id }))}
          >
            Reindex
          </button>
          <button className="ghost small" disabled={!!busy} onClick={() => run(`rm-${doc.id}`, () => dropFn({ data: doc.id }))}>
            Remove
          </button>
        </div>
      </td>
    </tr>
  )
}

/**
 * What one document was actually indexed as.
 *
 * A native `<dialog>`: it brings the backdrop, the focus trap and Escape-to-close with it,
 * all of which would otherwise be a few dozen lines of listeners to get subtly wrong.
 */
function PassagesModal({ doc, onClose }: { doc: Viewable; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const router = useRouter()
  const fetchIndexed = useServerFn(indexed)
  const fetchText = useServerFn(fullText)
  const saveFn = useServerFn(saveDocText)
  const cutFn = useServerFn(dropPassage)

  const [rows, setRows] = useState<Awaited<ReturnType<typeof indexed>>['passages'] | null>(null)
  const [source, setSource] = useState<Awaited<ReturnType<typeof fullText>> | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')
  const [err, setErr] = useState('')
  /** Which passage is being removed, so only its own button says so. */
  const [cutting, setCutting] = useState(0)

  const load = () => {
    Promise.all([fetchIndexed({ data: doc.id }), fetchText({ data: doc.id })])
      .then(([i, t]) => {
        setRows(i.passages)
        setSource(t)
        setDraft(t.text)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    ref.current?.showModal()
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])

  const dirty = source !== null && draft !== source.text

  const save = async () => {
    setSaving(true)
    setErr('')
    setSaved('')
    const r = await saveFn({ data: { id: doc.id, text: draft } })
    setSaving(false)
    if (!r.ok) return setErr(r.error)
    setSaved(`Saved — cut into ${r.chunks} passage(s).`)
    // Re-read both halves: the passages are rebuilt from what was just saved, so showing
    // the old ones beside the new text would be showing two different documents.
    setRows(null)
    load()
    // And the counts on the page behind this one moved too.
    await router.invalidate()
  }

  return (
    <dialog ref={ref} className="sheet" onClick={lightDismiss} onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 17 }}>{doc.title}</h3>
          <p className="note" style={{ margin: 0, overflowWrap: 'anywhere' }}>
            {doc.uri ?? 'uploaded file'}
          </p>
        </div>
        {/* A form with method=dialog closes it natively, so this needs no handler. */}
        <form method="dialog">
          <button className="ghost small">Close</button>
        </form>
      </div>

      {err && (
        <p className="err" style={{ marginTop: 14 }} role="alert">
          {err}
        </p>
      )}
      {saved && <p className="pill ok" style={{ marginTop: 14 }}>{saved}</p>}

      {source === null ? (
        <p className="note" style={{ marginTop: 16 }}>
          Loading…
        </p>
      ) : (
        <>
          <h3 style={{ marginTop: 18 }}>Extracted text</h3>
          <p className="note" style={{ marginTop: 0 }}>
            Everything Arlo read out of this, and the thing to correct when it read something wrong. Saving
            cuts it into passages again, so what you fix here is what gets quoted.
          </p>
          {/*
            A crawled page is refilled from the site, so an edit to one is temporary. Said
            plainly rather than prevented: correcting a page to answer a question today is
            reasonable, and losing the correction without warning is not.
          */}
          {source.fromCrawl && (
            <p className="warn" style={{ marginBottom: 8 }}>
              This page came from a crawl. Crawling the site again replaces this text with whatever the page
              says then.
            </p>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck
            style={{ minHeight: 280, fontSize: 14, lineHeight: 1.55 }}
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" disabled={!dirty || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save and reindex'}
            </button>
            <button className="ghost" disabled={!dirty || saving} onClick={() => setDraft(source.text)}>
              Undo changes
            </button>
            <span className="note">
              {draft.length.toLocaleString()} characters{dirty && ' · unsaved'}
            </span>
          </div>

          <h3 style={{ marginTop: 26 }}>Passages</h3>
          {rows === null ? (
            <p className="note" style={{ marginTop: 0 }}>
              Loading…
            </p>
          ) : rows.length === 0 ? (
            <p className="note" style={{ marginTop: 0 }}>
              No passages. Nothing here can be retrieved — try Reindex.
            </p>
          ) : (
            <>
              <p className="note" style={{ marginTop: 0 }}>
                {rows.length} passage(s) · {rows.filter((r) => r.embedded).length} with a vector. This is what
                retrieval searches, and it is rebuilt from the text above. Removing one cuts it out of
                that text, so it survives a reindex — but a fresh crawl of the page would bring it back.
              </p>
              <ol className="passages">
                {rows.map((p) => (
                  <li key={p.id}>
                    <div className="row">
                      <span className="note">
                        #{p.ord + 1} · {p.text.length} characters ·{' '}
                        {p.embedded ? 'searchable by meaning' : 'keyword only'}
                      </span>
                      <span className="grow" />
                      <button
                        className="linkish"
                        disabled={!!cutting || saving || dirty}
                        title={
                          dirty
                            ? 'Save or undo your edits first — they are changes to the same text'
                            : 'Cut this passage out of the document'
                        }
                        onClick={() => {
                          // Said precisely, because "stays gone" was true of a reindex and not of
                          // a crawl, and somebody relying on the shorter promise would lose the edit.
                          if (
                            !confirm(
                              'Remove this passage? It is cut from the document text, so it survives a reindex — but crawling this page again would bring it back.',
                            )
                          )
                            return
                          setCutting(p.id)
                          setErr('')
                          cutFn({ data: p.id })
                            .then(() => {
                              setRows(null)
                              load()
                              return router.invalidate()
                            })
                            .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                            .finally(() => setCutting(0))
                        }}
                      >
                        {cutting === p.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                    <p>{p.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </dialog>
  )
}
