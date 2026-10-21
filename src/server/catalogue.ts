/**
 * What the company sells, and the dates it wants remembered.
 *
 * Both are things every business knows and no document states well. A price list arrives as
 * a PDF whose text a model has to reassemble — which is how a price ends up two rows from
 * the thing it belongs to — and a calendar arrives as somebody's memory.
 *
 * So both are structured, edited as themselves, and **mirrored into the knowledge base as
 * one document each**. The structure is what a person edits; the document is what the bot
 * reads, through exactly the same retrieval, citation and guardrails as anything else. The
 * mirror is the whole trick: no new path into an answer, no second retrieval, nothing to
 * keep in step beyond one `store()` call after a write.
 */
import { all, insert, one, run } from './db.ts'
import * as bases from './bases.ts'
import { store } from './kb.ts'
import { CALENDAR_COLOURS, MAX_DAYS, STANDARD_BASES, fallsOn, todayFor } from '../types.ts'

export type Product = {
  id: number
  name: string
  description: string
  sku: string | null
  price: number | null
  currency: string
  unit: string | null
  active: boolean
  position: number
}

/** One calendar. Project calendars are not these — see the migration. */
export type Calendar = {
  id: number
  name: string
  description: string
  colour: string
  is_default: boolean
  position: number
  events: number
}

/** The palette, defined in types.ts because the picker for it runs in the browser. */
export const COLOURS = CALENDAR_COLOURS

export type Event = {
  calendar_id: number
  id: number
  title: string
  detail: string
  starts_on: string
  ends_on: string | null
  /** HH:MM. Every event on the calendar has one — see `addEvent`. */
  start_time: string
  end_time: string
  repeats: 'once' | 'weekly' | 'monthly' | 'yearly'
  source: string
  /** The rows entered as one course share one. Null on anything entered as a single date. */
  series?: string | null
}

/**
 * A time, or nothing usable.
 *
 * Postgres hands `time` back as HH:MM:SS and every input in the app speaks HH:MM, so the
 * seconds are cut here rather than in four components that would each have to remember.
 */
const clock = (v: unknown) => {
  const t = String(v ?? '').trim()
  return /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : null
}

/** An hour later, wrapping at midnight — the default when only a start was given. */
const hourAfter = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return `${String((h + 1) % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export const REPEATS = ['once', 'weekly', 'monthly', 'yearly'] as const

// ---------------------------------------------------------------- products

export const products = (workspaceId: number) =>
  all<Product>(
    `SELECT id, name, description, sku, price::float8 AS price, currency, unit, active, position
       FROM products WHERE workspace_id = ? ORDER BY position, id`,
    workspaceId,
  )

/**
 * Add one product, and republish the price list the bot answers from.
 *
 * `defer` skips that last step for a caller adding many at once. Republishing rewrites the
 * whole catalogue document and re-embeds every chunk of it over the network, so doing it per
 * row turns approving 35 products into 35 round-trips over a document that grows each time —
 * which is minutes of waiting for something that is only text. The caller publishes once
 * when it is done. See `decide()` in lessons.ts.
 */
export async function addProduct(workspaceId: number, p: Partial<Product>, defer = false) {
  const name = (p.name ?? '').trim().slice(0, 200)
  if (!name) throw new Error('Give it a name — it is what a customer will ask for.')

  const last = await one<{ n: number }>(
    `SELECT COALESCE(max(position), -1) + 1 AS n FROM products WHERE workspace_id = ?`,
    workspaceId,
  )
  const id = await insert(
    `INSERT INTO products (workspace_id, name, description, sku, price, currency, unit, position)
     VALUES (?,?,?,?,?,?,?,?)`,
    workspaceId,
    name,
    (p.description ?? '').trim().slice(0, 1000),
    p.sku?.trim().slice(0, 60) || null,
    price(p.price),
    (p.currency ?? 'SGD').trim().slice(0, 8) || 'SGD',
    p.unit?.trim().slice(0, 40) || null,
    last?.n ?? 0,
  )
  if (!defer) await publishProducts(workspaceId)
  return id
}

export async function editProduct(workspaceId: number, id: number, p: Partial<Product>) {
  const now = await one<Product>(
    `SELECT id, name, description, sku, price::float8 AS price, currency, unit, active, position
       FROM products WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!now) throw new Error('No such product')

  const name = (p.name ?? now.name).trim().slice(0, 200)
  if (!name) throw new Error('Give it a name — it is what a customer will ask for.')

  await run(
    `UPDATE products SET name = ?, description = ?, sku = ?, price = ?, currency = ?, unit = ?,
            active = ?, updated_at = now()
      WHERE workspace_id = ? AND id = ?`,
    name,
    (p.description ?? now.description).trim().slice(0, 1000),
    (p.sku === undefined ? now.sku : p.sku?.trim().slice(0, 60) || null),
    p.price === undefined ? now.price : price(p.price),
    (p.currency ?? now.currency).trim().slice(0, 8) || 'SGD',
    (p.unit === undefined ? now.unit : p.unit?.trim().slice(0, 40) || null),
    p.active ?? now.active,
    workspaceId,
    id,
  )
  await publishProducts(workspaceId)
}

export async function removeProduct(workspaceId: number, id: number) {
  const { changes } = await run(`DELETE FROM products WHERE workspace_id = ? AND id = ?`, workspaceId, id)
  if (!changes) throw new Error('No such product')
  await publishProducts(workspaceId)
}

/** Null when it is not a number: "call us" is a real answer and 0 is not it. */
const price = (v: unknown) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null
}

// ---------------------------------------------------------------- calendars

export const calendars = (workspaceId: number) =>
  all<Calendar>(
    `SELECT c.id, c.name, c.description, c.colour, c.is_default, c.position,
            (SELECT count(*)::int FROM events e WHERE e.calendar_id = c.id) AS events
       FROM calendars c WHERE c.workspace_id = ? ORDER BY c.is_default DESC, c.position, c.id`,
    workspaceId,
  )

/**
 * The calendar a date lands on when nobody said which.
 *
 * Made if it is missing rather than returning nothing: a workspace with no calendar and a
 * date to record is a workspace that cannot record it, and the fix is one row.
 */
