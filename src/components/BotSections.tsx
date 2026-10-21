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
import { BOT_DEFAULTS, LESSONS_PAGE, STANDARD_BASES, TOOLS, TOOL_IDS, calendarRange, looksPersonal, looksStale, shiftCalendar, todayFor } from '../types'
import type { BotMode, ChannelId, ToolId } from '../types'
import { Peek, lightDismiss } from './Modal'
import { Pager } from './Pager'

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
  /** The one board this bot keeps. Null means it answers and moves nobody. */
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

/**
 * Several days of one thing, written the way somebody would say them.
 *
 * "15, 17 & 18 Sept 2026" rather than three dates in full: the month and the year are the same
 * for all of them, and repeating those is what made three class days need three cards.
 */
const asDays = (days: string[]) => {
  const sorted = [...new Set(days)].sort()
  if (sorted.length < 2) return sorted[0] ? asDay(sorted[0]) : ''
  const last = sorted[sorted.length - 1]
  // Only worth compressing when they share a month; across months each stands on its own.
  const oneMonth = sorted.every((d) => d.slice(0, 7) === last.slice(0, 7))
  if (!oneMonth) return sorted.map(asDay).join(', ')
  const heads = sorted.slice(0, -1).map((d) => String(Number(d.slice(8))))
  return `${heads.join(', ')} & ${asDay(last)}`
}

export type Options = {
  /**
   * Ask the server to work guardrails out from this bot's knowledge base.
   *
   * Passed in rather than imported, because this file is shared with the new-bot page where
   * there is no bot to read a knowledge base for — and there it is simply absent.
   */
  /** The base this bot's approved facts are filed in. Null until the first one is approved. */
  learnedBase?: { id: number; name: string; documents: number; passages: number } | null
  /** Which resources are already attached to which approved example. */
  lessonResources?: { lesson_id: number; id: number }[]
  /** Correct an example's wording, and set the files that go out with it. */
  onEditExample?: (input: { id: number; question: string; answer: string; resourceIds: number[] }) => Promise<void>
  /** Turn down a proposed wording so it stops being offered. */
  onDismissSuggestion?: (id: number) => Promise<void>
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
    /** How a file is fetched. Already public — it is the address customers are sent. */
    token: string
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
  /** Filling in the hour a learned date arrived without. */
  onLessonTimes?: (input: { id: number; start_time?: string | null; end_time?: string | null }) => Promise<void>
  /** Saving a product or a date. Absent in the wizard, where the workspace has no bot yet. */
  onProduct?: (input: { id?: number; remove?: boolean; [k: string]: unknown }) => Promise<void>
  onEvent?: (input: { id?: number; remove?: boolean; [k: string]: unknown }) => Promise<void>

  /**
   * This bot's own training material: how much is waiting to be judged, and what is in use.
   *
   * Counts rather than the queue, because the queue is fetched a page at a time through
   * `onQueue` once somebody opens the review door. Sending every proposal on every page load,
   * and again after every approval, is most of the payload on a bot that has been running a
   * while.
   */
  lessons: { counts: Record<string, number>; deployed: Lesson[] }
  /** One page of the review queue, for the kind and search currently on screen. */
  onQueue?: (q: { kind: string; find: string; page: number }) => Promise<{
    rows: Lesson[]
    matched: number
    cards: number
  }>
  /** Approving is a decision about this bot, so it saves at once rather than on Save. */
  onDecide?: (input: {
    ids: number[]
    status: 'approved' | 'rejected'
    crossed?: { lesson: number; file: number }[]
  }) => Promise<void>
  /** Read this bot's conversations now. Returns how many proposals it found. */
  onScan?: () => Promise<{ found: number; failed: number }>
  /** Read a knowledge base for products, returning what it made of it. */
  onReadCatalogue?: (baseId: number) => Promise<{ found: number; added: number; known: number; read: number; more: boolean }>
}

/** One thing a bot picked up from a conversation a person answered. */
/**
 * Near-copies folded under the one that leads them.
 *
 * `similar_to` points at another lesson that says the same thing, and the server only ever
 * points at a row that leads a group itself -- so a leader is never also a follower and there
 * is no chain to walk here. A row with no leader leads its own group of one.
 *
 * Order is the order the rows arrived in. A leader keeps the position it would have had and
 * its followers move up beneath it, rather than staying where they were.
 */
function cluster(rows: Lesson[]) {
  const out: { leader: Lesson; also: Lesson[] }[] = []
  const seats = new Map<number, { leader: Lesson; also: Lesson[] }>()
  // Two passes: a follower can appear before its leader in the list's order, and it has to
  // find a seat that already exists.
  for (const l of rows)
    if (!l.similar_to) {
      const seat = { leader: l, also: [] as Lesson[] }
      seats.set(l.id, seat)
      out.push(seat)
    }
  for (const l of rows) {
    if (!l.similar_to) continue
    const seat = seats.get(l.similar_to)
    // A leader that is somehow not on screen would take its followers with it. Showing the row
    // on its own is the harmless way to be wrong.
    if (seat) seat.also.push(l)
    else out.push({ leader: l, also: [] })
  }
  return out
}

export type Lesson = {
  id: number
  /** An older pending proposal that says nearly the same thing, when the server found one. */
  similar_to?: number | null
  /** A proposed rewrite waiting on a person. Empty when it was looked at and left alone. */
  suggested?: string | null
  suggested_question?: string | null
  /** On a pending example: the files its conversation sent, which approving it will attach. */
  will_send?: { id: number; title: string; status: string; attachment_id: number | null; mime: string | null }[] | null
  kind: 'example' | 'fact' | 'resource' | 'event' | 'product' | 'contact'
  question: string | null
  answer: string
  /** For a fact: the closest thing the knowledge base already says. */
  nearest: string | null
  /** The thread it came out of, so a reviewer can read it before deciding. */
  conversation_id: number | null
  created_at: string
  /** For a date proposal: when it happens, and whether it comes round again. */
  starts_on?: string | null
  ends_on?: string | null
  repeats?: string | null
  /** HH:MM, or null when nobody has said what time yet. */
  start_time?: string | null
  end_time?: string | null
  /** Which calendar it will be filed on, once somebody has chosen. */
  calendar_id?: number | null
  /** For a product proposal: what it costs, if the team said so. */
  price?: number | null
  currency?: string | null
  unit?: string | null
  /** For a file proposal: which file, and what it is. */
  attachment_id: number | null
  file_mime: string | null
  file_size: number | null
  /** For a contact proposal: whose card, which column, and what it says there now. */
  customer_id?: number | null
  field?: string | null
  customer_name?: string | null
  current?: string | null
}

