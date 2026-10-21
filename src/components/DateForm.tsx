import { MAX_DAYS, todayFor } from '../types'
import { DayPicker } from './DayPicker'

/** One day of a course, with its own hours when they differ from the rest. */
export type PickedDay = { on: string; start_time?: string; end_time?: string }

export type DateFormValue = {
  title: string
  detail: string
  /** Separate days, or one thing running without a break. */
  mode: 'days' | 'span'
  days: PickedDay[]
  starts_on: string
  ends_on: string
  /** The hours for every day that does not name its own. */
  start_time: string
  end_time: string
  repeats: string
  /** The last day a repeat comes round. Meaningless, and ignored, when it does not repeat. */
  until: string
  /** Whether the form is showing a time against each day. */
  perDay: boolean
}

export const emptyDate = (): DateFormValue => ({
  title: '',
  detail: '',
  mode: 'days',
  days: [{ on: todayFor() }],
  starts_on: todayFor(),
  ends_on: '',
  start_time: '09:00',
  end_time: '',
  repeats: 'once',
  until: '',
  perDay: false,
})

/** What `setDays` wants, out of what the form holds. */
export const asDays = (v: DateFormValue) => ({
  title: v.title.trim(),
  detail: v.detail,
  days: v.perDay ? v.days : v.days.map((d) => d.on),
  start_time: v.start_time,
  end_time: v.end_time,
  repeats: v.repeats,
  until: v.repeats === 'once' ? null : v.until || null,
})

/** The second date means different things, so it is asked for in different words. */
const backwards = (v: DateFormValue) =>
  v.mode === 'span' && !!v.ends_on && v.ends_on < v.starts_on

export const ready = (v: DateFormValue, busy?: string) =>
  !!v.title.trim() && !busy && (v.mode === 'days' ? v.days.length > 0 : !!v.starts_on && !backwards(v))

/**
 * Everything about when a thing happens, asked once and used by both screens.
 *
 * ---------------------------------------------------------------- the shape of the questions
 *
 * Separate days leads and is the default, because that is what a course is and reaching for the
 * range when you meant days is the fault this exists to stop -- one live row read 20 to 27
 * October for a course the team described as "20, 22, 27 October".
 *
 * Repeating is a modifier rather than a third mode. "Monday and Wednesday, weekly, until 14
 * December" is a real thing somebody runs and three separate tabs cannot say it: it is picked
 * days *and* repeating at once. One row carries one anchor, so that becomes two rows that each
 * come round inside the same window, which is what `fallsOn` already reads.
 *
 * ---------------------------------------------------------------- one field, named honestly
 *
 * The second date is the end of a span when nothing repeats and the end of the window when
 * something does -- that is what `ends_on` has always meant, and leaving it labelled "To" in both
 * cases is where the confusion came from. So it is labelled for whichever it currently is.
 */