export async function defaultCalendar(workspaceId: number) {
  const found = await one<{ id: number }>(
    `SELECT id FROM calendars WHERE workspace_id = ? AND is_default`,
    workspaceId,
  )
  if (found) return found.id
  return insert(
    `INSERT INTO calendars (workspace_id, name, description, is_default)
     VALUES (?, 'Default Calendar', 'Closures, launches and cut-offs — the dates customers ask about.', true)`,
    workspaceId,
  )
}

export async function addCalendar(workspaceId: number, name: string, description = '', colour = 'sky') {
  const clean = name.trim().slice(0, 80)
  if (!clean) throw new Error('Give the calendar a name.')

  const last = await one<{ n: number }>(
    `SELECT COALESCE(max(position), -1) + 1 AS n FROM calendars WHERE workspace_id = ?`,
    workspaceId,
  )
  return insert(
    `INSERT INTO calendars (workspace_id, name, description, colour, position) VALUES (?,?,?,?,?)`,
    workspaceId,
    clean,
    description.trim().slice(0, 300),
    (COLOURS as readonly string[]).includes(colour) ? colour : 'sky',
    last?.n ?? 0,
  )
}

export async function editCalendar(
  workspaceId: number,
  id: number,
  patch: { name?: string; description?: string; colour?: string },
) {
  const now = await one<Calendar>(
    `SELECT id, name, description, colour, is_default, position, 0 AS events
       FROM calendars WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!now) throw new Error('No such calendar')

  await run(
    `UPDATE calendars SET name = ?, description = ?, colour = ? WHERE workspace_id = ? AND id = ?`,
    (patch.name ?? now.name).trim().slice(0, 80) || now.name,
    (patch.description ?? now.description).trim().slice(0, 300),
    (COLOURS as readonly string[]).includes(patch.colour ?? '') ? patch.colour : now.colour,
    workspaceId,
    id,
  )
  await publishEvents(workspaceId, id)
}

/**
 * Delete a calendar and the dates on it.
 *
 * Never the default one: it is where a learned date lands and where the first event goes, so
 * removing it leaves the next approval with nowhere to put anything.
 */
export async function removeCalendar(workspaceId: number, id: number) {
  const cal = await one<{ is_default: boolean }>(
    `SELECT is_default FROM calendars WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!cal) throw new Error('No such calendar')
  if (cal.is_default) throw new Error('This is where learned dates land. Make another one the default first.')

  await unpublish(workspaceId, id)
  await run(`DELETE FROM calendars WHERE workspace_id = ? AND id = ?`, workspaceId, id)
}

// ---------------------------------------------------------------- dates

/** Everything on one calendar, or on all of them when no calendar is named. */
export const events = (workspaceId: number, calendarId?: number) =>
  all<Event>(
    `SELECT id, calendar_id, title, detail, starts_on::text, ends_on::text,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
            repeats, source, series
       FROM events
      WHERE workspace_id = ? AND (?::int IS NULL OR calendar_id = ?)
      ORDER BY starts_on, start_time NULLS FIRST, id`,
    workspaceId,
    calendarId ?? null,
    calendarId ?? null,
  )