export const SECTIONS = [
  { id: 'identity', label: 'Identity', hint: 'Name and what it should know about you' },
  { id: 'knowledge', label: 'Knowledge and attachments', hint: 'What it may answer from, and what it may send' },
  // Straight after Knowledge, because it is the same question asked twice: that section is
  // what this bot may read, this one is what it learned from the people who answer for it.
  { id: 'training', label: 'Training', hint: 'What it learned from your team' },
  // Where it answers and what it can do, together: both are "what this bot is wired to",
  // both are a list of checkboxes, and neither was ever a page's worth on its own.
  { id: 'channels', label: 'Channels and tools', hint: 'Where it answers, what it can do, whose board it fills' },
  { id: 'behaviour', label: 'Behaviour and guardrails', hint: 'Tone, limits and model' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

/**
 * What a fresh workspace's own defaults look like, if it still has them.
 *
 * Matched by name/flag rather than "whatever sorts first" — a workspace with several
 * projects or several bases by the time a second bot is made has no first one worth
 * guessing at, and this is meant to fill in the obvious starting point, not a guess.
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
  // The board every workspace starts with, if it is still called that — a bot pointed at a
  // board somebody renamed or made a second one of would be a guess, not a default.
  confidence_floor: 0.45,
  strict_kb: true,
  escalate: BOT_DEFAULTS.escalate,
  forbidden: BOT_DEFAULTS.forbidden,
  resourceIds: [],
  // On by default for any tool that needs nothing beyond what the app already has; one
  // that needs its own credential (web search) stays off until that is set up.
  tools: TOOL_IDS.filter((id) => TOOLS[id].needs === null),
  mode: BOT_DEFAULTS.mode,
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
  if (section === 'training') return <Training draft={draft} set={set} options={options} />
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

// ---------------------------------------------------------------- training

/**
 * What this bot learned from the people who answered for it, and what it is using.
 *
 * Per bot, and that is not an implementation detail: a lesson came out of a conversation
 * this bot was handling, in the words its own customers were given. A support bot's phrasing
 * is not a sales bot's, and approving one for the wrong bot is how a sales bot starts
 * sounding like a returns desk.
 *
 * Approving saves immediately rather than waiting for Save at the bottom of the page. It is
 * a decision about a row, not an edit to a draft, and leaving ten approvals unsaved next to
 * a Save button that is about the prompt is how somebody loses them.
 */
/**
 * What the bot has learned, and what it wants permission to learn.
 *
 * This is a review queue before it is a settings page, and it was laid out as neither: one
 * column of near-identical cards where the customer's question, the team's answer and the
 * knowledge base's opinion were all the same size, and nothing said where any of it came
 * from. A reviewer has one question per row — *is this true and should it be said again* —
 * and answering it needs the source, the shape of the exchange, and a way to move on fast.
 */
function Training({ draft, set, options }: Fields) {
  const [picked, setPicked] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState('')
  const [showExamples, setShowExamples] = useState(false)
  /*
   * The queue is behind a door.
   *
   * What this bot has actually learned is the thing somebody opens this page to see, and it
   * was underneath three groups of proposals nobody had judged yet — so the page read as a
   * chore even when the queue was empty. Reviewing is a session of its own: it happens
   * rarely, it wants the whole width, and it ends.
   */
  const [reviewing, setReviewing] = useState(false)

  const { counts, deployed } = options.lessons
  const waiting = Object.values(counts).reduce((n, c) => n + c, 0)

  /*
   * The queue, by kind, with what approving one actually does.
   *
   * Empty kinds are left out rather than shown as a nought: a tab you cannot open is a
   * question about why not.
   */
  const KINDS = [
    {
      id: 'example',
      label: 'Ways to answer',
      blurb:
        'Shown to the model when a similar question arrives. Shapes wording and length, not facts — those still come from the knowledge base.',
    },
    {
      id: 'product',
      label: 'Products',
      blurb:
        'Named by your team and not on the price list. Approving one adds it under Products and prices, where you can correct what it costs — and the bot quotes it from there.',
    },
    {
      id: 'event',
      label: 'Dates',
      blurb:
        'A closure, a launch or an event your team mentioned that is not on the calendar. Approving one puts it under Important dates. Nothing a customer said about their own booking reaches here.',
    },
    {
      id: 'resource',
      label: 'Files and links',
      blurb:
        "Something your team attached or linked to. Approving one adds it to this bot's resources, sent whole when a customer asks for what the line beneath it describes. Its own tick: approving the sentence that mentioned a file does not send the file.",
    },
    {
      id: 'fact',
      label: 'Facts',
      blurb:
        'Approving one files it in the knowledge base, where it can be quoted with a citation. Check it is true and still current — it was said once, in one conversation.',
    },
  ]

  /*
   * Which tab is open, remembered by kind rather than by position.
   *
   * Approving everything in one tab empties it and it disappears, so an index would land on
   * whatever slid into its place. Falling back to the first remaining kind puts somebody on the
   * next real thing to look at -- derived rather than stored, so the correction happens in the
   * same render as the emptying instead of one fetch later.
   */
  const [kind, setKind] = useState('example')
  const live = KINDS.filter((k) => (counts[k.id] ?? 0) > 0)
  const open = live.some((k) => k.id === kind) ? kind : (live[0]?.id ?? 'example')

  /*
   * Narrowing the queue by what a proposal says.
   *
   * In SQL now rather than in the browser. A page holds twenty-five cards, and a box that
   * searched only the rows it had been handed would be answering a narrower question than it
   * looks like it answers -- the mistake contacts.tsx was fixed for. Debounced, so a keystroke
   * is not a query.
   */
  const [find, setFind] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(find.trim()), 250)
    return () => clearTimeout(t)
  }, [find])

  const [page, setPage] = useState(0)
  /** Bumped to read the page again in place, after a decision or a scan. */
  const [nonce, setNonce] = useState(0)
  const [shown, setShown] = useState<{ rows: Lesson[]; matched: number; cards: number }>({
    rows: [],
    matched: 0,
    cards: 0,
  })

  // A new kind or a new search starts at the top. Staying on page seven of a list that now has
  // two is how a search looks broken.
  useEffect(() => setPage(0), [open, term])

  /*
   * Changing a date's hours, then reading the page again.
   *
   * The loader is no longer invalidated for this -- it is the whole chatbot, which was thirteen
   * seconds of work to show one changed time field. The queue is this component's own state, so
   * re-reading it is the smaller and more honest refresh.
   *
   * ponytail: the hours are half of what makes two dates the same event, so the row leaves its
   * group until the grouping sweep catches up a tick later. Recomputing it here would put that
   * work back on somebody's click.
   */
  const onTimes =
    options.onLessonTimes &&
    (async (input: { id: number; start_time?: string | null; end_time?: string | null }) => {
      await options.onLessonTimes!(input)
      setNonce((n) => n + 1)
    })

  const ask = options.onQueue
  useEffect(() => {
    if (!ask) return
    /*
     * One answer at a time. Typing fast enough to overlap two reads would otherwise let the
     * slower one land last and put an older page on screen.
     */
    let current = true
    ask({ kind: open, find: term, page }).then((r) => {
      if (current) setShown(r)
    })
    return () => {
      current = false
    }
    /*
     * `ask` is deliberately not a dependency. It is rebuilt on every render of the page that
     * owns it, so including it here is an endless fetch -- and its identity never carries
     * information, only its arguments do.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, term, page, nonce])

  const groups = live.map((k) => ({
    ...k,
    total: counts[k.id] ?? 0,
    // Only the open tab has rows: the others are a count and a label until somebody asks.
    rows: k.id === open ? cluster(shown.rows) : [],
    matched: k.id === open ? shown.matched : (counts[k.id] ?? 0),
  }))
  const group = groups.find((g) => g.id === open) ?? groups[0]
  /*
   * What "select all" ticks: one per group, not one per card.
   *
   * This is the whole point of the folding. A queue of thirty-nine examples where a third are
   * rewordings of each other used to be one click, and that click is how the near-copies got
   * into the approved list in the first place. A follower is still approvable -- its own
   * checkbox is right there under the disclosure -- but it has to be chosen.
   *
   * It follows the search for free, because group.rows is already the filtered clusters. That
   * matters more than it looks: a Select all that reached rows the search was hiding would
   * approve things nobody had seen, which is the failure the folding exists to prevent.
   */
  /*
   * What one card stands for, and what ticking it decides.
   *
   * For most kinds a card is a row: tick the leader, approve the leader. A date is not -- a
   * course meeting on the 15th, 17th and 18th is one decision that has to write three rows,
   * and nine customers asking about it produced nine wordings of each. So a date group folds
   * to its distinct days, oldest proposal of each, and the card carries all three.
   */
  const asOneCard = (leader: Lesson, also: Lesson[]) => {
    if (leader.kind !== 'event') return { days: [] as Lesson[], ids: [leader.id] }
    const byDay = new Map<string, Lesson>()
    for (const l of [leader, ...also].sort((a, b) => a.id - b.id))
      if (l.starts_on && !byDay.has(l.starts_on)) byDay.set(l.starts_on, l)
    const days = [...byDay.values()].sort((a, b) => (a.starts_on! < b.starts_on! ? -1 : 1))
    return { days, ids: days.length ? days.map((d) => d.id) : [leader.id] }
  }

  const here = group?.rows.flatMap((r) => asOneCard(r.leader, r.also).ids) ?? []

  // The same three kinds again, on the other side of the decision.
  const inUse = deployed.filter((l) => l.kind === 'example')
  const canSend = deployed.filter((l) => l.kind === 'resource')
  const filed = deployed.filter((l) => l.kind === 'fact')

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  /** A card that stands for several rows ticks and unticks them together. */
  const toggleAll = (ids: number[]) =>
    setPicked((p) => (ids.every((i) => p.includes(i)) ? p.filter((i) => !ids.includes(i)) : [...new Set([...p, ...ids])]))

  /*
   * Files crossed off an answer, keyed by the pair rather than by the file.
   *
   * The same file legitimately belongs with one answer from a thread and not with another,
   * so crossing it off here must not cross it off there. Held until the tick, then sent with
   * it -- nothing is written while somebody is still making up their mind.
   */
  const [crossed, setCrossed] = useState<string[]>([])
  /** The files crossed off one answer, as the badge row wants them. */
  const crossedOn = (lesson: number) =>
    crossed.filter((k) => k.startsWith(`${lesson}:`)).map((k) => k.split(':')[1])
  const cross = (lesson: number, file: number) =>
    setCrossed((c) => (c.includes(`${lesson}:${file}`) ? c.filter((k) => k !== `${lesson}:${file}`) : [...c, `${lesson}:${file}`]))

  const act = async (ids: number[], status: 'approved' | 'rejected') => {
    if (!options.onDecide || !ids.length) return
    setBusy(true)
    setErr('')
    try {
      await options.onDecide({
        ids,
        status,
        crossed: crossed.map((k) => k.split(':').map(Number)).map(([lesson, file]) => ({ lesson, file })),
      })
      setPicked([])
      /*
       * Read this page again. The rows that were just decided have left the queue, so the page
       * under them shifts up -- and the queue is this component's own state now, not the
       * loader's. The counts behind the tabs come from the loader, which onDecide invalidates.
       */
      setNonce((n) => n + 1)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    if (!options.onScan) return
    setScanning(true)
    setScanned('')
    try {
      const { found, failed } = await options.onScan()
      // New proposals, so the page on screen is already out of date.
      setNonce((n) => n + 1)
      /*
       * Three answers, not two.
       *
       * A thread that threw used to be reported as "nothing new worth teaching" — the same
       * sentence as a thread with genuinely nothing in it. Somebody asking "are you sure?"
       * had no way to tell, and the honest answer was that nobody could.
       */
      setScanned(
        failed
          ? `Could not read ${failed} of them — check the server log.`
          : found
            ? `${found} new proposal${found === 1 ? '' : 's'}.`
            : 'Nothing new worth teaching in those.',
      )
    } catch (e) {
      setScanned(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  return (
    <Split
      panes={[
        {
          id: 'learned',
          label: 'What it has learned',
          hint: 'In use, and waiting on you',
          body: (
            <div className="fieldset training">
      {err && (
        <div className="field wide">
          <p className="err">{err}</p>
        </div>
      )}

      {!options.onDecide ? (
        <div className="field wide">
          <p className="note">
            Nothing to review yet — this bot does not exist until you finish. Come back once it has answered
            a few customers and your team has stepped in.
          </p>
        </div>
      ) : (
        <>
          {/*
            What it has learned, first — this is the answer to "did that approval do
            anything", and it used to be at the bottom of the page under the queue.
          */}
          <div className="field wide">
            <div className="queuehead">
              <div>
                <h3>What it has learned</h3>
                <p className="note">
                  {deployed.length
                    ? `${inUse.length} way${inUse.length === 1 ? '' : 's'} to answer · ${filed.length} fact${filed.length === 1 ? '' : 's'}`
                    : 'Nothing approved yet. Anything waiting below goes to work the moment you approve it.'}
                </p>
              </div>
              {options.onScan && draft.learns && (
                <div className="row">
                  {scanned && <span className="note">{scanned}</span>}
                  {/*
                    One button, not two.

                    There was a second here — "read imported chats" — for the chats that come
                    off a phone when a number is linked. Those need lifting out of the
                    already-read state they are filed in, which is a different action from
                    reading, so it got its own control. Two buttons both meaning "read my
                    conversations" is a distinction the person pressing them does not have,
                    and the one they pressed was usually the wrong one.
                    `lessons.scan()` now does both: imported threads are adopted, unstamped
                    and read alongside everything else that has moved since it was last read.
                  */}
                  <button type="button" className="ghost small" disabled={scanning} onClick={scan}>
                    {scanning ? 'Reading…' : 'Read conversations now'}
                  </button>
                </div>
              )}
            </div>

            {/*
              A door, not a pile.

              These are read when something is wrong with one, not browsed — so the page says
              how many there are and opens them on request. The list of files it can send used
              to sit here too and is gone: the same files are on the Knowledge page, where they
              can be given to any bot, and printing them twice made this page look like the
              place to manage them.
            */}
            {inUse.length > 0 && (
              <section className="lessongroup">
                <header className="queuehead">
                  <div>
                    <h4>Ways it answers</h4>
                    <p className="note">
                      {inUse.length} answer{inUse.length === 1 ? '' : 's'} shown to the model when a customer
                      asks something similar — with whichever files went with them.
                    </p>
                  </div>
                  <button type="button" className="ghost small" onClick={() => setShowExamples(true)}>
                    Review and edit
                  </button>
                </header>
              </section>
            )}

            {filed.length > 0 && (
              <section className="lessongroup">
                <header className="queuehead">
                  <div>
                    <h4>Facts it filed</h4>
                    <p className="note">
                      {filed.length} fact{filed.length === 1 ? '' : 's'} in{' '}
                      <strong>{options.learnedBase?.name ?? `Learned by ${draft.name || 'this bot'}`}</strong>,
                      quoted back with a citation whenever one answers a question.
                    </p>
                    <p className="note">
                      {/*
                        Pointed at rather than reprinted. A hundred learned facts is a knowledge
                        base, and the place to read, correct or delete one is the knowledge base —
                        not a copy on a settings tab that can only be retired wholesale.
                      */}
                      Read and edit them there. Retiring a fact here only stops it being offered again; it
                      does not remove what is already filed.
                    </p>
                  </div>
                  {options.learnedBase && (
                    <a className="pill" href={`/knowledge/${options.learnedBase.id}`}>
                      Open knowledge base
                    </a>
                  )}
                </header>
              </section>
            )}
          </div>

          {showExamples && (
            <Examples
              lessons={inUse}
              resources={options.resources}
              attached={options.lessonResources ?? []}
              onSave={options.onEditExample}
              onDismissSuggestion={options.onDismissSuggestion}
              onRetire={(id) => act([id], 'rejected')}
              onClose={() => setShowExamples(false)}
            />
          )}

          {/* The queue, as a door rather than a pile. */}
          <div className="field wide">
            <button
              type="button"
              className={`approvebar${waiting ? ' waiting' : ''}`}
              onClick={() => setReviewing(true)}
              disabled={!waiting}
            >
              <span className="count">{waiting}</span>
              <span>
                <strong>Training to Approve</strong>
                <span className="note">
                  {/* Read off the counts rather than off the rows, which are no longer all here. */}
                  {waiting
                    ? `${counts.example ?? 0} way${(counts.example ?? 0) === 1 ? '' : 's'} to answer · ${counts.resource ?? 0} file${(counts.resource ?? 0) === 1 ? '' : 's'} and link${(counts.resource ?? 0) === 1 ? '' : 's'} · ${counts.fact ?? 0} fact${(counts.fact ?? 0) === 1 ? '' : 's'} — none of it live until you say so`
                    : draft.learns
                      ? 'Nothing waiting. Threads are read a few minutes after they go quiet.'
                      : 'Switch learning on above to start collecting.'}
                </span>
              </span>
              {waiting > 0 && <span className="go">Review ›</span>}
            </button>
          </div>

          {reviewing && group && (
            <ReviewModal
              onClose={() => {
                setReviewing(false)
                setPicked([])
              }}
            >
              <>
                {/*
                  One kind at a time.

                  Five groups down one column meant scrolling past three decisions to reach
                  the fourth, and they are not the same decision: a way of answering is a
                  matter of taste, a price is a fact somebody has to be sure of, and a date
                  is a thing to check against a calendar. Reviewing them mixed together is
                  how a queue gets approved in one sweep without being read.
                */}
                <div className="seg small" role="tablist" aria-label="Kind of proposal">
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      role="tab"
                      aria-selected={g.id === group.id}
                      className={g.id === group.id ? 'on' : ''}
                      onClick={() => {
                        setKind(g.id)
                        setPicked([])
                      }}
                    >
                      {g.label} ({g.total})
                    </button>
                  ))}
                </div>

                {/*
                  Only once there is enough to be worth searching, the same rule the
                  attachment picker uses: a filter over five rows is furniture.
                */}
                {waiting > 6 && (
                  <input
                    className="search"
                    aria-label="Search this queue"
                    placeholder={`Search ${waiting} proposals`}
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                  />
                )}

                <div className="reviewbar">
                  <label className="check">
                    {/*
                      Scoped to what is on screen. "Select all" over a queue whose other four
                      fifths are hidden is a button that approves things nobody looked at.
                    */}
                    <input
                      type="checkbox"
                      checked={here.length > 0 && here.every((id) => picked.includes(id))}
                      ref={(el) => {
                        if (el)
                          el.indeterminate =
                            here.some((id) => picked.includes(id)) && !here.every((id) => picked.includes(id))
                      }}
                      onChange={() =>
                        setPicked((p) =>
                          here.every((id) => p.includes(id))
                            ? p.filter((id) => !here.includes(id))
                            : [...new Set([...p, ...here])],
                        )
                      }
                    />
                    <span>
                      <strong>{picked.length ? `${picked.length} selected` : `Select all ${group.label.toLowerCase()}`}</strong>
                    </span>
                  </label>
                  <span className="grow" />
                  <button
                    className="primary small"
                    disabled={!picked.length || busy}
                    onClick={() => act(picked, 'approved')}
                  >
                    {busy ? 'Saving…' : `Approve${picked.length ? ` ${picked.length}` : ''}`}
                  </button>
                  <button className="ghost small" disabled={!picked.length || busy} onClick={() => act(picked, 'rejected')}>
                    Reject
                  </button>
                </div>

                <section className="lessongroup">
                  <header>
                    <h4>{group.label}</h4>
                    <p className="note">{group.blurb}</p>
                    {/*
                      What the search left, then what the folding left. Two different reasons
                      for a shorter list, and running them into one sentence would make either
                      impossible to act on.
                    */}
                    {term && (
                      <p className="note">
                        {group.matched} of {group.total} match “{find.trim()}”. Approve and Select all reach only these.
                      </p>
                    )}
                    {shown.cards > group.rows.length && (
                      <p className="note">
                        {group.rows.length} of {shown.cards} card{shown.cards === 1 ? '' : 's'} shown, newest pages last.
                        Repeats are folded under the one that said it first.
                      </p>
                    )}
                  </header>
                  {group.rows.length === 0 && <p className="note">Nothing matches.</p>}
                  {group.rows.map(({ leader, also }) => {
                    const { days, ids } = asOneCard(leader, also)
                    // A date card covers every day of its course, so the fold underneath only
                    // has the other wordings left to show -- not days it is already carrying.
                    const rest = days.length ? also.filter((l) => !ids.includes(l.id)) : also
                    return (
                    <div key={leader.id} className={rest.length ? 'clustered' : undefined}>
                      <LessonCard
                        lesson={leader}
                        days={days}
                        picked={ids.every((i) => picked.includes(i))}
                        onToggle={() => toggleAll(ids)}
                        onTimes={onTimes}
                        calendars={options.calendars.filter((c) => draft.calendarIds.includes(c.id))}
                        crossed={crossedOn(leader.id)}
                        onCross={(file) => cross(leader.id, file)}
                      />
                      {/*
                        Shut to begin with. These are the ones somebody would otherwise read
                        four times and tick four times; open it when the one above looks like
                        the wrong wording of the two, not as a matter of course.

                        A follower that has been ticked forces it open, so nothing can be
                        approved from behind a fold.
                      */}
                      {rest.length > 0 && (
                        <details className="alike" open={rest.some((l) => picked.includes(l.id))}>
                          <summary>
                            {rest.length} more like this
                            {rest.some((l) => picked.includes(l.id)) &&
                              ` · ${rest.filter((l) => picked.includes(l.id)).length} selected`}
                          </summary>
                          {rest.map((l) => (
                            <LessonCard
                              key={l.id}
                              lesson={l}
                              picked={picked.includes(l.id)}
                              onToggle={() => toggle(l.id)}
                              onTimes={onTimes}
                              calendars={options.calendars.filter((c) => draft.calendarIds.includes(c.id))}
                              crossed={crossedOn(l.id)}
                              onCross={(file) => cross(l.id, file)}
                            />
                          ))}
                        </details>
                      )}
                    </div>
                    )
                  })}
                  {/*
                    Paged on the server, in cards rather than rows, so a group is never cut in
                    half by a page boundary. Pager draws nothing when there is only one page.
                  */}
                  <Pager at={page} pages={Math.ceil(shown.cards / LESSONS_PAGE)} setPage={setPage} />
                </section>
              </>
            </ReviewModal>
          )}
        </>
      )}
            </div>
          ),
        },
        {
          id: 'learning',
          label: 'Learning',
          hint: 'Whether it reads its own conversations',
          body: (
            <div className="fieldset training">
      {/* One line about how this works, then the switch. Everything below is the queue. */}
      <div className="field wide">
        <label className="switch">
          <input type="checkbox" checked={draft.learns} onChange={(e) => set('learns', e.target.checked)} />
          <span>
            <strong>Learn from human replies</strong>
            <span className="note">
              {draft.learns
                ? draft.mode === 'learning'
                  ? 'On, and this bot is watching rather than answering — every thread is training material.'
                  : 'On. A few minutes after a thread goes quiet it is read, and anything worth keeping is proposed here. Nothing reaches a customer until you approve it. Reading a conversation costs one model call against your own key.'
                : 'Off. Nothing is taken from these conversations.'}
            </span>
          </span>
        </label>
      </div>

            </div>
          ),
        },
      ]}
    />
  )
}

/**
 * The queue, given the whole screen while somebody is actually judging it.
 *
 * A native dialog: it closes on Escape, traps focus, and needs no scrim of our own. The
 * page underneath keeps its scroll position, so approving twenty rows and closing puts you
 * back where you were rather than at the top of a form.
 */
function ReviewModal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  return (
    <dialog ref={ref} className="sheet reviewsheet" onClick={lightDismiss} onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 17 }}>Training to approve</h3>
          <p className="note" style={{ margin: 0 }}>
            Tick what is true and worth repeating. Nothing here has reached a customer.
          </p>
        </div>
        {/* A form with method=dialog closes it natively, so this needs no handler. */}
        <form method="dialog">
          <button className="ghost small">Close</button>
        </form>
      </div>
      {children}
    </dialog>
  )
}

