import { useRef, useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as attachments from '../server/attachments'
import * as resources from '../server/resources'
import { list as uploadList } from '../server/uploads'
import { Peek, lightDismiss } from '../components/Modal'
import { Pager } from '../components/Pager'
import { MAX_RESOURCE_MB } from '../types'

/**
 * Every file this workspace holds, wherever it came from.
 *
 * Three stores, three tabs, and deliberately no "All". `resources`, `uploads` and `attachments`
 * agree on almost no column — one is gzipped, one is content-addressed in a bucket, one has a
 * public address and the others do not — so a union would buy a single list whose every action
 * is a switch on which table the row came from.
 *
 * ---------------------------------------------------------------- one card per file, not per row
 *
 * The Conversations tab groups on content. A brochure sent to two hundred and forty people is
 * two hundred and forty `attachments` rows and **one stored object**: the ingest path matches on
 * sha256 and points every arrival at the same key, which is what migration 069 was for. Listing
 * the rows showed the same file two hundred and forty times and implied a storage problem that
 * does not exist. One card, with how many threads it reached, is the same information without
 * the implication.
 */
const PAGE = 48

const load = createServerFn({ method: 'GET' })
  .validator((page: number) => page)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const [library, knowledge, chat] = await Promise.all([
      resources.list(s.workspaceId),
      uploadList(s.workspaceId),
      attachments.inConversations(s.workspaceId, { page: data, size: PAGE }),
    ])
    return { library, knowledge, chat }
  })

/**
 * Put a file in the library from this device.
 *
 * FormData because a file may be 25MB, and a JSON body would mean base64 — a third bigger on
 * the wire and held twice in memory for no gain. The same shape the chatbot editor uses.
 */
const upload = createServerFn({ method: 'POST' })
  .validator((d: FormData) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const file = data.get('file')
    if (!(file instanceof File)) throw new Error('No file was attached')
    if (file.size > resources.MAX_BYTES)
      throw new Error(`${file.name} is over the ${resources.MAX_BYTES / 1048576}MB limit`)
    await resources.addFile(
      s.workspaceId,
      { name: file.name, mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) },
      String(data.get('description') ?? ''),
      'upload',
    )
  })

/** Give a conversation file a public address. The only write here that changes who can see something. */
const share = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    try {
      await resources.shareAttachment(s.workspaceId, data)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

const tidy = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    return { removed: await attachments.tidyDuplicates(s.workspaceId, data) }
  })

const drop = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await resources.remove(s.workspaceId, data)
  })

export const Route = createFileRoute('/media')({
  // The default tab is the absent param, so a bare /media is the address people share.
  validateSearch: (q: Record<string, unknown>): { tab?: 'chat' | 'knowledge'; page?: number } => ({
    tab: q.tab === 'chat' || q.tab === 'knowledge' ? q.tab : undefined,
    page: typeof q.page === 'number' && q.page > 1 ? q.page : undefined,
  }),
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: ({ deps }) => load({ data: deps.page - 1 }),
  component: Media,
})

type Data = Awaited<ReturnType<typeof load>>
type Shown = { title: string; href: string; mime: string | null }

const when = (iso: string) => new Date(iso).toLocaleDateString()

/** Duplicated verbatim in three other files; not worth a shared module for one expression. */
const size = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} bytes`

/** Four mono characters, the same badge the file picker uses. */
const kindOf = (name: string, mime: string | null) =>
  (name.split('.').pop() ?? mime?.split('/').pop() ?? 'file').slice(0, 4).toLowerCase()

/**
 * The allowlist `api.resource.$token.ts` serves inline, not `image/*`.
 *
 * An SVG is served as a download there — deliberately, since it is a script that draws — and
 * pointing an `img` at a download gets you an empty box rather than a picture.
 */
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/

/**
 * The picture for a card, or null for the badge.
 *
 * An image is its own thumbnail, which is the rule the inbox already follows for a file in a
 * bubble. Nothing is generated for one, so it draws immediately — no poller, no backfill, and
 * it works on a deployment with no Storage at all, where `byToken` reads the bytes column.
 *
 * Everything else waits for the sweep to say there is something worth drawing. A link gets
 * nothing: photographing somebody else's site is a different feature with its own fetch,
 * its own cache and its own failure modes.
 */
const thumbOf = (r: { kind: string; mime: string | null; token: string; thumb?: boolean }) =>
  r.kind !== 'file' ? null
  : INLINE_IMAGE.test(r.mime ?? '') ? `/api/resource/${r.token}`
  : r.thumb ? `/api/thumb/${r.token}`
  : null

