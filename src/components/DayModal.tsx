import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as catalogue from '../server/catalogue'
import { displayName } from '../types'
import { Modal } from './Modal'

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

const save = createServerFn({ method: 'POST' })
  .validator((d: Record<string, unknown>) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const id = Number(data.id)
    // Named either way, so the log says who rather than that somebody did.
    if (data.remove) return catalogue.removeEvent(s.workspaceId, id, s.email)
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
  const loadFn = useServerFn(load)
  const [openKey, setOpenKey] = useState(start ?? '')
  const [editing, setEditing] = useState(false)
  const [face, setFace] = useState<(typeof FACES)[number]>('what')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

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
          {items.map((x) => (
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
          ))}
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

/** The same fields a date is added with, filled in. */
function EditEvent({
  event,
  calendars,
  busy,
  onCancel,
  onSave,
}: {
  event: Editable
  calendars?: { id: number; name: string }[]
  busy: string
  onCancel: () => void
  onSave: (v: Record<string, unknown>) => void
}) {
  const [v, setV] = useState({ ...event, ends_on: event.ends_on ?? '' })

  return (
    <>
      <div className="fields" style={{ marginTop: 14 }}>
        <div>
          <label htmlFor="e-title">What happens</label>
          <input id="e-title" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} />
        </div>
        {calendars && calendars.length > 1 && (
          <div>
            <label htmlFor="e-cal">On</label>
            <select
              id="e-cal"
              value={v.calendar_id}
              onChange={(e) => setV({ ...v, calendar_id: Number(e.target.value) })}
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor="e-from">From</label>
          <input id="e-from" type="date" value={v.starts_on} onChange={(e) => setV({ ...v, starts_on: e.target.value })} />
        </div>
        <div>
          <label htmlFor="e-to">To</label>
          <input id="e-to" type="date" value={v.ends_on} onChange={(e) => setV({ ...v, ends_on: e.target.value })} />
          <p className="note" style={{ margin: '4px 0 0' }}>
            Only for something spanning days.
          </p>
        </div>
        <div>
          <label htmlFor="e-start">Starts at</label>
          <input
            id="e-start"
            type="time"
            value={v.start_time}
            onChange={(e) => setV({ ...v, start_time: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="e-end">Ends at</label>
          <input id="e-end" type="time" value={v.end_time} onChange={(e) => setV({ ...v, end_time: e.target.value })} />
        </div>
        <div>
          <label htmlFor="e-rep">Repeats</label>
          <select id="e-rep" value={v.repeats} onChange={(e) => setV({ ...v, repeats: e.target.value })}>
            <option value="once">Once</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="yearly">Every year</option>
          </select>
        </div>
      </div>
      <label htmlFor="e-detail" style={{ marginTop: 12 }}>
        Anything else the bot should say about it
      </label>
      <input id="e-detail" value={v.detail} onChange={(e) => setV({ ...v, detail: e.target.value })} />
      <div className="row" style={{ marginTop: 14 }}>
        <button className="ghost small" onClick={onCancel} disabled={!!busy}>
          Cancel
        </button>
        <span className="grow" />
        <button
          className="small"
          disabled={!v.title.trim() || !v.starts_on || !!busy}
          onClick={() => onSave({ ...v, ends_on: v.ends_on || null })}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  )
}
