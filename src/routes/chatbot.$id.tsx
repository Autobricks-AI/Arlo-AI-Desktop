import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { NotFound } from '../components/NotFound'
import { requireSession } from '../server/auth'
import * as bots from '../server/bot'
import { options } from '../server/botform'
import * as lessons from '../server/lessons'
import * as resources from '../server/resources'
import * as catalogue from '../server/catalogue'
import { SECTIONS, Section, Steps } from '../components/BotSections'
import type { Draft, SectionId } from '../components/BotSections'
import { BOT_MODES } from '../types'
import type { BotMode } from '../types'

const load = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const bot = await bots.get(s.workspaceId, data)
    if (!bot) return null
    return {
      bot,
      baseIds: (await bots.connectedBases(s.workspaceId, data)).map((r) => r.base_id),
      calendarIds: (await bots.connectedCalendars(s.workspaceId, data)).map((r) => r.calendar_id),
      resourceIds: (await resources.forBot(s.workspaceId, data)).map((r) => r.id),
      connections: await bots.assignments(s.workspaceId, data),
      options: await options(s.workspaceId, data),
    }
  })

const save = createServerFn({ method: 'POST' })
  .validator((d: { id: number; patch: bots.Patch }) => d)
  .handler(async ({ data }) => bots.save((await requireSession()).workspaceId, data.id, data.patch))

/**
 * Write, correct or delete one of this bot's answers.
 *
 * The bot id comes from the browser and is checked against the session's workspace by the
 * queries themselves — every one of them is scoped, so a bot in somebody else's workspace
 * matches nothing rather than being edited.
 */
const addExample = createServerFn({ method: 'POST' })
  .validator((d: { botId: number; question: string; answer: string; resourceIds: number[] }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await lessons.addExample(s.workspaceId, data.botId, data)
  })

const editExample = createServerFn({ method: 'POST' })
  .validator((d: { id: number; question: string; answer: string; resourceIds: number[] }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    // Both halves in one call because they are one edit from where somebody is standing: the
    // wording and the attachment are two parts of the same answer, and saving one without
    // the other is how a sentence ends up promising a file that is no longer ticked.
    await lessons.editExample(s.workspaceId, data.id, { question: data.question, answer: data.answer })
    await lessons.setResources(s.workspaceId, data.id, data.resourceIds)
  })

const removeExample = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => lessons.removeExample((await requireSession()).workspaceId, data))

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
 * What each mode actually does to a customer, said in those terms.
 *
 * "Learning" is the one that needs saying plainly: from the customer's side it is
 * indistinguishable from having no bot at all, and somebody switching it on should know
 * that before they find out from an unanswered message.
 */
const MODE_MEANS: Record<BotMode, string> = {
  live: 'Answers customers on every connection it holds.',
  learning: 'Says nothing. Every conversation goes to a person, and the bot still owns the thread.',
  paused: 'Says nothing. Everything goes to a person.',
}

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

/**
 * The price list and the calendar, both workspace-level.
 *
 * One function each rather than six, because add / edit / remove differ only in which
 * fields arrive — and every one of them ends by republishing the mirrored document, which
 * is the part that must not be forgotten. `catalogue` does that itself.
 */
const saveProduct = createServerFn({ method: 'POST' })
  .validator((d: Record<string, unknown>) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const id = Number(data.id) || 0
    if (data.remove) return catalogue.removeProduct(s.workspaceId, id)
    if (id) return catalogue.editProduct(s.workspaceId, id, data as never)
    await catalogue.addProduct(s.workspaceId, data as never)
  })

const saveEvent = createServerFn({ method: 'POST' })
  .validator((d: Record<string, unknown>) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const id = Number(data.id) || 0
    if (data.remove) return catalogue.removeEvent(s.workspaceId, id)
    if (id) return catalogue.editEvent(s.workspaceId, id, data as never)
    await catalogue.addEvent(s.workspaceId, data as never)
  })

export const Route = createFileRoute('/chatbot/$id')({
  validateSearch: (s: Record<string, unknown>): { tab: string } => ({
    tab: typeof s.tab === 'string' ? s.tab : 'identity',
  }),
  loader: ({ params }) => load({ data: Number(params.id) }),
  component: Detail,
})

type Data = NonNullable<Awaited<ReturnType<typeof load>>>

/**
 * The bot as it is saved, in the shape the form edits it.
 *
 * One definition, used twice: to fill the form when the page opens, and to compare against
 * while it is being edited. Written out separately the two drifted, and a field missing
 * from the comparison is a change the page swears it has no record of.
 */
const saved0 = (data: Data): Draft => ({
  name: data.bot.name,
  description: data.bot.description,
  base_prompt: data.bot.base_prompt,
  business_notes: data.bot.business_notes,
  memory: data.bot.memory,
  persona: data.bot.persona,
  model: data.bot.model ?? '',
  learns: data.bot.learns,
  confidence_floor: Number(data.bot.confidence_floor),
  strict_kb: data.bot.strict_kb,
  escalate: data.bot.escalate,
  forbidden: data.bot.forbidden,
  tools: data.bot.tools,
  mode: data.bot.mode,
  baseIds: [...data.baseIds],
  calendarIds: [...data.calendarIds],
  resourceIds: [...data.resourceIds],
  connections: data.connections.map((c) => ({ channel: c.channel, connection_ref: c.connection_ref })),
})

