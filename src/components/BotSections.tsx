/**
 * The chatbot form, cut into sections.
 *
 * Shared by the create wizard and the configure page on purpose. They ask for exactly the
 * same things — the only difference is that one shows the sections one at a time and the
 * other lets you jump between them — and two copies of a form with twelve fields is two
 * copies that drift apart on the first change.
 *
 * Client-side, so nothing here may import from `src/server`. Everything arrives as props.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { BOT_DEFAULTS, STANDARD_BASES, TOOLS, TOOL_IDS, calendarRange, shiftCalendar } from '../types'
import type { BotMode, ChannelId, ToolId } from '../types'
import { lightDismiss } from './Modal'

export type Draft = {
  name: string
  description: string
  base_prompt: string
  business_notes: string
  memory: string
  persona: string
  model: string
  confidence_floor: number
  strict_kb: boolean
  escalate: string
  forbidden: string
  resourceIds: number[]
  tools: ToolId[]
  mode: BotMode
  /** Whether it reads finished conversations for what the customer said about themselves. */
  learns: boolean
  baseIds: number[]
  /** Calendars it may read. Empty means it knows no dates. */
  calendarIds: number[]
  connections: { channel: ChannelId; connection_ref: string }[]
}

/** One thing a customer can talk to: a widget, a bot, a number, a mailbox. */
export type Connection = {
  channel: ChannelId
  ref: string
  label: string
  /** Another bot already has this one. A connection answered by two bots replies twice. */
  takenBy: string | null
}

/**
 * What the workspace's linked provider offers.
 *
 * Declared here rather than imported from llm.ts, which reaches the database and the secret
 * store — neither belongs in a bundle that ships to a browser. Kept in step by the loader
 * that fills it, and by tsc where the two meet.
 */
type Catalogue = {
  provider: string
  fallback: string
  models: { id: string; label: string; tier: string | null }[]
  live: boolean
}

/**
 * A learned date, written the way somebody reads a date.
 *
 * Local rather than DayModal's shortDay, which is the same three lines but sits in a module
 * that imports the server. It also drops the year, and the year is the one part of a proposed
 * date worth being sure of — a model resolving "the 25th of August" against the wrong year is
 * the exact mistake the harvest prompt carries a TODAY block to prevent.
 */
const asDay = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
const asRange = (from: string, to?: string | null) =>
  to && to !== from ? asDay(from) + ' – ' + asDay(to) : asDay(from)

export type Options = {
  bases: { id: number; name: string; description: string; documents: number; passages: number }[]
  connections: Connection[]
  /** Whether a model is reachable at all. A bot with nowhere to ask cannot answer. */
  model: boolean
  /** What this workspace's provider offers, and what a bot that picks nothing runs on. */
  models: Catalogue
  /** Per tool: null when it can run, or why it cannot. */
  toolsReady: Record<string, string | null>
  resources: {
    id: number
    kind: string
    title: string
    description: string
    url: string | null
    mime: string | null
    size_bytes: number
    /** How many bots may send it. Deleting is workspace-wide, so this is worth showing. */
    bots: number
  }[]
  /** Absent on a page that cannot upload. The picker still renders; the form does not. */
  onAddResource?: (input: FormData) => Promise<void>
  /** Same again for renaming one. A workspace action, so it saves immediately. */
  onRenameResource?: (input: { id: number; title: string; description: string }) => Promise<void>
  /** Delete it outright: gone from every bot, and the bytes with it. */
  onDeleteResource?: (id: number) => Promise<void>
  /** What the company sells. Workspace-level, mirrored into the knowledge base on write. */
  products: {
    id: number
    name: string
    description: string
    sku: string | null
    price: number | null
    currency: string
    unit: string | null
    active: boolean
    position: number
  }[]
  /** Every calendar in the workspace, for the picker. */
  calendars: { id: number; name: string; description: string; colour: string; is_default: boolean; events: number }[]
  /** Dates the bot should know about — closures, launches, cut-offs. */
  events: {
    id: number
    calendar_id: number
    title: string
    detail: string
    starts_on: string
    ends_on: string | null
    /** HH:MM. Every event has both — an end an hour after the start, unless said otherwise. */
    start_time: string
    end_time: string
    repeats: string
    source: string
  }[]
  /** Saving a product or a date. Absent in the wizard, where the workspace has no bot yet. */
  onProduct?: (input: { id?: number; remove?: boolean; [k: string]: unknown }) => Promise<void>
  onEvent?: (input: { id?: number; remove?: boolean; [k: string]: unknown }) => Promise<void>

  /** Answers written for this bot, newest first. Empty in the wizard. */
  examples: { id: number; question: string; answer: string; created_at: string }[]
  /** Which resource is attached to which answer. */
  exampleResources: { lesson_id: number; id: number }[]
  /** Absent on a page that cannot save — the wizard, before the bot exists. */
  onAddExample?: (input: { question: string; answer: string; resourceIds: number[] }) => Promise<void>
  onEditExample?: (input: { id: number; question: string; answer: string; resourceIds: number[] }) => Promise<void>
  onRemoveExample?: (id: number) => Promise<void>
}

