import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import { handBack } from '../server/agent'
import * as bots from '../server/bot'
import { connections, replyAsPerson, tidy } from '../server/channels'
import * as convo from '../server/conversations'
import * as attachments from '../server/attachments'
import * as customers from '../server/customers'
import { ChannelIcon } from '../components/ChannelIcon'
import { BOT_AUTHOR, CHANNEL_IDS, CONNECTORS, connectionOf } from '../types'
import type { Status } from '../types'
import { lightDismiss } from '../components/Modal'

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
  .validator((d: { id: number | null; bot: number | null }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    return {
      me: s.email,
      rows: await convo.inbox(s.workspaceId, undefined, data.bot ?? undefined),
      // Named, so the filter reads as a bot rather than as a number in the address bar.
      filtered: data.bot ? ((await bots.get(s.workspaceId, data.bot))?.name ?? null) : null,
      counts: await convo.counts(s.workspaceId, data.bot ?? undefined),
      // Which bot, which number, which mailbox: a thread reference carries the connection
      // id, and this is what turns it into something a person can read.
      connections: await connections(s.workspaceId),
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
     * Which bot answers here, if any. A thread marked as the bot's on a connection no bot
     * is assigned to is a thread nothing is watching, and saying "Arlo is answering" over
     * it is the one thing the page must not do.
     */
    bot: (await bots.routeTo(workspaceId, conversation.channel, bots.connectionOf(conversation.channel_ref)))?.name ?? null,
    identities: await customers.identitiesOf(workspaceId, conversation.customer_id),
    messages,
    // One query for the whole thread rather than one per message.
    files: await attachments.forMessages(workspaceId, messages.map((m) => m.id)),
  }
}

/**
 * Answer as a person.
 *
 * Sending takes the thread over: a bot that keeps talking underneath a human is the worst
 * failure this product has, and somebody typing a reply has plainly decided to own it.
 * Handing it back is one button away.
 */
const send = createServerFn({ method: 'POST' })
  .validator((d: { id: number; text: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await replyAsPerson(s.workspaceId, data.id, data.text, s.email)
  })

/**
 * Give it back to Arlo, which answers whatever is still outstanding.
 *
 * Separate from setStatus because it is not the same act: closing or taking over changes a
 * label, and this one can put a message in front of a customer.
 */
const handOver = createServerFn({ method: 'POST' })
  // `wake` is the answer to the dialog: yes, switch it back to live and then take this.
  .validator((d: { id: number; wake?: boolean }) => d)
  .handler(async ({ data }) => handBack((await requireSession()).workspaceId, data.id, data.wake ?? false))

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
  validateSearch: (s: Record<string, unknown>): { id?: number; bot?: number } => ({
    id: Number(s.id) > 0 ? Number(s.id) : undefined,
    // Which bot answers these. Set by the Messages button on a bot card.
    bot: Number(s.bot) > 0 ? Number(s.bot) : undefined,
  }),
  loaderDeps: ({ search }) => ({ id: search.id, bot: search.bot }),
  loader: ({ deps }) => load({ data: { id: deps.id ?? null, bot: deps.bot ?? null } }),
  component: Inbox,
})