/**
 * Whether two drafts say the same thing.
 *
 * Sorted before comparing, because ticking a box and unticking it leaves the same set in a
 * different order — and a page that warns about unsaved changes nobody made is one people
 * learn to click through.
 */
const settled = (a: Draft, b: Draft) => {
  const flat = (d: Draft) =>
    JSON.stringify({
      ...d,
      tools: [...d.tools].sort(),
      baseIds: [...d.baseIds].sort((x, y) => x - y),
      calendarIds: [...d.calendarIds].sort((x, y) => x - y),
      resourceIds: [...d.resourceIds].sort((x, y) => x - y),
      connections: [...d.connections]
        .map((c) => `${c.channel}:${c.connection_ref}`)
        .sort(),
    })
  return flat(a) === flat(b)
}

/**
 * Hook-free on purpose: `DetailView` below runs a long stretch of hooks straight off
 * `data`'s fields, and a conditional return in front of only some of them — rather than
 * here, in front of all of it — would change how many hooks run the moment the loader data
 * flips from null to real between two renders of the *same* mounted route (a different id,
 * not a different page).
 */
function Detail() {
  const data = Route.useLoaderData()
  if (!data) return <NotFound what="chatbot" to="/chatbots" label="Back to the list." />
  return <DetailView data={data} />
}

function DetailView({ data }: { data: Data }) {
  const { tab } = Route.useSearch()
  const router = useRouter()
  const saveFn = useServerFn(save)
  const addExampleFn = useServerFn(addExample)
  const editExampleFn = useServerFn(editExample)
  const removeExampleFn = useServerFn(removeExample)
  const addResourceFn = useServerFn(addResource)
  const renameResourceFn = useServerFn(renameResource)
  const deleteResourceFn = useServerFn(deleteResource)
  const productFn = useServerFn(saveProduct)
  const eventFn = useServerFn(saveEvent)

  const [draft, setDraft] = useState<Draft>(() => saved0(data))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setSaved(false)
  }
  const pick = (id: string) => router.navigate({ to: '/chatbot/$id', params: { id: String(data.bot.id) }, search: { tab: id } })

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      await saveFn({
        data: {
          id: data.bot.id,
          patch: { ...draft, model: draft.model.trim() || null },
        },
      })
      await router.invalidate()
      setSaved(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const dirty = !settled(draft, saved0(data))

  return (
    <>
      {/*
        Unsaved work, said where it cannot be missed.

        This form is five tabs deep and most of it saves on one button at the bottom of the
        last one — so it was entirely possible to write a prompt, switch tab, wander off and
        lose it, with nothing on screen having suggested anything was pending. Sticky, so it
        is still there after scrolling, and it carries both answers: keep them or put them
        back.
      */}
      {dirty && (
        <div className="unsaved" role="status">
          <span>
            <strong>Unsaved changes</strong>
            <span className="note">Nothing here has reached the bot yet.</span>
          </span>
          <button className="small" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="ghost small" disabled={busy} onClick={() => setDraft(saved0(data))}>
            Discard
          </button>
        </div>
      )}

      <Link to="/chatbots" className="backlink">← Chatbots</Link>
      <div className="pagehead">
        <div className="titles">
          <h1 style={{ fontSize: 30 }}>{data.bot.name}</h1>
          <p className="lede" style={{ marginBottom: 12 }}>
            {data.bot.description || 'No description.'}
          </p>
        </div>
        <div className="runmode">
          {/*
            Three states, not a switch, because "paused" and "learning" are both silent and
            they are opposites: one is stop, the other is watch and take notes.
          */}
          <div className="seg" role="group" aria-label="How this bot runs">
            {BOT_MODES.map((m) => (
              <button
                key={m}
                className={draft.mode === m ? 'on' : ''}
                aria-pressed={draft.mode === m}
                onClick={() => set('mode', m)}
              >
                {m === 'live' ? 'Live' : m === 'learning' ? 'Learning' : 'Paused'}
              </button>
            ))}
          </div>
          <p className="note">{MODE_MEANS[draft.mode]}</p>
        </div>
      </div>

      <Steps current={tab} onPick={pick} />

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      <>
          <div className="card sectioncard">
            <Section
              section={(SECTIONS.some((s) => s.id === tab) ? tab : 'identity') as SectionId}
              draft={draft}
              set={set}
              options={{
                ...data.options,
                onAddExample: async (input) => {
                  await addExampleFn({ data: { ...input, botId: data.bot.id } })
                  await refresh(router)
                },
                onEditExample: async (input) => {
                  await editExampleFn({ data: input })
                  await refresh(router)
                },
                onRemoveExample: async (id) => {
                  await removeExampleFn({ data: id })
                  await refresh(router)
                },
                onAddResource: async (body) => {
                  await addResourceFn({ data: body })
                  await refresh(router)
                },
                onDeleteResource: async (id) => {
                  await deleteResourceFn({ data: id })
                  await refresh(router)
                },
                onProduct: async (input) => {
                  await productFn({ data: input })
                  await refresh(router)
                },
                onEvent: async (input) => {
                  await eventFn({ data: input })
                  await refresh(router)
                },
                onRenameResource: async (patch) => {
                  await renameResourceFn({ data: patch })
                  await refresh(router)
                },
              }}
            />
          </div>
          <div className="row wizardfoot">
            <button disabled={busy || !dirty} onClick={submit}>
              {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
            {saved && !dirty && <span className="pill ok">Saved</span>}
            <span className="note">Last changed {new Date(data.bot.updated_at).toLocaleString()}</span>
          </div>
      </>
    </>
  )
}
