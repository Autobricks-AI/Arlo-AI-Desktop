import { Fragment, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as catalogue from '../server/catalogue'
import { displayName } from '../types'
import { Modal } from './Modal'
import { DateForm, asDays, emptyDate, ready } from './DateForm'
import type { DateFormValue } from './DateForm'

/**
 * A day, then one date on it.
 *
 * The calendar draws a chip a few pixels tall, which is the wrong size for anything except
 * "something is on". Everything a person wants once they have seen that — when exactly, where
 * it came from, who it is with, what has been done to it, and changing any of it — lives here,
 * one tap in.
 *
 * Removing lives here too, and nowhere else. It used to be what a tap on the chip itself did:
 * no dialog, no undo, and the chip sat under a fingertip on a phone. A date was lost that way.
 */
const load = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    return {
      log: await catalogue.eventHistory(s.workspaceId, data),
      origin: await catalogue.eventOrigin(s.workspaceId, data),
    }
  })

/**
 * The other dates of the same thing as this one.
 *
 * Fetched rather than passed in, because the sheet is handed one day's items and has no idea
 * what else is on the calendar. `grouped` says whether these rows are tied by a token or merely
 * resemble each other, and the sheet shows them very differently for it.
 */
const courseFor = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data }) => catalogue.courseOf((await requireSession()).workspaceId, data))

/** Say that these dates are one course. The one press that turns a resemblance into a fact. */
const stamp = createServerFn({ method: 'POST' })
  .validator((d: { ids: number[] }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    return catalogue.stampSeries(s.workspaceId, data.ids, s.email)
  })

/** A whole course, set at once: the days it runs, their hours, and whether they come round. */
const saveCourse = createServerFn({ method: 'POST' })
  .validator(
    (d: {
      series?: string | null
      title: string
      detail?: string
      days: (string | { on: string; start_time?: string | null; end_time?: string | null })[]
      start_time?: string
      end_time?: string
      repeats?: string
      until?: string | null
      calendar_id?: number | null
      replacing: number[]
    }) => d,
  )
  .handler(async ({ data }) => {
    const s = await requireSession()
    const { replacing, ...e } = data
    await catalogue.setDays(s.workspaceId, { ...e, actor: s.email }, replacing)
  })

const save = createServerFn({ method: 'POST' })
  .validator((d: Record<string, unknown>) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const id = Number(data.id)
    // Named either way, so the log says who rather than that somebody did.
    if (data.remove) return catalogue.removeEvent(s.workspaceId, id, s.email)
    if (data.split) return void (await catalogue.splitEvent(s.workspaceId, id, s.email))
    await catalogue.editEvent(s.workspaceId, id, { ...data, actor: s.email } as never)
  })

export type DayItem = {
  key: string
  colour: string
  title: string
  detail: string
  /** HH:MM, or empty for something that lasts the day. */
  time: string
  /** The whole of when it happens, in words. */
  when: string
  /** The calendar or the board it sits on. */
  where: string
  /** 'learned' when an approval put it there, anything else when somebody typed it. */
  source: string
  /** Set for our own calendars: the dates that keep a log, and the only ones editable here. */
  eventId?: number
  /** The row itself, for the form to start from. */
  event?: Editable
  /** Set for a project's dates, which are an arrangement with one particular person. */
  person?: { id: number; name: string; email: string | null; phone: string | null }
}

type Editable = {
  id: number
  title: string
  detail: string
  starts_on: string
  ends_on: string | null
  start_time: string
  end_time: string
  repeats: string
  calendar_id: number
  /** The rows entered as one course share one. Null on everything entered as a single date. */
  series?: string | null
}

const whole = (e: { start_time: string; end_time: string }) => e.start_time === '00:00' && e.end_time === '23:59'

export const shortDay = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })

/**
 * One of our own dates, shaped for the day list and its detail.
 *
 * Here rather than in each page: the merged calendar and a single calendar's own page were
 * both about to grow their own idea of how to write "25 Aug to 27 Aug · all day · every year".
 */
