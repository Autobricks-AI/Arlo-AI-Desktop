import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import { handBack } from '../server/agent'
import { harvest, markRead } from '../server/lessons'
import * as bots from '../server/bot'
import { connections, replyAsPerson, tidy } from '../server/channels'
import * as convo from '../server/conversations'
import * as attachments from '../server/attachments'
import * as customers from '../server/customers'
import * as resources from '../server/resources'
import { ChannelIcon } from '../components/ChannelIcon'
import { useChatFiles } from '../components/ChatFiles'
import { Pager } from '../components/Pager'
import { CONNECTORS, INBOX_PAGE, MAX_RESOURCE_MB, connectionOf, windowOf, windowSays } from '../types'
import type { Status } from '../types'
import { Peek, lightDismiss } from '../components/Modal'

/**
 * The inbox: every conversation on every channel, and the place a person answers one.
 *
 * Two panes and no more. The list is the whole workspace in one column — a support person
 * looking for "the thing that came in five minutes ago" should not have to pick a channel
 * first — and opening one shows the thread beside who it is with.
 *
 * A thread is in the URL, so a conversation can be linked to and reloading keeps it open.
 */

const load = createServerFn({ method: 'GET' })
  .validator(
    (d: {
      id: number | null
      bot: number | null
      status: string | null
      /** A connector id, or one connection id. Resolved below — see the comment there. */
      from: string | null
      /** Name, number or address. Matched in SQL — see conversations.inbox(). */
      find: string | null
      /** Only the WhatsApp Business threads past the 24-hour window. */
      cold: boolean
      page: number
    }) => d,
  )
  .handler(async ({ data }) => {
    const s = await requireSession()

    /*
     * One control, two questions.
     *
     * "Only this connector" and "only this one number" are the same filter at different
     * widths — a connector is just the set of connections it owns. Resolving it here rather
     * than in the query keeps `inbox()` knowing only about connections, which is the thing a
     * `channel_ref` actually carries.
     */
    const live = await connections(s.workspaceId)
    const owned = data.from ? live.filter((c) => c.connector === data.from).map((c) => c.connection) : []
    // Named for what it is, not `connections` — that is the imported function three lines up.
    const onlyFrom = data.from ? (owned.length ? owned : [data.from]) : undefined

    const page = await convo.inbox(s.workspaceId, {
      status: (data.status as convo.Status | null) ?? undefined,
      connections: onlyFrom,
      find: data.find ?? undefined,
      cold: data.cold || undefined,
      botId: data.bot ?? undefined,
      page: data.page,
    })
    return {
      me: s.email,
      rows: page.rows,
      total: page.total,
      // Named, so the filter reads as a bot rather than as a number in the address bar.
      filtered: data.bot ? ((await bots.get(s.workspaceId, data.bot))?.name ?? null) : null,
      counts: await convo.counts(s.workspaceId, data.bot ?? undefined),
      // Which bot, which number, which mailbox: a thread reference carries the connection
      // id, and this is what turns it into something a person can read.
      connections: live,
      // What a person can attach without leaving the thread.
      library: (await resources.list(s.workspaceId)).filter((r) => r.kind === 'file'),
      open: data.id ? await thread(s.workspaceId, data.id) : null,
    }
  })

/** One conversation with everything the person answering it needs beside it. */
async function thread(workspaceId: number, id: number) {
  const conversation = await convo.get(workspaceId, id)
  if (!conversation) return null
  const customer = await customers.get(workspaceId, conversation.customer_id)
  const messages = await convo.messages(workspaceId, id)
  return {
    conversation,
    customer,
    /*
     * When the customer last wrote, which is the clock WhatsApp's 24-hour window runs on.
     *
     * Not derived from `messages` below, which is the newest two hundred — a thread that has
     * had two hundred messages out of it since would read as never having had one in.
     */
    lastIn: await convo.lastInboundAt(workspaceId, id),
    /*
     * How many the thread holds altogether, so the transcript can say whether there are older
     * ones. A long-running thread holds thousands and the window is two hundred; without this
     * the rest were absent with nothing on screen to say so.
     */
    messageCount: await convo.messageCount(workspaceId, id),
    /*
     * Which bot answers here, if any. A thread marked as the bot's on a connection no bot
     * is assigned to is a thread nothing is watching, and saying "Arlo is answering" over
     * it is the one thing the page must not do.
     */
    bot: (await bots.routeTo(workspaceId, conversation.channel, bots.connectionOf(conversation.channel_ref)))?.name ?? null,
    /*
     * And what it is doing, which the name alone cannot say.
     *
     * A draft-mode bot holds a thread and sends nothing, and until this the page had no way
     * to tell that apart from answering -- so a thread switched on to be answered looked
     * exactly like one that was not.
     */
    botMode:
      (await bots.routeTo(workspaceId, conversation.channel, bots.connectionOf(conversation.channel_ref)))?.mode ?? null,
    identities: await customers.identitiesOf(workspaceId, conversation.customer_id),
    messages,
    // One query for the whole thread rather than one per message.
    files: await attachments.forMessages(workspaceId, messages.map((m) => m.id)),
  }
}

/**
 * The window before what is on screen.
 *
 * A transcript gets "load older", not page numbers: a conversation reads downwards and a page
 * control in the middle of one is disorienting. The cursor is the oldest message currently
 * shown rather than an offset, because new replies keep arriving at the other end while
 * somebody reads backwards — an offset counted from the top would shift under them.
 */
const older = createServerFn({ method: 'GET' })
  .validator((d: { id: number; at: string; before: number }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    return { rows: await convo.before(s.workspaceId, data.id, { at: data.at, id: data.before }) }
  })

/**
 * Answer as a person.
 *
 * Sending takes the thread over: a bot that keeps talking underneath a human is the worst
 * failure this product has, and somebody typing a reply has plainly decided to own it.
 * Handing it back is one button away.
 */
/**
 * Put a file in the library from the thread somebody is answering.
 *
 * The same store the Media page and the chatbots use — a file attached here is a file the
 * workspace keeps, not a one-off upload that vanishes into one conversation. FormData for the
 * reason the chatbot editor gives: base64 in a JSON body is a third bigger and held twice.
 */
