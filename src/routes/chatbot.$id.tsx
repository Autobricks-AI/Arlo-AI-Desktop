import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { NotFound } from '../components/NotFound'
import { lightDismiss } from '../components/Modal'
import { requireSession } from '../server/auth'
import * as bots from '../server/bot'
import { options } from '../server/botform'
import * as lessons from '../server/lessons'
import * as resources from '../server/resources'
import * as catalogue from '../server/catalogue'
import { liveTakeover } from '../server/agent'
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

/** What going live would do to the threads people are holding. Asked before it is agreed to. */
const liveImpact = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => liveTakeover((await requireSession()).workspaceId, data))

/**
 * Go live, and mean it.
 *
 * Saving the mode is the whole of it: `bots.save` already hands the backlog over on the
 * transition to live, and sweeping again here would be a second pass answering the same
 * customers a second time. The dialog's job is to say what that save is about to do, not to
 * do it twice.
 *
 * Saved here rather than left to the page's own Save because the two are one decision --
 * somebody who agreed to the dialog agreed to the messages, and a button they might not
 * press must not be what decides whether forty conversations are answered.
 */
const goLive = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await bots.save(s.workspaceId, data, { mode: 'live' })
  })

/**
 * Write, correct or delete one of this bot's answers.
 *
 * The bot id comes from the browser and is checked against the session's workspace by the
 * queries themselves — every one of them is scoped, so a bot in somebody else's workspace
 * matches nothing rather than being edited.
 */
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

/** Turn down a proposed wording so it stops being offered. Nothing approved changes. */
const dismissSuggestion = createServerFn({ method: 'POST' })
  .validator((d: { id: number }) => d)
  .handler(async ({ data }) => lessons.dismissSuggestion((await requireSession()).workspaceId, data.id))

/** Read a knowledge base for things it sells, proposing each one the way a conversation does. */
const readCatalogue = createServerFn({ method: 'POST' })
  .validator((d: { baseId: number }) => d)
  .handler(async ({ data }) => lessons.fromBase((await requireSession()).workspaceId, data.baseId))

/** Read this bot's conversations now rather than waiting for the sweep. */
const scanLessons = createServerFn({ method: 'POST' })
  .validator((botId: number) => botId)
  .handler(async ({ data }) => lessons.scan((await requireSession()).workspaceId, data))

/**
 * One page of the review queue, read when the door opens rather than on every page load.
 *
 * It used to come down with the loader: every proposal, with its question, its answer and what
 * it nearly matched, re-sent after each approval. On a bot with a long queue that is almost the
 * whole payload, and the grouping behind it was most of the time the page took to open.
 */
const loadQueue = createServerFn({ method: 'GET' })
  .validator((d: { botId: number; kind: string; find: string; page: number }) => d)
  .handler(async ({ data }) =>
    lessons.queue((await requireSession()).workspaceId, data.botId, {
      kind: data.kind,
      find: data.find,
      page: data.page,
    }),
  )

/** The hour a learned date is missing, filled in by the person reviewing it. */
const setLessonTimes = createServerFn({ method: 'POST' })
  .validator((d: { id: number; start_time?: string | null; end_time?: string | null; calendar_id?: number | null }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await lessons.setTimes(s.workspaceId, data.id, data)
  })