/**
 * Which dates occupy exactly the same slot on a day.
 *
 * A slot is the whole span and both times. Not an identity -- two different courses genuinely
 * run the same days at the same hours -- which is why nothing here removes anything. It is a
 * grouping, so six wordings of one intake take one line in the grid instead of six, and every
 * title is still there to read the moment somebody opens the day.
 *
 * Anything without an event of its own -- a board entry, a booking -- groups only with itself.
 */
export const slotOf = (x: DayItem) =>
  x.event
    ? `slot:${x.event.starts_on}|${x.event.ends_on ?? ''}|${x.event.start_time}|${x.event.end_time}`
    : `one:${x.key}`

/** The same items, with everything sharing a slot folded under the first of them. */
export function bySlot(items: DayItem[]): { leader: DayItem; also: DayItem[] }[] {
  const seats = new Map<string, { leader: DayItem; also: DayItem[] }>()
  const out: { leader: DayItem; also: DayItem[] }[] = []
  for (const x of items) {
    const slot = slotOf(x)
    const seat = seats.get(slot)
    if (seat) seat.also.push(x)
    else {
      const fresh = { leader: x, also: [] as DayItem[] }
      seats.set(slot, fresh)
      out.push(fresh)
    }
  }
  return out
}

export const eventItem = (e: Editable & { source: string }, where: string, colour: string): DayItem => ({
  key: `e${e.id}`,
  colour,
  title: e.title,
  detail: e.detail,
  time: whole(e) ? '' : e.start_time,
  when: [
    e.ends_on && e.ends_on !== e.starts_on
      ? `${shortDay(e.starts_on)} to ${shortDay(e.ends_on)}`
      : shortDay(e.starts_on),
    whole(e) ? 'all day' : `${e.start_time}–${e.end_time}`,
    e.repeats === 'once' ? '' : `every ${e.repeats.replace('ly', '')}`,
  ]
    .filter(Boolean)
    .join(' · '),
  where,
  source: e.source,
  eventId: e.id,
  event: e,
})

const longDay = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

type About = Awaited<ReturnType<typeof load>>

