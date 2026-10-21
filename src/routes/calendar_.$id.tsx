import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { DayModal, eventItem } from '../components/DayModal'
import { NotFound } from '../components/NotFound'
import { requireSession } from '../server/auth'
import * as catalogue from '../server/catalogue'
import { calendarRange, fallsOn, shiftCalendar, todayFor } from '../types'
import { DateForm, asDays, emptyDate, ready } from '../components/DateForm'

/**
 * One calendar: its month, everything on it, and what has been done to it.
 *
 * The merged view answers "what is happening"; this answers the two questions that follow —
 * what exactly is on this one, and why does it say that. The second is the reason the log
 * exists: a calendar a person edits, a chatbot reads, and an approval writes into is one
 * where "who put this here" has three possible answers.
 */
const load = createServerFn({ method: 'GET' })
  .validator((d: { id: number; on: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const all = await catalogue.calendars(s.workspaceId)
    const calendar = all.find((c) => c.id === data.id)
    if (!calendar) return null
    return {
      calendar,
      events: await catalogue.events(s.workspaceId, data.id),
      history: await catalogue.history(s.workspaceId, data.id),
      // Offered on the title field, so a new intake joins a course instead of renaming it.
      courses: await catalogue.coursesOn(s.workspaceId, data.id),
    }
  })

const edit = createServerFn({ method: 'POST' })
  .validator((d: { id: number; name?: string; description?: string; colour?: string; remove?: boolean }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    if (data.remove) return catalogue.removeCalendar(s.workspaceId, data.id)
    await catalogue.editCalendar(s.workspaceId, data.id, data)
  })

/**
 * A date, added to this calendar.
 *
 * Here rather than on the merged Calendar page, which is where it used to be. That page
 * draws every calendar at once and a project's leads besides, so "add a date" there had to
 * open with a "which calendar?" picker — a question the person had already answered by
 * choosing a calendar to look at, and one there is no good default for once a workspace has
 * several. On this page the answer is the page.
 */
const addDate = createServerFn({ method: 'POST' })
  .validator((d: Record<string, unknown>) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await catalogue.addEvent(s.workspaceId, data as never)
  })

/**
 * Several separate days, as one thing.
 *
 * Its own function rather than a flag on `addDate`, because what it writes is a course: N rows
 * that know they belong together. Everything that decides anything -- the cap, the day format,
 * the token they share -- is in `setDays`, since the validator here is a pass-through and the
 * browser is the thing being validated.
 */
const addDays = createServerFn({ method: 'POST' })
  .validator(
    (d: {
      title: string
      detail?: string
      /** A plain day at the shared hours, or one that keeps its own. */
      days: (string | { on: string; start_time?: string | null; end_time?: string | null })[]
      start_time?: string
      end_time?: string
      repeats?: string
      until?: string | null
      calendar_id: number
    }) => d,
  )
  .handler(async ({ data }) => {
    const s = await requireSession()
    await catalogue.setDays(s.workspaceId, { ...data, actor: s.email })
  })

export const Route = createFileRoute('/calendar_/$id')({
  validateSearch: (q: Record<string, unknown>): { on?: string } => ({
    on: typeof q.on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.on) ? q.on : undefined,
  }),
  loaderDeps: ({ search }) => ({ on: search.on ?? todayFor() }),
  loader: ({ params, deps }) => load({ data: { id: Number(params.id), on: deps.on } }),
  component: OneCalendar,
})

type Data = Awaited<ReturnType<typeof load>>

const VIEWS = ['dates', 'month', 'history'] as const

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const whole = (e: { start_time: string; end_time: string }) => e.start_time === '00:00' && e.end_time === '23:59'

/** Where a date came from, in the words somebody would use about it. */
const cameFrom = (source: string) =>
  source === 'learned' ? 'learned from a conversation and approved' : 'added by hand'

/**
 * Hook-free on purpose: `CalendarView` below runs a long stretch of hooks straight off
 * `d`'s fields, and a conditional return in front of only some of them — rather than here,
 * in front of all of it — would change how many hooks run the moment `data` flips from null
 * to real between two renders of the *same* mounted route (a different id, not a different
 * page).
 */
function OneCalendar() {
  const data = Route.useLoaderData()
  if (!data) return <NotFound what="calendar" to="/calendar" label="Back to the calendar." />
  return <CalendarView d={data} />
}