function Media() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tab = search.tab ?? 'library'

  const [peek, setPeek] = useState<Shown | null>(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)

  const go = (next: 'library' | 'chat' | 'knowledge') =>
    // Flipping between tabs is not a place to go back to.
    void navigate({ search: next === 'library' ? {} : { tab: next }, replace: true })

  const done = () => void router.invalidate()

  return (
    <>
      <div className="pagehead">
        <div className="titles">
          <h1>Media</h1>
          <p className="lede">
            Every file this workspace holds — what a bot or a broadcast can send, what the knowledge bases
            were built from, and what has passed through conversations.
          </p>
        </div>
        <div className="actions">
          <button onClick={() => setAdding(true)}>Upload media</button>
        </div>
      </div>

      <div className="seg tabstrip" role="tablist" aria-label="Which files">
        <button role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'on' : ''} onClick={() => go('library')}>
          Library ({data.library.length})
        </button>
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => go('chat')}>
          Conversations ({data.chat.total})
        </button>
        <button role="tab" aria-selected={tab === 'knowledge'} className={tab === 'knowledge' ? 'on' : ''} onClick={() => go('knowledge')}>
          Knowledge ({data.knowledge.length})
        </button>
      </div>

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      {tab === 'library' && <Library data={data} onPeek={setPeek} onErr={setErr} onDone={done} />}
      {tab === 'chat' && <Conversations data={data} onPeek={setPeek} onErr={setErr} onDone={done} />}
      {tab === 'knowledge' && <Knowledge data={data} onPeek={setPeek} />}

      {peek && <Peek at={peek} onClose={() => setPeek(null)} />}
      {adding && (
        <UploadSheet
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false)
            go('library')
            done()
          }}
          onErr={setErr}
        />
      )}
    </>
  )
}