const FACES = ["what", "from", "changes"] as const

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export function DayModal({
  day,
  items,
  start,
  calendars,
  onChanged,
  onClose,
}: {
  day: string
  items: DayItem[]
  /** A date to open directly, for somewhere that was already showing one. */
  start?: string
  /** Offered as somewhere to move a date to. Omitted where there is only one. */
  calendars?: { id: number; name: string }[]
  /** Reload whatever the page is showing: the month behind this has just changed. */
  onChanged: () => Promise<unknown>
  onClose: () => void
}) {
  const saveFn = useServerFn(save)
  const courseFn = useServerFn(saveCourse)
  const stampFn = useServerFn(stamp)
  const loadFn = useServerFn(load)
  const [openKey, setOpenKey] = useState(start ?? '')
  const [editing, setEditing] = useState(false)
  const [face, setFace] = useState<(typeof FACES)[number]>('what')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  /*
   * Keep one of a slot, and take the rest off the calendar.
   *
   * Only ever from a click naming which one to keep. Removal goes through the same server call
   * an ordinary delete uses, so each one lands in the calendar's history with a name against
   * it and can be seen after the fact -- which is the safety net for a judgement the machine
   * was never able to make.
   */
  const keepOnly = async (keep: DayItem, group: DayItem[]) => {
    const drop = group.filter((x) => x.eventId && x.eventId !== keep.eventId)
    if (!drop.length) return
    setBusy(`keep${keep.key}`)
    setErr('')
    try {
      for (const x of drop) await saveFn({ data: { id: x.eventId, remove: true } })
      await onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  // Read back out of the fresh props rather than held: after a change the parent reloads,
  // and a copy taken on click would still be showing the date as it was.
  const open = items.find((x) => x.key === openKey)

  /*
   * Where it came from and what has been done to it, fetched when a date is opened rather
   * than with the month: a join nobody has asked for is not worth doing on every cell of a
   * calendar. Read here rather than inside the tab so the tab can be labelled with a count.
   */
  const [about, setAbout] = useState<About | null>(null)
  const openId = open?.eventId
  useEffect(() => {
    setAbout(null)
    if (!openId) return
    let live = true
    void loadFn({ data: openId })
      .then((got) => live && setAbout(got))
      .catch(() => live && setAbout({ log: [], origin: undefined }))
    return () => {
      live = false
    }
  }, [openId, loadFn])

  /** The same shape as `act`, for the writes that do not go through the one-row `save` door. */
  const run = async (what: string, call: () => Promise<unknown>) => {
    setBusy(what)
    setErr('')
    try {
      await call()
      await onChanged()
      return true
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy('')
    }
  }

  const act = async (what: string, data: Record<string, unknown>) => {
    setBusy(what)
    setErr('')
    try {
      await saveFn({ data })
      await onChanged()
      return true
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy('')
    }
  }

  const back = () => {
    setOpenKey("")
    setEditing(false)
    setFace("what")
  }

  if (openKey && !open) {
    return (
      <Modal title={longDay(day)} onClose={onClose}>
        <p className="note">That date is no longer here.</p>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost small" onClick={back}>
            ← Back to the day
          </button>
        </div>
      </Modal>
    )
  }

  if (open) {
    return (
      <Modal title={open.title} note={open.where} onClose={onClose}>
        <div className="row" style={{ marginTop: 0 }}>
          <button className="ghost small" onClick={back}>
            ← {longDay(day)}
          </button>
          <span className="grow" />
          {open.event && !editing && (
            <button className="ghost small" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>

        {err && (
          <p className="err" role="alert">
            {err}
          </p>
        )}

        {editing && open.event ? (
          <EditEvent
            event={open.event}
            calendars={calendars}
            busy={busy}
            onCancel={() => setEditing(false)}
            onSave={(v) => void act('save', v).then((ok) => ok && setEditing(false))}
            /*
              A course is written through setDays, which diffs: a day somebody moved keeps its
              row, a day taken off is removed, and the calendar document is rewritten once at
              the end rather than once per date.
            */
            onSaveCourse={(v, replacing) =>
              void run('save', () => courseFn({ data: { ...v, replacing } })).then((ok) => ok && setEditing(false))
            }
            onStamp={(ids) => run('stamp', () => stampFn({ data: { ids } }))}
            /*
             * Closes the sheet on success rather than staying open: the date being edited no
             * longer exists — it is now one row per day — so there is nothing left to edit
             * and the list behind is the right place to land.
             */
            onSplit={() => void act('split', { id: open.eventId, split: true }).then((ok) => ok && back())}
          />
        ) : (
          <>
            {/* Three short answers rather than one long page: what it is, where it came
                from, and what has happened to it. Only the first is ever urgent. */}
            <div className="seg tabstrip" role="tablist" aria-label="This date">
              {FACES.map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={face === f}
                  className={face === f ? 'on' : ''}
                  onClick={() => setFace(f)}
                >
                  {f === 'what' ? 'Details' : f === 'from' ? 'Where from' : `Changes${about ? ` (${about.log.length})` : ''}`}
                </button>
              ))}
            </div>

            {face === 'what' && (
              <dl className="factlist">
                <dt>When</dt>
                <dd>{open.when}</dd>
                <dt>On</dt>
                <dd>{open.where}</dd>
                {open.detail && (
                  <>
                    <dt>Detail</dt>
                    <dd>{open.detail}</dd>
                  </>
                )}
                {open.person && (
                  <>
                    {/* A project's dates are arrangements with somebody, so who it is with is
                        the first thing to know and the reason no chatbot reads these. */}
                    <dt>With</dt>
                    <dd>
                      <Link to="/contact/$id" params={{ id: String(open.person.id) }}>
                        {open.person.name}
                      </Link>
                      {(open.person.email || open.person.phone) && (
                        <small className="note"> · {open.person.email || open.person.phone}</small>
                      )}
                    </dd>
                  </>
                )}
              </dl>
            )}

            {face !== 'what' &&
              (!open.eventId ? (
                <p className="note">
                  Kept on the board it belongs to. Changes to it are made there, on the person&rsquo;s card.
                </p>
              ) : !about ? (
                <p className="note">Reading…</p>
              ) : face === 'from' ? (
                <CameFrom about={about} source={open.source} />
              ) : (
                <Changes log={about.log} />
              ))}

            {open.eventId && (
              <div className="row" style={{ marginTop: 16 }}>
                <span className="grow" />
                <button
                  className="ghost small bad"
                  disabled={!!busy}
                  onClick={() => {
                    if (
                      !confirm(`Remove "${open.title}"? It comes off the calendar and the bot stops mentioning it.`)
                    )
                      return
                    void act('remove', { id: open.eventId, remove: true }).then((ok) => ok && back())
                  }}
                >
                  {busy === 'remove' ? 'Removing…' : 'Remove this date'}
                </button>
              </div>
            )}
          </>
        )}
      </Modal>
    )
  }

  return (
    <Modal
      title={longDay(day)}
      note={items.length === 0 ? undefined : `${items.length} thing${items.length === 1 ? '' : 's'} on`}
      onClose={onClose}
    >
      {items.length === 0 ? (
        <p className="note">Nothing on this day.</p>
      ) : (
        <div className="pricelist">
          {bySlot(items).map(({ leader, also }) => {
            const row = (x: DayItem) => (
              <button key={x.key} className={`dayitem ${x.colour}`} onClick={() => setOpenKey(x.key)}>
                <span className="dot" />
                <span className="what">
                  <b>{x.title}</b>
                  <small className="note">
                    {x.time || 'All day'} · {x.where}
                    {x.detail ? ` · ${x.detail}` : ''}
                  </small>
                </span>
                <span className="note">›</span>
              </button>
            )

            // One date in its slot is just a date. No box, nothing to decide.
            if (!also.length || !leader.eventId) return <Fragment key={leader.key}>{row(leader)}</Fragment>

            /*
             * Several dates in one slot, drawn inside their own box.
             *
             * Sometimes that is one intake somebody approved six wordings of; sometimes it is
             * two courses that genuinely run the same days at the same hours. Nothing here can
             * tell those apart -- the six wordings of one course score lower against each other
             * than the two real courses do -- so the choice is offered rather than taken.
             *
             * The box is the point: a loose row of "Keep" buttons under a flat list gives no
             * clue which dates any of them would remove.
             */
            const group = [leader, ...also]
            return (
              <section key={leader.key} className="slotgroup">
                <header>
                  <b>{group.length} dates share this slot</b>
                  <small className="note">
                    {leader.when}. Keep the one that reads best and the others come off the calendar — unless these
                    are different things that happen to run together, in which case leave them.
                  </small>
                </header>
                {group.map(row)}
                <div className="slotkeep">
                  {group.map((x) => (
                    <button
                      key={x.key}
                      type="button"
                      className="ghost small"
                      disabled={!!busy}
                      onClick={() => void keepOnly(x, group)}
                    >
                      {busy === `keep${x.key}` ? 'Merging…' : `Keep “${x.title}”`}
                    </button>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

/** Where this date came from — the conversation behind it, or the person who typed it. */
function CameFrom({ about, source }: { about: About; source: string }) {
  const o = about.origin
  const added = about.log.find((h) => h.action === "added")

  if (!o)
    return (
      <dl className="factlist">
        <dt>How</dt>
        <dd>
          {source === "learned"
            ? "Learned from a conversation and approved. The thread it came from is no longer here."
            : "Typed in by hand."}
        </dd>
        {added && <dt>Added</dt>}
        {added && (
          <dd>
            {when(added.created_at)}
            {added.actor ? ` by ${added.actor}` : ""}
          </dd>
        )}
      </dl>
    )

  return (
    <dl className="factlist">
      <dt>How</dt>
      <dd>
        Your team said it in a conversation. <b>{o.bot}</b> put it up for approval, and somebody approved it.
      </dd>
      <dt>Said</dt>
      <dd>&ldquo;{o.said}&rdquo;</dd>
      {o.conversation_id && (
        <>
          <dt>In</dt>
          <dd>
            {/* The whole reason to ask where a date came from is to go and read the thread
                that said it. */}
            <Link to="/inbox" search={{ id: o.conversation_id }}>
              {o.subject || `The ${o.channel} thread`}
            </Link>
            {o.customer_id && (
              <>
                {" with "}
                <Link to="/contact/$id" params={{ id: String(o.customer_id) }}>
                  {displayName({ ...o, id: o.customer_id })}
                </Link>
              </>
            )}
          </dd>
        </>
      )}
      <dt>Heard</dt>
      <dd>{when(o.learned_at)}</dd>
      {added && <dt>Approved</dt>}
      {added && <dd>{when(added.created_at)}</dd>}
    </dl>
  )
}

/** Everything done to this date since it arrived, newest first. */
function Changes({ log }: { log: About["log"] }) {
  if (log.length === 0) return <p className="note">Nothing has been changed since it was added.</p>

  return (
    <div className="movelist tight">
      {log.map((h) => (
        <div key={h.id} className="moverow">
          <span className="when note">{when(h.created_at)}</span>
          <span className="what">
            <strong>{h.action}</strong>
          </span>
          <span className="by note">{h.actor ?? (h.source === "learned" ? "an approval" : "the app")}</span>
          <span className="why note">{h.detail}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Editing a date, as the thing it is part of.
 *
 * ---------------------------------------------------------------- why it is not one row
 *
 * A course meeting on three days is three rows sharing a title, and this sheet used to edit
 * exactly one of them -- so fixing the hours on a three-day course meant opening it three times,
 * and changing its name left the other two under the old one. The same form the add screen uses
 * now sits here, over the whole course, saved through `setDays`: the parameter documented as
 * "the course as it stood when the sheet was opened" and until now never passed by anybody.
 *
 * ---------------------------------------------------------------- what it refuses to assume
 *
 * Rows entered before any of this have no token, and those are the ones somebody arrives wanting
 * to fix. They can be found by resemblance, and resemblance is not identity: two intakes of one
 * course at the same hours are indistinguishable by name and time. So when the rows only look
 * alike they are listed and nothing more, behind one button that says so. Guessing instead would
 * put a delete beside a row that belongs to a different intake.
 */
function EditEvent({
  event,
  calendars,
  busy,
  onCancel,
  onSave,
  onSaveCourse,
  onStamp,
  onSplit,
}: {
  event: Editable
  calendars?: { id: number; name: string }[]
  busy: string
  onCancel: () => void
  onSave: (v: Record<string, unknown>) => void
  onSaveCourse: (v: ReturnType<typeof asDays> & { series?: string | null; calendar_id: number }, replacing: number[]) => void
  onStamp: (ids: number[]) => Promise<unknown>
  /** Absent for a date that has no days to split — a single day, or one that repeats. */
  onSplit?: () => void
}) {
  const courseFn = useServerFn(courseFor)
  const [course, setCourse] = useState<Awaited<ReturnType<typeof courseFor>> | null>(null)
  const [v, setV] = useState<DateFormValue | null>(null)
  const [moveTo, setMoveTo] = useState(event.calendar_id)

  /*
   * Read when the sheet opens rather than copied from the row it was opened on.
   *
   * The old form took a snapshot of one row and never resynced, which was survivable for one
   * row and is not for a course: the other days are not in the props at all, and a save from
   * inside this sheet reloads the page underneath it.
   */
  useEffect(() => {
    let live = true
    void courseFn({ data: event.id })
      .then((got) => {
        if (!live || !got) return
        setCourse(got)
        setV(formFor(got.grouped ? got.rows : [event as never]))
      })
      .catch(() => live && setV(formFor([event as never])))
    return () => {
      live = false
    }
  }, [courseFn, event])

  if (!v) return <p className="note">Reading the dates…</p>

  const alike = course && !course.grouped && course.rows.length > 1 ? course.rows : []

  return (
    <div style={{ marginTop: 14 }}>
      <DateForm value={v} onChange={setV} disabled={!!busy} />

      {calendars && calendars.length > 1 && (
        <div className="fields" style={{ marginTop: 14 }}>
          <div>
            <label htmlFor="e-cal">On</label>
            <select id="e-cal" value={moveTo} disabled={!!busy} onChange={(e) => setMoveTo(Number(e.target.value))}>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/*
        Rows that merely look like this one. Listed, counted, and left alone until somebody says
        they are one thing -- in the spirit of the Keep this one buttons above and of
        dedupe-dates refusing to decide which rows are duplicates.
      */}
      {alike.length > 0 && (
        <p className="note splitnote" style={{ marginTop: 14 }}>
          {alike.length - 1} other date{alike.length === 2 ? '' : 's'} share this name and these hours:{' '}
          {alike.map((r) => r.starts_on).join(', ')}. They are not recorded as one course, so this edits only{' '}
          {event.starts_on}.
          <button
            type="button"
            className="ghost small"
            disabled={!!busy}
            onClick={() => void onStamp(alike.map((r) => r.id))}
          >
            {busy === 'stamp' ? 'Joining…' : 'Treat these as one course'}
          </button>
        </p>
      )}

      {onSplit && v.mode === 'span' && v.ends_on && v.ends_on > v.starts_on && v.repeats === 'once' && (
        <p className="note splitnote" style={{ marginTop: 14 }}>
          This is one date covering every day from {v.starts_on} to {v.ends_on}. Split it and each day becomes its
          own, to edit or remove on its own.
          <button type="button" className="ghost small" disabled={!!busy} onClick={onSplit}>
            {busy === 'split' ? 'Splitting…' : 'Split into separate days'}
          </button>
        </p>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="ghost small" onClick={onCancel} disabled={!!busy}>
          Cancel
        </button>
        <span className="grow" />
        <button
          className="small"
          disabled={!ready(v, busy)}
          onClick={() =>
            v.mode === 'days'
              ? onSaveCourse(
                  { ...asDays(v), series: course?.series ?? null, calendar_id: moveTo },
                  course?.grouped ? course.rows.map((r) => r.id) : [event.id],
                )
              : onSave({
                  id: event.id,
                  title: v.title.trim(),
                  detail: v.detail,
                  starts_on: v.starts_on,
                  ends_on: v.ends_on || null,
                  start_time: v.start_time,
                  end_time: v.end_time,
                  repeats: v.repeats,
                  calendar_id: moveTo,
                })
          }
        >
          {busy === 'save' ? 'Saving…' : v.mode === 'days' && v.days.length > 1 ? `Save ${v.days.length} dates` : 'Save'}
        </button>
      </div>
    </div>
  )
}

/** The rows of a course, as the form holds them. */
function formFor(rows: Editable[]): DateFormValue {
  const first = rows[0]
  const span = rows.length === 1 && !!first.ends_on && first.ends_on > first.starts_on && first.repeats === 'once'
  const hours = new Set(rows.map((r) => `${r.start_time}-${r.end_time}`))
  return {
    ...emptyDate(),
    title: first.title,
    detail: first.detail,
    // A span stays a span; anything else is the days it runs on, which is most things.
    mode: span ? 'span' : 'days',
    days: rows.map((r) => ({ on: r.starts_on, start_time: r.start_time, end_time: r.end_time })),
    starts_on: first.starts_on,
    ends_on: first.ends_on ?? '',
    start_time: first.start_time,
    end_time: first.end_time,
    repeats: first.repeats,
    // For a repeat the second column is the window, which is what the form calls "until".
    until: first.repeats !== 'once' ? (first.ends_on ?? '') : '',
    // Shown as written: a course whose days already differ opens saying so rather than hiding it.
    perDay: hours.size > 1,
  }
}