function CalendarView({ d }: { d: NonNullable<Awaited<ReturnType<typeof load>>> }) {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const editFn = useServerFn(edit)
  const addFn = useServerFn(addDate)
  const addDaysFn = useServerFn(addDays)

  const on = search.on ?? todayFor()
  /*
   * The month, not the list.
   *
   * A calendar is a shape before it is a set of rows — where the gaps are, which week is
   * full — and that is the question somebody opening one is usually asking. The list is
   * still a tab away, and it is the better answer only once you know which date you want.
   */
  const [view, setView] = useState<(typeof VIEWS)[number]>('month')
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState('')
  /** The day whose modal is open, as an ISO date. Set from either the list or the month. */
  const [day, setDay] = useState<{ on: string; start?: string } | null>(null)
  const [err, setErr] = useState('')

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

  const { keys } = calendarRange(on, 'month')
  /*
   * `fallsOn`, not a copy of it.
   *
   * What stood here was a re-implementation that treated the two date columns the same way
   * whatever the repeat: it returned true for every key between `starts_on` and `ends_on`
   * before it looked at `repeats` at all. So a weekly class running 3 to 17 April was drawn on
   * all fifteen days instead of its three Saturdays -- the exact failure the shared helper's own
   * comment is about, fixed on the merged calendar and left standing here.
   */
  const dayOf = (key: string) => d.events.filter((e) => fallsOn(e, key))

  return (
    <>
      <p className="note" style={{ marginBottom: 4 }}>
        <Link to="/calendar">← Calendar</Link>
      </p>

      <div className="titlerow">
        <button
          className="ghost small"
          style={{ order: 2 }}
          disabled={!!busy}
          onClick={() => setAdding(!adding)}
        >
          {adding ? 'Cancel' : 'Add a date'}
        </button>
        {/* Removing the calendar sits with the dates it would take with it, rather than on a
            list row that opens on click. */}
        {!d.calendar.is_default && (
          <button
            className="ghost small bad"
            style={{ order: 2 }}
            disabled={!!busy}
            onClick={() => {
              if (!confirm(`Remove "${d.calendar.name}" and its ${d.events.length} date(s)? This cannot be undone.`))
                return
              void act('gone', () => editFn({ data: { id: d.calendar.id, remove: true } })).then(() =>
                navigate({ to: '/calendar' }),
              )
            }}
          >
            {busy === 'gone' ? 'Removing…' : 'Remove calendar'}
          </button>
        )}
        <input
          className="titleinput"
          aria-label="Calendar name"
          defaultValue={d.calendar.name}
          key={d.calendar.name}
          onBlur={(e) =>
            e.target.value.trim() !== d.calendar.name &&
            void act('name', () => editFn({ data: { id: d.calendar.id, name: e.target.value } }))
          }
        />
      </div>
      <input
        className="subinput"
        aria-label="What is on it"
        placeholder="What is on it"
        defaultValue={d.calendar.description}
        key={d.calendar.description}
        onBlur={(e) =>
          e.target.value !== d.calendar.description &&
          void act('desc', () => editFn({ data: { id: d.calendar.id, description: e.target.value } }))
        }
      />

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      {/* Above the tabs, not inside one: the date being added belongs to the calendar, not
          to whichever way of looking at it happens to be open. */}
      {adding && (
        <NewDate
          busy={busy}
          courses={d.courses}
          onAddSpan={(v) =>
            void act('event', () => addFn({ data: { ...v, calendar_id: d.calendar.id } })).then(() =>
              setAdding(false),
            )
          }
          onAddDays={(v) =>
            void act('event', () => addDaysFn({ data: { ...v, calendar_id: d.calendar.id } })).then(() =>
              setAdding(false),
            )
          }
        />
      )}

      <div className="seg tabstrip" role="tablist" aria-label="This calendar">
        {VIEWS.map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {v === 'dates' ? `Dates (${d.events.length})` : v === 'month' ? 'Month' : `Changes (${d.history.length})`}
          </button>
        ))}
      </div>

      {view === 'dates' &&
        (d.events.length === 0 ? (
          <p className="note">
            Nothing on this calendar yet. Add a date above, or approve one a chatbot heard on its Training
            tab.
          </p>
        ) : (
          <div className="pricelist">
            {d.events.map((e) => (
              <button key={e.id} className="pricerow rowbutton" onClick={() => setDay({ on: e.starts_on, start: `e${e.id}` })}>
                <span className="what">
                  <b>{e.title}</b>
                  {/* Where it came from, on every row: the difference between a date somebody
                      typed and one a conversation produced is the first thing to check when
                      one looks wrong. */}
                  <span className={`pill${e.source === 'learned' ? ' warn' : ''}`}>{cameFrom(e.source)}</span>
                  <small>
                    {e.starts_on}
                    {e.ends_on ? ` to ${e.ends_on}` : ''}
                    {whole(e) ? ' · all day' : ` · ${e.start_time}–${e.end_time}`}
                    {e.repeats !== 'once' ? ` · every ${e.repeats.replace('ly', '')}` : ''}
                    {e.detail ? ` · ${e.detail}` : ''}
                  </small>
                </span>
                <span className="note">›</span>
              </button>
            ))}
          </div>
        ))}

      {view === 'month' && (
        <>
          <div className="row calbar">
            <button className="ghost small" onClick={() => navigate({ search: { on: shiftCalendar(on, 'month', -1) } })} aria-label="Earlier">
              ‹
            </button>
            <strong className="callabel">
              {new Date(`${on.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC',
              })}
            </strong>
            <button className="ghost small" onClick={() => navigate({ search: { on: shiftCalendar(on, 'month', 1) } })} aria-label="Later">
              ›
            </button>
          </div>
          <div className="calgrid month">
            {keys.map((key) => (
              <button
                key={key}
                className={`calday${key.slice(0, 7) === on.slice(0, 7) ? '' : ' outside'}`}
                aria-label={`${key} — ${dayOf(key).length} on`}
                onClick={() => setDay({ on: key })}
              >
                <span className="calnum">{Number(key.slice(8))}</span>
                {dayOf(key).map((e) => (
                  <span key={e.id} className={`calentry ${d.calendar.colour}`} title={e.detail || e.title}>
                    {!whole(e) && <small>{e.start_time}</small>}
                    <b>{e.title}</b>
                  </span>
                ))}
              </button>
            ))}
          </div>
        </>
      )}

      {day && (
        <DayModal
          day={day.on}
          start={day.start}
          items={dayOf(day.on).map((e) => eventItem(e, d.calendar.name, d.calendar.colour))}
          onChanged={() => router.invalidate()}
          onClose={() => setDay(null)}
        />
      )}

      {view === 'history' &&
        (d.history.length === 0 ? (
          <p className="note">
            Nothing has changed on this calendar yet. Everything added, edited or removed from here on is
            listed, including things that no longer exist.
          </p>
        ) : (
          <div className="movelist">
            <div className="moverow head" aria-hidden="true">
              <span>When</span>
              <span>What</span>
              <span>Change</span>
              <span>By</span>
              <span>Dates</span>
            </div>
            {d.history.map((h) => (
              <div key={h.id} className="moverow">
                <span className="when note">{when(h.created_at)}</span>
                <span className="who">
                  {h.title}
                  {/* The row outlives the event, which is the point — but a row about
                      something that is gone should say so rather than look clickable. */}
                  {!h.event_id && h.action !== 'removed' && <span className="note"> (since deleted)</span>}
                </span>
                <span className="what">
                  <strong>{h.action}</strong>
                  {h.source === 'learned' && <span className="pill">learned</span>}
                </span>
                <span className="by note">{h.actor ?? (h.source === 'learned' ? 'an approval' : 'the app')}</span>
                <span className="why note">{h.detail}</span>
              </div>
            ))}
          </div>
        ))}
    </>
  )
}

/**
 * Adding to a calendar, through the same form the edit sheet uses.
 *
 * Everything about when a thing happens lives in `DateForm`, so the two screens cannot drift
 * apart -- which they had already begun to, the add form having gained a day picker and a
 * backwards-range check that the edit sheet never got.
 */
function NewDate({
  busy,
  courses,
  onAddDays,
  onAddSpan,
}: {
  busy: string
  courses: { title: string; dates: number }[]
  onAddDays: (v: ReturnType<typeof asDays>) => void
  onAddSpan: (v: Record<string, unknown>) => void
}) {
  const [v, setV] = useState(emptyDate)

  return (
    <div className="card" style={{ margin: '10px 0' }}>
      <DateForm value={v} onChange={setV} courses={courses} disabled={!!busy} />
      <div className="row" style={{ marginTop: 14 }}>
        <button
          className="small"
          disabled={!ready(v, busy)}
          onClick={() =>
            v.mode === 'days'
              ? onAddDays(asDays(v))
              : onAddSpan({
                  title: v.title.trim(),
                  detail: v.detail,
                  starts_on: v.starts_on,
                  ends_on: v.ends_on || null,
                  start_time: v.start_time,
                  end_time: v.end_time,
                  repeats: v.repeats,
                })
          }
        >
          {busy === 'event' ? 'Adding…' : v.mode === 'days' && v.days.length > 1 ? `Add ${v.days.length} dates` : 'Add'}
        </button>
      </div>
    </div>
  )
}
