import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as bots from '../server/bot'
import { options } from '../server/botform'
import * as resources from '../server/resources'
import { SECTIONS, Section, Steps, emptyDraft } from '../components/BotSections'
import type { Draft, SectionId } from '../components/BotSections'

const load = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await requireSession()
  return { options: await options(s.workspaceId), existing: (await bots.list(s.workspaceId)).length }
})

const create = createServerFn({ method: 'POST' })
  .validator((d: bots.Patch) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const bot = await bots.create(s.workspaceId, data)
    return { id: bot.id }
  })


/**
 * Adding a resource is a workspace action, not part of a bot.
 *
 * FormData because a file may be 25MB, and a JSON body would mean base64 — a third bigger
 * on the wire and held twice in memory for no gain.
 */
const addResource = createServerFn({ method: 'POST' })
  .validator((d: FormData) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const description = String(data.get('description') ?? '')
    if (data.get('kind') === 'link') {
      await resources.addLink(s.workspaceId, String(data.get('url') ?? ''), String(data.get('title') ?? ''), description)
      return
    }
    const file = data.get('file')
    if (!(file instanceof File)) throw new Error('No file was attached')
    if (file.size > resources.MAX_BYTES)
      throw new Error(file.name + " is over the " + resources.MAX_BYTES / 1048576 + "MB limit")
    await resources.addFile(
      s.workspaceId,
      { name: file.name, mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) },
      description,
    )
  })

/** Renaming one is a workspace action too, so it saves the moment it is confirmed. */
const renameResource = createServerFn({ method: 'POST' })
  .validator((d: { id: number; title: string; description: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await resources.rename(s.workspaceId, data.id, data.title, data.description)
  })

/**
 * Delete a resource outright.
 *
 * Workspace-wide and not undoable: every bot loses it, the bytes go, and a file's public
 * address stops resolving — which is the only way to revoke one, since it is already in
 * messages sent to people we cannot reach.
 */
const deleteResource = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await resources.remove(s.workspaceId, data)
  })

/**
 * Re-read the page after a mutation, and never let that failure be mistaken for the
 * mutation's.
 *
 * The two are separate: the server has already confirmed the change by the time this runs.
 * A dropped connection here means the list on screen is stale, not that the file survived —
 * and reporting it as "could not delete" is how somebody ends up pressing a destructive
 * button a second time to fix a problem that does not exist.
 */
const refresh = async (router: { invalidate: () => Promise<unknown> }) => {
  try {
    await router.invalidate()
  } catch {
    // Stale, not failed. The next navigation or reload picks it up.
  }
}

export const Route = createFileRoute('/chatbot/new')({ loader: () => load(), component: NewBot })

/** The shared sections, plus a last step that shows what is about to be created. */
const REVIEW = { id: 'review', label: 'Review', hint: 'Check it over and create' }

function NewBot() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const createFn = useServerFn(create)
  const addResourceFn = useServerFn(addResource)
  const renameResourceFn = useServerFn(renameResource)
  const deleteResourceFn = useServerFn(deleteResource)

  const [draft, setDraft] = useState<Draft>(() => emptyDraft(data.options))
  const [step, setStep] = useState<string>('identity')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  const order = [...SECTIONS.map((s) => s.id as string), REVIEW.id]
  const at = order.indexOf(step)
  // Uploading adds to the workspace, so the loader has to be re-read to show it.
  const add = async (body: FormData) => {
    await addResourceFn({ data: body })
    await refresh(router)
  }

  const go = (delta: number) => setStep(order[Math.min(order.length - 1, Math.max(0, at + delta))])

  const submit = async () => {
    if (!draft.name.trim()) {
      // The one required field, and the only thing that blocks. Everything else has a
      // sensible default, which is why the steps are all reachable from the start.
      setErr('Give it a name first.')
      setStep('identity')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const { id } = await createFn({
        data: {
          ...draft,
          model: draft.model.trim() || null,
        },
      })
      await router.invalidate()
      router.navigate({ to: '/chatbot/$id', params: { id: String(id) }, search: { tab: 'identity' } })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <Link to="/chatbots" className="backlink">← Chatbots</Link>
      <h1>New chatbot</h1>
      <p className="lede">
        Six short steps, in any order. Everything is filled in with a sensible starting point, and nothing is created until the last step — so you can move around freely.
      </p>

      <Steps current={step} onPick={setStep} extra={[REVIEW]} />

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      <div className="card sectioncard">
        {step === 'review' ? (
          <Review draft={draft} options={data.options} first={data.existing === 0} />
        ) : (
          <Section
            section={step as SectionId}
            draft={draft}
            set={set}
            options={{
              ...data.options,
              onAddResource: add,
              onDeleteResource: async (id) => {
                await deleteResourceFn({ data: id })
                await refresh(router)
              },
              onRenameResource: async (patch) => {
                await renameResourceFn({ data: patch })
                await refresh(router)
              },
            }}
          />
        )}
      </div>

      <div className="row wizardfoot">
        <button className="ghost" disabled={at === 0 || busy} onClick={() => go(-1)}>
          Back
        </button>
        {step === 'review' ? (
          <button className="primary" disabled={busy} onClick={submit}>
            {busy ? 'Creating…' : 'Create chatbot'}
          </button>
        ) : (
          <button onClick={() => go(1)}>Next</button>
        )}
        <span className="note">
          Step {at + 1} of {order.length}
        </span>
      </div>
    </>
  )
}

/** What is about to exist, in the words the gallery will use for it. */
function Review({
  draft,
  options,
  first,
}: {
  draft: Draft
  options: Awaited<ReturnType<typeof load>>['options']
  first: boolean
}) {
  const picked = options.connections.filter((c) =>
    draft.connections.some((x) => x.channel === c.channel && x.connection_ref === c.ref),
  )
  const sources = options.bases.filter((b) => draft.baseIds.includes(b.id))

  return (
    <dl className="review">
      <div>
        <dt>Name</dt>
        <dd>{draft.name.trim() || <span className="note">not set — required</span>}</dd>
      </div>
      <div>
        <dt>Description</dt>
        <dd>{draft.description.trim() || <span className="note">none</span>}</dd>
      </div>
      <div>
        <dt>Knows</dt>
        <dd>
          {sources.length === 0 ? (
            <span className="note">nothing ticked — it will hand off every question</span>
          ) : (
            sources.map((b) => b.name).join(', ')
          )}
        </dd>
      </div>
      <div>
        <dt>Can send</dt>
        <dd>
          {draft.resourceIds.length ? (
            options.resources
              .filter((r) => draft.resourceIds.includes(r.id))
              .map((r) => r.title)
              .join(', ')
          ) : (
            <span className="note">nothing</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Answers on</dt>
        <dd>
          {picked.length ? (
            picked.map((c) => c.label).join(', ')
          ) : first ? (
            <span className="note">nothing picked — it will not answer anywhere yet</span>
          ) : (
            <span className="note">nothing picked — it will not answer anywhere</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Tools</dt>
        <dd>{draft.tools.length ? draft.tools.join(", ") : <span className="note">none</span>}</dd>
      </div>
      <div>
        <dt>Hands off below</dt>
        <dd>{draft.confidence_floor.toFixed(2)} confidence</dd>
      </div>
      <div>
        <dt>Knowledge base only</dt>
        <dd>{draft.strict_kb ? 'Yes' : 'No — may answer from general knowledge'}</dd>
      </div>
      <div>
        <dt>Model</dt>
        <dd className="mono">{draft.model.trim() || 'server default'}</dd>
      </div>
    </dl>
  )
}
