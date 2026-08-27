import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { DayModal, eventItem } from '../components/DayModal'
import type { DayItem } from '../components/DayModal'
import { requireSession } from '../server/auth'
import * as catalogue from '../server/catalogue'
import { CALENDAR_COLOURS, CALENDAR_VIEWS, calendarRange, shiftCalendar } from '../types'
import type { CalendarView } from '../types'

/**
 * Every date this workspace keeps, in one place and separable again.
 *
 * A calendar is the business's own — closures, launches, cut-offs, a season of workshops —
 * kept as rows, edited here, and read by the bot through the knowledge base. A workspace
 * keeps several, because "when are we shut" and "when are the workshops" are different
 * questions to different people.
 *
 * The merged view is the point: somebody asking "what is happening in March" does not care
 * which calendar a thing came from. The filter is the other half of the point, for when
 * they do.
 */
const load = createServerFn({ method: 'GET' })
  .validator((d: { on: string; view: CalendarView }) => d)
  .handler(async () => {
    const s = await requireSession()
    return {
      calendars: await catalogue.calendars(s.workspaceId),
      events: await catalogue.events(s.workspaceId),
    }
  })

const saveCalendar = createServerFn({ method: 'POST' })
  .validator((d: { id?: number; name?: string; description?: string; colour?: string; remove?: boolean }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    if (data.remove && data.id) return catalogue.removeCalendar(s.workspaceId, data.id)
    if (data.id) return catalogue.editCalendar(s.workspaceId, data.id, data)
    await catalogue.addCalendar(s.workspaceId, data.name ?? '', data.description, data.colour)
  })

/*
 * Adding a date lives on the calendar it goes on, not here.
 *
 * This page merges every calendar in the workspace, so the form here had to open by asking
 * which calendar — a question the person answers by opening one, and one with no sensible
 * default once there is more than a single calendar. So this
 * page views and consolidates; `/calendar/$id` is where a date is written. Editing and
 * removing an existing date still work from a day, through DayModal, which owns its own
 * calls: those start from the date itself, so there is nothing to ask.
 */

export const Route = createFileRoute('/calendar')({
  // The month and the view in the URL: a month worth looking at is a month worth sending
  // somebody.
  validateSearch: (q: Record<string, unknown>): { on?: string; view?: CalendarView } => ({
    on: typeof q.on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.on) ? q.on : undefined,
    view: CALENDAR_VIEWS.includes(q.view as CalendarView) ? (q.view as CalendarView) : undefined,
  }),
  loaderDeps: ({ search }) => ({
    on: search.on ?? new Date().toISOString().slice(0, 10),
    view: search.view ?? 'month',
  }),
  loader: ({ deps }) => load({ data: deps }),
  component: Calendars,
})

const TABS = ['month', 'calendars'] as const

type Data = Awaited<ReturnType<typeof load>>