const attach = createServerFn({ method: 'POST' })
  .validator((d: FormData) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const file = data.get('file')
    if (!(file instanceof File)) throw new Error('No file was attached')
    if (file.size > resources.MAX_BYTES)
      throw new Error(`${file.name} is over the ${resources.MAX_BYTES / 1048576}MB limit`)
    const id = await resources.addFile(
      s.workspaceId,
      { name: file.name, mime: file.type, bytes: Buffer.from(await file.arrayBuffer()) },
      '',
      'upload',
    )
    return { id }
  })

const send = createServerFn({ method: 'POST' })
  .validator((d: { id: number; text: string; resourceIds?: number[] }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    /*
     * Resolved here, from ids, rather than trusting what the browser sent.
     *
     * A `Sendable` carries the token that becomes a public address, so taking one off the
     * wire would let anybody with the page send any file whose id they could guess. The list
     * is this workspace's own, filtered to what was asked for.
     */
    const wanted = new Set(data.resourceIds ?? [])
    const files = wanted.size ? (await resources.list(s.workspaceId)).filter((r) => wanted.has(r.id)) : []

    await replyAsPerson(s.workspaceId, data.id, data.text, s.email, files)
  })

/**
 * Give it back to Arlo, which answers whatever is still outstanding.
 *
 * Separate from setStatus because it is not the same act: closing or taking over changes a
 * label, and this one can put a message in front of a customer.
 */
const handOver = createServerFn({ method: 'POST' })
  // `wake` is the answer to the dialog: yes, switch it back to live and then take this.
  .validator((d: { id: number; wake?: boolean; here?: boolean }) => d)
  .handler(async ({ data }) => handBack((await requireSession()).workspaceId, data.id, { wake: data.wake, here: data.here }))

/**
 * Read this conversation for anything worth teaching, now.
 *
 * The sweep does this on its own once a thread has been quiet a while, but somebody looking at
 * a conversation they have just finished should not have to wait for it.
 *
 * `markRead` is the second half and is not optional: `harvest()` deliberately never stamps the
 * watermark itself, so without it the next sweep tick reads the same window again and proposes
 * every one of these a second time. `fromScratch` re-reads a thread that has already been read,
 * which is what makes this useful on a conversation the sweep got to first.
 */
const learnFrom = createServerFn({ method: 'POST' })
  .validator((d: { id: number; fromScratch?: boolean }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const found = await harvest(s.workspaceId, data.id, { fromScratch: data.fromScratch })
    await markRead(s.workspaceId, data.id)
    return found
  })

/**
 * Take the override off this one thread, and leave the bot wherever it is everywhere else.
 *
 * The other half of `handOver`'s `here`. Without it the override is a one-way door: somebody
 * who turned it on to let the bot answer a single conversation had no way back short of
 * changing the bot's mode for every other conversation it owns.
 */
const stopHere = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => convo.setAnswersLive((await requireSession()).workspaceId, data, false))

/**
 * Forget threads whose connection is gone — an unlinked number, a deleted widget.
 *
 * Run from the Refresh button rather than the loader: the loader is also what the poller
 * calls, and this deletes rows. See channels.tidy(), which is fail-closed per channel.
 */
const tidyInbox = createServerFn({ method: 'POST' })
  .handler(async () => tidy((await requireSession()).workspaceId))

const setStatus = createServerFn({ method: 'POST' })
  .validator((d: { id: number; status: Status }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await convo.setStatus(s.workspaceId, data.id, data.status, data.status === 'human' ? s.email : null)
  })

export const Route = createFileRoute('/inbox')({
  /*
   * The filters live in the URL now, because they decide the query rather than hiding rows
   * that were already fetched. That also makes a filtered inbox linkable, and survives the
   * ten-second poll below — `router.invalidate()` re-runs the loader with the same search, so
   * a refresh cannot bounce somebody back to page one of everything.
   */
  validateSearch: (s: Record<string, unknown>): { id?: number; bot?: number; status?: string; from?: string; find?: string; cold?: boolean; page?: number } => ({
    id: Number(s.id) > 0 ? Number(s.id) : undefined,
    // Which bot answers these. Set by the Messages button on a bot card.
    bot: Number(s.bot) > 0 ? Number(s.bot) : undefined,
    // 'all' is the absent parameter, as everywhere else here.
    status: ['human', 'bot', 'closed'].includes(String(s.status)) ? String(s.status) : undefined,
    // Which kind of account it arrived on. 32 because a connection id is the longest of these.
    from: typeof s.from === 'string' && s.from !== 'all' ? s.from.slice(0, 32) : undefined,
    // Who it is with. 80 is a long name and a long address; past that it is a paste.
    find: typeof s.find === 'string' && s.find.trim() ? s.find.trim().slice(0, 80) : undefined,
    // Only the ones that have gone past the WhatsApp window. Absent rather than false, as
    // every other filter here is, so a cleared chip leaves no trace in the address bar.
    cold: s.cold === true || s.cold === '1' ? true : undefined,
    page: Number(s.page) > 1 ? Math.floor(Number(s.page)) : undefined,
  }),
  loaderDeps: ({ search }) => ({
    id: search.id,
    bot: search.bot,
    status: search.status,
    from: search.from,
    find: search.find,
    cold: search.cold,
    page: search.page ?? 1,
  }),
  loader: ({ deps }) =>
    load({
      data: {
        id: deps.id ?? null,
        bot: deps.bot ?? null,
        status: deps.status ?? null,
        from: deps.from ?? null,
        find: deps.find ?? null,
        cold: deps.cold ?? false,
        page: deps.page - 1,
      },
    }),
  component: Inbox,
})

type Data = Awaited<ReturnType<typeof load>>

/**
 * The training watermark, in a sentence.
 *
 * The count uses the same comparison the server makes, so the line and the harvest cannot
 * disagree about what "since" means.
 */
const readMark = (harvestedAt: string | null, messages: { created_at: string }[]) => {
  if (!harvestedAt) return 'Not read for training yet'
  const cut = new Date(harvestedAt).getTime()
  const since = messages.filter((m) => new Date(m.created_at).getTime() > cut).length
  return `Read for training up to ${when(harvestedAt)}${
    since ? ` · ${since} message${since === 1 ? '' : 's'} since` : ''
  }`
}

/**
 * Where the watermark falls in the transcript itself, not just said in a sentence above it —
 * the id of the first message strictly after `harvestedAt`, so a divider can sit right before
 * it. Same comparison as `readMark`, so the two can never disagree about what's covered.
 *
 * `null` means nothing to mark: never read at all. `'end'` means the opposite — read past
 * every message here — so the divider belongs after the last bubble rather than before one
 * that does not exist.
 */
