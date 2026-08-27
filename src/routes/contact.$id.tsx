import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as convo from '../server/conversations'
import * as customers from '../server/customers'
import * as lessons from '../server/lessons'
import { ChannelIcon } from '../components/ChannelIcon'
import { NotFound } from '../components/NotFound'
import { DATE_KINDS, POINT_KINDS, displayName, when } from '../types'

/**
 * One person: who they are, every way of reaching them, and everything they have said.
 *
 * The split that matters is between what a channel wrote and what a person typed. A push
 * name and a WhatsApp address arrive on their own and are only ever filled into blanks;
 * everything on this page is somebody's own work and is never overwritten.
 */
const load = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const contact = await customers.get(s.workspaceId, data)
    if (!contact) return null
    return {
      contact,
      points: await customers.points(s.workspaceId, data),
      identities: await customers.identitiesOf(s.workspaceId, data),
      threads: await convo.byCustomer(s.workspaceId, data),
      history: await customers.history(s.workspaceId, data),
      dates: await customers.datesOf(s.workspaceId, data),
      /*
       * Only ever disagreements. A blank field was filled the moment the bot read it, so
       * anything still waiting is the customer saying something different from what
       * somebody here typed — which is a decision, not a gap.
       */
      waiting: await lessons.waitingFor(s.workspaceId, data),
    }
  })

/** Agree with what the customer said, or leave the card as it is. Either way it stops asking. */
const decide = createServerFn({ method: 'POST' })
  .validator((d: { id: number; status: 'approved' | 'rejected' }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await lessons.decideContact(s.workspaceId, data.id, data.status)
  })

const save = createServerFn({ method: 'POST' })
  .validator((d: { id: number; patch: customers.Patch }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    // Named, so the card's history says who rather than that somebody did.
    await customers.update(s.workspaceId, data.id, data.patch, { actor: s.email, source: 'person' })
  })

const addPoint = createServerFn({ method: 'POST' })
  .validator((d: { id: number; kind: string; value: string; label: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await customers.addPoint(s.workspaceId, data.id, data.kind, data.value, data.label)
  })

const dropPoint = createServerFn({ method: 'POST' })
  .validator((d: { id: number; pointId: number }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await customers.removePoint(s.workspaceId, data.id, data.pointId)
  })

const primaryPoint = createServerFn({ method: 'POST' })
  .validator((d: { id: number; pointId: number }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await customers.makePrimary(s.workspaceId, data.id, data.pointId)
  })

const saveDate = createServerFn({ method: 'POST' })
  .validator((d: Record<string, unknown>) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const id = Number(data.id) || 0
    if (data.remove) return customers.removeDate(s.workspaceId, Number(data.customerId), id, s.email)
    await customers.addDate(s.workspaceId, Number(data.customerId), data as never, { actor: s.email })
  })

const remove = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await customers.remove(s.workspaceId, data)
  })

export const Route = createFileRoute('/contact/$id')({
  // Returned, not thrown: a contact from another workspace reads exactly like one that
  // never existed, which is the only thing it is safe to say about it — see NotFound.
  loader: ({ params }) => load({ data: Number(params.id) }),
  component: Contact,
})


/** Whole years, from a date of birth — which is stored instead of an age, because ages rot. */
const ageFrom = (dob: string | null) => {
  if (!dob) return null
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  const now = new Date()
  const years = now.getFullYear() - born.getFullYear()
  const had = now.getMonth() > born.getMonth() || (now.getMonth() === born.getMonth() && now.getDate() >= born.getDate())
  return years - (had ? 0 : 1)
}

/**
 * The page in five questions, rather than one column of everything.
 *
 * A contact record answers quite different questions — who is this, how do I reach them,
 * what have they said, what do we know — and stacking all of them meant scrolling past
 * sixteen form fields to read a phone number.
 */
const TABS = ['details', 'reach', 'dates', 'threads', 'notes', 'changes'] as const

/** Which tabs hold fields the one Save button writes. */
const EDITS = new Set<(typeof TABS)[number]>(['details', 'notes'])