/** Approving is a decision about a row, so it saves at once rather than on Save. */
const decideLessons = createServerFn({ method: 'POST' })
  .validator(
    (d: {
      ids: number[]
      status: 'approved' | 'rejected'
      botId: number
      /** Files a reviewer crossed off an answer before approving it. */
      crossed?: { lesson: number; file: number }[]
    }) => d,
  )
  .handler(async ({ data }) => {
    const s = await requireSession()
    await lessons.decide(s.workspaceId, data.ids, data.status, data.crossed ?? [])
    /*
     * What the bot may now reach, back to the form.
     *
     * Approving a file connects it to the bot and approving a fact connects the base it was
     * filed in — both on the server, both invisible to a form whose draft was read once when
     * the page loaded. The checkbox stayed unticked, which was the visible half; the other
     * half was worse, because pressing Save afterwards wrote the stale list back and
     * unlinked the very thing that had just been approved.
     */
    return {
      resourceIds: (await resources.forBot(s.workspaceId, data.botId)).map((r) => r.id),
      baseIds: (await bots.connectedBases(s.workspaceId, data.botId)).map((b) => b.base_id),
    }
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
  const impactFn = useServerFn(liveImpact)
  const goLiveFn = useServerFn(goLive)
  const queueFn = useServerFn(loadQueue)
  const editExampleFn = useServerFn(editExample)
  const dismissFn = useServerFn(dismissSuggestion)
  const decideFn = useServerFn(decideLessons)
  const timesFn = useServerFn(setLessonTimes)
  const scanFn = useServerFn(scanLessons)
  const readFn = useServerFn(readCatalogue)
  const addResourceFn = useServerFn(addResource)
  const renameResourceFn = useServerFn(renameResource)
  const deleteResourceFn = useServerFn(deleteResource)
  const productFn = useServerFn(saveProduct)
  const eventFn = useServerFn(saveEvent)

  const [draft, setDraft] = useState<Draft>(() => saved0(data))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)
  /*
   * What going live would do, held while the dialog asks about it. Null is "not asking".
   * Fetched rather than guessed, because the number of threads it will answer is the whole
   * reason somebody hesitates over this button.
   */
  const [going, setGoing] = useState<{ threads: number; answering: number } | null>(null)
  /*
   * Something that went right, which the error line is the wrong colour for. Going live can
   * put messages in front of real customers, and that is not a thing to do silently.
   */
  const [notice, setNotice] = useState('')

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
        {/*
          Before the run modes, and solid rather than outlined.

          Talking to it is the thing to try first — the same argument broadcasts makes for
          putting "Send a test" beside the real action — and the modes next to it are the
          thing that changes what customers get. Reaching the dangerous control first, past a
          safe one that answers the same question, is the wrong way round.

          It tests the bot *as saved*: this navigates away from an unsaved form, which the
          sticky bar already warns about. Disabling it while dirty would make it dead exactly
          when somebody most wants to check a change, so the title says so instead.
        */}
        <div className="actions">
          <Link
            to="/playground/$id"
            params={{ id: String(data.bot.id) }}
            className="button primary"
            title={
              dirty
                ? 'Chat with this bot. It answers as last saved, so save first to try your changes.'
                : 'Chat with this bot. Nothing is saved.'
            }
          >
            Playground
          </Link>
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
                /*
                  Live is the one that asks. It is not only a label on this page: it hands
                  every thread a person is holding back to the bot and answers the ones still
                  waiting on an answer, which is messages to real customers. The other two
                  are silent, so they stay a click.

                  Only when it is not already live -- re-picking the mode it is in should not
                  threaten to answer anybody.
                */
                onClick={() => {
                  if (m !== 'live' || data.bot.mode === 'live') return set('mode', m)
                  setErr('')
                  setNotice('')
                  void (async () => {
                    try {
                      setGoing(await impactFn({ data: data.bot.id }))
                    } catch (e) {
                      setErr(e instanceof Error ? e.message : String(e))
                    }
                  })()
                }}
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

      {notice && (
        <p className="note" role="status">
          {notice}
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
                onEditExample: async (input) => {
                  await editExampleFn({ data: input })
                  await refresh(router)
                },
                onDismissSuggestion: async (id) => {
                  await dismissFn({ data: { id } })
                  await refresh(router)
                },
                onQueue: (q) => queueFn({ data: { ...q, botId: data.bot.id } }),
                onDecide: async (input) => {
                  const now = await decideFn({ data: { ...input, botId: data.bot.id } })
                  // Merged rather than replaced: somebody may have ticked something else
                  // while reviewing, and their unsaved edit is not this function's to undo.
                  set('resourceIds', [...new Set([...draft.resourceIds, ...now.resourceIds])])
                  set('baseIds', [...new Set([...draft.baseIds, ...now.baseIds])])
                  await refresh(router)
                },
                onScan: async () => {
                  const found = await scanFn({ data: data.bot.id })
                  await refresh(router)
                  return found
                },
                /*
                 * No loader invalidation. The row whose hours changed is in the review queue,
                 * which the component owns and re-reads itself -- and the loader behind it is
                 * the whole chatbot, which is a great deal of work for one time field.
                 */
                onLessonTimes: async (input) => {
                  await timesFn({ data: input })
                },
                onReadCatalogue: async (baseId) => {
                  const got = await readFn({ data: { baseId } })
                  await refresh(router)
                  return got
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

      {going && (
        /*
         * The same dialog the inbox uses to wake a bot on one thread, asking the wider
         * version of that question. What it must say before anybody agrees: how many
         * conversations stop being a person's, and how many customers hear from the bot in
         * the next few seconds.
         */
        <dialog className="sheet" ref={(el) => el?.showModal()} onClick={lightDismiss} onClose={() => setGoing(null)}>
          <div className="sheetbody">
            <h3 style={{ marginTop: 0 }}>Set {data.bot.name} live?</h3>
            <p className="note">{MODE_MEANS.live}</p>
            {going.threads === 0 ? (
              <p className="note">No conversation is with a person right now, so nothing changes in the inbox.</p>
            ) : (
              <>
                <p className="note">
                  <strong>
                    {going.threads} conversation{going.threads === 1 ? '' : 's'}
                  </strong>{' '}
                  {going.threads === 1 ? 'is' : 'are'} with a person. {going.threads === 1 ? 'It goes' : 'They go'} back
                  to {data.bot.name}, which takes the next message on {going.threads === 1 ? 'it' : 'each of them'}.
                </p>
                {going.answering > 0 ? (
                  <p className="note">
                    <strong>
                      {going.answering} of {going.threads === 1 ? 'them' : 'those'}
                    </strong>{' '}
                    {going.answering === 1 ? 'is' : 'are'} waiting on an answer, so {data.bot.name} replies to{' '}
                    {going.answering === 1 ? 'that customer' : 'those customers'} straight away. A thread whose last
                    message was a goodbye is handed back without a reply.
                  </p>
                ) : (
                  <p className="note">
                    None of them is waiting on an answer, so nobody hears from {data.bot.name} until they write again.
                  </p>
                )}
              </>
            )}
            <div className="row" style={{ marginTop: 16 }}>
              <button
                disabled={busy}
                onClick={() => {
                  const asked = going
                  setGoing(null)
                  void (async () => {
                    setBusy(true)
                    setErr('')
                    try {
                      await goLiveFn({ data: data.bot.id })
                      // The draft follows the server, so the page does not show Learning
                      // beside a bot that is now answering.
                      setDraft((d) => ({ ...d, mode: 'live' }))
                      await router.invalidate()
                      setNotice(
                        asked.threads
                          ? `${data.bot.name} is live. ${asked.threads} conversation${
                              asked.threads === 1 ? '' : 's'
                            } handed back${asked.answering ? `, ${asked.answering} being answered now` : ''}.`
                          : `${data.bot.name} is live.`,
                      )
                    } catch (e) {
                      setGoing(asked)
                      setErr(e instanceof Error ? e.message : String(e))
                    } finally {
                      setBusy(false)
                    }
                  })()
                }}
              >
                {going.threads ? 'Go live and hand them back' : 'Go live'}
              </button>
              <button className="ghost" disabled={busy} onClick={() => setGoing(null)}>
                Cancel
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  )
}