const watermarkBefore = (harvestedAt: string | null, messages: { id: number; created_at: string }[]) => {
  if (!harvestedAt) return null
  const cut = new Date(harvestedAt).getTime()
  return messages.find((m) => new Date(m.created_at).getTime() > cut)?.id ?? 'end'
}

/** Duplicated verbatim in two other files; not worth a shared module for one expression. */
const size = (n: number) =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

const when = (at: string) => {
  const d = new Date(at)
  const today = new Date().toDateString() === d.toDateString()
  return d.toLocaleString(undefined, today ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * Which connector, and which account of it.
 *
 * A connection that has been removed still has threads, and they say so rather than
 * silently reading as though they arrived on nothing.
 */
const arrivedOn = (on: Data['connections'][number] | undefined, channel: string) =>
  on ? `${CONNECTORS[on.connector as keyof typeof CONNECTORS]?.name ?? on.connector} · ${on.label}` : `${channel} · connection removed`

/** Whoever this is with, however little we know about them. */
const who = (row: { customer_name: string | null; customer_email: string | null; channel_ref: string }) =>
  row.customer_name || row.customer_email || label(row.channel_ref)

/** The channel's own address, minus the connection id in front of it. */
const label = (channelRef: string) => {
  const rest = channelRef.split(':').slice(1).join(':') || channelRef
  return rest.endsWith('@s.whatsapp.net') ? `+${rest.split('@')[0]}` : rest.split('@')[0]
}

/**
 * The status filters, each carrying its own count.
 *
 * The count belongs on the control rather than in a sentence above it: "1 waiting on a
 * person" and a separate button saying "Needs a person" are the same fact printed twice,
 * and the pair of them wrapped into four lines of a narrow column.
 */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'human', label: 'Person' },
  { id: 'bot', label: 'Arlo' },
  { id: 'closed', label: 'Closed' },
] as const