/** The part of a URL worth reading at a glance. Falls back to the whole thing. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Every quarter hour of the day, once.
 *
 * Built at module load rather than per render: it is the same ninety-six strings on every
 * card, and rebuilding them for each is work nobody asked for.
 */
const QUARTERS = Array.from({ length: 96 }, (_, i) => {
  const h = Math.floor(i / 4)
  const m = (i % 4) * 15
  const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  // Shown the way people say it, stored the way the database wants it.
  const hour = h % 12 === 0 ? 12 : h % 12
  return { value, label: `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}` }
})

/**
 * Picking a time, from a list rather than by typing into one.
 *
 * `<input type="time">` renders as `--:--` and wants a keyboard, which on a phone means a
 * spinner nobody can hit and a value that stays empty because the hour was typed and the
 * minutes were not. A select is one tap, cannot hold a half-finished time, and on a phone
 * is a native wheel.
 *
 * Quarter hours, because that is what businesses schedule on. A time that is not one of
 * them — 19:05, out of a conversation — is kept and offered rather than snapped to
 * something near it, which would silently move an event somebody was told about.
 */
function TimePick({
  value,
  onChange,
  id,
  allowNone = true,
}: {
  value: string
  onChange: (next: string) => void
  id?: string
  allowNone?: boolean
}) {
  const options = value && !QUARTERS.some((q) => q.value === value) ? [{ value, label: value }, ...QUARTERS] : QUARTERS

  return (
    <select id={id} className="timepick" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">—</option>}
      {options.map((q) => (
        <option key={q.value} value={q.value}>
          {q.label}
        </option>
      ))}
    </select>
  )
}