export const SECTIONS = [
  { id: 'identity', label: 'Identity', hint: 'Name and what it should know about you' },
  { id: 'knowledge', label: 'Knowledge and attachments', hint: 'What it may answer from, and what it may send' },
  // Straight after Knowledge, because it is the same question asked twice: that section is
  // what this bot may read, this one is what it has been told to say.
  { id: 'answers', label: 'Answers and learning', hint: 'What to reply, and what it notes about customers' },
  // Where it answers and what it can do, together: both are "what this bot is wired to",
  // both are a list of checkboxes, and neither was ever a page's worth on its own.
  { id: 'channels', label: 'Channels and tools', hint: 'Where it answers and what it can do' },
  { id: 'behaviour', label: 'Behaviour and guardrails', hint: 'Tone, limits and model' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

/**
 * What a fresh workspace's own defaults look like, if it still has them.
 *
 * Matched by name/flag rather than "whatever sorts first" — a workspace with several bases
 * by the time a second bot is made has no first one worth guessing at, and this is meant to
 * fill in the obvious starting point, not a guess.
 */
type Starters = {
  bases: { id: number; name: string }[]
  calendars: { id: number; is_default: boolean }[]
}

export const emptyDraft = (starters?: Starters): Draft => ({
  name: BOT_DEFAULTS.name,
  description: BOT_DEFAULTS.description,
  base_prompt: BOT_DEFAULTS.base_prompt,
  business_notes: BOT_DEFAULTS.business_notes,
  memory: BOT_DEFAULTS.memory,
  persona: BOT_DEFAULTS.persona,
  model: '',
  confidence_floor: 0.45,
  strict_kb: true,
  escalate: BOT_DEFAULTS.escalate,
  forbidden: BOT_DEFAULTS.forbidden,
  resourceIds: [],
  // On by default for any tool that needs nothing beyond what the app already has; one
  // that needs its own credential (web search) stays off until that is set up.
  tools: TOOL_IDS.filter((id) => TOOLS[id].needs === null),
  mode: BOT_DEFAULTS.mode,
  // On by default, matching the column. It is the useful behaviour and it is visible in
  // the form, which is what makes a default like this fair rather than sneaky.
  learns: true,
  // The one base every workspace starts with — not the other three STANDARD_BASES, which
  // stay an explicit choice.
  baseIds: starters?.bases.filter((b) => b.name === STANDARD_BASES[0].name).map((b) => b.id) ?? [],
  calendarIds: starters?.calendars.filter((c) => c.is_default).map((c) => c.id) ?? [],
  connections: [],
})

const CHANNEL_LABEL: Record<ChannelId, string> = {
  web: 'Web chat',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  email: 'Email',
}

/**
 * The step rail.
 *
 * Every step is reachable at any time, including ones not visited yet. A wizard that locks
 * you out of step four until step three is "complete" is a wizard that decides for you what
 * order your own configuration makes sense in — and this form has no field that depends on
 * another, so there is nothing to protect.
 */
export function Steps({
  current,
  onPick,
  extra = [],
}: {
  current: string
  onPick: (id: string) => void
  /** Steps beyond the shared sections — the wizard's Review, the detail page's Messages. */
  extra?: { id: string; label: string; hint: string }[]
}) {
  const all = [...SECTIONS, ...extra]
  const at = all.findIndex((s) => s.id === current)

  return (
    <ol className="steps">
      {all.map((s, i) => (
        <li key={s.id} className={s.id === current ? 'on' : i < at ? 'done' : ''}>
          <button onClick={() => onPick(s.id)} aria-current={s.id === current ? 'step' : undefined}>
            <span className="dot">{i < at ? '✓' : i + 1}</span>
            <span className="what">
              <strong>{s.label}</strong>
              <span className="note">{s.hint}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

/** What every section needs. The section id is the switch's business, not theirs. */
type Fields = {
  draft: Draft
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void
  options: Options
}
type Props = Fields & { section: SectionId }

/**
 * A tab's own contents, split down again: the parts on the left, one of them on the right.
 *
 * Five tabs was the right number for the top of the page and the wrong number for what is
 * under them — Identity alone is a name, a prompt, a page of business notes and a memory,
 * and scrolling past three of them to reach the fourth is how a form starts feeling like a
 * questionnaire. Vertical rather than another horizontal strip, because these are labels of
 * sentences rather than single words, and because two horizontal strips stacked stop
 * reading as a hierarchy.
 *
 * Local state, not the URL: the tab above is the address, and a second parameter for which
 * field you were looking at is a link nobody wanted to send.
 */
type Pane = { id: string; label: string; hint?: string; body: ReactNode }

function Split({ panes }: { panes: Pane[] }) {
  const [at, setAt] = useState(panes[0]?.id ?? '')
  const shown = panes.find((x) => x.id === at) ?? panes[0]

  return (
    <div className="subsplit">
      {/* A card of its own, so the list of parts reads as a place you are in rather than a
          row of buttons above the thing they act on. */}
      <nav className="subrail" role="tablist" aria-orientation="vertical">
        {panes.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={x.id === shown?.id}
            className={x.id === shown?.id ? 'on' : ''}
            onClick={() => setAt(x.id)}
          >
            <strong>{x.label}</strong>
            {x.hint && <span className="note">{x.hint}</span>}
          </button>
        ))}
      </nav>
      <div className="subpane">
        {shown && (
          <header>
            <h3>{shown.label}</h3>
            {shown.hint && <p className="note">{shown.hint}</p>}
          </header>
        )}
        {shown?.body}
      </div>
    </div>
  )
}

export function Section({ section, draft, set, options }: Props) {
  if (section === 'identity') return <Identity draft={draft} set={set} options={options} />
  if (section === 'knowledge') return <Knowledge draft={draft} set={set} options={options} />
  if (section === 'answers') return <Answers draft={draft} set={set} options={options} />
  if (section === 'channels')
    return (
      <Split
        panes={[
          {
            id: 'where',
            label: 'Where it answers',
            hint: 'Widgets, numbers and mailboxes',
            body: <Channels draft={draft} set={set} options={options} />,
          },
          {
            id: 'tools',
            label: 'Tools',
            hint: 'What it may do besides talk',
            body: <Tools draft={draft} set={set} options={options} />,
          },
        ]}
      />
    )
  return <Behaviour draft={draft} set={set} options={options} />
}

function Identity({ draft, set, options }: Fields) {
  return (
    <Split
      panes={[
        {
          id: 'who',
          label: 'Who it is',
          hint: 'Name and one line',
          body: (
            <div className="fieldset">
      <div className="field">
        <label htmlFor="name">Name</label>
        <input
          id="name"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
        <p className="note">What the bot calls itself, and how you tell it apart from the others.</p>
      </div>

      <div className="field">
        <label htmlFor="description">One line about it</label>
        <input
          id="description"
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
        />
        <p className="note">Shown on its card. Only you see this.</p>
      </div>

            </div>
          ),
        },
        {
          id: 'prompt',
          label: 'Base prompt',
          hint: 'What it is told to be',
          body: (
            <div className="fieldset">
      <div className="field wide">
        <label htmlFor="base_prompt">Base prompt</label>
        <textarea
          id="base_prompt"
          rows={12}
          value={draft.base_prompt}
          onChange={(e) => set('base_prompt', e.target.value)}
        />
        <p className="note">
          The role, and how the employee works. In every prompt, whether or not anything was retrieved.
        </p>
      </div>

      {/*
        Both optional and both empty until somebody fills them. They are context, not
        sources: what an answer may actually be built on is the knowledge base, and the
        prompt says so whenever either of these is used.
      */}
            </div>
          ),
        },
        {
          id: 'business',
          label: 'About the business',
          hint: 'Context, not evidence',
          body: (
            <div className="fieldset">
      <div className="field wide">
        <label htmlFor="business_notes">
          What it knows about the business &amp; role <span className="note">— optional (USER.md)</span>
        </label>
        <textarea
          id="business_notes"
          rows={8}
          value={draft.business_notes}
          onChange={(e) => set('business_notes', e.target.value)}
        />
        <p className="note">
          Standing context: who you are, how the team works, what this bot is for. Anything a new hire would
          be told on day one that is not written down anywhere.
        </p>
      </div>

            </div>
          ),
        },
        {
          id: 'memory',
          label: 'Working memory',
          hint: 'What it carries between conversations',
          body: (
            <div className="fieldset">
      <div className="field wide">
        <label htmlFor="memory">
          Working memory <span className="note">— optional (MEMORY.md)</span>
        </label>
        <textarea id="memory" rows={8} value={draft.memory} onChange={(e) => set('memory', e.target.value)} />
        <p className="note">
          What it carries between conversations — a policy you clarified, a question that keeps coming up, a
          decision made last week.
          <br />
          <strong>Neither box is a source.</strong> Prices, policies and hours belong in the knowledge base,
          where an answer can cite them and they stay current. Typed here they arrive uncited, and go stale the
          moment the real source is edited.
        </p>
      </div>
            </div>
          ),
        },
      ]}
    />
  )
}

// ---------------------------------------------------------------- answers

/**
 * Questions somebody has written the reply to.
 *
 * Not harvested. Nothing reads your inbox and proposes what you might have meant — you
 * write the answer you want given, and that is the answer it gives. There is no approval
 * queue for the same reason: the person writing it is the person who would have approved it.
 *
 * These outrank the knowledge base at answering time. A crawled page is whatever the website
 * said last year; this is somebody deciding, today, what the reply should be.
 */
function Answers({ draft, set, options }: Fields) {
  const [adding, setAdding] = useState(false)
  const readOnly = !options.onAddExample

  return (
    <div className="fieldset">
      <div className="field wide">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <strong style={{ fontSize: 15 }}>Answers</strong>
          {!readOnly && (
            <button type="button" className="ghost small" onClick={() => setAdding(true)}>
              Write an answer
            </button>
          )}
        </div>
        <p className="note" style={{ marginTop: 4 }}>
          {readOnly
            ? 'Once this bot exists you can write the answers it should give.'
            : 'Ask it the way a customer would, and write the reply you want sent. These are used ahead of the knowledge base when both fit.'}
        </p>
      </div>

      {adding && (
        <div className="field wide">
          <ExampleForm
            resources={options.resources}
            onCancel={() => setAdding(false)}
            onSave={async (v) => {
              await options.onAddExample!(v)
              setAdding(false)
            }}
          />
        </div>
      )}

      <div className="field wide">
        {options.examples.length === 0 ? (
          <p className="note" style={{ marginTop: 0 }}>
            Nothing written yet. The bot answers from its knowledge base until there is.
          </p>
        ) : (
          options.examples.map((e) => (
            <ExampleRow
              key={e.id}
              example={e}
              resources={options.resources}
              attached={options.exampleResources.filter((r) => r.lesson_id === e.id).map((r) => r.id)}
              onSave={options.onEditExample}
              onRemove={options.onRemoveExample}
            />
          ))
        )}
      </div>

      {/*
        The other half of the section, and a different thing entirely.
        Above is what you tell it to say. This is what it notices about the person it is
        saying it to — and because that is personal data being written without anybody
        asking, it gets a switch and a plain description of exactly what it reads.
      */}
      <div className="field wide" style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 8 }}>
        <strong style={{ fontSize: 15 }}>Learning about customers</strong>
        <label className="tick" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={draft.learns} onChange={(e) => set('learns', e.target.checked)} />
          Read finished conversations for details about the customer
        </label>
        <p className="note" style={{ marginTop: 6 }}>
          {draft.learns
            ? 'Once a thread goes quiet it is read once, and only for what the customer said about themselves — their company, where they are, when they are away. A blank field on their card is filled; anything that disagrees with what you typed waits on the card for you to decide. It never learns your answers, and never anything about the business.'
            : 'Off. Contact details are only what somebody types on the card.'}
        </p>
      </div>
    </div>
  )
}

/** The two boxes and a file picker, shared by writing a new answer and correcting one. */
function ExampleForm({
  initial,
  resources,
  onSave,
  onCancel,
}: {
  initial?: { question: string; answer: string; resourceIds: number[] }
  resources: Options['resources']
  onSave: (v: { question: string; answer: string; resourceIds: number[] }) => Promise<void>
  onCancel: () => void
}) {
  const [question, setQuestion] = useState(initial?.question ?? '')
  const [answer, setAnswer] = useState(initial?.answer ?? '')
  const [picked, setPicked] = useState<number[]>(initial?.resourceIds ?? [])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!question.trim() || !answer.trim()) return
    setBusy(true)
    setErr('')
    try {
      await onSave({ question: question.trim(), answer: answer.trim(), resourceIds: picked })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <label>When somebody asks</label>
      <input
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="do you deliver on Sundays?"
        maxLength={500}
        autoFocus
      />

      <label style={{ marginTop: 12, display: 'block' }}>Reply with</label>
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="We deliver Monday to Saturday, before noon."
        rows={4}
        maxLength={2000}
      />

      {resources.length > 0 && (
        <>
          <label style={{ marginTop: 12, display: 'block' }}>Send with it</label>
          <div className="row wrap" style={{ gap: 6 }}>
            {resources.map((r) => (
              <label key={r.id} className="tick">
                <input
                  type="checkbox"
                  checked={picked.includes(r.id)}
                  onChange={(e) =>
                    setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))
                  }
                />
                {r.title}
              </label>
            ))}
          </div>
        </>
      )}

      {err && (
        <p className="err" style={{ marginTop: 12 }} role="alert">
          {err}
        </p>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={busy || !question.trim() || !answer.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** One written answer: read it, open it to correct it, or delete it. */
function ExampleRow({
  example,
  resources,
  attached,
  onSave,
  onRemove,
}: {
  example: { id: number; question: string; answer: string }
  resources: Options['resources']
  attached: number[]
  onSave?: (input: { id: number; question: string; answer: string; resourceIds: number[] }) => Promise<void>
  onRemove?: (id: number) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const files = resources.filter((r) => attached.includes(r.id))

  if (open && onSave)
    return (
      <ExampleForm
        initial={{ question: example.question, answer: example.answer, resourceIds: attached }}
        resources={resources}
        onCancel={() => setOpen(false)}
        onSave={async (v) => {
          await onSave({ id: example.id, ...v })
          setOpen(false)
        }}
      />
    )

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <strong style={{ fontSize: 15 }}>{example.question}</strong>
      <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{example.answer}</p>
      {files.length > 0 && (
        <p className="note" style={{ margin: '8px 0 0' }}>
          Sends {files.map((f) => f.title).join(', ')}
        </p>
      )}
      {(onSave || onRemove) && (
        <div className="row" style={{ marginTop: 10 }}>
          {onSave && (
            <button type="button" className="ghost small" onClick={() => setOpen(true)}>
              Edit
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              className="ghost small bad"
              style={{ marginLeft: 'auto' }}
              onClick={() => onRemove(example.id)}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- knowledge

/**
 * Two lists, and the difference between them is what happens to the thing.
 *
 * A knowledge source is *read*: chunked, searched, quoted back in pieces with a citation.
 * A resource is *sent*: whole, unread, as a link the customer opens. A brochure PDF is
 * useless as knowledge and perfectly good as an attachment, which is why ticking it in one
 * list says nothing about the other.
 */
function Knowledge({ draft, set, options }: Fields) {
  const toggleBase = (id: number) =>
    set('baseIds', draft.baseIds.includes(id) ? draft.baseIds.filter((b) => b !== id) : [...draft.baseIds, id])
  const toggleResource = (id: number) =>
    set(
      'resourceIds',
      draft.resourceIds.includes(id) ? draft.resourceIds.filter((r) => r !== id) : [...draft.resourceIds, id],
    )

  const picked = draft.baseIds.length
  const total = options.bases.length
  const allPicked = total > 0 && picked === total

  return (
    <Split
      panes={[
        {
          id: 'bases',
          label: 'Knowledge bases',
          hint: 'What it may answer from',
          body: (
            <div className="fieldset">
      <div className="field wide">
        <label>Knowledge bases</label>
        <p className="note" style={{ marginTop: 0 }}>
          What this bot may answer from. A whole base at a time, so a source added to one later is reachable
          without coming back here — and anything unticked stays invisible to it.
        </p>

        {total === 0 ? (
          <p className="note">
            No knowledge bases yet. Make one under Knowledge, or this bot will have nothing to answer from.
          </p>
        ) : (
          <div className="picker">
            <label className="pick allpick">
              <input
                type="checkbox"
                checked={allPicked}
                ref={(el) => {
                  // Some ticked, not all: a dash rather than a box that lies either way.
                  if (el) el.indeterminate = !allPicked && picked > 0
                }}
                onChange={() => set('baseIds', allPicked ? [] : options.bases.map((b) => b.id))}
              />
              <span>
                <strong>Select all</strong>
                <span className="note">
                  {total} knowledge base{total === 1 ? '' : 's'}
                </span>
              </span>
            </label>

            {options.bases.map((base) => (
              <label key={base.id} className="pick">
                <input type="checkbox" checked={draft.baseIds.includes(base.id)} onChange={() => toggleBase(base.id)} />
                <span>
                  {base.name}
                  <span className="note">
                    {base.documents} document(s), {base.passages} passage(s)
                    {base.description && ` · ${base.description}`}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {picked === 0 && total > 0 && (
          <p className="err" style={{ marginTop: 10 }}>
            Nothing ticked. This bot has nothing to answer from and will hand off every question.
          </p>
        )}
      </div>

            </div>
          ),
        },
        {
          id: 'catalogue',
          label: 'Products and prices',
          hint: 'What you sell, and what it costs',
          body: <Catalogue options={options} />,
        },
        {
          id: 'dates',
          label: 'Important dates',
          hint: 'Closures, launches, cut-offs',
          body: <DatesPointer draft={draft} set={set} options={options} />,
        },
        {
          id: 'resources',
          label: 'Files and links',
          hint: 'What it may send',
          body: (
            <div className="fieldset">
      {/* ---------------------------------------------------------- resources */}
      <div className="field wide">
        <label>Resources and files</label>
        <p className="note" style={{ marginTop: 0 }}>
          Things it may send to a customer — a price list, a manual, a booking link. Sent whole, as a link,
          rather than read and quoted. Needs the <strong>Send a file or link</strong> tool switched on.
        </p>

        {options.resources.length === 0 ? (
          <p className="note">Nothing added yet. Add a file or a link below.</p>
        ) : (
          <div className="picker">
            {options.resources.map((r) => (
              <ResourceRow
                key={r.id}
                resource={r}
                picked={draft.resourceIds.includes(r.id)}
                onToggle={() => toggleResource(r.id)}
                onRename={options.onRenameResource}
                onDelete={options.onDeleteResource}
              />
            ))}
          </div>
        )}

        {options.onAddResource && <AddResource onAdd={options.onAddResource} />}
      </div>
            </div>
          ),
        },
      ]}
    />
  )
}

/**
 * One resource: tick it to let this bot send it, or open it to say what it is.
 *
 * Both fields are worth editing, and neither is decoration. The model is handed this list
 * and asked to choose from it, so the title is what a customer's request gets matched
 * against — `The_Ledger_of_Life_(2).pdf` is a poor thing to match on and `Ledger of Life
 * guide` is a good one. The description is the tiebreaker when two titles are close.
 *
 * The editor replaces the row rather than sitting inside it: a text input inside a <label>
 * toggles the checkbox every time you click into it.
 */
function ResourceRow({
  resource,
  picked,
  onToggle,
  onRename,
  onDelete,
}: {
  resource: Options['resources'][number]
  picked: boolean
  onToggle: () => void
  onRename?: (input: { id: number; title: string; description: string }) => Promise<void>
  onDelete?: (id: number) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(resource.title)
  const [description, setDescription] = useState(resource.description)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const size =
    resource.size_bytes >= 1048576
      ? `${(resource.size_bytes / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(resource.size_bytes / 1024))} KB`
  const detail = resource.kind === 'link' ? resource.url : `${resource.mime ?? 'file'} · ${size}`

  const save = async () => {
    if (!onRename) return
    setBusy(true)
    setErr('')
    try {
      await onRename({ id: resource.id, title, description })
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (editing)
    return (
      <div className="pick editing">
        <div className="field">
          <label htmlFor={`res-title-${resource.id}`}>Title</label>
          <input
            id={`res-title-${resource.id}`}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && title.trim() && save()}
          />
          <p className="note">What the bot is asked to pick by. A filename is a starting point, not a name.</p>
        </div>
        <div className="field">
          <label htmlFor={`res-desc-${resource.id}`}>What it is for</label>
          <input
            id={`res-desc-${resource.id}`}
            value={description}
            placeholder="The current price list, for anyone asking what things cost"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && title.trim() && save()}
          />
          <p className="note">How it decides this is the right thing to send. Worth a sentence.</p>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="row">
          <button className="small primary" disabled={!title.trim() || busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="ghost small"
            disabled={busy}
            onClick={() => {
              setTitle(resource.title)
              setDescription(resource.description)
              setErr('')
              setEditing(false)
            }}
          >
            Cancel
          </button>
          <span className="note mono">{detail}</span>
        </div>
      </div>
    )

  return (
    <div className="pick resource">
      <label className="pickmain">
        <input type="checkbox" checked={picked} onChange={onToggle} />
        {/*
          Three lines, each cut with an ellipsis rather than wrapped. A resource is picked
          out of a list by scanning it, and a description that wraps to four lines makes the
          row below it hard to find — the full text is one click away in the editor.
        */}
        <span className="what">
          <strong className="line" title={resource.title}>
            {resource.title}
          </strong>
          {resource.description ? (
            <span className="note line" title={resource.description}>
              {resource.description}
            </span>
          ) : (
            /*
              The nudge lives in the row rather than in the button, so the button can stay
              the same word every time. An unnamed, undescribed resource is one the model
              has almost nothing to match a customer's words against.
            */
            <span className="note line dim">No description — the bot has little to go on when choosing this.</span>
          )}
          <span className="note line meta" title={detail ?? ''}>
            {detail}
          </span>
        </span>
      </label>
      {/* Absent on a page that has no way to save it, rather than offered and inert. */}
      {onRename && (
        <button className="ghost small" onClick={() => setEditing(true)} title="Rename it, and say what it is for">
          Edit
        </button>
      )}
      {/*
        Two different removals, and the difference has to be unmissable. The tick takes it
        off *this* bot and nothing else. This deletes the file: every bot loses it, the bytes
        go, and any address already sent to a customer stops opening — which is the only way
        to revoke one, and is not undoable.
      */}
      {onDelete && (
        <button
          className="ghost small danger"
          disabled={busy}
          title="Delete the file itself, for every chatbot"
          onClick={async () => {
            const also =
              resource.bots > 1 ? `\n\n${resource.bots} chatbots can send this. All of them lose it.` : ''
            const sent =
              resource.kind === 'file'
                ? '\n\nAnything you have already sent a customer stops opening.'
                : ''
            if (!confirm(`Delete "${resource.title}" and its contents? This cannot be undone.${also}${sent}`)) return
            setBusy(true)
            try {
              await onDelete(resource.id)
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e))
              setBusy(false)
            }
          }}
        >
          Delete
        </button>
      )}
      {err && <p className="err">{err}</p>}
    </div>
  )
}

/**
 * Adding a resource is a workspace action, not part of the draft.
 *
 * It uploads immediately, which breaks the wizard's "nothing exists until you finish" rule
 * — deliberately. A file belongs to the workspace and is reusable by every bot, so holding
 * bytes in browser memory until a bot is created would be storing it in the wrong place to
 * preserve a promise about something else.
 */
function AddResource({ onAdd }: { onAdd: (input: FormData) => Promise<void> }) {
  const [mode, setMode] = useState<'file' | 'link'>('file')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const picker = useRef<HTMLInputElement>(null)

  const submit = async (file?: File) => {
    setBusy(true)
    setErr('')
    const body = new FormData()
    body.set('kind', file ? 'file' : 'link')
    body.set('description', description)
    if (file) body.set('file', file)
    else {
      body.set('url', url)
      body.set('title', title)
    }
    try {
      await onAdd(body)
      setUrl('')
      setTitle('')
      setDescription('')
      if (picker.current) picker.current.value = ''
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="addresource">
      <div className="row">
        <button className={mode === 'file' ? '' : 'ghost'} onClick={() => setMode('file')}>
          Upload a file
        </button>
        <button className={mode === 'link' ? '' : 'ghost'} onClick={() => setMode('link')}>
          Add a link
        </button>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="res-desc">What it is for</label>
        <input
          id="res-desc"
          value={description}
          placeholder="The current price list, for anyone asking what things cost"
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="note">How the bot decides this is the right thing to send. Worth a sentence.</p>
      </div>

      {mode === 'file' ? (
        <div className="field">
          <label htmlFor="res-file">File</label>
          <input
            id="res-file"
            ref={picker}
            type="file"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void submit(file)
            }}
          />
          <p className="note">PDF, Word, PowerPoint, an image or a short video. Up to 25MB.</p>
        </div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="res-url">Address</label>
            <input id="res-url" type="url" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="res-title">Name</label>
            <input id="res-title" value={title} placeholder="Book a call" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <button style={{ marginTop: 10 }} disabled={busy || !url} onClick={() => void submit()}>
            {busy ? 'Adding…' : 'Add link'}
          </button>
        </>
      )}

      {busy && mode === 'file' && <p className="note">Uploading…</p>}
      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- what the company sells

/**
 * The price list, as a list of prices.
 *
 * It used to arrive as a PDF, which meant a model reassembling a table out of text — and
 * that is how a price ends up two rows from the product it belongs to. Typed here it is
 * unambiguous, and it is mirrored into the knowledge base on every write, so the bot reads
 * it through exactly the same retrieval as everything else.
 */
function Catalogue({ options }: { options: Options }) {
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [from, setFrom] = useState(0)
  const [editing, setEditing] = useState(0)
  const [read, setRead] = useState('')
  const blank = { name: '', description: '', sku: '', price: '', currency: 'SGD', unit: '' }
  const [draft, setDraft] = useState(blank)

  const act = async (what: string, input: Record<string, unknown>) => {
    if (!options.onProduct) return
    setBusy(what)
    setErr('')
    try {
      await options.onProduct(input)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  if (!options.onProduct)
    return (
      <div className="fieldset">
        <div className="field wide">
          <p className="note">
            Nothing to list yet — this bot does not exist until you finish. What you sell is kept for the
            whole workspace and can be filled in afterwards.
          </p>
        </div>
      </div>
    )

  return (
    <div className="fieldset">
      <div className="field wide">
        {err && <p className="err">{err}</p>}

        {options.products.length === 0 && !adding && (
          <p className="note">
            Nothing listed yet. Anything added here is written into the knowledge base as a price list, so
            the bot can quote it with a citation like any other source.
          </p>
        )}

        {options.products.length > 0 && (
          <div className="pricelist">
            {options.products.map((r) =>
              editing === r.id ? (
                /*
                 * Corrected here rather than approved somewhere else.
                 *
                 * A price read out of a PDF is right far more often than not, and the way to
                 * catch the one that is wrong is to see it beside the others — which is this
                 * list, not a queue.
                 */
                <EditProduct
                  key={r.id}
                  product={r}
                  busy={busy}
                  onCancel={() => setEditing(0)}
                  onSave={(v) => void act('edit', { ...v, id: r.id }).then(() => setEditing(0))}
                />
              ) : (
                <div key={r.id} className={`pricerow${r.active ? '' : ' off'}`}>
                  <span className="what">
                    <b>{r.name}</b>
                    {r.sku && <code>{r.sku}</code>}
                    {r.description && <small>{r.description}</small>}
                  </span>
                  <span className="cost">
                    {r.price === null ? (
                      <em className="note">on request</em>
                    ) : (
                      <>
                        {r.currency} {r.price.toFixed(2)}
                        {r.unit && <small className="note"> {r.unit}</small>}
                      </>
                    )}
                  </span>
                  <button className="ghost small" disabled={!!busy} onClick={() => setEditing(r.id)}>
                    Edit
                  </button>
                  <button
                    className="ghost small"
                    disabled={!!busy}
                    title={r.active ? 'Take it off the list, keeping the row' : 'Put it back on the list'}
                    onClick={() => void act(`t${r.id}`, { id: r.id, active: !r.active })}
                  >
                    {r.active ? 'Hide' : 'Show'}
                  </button>
                  <button className="ghost small bad" disabled={!!busy} onClick={() => void act(`d${r.id}`, { id: r.id, remove: true })}>
                    Remove
                  </button>
                </div>
              ),
            )}
          </div>
        )}

        {adding ? (
          <div className="card" style={{ marginTop: 12 }}>
            <div className="fields">
              <div>
                <label htmlFor="p-name">Name</label>
                <input id="p-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div>
                <label htmlFor="p-sku">Code</label>
                <input id="p-sku" placeholder="Optional" value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value })} />
              </div>
              <div>
                <label htmlFor="p-price">Price</label>
                <input
                  id="p-price"
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Blank for on request"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="p-cur">Currency</label>
                <input id="p-cur" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
              </div>
              <div>
                <label htmlFor="p-unit">Per</label>
                <input id="p-unit" placeholder="each, per month…" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} />
              </div>
            </div>
            <div className="field wide" style={{ marginTop: 12 }}>
              <label htmlFor="p-desc">What it is</label>
              <input
                id="p-desc"
                placeholder="In the words a customer would use"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                className="small"
                disabled={!draft.name.trim() || !!busy}
                onClick={() =>
                  void act('add', { ...draft, price: draft.price === '' ? null : Number(draft.price) }).then(() => {
                    setDraft(blank)
                    setAdding(false)
                  })
                }
              >
                {busy === 'add' ? 'Adding…' : 'Add'}
              </button>
              <button className="ghost small" disabled={!!busy} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="ghost small" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
            Add a product
          </button>
        )}

      </div>
    </div>
  )
}

// ---------------------------------------------------------------- dates the bot should know

/**
 * The business's own calendar.
 *
 * Not the same calendar as a project's: that one is somebody's follow-ups and bookings, and
 * this one is closures, launches and cut-offs — the dates a customer asks about directly.
 * A month grid rather than a list because "are you open on the 18th" is a question about a
 * square, and dates the bot learned from a conversation land here once approved.
 */
/**
 * Where the dates live now.
 *
 * They were edited here, which was right while there was one business calendar and wrong the
 * moment there could be several: a workspace with a workshop calendar and a delivery
 * calendar is not editing "the bot's dates", it is keeping a diary — and a diary belongs on
 * a page of its own rather than four clicks inside one chatbot's settings.
 *
 * What is left here is the answer to the question this tab is actually asked: what does this
 * bot know about dates. Every calendar, because every calendar is read by every bot.
 */
function DatesPointer({ draft, set, options }: Fields) {
  const soon = [...options.events]
    .filter((e) => draft.calendarIds.includes(e.calendar_id))
    .filter((e) => (e.ends_on ?? e.starts_on) >= new Date().toISOString().slice(0, 10))
    .slice(0, 6)

  return (
    <div className="fieldset">
      <div className="field wide">
        <label>Calendars</label>
        <p className="note" style={{ marginTop: 0 }}>
          Which of them this bot may read, a whole calendar at a time — the same as the knowledge bases
          above. Dates are kept on the <Link to="/calendar">Calendar</Link>, and one your team mentions in a
          conversation lands on whichever of these you choose when you approve it.
        </p>

        {options.calendars.length === 0 ? (
          <p className="note">
            None yet. <Link to="/calendar">Make one</Link> and it can be ticked here.
          </p>
        ) : (
          <div className="picker">
            {options.calendars.map((c) => (
              <label key={c.id} className="pick">
                <input
                  type="checkbox"
                  checked={draft.calendarIds.includes(c.id)}
                  onChange={() =>
                    set(
                      'calendarIds',
                      draft.calendarIds.includes(c.id)
                        ? draft.calendarIds.filter((x) => x !== c.id)
                        : [...draft.calendarIds, c.id],
                    )
                  }
                />
                <span>
                  {c.name}
                  <span className="note">
                    {c.events} date{c.events === 1 ? '' : 's'}
                    {c.description ? ` · ${c.description}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {options.calendars.length > 0 && draft.calendarIds.length === 0 && (
          <p className="note" style={{ marginTop: 8 }}>
            Nothing ticked, so this bot knows no dates at all — it will hand off anything asking when.
          </p>
        )}

        {options.events.length === 0 ? (
          <p className="note">Nothing recorded yet.</p>
        ) : (
          <div className="pricelist">
            {soon.map((e) => (
              <div key={e.id} className="pricerow">
                <span className="what">
                  <b>{e.title}</b>
                  {e.source === 'learned' && <span className="pill">learned</span>}
                  <small>
                    {e.starts_on}
                    {e.ends_on ? ` to ${e.ends_on}` : ''}
                    {e.start_time === '00:00' && e.end_time === '23:59' ? ' · all day' : ` · ${e.start_time}–${e.end_time}`}
                    {e.repeats !== 'once' ? ` · every ${e.repeats.replace('ly', '')}` : ''}
                  </small>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <Link className="button ghost small" to="/calendar">
            Open the calendar ›
          </Link>
          <span className="note">
            {options.events.length} date{options.events.length === 1 ? '' : 's'} in all
          </span>
        </div>
      </div>
    </div>
  )
}


// ---------------------------------------------------------------- channels

function Channels({ draft, set, options }: Fields) {
  const has = (c: Connection) => draft.connections.some((x) => x.channel === c.channel && x.connection_ref === c.ref)
  const toggle = (c: Connection) =>
    set(
      'connections',
      has(c)
        ? draft.connections.filter((x) => !(x.channel === c.channel && x.connection_ref === c.ref))
        : [...draft.connections, { channel: c.channel, connection_ref: c.ref }],
    )

  const byChannel = options.connections.reduce<Record<string, Connection[]>>((acc, c) => {
    ;(acc[c.channel] ??= []).push(c)
    return acc
  }, {})

  return (
    <div className="fieldset">
      <div className="field wide">
        {options.connections.length === 0 ? (
          <p className="note">
            Nothing connected yet. Set up a widget, a Telegram bot, a WhatsApp number or a mailbox under
            Connectors, then come back and point this bot at it.
          </p>
        ) : (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              Pick the places this bot answers. Anywhere you leave unpicked still receives messages — they are
              filed and handed to a person, never dropped.
            </p>
            {Object.entries(byChannel).map(([channel, list]) => (
              <div key={channel} style={{ marginTop: 14 }}>
                <div className="sect" style={{ padding: '0 0 6px' }}>
                  {CHANNEL_LABEL[channel as ChannelId]}
                </div>
                <div className="picker">
                  {list.map((c) => (
                    <label key={`${c.channel}:${c.ref}`} className="pick">
                      <input type="checkbox" checked={has(c)} onChange={() => toggle(c)} />
                      <span>
                        {c.label}
                        {c.takenBy && !has(c) && (
                          <span className="note">
                            answered by {c.takenBy} — picking it here moves it
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- tools

/**
 * A tool is something the model decides to use on its own, mid-answer. That is why each is
 * granted deliberately rather than switched on for everyone: the model chooses, so the
 * choice of what it may choose from belongs to whoever configured the bot.
 */
function Tools({ draft, set, options }: Fields) {
  const toggle = (id: ToolId) =>
    set('tools', draft.tools.includes(id) ? draft.tools.filter((t) => t !== id) : [...draft.tools, id])

  return (
    <div className="fieldset">
      <div className="field wide">
        <p className="note" style={{ marginTop: 0 }}>
          Nothing is on by default. Every tool the bot holds is one more thing it can decide to do without
          asking, so each is a deliberate grant.
        </p>
        <div className="picker" style={{ maxHeight: 'none' }}>
          {TOOL_IDS.map((id) => {
            const why = options.toolsReady[id]
            return (
              <label key={id} className="pick">
                <input
                  type="checkbox"
                  checked={draft.tools.includes(id)}
                  onChange={() => toggle(id)}
                />
                <span>
                  <strong style={{ fontSize: 14 }}>{TOOLS[id].name}</strong>
                  {/*
                    A tool the server cannot run is still tickable. Turning it on now and
                    setting the key later is a reasonable order to do things in, and the bot
                    is told plainly that it is unavailable rather than silently getting
                    nothing back.
                  */}
                  {why && <span className="pill warn" style={{ marginLeft: 8 }}>needs setup</span>}
                  <span className="note">{TOOLS[id].blurb}</span>
                  {why && <span className="note" style={{ color: 'var(--warn-ink)' }}>{why}</span>}
                </span>
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- behaviour

function Behaviour({ draft, set, options }: Fields) {
  const offered = options.models.models
  // Set to something this provider will not answer to. Worth saying out loud: the call still
  // works, because it quietly falls back, so the only symptom is a bot not running on what
  // the page says it runs on.
  const stale = !!draft.model && !offered.some((m) => m.id === draft.model)

  return (
    <Split
      panes={[
        {
          id: 'voice',
          label: 'House style',
          hint: 'How it sounds',
          body: (
            <div className="fieldset">
      <div className="field wide">
        <label htmlFor="persona">House style</label>
        <textarea
          id="persona"
          rows={4}
          value={draft.persona}
          onChange={(e) => set('persona', e.target.value)}
        />
        <p className="note">
          Added to the safety rules, not instead of them. It will still refuse to invent policies, still treat
          crawled pages as data rather than instructions, and still hand off rather than guess.
        </p>
      </div>

            </div>
          ),
        },
        {
          id: 'answering',
          label: 'When it answers',
          hint: 'Confidence, sources, model',
          body: (
            <div className="fieldset">
      <div className="field">
        <label htmlFor="floor">Hand off below {draft.confidence_floor.toFixed(2)} confidence</label>
        <input
          id="floor"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={draft.confidence_floor}
          onChange={(e) => set('confidence_floor', Number(e.target.value))}
        />
        <p className="note">
          Checked after the model answers, so it cannot talk its way past it. 1 sends everything to a person.
        </p>
      </div>

      <div className="field">
        <label htmlFor="model">Model</label>
        {/*
          A select, never a blank box. An empty text input reads as "unset, and I should
          probably type something", when the honest state is "follow the server" — which is
          the right answer for almost everyone and is now the thing that is actually
          selected.
        */}
        <select id="model" value={draft.model} onChange={(e) => set('model', e.target.value)}>
          <option value="">
            {options.models.fallback ? 'Default (' + options.models.fallback + ')' : 'Server default'}
          </option>
          {/*
            A model already saved that is not in the list stays selectable, so opening the
            page and saving it cannot silently move a bot off the model it was running on —
            and after a provider change it is how you can still see what it was set to.
          */}
          {(!draft.model || offered.some((m) => m.id === draft.model)
            ? offered
            : [{ id: draft.model, label: draft.model + ' — not offered by this provider', tier: null }, ...offered]
          ).map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.tier ? ' · ' + m.tier : ''}
            </option>
          ))}
        </select>
        <p className="note">
          {!options.model
            ? 'No Autobricks key on this workspace — every question goes to a person until one is saved in Settings.'
            : 'Your Autobricks key, so this is its live catalogue. Premium models need credit on that account.'}
          {stale && ' This bot is set to a model this provider does not offer, so it is running on the default instead.'}
        </p>
      </div>

      <div className="field wide">
        <label className="switch">
          <input type="checkbox" checked={draft.strict_kb} onChange={(e) => set('strict_kb', e.target.checked)} />
          <span>
            <strong>Answer only from the knowledge base</strong>
            <span className="note">
              {draft.strict_kb
                ? 'A question the sources do not cover goes to a person.'
                : 'Off: it may answer from general knowledge and will say when it does. This is the setting most likely to produce a confident invented policy.'}
            </span>
          </span>
        </label>
      </div>

            </div>
          ),
        },
        {
          id: 'guardrails',
          label: 'Guardrails',
          hint: 'What it must hand off or refuse',
          body: (
            <div className="fieldset">
      <div className="field wide">
        <strong style={{ fontSize: 15 }}>Guardrails</strong>
        <p className="note" style={{ marginTop: 4 }}>
          The lists below hold for any business. Add the rules that only apply to yours — anything the
          bot must always hand to a person, and anything it must not discuss at all.
        </p>
      </div>

      <div className="field">
        <label htmlFor="escalate">Always hand off</label>
        <textarea
          id="escalate"
          rows={9}
          value={draft.escalate}
          onChange={(e) => set('escalate', e.target.value)}
        />
        <p className="note">One subject per line. However confident it is.</p>
      </div>

      <div className="field">
        <label htmlFor="forbidden">Never discuss</label>
        <textarea
          id="forbidden"
          rows={9}
          value={draft.forbidden}
          onChange={(e) => set('forbidden', e.target.value)}
        />
        <p className="note">Refused outright, then handed to a person.</p>
      </div>
            </div>
          ),
        },
      ]}
    />
  )
}


/**
 * One product, corrected in place.
 *
 * The same fields it is added with, filled in. Kept beside the list rather than in a dialog
 * because the reason to open it is almost always a price that looks wrong next to the one
 * above it — and closing that comparison to edit is what makes somebody give up and retype
 * the whole row.
 */
function EditProduct({
  product,
  busy,
  onCancel,
  onSave,
}: {
  product: Options['products'][number]
  busy: string
  onCancel: () => void
  onSave: (v: Record<string, unknown>) => void
}) {
  const [v, setV] = useState({
    name: product.name,
    description: product.description ?? '',
    sku: product.sku ?? '',
    // Text, not a number: an empty box has to mean "on request" rather than nought.
    price: product.price === null ? '' : String(product.price),
    currency: product.currency ?? 'SGD',
    unit: product.unit ?? '',
  })

  return (
    <div className="card" style={{ margin: '8px 0' }}>
      <div className="fields">
        <div>
          <label htmlFor={`e-name-${product.id}`}>Name</label>
          <input id={`e-name-${product.id}`} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
        <div>
          <label htmlFor={`e-sku-${product.id}`}>Code</label>
          <input
            id={`e-sku-${product.id}`}
            placeholder="Optional"
            value={v.sku}
            onChange={(e) => setV({ ...v, sku: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`e-price-${product.id}`}>Price</label>
          <input
            id={`e-price-${product.id}`}
            type="number"
            min={0}
            step="0.01"
            placeholder="Blank for on request"
            value={v.price}
            onChange={(e) => setV({ ...v, price: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`e-cur-${product.id}`}>Currency</label>
          <input id={`e-cur-${product.id}`} value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value })} />
        </div>
        <div>
          <label htmlFor={`e-unit-${product.id}`}>Per</label>
          <input
            id={`e-unit-${product.id}`}
            placeholder="each, per month…"
            value={v.unit}
            onChange={(e) => setV({ ...v, unit: e.target.value })}
          />
        </div>
      </div>
      <div className="field wide" style={{ marginTop: 12 }}>
        <label htmlFor={`e-desc-${product.id}`}>What it is</label>
        <input
          id={`e-desc-${product.id}`}
          placeholder="In the words a customer would use"
          value={v.description}
          onChange={(e) => setV({ ...v, description: e.target.value })}
        />
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button
          className="small"
          disabled={!v.name.trim() || !!busy}
          onClick={() => onSave({ ...v, price: v.price === '' ? null : Number(v.price) })}
        >
          {busy === 'edit' ? 'Saving…' : 'Save'}
        </button>
        <button className="ghost small" disabled={!!busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
