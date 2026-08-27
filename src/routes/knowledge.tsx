import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as bases from '../server/bases'
import { configured } from '../server/embed'
import { lightDismiss } from '../components/Modal'

/**
 * The knowledge bases in a workspace.
 *
 * A base is one body of knowledge with one audience — the public help centre, the internal
 * handbook, last year's catalogue — and a chatbot is connected to whole bases rather than
 * to the sources inside them. That is the point of splitting them up: a bot answering
 * customers and one answering staff should not be reading the same pile, and until now
 * there was only one pile to read.
 */
const load = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await requireSession()
  // `first` makes one if the workspace somehow has none, so this page always has somewhere
  // to send you rather than an empty state that is really a broken state.
  await bases.first(s.workspaceId)
  return { bases: await bases.list(s.workspaceId), embeddings: configured() }
})

const create = createServerFn({ method: 'POST' })
  .validator((d: { name: string; description: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    try {
      const made = await bases.create(s.workspaceId, data.name, data.description)
      return { ok: true as const, id: made.id }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

const drop = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    try {
      await bases.remove(s.workspaceId, data)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

export const Route = createFileRoute('/knowledge')({ loader: () => load(), component: Bases })

function Bases() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const createFn = useServerFn(create)
  const dropFn = useServerFn(drop)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    setBusy(true)
    setErr('')
    const r = await createFn({ data: { name, description } })
    setBusy(false)
    if (!r.ok) return setErr(r.error)
    setAdding(false)
    setName('')
    setDescription('')
    await router.invalidate()
    // Straight into it: somebody who just made a knowledge base is about to fill it.
    router.navigate({ to: '/knowledge/$id', params: { id: String(r.id) } })
  }

  const remove = async (id: number, label: string) => {
    if (!confirm(`Remove "${label}" and every source in it? This cannot be undone.`)) return
    const r = await dropFn({ data: id })
    if (!r.ok) setErr(r.error)
    await router.invalidate()
  }

  return (
    <>
      <div className="pagehead">
        <div className="titles">
          <h1>Knowledge</h1>
          <p className="lede">
            What Arlo is allowed to answer from. A base is one body of knowledge; a chatbot is connected to
            whole bases, so anything added to one is reachable without reconfiguring the bot.
          </p>
        </div>
        <div className="actions">
          <button className="primary" onClick={() => setAdding(true)}>
            New knowledge base
          </button>
        </div>
      </div>

      {!data.embeddings && (
        <p className="note" style={{ marginBottom: 20 }}>
          No embeddings key configured — everything here is searched by keyword rather than by meaning.
        </p>
      )}

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      <div className="cards">
        {data.bases.map((b) => (
          <div key={b.id} className="card basecard">
            <Link to="/knowledge/$id" params={{ id: String(b.id) }} className="baselink">
              {b.name}
            </Link>
            <p className="note desc">{b.description || 'No description.'}</p>

            <div className="row counts">
              <span>
                <strong>{b.documents}</strong> document{b.documents === 1 ? '' : 's'}
              </span>
              <span>
                <strong>{b.passages}</strong> passage{b.passages === 1 ? '' : 's'}
              </span>
            </div>
            <p className="note" style={{ margin: 0 }}>
              {b.sites} site{b.sites === 1 ? '' : 's'} · {b.files} file{b.files === 1 ? '' : 's'}
              {/* The same signal the detail page shows: something in here is still filling. */}
              {b.busy && (
                <span className="pill warn" style={{ marginLeft: 8 }}>
                  working
                </span>
              )}
            </p>

            <div className="row" style={{ marginTop: 16 }}>
              <Link className="button small" to="/knowledge/$id" params={{ id: String(b.id) }}>
                Open
              </Link>
              {/*
                Removing the last one is refused by the server anyway — there has to be
                somewhere for the next thing somebody adds to go — so the button is not
                offered when it would only produce an error.
              */}
              {data.bases.length > 1 && (
                <button className="ghost small" onClick={() => remove(b.id, b.name)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Native <dialog>: the backdrop, the focus trap and Escape-to-close come with it. */}
      {adding && (
        <dialog className="sheet narrow" ref={(el) => el?.showModal()} onClick={lightDismiss} onClose={() => setAdding(false)}>
          <h3 style={{ fontSize: 17 }}>New knowledge base</h3>
          <p className="note" style={{ marginTop: 0 }}>
            One body of knowledge, for one audience. Sources go into it, and chatbots are connected to it as
            a whole.
          </p>

          <div className="field" style={{ marginTop: 16 }}>
            <label htmlFor="kb-name">Name</label>
            <input
              id="kb-name"
              autoFocus
              value={name}
              placeholder="Internal handbook"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()}
            />
          </div>
          <div className="field">
            <label htmlFor="kb-desc">What is in it</label>
            <input
              id="kb-desc"
              value={description}
              placeholder="Policies and process for the team — not for customers"
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="note">Optional, and worth a sentence once there is more than one of these.</p>
          </div>

          <div className="row" style={{ marginTop: 18 }}>
            <button className="primary" disabled={!name.trim() || busy} onClick={submit}>
              {busy ? 'Creating…' : 'Create'}
            </button>
            <form method="dialog">
              <button className="ghost">Cancel</button>
            </form>
          </div>
        </dialog>
      )}
    </>
  )
}