/** The card shell every tab uses, so three lists read as one page. */
function FileCard({
  name,
  mime,
  preview,
  children,
  actions,
}: {
  name: string
  mime: string | null
  preview?: string | null
  children: React.ReactNode
  actions: React.ReactNode
}) {
  /*
   * A preview that will not load falls back to the badge, rather than to the browser's broken
   * -image glyph, which reads as a bug in the page. Covers both ways it happens: a 404 from an
   * object that has gone, and a picture the browser will not decode.
   */
  const [broken, setBroken] = useState(false)

  return (
    <div className="card">
      <div className="row" style={{ gap: 10, alignItems: 'flex-start', marginTop: 0 }}>
        {/*
          The picture goes in the badge's own slot rather than wrapping both in a container,
          because `.card > .row > .mark` is a direct-child selector — nesting it one deeper
          silently unstyles the badge on every card that has no preview.
        */}
        {preview && !broken ? (
          // alt is empty on purpose: the filename is the very next element, and reading it
          // twice is noise to anybody listening rather than looking.
          <img
            className="thumb"
            src={preview}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="mark">{kindOf(name, mime)}</span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{name}</strong>
          {children}
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>{actions}</div>
    </div>
  )
}

// ---------------------------------------------------------------- what can be sent

/** Where a library file came from. Null on everything older than the column. */
const CAME_FROM: Record<string, string> = {
  upload: 'uploaded here',
  lesson: 'approved in training',
  chat: 'shared from a conversation',
}

function Library({
  data,
  onPeek,
  onErr,
  onDone,
}: {
  data: Data
  onPeek: (s: Shown) => void
  onErr: (s: string) => void
  onDone: () => void
}) {
  const remove = useServerFn(drop)
  const [busy, setBusy] = useState(0)

  if (!data.library.length)
    return (
      <div className="card">
        <p className="note" style={{ margin: 0 }}>
          Nothing here yet. Press Upload media, or share a file out of a conversation — a library file is
          one a chatbot or a broadcast can actually send.
        </p>
      </div>
    )

  return (
    <>
      <p className="note">
        Anything here has a public address — the link is what gets forwarded, so it works for somebody who
        has never signed in. Deleting a file is the only way to take that back.
      </p>
      <div className="cards">
        {data.library.map((r) => (
          <FileCard
            key={r.id}
            name={r.title}
            mime={r.mime}
            preview={thumbOf(r)}
            actions={
              <>
                {/*
                  A file we hold opens here; a link goes to its own tab. The same split the
                  attachment chips make, and for the same reason — we can draw a brochure and
                  we cannot draw somebody else's website.

                  Gated on having somewhere to go, so a link row with no address does not
                  render a button that does nothing.
                */}
                {(r.kind === 'file' || r.url) && (
                  <button
                    className="ghost small"
                    onClick={() =>
                      r.kind === 'file'
                        ? onPeek({ title: r.title, href: `/api/resource/${r.token}`, mime: r.mime })
                        : window.open(r.url!, '_blank', 'noopener')
                    }
                  >
                    Open
                  </button>
                )}
                <span className="grow" />
                <button
                  className="ghost small bad"
                  disabled={busy === r.id}
                  onClick={async () => {
                    setBusy(r.id)
                    onErr('')
                    try {
                      await remove({ data: r.id })
                      onDone()
                    } catch (e) {
                      onErr(e instanceof Error ? e.message : String(e))
                    } finally {
                      setBusy(0)
                    }
                  }}
                >
                  Delete
                </button>
              </>
            }
          >
            <span className="note" style={{ display: 'block' }}>
              {r.kind === 'link'
                ? 'a link'
                : `${size(r.size_bytes)} · ${CAME_FROM[r.source ?? ''] ?? 'added before this was recorded'}`}
            </span>
            <span className="note" style={{ display: 'block' }}>
              {r.bots ? `${r.bots} chatbot${r.bots === 1 ? '' : 's'} can send it` : 'no chatbot sends it'} ·{' '}
              {when(r.created_at)}
            </span>
          </FileCard>
        ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- what went through a thread

function Conversations({
  data,
  onPeek,
  onErr,
  onDone,
}: {
  data: Data
  onPeek: (s: Shown) => void
  onErr: (s: string) => void
  onDone: () => void
}) {
  const make = useServerFn(share)
  const clean = useServerFn(tidy)
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [asking, setAsking] = useState<attachments.InConversation | null>(null)
  const [busy, setBusy] = useState(0)

  const { rows, total } = data.chat
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const at = Math.min(Math.max(0, (search.page ?? 1) - 1), pages - 1)
  const redundant = rows.reduce((n, r) => n + r.redundant, 0)

  if (!total)
    return (
      <div className="card">
        <p className="note" style={{ margin: 0 }}>
          No files have been sent or received in a conversation yet.
        </p>
      </div>
    )

  return (
    <>
      <p className="note">
        One card per file, however many times it was sent. These stay private — only somebody signed in to
        this workspace can open one, and sharing is what gives a file a public address.
      </p>
      {/*
        Said once, at the top, because it is the thing the old row-per-message list got wrong: the
        same brochure appearing hundreds of times looked like hundreds of copies.
      */}
      {!!redundant && (
        <p className="warn">
          {redundant} {redundant === 1 ? 'row records' : 'rows record'} a file twice against the same
          message. Those are the only duplicates worth removing — everything else is a real send.
        </p>
      )}

      <div className="cards">
        {rows.map((a) => (
          <FileCard
            key={a.id}
            name={a.name}
            mime={a.mime}
            actions={
              <>
                {a.held && (
                  <button
                    className="ghost small"
                    onClick={() => onPeek({ title: a.name, href: `/api/attachment/${a.id}`, mime: a.mime })}
                  >
                    Open
                  </button>
                )}
                {a.held && !a.from_library && (
                  <button className="ghost small" onClick={() => setAsking(a)}>
                    Share
                  </button>
                )}
                {!!a.redundant && (
                  <button
                    className="ghost small bad"
                    disabled={busy === a.id}
                    onClick={async () => {
                      setBusy(a.id)
                      onErr('')
                      try {
                        await clean({ data: a.id })
                        onDone()
                      } catch (e) {
                        onErr(e instanceof Error ? e.message : String(e))
                      } finally {
                        setBusy(0)
                      }
                    }}
                  >
                    Remove {a.redundant} duplicate
                  </button>
                )}
              </>
            }
          >
            <span className="note" style={{ display: 'block' }}>
              {size(a.size_bytes)}
              {' · '}
              {a.copies === 1
                ? 'once'
                : `sent ${a.copies} times across ${a.conversations} ${a.conversations === 1 ? 'thread' : 'threads'}`}
              {!a.held && ' · not kept, past the 30-day window'}
            </span>
            <span className="note" style={{ display: 'block' }}>
              {[
                a.from_customer && 'received',
                a.from_bot && 'sent by Arlo',
                a.from_team && 'sent by you',
                a.from_library && 'from the library',
              ]
                .filter(Boolean)
                .join(' · ')}
              {' · '}
              {when(a.last_seen)}
            </span>
            {a.conversation_id && (
              <Link to="/inbox" search={{ id: a.conversation_id }} className="note">
                {a.customer ?? 'open the conversation'}
              </Link>
            )}
          </FileCard>
        ))}
      </div>

      <Pager
        at={at}
        pages={pages}
        setPage={(n) => void navigate({ search: (p) => ({ ...p, page: n > 0 ? n + 1 : undefined }) })}
      />

      {asking && (
        <dialog className="sheet narrow" ref={(el) => el?.showModal()} onClick={lightDismiss} onClose={() => setAsking(null)}>
          <h3 style={{ marginTop: 0 }}>Share “{asking.name}”?</h3>
          <div className="tip" style={{ marginTop: 0 }}>
            <strong>It gets an address anyone can open</strong>
            <p>
              Sharing adds it to the library so a chatbot or a broadcast can send it. That means a link that
              works without signing in — because the link ends up inside a message somebody may forward.
            </p>
            <p className="note">
              Deleting it from the library is the only way to take that back. It stays in this conversation
              either way, and once the library holds it, it is no longer cleared after 30 days.
            </p>
          </div>
          <div className="sheetfoot row">
            <button
              disabled={busy === asking.id}
              onClick={async () => {
                setBusy(asking.id)
                onErr('')
                const got = await make({ data: asking.id })
                setBusy(0)
                setAsking(null)
                if (!got.ok) return onErr(got.error)
                onDone()
              }}
            >
              {busy === asking.id ? 'Sharing…' : 'Share it'}
            </button>
            <button className="ghost" onClick={() => setAsking(null)}>
              Keep it private
            </button>
          </div>
        </dialog>
      )}
    </>
  )
}

// ---------------------------------------------------------------- what the bases were built from

function Knowledge({ data, onPeek }: { data: Data; onPeek: (s: Shown) => void }) {
  if (!data.knowledge.length)
    return (
      <div className="card">
        <p className="note" style={{ margin: 0 }}>
          Nothing uploaded to a knowledge base yet. <Link to="/knowledge">Knowledge</Link> is where one goes.
        </p>
      </div>
    )

  return (
    <>
      <p className="note">
        Source material the bases were built from. These are read to answer questions, not sent — the
        download is for you, not for a customer.
      </p>
      <div className="cards">
        {data.knowledge.map((u) => {
          /*
           * `size_bytes = 0` is not an empty file, it is a row adopted by a migration with no
           * original behind it — `uploads.open()` answers 404 for those. Shown the same way a
           * swept attachment is, so the page never offers a download that cannot work.
           */
          const kept = u.size_bytes > 0
          return (
            <FileCard
              key={u.id}
              name={u.filename}
              mime={u.mime}
              actions={
                kept ? (
                  <button
                    className="ghost small"
                    onClick={() => onPeek({ title: u.filename, href: `/api/upload/${u.id}`, mime: u.mime })}
                  >
                    Open
                  </button>
                ) : null
              }
            >
              <span className="note" style={{ display: 'block' }}>
                {kept ? size(u.size_bytes) : 'not kept — indexed before the original was stored'} ·{' '}
                {u.chunks} passage{u.chunks === 1 ? '' : 's'}
              </span>
              <span className="note" style={{ display: 'block' }}>
                <span className={`pill${u.status === 'failed' ? ' bad' : u.status === 'ready' ? ' ok' : ''}`}>
                  {u.status}
                </span>{' '}
                {when(u.created_at)}
              </span>
            </FileCard>
          )
        })}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- putting one here

function UploadSheet({
  onClose,
  onDone,
  onErr,
}: {
  onClose: () => void
  onDone: () => void
  onErr: (s: string) => void
}) {
  const send = useServerFn(upload)
  const picker = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!file) return
    setBusy(true)
    onErr('')
    try {
      const body = new FormData()
      body.set('file', file)
      body.set('description', description)
      await send({ data: body })
      onDone()
    } catch (e) {
      onErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog className="sheet narrow" ref={(el) => el?.showModal()} onClick={lightDismiss} onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>Upload media</h3>
      <p className="note">
        It goes into the library, so a chatbot or a WhatsApp broadcast can send it. Up to {MAX_RESOURCE_MB}MB.
      </p>

      <div className="addresource">
        <input
          ref={picker}
          type="file"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null
            // Otherwise picking the same file again fires no change event.
            e.target.value = ''
            if (picked && picked.size > MAX_RESOURCE_MB * 1048576)
              return onErr(`${picked.name} is over the ${MAX_RESOURCE_MB}MB limit`)
            setFile(picked)
          }}
        />
        {file && (
          <p className="note" style={{ marginBottom: 0 }}>
            {file.name} · {size(file.size)}
          </p>
        )}
        <label className="field">
          <span className="note">What it is (optional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="So a chatbot knows when to send it"
          />
        </label>
      </div>

      <div className="sheetfoot row">
        <button disabled={!file || busy} onClick={submit}>
          {busy ? 'Uploading…' : 'Add to library'}
        </button>
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  )
}