type Data = Awaited<ReturnType<typeof load>>

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
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all')
  const [channel, setChannel] = useState<string>('all')

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

  const rows = d.rows.filter(
    (r) => (filter === 'all' || r.status === filter) && (channel === 'all' || r.channel === channel),
  )

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

          {/* Marks alone: the colours are the channels, and four words would wrap. */}
          <div className="filters">
            <button className={`chip ${channel === 'all' ? 'on' : ''}`} onClick={() => setChannel('all')}>
              All
            </button>
            {CHANNEL_IDS.map((c) => (
              <button
                key={c}
                title={c}
                aria-label={c}
                className={`chip mark src-${c} ${channel === c ? 'on' : ''}`}
                onClick={() => setChannel(c)}
              >
                <ChannelIcon source={c} size={14} />
              </button>
            ))}
          </div>

          <div className="card">
            <div className="threadlist">
            {rows.map((row) => (
              <button
                key={row.id}
                className={`threadrow src-${row.channel} ${row.id === id ? 'on' : ''}`}
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
                {row.status !== 'bot' && (
                  <span className={`pill ${row.status === 'human' ? 'warn' : ''}`} style={{ marginTop: 6 }}>
                    {row.status === 'human' ? `with ${row.assignee ?? 'a person'}` : 'closed'}
                  </span>
                )}
              </button>
            ))}
              {!rows.length && (
                <p className="note" style={{ padding: 16 }}>
                  Nothing here. Questions arrive from whatever is set up on{' '}
                  <a href="/connectors">Connectors</a>.
                </p>
              )}
            </div>
          </div>
        </div>

        {d.open ? (
          <Thread
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

function Thread({ open, me, on }: { open: NonNullable<Data['open']>; me: string; on?: Data['connections'][number] }) {
  const { conversation, customer, identities, messages, files, bot } = open
  const post = useServerFn(send)
  const mark = useServerFn(setStatus)
  const giveBack = useServerFn(handOver)
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
  const giveItBack = async (force = false) => {
    setBusy('bot')
    setErr('')
    try {
      const r = await giveBack({ data: { id: conversation.id, wake: force } })
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

  const reply = () =>
    act('send', async () => {
      const body = text
      setText('')
      try {
        await post({ data: { id: conversation.id, text: body } })
      } catch (e) {
        // Put it back rather than losing what somebody typed.
        setText(body)
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
        </div>
<span
          className={`pill ${conversation.status === 'human' || (conversation.status === 'bot' && !bot) ? 'warn' : conversation.status === 'bot' ? 'ok' : ''}`}
        >
          {conversation.status === 'closed'
            ? 'closed'
            : conversation.status === 'human'
              ? `with ${conversation.assignee ?? 'a person'}`
              : bot
                ? `${bot} is answering`
                : 'no chatbot assigned'}
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
              <button
                className="ghost small"
                disabled={!!busy}
                onClick={() => act('take', () => mark({ data: { id: conversation.id, status: 'human' } }))}
              >
                {busy === 'take' ? 'Taking over…' : 'Take over'}
              </button>
            )}
          </>
        }
      />

      <div className="msgs">
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.direction}`}>
            {m.body}
            <small>
              {m.direction === 'out' ? (m.author === BOT_AUTHOR ? 'Arlo' : (m.author ?? 'you')) : 'them'} ·{' '}
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
        ))}
        <div ref={foot} />
      </div>

      {err && (
        <p className="err" style={{ marginTop: 12 }}>
          {err}
        </p>
      )}

      <textarea
        value={text}
        placeholder={conversation.status === 'closed' ? 'Replying reopens this conversation' : `Reply as ${me}`}
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
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={!text.trim() || !!busy} onClick={reply}>
          {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
      </div>

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
              It will answer the last message here, and it will start answering on every channel it is
              connected to — not only this conversation. You can set it back on its Identity tab at any time.
            </p>
            <div className="row" style={{ marginTop: 16 }}>
              <button disabled={!!busy} onClick={() => void giveItBack(true)}>
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
 */function Attachment({ file }: { file: NonNullable<Data['open']>['files'][number] }) {
  const href = `/api/attachment/${file.id}`
  const size =
    file.size_bytes >= 1048576
      ? `${(file.size_bytes / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(file.size_bytes / 1024))} KB`

  // An image is its own thumbnail. Everything else gets a card: a glyph for what kind of
  // file it is, its name, and its size — enough to decide whether to open it.
  if (file.held && file.mime?.startsWith('image/'))
    return (
      <a href={href} target="_blank" rel="noreferrer" className="file image" title={file.name}>
        <img src={href} alt={file.name} loading="lazy" />
        <small>
          {file.name} · {size}
        </small>
      </a>
    )

  const card = (
    <>
      <span className="filekind" aria-hidden="true">
        {kindOf(file.mime, file.name)}
      </span>
      <span className="filewho">
        <b>{file.name}</b>
        <small>{file.held ? size : `${size} · not kept`}</small>
      </span>
    </>
  )

  // Nothing to open when the bytes were never kept — see attachments.ts. The card stays,
  // because "they sent a file we do not hold" is the fact somebody needs.
  return file.held ? (
    <a href={href} target="_blank" rel="noreferrer" className="file card" title={`Open ${file.name}`}>
      {card}
    </a>
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