/**
 * A column name as a person would say it: `date_of_birth` → "Date of birth".
 *
 * Derived rather than a second table of labels. The log records every field on the card,
 * including the ones no chatbot may touch, and a hand-written map would be a list to forget
 * to add to — every name here already reads correctly with the underscores taken out.
 */
const readable = (field: string) => field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/**
 * Hook-free on purpose: the only thing this does is decide which of two components mounts.
 * `ContactView` below has its own long run of hooks reading straight off `contact`'s fields,
 * and a conditional return sitting in front of those — rather than in front of all of it,
 * here — would change how many hooks run the moment `data` flips from null to real between
 * two renders of the *same* mounted route (a different id, not a different page).
 */
function Contact() {
  const data = Route.useLoaderData()
  if (!data) return <NotFound what="contact" to="/contacts" label="Back to the list." />
  return <ContactView data={data} />
}

function ContactView({ data }: { data: NonNullable<Awaited<ReturnType<typeof load>>> }) {
  const { contact, points, identities, threads, history, dates, waiting } = data
  const router = useRouter()
  const saveFn = useServerFn(save)
  const removeFn = useServerFn(remove)
  const dateFn = useServerFn(saveDate)
  const decideFn = useServerFn(decide)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  /*
   * The saved contact, in the shape the form holds it.
   *
   * Used twice: once to fill the form, and again on every render to tell whether anything
   * has been typed since. That second use is what makes tabs safe — the fields are spread
   * across Details and Notes now, and Save has to stay reachable from wherever somebody
   * wandered off to, or edits go quietly over the side.
   */
  const start = () => ({
    name: contact.name ?? '',
    first_name: contact.first_name ?? '',
    last_name: contact.last_name ?? '',
    company: contact.company ?? '',
    job_title: contact.job_title ?? '',
    owner: contact.owner ?? '',
    source: contact.source ?? '',
    gender: contact.gender ?? '',
    date_of_birth: contact.date_of_birth?.slice(0, 10) ?? '',
    nationality: contact.nationality ?? '',
    ethnicity: contact.ethnicity ?? '',
    language: contact.language ?? '',
    timezone: contact.timezone ?? '',
    address: contact.address ?? '',
    city: contact.city ?? '',
    country: contact.country ?? '',
    tags: (contact.tags ?? []).join(', '),
    notes: contact.notes ?? '',
    marketing_consent: contact.marketing_consent,
    do_not_contact: contact.do_not_contact,
  })

  const [form, setForm] = useState(start)
  const [tab, setTab] = useState<(typeof TABS)[number]>('details')
  // Flat, all strings and booleans, so comparing the serialised pair is honest and cheap.
  const dirty = JSON.stringify(form) !== JSON.stringify(start())

  const set = (key: keyof typeof form) => (value: string | boolean) => {
    setForm((f) => ({ ...f, [key]: value }))
    setNote('')
  }

  /** The small mutations on this page: adding and dropping a date. */
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr('')
    try {
      await fn()
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const erase = async () => {
    // Everything they ever said goes with them and none of it comes back, so the count is
    // in the question rather than in a note underneath it.
    const said = threads.length === 1 ? '1 conversation' : `${threads.length} conversations`
    if (!window.confirm(`Delete ${shown}? Their ${said} and every message in them are deleted too. This cannot be undone.`))
      return

    setBusy(true)
    setErr('')
    try {
      await removeFn({ data: contact.id })
      await router.navigate({ to: '/contacts' })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      const { tags, ...rest } = form
      await saveFn({
        data: { id: contact.id, patch: { ...rest, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } },
      })
      setNote('Saved.')
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const age = ageFrom(form.date_of_birth || contact.date_of_birth)
  const shown = displayName(contact)

  const field = (key: keyof typeof form, label: string, extra?: { type?: string; hint?: string; wide?: boolean }) => (
    <div style={extra?.wide ? { gridColumn: '1 / -1' } : undefined}>
      <label htmlFor={key}>{label}</label>
      <input
        id={key}
        type={extra?.type ?? 'text'}
        value={String(form[key] ?? '')}
        onChange={(e) => set(key)(e.target.value)}
        placeholder="Not known"
      />
      {extra?.hint && (
        <p className="note" style={{ margin: '4px 0 0' }}>
          {extra.hint}
        </p>
      )}
    </div>
  )

  return (
    <>
      <p className="note" style={{ marginBottom: 4 }}>
        <Link to="/contacts">‹ Contacts</Link>
      </p>
      <h1>{shown}</h1>
      <p className="lede">
        {[
          contact.job_title && contact.company ? `${contact.job_title} at ${contact.company}` : contact.company,
          `first seen ${when(contact.created_at)}`,
          `last ${when(contact.last_seen_at)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {contact.do_not_contact && (
        <div className="card banner bad" style={{ marginBottom: 8 }}>
          <b>Do not contact.</b> Somebody marked this person as not to be written to.
        </div>
      )}

      <div className="seg tabstrip" role="tablist" aria-label="This contact">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'on' : ''}
            onClick={() => setTab(t)}
          >
            {t === 'details'
              ? 'Details'
              : t === 'reach'
                ? `Reaching them (${points.length})`
                : t === 'dates'
                  ? `Dates (${dates.length})`
                  : t === 'threads'
                    ? `Conversations (${threads.length})`
                    : t === 'notes'
                      ? 'Notes'
                      : `Changes (${history.length})`}
            {/* Typed but not written down, on a tab that is not the one being looked at. */}
            {dirty && EDITS.has(t) && tab !== t && <b className="dot" aria-label="unsaved" />}
          </button>
        ))}
      </div>

      {/*
        Above the tabs, not inside one. It is a question waiting on an answer, and burying
        it under a tab is how it waits forever — the whole reason it is here rather than
        being written straight onto the card is that somebody has to decide.
      */}
      {waiting.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>They said something different</h3>
          <p className="note" style={{ marginTop: 4 }}>
            Read from a conversation. The card says one thing and they said another, so nothing has been
            changed.
          </p>
          {waiting.map((w) => (
            <div key={w.id} className="row" style={{ marginTop: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 220 }}>
                <strong>{w.question}</strong>
                <span className="note" style={{ display: 'block' }}>
                  they said “{w.answer}”
                </span>
              </span>
              <button
                className="ghost small"
                onClick={async () => {
                  await decideFn({ data: { id: w.id, status: 'approved' } })
                  await router.invalidate()
                }}
              >
                Use theirs
              </button>
              <button
                className="ghost small"
                onClick={async () => {
                  await decideFn({ data: { id: w.id, status: 'rejected' } })
                  await router.invalidate()
                }}
              >
                Keep ours
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'details' && (
        <div className="card">
          <h3>Who they are</h3>
          <div className="fields" style={{ marginTop: 12 }}>
            {field('name', 'Full name', {
              wide: true,
              hint: 'What the channel called them. The two halves below are used instead wherever they are filled in.',
            })}
            {field('first_name', 'First name')}
            {field('last_name', 'Last name')}
            {field('company', 'Company')}
            {field('job_title', 'Job title')}
            {field('owner', 'Owned by', { hint: 'Whoever here looks after this relationship.' })}
            {field('source', 'Source', { hint: 'How they arrived: a campaign, a referral, the website.' })}
          </div>

          <h3 style={{ marginTop: 22 }}>Where they are</h3>
          <div className="fields" style={{ marginTop: 12 }}>
            {field('city', 'City')}
            {field('country', 'Country')}
            {field('timezone', 'Time zone', { hint: 'So nobody calls at four in the morning.' })}
            {field('language', 'Language', { hint: 'What to answer them in.' })}
            {field('address', 'Address', { wide: true })}
          </div>

          <h3 style={{ marginTop: 22 }}>Personal</h3>
          <p className="note" style={{ marginTop: 0 }}>
            Fill these in only where the business genuinely needs them — advice that differs by age, or a
            product that ships by country. Ethnicity in particular is protected data in most places.
          </p>
          <div className="fields">
            {field('date_of_birth', 'Date of birth', {
              type: 'date',
              hint: age === null ? 'A date, not an age — an age is wrong within a year.' : `${age} years old.`,
            })}
            {field('gender', 'Gender', { hint: 'Free text, because it is theirs to say.' })}
            {field('nationality', 'Nationality')}
            {field('ethnicity', 'Ethnicity')}
          </div>

          {/* Far from Save, quiet, and last: it is the one control on this page that cannot
              be undone, so it should never be the one hit by accident. */}
          <div className="row" style={{ marginTop: 24, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <span className="grow" />
            <button className="ghost bad" disabled={busy} onClick={erase}>
              Delete contact
            </button>
          </div>
        </div>
      )}

      {tab === 'notes' && (
        <div className="card">
          <h3>Notes and labels</h3>
          <div className="fields" style={{ marginTop: 12, gridTemplateColumns: '1fr' }}>
            <div>
              <label htmlFor="tags">Tags</label>
              <input
                id="tags"
                value={form.tags}
                onChange={(e) => set('tags')(e.target.value)}
                placeholder="vip, wholesale, singapore"
              />
              <p className="note" style={{ margin: '4px 0 0' }}>
                Separated by commas. What this company sorts people by.
              </p>
            </div>
            <div>
              <label htmlFor="notes">Notes</label>
              <textarea id="notes" value={form.notes} onChange={(e) => set('notes')(e.target.value)} />
            </div>
          </div>

          <div style={{ marginTop: 14 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={form.marketing_consent}
                onChange={(e) => set('marketing_consent')(e.target.checked)}
              />
              <span>
                <strong>Agreed to marketing</strong>
                <span className="note" style={{ display: 'block' }}>
                  Writing in for support is not agreement. Tick this only if they said so.
                </span>
              </span>
            </label>
            <label className="check" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={form.do_not_contact}
                onChange={(e) => set('do_not_contact')(e.target.checked)}
              />
              <span>
                <strong>Do not contact</strong>
                <span className="note" style={{ display: 'block' }}>
                  They asked not to be written to. Shown on every screen that mentions them.
                </span>
              </span>
            </label>
          </div>

        </div>
      )}

      {tab === 'dates' && (
        <Dates
          dates={dates}
          busy={busy}
          onAdd={(v) => act(() => dateFn({ data: { ...v, customerId: contact.id } }))}
          onRemove={(id) => act(() => dateFn({ data: { id, customerId: contact.id, remove: true } }))}
        />
      )}

      {tab === 'reach' && (
        <>
          <Points contactId={contact.id} points={points} />

          <div className="card" style={{ marginTop: 8 }}>
            <h3>Known on</h3>
            <p className="note" style={{ marginTop: 0 }}>
              Where their messages actually come from. Written by the channel, so not editable — rewriting
              one would point the next reply at somebody else.
            </p>
            {identities.map((i) => (
              <p key={`${i.channel}:${i.external_id}`} className="chline" style={{ margin: '6px 0' }}>
                <span className={`src-${i.channel}`}>
                  <ChannelIcon source={i.channel} size={14} />
                </span>
                <code>{i.external_id}</code>
              </p>
            ))}

            {Object.entries(contact.traits ?? {}).length > 0 && (
              <>
                <h3 style={{ marginTop: 18 }}>What Arlo has picked up</h3>
                <p className="note" style={{ marginTop: 0 }}>
                  Observed in conversation, not asked for.
                </p>
                <div className="row" style={{ gap: 6 }}>
                  {Object.entries(contact.traits ?? {}).map(([k, v]) => (
                    <span key={k} className="pill">
                      {k}: {v}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/*
        Save, wherever they are.

        Shown on the two tabs that hold fields, and on any tab at all once something has been
        typed — the fields are spread out now, and a Save that is only on the tab you left is
        the same as no Save.
      */}
      {(EDITS.has(tab) || dirty) && (
        <div className="row" style={{ marginTop: 16 }}>
          <button disabled={busy || !dirty} onClick={submit}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {dirty ? (
            <span className="note">Not saved yet.</span>
          ) : (
            note && <span className="pill ok">{note}</span>
          )}
        </div>
      )}
      {err && <p className="err">{err}</p>}

      {tab === 'threads' &&
        (threads.length === 0 ? (
          <div className="card">
            <p className="note" style={{ margin: 0 }}>
              Nothing yet.
            </p>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Last message</th>
                <th className="num">Messages</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {threads.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="chline">
                      <span className={`src-${t.channel}`}>
                        <ChannelIcon source={t.channel} size={14} />
                      </span>
                      {t.channel}
                    </span>
                  </td>
                  <td>
                    <Link to="/inbox" search={{ id: t.id }}>
                      {t.last_body?.slice(0, 80) ?? 'No messages'}
                    </Link>
                  </td>
                  <td className="num">{t.messages}</td>
                  <td>
                    <span className={`pill ${t.status === 'human' ? 'warn' : t.status === 'bot' ? 'ok' : ''}`}>
                      {t.status === 'human' ? `with ${t.assignee ?? 'a person'}` : t.status}
                    </span>
                  </td>
                  <td>{when(t.last_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ))}

      {tab === 'changes' &&
        (history.length === 0 ? (
          <div className="card">
            <p className="note" style={{ margin: 0 }}>
              Nothing has changed on this card yet. Everything written to it from here on is listed —
              by whom, and whether they typed it, a channel filled it in, or somebody approved it.
            </p>
          </div>
        ) : (
          <div className="movelist">
            <div className="moverow head" aria-hidden="true">
              <span>When</span>
              <span>What</span>
              <span>Change</span>
              <span>By</span>
              <span>Now</span>
            </div>
            {history.map((h) => (
              <div key={h.id} className="moverow">
                <span className="when note">{when(h.created_at)}</span>
                <span className="who">{h.field ? readable(h.field) : 'The contact'}</span>
                <span className="what">
                  <strong>{h.action}</strong>
                  {/* Where it came from. A card is written by three different hands and the
                      difference is the first thing to check when a field looks wrong. */}
                  {h.source !== 'person' && <span className="pill">{h.source}</span>}
                </span>
                <span className="by note">
                  {h.actor ?? (h.source === 'learned' ? 'an approval' : h.source === 'channel' ? 'the channel' : 'the app')}
                </span>
                <span className="why note">
                  {h.became ?? <em>emptied</em>}
                  {h.was && h.action === 'updated' && <small className="note"> · was {h.was}</small>}
                </span>
              </div>
            ))}
          </div>
        ))}
    </>
  )
}

/**
 * Every way of reaching one person.
 *
 * Rows rather than fields, because a person has a work address and a personal one, two
 * numbers and a handle on whichever app they actually read. The primary of each kind is
 * the one the app uses when it can only use one — a reply, a merge, a lookup.
 */
function Points({ contactId, points }: { contactId: number; points: customers.Point[] }) {
  const router = useRouter()
  const add = useServerFn(addPoint)
  const drop = useServerFn(dropPoint)
  const primary = useServerFn(primaryPoint)

  const [kind, setKind] = useState<string>('email')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
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

  const submit = () =>
    act('add', async () => {
      await add({ data: { id: contactId, kind, value, label } })
      setValue('')
      setLabel('')
    })

  return (
    <div className="card">
      <h3>Ways to reach them</h3>
      <p className="note" style={{ marginTop: 0 }}>
        As many as you know. The first of each kind is the one Arlo uses when it needs exactly one.
      </p>

      {points.map((p) => (
        <div key={p.id} className="acctrow">
          <span className={`src-${p.kind}`}>
            <ChannelIcon source={p.kind} size={14} />
          </span>
          <div className="acctwho">
            <strong style={{ overflowWrap: 'anywhere' }}>{p.value}</strong>
            <p className="note" style={{ margin: 0 }}>
              {[p.kind, p.label, p.is_primary && 'primary'].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="acctactions">
            {!p.is_primary && (
              <button
                className="ghost"
                disabled={!!busy}
                title="Use this one when only one will do"
                onClick={() => act(`p${p.id}`, () => primary({ data: { id: contactId, pointId: p.id } }))}
              >
                {busy === `p${p.id}` ? '…' : 'Primary'}
              </button>
            )}
            <button
              className="danger"
              disabled={!!busy}
              onClick={() => act(`d${p.id}`, () => drop({ data: { id: contactId, pointId: p.id } }))}
            >
              {busy === `d${p.id}` ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ))}

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, marginTop: 12 }}>
        <div className="fields" style={{ gridTemplateColumns: 'minmax(110px, 0.6fr) minmax(0, 1.6fr) minmax(90px, 0.6fr)' }}>
          <div>
            <label htmlFor="kind">Kind</label>
            <select id="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {POINT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="value">Address, number or handle</label>
            <input
              id="value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && value.trim() && submit()}
              placeholder={kind === 'email' ? 'kit@example.com' : kind === 'phone' ? '+65 9123 4567' : '@handle or a link'}
            />
          </div>
          <div>
            <label htmlFor="plabel">Label</label>
            <input id="plabel" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="work" />
          </div>
        </div>
        <button style={{ marginTop: 10 }} disabled={!value.trim() || !!busy} onClick={submit}>
          {busy === 'add' ? 'Adding…' : 'Add'}
        </button>
      </div>

      {err && (
        <p className="err" style={{ marginBottom: 0 }}>
          {err}
        </p>
      )}
    </div>
  )
}

/**
 * When this person is away, free, or would rather be reached.
 *
 * Their dates, not the company's — the business calendar is a different thing entirely, read
 * by every chatbot and approved before anything reaches it. These are read from what this one
 * customer said, kept on their card, and no chatbot ever sees them: one customer's travel is
 * not something to tell the next customer who asks.
 */
function Dates({
  dates,
  busy,
  onAdd,
  onRemove,
}: {
  dates: customers.CustomerDate[]
  busy: boolean
  onAdd: (v: Record<string, unknown>) => Promise<void>
  onRemove: (id: number) => Promise<void>
}) {
  const blank = { kind: 'away', title: '', starts_on: '', ends_on: '' }
  const [v, setV] = useState(blank)
  const [adding, setAdding] = useState(false)

  return (
    <div className="card">
      <div className="tip">
        <strong>Theirs, not the business&rsquo;s</strong>
        <p>
          When this person is away, free or would rather be reached. Anything they say about it in a
          conversation lands here by itself. No chatbot reads these — one customer&rsquo;s travel is not
          something to tell the next customer.
        </p>
      </div>

      {dates.length === 0 ? (
        <p className="note">Nothing yet.</p>
      ) : (
        <div className="pricelist">
          {dates.map((d) => (
            <div key={d.id} className="pricerow">
              <span className="what">
                <b>{d.title}</b>
                <span className={`pill${d.kind === 'away' ? ' bad' : d.kind === 'free' ? ' ok' : ''}`}>
                  {DATE_KINDS[d.kind] ?? d.kind}
                </span>
                <small>
                  {d.starts_on}
                  {d.ends_on ? ` to ${d.ends_on}` : ''}
                  {/* Where it came from, on every row: a date they said and a date somebody
                      typed are corrected in different places when one is wrong. */}
                  {' · '}
                  {d.source === 'learned' ? 'from a conversation' : 'added by hand'}
                </small>
              </span>
              <button className="ghost small bad" disabled={busy} onClick={() => void onRemove(d.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="fields">
            <div>
              <label htmlFor="d-kind">What sort</label>
              <select id="d-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
                {Object.entries(DATE_KINDS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="d-title">What it is</label>
              <input
                id="d-title"
                placeholder="In Japan, back at work, mornings only"
                value={v.title}
                onChange={(e) => setV({ ...v, title: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="d-from">From</label>
              <input id="d-from" type="date" value={v.starts_on} onChange={(e) => setV({ ...v, starts_on: e.target.value })} />
            </div>
            <div>
              <label htmlFor="d-to">To</label>
              <input id="d-to" type="date" value={v.ends_on} onChange={(e) => setV({ ...v, ends_on: e.target.value })} />
              <p className="note" style={{ margin: '4px 0 0' }}>
                Only for something spanning days.
              </p>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="small"
              disabled={!v.title.trim() || !v.starts_on || busy}
              onClick={() =>
                void onAdd({ ...v, ends_on: v.ends_on || null }).then(() => {
                  setV(blank)
                  setAdding(false)
                })
              }
            >
              Add
            </button>
            <button className="ghost small" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="ghost small" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
          Add a date
        </button>
      )}
    </div>
  )
}