export async function addEvent(
  workspaceId: number,
  e: {
    title: string
    detail?: string
    starts_on: string
    ends_on?: string | null
    start_time?: string | null
    end_time?: string | null
    repeats?: string
    source?: string
    /** Which calendar it goes on. The default one when nobody said. */
    calendar_id?: number | null
    /** Who did it, for the record. Absent when the app did it on its own. */
    actor?: string | null
    /** Shared by the rows entered as one course, so they can be edited as one afterwards. */
    series?: string | null
  },
  /** Skip republishing the calendar document — for a caller adding several at once. */
  defer = false,
) {
  const title = e.title.trim().slice(0, 200)
  if (!title) throw new Error('Give the date a name.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.starts_on)) throw new Error('A date, as YYYY-MM-DD.')
  // A range that ends before it starts is a typo, and one that is only a day is one day.
  const ends = e.ends_on && e.ends_on > e.starts_on ? e.ends_on : null

  /*
   * Every event on this calendar has a start and an end.
   *
   * A customer asking about a date is asking what time, and half an answer is the half they
   * did not want. An end an hour after the start is the assumption anybody makes about an
   * event with only a start time; it is stated here so it is one assumption rather than one
   * per reader. A span of days with no times is a whole-day thing, which is what it looks
   * like when nobody says otherwise.
   */
  const from = clock(e.start_time) ?? (ends ? '00:00' : '09:00')
  const to = clock(e.end_time) ?? (ends ? '23:59' : hourAfter(from))

  /*
   * A supplied calendar id has to belong to this workspace, and nothing upstream proves it
   * does — `chatbot.$id.tsx` and `calendar_.$id.tsx` both validate with a type cast rather
   * than a check, so the value arrives from the browser. Without this, posting another
   * tenant's calendar id created an `events` row tagged to the caller's workspace and
   * foreign-keyed to the victim's calendar. RLS reads that row as ours and permits it.
   * `bot.setCalendars` guards the same shape with the same SELECT.
   *
   * An id that is not ours falls back to the default rather than throwing: the caller is
   * usually the bot filing a booking, and refusing the whole event over a bad calendar loses
   * the appointment as well.
   */
  const asked = e.calendar_id
    ? await one<{ id: number }>(`SELECT id FROM calendars WHERE workspace_id = ? AND id = ?`, workspaceId, e.calendar_id)
    : undefined
  const calendarId = asked?.id ?? (await defaultCalendar(workspaceId))

  /*
   * The same date, said the same way, twice.
   *
   * Every insert into events comes through here -- the calendar page, the bot's dates tab and
   * an approved proposal -- and until now none of them checked anything. One workspace ended
   * up with six rows for one part-time intake, all on 12-26 September at 09:00, because six
   * customers asked about it and each answer was approved.
   *
   * This catches none of those six: they are worded differently, and that is deliberate. Two
   * courses genuinely do run the same days at the same times, so a slot is not an identity and
   * matching on one would merge real dates. Titles are no better -- measured on those rows the
   * six wordings of one course scored 0.39-0.46 against each other while "Full-Time" against
   * "Part-Time", two different courses, scored 0.83. Similarity is upside down here.
   *
   * So the only test is the one that cannot be wrong: the same slot AND the same title once
   * punctuation and capitals are set aside. It is free, it can never merge two real dates, and
   * it stops one proposal being approved twice from two conversations that worded it alike.
   * Anything less certain than that is folded in the month view for a person to judge.
   */
  const already = await one<{ id: number }>(
    `SELECT id FROM events
      WHERE workspace_id = ? AND calendar_id = ? AND starts_on = ?::date
        AND ends_on IS NOT DISTINCT FROM ?::date
        AND start_time IS NOT DISTINCT FROM ?::time AND end_time IS NOT DISTINCT FROM ?::time
        AND lower(regexp_replace(title, '[^a-zA-Z0-9]+', '', 'g')) = lower(regexp_replace(?, '[^a-zA-Z0-9]+', '', 'g'))
      LIMIT 1`,
    workspaceId,
    calendarId,
    e.starts_on,
    ends,
    from,
    to,
    title,
  )
  if (already) return already.id

  const id = await insert(
    `INSERT INTO events (workspace_id, calendar_id, title, detail, starts_on, ends_on,
                         start_time, end_time, repeats, source, series)
     VALUES (?,?,?,?,?::date,?::date,?::time,?::time,?,?,?)`,
    workspaceId,
    calendarId,
    title,
    (e.detail ?? '').trim().slice(0, 1000),
    e.starts_on,
    ends,
    from,
    to,
    (REPEATS as readonly string[]).includes(e.repeats ?? '') ? e.repeats : 'once',
    e.source ?? 'person',
    e.series ?? null,
  )
  await note(
    workspaceId,
    calendarId,
    'added',
    { id, title, starts_on: e.starts_on, ends_on: ends, start_time: from, end_time: to, source: e.source },
    e.actor,
  )
  if (!defer) await publishEvents(workspaceId, calendarId)
  return id
}

export async function editEvent(
  workspaceId: number,
  id: number,
  e: Partial<Event> & { actor?: string | null },
  /** Skip republishing, for a caller changing several rows of one course at once. */
  defer = false,
) {
  const now = await one<Event>(
    `SELECT id, calendar_id, title, detail, starts_on::text, ends_on::text,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
            repeats, source
       FROM events WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!now) throw new Error('No such date')

  /*
   * Same check as addEvent, and needed for the same reason: the WHERE above scopes the row
   * being edited, but says nothing about the calendar id being written into it. A supplied id
   * that is not ours is ignored rather than refused — COALESCE below already means "leave it
   * alone" for undefined, so this makes a foreign id behave the same way.
   */
  const moved = e.calendar_id
    ? await one<{ id: number }>(`SELECT id FROM calendars WHERE workspace_id = ? AND id = ?`, workspaceId, e.calendar_id)
    : undefined
  const calendarId = e.calendar_id ? (moved?.id ?? null) : null

  const starts = e.starts_on ?? now.starts_on
  const ends = e.ends_on === undefined ? now.ends_on : e.ends_on
  await run(
    `UPDATE events SET title = ?, detail = ?, starts_on = ?::date, ends_on = ?::date,
            start_time = ?::time, end_time = ?::time, repeats = ?,
            calendar_id = COALESCE(?::int, calendar_id),
            -- COALESCE, so an ordinary edit cannot quietly orphan a row from its course.
            series = COALESCE(?::text, series), updated_at = now()
      WHERE workspace_id = ? AND id = ?`,
    (e.title ?? now.title).trim().slice(0, 200) || now.title,
    (e.detail ?? now.detail).trim().slice(0, 1000),
    starts,
    ends && ends > starts ? ends : null,
    clock(e.start_time) ?? now.start_time,
    /*
     * The event's own end, not an hour after its start.
     *
     * `hourAfter` is the right default when an event is *created* with only a start. Applying
     * it on every edit meant renaming an eight-hour event, or touching its detail, silently
     * cut it to one hour — the caller passed no end_time because they were not changing it,
     * and the fallback read that as "recompute". Only a start actually being moved with no new
     * end has anything to recompute, and even then the stored end is the better answer if it
     * is still after the new start.
     */
    clock(e.end_time) ?? now.end_time ?? hourAfter(clock(e.start_time) ?? now.start_time),
    (REPEATS as readonly string[]).includes(e.repeats ?? '') ? e.repeats : now.repeats,
    calendarId,
    e.series ?? null,
    workspaceId,
    id,
  )
  await note(
    workspaceId,
    calendarId ?? now.calendar_id,
    'edited',
    {
      id,
      title: (e.title ?? now.title).trim() || now.title,
      starts_on: starts,
      ends_on: ends && ends > starts ? ends : null,
      start_time: clock(e.start_time) ?? now.start_time,
      end_time: clock(e.end_time) ?? now.end_time,
      source: now.source,
    },
    e.actor,
  )
  // Both calendars, when it moved between them: the one it left has a document too.
  if (defer) return
  await publishEvents(workspaceId, now.calendar_id)
  if (e.calendar_id && e.calendar_id !== now.calendar_id) await publishEvents(workspaceId, e.calendar_id)
}

/** The token the rows of one course share. Short, random, meaningless on purpose. */
const newSeries = () => `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`

/**
 * The days a course runs, set in one go.
 *
 * ---------------------------------------------------------------- why this exists
 *
 * A course meeting on three days is three rows sharing a title, and the only form for entering
 * one offered From and To. So people entered a range, and a range is drawn on every day between:
 * a live row reads 20 to 27 October for a course the team described as "20, 22, 27 October",
 * putting a class on five days nobody is teaching. This is what the Days tab writes through.
 *
 * ---------------------------------------------------------------- a diff, not a replace
 *
 * Deleting every old row and adding the new set would be shorter and is wrong. `lessons.event_id`
 * is `on delete set null`, so a row that goes takes with it the link to the training proposal it
 * came from -- and the "Where from" tab somebody uses to check where a date came from goes blank.
 * A day that survives an edit keeps its id, so it keeps its provenance and its history.
 *
 * ---------------------------------------------------------------- published once
 *
 * Every write is deferred and the calendar document is rewritten at the end, the pattern
 * `decide()` uses for a batch of approvals. Without it, editing a three-day course is three
 * document rewrites and three embedding round trips to say one thing.
 */
export async function setDays(
  workspaceId: number,
  e: {
    /** The course being edited. Absent when this is a new one, which then gets its own. */
    series?: string | null
    title: string
    detail?: string
    /**
     * The days it runs, at least one. Order does not matter and duplicates are ignored.
     *
     * A plain string is a day at the shared hours below. An object is a day that keeps its own,
     * which is how a course whose last session is an evening assessment gets said truthfully --
     * `events` has carried a time per row since 045, and only this function insisted they all
     * match.
     */
    days: (string | { on: string; start_time?: string | null; end_time?: string | null })[]
    /** The hours for any day that does not name its own. */
    start_time?: string | null
    end_time?: string | null
    /**
     * Whether each of those days comes round again, and when it stops.
     *
     * One row can only carry one anchor, so "Tuesday and Thursday, weekly" is two rows that each
     * repeat -- which is what fallsOn already reads, with `until` as the window either side of
     * which nothing falls. Left alone, every row is a single day that happens once.
     */
    repeats?: string
    until?: string | null
    source?: string
    calendar_id?: number | null
    actor?: string | null
  },
  /** Rows this supersedes: the course as it stood when the sheet was opened. */
  replacing: number[] = [],
): Promise<number[]> {
  /*
   * Flattened to one shape before anything else looks at them, so the rest of this function does
   * not have to care which way the caller wrote a day. Last one wins on a duplicate day, which
   * is the only reading that lets somebody correct a time without removing the day first.
   */
  const asked = new Map<string, { start_time?: string | null; end_time?: string | null }>()
  for (const d of e.days) {
    const on = typeof d === 'string' ? d : d.on
    if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) continue
    asked.set(on, typeof d === 'string' ? {} : { start_time: d.start_time, end_time: d.end_time })
  }
  const days = [...asked.keys()].sort()
  if (!days.length) throw new Error('Pick at least one day.')
  if (days.length > MAX_DAYS)
    throw new Error(`That is ${days.length} days. ${MAX_DAYS} is the most one thing can run for.`)

  // The shared pair is the default, never an override: a day that named its own hours keeps them.
  const hoursFor = (on: string) => ({
    start_time: asked.get(on)?.start_time ?? e.start_time,
    end_time: asked.get(on)?.end_time ?? e.end_time,
  })
  /*
   * Whitelisted here rather than left to addEvent, which is the only one of the two writers that
   * does it -- editEvent takes the narrow type and would have been handed whatever arrived.
   */
  const repeats: Event['repeats'] =
    (REPEATS as readonly string[]).includes(e.repeats ?? '') ? (e.repeats as Event['repeats']) : 'once'
  // Only meaningful as the far edge of a repeat. A day that happens once has no window.
  const until = repeats === 'once' ? null : (e.until ?? null)

  /*
   * The rows being replaced, read before anything changes them and scoped to this workspace.
   * `replacing` arrives from a browser, so it is a claim about which rows to touch, not a fact.
   */
  const was = replacing.length
    ? await all<{ id: number; starts_on: string; calendar_id: number }>(
        `SELECT id, starts_on::text, calendar_id FROM events WHERE workspace_id = ? AND id = ANY(?::int[])`,
        workspaceId,
        replacing,
      )
    : []

  const series = e.series ?? newSeries()
  // Calendars to republish: the one it is on, plus any it is leaving.
  const touched = new Set<number>(was.map((r) => r.calendar_id))
  const made: number[] = []

  /*
   * Days are paired to rows by position, not only by equality.
   *
   * "20, 22, 27" becoming "20, 22, 28" is somebody moving the last session, and a move should
   * stay the row it was: the id carries the per-date history, the link back to the proposal it
   * came from, and the "Where from" tab somebody opens to check it. Matching on equality alone
   * would delete the 27th and insert the 28th, and `lessons.event_id` is `on delete set null`,
   * so that link is gone for good over what the person thought was an edit.
   *
   * So the days nobody moved are matched first, and whatever is left over on each side is
   * paired in date order -- which is the order they are read in.
   */
  const keeping = new Map(was.filter((r) => days.includes(r.starts_on)).map((r) => [r.starts_on, r]))
  const spare = was.filter((r) => !days.includes(r.starts_on)).sort((a, b) => a.starts_on.localeCompare(b.starts_on))
  const moving = new Map<string, (typeof was)[number]>()
  for (const on of days) if (!keeping.has(on) && spare.length) moving.set(on, spare.shift()!)

  for (const on of days) {
    const already = keeping.get(on) ?? moving.get(on)
    if (already) {
      // The row stays; only what changed is written to it, including the day when it moved.
      await editEvent(
        workspaceId,
        already.id,
        {
          title: e.title,
          detail: e.detail,
          starts_on: on,
          ends_on: until,
          start_time: hoursFor(on).start_time ?? undefined,
          end_time: hoursFor(on).end_time ?? undefined,
          repeats,
          calendar_id: e.calendar_id ?? undefined,
          series,
          actor: e.actor,
        },
        true,
      )
      made.push(already.id)
      continue
    }

    made.push(
      await addEvent(
        workspaceId,
        {
          title: e.title,
          detail: e.detail,
          starts_on: on,
          /*
           * The window, not a span. For a repeat these two columns bound the repetition rather
           * than filling the days between -- which is the distinction fallsOn exists to keep,
           * and the one that put a class on eleven days nobody was teaching when it was lost.
           */
          ends_on: until,
          start_time: hoursFor(on).start_time,
          end_time: hoursFor(on).end_time,
          repeats,
          source: e.source,
          calendar_id: e.calendar_id,
          series,
          actor: e.actor,
        },
        true,
      ),
    )
  }

  /*
   * Only what is left over after everything that survived -- edited, moved or adopted.
   *
   * Subtracted rather than recomputed from the dates: addEvent returns an existing row's id
   * when one already matches, so a day can be kept by a row that was never in `keeping`, and
   * removing by date would then delete a day the person had just chosen.
   */
  const kept = new Set(made)
  for (const row of was) {
    if (kept.has(row.id)) continue
    await removeEvent(workspaceId, row.id, e.actor, true)
  }

  /*
   * Where the rows actually landed, read back rather than assumed: addEvent falls back to the
   * default calendar when it is given one that is not ours, so the id asked for is not always
   * the id to republish.
   */
  for (const r of await all<{ calendar_id: number }>(
    `SELECT DISTINCT calendar_id FROM events WHERE workspace_id = ? AND id = ANY(?::int[])`,
    workspaceId,
    made,
  ))
    touched.add(r.calendar_id)

  for (const id of touched) await publishEvents(workspaceId, id)
  return made
}

/**
 * One date spanning several days, made into one date per day.
 *
 * A span is a single row drawn on every day it covers, so removing it from the Wednesday
 * removes it from the Monday too -- there is nothing there to say "not the Wednesday". That is
 * right for a closure, which really is one thing, and wrong for the far commoner case of a
 * course that meets on some of those days and not others.
 *
 * After this there is a row per day, each editable and removable on its own. Nothing is lost:
 * the days are the days the span already claimed, and the one that should not be there is now
 * a single delete instead of an impossible one.
 *
 * Deliberately not offered for something that repeats -- its two dates are a window rather than
 * a run of days, and flattening that would turn a standing weekly slot into a handful of
 * one-offs.
 */
export async function splitEvent(workspaceId: number, id: number, actor?: string | null): Promise<number[]> {
  const e = await one<Event & { calendar_id: number }>(
    `SELECT id, calendar_id, title, detail, starts_on::text, ends_on::text, repeats, source,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM events WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!e) throw new Error('No such date')
  if (e.repeats !== 'once') throw new Error('A repeating date is a window, not a run of days, so there is nothing to split.')
  if (!e.ends_on || e.ends_on <= e.starts_on) throw new Error('That date is already a single day.')

  const days: string[] = []
  for (let at = new Date(`${e.starts_on}T00:00:00Z`); ; at = new Date(at.getTime() + 86_400_000)) {
    const key = at.toISOString().slice(0, 10)
    days.push(key)
    if (key >= e.ends_on) break
  }

  const made: number[] = []
  for (const on of days)
    made.push(
      await addEvent(
        workspaceId,
        {
          title: e.title,
          detail: e.detail,
          starts_on: on,
          ends_on: null,
          start_time: e.start_time,
          end_time: e.end_time,
          repeats: 'once',
          source: e.source,
          calendar_id: e.calendar_id,
          actor,
        },
        // Published once at the end rather than once per day.
        true,
      ),
    )

  await removeEvent(workspaceId, id, actor)
  return made
}

export async function removeEvent(
  workspaceId: number,
  id: number,
  actor?: string | null,
  /** Skip republishing, for a caller taking several days off one course at once. */
  defer = false,
) {
  const gone = await one<{ calendar_id: number; title: string; starts_on: string; source: string }>(
    `DELETE FROM events WHERE workspace_id = ? AND id = ?
      RETURNING calendar_id, title, starts_on::text, source`,
    workspaceId,
    id,
  )
  if (!gone) throw new Error('No such date')
  // The row outlives the event on purpose: what happened to something that is no longer
  // there is exactly the question a history gets asked.
  await note(workspaceId, gone.calendar_id, 'removed', { title: gone.title, starts_on: gone.starts_on, source: gone.source }, actor)
  if (!defer) await publishEvents(workspaceId, gone.calendar_id)
}

// ---------------------------------------------------------------- the record

export type LogEntry = {
  id: number
  event_id: number | null
  action: string
  title: string
  detail: string
  source: string
  actor: string | null
  created_at: string
}

/**
 * Note what just happened to a calendar.
 *
 * Never throws into the caller: a calendar that refuses an edit because the history could
 * not be written is worse than a history with a gap in it. The gap is logged instead.
 */
async function note(
  workspaceId: number,
  calendarId: number,
  action: 'added' | 'edited' | 'removed',
  e: { id?: number | null; title: string; starts_on?: string; ends_on?: string | null; start_time?: string | null; end_time?: string | null; source?: string },
  actor?: string | null,
) {
  try {
    const span = e.starts_on
      ? `${e.starts_on}${e.ends_on ? ` to ${e.ends_on}` : ''}${e.start_time ? ` ${e.start_time}–${e.end_time ?? ''}` : ''}`
      : ''
    await run(
      `INSERT INTO calendar_log (workspace_id, calendar_id, event_id, action, title, detail, source, actor)
       VALUES (?,?,?,?,?,?,?,?)`,
      workspaceId,
      calendarId,
      e.id ?? null,
      action,
      e.title.slice(0, 200),
      span,
      e.source ?? 'person',
      actor ?? null,
    )
  } catch (err) {
    console.error('[catalogue] could not record a calendar change:', err instanceof Error ? err.message : err)
  }
}

/** What has happened to one calendar, newest first. */
export const history = (workspaceId: number, calendarId: number, limit = 200) =>
  all<LogEntry>(
    `SELECT id, event_id, action, title, detail, source, actor, created_at
       FROM calendar_log WHERE workspace_id = ? AND calendar_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    workspaceId,
    calendarId,
    limit,
  )

/**
 * What has happened to one date.
 *
 * Matched on the event rather than the calendar, so the list a person sees when they open a
 * date is about that date. A removed events log rows keep the calendar and lose the id, which
 * is why this returns nothing for something already gone — the calendars own history has it.
 */
export const eventHistory = (workspaceId: number, eventId: number) =>
  all<LogEntry>(
    `SELECT id, event_id, action, title, detail, source, actor, created_at
       FROM calendar_log WHERE workspace_id = ? AND event_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 50`,
    workspaceId,
    eventId,
  )

export type Origin = {
  lesson_id: number
  said: string
  learned_at: string
  bot_id: number
  bot: string
  conversation_id: number | null
  customer_id: number | null
  name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  channel: string | null
  subject: string | null
}

/**
 * The conversation a learned date came out of.
 *
 * "Learned from a conversation and approved" is true and useless on its own: the reason to
 * ask where a date came from is to go and read the thing that said it. The lesson keeps the
 * thread, so the trail is already there — it was just never followed.
 */
export const eventOrigin = (workspaceId: number, eventId: number) =>
  one<Origin>(
    `SELECT l.id AS lesson_id, l.answer AS said, l.created_at AS learned_at,
            b.id AS bot_id, b.name AS bot,
            l.conversation_id, v.customer_id, v.channel, v.subject,
            c.name, c.first_name, c.last_name, c.email, c.phone
       FROM lessons l
       JOIN bots b ON b.id = l.bot_id
       LEFT JOIN conversations v ON v.id = l.conversation_id
       LEFT JOIN customers c ON c.id = v.customer_id
      WHERE l.workspace_id = ? AND l.event_id = ?
      ORDER BY l.id DESC LIMIT 1`,
    workspaceId,
    eventId,
  )

// ---------------------------------------------------------------- the mirror

/**
 * The base these belong in, made if it is not there.
 *
 * By the standard name, so a workspace that kept its seeded bases gets its price list filed
 * under Products & services rather than in a fifth base nobody asked for.
 */
async function baseFor(workspaceId: number, name: string, description: string) {
  const found = (await bases.list(workspaceId)).find((b) => b.name === name)
  return found ?? (await bases.create(workspaceId, name, description))
}

/**
 * Rewrite the price list as a document.
 *
 * One document, replaced in place through the synthetic uri — the same mechanism the
 * learned-facts document uses. A hundred products stay one row somebody can read top to
 * bottom, and chunking cuts it where it needs cutting.
 */
/**
 * The price list is configuration, not a document.
 *
 * It used to be mirrored into the knowledge base as `catalogue:products` so the bot could
 * quote it with a citation. That turned out to be a loop with a bad end: read a price list
 * PDF into the products table, and the same products were written straight back into the
 * base the PDF came from — two documents in one base saying the same thing, the generated
 * one impossible to delete because editing any product recreated it.
 *
 * So it goes to the model directly instead, in the system prompt, ahead of everything
 * retrieved. See `priceList()` below and `bot.prompt()`. This function now only clears up
 * the document if a workspace still has one from before.
 */
export async function publishProducts(workspaceId: number) {
  const kb = await import('./kb.ts')
  const doc = await one<{ id: number }>(
    `SELECT id FROM documents WHERE workspace_id = ? AND uri = 'catalogue:products'`,
    workspaceId,
  )
  if (doc) await kb.removeDocument(workspaceId, doc.id)
}

/**
 * What this company sells, for the prompt.
 *
 * Null when there is nothing listed, so a bot with no catalogue is not handed an empty
 * heading to reason about.
 */
export async function priceList(workspaceId: number): Promise<string | null> {
  const rows = (await products(workspaceId)).filter((p) => p.active)
  if (!rows.length) return null

  return rows
    .map((p) => {
      const cost =
        p.price === null
          ? 'price on request'
          : `${p.currency} ${p.price.toFixed(2)}${p.unit ? ` ${p.unit}` : ''}`
      return [p.name, p.sku && `(${p.sku})`, '—', cost, p.description && `. ${p.description}`]
        .filter(Boolean)
        .join(' ')
    })
    .join('\n')
}

/** How far ahead the schedule looks. A year, so a public holiday five months out survives. */
const HORIZON_DAYS = 365
/** Occurrences shown per thing. The cap that does the real work -- see below. */
const PER_GROUP = 4
/** Things shown at all. */
const GROUPS = 20

/** The key two rows share when they are the same thing: the title, with the noise taken out. */
const flat = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** A course as the editor needs it: its rows, and whether they are really one thing. */
export type Course = {
  /** Null when these rows only look alike. */
  series: string | null
  /**
   * Whether the rows are tied by a recorded token, or merely resemble each other.
   *
   * The difference decides what the editor is allowed to do with them. Tied, it may edit them as
   * a course and take a day off. Resembling, it may only offer them, because two intakes of one
   * course at the same hours are indistinguishable by title and time -- and unticking a date on
   * a wrong guess deletes somebody's real session.
   */
  grouped: boolean
  rows: Event[]
}

/**
 * The other dates of the same thing as this one.
 *
 * ---------------------------------------------------------------- why it is not just a query
 *
 * A course meeting on three days is three rows sharing a title, with no course entity -- 043
 * decided that and it is still right. `series` was added so rows entered together could be found
 * again, but every row that existed before it is null, and those are exactly the ones somebody
 * opens wanting to fix.
 *
 * So there are two answers and they are not interchangeable. A token is a fact: these rows were
 * entered as one thing. A matching title and matching hours is a resemblance, and the repo
 * already carries the counter-example -- two intakes a fortnight apart are two dates however
 * alike they read. The caller is told which it has.
 */
export async function courseOf(workspaceId: number, eventId: number): Promise<Course | null> {
  const one_ = await one<Event>(
    `SELECT id, calendar_id, title, detail, starts_on::text, ends_on::text,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
            repeats, source, series
       FROM events WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    eventId,
  )
  if (!one_) return null

  if (one_.series) {
    const rows = await all<Event>(
      `SELECT id, calendar_id, title, detail, starts_on::text, ends_on::text,
              to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
              repeats, source, series
         FROM events WHERE workspace_id = ? AND series = ?
        ORDER BY starts_on, start_time NULLS FIRST, id`,
      workspaceId,
      one_.series,
    )
    return { series: one_.series, grouped: true, rows }
  }

  /*
   * The suggestion. Same calendar, same flattened title, same hours, same repeat -- the identity
   * `addEvent` already dedupes on, minus the day. Deliberately strict: a looser rule catches more
   * of what somebody meant and also catches things they did not, and this list ends up beside a
   * button that can delete rows.
   */
  const alike = await all<Event>(
    `SELECT id, calendar_id, title, detail, starts_on::text, ends_on::text,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
            repeats, source, series
       FROM events
      WHERE workspace_id = ? AND calendar_id = ? AND series IS NULL AND repeats = ?
        AND start_time IS NOT DISTINCT FROM ?::time AND end_time IS NOT DISTINCT FROM ?::time
        AND lower(regexp_replace(title, '[^a-zA-Z0-9]+', '', 'g'))
          = lower(regexp_replace(?, '[^a-zA-Z0-9]+', '', 'g'))
      ORDER BY starts_on, id`,
    workspaceId,
    one_.calendar_id,
    one_.repeats,
    one_.start_time,
    one_.end_time,
    one_.title,
  )
  return { series: null, grouped: false, rows: alike.length > 1 ? alike : [one_] }
}

/**
 * Say that these rows are one course, and mean it from now on.
 *
 * The one deliberate press that turns a resemblance into a fact. Nothing infers this: the rows
 * are shown first, and somebody who can see that two intakes got swept together simply does not
 * press it. Returns the token so the caller can go straight on editing the course it just made.
 */
export async function stampSeries(workspaceId: number, ids: number[], actor?: string | null): Promise<string> {
  const wanted = [...new Set(ids)].filter(Number.isInteger)
  if (wanted.length < 2) throw new Error('A course is more than one date.')

  const rows = await all<{ id: number; calendar_id: number }>(
    `SELECT id, calendar_id FROM events WHERE workspace_id = ? AND id = ANY(?::int[])`,
    workspaceId,
    wanted,
  )
  if (!rows.length) throw new Error('No such dates.')

  const series = newSeries()
  for (const r of rows) await editEvent(workspaceId, r.id, { series, actor }, true)
  for (const id of new Set(rows.map((r) => r.calendar_id))) await publishEvents(workspaceId, id)
  return series
}

/** The courses already on a calendar, so adding dates can join one instead of naming it again. */
export const coursesOn = async (workspaceId: number, calendarId: number) => {
  const rows = await events(workspaceId, calendarId)
  const seen = new Map<string, { series: string | null; title: string; dates: number }>()
  for (const e of rows) {
    const key = e.series ?? flat(e.title)
    const got = seen.get(key) ?? { series: e.series ?? null, title: e.title, dates: 0 }
    if (e.title.length < got.title.length) got.title = e.title
    got.dates++
    seen.set(key, got)
  }
  return [...seen.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * What is coming up, as prompt text. The calendar's answer to priceList().
 *
 * ---------------------------------------------------------------- why this exists
 *
 * A bot was telling customers about classes that had already run, out of approved examples. The
 * calendar that should own this reached the model only as a document rendered at write time and
 * retrieved like any other passage -- and examples outrank passages. Here it is a section of the
 * prompt, like the price list, and the prompt says it wins.
 *
 * ---------------------------------------------------------------- the three caps, and which matters
 *
 * `PER_GROUP` is the one doing the work. A weekly class with no `ends_on` has no last session, so
 * a cap by total count would hand it the next twenty Saturdays and evict the one-off intake three
 * months out -- the very thing somebody asks about. Capping each thing separately bounds both the
 * forever-weekly and the fifty-session course. `HORIZON_DAYS` is generous on purpose: it is not
 * what controls the size.
 *
 * ---------------------------------------------------------------- grouped twice, and why
 *
 * By title, because a three-day course is three rows sharing one, and three lines saying the same
 * course name reads as three courses.
 *
 * Then by slot, because the same intake gets proposed by every conversation that mentions it and
 * each proposal is titled differently -- one live calendar had fifteen rows for one October intake
 * under fifteen names. Nothing existing collapses those: the grouping in sweepGroups needs the same
 * conversation and the same title, and similarity is upside down here (six wordings of one intake
 * score 0.39-0.46 against each other, while Full-Time against Part-Time scores 0.83). So rows that
 * occupy identical days at identical hours are one thing whatever they are called, and the shortest
 * title wins -- the long ones are the model padding.
 *
 * `detail` is deliberately absent. It is a thousand characters a row.
 */
export async function schedule(
  workspaceId: number,
  calendarIds: number[],
  { now = new Date(), days = HORIZON_DAYS, groups = GROUPS, per = PER_GROUP } = {},
): Promise<string | null> {
  if (!calendarIds.length) return null

  const from = todayFor(now)
  const until = todayFor(new Date(Date.parse(`${from}T00:00:00Z`) + days * 86400000))

  const rows = (await events(workspaceId)).filter((e) => calendarIds.includes(e.calendar_id))
  if (!rows.length) return null

  type Group = {
    title: string
    /** Each day with the hours that day actually runs, which are not always the course's. */
    days: { on: string; start: string; end: string }[]
    spans: { from: string; to: string; start: string; end: string }[]
  }
  const byTitle = new Map<string, Group>()

  for (const e of rows) {
    const last = e.ends_on || e.starts_on
    // Still to come, or running now. A course that began on Monday is this week's answer.
    if (last < from || e.starts_on > until) continue

    const key = flat(e.title)
    const g = byTitle.get(key) ?? { title: e.title, days: [], spans: [] }
    // The shortest name wins: the long ones are the model padding the same thing.
    if (e.title.length < g.title.length) g.title = e.title

    if ((e.repeats ?? 'once') === 'once') {
      /*
       * A span stays a span. Enumerating it and then capping at `per` was worse than useless on
       * real data: 20 to 27 October rendered as "20, 21, 22, 23 October", which tells a customer
       * the course ends four days before it does.
       */
      if (e.ends_on && e.ends_on > e.starts_on)
        g.spans.push({ from: e.starts_on, to: e.ends_on, start: e.start_time, end: e.end_time })
      else if (!g.days.some((d) => d.on === e.starts_on))
        g.days.push({ on: e.starts_on, start: e.start_time, end: e.end_time })
    } else {
      /*
       * A repeat has no listed days, so they are walked out of `fallsOn` -- the same predicate the
       * month grid uses, so the two cannot disagree about which days show a class. Capped per
       * group, which is what stops a weekly class with no end date owning the whole block.
       */
      let found = 0
      for (let d = from; d <= until && found < per; d = nextDay(d)) {
        if (!fallsOn(e, d)) continue
        if (!g.days.some((x) => x.on === d)) g.days.push({ on: d, start: e.start_time, end: e.end_time })
        found++
      }
    }

    if (g.days.length || g.spans.length) byTitle.set(key, g)
  }

  /*
   * Then the same thing under several names becomes one.
   *
   * Every conversation that mentions an intake proposes it again with its own wording -- one live
   * calendar held fifteen rows for one October intake under fifteen titles. Nothing existing
   * collapses them: sweepGroups needs the same conversation and the same title, and similarity is
   * upside down here (six wordings of one intake score 0.39-0.46 against each other, while
   * Full-Time against Part-Time -- two different courses -- scores 0.83). Identical days at
   * identical hours is the one signal that holds.
   */
  const bySlot = new Map<string, Group>()
  for (const g of byTitle.values()) {
    g.days.sort((a, b) => a.on.localeCompare(b.on))
    g.spans.sort((a, b) => a.from.localeCompare(b.from))
    // Hours are part of the slot, so two courses on one day at different hours stay two things.
    const slot = [
      g.days.map((d) => `${d.on}@${d.start}-${d.end}`).join(','),
      g.spans.map((s) => `${s.from}..${s.to}@${s.start}-${s.end}`).join(','),
    ].join('|')
    const seen = bySlot.get(slot)
    if (!seen || g.title.length < seen.title.length) bySlot.set(slot, g)
  }

  const first = (g: Group) => [...g.days.map((d) => d.on), ...g.spans.map((s) => s.from)].sort()[0]
  const all = [...bySlot.values()].sort((a, b) => first(a).localeCompare(first(b)))
  if (!all.length) return null

  /** "from 09:00 to 18:00", or the sentinel pair said as what it means. */
  const hours = (start: string, end: string) =>
    start === '00:00' && end === '23:59' ? ' (all day)' : ` from ${start} to ${end}`

  const shown = all.slice(0, groups)
  const lines = shown.map((g) => {
    /*
     * Capped here too, not only on the repeats.
     *
     * The repeat branch walks `fallsOn` and stops at `per`, so it could never run away. Listed
     * days had no such limit, because a course was three rows and nobody could make thirty by
     * hand. The Days tab makes thirty one Save, and thirty dates on one line is most of what the
     * model reads about the calendar.
     */
    const over = g.days.length - per
    const parts = [
      ...g.spans.map((s) => ({ when: `${spoken(s.from)} to ${spoken(s.to)}`, start: s.start, end: s.end })),
      ...g.days.slice(0, per).map((d) => ({ when: spoken(d.on), start: d.start, end: d.end })),
    ]

    /*
     * The hours once at the end, unless they differ.
     *
     * One pair for the whole course was not a simplification, it was a wrong answer: the group
     * took its hours from whichever row came first and printed them against every other date.
     * A course whose last session is an evening assessment -- 09:00-18:00, 09:00-18:00, then
     * 19:00-22:00 -- was read out as nine to six throughout, and that state is reachable by
     * adding the three dates one at a time, which is how it was found.
     */
    const same = parts.every((p) => p.start === parts[0].start && p.end === parts[0].end)
    const when = same ? parts.map((p) => p.when).join(', ') : parts.map((p) => p.when + hours(p.start, p.end)).join(', ')
    const at = same ? hours(parts[0].start, parts[0].end) : ''
    // The hours belong to the dates, so they come before the count of the ones not shown.
    const rest = over > 0 ? `, and ${over} more — confirm the rest with the team` : ''
    return `${g.title} — ${when}${at}${rest}`
  })

  /*
   * Said out loud, never cut silently. A truncated list that reads as complete is what makes the
   * bot answer "we have nothing then" about something that is on the calendar.
   */
  if (all.length > shown.length) lines.push('…and more after that — confirm with the team.')
  return lines.join('\n')
}

/** The next calendar day, as a key. String arithmetic so it cannot drift with the clock. */
const nextDay = (key: string) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)

/**
 * "Saturday 18 October". The weekday is the point, not decoration: "do you have weekend sessions"
 * is otherwise date-to-weekday arithmetic, which types.ts already records models getting wrong.
 */
const spoken = (key: string) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })

/**
 * Rewrite the calendar as a document.
 *
 * Dates in words, not a table: "Closed for Chinese New Year — 17 February 2026 to 19
 * February 2026" is a sentence a model can answer "are you open on the 18th" from, and a
 * row of ISO strings is not.
 */
export async function publishEvents(workspaceId: number, calendarId?: number) {
  // Every calendar, when nobody named one: the caller is republishing the lot.
  if (!calendarId) {
    for (const c of await calendars(workspaceId)) await publishEvents(workspaceId, c.id)
    return
  }

  const cal = await one<{ name: string; description: string }>(
    `SELECT name, description FROM calendars WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    calendarId,
  )
  if (!cal) return

  const rows = await events(workspaceId, calendarId)
  const standard = STANDARD_BASES.find((b) => b.name === 'Company')!
  const base = await baseFor(workspaceId, standard.name, standard.description)

  const when = (e: Event) => {
    const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
    /*
     * The time is the half of the answer anybody wants — "the 25th" is not what somebody
     * asking about an event is after. A whole-day span says so rather than reading as an
     * event that starts at midnight.
     */
    const wholeDay = e.start_time === '00:00' && e.end_time === '23:59'
    const at = wholeDay ? '' : ` from ${e.start_time} to ${e.end_time}`
    const span = e.ends_on
      ? `${day(e.starts_on)} to ${day(e.ends_on)}${wholeDay ? '' : `, ${at.trim()}`}`
      : `${day(e.starts_on)}${at}`
    if (e.repeats === 'once') return span
    return `${span}, and every ${e.repeats === 'yearly' ? 'year' : e.repeats === 'monthly' ? 'month' : 'week'} after`
  }

  /*
   * A document per calendar, addressed by its id.
   *
   * One merged document would answer "when is the workshop" with a delivery cut-off sitting
   * in the same passage — which is the whole reason there is more than one calendar.
   */
  await store(workspaceId, {
    source: 'text',
    uri: `catalogue:events:${calendarId}`,
    title: cal.name,
    mime: 'text/plain',
    baseId: base.id,
    text: rows.length
      ? `${cal.description || 'Dates that affect what we can offer and when.'}\n\n${rows
          .map((e) => `${e.title} — ${when(e)}${e.detail ? `. ${e.detail}` : ''}`)
          .join('\n')}`
      : `${cal.name}: nothing recorded yet.`,
  })
}

/** A calendar that is going: its document goes with it, or the bot keeps quoting a ghost. */
async function unpublish(workspaceId: number, calendarId: number) {
  const kb = await import('./kb.ts')
  const doc = await one<{ id: number }>(
    `SELECT id FROM documents WHERE workspace_id = ? AND uri = ?`,
    workspaceId,
    `catalogue:events:${calendarId}`,
  )
  if (doc) await kb.removeDocument(workspaceId, doc.id)
}