export function DateForm({
  value: v,
  onChange,
  courses = [],
  disabled,
}: {
  value: DateFormValue
  onChange: (v: DateFormValue) => void
  /** Courses already on this calendar, offered so a new intake can join one. */
  courses?: { title: string; dates: number }[]
  disabled?: boolean
}) {
  const set = (patch: Partial<DateFormValue>) => onChange({ ...v, ...patch })
  const repeating = v.repeats !== 'once'

  return (
    <>
      <div className="fields">
        <div className="field wide">
          <label htmlFor="df-title">What happens</label>
          <input
            id="df-title"
            list={courses.length ? 'df-courses' : undefined}
            value={v.title}
            disabled={disabled}
            onChange={(e) => set({ title: e.target.value })}
          />
          {/*
            The courses already here, offered rather than imposed. Typing stays typing — this is
            a datalist, not a select — but adding November's dates to a course that exists can
            now attach to it instead of inventing another wording of its name, which is how one
            intake ended up as fifteen rows nothing could group.
          */}
          {courses.length > 0 && (
            <datalist id="df-courses">
              {courses.map((c) => (
                <option key={c.title} value={c.title}>
                  {c.dates} date{c.dates === 1 ? '' : 's'}
                </option>
              ))}
            </datalist>
          )}
        </div>
      </div>

      <label style={{ marginTop: 14 }}>When</label>
      <div className="seg small" role="tablist" aria-label="When it happens">
        <button
          type="button"
          role="tab"
          aria-selected={v.mode === 'days'}
          className={v.mode === 'days' ? 'on' : ''}
          disabled={disabled}
          onClick={() => set({ mode: 'days' })}
        >
          Individual dates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={v.mode === 'span'}
          className={v.mode === 'span' ? 'on' : ''}
          disabled={disabled}
          onClick={() => set({ mode: 'span' })}
        >
          A range
        </button>
      </div>

      {v.mode === 'days' ? (
        <div style={{ marginTop: 10 }}>
          <DayPicker
            days={v.days.map((d) => d.on)}
            max={MAX_DAYS}
            disabled={disabled}
            onChange={(days) =>
              // Keep the hours already set against a day that is still chosen.
              set({ days: days.map((on) => v.days.find((d) => d.on === on) ?? { on }) })
            }
          />
        </div>
      ) : (
        <div className="fields" style={{ marginTop: 10 }}>
          <div>
            <label htmlFor="df-from">From</label>
            <input id="df-from" type="date" value={v.starts_on} disabled={disabled} onChange={(e) => set({ starts_on: e.target.value })} />
          </div>
          <div>
            <label htmlFor="df-to">{repeating ? 'Repeats until' : 'To'}</label>
            <input
              id="df-to"
              type="date"
              min={v.starts_on || undefined}
              value={v.ends_on}
              disabled={disabled}
              onChange={(e) => set({ ends_on: e.target.value })}
            />
            <p className={backwards(v) ? 'warn' : 'note'} style={{ margin: '4px 0 0' }}>
              {backwards(v)
                ? 'The last day is before the first one.'
                : repeating
                  ? 'The last day it comes round. Leave it empty and it never stops.'
                  : 'The last day it runs, for something without a break.'}
            </p>
          </div>
        </div>
      )}

      <label style={{ marginTop: 14 }}>Times</label>
      <div className="seg small" role="tablist" aria-label="How the hours are set">
        <button
          type="button"
          role="tab"
          aria-selected={!v.perDay}
          className={!v.perDay ? 'on' : ''}
          disabled={disabled}
          onClick={() => set({ perDay: false })}
        >
          The same every time
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={v.perDay}
          className={v.perDay ? 'on' : ''}
          disabled={disabled || v.mode === 'span'}
          title={v.mode === 'span' ? 'A range is one thing, so it has one pair of hours.' : undefined}
          onClick={() =>
            // Seeded from the shared pair, so switching across loses nothing and the rare case
            // starts from the common one rather than from blank.
            set({
              perDay: true,
              days: v.days.map((d) => ({ ...d, start_time: d.start_time ?? v.start_time, end_time: d.end_time ?? v.end_time })),
            })
          }
        >
          Different for some dates
        </button>
      </div>

      <div className="fields" style={{ marginTop: 10 }}>
        <div>
          <label htmlFor="df-start">{v.perDay ? 'Starts at, where not set below' : 'Starts at'}</label>
          <input id="df-start" type="time" value={v.start_time} disabled={disabled} onChange={(e) => set({ start_time: e.target.value })} />
        </div>
        <div>
          <label htmlFor="df-end">Ends at</label>
          <input id="df-end" type="time" value={v.end_time} disabled={disabled} onChange={(e) => set({ end_time: e.target.value })} />
          <p className="note" style={{ margin: '4px 0 0' }}>
            An hour after the start if you leave it.
          </p>
        </div>
        <div>
          <label htmlFor="df-rep">Repeats</label>
          <select id="df-rep" value={v.repeats} disabled={disabled} onChange={(e) => set({ repeats: e.target.value })}>
            <option value="once">Never</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="yearly">Every year</option>
          </select>
          {repeating && v.mode === 'days' && (
            <p className="note" style={{ margin: '4px 0 0' }}>
              Each date chosen comes round again.
            </p>
          )}
        </div>
        {repeating && v.mode === 'days' && (
          <div>
            <label htmlFor="df-until">Repeats until</label>
            <input id="df-until" type="date" value={v.until} disabled={disabled} onChange={(e) => set({ until: e.target.value })} />
            <p className="note" style={{ margin: '4px 0 0' }}>
              Leave it empty and it never stops.
            </p>
          </div>
        )}
      </div>

      {v.perDay && v.mode === 'days' && v.days.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <label>Hours for each date</label>
          {[...v.days]
            .sort((a, b) => a.on.localeCompare(b.on))
            .map((d) => (
              <div key={d.on} className="row" style={{ gap: 10, alignItems: 'center', marginTop: 6 }}>
                <span style={{ minWidth: 150, fontSize: 13 }}>{spoken(d.on)}</span>
                <input
                  type="time"
                  aria-label={`Starts at on ${d.on}`}
                  style={{ width: 130 }}
                  value={d.start_time ?? v.start_time}
                  disabled={disabled}
                  onChange={(e) => set({ days: v.days.map((x) => (x.on === d.on ? { ...x, start_time: e.target.value } : x)) })}
                />
                <input
                  type="time"
                  aria-label={`Ends at on ${d.on}`}
                  style={{ width: 130 }}
                  value={d.end_time ?? v.end_time}
                  disabled={disabled}
                  onChange={(e) => set({ days: v.days.map((x) => (x.on === d.on ? { ...x, end_time: e.target.value } : x)) })}
                />
              </div>
            ))}
        </div>
      )}

      <label htmlFor="df-detail" style={{ marginTop: 14 }}>
        Anything else the bot should say about it
      </label>
      <input id="df-detail" value={v.detail} disabled={disabled} onChange={(e) => set({ detail: e.target.value })} />
    </>
  )
}

/** "Saturday 17 October", for a row somebody is setting hours against. */
const spoken = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