function Calendars() {
  const d = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const calFn = useServerFn(saveCalendar)

  const on = search.on ?? new Date().toISOString().slice(0, 10)
  const view = search.view ?? 'month'
  const go = (next: Partial<{ on: string; view: CalendarView }>) =>
    navigate({ search: { on, view, ...next }, replace: true })

  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  /*
   * Which sources are drawn. Empty means all of them — an explicit set that starts full
   * would have to be corrected every time somebody adds a calendar.
   */
  const [hidden, setHidden] = useState<string[]>([])
  const [adding, setAdding] = useState<'calendar' | null>(null)
  /** The day whose modal is open, as an ISO date. */
  const [day, setDay] = useState('')
  const [tab, setTab] = useState<(typeof TABS)[number]>('month')

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what)
    setErr('')
    try {
      await fn()
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  const sources = d.calendars.map((c) => ({
    key: `cal:${c.id}`,
    name: c.name,
    colour: c.colour,
    count: c.events,
    own: c,
  }))
  const shownSource = (key: string) => !hidden.includes(key)

  const { keys } = calendarRange(on, view)
  const term = q.trim().toLowerCase()

  /**
   * What falls on a day, from every source that is switched on.
   *
   * Recurrence is expanded here rather than stored, so a yearly closure stays one row to
   * correct when the date moves.
   */
  const dayOf = (key: string): DayItem[] => {
    const out: DayItem[] = []

    for (const e of d.events) {
      const source = `cal:${e.calendar_id}`
      if (!shownSource(source)) continue
      const cal = d.calendars.find((c) => c.id === e.calendar_id)
      const start = e.starts_on
      const end = e.ends_on || e.starts_on
      let hit = key >= start && key <= end
      if (!hit && e.repeats !== 'once' && key >= start) {
        const day = new Date(`${key}T00:00:00Z`)
        const first = new Date(`${start}T00:00:00Z`)
        hit =
          (e.repeats === 'yearly' && key.slice(5) === start.slice(5)) ||
          (e.repeats === 'monthly' && key.slice(8) === start.slice(8)) ||
          (e.repeats === 'weekly' && day.getUTCDay() === first.getUTCDay())
      }
      if (!hit) continue
      if (term && !`${e.title} ${e.detail}`.toLowerCase().includes(term)) continue
      out.push(eventItem(e, cal?.name ?? 'A calendar', cal?.colour ?? 'moss'))
    }

    return out.sort((a, b) => a.time.localeCompare(b.time))
  }

  const found = term ? keys.reduce((n, k) => n + dayOf(k).length, 0) : 0

  return (
    <>
      <h1>Calendar</h1>
      <p className="lede">
        Everything this workspace keeps a date for, on every calendar it keeps — and each of
        them is read by every chatbot.
      </p>

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      {/*
        The merged month first, because it is the question this page answers: what is
        happening. The list it is made of is a tab away, where somebody goes when the
        answer surprises them — rather than a scroll away under it, which is where the month
        pushed them once it was a month tall.
      */}
      <div className="row">
      <div className="seg tabstrip" role="tablist" aria-label="Calendar">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'month' ? 'Everything' : `Calendars (${d.calendars.length})`}
          </button>
        ))}
      </div>
      <span className="grow" />
      {tab === 'calendars' && (
        <button className="ghost small" onClick={() => setAdding(adding === 'calendar' ? null : 'calendar')}>
          New calendar
        </button>
      )}
      </div>

      <div className="calmain" hidden={tab !== 'month'}>
          <div className="row calbar" style={{ marginTop: 0 }}>
            <button className="ghost small" onClick={() => go({ on: shiftCalendar(on, view, -1) })} aria-label="Earlier">
              ‹
            </button>
            <strong className="callabel">
              {view === 'month'
                ? new Date(`${on.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
                    month: 'long',
                    year: 'numeric',
                    timeZone: 'UTC',
                  })
                : new Date(`${on}T00:00:00Z`).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })}
            </strong>
            <button className="ghost small" onClick={() => go({ on: shiftCalendar(on, view, 1) })} aria-label="Later">
              ›
            </button>
            <div className="seg small">
              {CALENDAR_VIEWS.map((v) => (
                <button key={v} className={v === view ? 'on' : ''} onClick={() => go({ view: v })}>
                  {v}
                </button>
              ))}
            </div>
            <span className="grow" />
            <input
              placeholder="Search dates"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ maxWidth: 220 }}
            />
          </div>

          {/*
            The filter, as pills over the month it filters.

            It was a tick on each row of the lists below, which put the control a scroll away
            from the thing it changed — and made two jobs of one list: what is drawn, and
            what exists. The pills are the first; the lists are the second.
          */}
          <div className="filters calpills">
            {sources.map((x) => (
              <button
                key={x.key}
                className={`chip ${x.colour}${shownSource(x.key) ? ' on' : ''}`}
                aria-pressed={shownSource(x.key)}
                onClick={() => setHidden((h) => (h.includes(x.key) ? h.filter((y) => y !== x.key) : [...h, x.key]))}
              >
                <span className="dot" />
                {x.name}
                <b>{x.count}</b>
              </button>
            ))}
            {hidden.length > 0 && (
              <button className="linkish" onClick={() => setHidden([])}>
                show all
              </button>
            )}
          </div>

          {term && (
            <p className="note" style={{ marginTop: 0 }}>
              {found} match{found === 1 ? '' : 'es'} in view. Everything else is dimmed rather than hidden, so the
              shape of the month is still there.
            </p>
          )}

          {/*
            A whole day is one button, and the chips inside it are decoration.

            They used to be buttons themselves, and the one thing a tap did was delete —
            no dialog, on a target a few pixels tall. Somebody lost a date to it. Opening
            the day is what a tap on a day should do anyway, and it gives an empty day
            somewhere to say so.
          */}
          <div className={`calgrid ${view}`}>
            {keys.map((key) => (
              <button
                key={key}
                className={`calday${key.slice(0, 7) === on.slice(0, 7) ? '' : ' outside'}`}
                aria-label={`${key} — ${dayOf(key).length} on`}
                onClick={() => setDay(key)}
              >
                <span className="calnum">{Number(key.slice(8))}</span>
                {dayOf(key).map((x) => (
                  <span key={x.key} className={`calentry ${x.colour}`} title={x.detail || x.title}>
                    {x.time && <small>{x.time}</small>}
                    <b>{x.title}</b>
                  </span>
                ))}
              </button>
            ))}
          </div>

          {day && (
            <DayModal
              day={day}
              items={dayOf(day)}
              calendars={d.calendars}
              onChanged={() => router.invalidate()}
              onClose={() => setDay('')}
            />
          )}
      </div>

      {tab === 'calendars' && (
        <>
      {/*
        What belongs on a calendar here, and the mistake worth spending a paragraph to
        prevent: these hold facts about the business that any customer might ask about.
        Arrangements with one particular person are not that, and stay on their contact.
      */}
      <div className="tip">
        <strong>What the business does, on a date</strong>
        <p>
          Closures, launches, cut-offs, a season of workshops — true for everybody and safe for a chatbot to
          say out loud. A bot reads whichever of these it is given under <b>Knowledge and attachments</b>, and
          a date your team states in a conversation lands on one of them once you approve it under{' '}
          <b>Training</b>. Only what your <b>team</b> said is ever offered: a customer's own claim about your
          dates is never learned.
        </p>
      </div>
      <p className="note" style={{ maxWidth: '70ch' }}>
        Use the pills above the month to choose which of them it draws.
      </p>

      {adding === 'calendar' && (
        <NewCalendar busy={busy} onAdd={(v) => act('cal', () => calFn({ data: v })).then(() => setAdding(null))} />
      )}

      <div className="callist">
        {d.calendars.map((c) => (
          <Link key={c.id} className={`calrow ${c.colour}`} to="/calendar/$id" params={{ id: String(c.id) }}>
            <span className="dot" />
            <span className="what">
              <b>{c.name}</b>
              {c.is_default && <span className="pill">learned dates land here</span>}
              <small className="note">{c.description || 'No description.'}</small>
            </span>
            <span className="note count">
              {c.events} date{c.events === 1 ? '' : 's'}
            </span>
            {/* Removing one lives on its own page, next to the dates it would take with it.
                A row that opens on click is the wrong place to keep a delete. */}
            <span className="note">›</span>
          </Link>
        ))}
      </div>

        </>
      )}
    </>
  )
}

/** A new calendar: a name, a line about it, and which colour it is drawn in. */
function NewCalendar({ busy, onAdd }: { busy: string; onAdd: (v: Record<string, unknown>) => void }) {
  const [v, setV] = useState({ name: '', description: '', colour: 'amber' })

  return (
    <div className="card" style={{ margin: '10px 0' }}>
      <label htmlFor="c-name">Name</label>
      <input id="c-name" placeholder="Workshops" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      <label htmlFor="c-desc" style={{ marginTop: 10 }}>
        What is on it
      </label>
      <input
        id="c-desc"
        placeholder="Every session we run, and where"
        value={v.description}
        onChange={(e) => setV({ ...v, description: e.target.value })}
      />
      <p className="note" style={{ margin: '4px 0 0' }}>
        Read by every chatbot, so say it the way a customer would ask.
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="filters" style={{ marginBottom: 0 }}>
          {CALENDAR_COLOURS.map((c) => (
            <button key={c} className={`swatch ${c}${v.colour === c ? ' on' : ''}`} aria-label={c} onClick={() => setV({ ...v, colour: c })} />
          ))}
        </div>
        <span className="grow" />
        <button className="small" disabled={!v.name.trim() || !!busy} onClick={() => onAdd(v)}>
          {busy === 'cal' ? 'Adding…' : 'Add calendar'}
        </button>
      </div>
    </div>
  )
}