function Inbox() {
  const d = Route.useLoaderData()
  /** connection id → what it is called. Missing means a connection that has been removed. */
  const named = new Map(d.connections.map((c) => [`${c.channel}:${c.connection}`, c]))
  const whichConnection = (channel: string, ref: string) => named.get(`${channel}:${connectionOf(ref)}`)
  const { id } = Route.useSearch()
  const router = useRouter()
  const navigate = useNavigate({ from: '/inbox' })
  const { status: urlStatus, from: urlFrom, find: urlFind = '', cold = false, page = 1 } = Route.useSearch()
  const filter = (urlStatus ?? 'all') as (typeof FILTERS)[number]['id']
  const from = urlFrom ?? 'all'
  const setFrom = (v: string) =>
    void go({ search: (p) => ({ ...p, from: v === 'all' ? undefined : v, page: undefined }) })

  /*
   * One mark per connector actually in use, rather than per channel.
   *
   * WhatsApp and WhatsApp Business are both the `whatsapp` channel and are two different
   * things to whoever is answering — different number, different rules, different window. So
   * the marks follow the connector, which is what the thread rows and their stripes already
   * do, and WhatsApp Business gets its own plum mark beside the green one.
   *
   * Only what is connected, because a filter for a channel this workspace does not have can
   * only ever return nothing.
   */
  const kinds = [...new Map(d.connections.map((c) => [c.connector, c])).values()]
  const go = Route.useNavigate()
  // Changing a filter starts again at the first page — page four of "all" is not page four
  // of "waiting on a person", and landing on an empty page reads as no results.
  const setFilter = (id: string) =>
    void go({ search: (p) => ({ ...p, status: id === 'all' ? undefined : id, page: undefined }) })

  /*
   * Typed here, applied in the URL a beat later.
   *
   * Same arrangement as the contacts box, and for the same reason: the filter runs in SQL,
   * so a navigation per keystroke is a query per keystroke. 250ms is under the gap between
   * words and the box itself never lags, because it is state rather than the URL.
   */
  const [typed, setTyped] = useState(urlFind)
  useEffect(() => {
    if (typed === urlFind) return
    const t = setTimeout(
      () => void go({ search: (p) => ({ ...p, find: typed.trim() || undefined, page: undefined }) }),
      250,
    )
    return () => clearTimeout(t)
  }, [typed, urlFind, go])
  // A back button or a shared link changing the URL under us should show in the box.
  useEffect(() => setTyped(urlFind), [urlFind])

  /** True only while a refresh somebody asked for is in flight, so the button can say so. */
  const [refreshing, setRefreshing] = useState(false)
  const tidyFn = useServerFn(tidyInbox)

  /*
   * Nobody refreshes an inbox by hand. Ten seconds is well under the time it takes to read a
   * thread and reply, and the loader is two indexed queries.
   *
   * Skipped while the tab is hidden, and run once the moment it is shown again. Browsers
   * throttle timers in background tabs — a minute between ticks is normal, longer is
   * allowed — so a plain interval means coming back to a tab and reading an inbox that
   * stopped updating while you were away, which reads as the app being broken rather than
   * as the tab having been asleep. Skipping the hidden ticks also stops a tab left open
   * overnight from spending the night querying.
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'hidden') return
      void router.invalidate()
    }
    const t = setInterval(tick, 10_000)
    const onShow = () => document.visibilityState === 'visible' && void router.invalidate()
    document.addEventListener('visibilitychange', onShow)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [router])

  // Filtered in SQL now, beside the count — so the chips and the list can no longer disagree.
  const rows = d.rows
  const pages = Math.max(1, Math.ceil(d.total / INBOX_PAGE))
  const at = Math.min(Math.max(0, page - 1), pages - 1)

  const counts = {
    all: d.counts.bot + d.counts.human + d.counts.closed,
    human: d.counts.human,
    bot: d.counts.bot,
    closed: d.counts.closed,
  }

  return (
    // Fills the frame: the thread list and the messages scroll, the page never does.
    <div className="fullheight">
      <div className="inboxsplit">
        {/* Everything about *choosing* a conversation lives in this column, so the whole
            of the other one is the conversation itself. */}
        <div className="inboxside">
          {/*
            The refresh is here despite the ten-second poller, and not as a fallback for it.
            Waiting out a countdown you cannot see is the worst part of any inbox — somebody
            who has just replied from their phone wants to watch it land, now, and telling
            them it will appear within ten seconds is not the same as letting them look.
          */}
          <div className="titlerow">
            <h1 style={{ flex: 1, minWidth: 0 }}>Inbox</h1>
            <button
              className="ghost small"
              disabled={refreshing}
              aria-label="Check for new messages"
              /*
               * Refresh also reconciles: threads whose connection no longer exists are
               * deleted before the list is re-read.
               *
               * Here and not in the loader, which the ten-second poller also runs — a
               * destructive sweep six times a minute per open tab is a great deal of chance
               * for one filesystem read to be wrong, and `tidy()` is fail-closed but not
               * free. This is the button somebody presses, so this is where it belongs.
               *
               * Never blocks the refresh: a tidy that fails must still leave you with an
               * up-to-date inbox, which is what was actually asked for.
               */
              onClick={() => {
                setRefreshing(true)
                void tidyFn()
                  .catch(() => {})
                  .then(() => router.invalidate())
                  .finally(() => setRefreshing(false))
              }}
            >
              {refreshing ? 'Checking…' : 'Refresh'}
            </button>
          </div>

          {/*
            Narrowed to one bot, and saying so. A filter that only exists in the address bar
            is one somebody forgets is on and then reads an empty inbox as an outage — so it
            is stated, and the way out of it is next to the statement.
          */}
          {d.filtered && (
            <p className="note botfilter">
              Answered by <strong>{d.filtered}</strong>
              <Link to="/inbox" search={{}}>
                show all
              </Link>
            </p>
          )}

          <div className="filters">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`chip ${filter === f.id ? 'on' : ''}`}
                title={f.id === 'human' ? 'Waiting on a person' : f.id === 'bot' ? 'Arlo is answering' : undefined}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
                <b>{counts[f.id]}</b>
              </button>
            ))}
          </div>

          {/*
            Who it is with. One box for a name and a number, because a person looking for
            Perry's thread and a person looking for the thread on 8852 are doing the same
            thing — and neither of them knows which field the number is filed under.
          */}
          <input
            className="search"
            aria-label="Search conversations"
            placeholder="Search by name or number"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            style={{ marginBottom: 8 }}
          />

          {/*
            Which ones have gone past the WhatsApp window.

            Its own row rather than squeezed in with the status chips, because it is a
            different question — a cold thread can be the bot's, a person's or closed — and
            offered only where it can be true at all. A workspace with no WhatsApp Business
            number has no window to be past, and a chip that always finds nothing is a chip
            that teaches people to ignore the row it is in.
          */}
          {kinds.some((c) => c.connector === 'whatsapp_cloud') && (
            <div className="filters">
              <button
                className={`chip ${cold ? 'on' : ''}`}
                title="Threads whose customer has not written for 24 hours. Only an approved template reaches them until they do."
                onClick={() =>
                  void go({ search: (p) => ({ ...p, cold: cold ? undefined : true, page: undefined }) })
                }
              >
                Past the 24h window
              </button>
            </div>
          )}

          {/* Marks alone: the colours are the connectors, and four words would wrap. */}
          <div className="filters">
            <button className={`chip ${from === 'all' ? 'on' : ''}`} onClick={() => setFrom('all')}>
              All
            </button>
            {kinds.map((c) => {
              const name = CONNECTORS[c.connector as keyof typeof CONNECTORS]?.name ?? c.connector
              return (
                <button
                  key={c.connector}
                  title={name}
                  aria-label={name}
                  className={`chip mark src-${c.connector} ${from === c.connector ? 'on' : ''}`}
                  onClick={() => setFrom(c.connector)}
                >
                  <ChannelIcon source={c.connector} size={14} />
                </button>
              )
            })}
          </div>

          <div className="card">
            <div className="threadlist">
            {rows.map((row) => (
              <button
                key={row.id}
                /* The connector, not the channel: WhatsApp and WhatsApp Business are both
                   `whatsapp` and are answered differently, so the stripe has to tell them
                   apart the same way the mark beside it already does. */
                className={`threadrow src-${whichConnection(row.channel, row.channel_ref)?.connector ?? row.channel} ${row.id === id ? 'on' : ''}`}
                onClick={() => navigate({ search: (prev) => ({ ...prev, id: row.id }) })}
              >
                <span className="chline" style={{ justifyContent: 'space-between' }}>
                  <b className="chline">
                    {/* The connector's own mark, not the channel's: Gmail and Outlook are
                        both "email" and look nothing alike to the person reading this. */}
                    <span
                      className={`src-${whichConnection(row.channel, row.channel_ref)?.connector ?? row.channel}`}
                      title={arrivedOn(whichConnection(row.channel, row.channel_ref), row.channel)}
                    >
                      <ChannelIcon source={whichConnection(row.channel, row.channel_ref)?.connector ?? row.channel} size={13} />
                    </span>
                    {who(row)}
                  </b>
                  <span className="note">{when(row.last_at)}</span>
                </span>
                <span className="note" style={{ display: 'block', marginTop: 2 }}>
                  {row.last_body?.slice(0, 90) ?? 'No messages yet'}
                </span>
                <span className="chline" style={{ marginTop: 6 }}>
                  {row.status !== 'bot' && (
                    <span className={`pill ${row.status === 'human' ? 'warn' : ''}`}>
                      {row.status === 'human' ? `with ${row.assignee ?? 'a person'}` : 'closed'}
                    </span>
                  )}
                  {/*
                    Marked only when it is the exception. A thread inside the window is the
                    normal case and says nothing — a badge on every row is a badge nobody
                    reads, and the one that matters is the one that stops a reply landing.
                  */}
                  {windowOf(whichConnection(row.channel, row.channel_ref)?.connector, row.last_in_at)?.state ===
                    'closed' && (
                    <span className="pill" title="Only an approved template will reach them until they write in again">
                      window closed
                    </span>
                  )}
                </span>
              </button>
            ))}
              {!rows.length && (
                <p className="note" style={{ padding: 16 }}>
                  Nothing here. Questions arrive from whatever is set up on{' '}
                  <a href="/connectors">Connectors</a>.
                </p>
              )}
            </div>
            {/* Inside the card, under the scrolling list: the pane scrolls, the pager does
                not go with it. Hidden entirely on a single page, as everywhere else. */}
            <Pager
              at={at}
              pages={pages}
              setPage={(n) => void go({ search: (p) => ({ ...p, page: n > 0 ? n + 1 : undefined }) })}
            />
          </div>
        </div>

        {d.open ? (
          <Thread
            library={d.library}
            key={d.open.conversation.id}
            open={d.open}
            me={d.me}
            on={whichConnection(d.open.conversation.channel, d.open.conversation.channel_ref)}
          />
        ) : (
          <Empty />
        )}
      </div>
    </div>
  )
}