/** A day and a time, in the reader's own zone. */
const learnedAt = (at: string) =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * One proposal, laid out as the thing it is.
 *
 * An example is an exchange, so it reads as one: the question quoted and muted, the answer
 * below it in the company's own words. A fact is a claim, so the claim is the headline and
 * what the knowledge base already says sits under it for comparison. Both carry where they
 * came from, because "is this true" is usually answered by reading the conversation.
 */
function LessonCard({
  lesson,
  picked,
  onToggle,
  onTimes,
  calendars,
  crossed = [],
  onCross,
  days = [],
}: {
  lesson: Lesson
  picked: boolean
  onToggle: () => void
  /**
   * Every day this card covers, for a date that is one course meeting several times.
   *
   * Empty for a single day and for every other kind, where the card is one row and the row is
   * one thing.
   */
  days?: Lesson[]
  /** Ids of the files crossed off this answer, held by the queue until the tick. */
  crossed?: string[]
  onCross?: (file: number) => void
  /** Present on a date proposal, which may have arrived without an hour. */
  onTimes?: (input: {
    id: number
    start_time?: string | null
    end_time?: string | null
    calendar_id?: number | null
  }) => Promise<void>
  /** The calendars this bot may read — the only ones a date it learned may be filed on. */
  calendars?: Options['calendars']
}) {
  const [from, setFrom] = useState(lesson.start_time ?? '')
  const [to, setTo] = useState(lesson.end_time ?? '')
  const [cal, setCal] = useState(lesson.calendar_id ?? calendars?.[0]?.id ?? 0)
  return (
    <div className={`lessoncard${picked ? ' picked' : ''}`}>
      <label className="check">
        <input type="checkbox" checked={picked} onChange={onToggle} />
        <span className="body">
          {lesson.kind === 'resource' ? (
            /*
             * A file proposal is the file plus when to send it. The name and size are the
             * card, and the description underneath is what a customer's request will be
             * matched against — so it is the part worth reading before approving.
             */
            <>
              <span className="proposedfile">
                <span className="filekind" aria-hidden="true">
                  {lesson.attachment_id ? (lesson.answer.split('.').pop() ?? 'file').slice(0, 4).toUpperCase() : '↗'}
                </span>
                <span>
                  {/* A link's own address is the interesting half, so it is the one shown whole. */}
                  <b>{lesson.attachment_id ? lesson.answer : hostOf(lesson.answer)}</b>
                  <small>
                    {lesson.attachment_id
                      ? `${lesson.file_size ? `${Math.max(1, Math.round(lesson.file_size / 1024))} KB` : 'file'}${lesson.file_mime ? ` · ${lesson.file_mime}` : ''}`
                      : lesson.answer}
                  </small>
                </span>
              </span>
              <p className="said">Send it when somebody asks for {lesson.question}</p>
            </>
          ) : lesson.kind === 'contact' ? (
            /*
             * A change to one person's card: whose, which field, and what it would replace.
             *
             * What is there now is the half worth reading. Approving a birthday onto a blank
             * field is filling a gap; approving a company over one already filled is
             * overwriting what somebody typed, and those should not look the same.
             */
            <>
              <p className="factlabel">
                {lesson.customer_name ?? 'This contact'} · {lesson.question}
              </p>
              <p className="claim">{lesson.answer}</p>
              <p className="said">
                {lesson.current
                  ? `Replaces what the card says now: ${lesson.current}`
                  : 'The card has nothing in that field yet.'}
              </p>
            </>
          ) : lesson.kind === 'product' ? (
            /* A product is a name and a price, so it reads as a row of a price list. */
            <>
              <p className="claim">{lesson.answer}</p>
              <p className="said">
                {lesson.price === null || lesson.price === undefined
                  ? 'No price was said — it will be listed as “on request”.'
                  : [lesson.currency ?? 'SGD', lesson.price.toFixed(2), lesson.unit].filter(Boolean).join(' ')}
                {lesson.question ? ' · ' + lesson.question : ''}
              </p>
            </>
          ) : lesson.kind === 'event' ? (
            /* A date is a date, so it leads with when — and says so at a size you can read. */
            <>
              {/*
                The date, as the substance of the card rather than a caption above it.

                It used to borrow .factlabel, which is 10px grey uppercase monospace and right
                for what a *fact* is about. On a date card it read as a caption, and the two
                time pickers underneath were the biggest controls on the row — so the pickers
                looked like where the dates went, and the dates themselves went unseen.
              */}
              {/*
                Every day of the course on one line, because that is one decision.

                Nine customers asked about the September intake and each answer was learned, so
                the queue held nine wordings of each of three class days -- twenty-seven cards
                for one thing somebody says yes to once. Ticking this writes one date per day.
              */}
              <p className="whenline">
                {days.length > 1
                  ? asDays(days.map((d) => d.starts_on).filter((x): x is string => !!x))
                  : lesson.starts_on
                    ? asRange(lesson.starts_on, lesson.ends_on)
                    : ''}
                {lesson.repeats && lesson.repeats !== 'once' ? (
                  <span className="every">every {lesson.repeats.replace('ly', '')}</span>
                ) : null}
              </p>
              {days.length > 1 && <p className="note">{days.length} days, approved together.</p>}
              <p className="claim">{lesson.answer}</p>
              {/*
                The hour, asked for rather than guessed.

                A team saying "the 25th" and nothing else is the common case, and a calendar
                entry with an invented time is one nobody is ever prompted to correct — so
                the card asks, here, before it can be approved. Leaving the end blank is
                fine: an event that starts at seven runs to eight unless somebody says
                otherwise.
              */}
              {onTimes && (
                <div
                  className="eventtimes"
                  // The card's own label is a checkbox; a click in here is somebody setting a
                  // time, not ticking the row.
                  onClick={(e) => e.preventDefault()}
                >
                  {/*
                    Where it goes, chosen from what this bot can actually read. Filing a date
                    on a calendar the bot was not given would be a date it cannot then quote
                    — which reads as the approval having done nothing.
                  */}
                  {!!calendars?.length && (
                    <label>
                      <span className="note">Calendar</span>
                      <select
                        className="calpick"
                        value={cal}
                        onChange={(e) => {
                          const next = Number(e.target.value)
                          setCal(next)
                          void onTimes({ id: lesson.id, start_time: from, end_time: to, calendar_id: next })
                        }}
                      >
                        {calendars.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {/* "From" and "To" on their own read as a date range, which is what the
                      person reading this card is looking for — so they say which. */}
                  <label>
                    <span className="note">Start time</span>
                    {/* Saved on the change, not on the way out: a select has no half-typed
                        state to wait for, and a card somebody ticks straight after picking
                        should already carry the time. */}
                    <TimePick
                      value={from}
                      onChange={(next) => {
                        setFrom(next)
                        void onTimes({ id: lesson.id, start_time: next, end_time: to, calendar_id: cal })
                      }}
                    />
                  </label>
                  <label>
                    <span className="note">End time</span>
                    <TimePick
                      value={to}
                      onChange={(next) => {
                        setTo(next)
                        void onTimes({ id: lesson.id, start_time: from, end_time: next, calendar_id: cal })
                      }}
                    />
                  </label>
                  <span className="note">
                    {from
                      ? to
                        ? ''
                        : 'Ends an hour later unless you say otherwise.'
                      : calendars?.length
                        ? 'Nobody said a time. Add one before approving, or it goes on as a whole day.'
                        : 'This bot has no calendar ticked under Knowledge, so there is nowhere to file this.'}
                  </span>
                </div>
              )}
            </>
          ) : lesson.kind === 'example' ? (
            <>
              {lesson.question && <p className="asked">{lesson.question}</p>}
              <p className="said">{lesson.answer}</p>
            </>
          ) : (
            <>
              {/* What it is about, then what it says. The label is how somebody finds this
                  again once it is in the knowledge base, so it is filed with it. */}
              {lesson.question && <p className="factlabel">{lesson.question}</p>}
              <p className="claim">{lesson.answer}</p>
              {/*
                What the knowledge base already says closest to this, shown rather than acted
                on. A similarity threshold would either bury real new facts or wave through
                restatements; whoever is reading the row is the better judge and is here.
              */}
              <p className={`nearest${lesson.nearest ? '' : ' none'}`}>
                <span>{lesson.nearest ? 'Closest thing already known' : 'Nothing like this is known yet'}</span>
                {lesson.nearest}
              </p>
            </>
          )}

          {/*
            What goes out with it, above the footer so it is read before the tick. A file
            already approved arrives with the answer; one still in the queue is marked and
            does not go until it gets its own tick.
          */}
          <Sends items={lesson.will_send} crossed={crossed} onCross={onCross} />

          <span className="foot">
            <span className="pill">
              {lesson.kind === 'example'
                ? 'way to answer'
                : lesson.kind === 'resource'
                  ? lesson.attachment_id
                    ? 'file to send'
                    : 'link to send'
                  : lesson.kind === 'event'
                    ? 'date'
                    : lesson.kind === 'product'
                      ? 'product'
                      : 'fact'}
            </span>
            <span className="note">learned {learnedAt(lesson.created_at)}</span>
            {lesson.conversation_id && (
              <a
                className="note"
                href={`/inbox?id=${lesson.conversation_id}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                read the conversation ›
              </a>
            )}
          </span>
        </span>
      </label>
    </div>
  )
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

        {/*
          Reading a base rather than typing the list again.

          Straight onto this list, with no approval step. Training is for a product somebody
          *mentioned* in a conversation, where naming a thing is not the same as confirming
          it exists — this is a person pointing at their own price list and pressing read, a
          decision already made. Anything the model got wrong is edited here, in front of
          every other price, which is where a wrong one actually shows.
        */}
        {options.onReadCatalogue && options.bases.length > 0 && (
          <div className="row wrap" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
            <label htmlFor="p-from" className="note" style={{ margin: 0 }}>
              Read a knowledge base for products
            </label>
            <select id="p-from" value={from} onChange={(e) => setFrom(Number(e.target.value))} style={{ maxWidth: 240 }}>
              <option value={0}>Pick one…</option>
              {options.bases.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.documents})
                </option>
              ))}
            </select>
            <button
              className="ghost small"
              disabled={!from || !!busy}
              onClick={() => {
                setBusy('read')
                setErr('')
                setRead('')
                void options
                  .onReadCatalogue!(from)
                  .then((r) =>
                    setRead(
                      r.found === 0
                        ? 'Nothing in there reads as something you sell.'
                        : `Added ${r.added}${r.known ? `, ${r.known} already listed` : ''}.${
                            r.more ? ` Only the first ${r.read} parts were read.` : ''
                          }`,
                    ),
                  )
                  .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(''))
              }}
            >
              {busy === 'read' ? 'Reading…' : 'Read it'}
            </button>
            {read && <span className="note">{read}</span>}
          </div>
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
    // todayFor, not toISOString: the UTC day is yesterday in Singapore until 08:00, so this list
    // went on offering yesterday's session for the whole of every morning.
    .filter((e) => (e.ends_on ?? e.starts_on) >= todayFor())
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
            ? 'No model key on this workspace — every question goes to a person until one is set.'
            : options.models.provider === 'autobricks'
              ? 'Your own Autobricks key, so this is its live catalogue. Premium models need credit on that account.'
              : 'The shared key. Default follows OPENROUTER_MODEL, so one change moves every bot that has not chosen for itself.'}
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
          These two lists hold for any business. Add whatever only applies to yours: anything it
          must refuse outright, and anything it must hand to a person rather than answer itself.
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
 * Every approved example, open for correction.
 *
 * An example is a transcript, and a transcript is rarely phrased the way anybody would choose
 * on reflection — a typo, an aside to a colleague, a sentence that only made sense in that
 * thread. Until now the only thing that could be done about one was retire it, which threw
 * away a good answer over a bad word.
 *
 * The files matter as much as the words. The team said "here is our full product list" and
 * attached the PDF; learning only the sentence gives a bot that promises a file and sends
 * nothing, which is worse than never having learned it.
 */
function Examples({
  lessons,
  resources,
  attached,
  onSave,
  onDismissSuggestion,
  onRetire,
  onClose,
}: {
  lessons: Lesson[]
  resources: Options['resources']
  attached: { lesson_id: number; id: number }[]
  onSave?: (input: { id: number; question: string; answer: string; resourceIds: number[] }) => Promise<void>
  /** Turn down a proposed wording so it stops being offered. */
  onDismissSuggestion?: (id: number) => Promise<void>
  onRetire: (id: number) => void
  onClose: () => void
}) {
  /*
   * Opened once, on mount — the pattern ReviewModal below already uses.
   *
   * This was `ref={(el) => el?.showModal()}`, a new function identity on every render, so
   * React detached and re-attached the ref and called showModal() again each time. Browsers
   * no-op that on an already-open dialog, so it was harmless and invisible; it is still a
   * re-entrancy nobody meant, and this dialog re-renders on every keystroke in it.
   */
  const sheet = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    sheet.current?.showModal()
  }, [])

  // The same narrowing as the review queue, for the same reason: eighty of these is a scroll.
  const [find, setFind] = useState('')
  const term = find.trim().toLowerCase()
  /*
   * And a second narrowing, for the one job nobody can do by scrolling: a backfill proposes a
   * wording for every example that will go out of date, and finding twenty of them among eighty
   * by eye is how they stay unaccepted.
   */
  const [onlySuggested, setOnlySuggested] = useState(false)
  // Either half. An example whose answer needs nothing and whose question names a dead month is
  // still one somebody has to accept, and counting only answers hid twenty of them.
  const waiting = lessons.filter(
    (l) =>
      (!!l.suggested && l.suggested !== l.answer) ||
      (!!l.suggested_question && l.suggested_question !== (l.question ?? '')),
  )
  const shown = (onlySuggested ? waiting : lessons).filter((l) =>
    term ? `${l.question ?? ''} ${l.answer}`.toLowerCase().includes(term) : true,
  )

  return (
    <dialog className="sheet wide" ref={sheet} onClick={lightDismiss} onClose={onClose}>
      <div className="sheetbody">
        <div className="queuehead">
          <div>
            <h3 style={{ marginTop: 0 }}>Ways it answers</h3>
            <p className="note">
              Shown to the model when somebody asks something similar. Correct the wording, or change which
              files go out with it.
            </p>
          </div>
          <button type="button" className="ghost small" onClick={onClose}>
            Done
          </button>
        </div>

        {lessons.length > 6 && (
          <input
            className="search"
            aria-label="Search these answers"
            placeholder={`Search ${lessons.length} answers`}
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
        )}

        {(() => {
          const card = (l: Lesson) => (
            <ExampleCard
              key={l.id}
              lesson={l}
              resources={resources}
              picked={attached.filter((a) => a.lesson_id === l.id).map((a) => a.id)}
              onSave={onSave}
              onDismissSuggestion={onDismissSuggestion}
              onRetire={() => onRetire(l.id)}
            />
          )
          const groups = cluster(shown)
          const folded = shown.length - groups.length
          return (
            <>
              {term && (
                <p className="note">
                  {shown.length} of {lessons.length} match “{find.trim()}”.
                </p>
              )}
              {!!waiting.length && (
                <label className="check" style={{ marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={onlySuggested}
                    onChange={(e) => setOnlySuggested(e.target.checked)}
                  />
                  <span>
                    {waiting.length} {waiting.length === 1 ? 'has' : 'have'} a suggested wording, with what
                    expires taken out
                  </span>
                </label>
              )}
              {/*
                Said once at the top rather than left as arithmetic. Eighty examples that read
                as sixty-five is a difference somebody will otherwise notice and mistrust.
              */}
              {folded > 0 && (
                <p className="note">
                  {folded} of these repeat another, and are folded under it. The bot is using all of
                  them — retire the ones that read worse.
                </p>
              )}
              {groups.length === 0 && <p className="note">Nothing matches.</p>}
              {groups.map(({ leader, also }) => (
                <div key={leader.id} className={also.length ? 'clustered' : undefined}>
                  {card(leader)}
                  {also.length > 0 && (
                    <details className="alike">
                      <summary>{also.length} more like this</summary>
                      {also.map(card)}
                    </details>
                  )}
                </div>
              ))}
            </>
          )
        })()}
      </div>
    </dialog>
  )
}

/** Sizes people recognise, for a row that has to say what a thing is in one line. */
const fileSize = (bytes: number) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/** Four characters that say what it is: the extension, or an arrow for somewhere else. */
const fileMark = (r: Options['resources'][number]) =>
  r.kind === 'link' ? '↗' : (r.title.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()

/** One thing a chip stands for: a file we hold and can show, or a link that lives elsewhere. */
type Shown = { key: string; title: string; href: string; mime: string | null; isFile: boolean }

/**
 * Things that go out with an answer, as badges you can look inside.
 *
 * Written once for both screens. The queue crosses a badge off and keeps it on show, struck
 * through, because changing your mind is most of reviewing; the editor takes it off the list
 * outright, because there the list is the setting. Same chip either way -- what the cross does
 * is the caller's business.
 */
function FileChips({
  items,
  crossed = [],
  onCross,
  removes,
}: {
  items: Shown[]
  crossed?: string[]
  onCross?: (key: string) => void
  /** Whether the cross deletes the chip rather than striking it. Changes only the wording. */
  removes?: boolean
}) {
  const [peek, setPeek] = useState<{ title: string; href: string; mime: string | null } | null>(null)
  if (!items.length) return null

  return (
    <>
      {items.map((f) => {
        const off = crossed.includes(f.key)
        return (
          <span key={f.key} className={`chip ${off ? 'off' : 'on'}`}>
            <button
              type="button"
              className="chiplook"
              title={off ? `${f.title} — not sent with this answer` : `Look at ${f.title}`}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                // A link goes to its own tab; a file we hold opens here.
                if (f.isFile) setPeek({ title: f.title, href: f.href, mime: f.mime })
                else window.open(f.href, '_blank', 'noopener')
              }}
            >
              <span className="mark">
                {f.isFile ? (f.title.split('.').pop() ?? 'file').slice(0, 4).toUpperCase() : '↗'}
              </span>
              <span className="chipname">{f.title}</span>
            </button>
            {onCross && (
              <button
                type="button"
                className="chipx"
                title={
                  removes
                    ? `Stop sending ${f.title} with this answer`
                    : off
                      ? `Send ${f.title} with this answer after all`
                      : `Do not send ${f.title} with this answer`
                }
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onCross(f.key)
                }}
              >
                <span aria-hidden="true">{off ? '↺' : '×'}</span>
              </button>
            )}
          </span>
        )
      })}
      {peek && <Peek at={peek} onClose={() => setPeek(null)} />}
    </>
  )
}

/**
 * What a proposed answer sends, in the review queue.
 *
 * Two states and no third: filled means this answer sends it, outlined and struck means it
 * does not. Whether the bot already holds the file is not the reviewer's problem -- approving
 * an answer with a badge left on adds the file to the bot's files and links if it is new. The
 * question on this screen is only ever "does this go out with this answer".
 *
 * Crossing off is per answer, not per file: the same price list belongs with one reply from a
 * thread and not with another, and taking it off here never takes it off the bot.
 *
 * The match behind these is the whole conversation, which cannot tell which answer a file
 * belonged to -- a thread with four answers and one photo offers the photo to all four. That
 * is a judgement a person makes in a second by looking at it, which is what the badge opens.
 */
function Sends({
  items,
  crossed,
  onCross,
}: {
  items: Lesson['will_send']
  crossed: string[]
  onCross?: (file: number) => void
}) {
  if (!items?.length) return null
  // Something kept on this answer that the bot does not hold yet, which approving will add.
  const adds = items.some((f) => f.status !== 'approved' && !crossed.includes(String(f.id)))

  return (
    <div className="sends">
      <p className="sendrow">
        <span className="note">Sends with this answer</span>
        <FileChips
          items={items.map((f) => ({
            key: String(f.id),
            title: f.title,
            href: f.attachment_id ? `/api/attachment/${f.attachment_id}` : f.title,
            mime: f.mime,
            isFile: !!f.attachment_id,
          }))}
          crossed={crossed}
          onCross={onCross && ((key) => onCross(Number(key)))}
        />
      </p>
      {/*
        Adding a file to the bot's library is a consequence worth one line, because it is the
        one thing on this screen that outlives the answer being approved.
      */}
      {adds && (
        <p className="note sendnote">
          Approving adds any of these the bot does not hold yet to its <strong>files and links</strong>.
        </p>
      )}
    </div>
  )
}

/**
 * Choosing, in its own sheet.
 *
 * Off the card because choosing and reading are different jobs. A card answers "what does
 * this send?" in one glance at its badges; this answers "what else could it send?", which is
 * the whole library and only wanted while somebody is actually choosing.
 *
 * Toggling writes straight through to the card behind it -- there is no separate confirm,
 * because the card's own Save is the confirm and a second one would only be a thing to forget.
 */
function AttachSheet({
  all,
  ids,
  onToggle,
  onClose,
}: {
  all: Options['resources']
  ids: number[]
  onToggle: (id: number) => void
  onClose: () => void
}) {
  const sheet = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    sheet.current?.showModal()
  }, [])

  return (
    <dialog className="sheet" ref={sheet} onClick={lightDismiss} onClose={onClose}>
      <div className="sheetbody">
        <div className="queuehead">
          <div>
            <h3 style={{ marginTop: 0 }}>Send these with it</h3>
            <p className="note">The bot attaches whatever is ticked when it answers this way.</p>
          </div>
          <button type="button" className="ghost small" onClick={onClose}>
            Done
          </button>
        </div>
        <Attachables all={all} ids={ids} onToggle={onToggle} />
      </div>
    </dialog>
  )
}

/**
 * Choosing what goes out with an answer.
 *
 * A column of checkboxes is fine for four things and useless for forty: the question a
 * person actually has is "what does this answer send?", and a flat list makes them read
 * every row to find out. So what is attached is lifted out as chips — the answer, in one
 * line, each one removable — and everything else is a searchable list underneath.
 *
 * The search box only appears once there is enough to search, because a filter over five
 * rows is furniture.
 */
function Attachables({
  all,
  ids,
  onToggle,
}: {
  all: Options['resources']
  ids: number[]
  onToggle: (id: number) => void
}) {
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()

  const chosen = all.filter((r) => ids.includes(r.id))
  const rest = all.filter(
    (r) => !ids.includes(r.id) && (!term || `${r.title} ${r.description}`.toLowerCase().includes(term)),
  )

  return (
    <div className="attachpicker">
      {chosen.length > 0 && (
        <div className="attached sendrow">
          <FileChips
            items={chosen.map((r) => ({
              key: String(r.id),
              title: r.title,
              href: r.kind === 'link' ? (r.url ?? '') : `/api/resource/${r.token}`,
              mime: r.mime,
              isFile: r.kind !== 'link',
            }))}
            onCross={(key) => onToggle(Number(key))}
            removes
          />
        </div>
      )}


      {all.length > 6 && (
        <input
          className="attachfind"
          placeholder={`Search ${all.length} files and links`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}

      <div className="pickfiles">
        {rest.map((r) => (
          <button key={r.id} type="button" className="filerow" onClick={() => onToggle(r.id)}>
            <span className="mark">{fileMark(r)}</span>
            <span className="what">
              <b>{r.title}</b>
              {/* A link's description is often its own title again, and saying it twice is
                  worse than not saying it. */}
              {r.description && r.description !== r.title && <small>{r.description}</small>}
            </span>
            <span className="note">{r.kind === 'link' ? 'link' : fileSize(r.size_bytes)}</span>
          </button>
        ))}
        {rest.length === 0 && (
          <p className="note" style={{ margin: 4 }}>
            {term ? 'Nothing matches.' : 'Everything here is already attached.'}
          </p>
        )}
      </div>
    </div>
  )
}

function ExampleCard({
  lesson,
  resources,
  picked,
  onSave,
  onDismissSuggestion,
  onRetire,
}: {
  lesson: Lesson
  resources: Options['resources']
  picked: number[]
  onSave?: (input: { id: number; question: string; answer: string; resourceIds: number[] }) => Promise<void>
  /** Turn down a proposed wording so it stops being offered. */
  onDismissSuggestion?: (id: number) => Promise<void>
  onRetire: () => void
}) {
  const [question, setQuestion] = useState(lesson.question ?? '')
  const [answer, setAnswer] = useState(lesson.answer)
  const [ids, setIds] = useState<number[]>(picked)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [picking, setPicking] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [err, setErr] = useState('')

  // In the order the workspace lists them, so two cards attaching the same pair read alike.
  const chosen = resources
    .filter((r) => ids.includes(r.id))
    .map((r) => ({
      key: String(r.id),
      title: r.title,
      href: r.kind === 'link' ? (r.url ?? '') : `/api/resource/${r.token}`,
      mime: r.mime,
      isFile: r.kind !== 'link',
    }))

  const same =
    question === (lesson.question ?? '') &&
    answer === lesson.answer &&
    ids.length === picked.length &&
    ids.every((i) => picked.includes(i))

  const save = async () => {
    if (!onSave) return
    setSaving(true)
    setErr('')
    try {
      await onSave({ id: lesson.id, question, answer, resourceIds: ids })
      setSaved(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const toggle = (id: number) => {
    setSaved(false)
    setIds((was) => (was.includes(id) ? was.filter((i) => i !== id) : [...was, id]))
  }

  return (
    <div className="card examplecard">
      <label htmlFor={`q-${lesson.id}`}>When somebody asks</label>
      <textarea
        id={`q-${lesson.id}`}
        rows={2}
        value={question}
        onChange={(e) => {
          setQuestion(e.target.value)
          setSaved(false)
        }}
      />
      {/*
        The same warning the answer gets, for the half that decides whether this example is
        reached at all. A stored question naming a month that has gone is a worse match for what
        a customer actually types, and it is shown to the model as the pairing to imitate.
      */}
      {looksStale(question) && (
        <p className="warn" style={{ margin: '6px 0 0' }}>
          This question names a date or a month. It is what an incoming message is matched against,
          so it will keep pulling this example up for a time that has passed.
        </p>
      )}

      <label htmlFor={`a-${lesson.id}`} style={{ marginTop: 10 }}>
        Answer like this
      </label>
      <textarea
        id={`a-${lesson.id}`}
        rows={4}
        value={answer}
        onChange={(e) => {
          setAnswer(e.target.value)
          setSaved(false)
        }}
      />
      {/*
        Examples harvested before greetings were stripped. Flagged rather than rewritten:
        somebody approved this wording, and quietly editing it under them is how a review
        queue stops being trusted. New ones no longer arrive this way.
      */}
      {looksPersonal(answer) && (
        <p className="warn" style={{ margin: '6px 0 0' }}>
          This opens with a greeting, and it is shown to the bot while it answers other people.
          Delete the greeting and it will read the same to everybody.
        </p>
      )}
      {/*
        The same argument one step on. A greeting is written to one person; a date is written to
        one week. Both read fine for ever and stop being true.
      */}
      {looksStale(answer) && (
        <p className="warn" style={{ margin: '6px 0 0' }}>
          This names a date, a time or a price. It is shown to the bot months from now, and it will
          be repeated as though it were still current.
        </p>
      )}
      {/*
        Offered, never applied. Pressing this fills the box; saving is still a separate, deliberate
        act by the person who approved the original wording.
      */}
      {(() => {
        /*
         * Two halves, proposed independently, offered together.
         *
         * A question is rewritten rather than bracketed -- see migration 080 -- so the two read
         * differently and are labelled differently. Either can be the only one there: an answer
         * can be fine while its question names a month that has gone, which was twenty of one
         * bot's eighty examples.
         */
        const newQuestion =
          lesson.suggested_question && lesson.suggested_question !== question ? lesson.suggested_question : null
        const newAnswer = lesson.suggested && lesson.suggested !== answer ? lesson.suggested : null
        if (!newQuestion && !newAnswer) return null

        return (
          <div className="suggestion">
            <p className="note" style={{ margin: 0 }}>Suggested wording, with what expires taken out:</p>
            {newQuestion && (
              <>
                <p className="note" style={{ margin: '6px 0 0' }}>When somebody asks</p>
                <p className="said" style={{ margin: '2px 0 0' }}>{newQuestion}</p>
              </>
            )}
            {newAnswer && (
              <>
                {newQuestion && <p className="note" style={{ margin: '8px 0 0' }}>Answer like this</p>}
                <p className="said" style={{ margin: newQuestion ? '2px 0 8px' : '6px 0 8px' }}>{newAnswer}</p>
              </>
            )}
            <div className="row" style={{ gap: 8, marginTop: newAnswer ? 0 : 8 }}>
              <button
                className="ghost small"
                onClick={() => {
                  if (newQuestion) setQuestion(newQuestion)
                  if (newAnswer) setAnswer(newAnswer)
                  setSaved(false)
                }}
              >
                Use this
              </button>
              {/*
                And a way to say no that sticks.
                
                Without it the only way to be rid of a suggestion that adds nothing was to accept
                it or scroll past it for ever -- and a queue you cannot clear is one people stop
                reading. It records the same "looked at, nothing to change" state the backfill
                writes, so the script will not propose this row again either.
              */}
              {onDismissSuggestion && (
                <button
                  className="ghost small"
                  disabled={dismissing}
                  title="Stop offering this wording. Your answer is not changed."
                  onClick={() => {
                    setDismissing(true)
                    void onDismissSuggestion(lesson.id).catch((e) => {
                      setErr(e instanceof Error ? e.message : String(e))
                      setDismissing(false)
                    })
                  }}
                >
                  {dismissing ? 'Dismissing…' : 'No thanks'}
                </button>
              )}
            </div>
          </div>
        )
      })()}

      {/*
        What this answer sends, and nothing else.
        
        Every card used to list the whole workspace with a checkbox beside each row, so a bot
        with forty files answered "what does this send?" by making somebody read forty rows on
        every card. The badges are the answer; choosing is a different job and it happens in
        its own sheet.
      */}
      <p className="sendrow" style={{ margin: '12px 0 0' }}>
        <span className="note">{ids.length ? 'Sends with this answer' : 'Sends nothing with this answer'}</span>
        <FileChips items={chosen} onCross={(key) => toggle(Number(key))} removes />
        {resources.length > 0 && (
          <button type="button" className="ghost small" onClick={() => setPicking(true)}>
            {ids.length ? 'Attach more' : 'Attach a file or link'}
          </button>
        )}
      </p>
      {resources.length === 0 && (
        <p className="note" style={{ margin: '6px 0 0' }}>
          No files or links in this workspace yet. Add them under Knowledge and they will appear here.
        </p>
      )}
      {picking && (
        <AttachSheet all={resources} ids={ids} onToggle={toggle} onClose={() => setPicking(false)} />
      )}

      {err && (
        <p className="err" style={{ marginBottom: 0 }}>
          {err}
        </p>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="small" disabled={saving || same || !onSave} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && same && <span className="pill ok">Saved</span>}
        <button type="button" className="ghost small bad" style={{ marginLeft: 'auto' }} onClick={onRetire}>
          Retire
        </button>
      </div>
    </div>
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
