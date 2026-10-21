import { useState } from 'react'
import { calendarRange, shiftCalendar, todayFor } from '../types'

/**
 * Pick the days a thing actually runs on.
 *
 * ---------------------------------------------------------------- what it is for
 *
 * A course meeting on three days is three rows sharing a title. The only form for entering one
 * offered From and To, so people entered a range -- and a range is drawn on every day between.
 * One live row read 20 to 27 October for a course the team described as "20, 22, 27 October":
 * eight days claimed, five with a class on them nobody is teaching.
 *
 * ---------------------------------------------------------------- the grid is not a calday
 *
 * It borrows `.calgrid` for the seven columns and nothing else. A `.calday` is a container for a
 * day's entries -- 96px tall, a flex column -- and a cell here holds one number and whether it
 * is chosen. The three month grids in the app each hard-code what they paint inside a cell, so
 * reusing one would mean a fourth set of props rather than a shared thing.
 *
 * ---------------------------------------------------------------- and a date box beside it
 *
 * A hand-rolled grid is not keyboard-reachable without writing arrow-key handling, and a native
 * date input is keyboard-reachable, localised and free. So the grid is the quick way and the
 * input is the other way, and neither is the only way.
 */
export function DayPicker({
  days,
  onChange,
  max,
  disabled,
}: {
  /** YYYY-MM-DD, in any order. */
  days: string[]
  onChange: (days: string[]) => void
  max: number
  disabled?: boolean
}) {
  // The month on show follows what is already picked, so editing a course opens where it runs.
  const [on, setOn] = useState(() => [...days].sort()[0] ?? todayFor())
  const [typed, setTyped] = useState('')
  const today = todayFor()
  const { keys } = calendarRange(on, 'month')
  const picked = new Set(days)
  const full = days.length >= max

  const toggle = (key: string) => {
    if (disabled) return
    // Off is always allowed; on is what the cap applies to, or a full picker cannot be emptied.
    if (picked.has(key)) onChange(days.filter((d) => d !== key))
    else if (!full) onChange([...days, key].sort())
  }

  const month = new Date(`${on}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" className="ghost small" aria-label="Previous month" onClick={() => setOn(shiftCalendar(on, 'month', -1))}>
          ‹
        </button>
        <b style={{ fontSize: 14, minWidth: 140, textAlign: 'center' }}>{month}</b>
        <button type="button" className="ghost small" aria-label="Next month" onClick={() => setOn(shiftCalendar(on, 'month', 1))}>
          ›
        </button>
        <span className="grow" />
        {/*
          Counted, never typed in. A number set before picking is a second thing that can be
          wrong, and then a Save button disabled for a reason somebody has to go and read.
        */}
        <span className="note" aria-live="polite">
          {days.length === 0 ? 'No days chosen yet' : `${days.length} day${days.length === 1 ? '' : 's'} chosen`}
          {full ? ` — ${max} is the most` : ''}
        </span>
      </div>

      <div className="calgrid month picker" role="group" aria-label="Days this runs on">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="calhead">
            {d}
          </div>
        ))}
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={picked.has(key)}
            aria-label={key}
            disabled={disabled || (full && !picked.has(key))}
            className={`calpick${key.slice(0, 7) === on.slice(0, 7) ? '' : ' outside'}${key === today ? ' now' : ''}`}
            onClick={() => toggle(key)}
          >
            {Number(key.slice(8))}
          </button>
        ))}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'flex-end' }}>
        <div>
          <label htmlFor="dp-add">Or type a day</label>
          <input
            id="dp-add"
            type="date"
            value={typed}
            disabled={disabled || full}
            onChange={(e) => {
              const v = e.target.value
              setTyped('')
              if (v && !picked.has(v)) {
                onChange([...days, v].sort())
                setOn(v)
              }
            }}
          />
        </div>
      </div>

      {days.length > 0 && (
        <div className="pickeddays">
          {[...days].sort().map((d) => (
            <span key={d} className="chip on">
              {spoken(d)}
              <button type="button" aria-label={`Remove ${d}`} disabled={disabled} onClick={() => toggle(d)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** "Sat 17 Oct". Short, because a chip row of these has to fit. */
const spoken = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })
