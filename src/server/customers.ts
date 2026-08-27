/**
 * Who we are talking to.
 *
 * The one idea here: a customer is a person, not an account on a channel. `identify()`
 * takes "this WhatsApp number" or "this browser" and returns the person, creating them
 * the first time and finding them every time after.
 *
 * Merging matters more than it looks. Without it the same human is three customers, and
 * the answer to "have we spoken to them before" is wrong on every channel but the one
 * they happen to be using.
 */
import { all, insert, one, run } from './db.ts'
import { DATE_KINDS } from '../types.ts'

export type Customer = {
  id: number
  /** The display name a channel gave us. First and last names are what somebody typed. */
  name: string | null
  first_name: string | null
  last_name: string | null
  company: string | null
  job_title: string | null
  /** The primary of each kind, mirrored from customer_points. See setPrimaries(). */
  email: string | null
  phone: string | null
  gender: string | null
  date_of_birth: string | null
  nationality: string | null
  ethnicity: string | null
  language: string | null
  timezone: string | null
  address: string | null
  city: string | null
  country: string | null
  owner: string | null
  source: string | null
  tags: string[]
  notes: string | null
  marketing_consent: boolean
  do_not_contact: boolean
  traits: Record<string, string>
  created_at: string
  last_seen_at: string
}

/** One way of reaching somebody. A person has several, so it is a row and not a column. */
export type Point = {
  id: number
  kind: string
  value: string
  label: string | null
  is_primary: boolean
}

/** What the editor may write. Everything optional; anything absent is left alone. */
export type Patch = Partial<
  Pick<
    Customer,
    | 'name' | 'first_name' | 'last_name' | 'company' | 'job_title'
    | 'gender' | 'date_of_birth' | 'nationality' | 'ethnicity' | 'language' | 'timezone'
    | 'address' | 'city' | 'country'
    | 'owner' | 'source' | 'notes' | 'marketing_consent' | 'do_not_contact'
  >
> & { tags?: string[] }

/** What a channel knows about whoever just wrote in. All of it optional but the id. */
export type Identity = {
  channel: string
  /** The channel's own id for them: phone number, chat id, email address, widget token. */
  externalId: string
  name?: string | null
  email?: string | null
  phone?: string | null
}

/**
 * Find or create the customer behind a channel identity.
 *
 * Matching, in order:
 *   1. this exact identity, seen before
 *   2. an email address we already hold — the one identifier people actually share
 *      across channels, and the only one worth merging on automatically
 *   3. a new customer
 *
 * Phone numbers are deliberately *not* merged on. They arrive in half a dozen formats and
 * a wrong merge joins two people's conversations together, which is a far worse failure
 * than leaving one person as two records that a human can merge later.
 */
export async function identify(workspaceId: number, id: Identity): Promise<Customer> {
  /*
   * Serialized on the identity, not on the workspace.
   *
   * `withWorkspace()` holds one transaction open for the whole inbound pipeline — retrieval,
   * the model call, the outbound send — which for a busy channel is multiple seconds. Two
   * calls for the *same brand-new* identity (a customer's own message racing a WhatsApp
   * from-me mirror of something sent from the connected phone moments later, say) can both
   * run the SELECT below before either commits, both see nothing, and both insert a customer
   * row. `customer_identities` has a primary key that stops the identity itself splitting,
   * but nothing stopped the loser's `customers` row from surviving as a name-less,
   * conversation-less duplicate.
   *
   * `pg_advisory_xact_lock` blocks a second caller with the same key until the first
   * transaction ends, and releases itself at commit or rollback — no unlock call, no column,
   * no lock that can outlive a crashed request. Keyed on the identity, so unrelated customers
   * are never serialized against each other; only two calls racing the exact same not-yet-
   * existing identity ever wait.
   */
  await run(
    `SELECT pg_advisory_xact_lock(hashtextextended(?, 0))`,
    `${workspaceId}:${id.channel}:${id.externalId}`,
  )

  const known = await one<{ customer_id: number }>(
    `SELECT customer_id FROM customer_identities WHERE workspace_id = ? AND channel = ? AND external_id = ?`,
    workspaceId,
    id.channel,
    id.externalId,
  )
  if (known) {
    await touch(workspaceId, known.customer_id, id)
    return (await get(workspaceId, known.customer_id))!
  }

  const email = id.email?.trim().toLowerCase() || null
  const existing = email
    ? await one<{ id: number }>(
        `SELECT id FROM customers WHERE workspace_id = ? AND lower(email) = ? ORDER BY id LIMIT 1`,
        workspaceId,
        email,
      )
    : undefined

  /*
   * No board here.
   *
   * Which project somebody belongs on is a fact about the bot that answered them, and this
   * function has no idea which bot that was — it runs before one is even chosen. agent.ts
   * adds the lead once it knows, which is also the only place that could be right.
   */
  const customerId =
    existing?.id ??
    (await insert(
      `INSERT INTO customers (workspace_id, name, first_name, last_name, email, phone)
       VALUES (?, ?, (split_person_name(?))[1], (split_person_name(?))[2], ?, ?)`,
      workspaceId,
      id.name?.trim() || null,
      id.name?.trim() || null,
      id.name?.trim() || null,
      email,
      id.phone?.trim() || null,
    ))

  // Only for somebody who did not exist a moment ago: `existing` is a merge onto a card that
  // already has a history, and "created" on it twice would be a lie.
  if (!existing?.id)
    await note(workspaceId, customerId, 'created', { became: id.name?.trim() || id.externalId }, { source: 'channel' })

  await run(
    `INSERT INTO customer_identities (workspace_id, customer_id, channel, external_id) VALUES (?,?,?,?)
     ON CONFLICT DO NOTHING`,
    workspaceId,
    customerId,
    id.channel,
    id.externalId,
  )
  await touch(workspaceId, customerId, id)
  return (await get(workspaceId, customerId))!
}

/**
 * Fill in blanks and mark them as seen.
 *
 * COALESCE on the stored value, so this only ever fills a gap. A channel that reports a
 * display name must not overwrite the name a person typed into the CRM, and an email
 * captured once must not be replaced by a later message that happens not to carry one.
 */
async function touch(workspaceId: number, customerId: number, id: Identity) {
  await run(
    `UPDATE customers
        SET name  = COALESCE(name, ?),
            first_name = COALESCE(first_name, (split_person_name(COALESCE(name, ?)))[1]),
            last_name  = COALESCE(last_name,  (split_person_name(COALESCE(name, ?)))[2]),
            email = COALESCE(email, ?),
            phone = COALESCE(phone, ?),
            last_seen_at = now()
      WHERE workspace_id = ? AND id = ?`,
    id.name?.trim() || null,
    id.name?.trim() || null,
    id.name?.trim() || null,
    id.email?.trim().toLowerCase() || null,
    id.phone?.trim() || null,
    workspaceId,
    customerId,
  )

  /*
   * Whatever the channel knew is a way of reaching them, kept alongside anything already
   * there rather than instead of it — a second address is a second address, not a
   * correction. Free on a repeat: the unique index makes the same sighting a no-op, and
   * being late means it never becomes the primary of a kind that already has one.
   */
  if (id.email?.trim()) await addPoint(workspaceId, customerId, 'email', id.email)
  if (id.phone?.trim()) await addPoint(workspaceId, customerId, 'phone', id.phone)
}

/**
 * Forget somebody entirely.
 *
 * Every conversation, message, identity, contact point, deal and booking goes with them —
 * all five tables cascade from this row. That is the point rather than a side effect: a
 * delete that left the transcripts behind would not be a delete, and this is the call an
 * erasure request is answered with.
 *
 * There is no soft delete and no undo, so the confirmation is the caller's job.
 */
export async function remove(workspaceId: number, id: number) {
  const { changes } = await run(`DELETE FROM customers WHERE workspace_id = ? AND id = ?`, workspaceId, id)
  if (!changes) throw new Error('No such contact')
}

export const get = (workspaceId: number, id: number) =>
  one<Customer>(`SELECT * FROM customers WHERE workspace_id = ? AND id = ?`, workspaceId, id)

export const list = (workspaceId: number) =>
  all<Customer & { channels: string[]; conversations: number }>(
    `SELECT c.*,
            COALESCE((SELECT array_agg(DISTINCT i.channel) FROM customer_identities i
                       WHERE i.customer_id = c.id), '{}') AS channels,
            (SELECT count(*)::int FROM conversations v WHERE v.customer_id = c.id) AS conversations
       FROM customers c
      WHERE c.workspace_id = ?
      ORDER BY c.last_seen_at DESC`,
    workspaceId,
  )

export const identitiesOf = (workspaceId: number, customerId: number) =>
  all<{ channel: string; external_id: string }>(
    `SELECT channel, external_id FROM customer_identities WHERE workspace_id = ? AND customer_id = ?
      ORDER BY channel`,
    workspaceId,
    customerId,
  )

/**
 * Merge new traits into what we already hold.
 *
 * `||` on jsonb is a shallow right-biased merge, which is the behaviour wanted: a newer
 * observation replaces an older one of the same key and leaves the rest alone. Keys and
 * values are trimmed and capped here rather than trusted, because these come from a model
 * reading a customer's own message — an unbounded one would happily store a paragraph.
 */
export async function learn(workspaceId: number, customerId: number, traits: Record<string, string>) {
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(traits)) {
    const key = k.trim().toLowerCase().slice(0, 40)
    const value = String(v).trim().slice(0, 200)
    if (key && value) clean[key] = value
  }
  if (!Object.keys(clean).length) return
  await run(
    `UPDATE customers SET traits = traits || ?::jsonb WHERE workspace_id = ? AND id = ?`,
    JSON.stringify(clean),
    workspaceId,
    customerId,
  )
}

/** The columns the contact page may write. Anything else about a person is a point or a deal. */
const FIELDS = [
  'name', 'first_name', 'last_name', 'company', 'job_title',
  'gender', 'date_of_birth', 'nationality', 'ethnicity', 'language', 'timezone',
  'address', 'city', 'country',
  'owner', 'source', 'notes', 'marketing_consent', 'do_not_contact',
] as const

/** Nothing is 400 characters of name, and a notes field is not a document store. */
const LIMITS: Record<string, number> = { notes: 4000, address: 500 }

// ---------------------------------------------------------------- what happened to a card

export type Change = {
  id: number
  action: string
  field: string | null
  was: string | null
  became: string | null
  source: string
  actor: string | null
  created_at: string
}

/**
 * Note something done to a contact.
 *
 * Never throws into the caller: a save that fails because its history could not be written
 * is worse than a history with a hole in it. The hole is logged instead.
 */
async function note(
  workspaceId: number,
  customerId: number,
  action: 'created' | 'updated' | 'added' | 'removed',
  what: { field?: string | null; was?: unknown; became?: unknown },
  by: { actor?: string | null; source?: string } = {},
) {
  const shown = (v: unknown) => {
    if (v === null || v === undefined || v === '') return null
    if (typeof v === 'boolean') return v ? 'yes' : 'no'
    return String(v).slice(0, 300)
  }
  try {
    await run(
      `INSERT INTO contact_log (workspace_id, customer_id, action, field, was, became, source, actor)
       VALUES (?,?,?,?,?,?,?,?)`,
      workspaceId,
      customerId,
      action,
      what.field ?? null,
      shown(what.was),
      shown(what.became),
      by.source ?? 'person',
      by.actor ?? null,
    )
  } catch (err) {
    console.error('[customers] could not record a change:', err instanceof Error ? err.message : err)
  }
}

/** What has happened to one contact, newest first. */
export const history = (workspaceId: number, customerId: number, limit = 200) =>
  all<Change>(
    `SELECT id, action, field, was, became, source, actor, created_at
       FROM contact_log WHERE workspace_id = ? AND customer_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    workspaceId,
    customerId,
    limit,
  )

/**
 * Set by hand, from the contact page. Blanking a field is allowed here; `touch` cannot.
 *
 * Only the keys present are written, so a page that shows half the record cannot wipe the
 * other half by omission — which is what a form of twenty fields makes very easy to do.
 */
export async function update(
  workspaceId: number,
  customerId: number,
  patch: Patch,
  /** Who is doing it, for the record. `source` says which of the three hands this was. */
  by: { actor?: string | null; source?: string } = {},
) {
  const sets: string[] = []
  const values: unknown[] = []
  // Read first: the log wants what each field was, and after the UPDATE it is gone.
  const before = await get(workspaceId, customerId)

  for (const field of FIELDS) {
    if (!(field in patch)) continue
    const raw = (patch as Record<string, unknown>)[field]
    sets.push(`${field} = ?`)
    if (typeof raw === 'boolean') values.push(raw)
    else if (typeof raw === 'string') values.push(raw.trim().slice(0, LIMITS[field] ?? 200) || null)
    /*
     * Numbers, which every field here used to be free of.
     *
     * Without this branch a number falls through to null, so setting a lead's value to 1000
     * silently stored nothing and the board totalled zero — the write reported success and
     * the figure was simply absent. Infinity and NaN are the honest null: they are not
     * amounts, and numeric would reject them anyway.
     */
    else if (typeof raw === 'number') values.push(Number.isFinite(raw) ? raw : null)
    else values.push(null)
  }

  if (patch.tags) {
    sets.push(`tags = ?::jsonb`)
    // Trimmed, de-duplicated, bounded: a tag list is for filtering, not for prose.
    values.push(
      JSON.stringify([...new Set(patch.tags.map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 30)),
    )
  }

  if (!sets.length) return
  const { changes } = await run(
    `UPDATE customers SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`,
    ...values,
    workspaceId,
    customerId,
  )
  if (!changes) throw new Error('No such customer')

  /*
   * One row per field that actually moved.
   *
   * After the write rather than before it, so nothing is recorded that did not happen, and
   * only where the value differs — a page that submits all twenty fields on every save would
   * otherwise write twenty rows of "unchanged" and bury the one that matters.
   */
  if (!before) return
  for (const field of FIELDS) {
    if (!(field in patch)) continue
    const was = (before as Record<string, unknown>)[field] ?? null
    const became = (patch as Record<string, unknown>)[field] ?? null
    const same = typeof was === 'string' && typeof became === 'string' ? was === became.trim() : was === became
    if (same || (was === null && became === '')) continue
    await note(workspaceId, customerId, 'updated', { field, was, became }, by)
  }
  if (patch.tags) {
    const was = (before.tags ?? []).join(', ')
    const became = patch.tags.join(', ')
    if (was !== became) await note(workspaceId, customerId, 'updated', { field: 'tags', was, became }, by)
  }
}

// ---------------------------------------------------------------- ways of reaching them

export const points = (workspaceId: number, customerId: number) =>
  all<Point>(
    `SELECT id, kind, value, label, is_primary FROM customer_points
      WHERE workspace_id = ? AND customer_id = ? ORDER BY kind, is_primary DESC, id`,
    workspaceId,
    customerId,
  )

/**
 * Add a way of reaching somebody, or leave the existing one alone.
 *
 * The first of each kind becomes the primary, because the first one is the only one — and
 * a kind with no primary would leave `customers.email` empty while an address sits right
 * there in the list.
 */
export async function addPoint(
  workspaceId: number,
  customerId: number,
  kind: string,
  value: string,
  label?: string | null,
) {
  const clean = value.trim().slice(0, 300)
  if (!clean) throw new Error('Nothing to add')
  if (!(await get(workspaceId, customerId))) throw new Error('No such customer')

  const first = !(await one(
    `SELECT 1 FROM customer_points WHERE workspace_id = ? AND customer_id = ? AND kind = ?`,
    workspaceId,
    customerId,
    kind.trim().toLowerCase(),
  ))

  await run(
    `INSERT INTO customer_points (workspace_id, customer_id, kind, value, label, is_primary)
     VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    workspaceId,
    customerId,
    kind.trim().toLowerCase().slice(0, 40),
    kind === 'email' ? clean.toLowerCase() : clean,
    label?.trim().slice(0, 40) || null,
    first,
  )
  await setPrimaries(workspaceId, customerId)
}

export async function removePoint(workspaceId: number, customerId: number, pointId: number) {
  const { changes } = await run(
    `DELETE FROM customer_points WHERE workspace_id = ? AND customer_id = ? AND id = ?`,
    workspaceId,
    customerId,
    pointId,
  )
  if (!changes) throw new Error('No such contact detail')
  await setPrimaries(workspaceId, customerId)
}

/** Which one of a kind the app uses when it needs exactly one. */
export async function makePrimary(workspaceId: number, customerId: number, pointId: number) {
  const point = await one<{ kind: string }>(
    `SELECT kind FROM customer_points WHERE workspace_id = ? AND customer_id = ? AND id = ?`,
    workspaceId,
    customerId,
    pointId,
  )
  if (!point) throw new Error('No such contact detail')

  await run(
    `UPDATE customer_points SET is_primary = (id = ?)
      WHERE workspace_id = ? AND customer_id = ? AND kind = ?`,
    pointId,
    workspaceId,
    customerId,
    point.kind,
  )
  await setPrimaries(workspaceId, customerId)
}

/**
 * Mirror the primary email and phone onto the customer row.
 *
 * Those two columns are what `identify()` merges on and what a reply is addressed to, so
 * they have to hold one value — but a person has several, and the list is the truth. This
 * is the cached answer to "which one", recomputed whenever the list changes rather than
 * maintained by hand in four places.
 */
