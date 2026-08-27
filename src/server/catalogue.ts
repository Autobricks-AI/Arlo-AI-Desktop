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
import { CALENDAR_COLOURS, STANDARD_BASES } from '../types.ts'

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

export async function addCalendar(workspaceId: number, name: string, description = '', colour = 'moss') {
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
    (COLOURS as readonly string[]).includes(colour) ? colour : 'moss',
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
            repeats, source
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

  const calendarId = e.calendar_id ?? (await defaultCalendar(workspaceId))

  const id = await insert(
    `INSERT INTO events (workspace_id, calendar_id, title, detail, starts_on, ends_on,
                         start_time, end_time, repeats, source)
     VALUES (?,?,?,?,?::date,?::date,?::time,?::time,?,?)`,
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

export async function editEvent(workspaceId: number, id: number, e: Partial<Event> & { actor?: string | null }) {
  const now = await one<Event>(
    `SELECT id, calendar_id, title, detail, starts_on::text, ends_on::text,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
            repeats, source
       FROM events WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )
  if (!now) throw new Error('No such date')

  const starts = e.starts_on ?? now.starts_on
  const ends = e.ends_on === undefined ? now.ends_on : e.ends_on
  await run(
    `UPDATE events SET title = ?, detail = ?, starts_on = ?::date, ends_on = ?::date,
            start_time = ?::time, end_time = ?::time, repeats = ?,
            calendar_id = COALESCE(?::int, calendar_id), updated_at = now()
      WHERE workspace_id = ? AND id = ?`,
    (e.title ?? now.title).trim().slice(0, 200) || now.title,
    (e.detail ?? now.detail).trim().slice(0, 1000),
    starts,
    ends && ends > starts ? ends : null,
    clock(e.start_time) ?? now.start_time,
    clock(e.end_time) ?? hourAfter(clock(e.start_time) ?? now.start_time),
    (REPEATS as readonly string[]).includes(e.repeats ?? '') ? e.repeats : now.repeats,
    e.calendar_id ?? null,
    workspaceId,
    id,
  )
  await note(
    workspaceId,
    e.calendar_id ?? now.calendar_id,
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
  await publishEvents(workspaceId, now.calendar_id)
  if (e.calendar_id && e.calendar_id !== now.calendar_id) await publishEvents(workspaceId, e.calendar_id)
}

export async function removeEvent(workspaceId: number, id: number, actor?: string | null) {
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
  await publishEvents(workspaceId, gone.calendar_id)
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