function Empty() {
  return (
    <div className="card">
      <p className="note" style={{ margin: 0 }}>
        Pick a conversation to read it, see who it is with, and answer.
      </p>
    </div>
  )
}

/**
 * Pick a file to send, or bring one in from this device.
 *
 * Two ways in, one destination. An upload here goes to the same library the Media page and
 * the chatbots read, so answering one customer with a brochure is also how the brochure
 * gets kept — rather than a copy that exists only inside this thread and has to be found on
 * somebody's laptop the next time it is asked for.
 *
 * Ticks rather than a click-to-send list: a reply is often a sentence *and* the document it
 * refers to, so the sheet collects a choice and the composer sends it.
 */
function AttachSheet({
  library,
  picked,
  onToggle,
  onUpload,
  onClose,
}: {
  library: Data['library']
  picked: number[]
  onToggle: (id: number) => void
  onUpload: (file: File) => Promise<void>
  onClose: () => void
}) {
  // An empty library has nothing to show, so start where the person can actually do something.
  const [how, setHow] = useState<'library' | 'device'>(library.length ? 'library' : 'device')
  const [find, setFind] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const needle = find.trim().toLowerCase()
  const matching = needle ? library.filter((r) => r.title.toLowerCase().includes(needle)) : library

  return (
    <dialog className="sheet" ref={(el) => el?.showModal()} onClick={lightDismiss} onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>Attach a file</h3>

      <div className="seg small">
        <button className={how === 'library' ? 'on' : ''} onClick={() => setHow('library')}>
          From Media ({library.length})
        </button>
        <button className={how === 'device' ? 'on' : ''} onClick={() => setHow('device')}>
          Upload from this device
        </button>
      </div>

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      {how === 'library' ? (
        <>
          {library.length > 8 && (
            <input
              className="search"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Search files"
              aria-label="Search files"
            />
          )}
          <div className="picker">
            {matching.map((r) => (
              <label key={r.id} className="pick">
                <input type="checkbox" checked={picked.includes(r.id)} onChange={() => onToggle(r.id)} />
                <span className="mark" aria-hidden="true">
                  {kindOf(r.mime, r.title)}
                </span>
                <span className="what">
                  <strong className="line" title={r.title}>
                    {r.title}
                  </strong>
                  <span className="note line meta">{size(r.size_bytes)}</span>
                </span>
              </label>
            ))}
            {!matching.length && (
              <p className="note" style={{ margin: 0, padding: '14px' }}>
                {library.length
                  ? 'Nothing matching that.'
                  : 'No files yet. Upload one on the other tab — it is kept, so the next person can send it without asking you for it.'}
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="addresource">
          <input
            type="file"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0]
              // Cleared, or choosing the same file twice fires no change event the second time.
              e.target.value = ''
              if (!file) return
              if (file.size > MAX_RESOURCE_MB * 1048576)
                return setErr(`${file.name} is ${size(file.size)} — over the ${MAX_RESOURCE_MB}MB limit`)
              setBusy(true)
              setErr('')
              try {
                await onUpload(file)
                // Back to the list, where it is now ticked: that is the proof it was kept.
                setHow('library')
              } catch (e2) {
                setErr(e2 instanceof Error ? e2.message : String(e2))
              } finally {
                setBusy(false)
              }
            }}
          />
          <p className="note" style={{ marginBottom: 0 }}>
            {busy
              ? 'Uploading…'
              : `Up to ${MAX_RESOURCE_MB}MB. It is added to Media too, so it can be sent again without uploading it twice.`}
          </p>
        </div>
      )}

      <div className="sheetfoot row">
        <button onClick={onClose}>{picked.length ? `Attach ${picked.length}` : 'Done'}</button>
      </div>
    </dialog>
  )
}