async function setPrimaries(workspaceId: number, customerId: number) {
  await run(
    `UPDATE customers c SET
       email = (SELECT p.value FROM customer_points p
                 WHERE p.customer_id = c.id AND p.kind = 'email'
                 ORDER BY p.is_primary DESC, p.id LIMIT 1),
       phone = (SELECT p.value FROM customer_points p
                 WHERE p.customer_id = c.id AND p.kind = 'phone'
                 ORDER BY p.is_primary DESC, p.id LIMIT 1)
     WHERE c.workspace_id = ? AND c.id = ?`,
    workspaceId,
    customerId,
  )
}

// ---------------------------------------------------------------- dates of their own

/**
 * What one customer told us about their own availability.
 *
 * Kept here rather than on a project, and reached from a board by joining `project_leads` —
 * the same way a booking reaches one. A person is away in September whichever boards they
 * happen to be on, and taking them off a board must not delete the fact that they are away.
 */
export type CustomerDate = {
  id: number
  customer_id: number
  kind: 'away' | 'free' | 'prefer' | 'other'
  title: string
  detail: string
  starts_on: string
  ends_on: string | null
  start_time: string | null
  end_time: string | null
  source: string
  conversation_id: number | null
  created_at: string
}

export const datesOf = (workspaceId: number, customerId: number) =>
  all<CustomerDate>(
    `SELECT id, customer_id, kind, title, detail, starts_on::text, ends_on::text,
            to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time,
            source, conversation_id, created_at
       FROM customer_dates
      WHERE workspace_id = ? AND customer_id = ?
      ORDER BY starts_on, id`,
    workspaceId,
    customerId,
  )

/**
 * Record a date of theirs, or quietly do nothing if it is already recorded.
 *
 * Returns the new id, or null when the unique index turned it away — which is the ordinary
 * outcome for something mentioned in more than one thread, not a failure.
 */
export async function addDate(
  workspaceId: number,
  customerId: number,
  d: {
    kind?: string
    title: string
    detail?: string
    starts_on: string
    ends_on?: string | null
    start_time?: string | null
    end_time?: string | null
    source?: string
    conversation_id?: number | null
  },
  by: { actor?: string | null } = {},
): Promise<number | null> {
  const kind = d.kind && d.kind in DATE_KINDS ? d.kind : 'other'
  const title = d.title.trim().slice(0, 200)
  if (!title) throw new Error('That date needs a name')

  const row = await one<{ id: number }>(
    `INSERT INTO customer_dates
       (workspace_id, customer_id, kind, title, detail, starts_on, ends_on, start_time, end_time,
        source, conversation_id)
     VALUES (?,?,?,?,?, ?::date, ?::date, ?::time, ?::time, ?, ?)
     ON CONFLICT DO NOTHING RETURNING id`,
    workspaceId,
    customerId,
    kind,
    title,
    (d.detail ?? '').trim().slice(0, 500),
    d.starts_on,
    // An end the same as the start is a single day, which is what null means here.
    d.ends_on && d.ends_on > d.starts_on ? d.ends_on : null,
    d.start_time || null,
    d.end_time || null,
    d.source ?? 'person',
    d.conversation_id ?? null,
  )
  if (!row) return null

  await note(
    workspaceId,
    customerId,
    'added',
    {
      field: 'a date',
      became: `${DATE_KINDS[kind as keyof typeof DATE_KINDS]} · ${title} · ${d.starts_on}${
        d.ends_on && d.ends_on > d.starts_on ? ` to ${d.ends_on}` : ''
      }`,
    },
    { actor: by.actor, source: d.source ?? 'person' },
  )
  return row.id
}

export async function removeDate(workspaceId: number, customerId: number, id: number, actor?: string | null) {
  const gone = await one<{ title: string; kind: string; starts_on: string; source: string }>(
    `DELETE FROM customer_dates WHERE workspace_id = ? AND customer_id = ? AND id = ?
      RETURNING title, kind, starts_on::text, source`,
    workspaceId,
    customerId,
    id,
  )
  if (!gone) throw new Error('No such date')
  await note(
    workspaceId,
    customerId,
    'removed',
    { field: 'a date', was: `${gone.title} · ${gone.starts_on}` },
    { actor, source: gone.source },
  )
}