function Thread({
  open,
  me,
  on,
  library,
}: {
  open: NonNullable<Data['open']>
  me: string
  on?: Data['connections'][number]
  library: Data['library']
}) {
  const { conversation, customer, identities, files, bot, botMode } = open

  /*
   * Whether a reply typed below will actually go out.
   *
   * Null on every connector but WhatsApp Business — a linked handset has no window, and
   * warning about one that does not exist is worse than saying nothing.
   */
  const win = windowOf(on?.connector, open.lastIn)
  const olderFn = useServerFn(older)
  const upload = useServerFn(attach)

  /** Chosen for this reply, by resource id. Cleared when it sends, like the text is. */
  const [picked, setPicked] = useState<number[]>([])
  const [attaching, setAttaching] = useState(false)

  /*
   * The loader gives the newest window; anything fetched above it is held here.
   *
   * Kept in the component rather than pushed into the URL: how far back somebody has scrolled
   * is not a place worth linking to, and the ten-second poll would have to preserve it. Reset
   * whenever the loader hands over a different newest window, which is what `key` on the
   * conversation id already guarantees — this component is remounted per thread.
   */
  const [earlier, setEarlier] = useState<typeof open.messages>([])
  const [loadingOlder, setLoadingOlder] = useState(false)
  const messages = [...earlier, ...open.messages]
  const hasOlder = open.messageCount > messages.length
  const post = useServerFn(send)
  const mark = useServerFn(setStatus)
  const giveBack = useServerFn(handOver)
  const stopHereFn = useServerFn(stopHere)
  const learn = useServerFn(learnFrom)
  const router = useRouter()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const foot = useRef<HTMLDivElement>(null)
  /*
   * Set when handing back needs a decision first.
   *
   * The bot is not live, and switching it changes what it does on every channel it answers —
   * not only on the thread being looked at. So it is asked once, plainly, rather than done
   * quietly or refused with an error that leaves somebody to go and find a settings page.
   */
  const [wake, setWake] = useState<{ name: string; mode: string } | null>(null)

  /*
   * Open on the newest message, the way every messaging app does.
   *
   * Keyed on the conversation as well as the count, because switching threads keeps the
   * component mounted: two threads with the same number of messages left the second one
   * showing wherever the first had been scrolled to.
   *
   * The scroll runs after paint rather than in the effect body. Attachments, citation lines
   * and wrapped bubbles all settle a frame late, so scrolling immediately aims at a document
   * shorter than the one that ends up on screen and lands short of the bottom — which is
   * exactly the "it does not go to the latest message" people report. `block: 'end'` because
   * the marker is a zero-height div and the default would centre it.
   */
  useEffect(() => {
    const at = requestAnimationFrame(() => foot.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(at)
  }, [conversation.id, messages.length])

  /**
   * Hand the thread back, waking the bot first if that is what it takes.
   *
   * Two round trips at most: the first says whether a decision is needed, the second carries
   * it out. The dialog is only ever shown in answer to something the server actually said,
   * so a bot that is already live never sees one.
   */
  const giveItBack = async (how: { wake?: boolean; here?: boolean } = {}) => {
    setBusy('bot')
    setErr('')
    try {
      const r = await giveBack({ data: { id: conversation.id, ...how } })
      if (r.status === 'asleep' && r.bot) {
        setWake({ name: r.bot.name, mode: r.bot.mode })
        return
      }
      setWake(null)
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  /*
   * One file into the library, then ticked for this reply.
   *
   * Hoisted out of the attach sheet so the paperclip, a paste and a drop all take the same
   * road: a file in a reply is a file the workspace keeps, whichever gesture put it there.
   */
  const keep = async (file: File) => {
    const body = new FormData()
    body.set('file', file)
    const { id } = await upload({ data: body })
    setPicked((p) => (p.includes(id) ? p : [...p, id]))
    // So the new file is in the list behind the sheet, named rather than numbered.
    await router.invalidate()
  }

  /*
   * Pasted or dropped, which for a screenshot is the only gesture anybody actually uses.
   *
   * Uploaded as it lands rather than held: the composer already speaks in resource ids, and
   * a second shape of pending file would mean two ways for a send to carry an attachment.
   */
  const chat = useChatFiles(setErr, (files) =>
    act('attach', async () => {
      for (const file of files) await keep(file)
    }),
  )

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

  // The last word is the customer's, so handing back means answering it rather than
  // waiting for them to write in again.
  const outstanding = messages.at(-1)?.direction === 'in'

  // Only where a bot reads this thread at all, for the same reason the sentence above is.
  const cut = bot ? watermarkBefore(conversation.harvested_at, messages) : null

  const reply = () =>
    act('send', async () => {
      const body = text
      const sending = picked
      setText('')
      setPicked([])
      try {
        await post({ data: { id: conversation.id, text: body, resourceIds: sending } })
      } catch (e) {
        // Put it back rather than losing what somebody typed — the files too, or they would
        // have to be found and picked again to retry a send that failed for its own reasons.
        setText(body)
        setPicked(sending)
        throw e
      }
    })

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="chline">
            <ChannelIcon source={conversation.channel} />
            {/* Straight to the record: whoever is answering usually learns a name or an
                address mid-thread, and the place to put it is one click away. */}
            {customer ? (
              <Link to="/contact/$id" params={{ id: String(customer.id) }}>
                {customer.name || customer.email || label(conversation.channel_ref)}
              </Link>
            ) : (
              label(conversation.channel_ref)
            )}
          </h3>
          {/* Where this arrived: the connector, then the exact account of it. Never just
              "email" — a workspace with a support address and a sales one cannot be
              answered from a line that does not say which one was written to. */}
          <p className="note" style={{ margin: 0 }}>
            {arrivedOn(on, conversation.channel)} · from {label(conversation.channel_ref)}
            {conversation.subject && ` · ${conversation.subject}`}
          </p>
          {/*
            How far this thread has been read for training.

            It lived only in the database until now — `conversations.harvested_at`, the cutoff
            every harvest compares against — so "which half has it read" was a real question
            with a real answer and no way to see it. Said only where it means something: a
            thread no bot learns from is never read at all, and a line about that would be a
            line about nothing.
          */}
          {bot && <p className="note" style={{ margin: 0 }}>{readMark(conversation.harvested_at, messages)}</p>}
        </div>
<span
          className={`pill ${conversation.status === 'human' || (conversation.status === 'bot' && !bot) ? 'warn' : conversation.status === 'bot' ? 'ok' : ''}`}
        >
          {conversation.status === 'closed'
            ? 'closed'
            : conversation.status === 'human'
              ? `with ${conversation.assignee ?? 'a person'}`
              : !bot
                ? 'no chatbot assigned'
                : /*
                   * Said differently on purpose. The bot is not live -- it is answering here
                   * because somebody switched this one thread on, and nothing else about it
                   * has changed. Reading that as "Arlo is answering" is how a test gets
                   * mistaken for a bot that went live weeks ago.
                   */
                  conversation.answers_live && botMode !== 'live'
                  ? `${bot} is answering — this thread only`
                  : `${bot} is answering`}
        </span>
      </div>

      <Customer
        customer={customer}
        identities={identities}
        actions={
          <>
            {/*
              Who owns the thread. Handing back can put a message in front of a customer
              straight away. The two branches are one control — a thread is either a person's
              or the bot's — so they share a slot rather than living in different corners of
              the page.
            */}
            {conversation.status !== 'bot' ? (
              <>
                <span className="note">
                  {!bot
                    ? 'No chatbot answers this connection yet.'
                    : outstanding
                      ? `${bot} answers the last message now.`
                      : `${bot} takes the next message.`}
                </span>
                <button className="ghost small" disabled={!!busy} onClick={() => void giveItBack()}>
                  {busy === 'bot'
                    ? outstanding
                      ? 'Answering…'
                      : 'Handing back…'
                    : `Hand back to ${bot ?? 'the chatbot'}`}
                </button>
              </>
            ) : (
              <>
                {/*
                  Only when it is on, and next to the thing it undoes. Nothing expires this,
                  so the way off has to be where somebody looking at the thread will see it --
                  taking the thread over turns it off too, but that is a heavier act than
                  simply wanting the bot to stop answering here.
                */}
                {conversation.answers_live && botMode !== 'live' && (
                  <button
                    className="ghost small"
                    disabled={!!busy}
                    title={`Stop ${bot ?? 'the chatbot'} answering this conversation and leave it as it is elsewhere`}
                    onClick={() => act('quiet', () => stopHereFn({ data: conversation.id }))}
                  >
                    {busy === 'quiet' ? 'Stopping…' : 'Stop answering here'}
                  </button>
                )}
              <button
                className="ghost small"
                disabled={!!busy}
                onClick={() => act('take', () => mark({ data: { id: conversation.id, status: 'human' } }))}
              >
                {busy === 'take' ? 'Taking over…' : 'Take over'}
              </button>
              </>
            )}
            {/*
              Outside the branch above, because a thread is worth reading for training
              whoever currently owns it — and the one a person has just answered by hand is
              the likeliest of the lot. It sat in the bot's half until now, so the button was
              missing from exactly the conversations somebody had taken over and taught
              something to.

              The sweep reads a thread a few minutes after it goes quiet; this is that same
              read, on demand. It reads from the watermark forwards, so pressing it twice on
              an unchanged thread is honest about finding nothing rather than proposing
              everything again.
            */}
            <button
              className="ghost small"
              disabled={!!busy}
              title="Read this conversation now for anything worth teaching the chatbot"
              onClick={() =>
                act('learn', async () => {
                  const found = await learn({ data: { id: conversation.id } })
                  setErr(
                    found > 0
                      ? `${found} thing${found === 1 ? '' : 's'} to review on the chatbot's Training tab.`
                      : 'Nothing new worth teaching in this conversation.',
                  )
                })
              }
            >
              {busy === 'learn' ? 'Reading…' : 'Read for training'}
            </button>
            {/*
              Only once there is a watermark to get behind.

              The button above reads forwards from it, which is right for the ordinary case
              and leaves no way to re-read a thread the sweep already passed over — the exact
              situation somebody is in when they have just fixed what the bot was told. Shown
              only when it would do something different from the button beside it.
            */}
            {conversation.harvested_at && (
              <button
                className="ghost small"
                disabled={!!busy}
                title="Read the whole conversation again, including what was already read"
                onClick={() =>
                  act('relearn', async () => {
                    const found = await learn({ data: { id: conversation.id, fromScratch: true } })
                    setErr(
                      found > 0
                        ? `${found} thing${found === 1 ? '' : 's'} to review on the chatbot's Training tab.`
                        : 'Nothing worth teaching in this conversation.',
                    )
                  })
                }
              >
                {busy === 'relearn' ? 'Reading…' : 'Read it all again'}
              </button>
            )}
          </>
        }
      />

      <div className="msgs">
        {/* At the top, where the conversation runs out — not a pager, because a transcript
            reads downwards and page numbers in the middle of one are disorienting. */}
        {hasOlder && (
          <div className="row" style={{ justifyContent: 'center', padding: '4px 0 10px' }}>
            <button
              className="ghost small"
              disabled={loadingOlder}
              onClick={async () => {
                const first = messages[0]
                if (!first) return
                setLoadingOlder(true)
                try {
                  const { rows } = await olderFn({
                    data: { id: conversation.id, at: String(first.created_at), before: first.id },
                  })
                  setEarlier((held) => [...rows, ...held])
                } finally {
                  setLoadingOlder(false)
                }
              }}
            >
              {loadingOlder ? 'One moment…' : `Load older · ${open.messageCount - messages.length} before this`}
            </button>
          </div>
        )}
        {messages.map((m) => (
          <Fragment key={m.id}>
            {cut === m.id && <div className="watermark"><span>Read for training up to here</span></div>}
            <div className={`bubble ${m.direction}`}>
              {m.body}
              <small>
                {/*
                  `speaker`, not `author`. The author of a person's reply on a default
                  install is 'arlo' — the account name — which is also BOT_AUTHOR, so every
                  message somebody typed by hand was signed with the bot's name.
                */}
                {m.direction === 'out' ? (m.speaker === 'bot' ? 'Arlo' : (m.author ?? 'you')) : 'them'} ·{' '}
                {when(m.created_at)}
                {m.direction === 'out' && !m.external_id && conversation.channel !== 'web' && ' · not delivered'}
              </small>
              {files
                .filter((f) => f.message_id === m.id)
                .map((f) => (
                  <Attachment key={f.id} file={f} />
                ))}
              {m.cited?.length ? (
                <small>
                  From {m.cited.map((c) => c.title).filter((t, i, all) => all.indexOf(t) === i).join(', ')}
                </small>
              ) : null}
            </div>
          </Fragment>
        ))}
        {/* Read past everything here, so the line belongs after the last bubble rather than
            before one that does not exist. */}
        {cut === 'end' && <div className="watermark"><span>Read for training up to here</span></div>}
        <div ref={foot} />
      </div>

      {err && (
        <p className="err" style={{ marginTop: 12 }}>
          {err}
        </p>
      )}

      {/*
        The composer is the drop and paste target, not the textarea inside it.

        Somebody dragging a screenshot aims at the box they type in, including the space
        around it — and a paste only reaches the textarea if it already has focus, which it
        does not when somebody has just come back from taking a screen grab.
      */}
      <div className={`composer${chat.dragging ? ' dragging' : ''}`} {...chat.bind}>
      <textarea
        value={text}
        /*
          Not disabled when the window has closed, deliberately. The provider's clock counts
          messages that never reached us, so a local reading is a second opinion — good enough
          to warn with, not good enough to refuse a send that would have worked. If the
          provider disagrees it refuses, and the sentence for that is already written.
        */
        placeholder={
          win?.state === 'closed'
            ? 'They have not written for 24 hours — only an approved template will reach them'
            : conversation.status === 'closed'
              ? 'Replying reopens this conversation'
              : `Reply as ${me}`
        }
        style={{ marginTop: 12, minHeight: 72 }}
        onChange={(e) => setText(e.target.value)}
        // Enter sends, Shift+Enter is a newline — what every chat client does, and this is
        // one being typed into all day.
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
            e.preventDefault()
            void reply()
          }
        }}
      />
      {/*
        Only Send down here.

        Who owns the thread acts on the thread rather than on what is being typed, so it sits
        at the top with the banner. Close is gone entirely: it was one tap from Send and all
        it did was take a thread out of the list, the same shape of mistake as the calendar
        chip that deleted a date on click. A thread closed by accident reopens by replying or
        by handing it back.
      */}
      {!!picked.length && (
        <div className="chline" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {picked.map((id) => {
            const file = library.find((r) => r.id === id)
            return (
              <span key={id} className="pill">
                {file?.title ?? 'a file'}
                <button
                  className="chipx"
                  aria-label={`Remove ${file?.title ?? 'file'}`}
                  onClick={() => setPicked((p) => p.filter((x) => x !== id))}
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        {/*
          A file with nothing typed is allowed: the send captions it with its own name, because
          every WhatsApp send puts a text message out first and Meta refuses an empty body.
        */}
        <button disabled={(!text.trim() && !picked.length) || !!busy} onClick={reply}>
          {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
        <button className="ghost" disabled={!!busy} onClick={() => setAttaching(true)}>
          Attach{picked.length ? ` (${picked.length})` : ''}
        </button>
        {busy === 'attach' && <span className="note">Uploading…</span>}
      </div>
      </div>

      {attaching && (
        <AttachSheet
          library={library}
          picked={picked}
          onToggle={(id) =>
            setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
          }
          onUpload={keep}
          onClose={() => setAttaching(false)}
        />
      )}

      {wake && (
        /*
         * A real dialog, not a `window.confirm`.
         *
         * What is being agreed to is bigger than the thread on screen — the bot goes live on
         * every channel it answers — so it gets the room to say that, in the product's own
         * voice, with the consequence above the button rather than after it.
         */
        <dialog className="sheet" ref={(el) => el?.showModal()} onClick={lightDismiss} onClose={() => setWake(null)}>
          <div className="sheetbody">
            <h3 style={{ marginTop: 0 }}>Wake {wake.name} up?</h3>
            <p className="note">
              {wake.name} is {wake.mode === 'learning' ? 'in learning mode' : 'paused'}, so it watches and never
              replies. Handing this thread back will switch it to <strong>Live</strong>.
            </p>
            <p className="note">
              <strong>Just this conversation</strong> answers the last message here and leaves {wake.name}{' '}
              {wake.mode === 'learning' ? 'watching' : 'drafting'} everywhere else — for seeing what it has
              learned without every other customer hearing from it. Replies are real and go to this person.
            </p>
            <p className="note">
              <strong>Set to Live</strong> is the wider change: it will start answering on every channel it is
              connected to. You can set it back on its Identity tab at any time.
            </p>
            <div className="row" style={{ marginTop: 16 }}>
              <button disabled={!!busy} onClick={() => void giveItBack({ here: true })}>
                {busy === 'bot' ? 'Answering…' : 'Answer just this conversation'}
              </button>
              <button className="ghost" disabled={!!busy} onClick={() => void giveItBack({ wake: true })}>
                {busy === 'bot' ? 'Waking…' : `Set to Live and hand back`}
              </button>
              <button className="ghost" disabled={!!busy} onClick={() => setWake(null)}>
                Cancel
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  )
}

/** Who this is, gathered from every channel they have written in on. */
function Customer({
  customer,
  identities,
  actions,
}: {
  customer: NonNullable<Data['open']>['customer']
  identities: NonNullable<Data['open']>['identities']
  /** Taking the thread over and handing it back — kept beside the banner rather than down by
      Send, since neither is about sending a reply and both were getting lost in a row that is. */
  actions: ReactNode
}) {
  // customer_id is never null in the schema; this is only a deleted-row race. The banner
  // has nothing to say then, but the actions still work and still belong up here rather
  // than falling back down to the footer for it.
  if (!customer) return <div className="row">{actions}</div>
  const traits = Object.entries(customer.traits ?? {})

  return (
    <div style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', padding: '10px 0', marginBottom: 12 }}>
      <div className="row">
        <p className="note" style={{ margin: 0 }}>
          {[customer.email, customer.phone && `+${customer.phone}`, `first seen ${when(customer.created_at)}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <span className="grow" />
        {actions}
      </div>
      {identities.length > 1 && (
        <p className="note" style={{ margin: '4px 0 0' }}>
          Also on {identities.map((i) => i.channel).filter((c, i, all) => all.indexOf(c) === i).join(', ')}
        </p>
      )}
      {traits.length > 0 && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          {traits.map(([k, v]) => (
            <span key={k} className="pill">
              {k}: {v}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A file that came with a message.
 *
 * An image is shown, because a photo of a broken part is the whole message and asking
 * somebody to download it to see it is asking them not to look. Everything else is a link
 * with its name and size, which is what a person needs to decide whether to open it.
 *
 * A file we do not hold — over the cap, or a fetch that failed — still appears, greyed and
 * saying so. "They sent a 60MB video we did not keep" is a fact worth having; a blank space
 * reads as though they sent nothing.
 *
 * Opened in a sheet over the thread rather than a new tab. A file in a conversation is read
 * against the conversation — "is this the right invoice" is a question about the messages
 * either side of it — and a tab takes the thread away to answer it.
 */function Attachment({ file }: { file: NonNullable<Data['open']>['files'][number] }) {
  const [peek, setPeek] = useState(false)
  const href = `/api/attachment/${file.id}`

  const sheet = peek && (
    <Peek at={{ title: file.name, href, mime: file.mime }} onClose={() => setPeek(false)} />
  )

  // An image is its own thumbnail. Everything else gets a card: a glyph for what kind of
  // file it is, its name, and its size — enough to decide whether to open it.
  if (file.held && file.mime?.startsWith('image/'))
    return (
      <>
        <button type="button" onClick={() => setPeek(true)} className="file image" title={file.name}>
          <img src={href} alt={file.name} loading="lazy" />
          <small>
            {file.name} · {size(file.size_bytes)}
          </small>
        </button>
        {sheet}
      </>
    )

  const card = (
    <>
      <span className="filekind" aria-hidden="true">
        {kindOf(file.mime, file.name)}
      </span>
      <span className="filewho">
        <b>{file.name}</b>
        <small>{file.held ? size(file.size_bytes) : `${size(file.size_bytes)} · not kept`}</small>
      </span>
    </>
  )

  // Nothing to open when the bytes were never kept — see attachments.ts. The card stays,
  // because "they sent a file we do not hold" is the fact somebody needs.
  return file.held ? (
    <>
      <button type="button" onClick={() => setPeek(true)} className="file card" title={`Open ${file.name}`}>
        {card}
      </button>
      {sheet}
    </>
  ) : (
    <span className="file card gone" title="Too large to keep, or the download failed">
      {card}
    </span>
  )
}

/**
 * Three or four letters that say what a file is.
 *
 * Deliberately not an icon set: a short uppercase extension is legible at any size, needs
 * no assets, and is never wrong about a format nobody anticipated.
 */
function kindOf(mime: string | null, name: string) {
  const ext = name.includes('.') ? name.split('.').pop()!.slice(0, 4).toUpperCase() : ''
  if (ext) return ext
  if (!mime) return 'FILE'
  if (mime.startsWith('image/')) return 'IMG'
  if (mime.startsWith('video/')) return 'VID'
  if (mime.startsWith('audio/')) return 'AUD'
  if (mime.includes('pdf')) return 'PDF'
  return 'FILE'
}
