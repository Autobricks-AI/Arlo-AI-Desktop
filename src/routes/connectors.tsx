import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { providerSettings, requireSession } from '../server/auth'
import * as email from '../server/channels/email'
import * as telegram from '../server/channels/telegram'
import * as whatsapp from '../server/channels/whatsapp'
import * as web from '../server/channels/web'
import { stats } from '../server/channels'
import { taken } from '../server/bot'
import { available as modelAvailable, catalogue as modelCatalogue } from '../server/llm'
import { CONNECTORS, EMAIL_IDS } from '../types'
import type { ConnectorId, EmailId } from '../types'
import { ChannelIcon } from '../components/ChannelIcon'
import { MailboxModal } from '../components/MailboxModal'
import { TelegramConfig } from '../components/TelegramConfig'
import { TelegramModal } from '../components/TelegramModal'
import { WebWidgetModal } from '../components/WebWidgetModal'
import { ConfirmRemove } from '../components/ConfirmRemove'
import { WhatsAppModal } from '../components/WhatsAppModal'

/**
 * The address this instance is reachable at, which webhooks, OAuth redirects and the
 * widget snippet all need.
 *
 * The loopback fallback is only right for a laptop. Set PUBLIC_URL to whatever the outside
 * world types — behind a proxy, that is never what this process sees.
 */
const publicBase = () => (process.env.PUBLIC_URL || 'http://127.0.0.1:9005').replace(/\/+$/, '')

const load = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await requireSession()
  return {
    base: publicBase(),
    widgets: await web.list(s.workspaceId),
    telegram: await telegram.list(s.workspaceId),
    whatsapp: whatsapp.list(s.workspaceId),
    mailboxes: await email.list(s.workspaceId),
    stats: await stats(s.workspaceId),
    // Which connections a chatbot actually answers on. Nothing answers a connection that
    // is not assigned to one, so a row that says nothing about it is a row that looks
    // connected and is silent.
    answering: await taken(s.workspaceId),
    // Shown rather than hidden: a provider the operator has not set up should say so, not
    // present a button that fails after three clicks.
    configured: Object.fromEntries(email.PROVIDERS.map((p) => [p, email.configured(p)])) as Record<
      EmailId,
      boolean
    >,
    // The model this workspace will actually use, asked of the same resolver the calls go
    // through — a stat read from anywhere else is one that can be confidently wrong.
    model: (await modelAvailable(s.workspaceId)) ? (await modelCatalogue(s.workspaceId)).fallback : null,
  }
})

// ---------------------------------------------------------------- web chat

const addWidget = createServerFn({ method: 'POST' })
  .validator((label: string) => label)
  .handler(async ({ data }) => web.add((await requireSession()).workspaceId, data))

const dropWidget = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => web.remove((await requireSession()).workspaceId, data))

// ---------------------------------------------------------------- telegram

const addBot = createServerFn({ method: 'POST' })
  .validator((d: { label: string; token: string }) => d)
  .handler(async ({ data }) => telegram.add((await requireSession()).workspaceId, { ...data, base: publicBase() }))

const dropBot = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => telegram.remove((await requireSession()).workspaceId, data))

const retryBot = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => telegram.retry((await requireSession()).workspaceId, data, publicBase()))

const allowSender = createServerFn({ method: 'POST' })
  .validator((d: { botId: string; sender: string; on: boolean }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    return data.on
      ? telegram.allow(s.workspaceId, data.botId, data.sender)
      : telegram.revoke(s.workspaceId, data.botId, data.sender)
  })

const setBotOpen = createServerFn({ method: 'POST' })
  .validator((d: { botId: string; open: boolean }) => d)
  .handler(async ({ data }) => telegram.setOpen((await requireSession()).workspaceId, data.botId, data.open))

// ---------------------------------------------------------------- whatsapp

const linkWhatsapp = createServerFn({ method: 'POST' })
  .validator((label: string) => label)
  .handler(async ({ data }) => whatsapp.add((await requireSession()).workspaceId, data))

const reopenWhatsapp = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => whatsapp.restart((await requireSession()).workspaceId, data))

/** Polled while a code is on screen: the scan happens on the phone, not in this tab. */
const pollWhatsapp = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => whatsapp.get((await requireSession()).workspaceId, data) ?? null)

const unlinkWhatsapp = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => whatsapp.remove((await requireSession()).workspaceId, data))

// ---------------------------------------------------------------- mailboxes

const connectMailbox = createServerFn({ method: 'POST' })
  .validator((provider: EmailId) => provider)
  .handler(async ({ data }) => email.authUrl((await requireSession()).workspaceId, data, publicBase()))

const dropMailbox = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => email.disconnect((await requireSession()).workspaceId, data))

const syncMailbox = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(async ({ data }) => email.syncNow((await requireSession()).workspaceId, data))

const setSince = createServerFn({ method: 'POST' })
  .validator((d: { id: string; since: string }) => d)
  .handler(async ({ data }) => email.setSince((await requireSession()).workspaceId, data.id, data.since))

export const Route = createFileRoute('/connectors')({
  validateSearch: (s: Record<string, unknown>): { connected?: string; error?: string } => ({
    connected: typeof s.connected === 'string' ? s.connected : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
  }),
  loader: () => load(),
  component: Connectors,
})

type Data = Awaited<ReturnType<typeof load>>
type Stat = { threads: number; last_at: string } | undefined
type StatOf = (channel: string, id: string) => Stat

/** A timestamp as somebody reads it, in the browser's own zone — which is the one they are in. */
const when = (at: string | null) =>
  at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''

/** The one line every connection row ends with: how much came through it, and when last. */
const traffic = (stat: Stat) =>
  stat ? `${stat.threads} conversation${stat.threads === 1 ? '' : 's'} · last ${when(stat.last_at)}` : 'Nothing asked here yet'

/**
 * Who answers here, said on every row.
 *
 * A connection with no chatbot still receives — it files everything and waits for a person
 * — and that is worth a line, because "connected" and "answered" are two different things
 * and only one of them is visible from a green dot.
 */
function Answering({ data, channel, id }: { data: Data; channel: string; id: string }) {
  const bot = data.answering.find((a) => a.channel === channel && a.connection_ref === id)
  return (
    <p className={bot ? 'note' : 'warn'} style={{ margin: 0 }}>
      {bot ? (
        `Answered by ${bot.bot_name}`
      ) : (
        <>
          No chatbot — questions wait for a person. <Link to="/chatbots">Assign one ›</Link>
        </>
      )}
    </p>
  )
}

function Connectors() {
  const d = Route.useLoaderData()
  const { connected, error } = Route.useSearch()

  const total = d.stats.reduce((sum, s) => sum + s.threads, 0)
  const live = d.widgets.length + d.telegram.length + d.whatsapp.length + d.mailboxes.length

  /** Threads and last activity for one connector, summed over its connections. */
  const statFor = (channel: string, ids: string[]): Stat => {
    const rows = d.stats.filter((s) => s.channel === channel && ids.includes(s.connection))
    if (!rows.length) return undefined
    return {
      threads: rows.reduce((sum, r) => sum + r.threads, 0),
      last_at: rows.map((r) => r.last_at).sort().at(-1)!,
    }
  }
  const statOf: StatOf = (channel, id) => statFor(channel, [id])

  const mailboxesOf = (provider: EmailId) => d.mailboxes.filter((m) => m.provider === provider)

  return (
    <>
      <h1>Connectors</h1>
      <p className="lede">
        Where questions arrive from, and where replies go back. Credentials are stored encrypted and never
        rendered back to this page.
      </p>

      {connected && (
        <div className="card banner" style={{ marginBottom: 8 }}>
          <b>{connected}</b> Questions from it are answered from the next check.
        </div>
      )}
      {error && (
        <div className="card banner bad" style={{ marginBottom: 8 }}>
          <b>Connection failed.</b> <span className="err">{error}</span>
        </div>
      )}

      <div className="grid" style={{ marginBottom: 8 }}>
        <div className="card stat">
          <small>Conversations received</small>
          {total}
        </div>
        <div className="card stat">
          <small>Connections live</small>
          {live}
        </div>
        <div className="card stat" style={{ fontSize: 20 }}>
          <small>Model</small>
          {d.model ? 'Answering' : 'No model'}
          <span className="cap">
            {d.model ?? 'Add your Autobricks key in Settings, or every question goes to a person'}
          </span>
        </div>
      </div>

      <h2>Inbound channels</h2>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <Card
          id="web"
          live={d.widgets.length > 0}
          state={d.widgets.length ? 'connected' : 'ready'}
          stat={statFor(
            'web',
            d.widgets.map((w) => w.id),
          )}
        >
          <WebWidgets data={d} statOf={statOf} />
        </Card>

        <Card
          id="telegram"
          live={d.telegram.length > 0}
          state={d.telegram.length ? 'connected' : 'ready'}
          stat={statFor(
            'telegram',
            d.telegram.map((b) => b.id),
          )}
        >
          <Bots data={d} statOf={statOf} />
        </Card>

        <Card
          id="whatsapp"
          live={d.whatsapp.some((a) => a.status === 'online')}
          state={d.whatsapp.length ? 'connected' : 'ready'}
          stat={statFor(
            'whatsapp',
            d.whatsapp.map((a) => a.id),
          )}
        >
          <Numbers data={d} statOf={statOf} />
        </Card>

        {EMAIL_IDS.map((provider) => (
          <Card
            key={provider}
            id={provider}
            live={mailboxesOf(provider).length > 0}
            state={mailboxesOf(provider).length ? 'connected' : d.configured[provider] ? 'ready' : 'not set up'}
            stat={statFor(
              'email',
              mailboxesOf(provider).map((m) => m.id),
            )}
          >
            <Mailboxes
              data={d}
              provider={provider}
              boxes={mailboxesOf(provider)}
              ready={d.configured[provider]}
              statOf={statOf}
            />
          </Card>
        ))}
      </div>
    </>
  )
}

/**
 * The frame every connector shares: what it is, whether anything is live on it, and how
 * much has come through. What varies — a list of bots, of numbers, of mailboxes — is the
 * panel inside.
 */
function Card({
  id,
  live,
  state,
  stat,
  children,
}: {
  id: ConnectorId
  live: boolean
  state: 'connected' | 'ready' | 'not set up'
  stat: Stat
  children: React.ReactNode
}) {
  const meta = CONNECTORS[id]
  return (
    <div className={`card src-${id}`}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span className={`dot ${live ? 'on' : 'off'}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="chline">
            <ChannelIcon source={id} />
            {meta.name}
          </h3>
          <p className="note" style={{ margin: 0 }}>
            {meta.blurb}
          </p>
        </div>
        <span className="flag">{state}</span>
      </div>

      {children}

      <p className="note" style={{ marginTop: 14, marginBottom: 0 }}>
        {stat
          ? `${stat.threads} conversation${stat.threads === 1 ? '' : 's'} received · last ${when(stat.last_at)}. `
          : 'Nothing received through this connector yet. '}
        {meta.docs && (
          <a href={meta.docs} target="_blank" rel="noreferrer">
            Where to get these ›
          </a>
        )}
      </p>
    </div>
  )
}

/** Every panel below shares this: run something, say what went wrong, reload the page. */
function useAct() {
  const router = useRouter()
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
  return { busy, err, act, router }
}

/**
 * One snippet per site, not one per workspace.
 *
 * A brand site, a docs portal and a staging copy are three places with three different
 * audiences. Each having its own tag is what makes one revocable on its own, and what says
 * which site a question came from once it is in the inbox.
 */
function WebWidgets({ data, statOf }: { data: Data; statOf: StatOf }) {
  const add = useServerFn(addWidget)
  const drop = useServerFn(dropWidget)
  const { busy, err, act, router } = useAct()
  const [open, setOpen] = useState(false)
  /** The widget whose removal is being confirmed. Removing one deletes its chats. */
  const [removing, setRemoving] = useState<Data['widgets'][number] | null>(null)

  return (
    <div style={{ marginTop: 16 }}>
      {data.widgets.map((w) => {
        const snippet = `<script src="${data.base}/api/widget.js?key=${w.key}" defer></script>`
        return (
          <div key={w.id} className="acctrow">
            <span className="dot on" />
            <div className="acctwho">
              <h3 style={{ marginBottom: 0 }}>{w.label}</h3>
              <p className="note" style={{ margin: 0 }}>
                {traffic(statOf('web', w.id))}
              </p>
              <Answering data={data} channel="web" id={w.id} />
              <p className="note" style={{ margin: 0 }}>
                <code>{snippet}</code>
              </p>
            </div>
            <div className="acctactions">
              <button className="ghost" onClick={() => navigator.clipboard?.writeText(snippet)}>
                Copy tag
              </button>
              <button className="danger" disabled={!!busy} onClick={() => setRemoving(w)}>
                {busy === w.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        )
      })}

      <div className="row" style={{ marginTop: data.widgets.length ? 12 : 0 }}>
        <button onClick={() => setOpen(true)}>{data.widgets.length ? 'Add another site' : 'Add a site'}</button>
        <span className="note">
          {data.widgets.length ? 'Every site files into the same inbox.' : 'One tag, no build step on your site.'}
        </span>
      </div>

      {err && (
        <p className="err" style={{ marginBottom: 0 }}>
          {err}
        </p>
      )}

      {open && (
        <WebWidgetModal
          base={data.base}
          add={(label) => add({ data: label })}
          onClose={async () => {
            setOpen(false)
            await router.invalidate()
          }}
        />
      )}

      {removing && (
        <ConfirmRemove
          title={`Remove ${removing.label}?`}
          note="The snippet stops answering wherever it is installed."
          takes="Every chat that came through this widget goes, with its messages. Its key stops resolving, so those threads cannot be answered or reopened."
          confirmLabel={`Remove ${removing.label}`}
          busy={busy === removing.id}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id
            void act(id, () => drop({ data: id })).then(() => setRemoving(null))
          }}
        />
      )}
    </div>
  )
}

/**
 * The connected bots and who is allowed to reach each one.
 *
 * A bot handle is public, so the allow list is the security boundary — the row leads with
 * it. Senders the bot turned away are one click from being let in inside the config
 * dialog, which is also the only practical way to learn your own numeric Telegram id.
 */
function Bots({ data, statOf }: { data: Data; statOf: StatOf }) {
  const add = useServerFn(addBot)
  const drop = useServerFn(dropBot)
  const retry = useServerFn(retryBot)
  const allow = useServerFn(allowSender)
  // Named for the call, not the column: `open` above is already this component's add-form state.
  const reach = useServerFn(setBotOpen)
  const { busy, err, act, router } = useAct()
  const [open, setOpen] = useState(false)
  const [configuring, setConfiguring] = useState<Data['telegram'][number] | null>(null)
  /** The bot whose removal is being confirmed. Removing one deletes the messages it received. */
  const [removing, setRemoving] = useState<Data['telegram'][number] | null>(null)

  const close = async () => {
    setOpen(false)
    setConfiguring(null)
    await router.invalidate()
  }

  return (
    <div style={{ marginTop: 16 }}>
      {data.telegram.map((b) => (
        <div key={b.id} className="acctrow">
          <span className={`dot ${b.open || b.allowed.length ? 'on' : 'off'}`} />
          <div className="acctwho">
            <h3 style={{ marginBottom: 0 }}>{b.label}</h3>
            <p className="note" style={{ margin: 0 }}>
              {b.username ? `@${b.username}` : 'Handle unknown'} ·{' '}
              {b.open
                ? 'open to anyone'
                : b.allowed.length
                  ? `${b.allowed.length} allowed sender${b.allowed.length === 1 ? '' : 's'}`
                  : 'nobody allowed yet — it answers nothing'}
              {/* Nobody is waiting to be let in when the door is not shut. */}
              {!b.open && b.pending.length > 0 && ` · ${b.pending.length} waiting to be let in`}
            </p>
            <p className="note" style={{ margin: 0 }}>
              {traffic(statOf('telegram', b.id))}
              {/*
                Which direction this bot receives from, said only when it is the unusual one.
                A webhook is the default and needs no explanation; polling looks like a
                missing webhook unless the page says it is a choice.
              */}
              {b.mode === 'polling' && ' · fetched by polling, no public address needed'}
            </p>
            <Answering data={data} channel="telegram" id={b.id} />
            {b.last_error && (
              <p className="err" style={{ margin: 0 }}>
                {b.last_error}
              </p>
            )}
          </div>
          <div className="acctactions">
            <button className="ghost" onClick={() => setConfiguring(b)}>
              Config
            </button>
            {b.last_error && (
              <button
                className="ghost"
                disabled={!!busy}
                onClick={() => act(`retry-${b.id}`, () => retry({ data: b.id }))}
              >
                {/* Not "retry webhook": this now falls back to polling when a webhook will
                    not register, so what it retries is receiving, not one transport. */}
                {busy === `retry-${b.id}` ? 'Retrying…' : 'Reconnect'}
              </button>
            )}
            <button className="danger" disabled={!!busy} onClick={() => setRemoving(b)}>
              {busy === b.id ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ))}

      <div className="row" style={{ marginTop: data.telegram.length ? 12 : 0 }}>
        <button onClick={() => setOpen(true)}>
          {data.telegram.length ? 'Connect another bot' : 'Connect a bot'}
        </button>
        <span className="note">Every bot files into the same inbox.</span>
      </div>

      {err && (
        <p className="err" style={{ marginBottom: 0 }}>
          {err}
        </p>
      )}

      {open && <TelegramModal add={(arg) => add({ data: arg })} onClose={close} />}
      {configuring && (
        <TelegramConfig
          bot={configuring}
          allow={(arg) => allow({ data: arg })}
          setOpen={(arg) => reach({ data: arg })}
          onClose={close}
        />
      )}

      {removing && (
        <ConfirmRemove
          title={`Remove ${removing.label}?`}
          note="The webhook is deleted, so Telegram stops delivering to this bot."
          takes="Every conversation this bot received goes, with its messages. Nothing can reply to them once the token is disconnected."
          confirmLabel={`Remove ${removing.label}`}
          busy={busy === removing.id}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id
            void act(id, () => drop({ data: id })).then(() => setRemoving(null))
          }}
        />
      )}
    </div>
  )
}

/** The linked numbers, and the way to add another. Linking happens in a dialog. */
function Numbers({ data, statOf }: { data: Data; statOf: StatOf }) {
  const link = useServerFn(linkWhatsapp)
  const reopen = useServerFn(reopenWhatsapp)
  const poll = useServerFn(pollWhatsapp)
  const unlink = useServerFn(unlinkWhatsapp)
  const { busy, err, act, router } = useAct()

  // null = closed, {} = link a new number, {existing} = reopen a dropped one.
  const [modal, setModal] = useState<{ existing?: Data['whatsapp'][number] } | null>(null)

  /*
   * Which number is being unlinked, while the warning is up.
   *
   * A window.confirm was here and is not enough for this one. Unlinking deletes the number's
   * conversations, and the part somebody needs to read — that approved training survives it —
   * is a distinction a single line of unstyled system text is bad at making. It is also the
   * one dialog in this app where the reassuring half matters as much as the warning.
   */
  const [unlinking, setUnlinking] = useState<Data['whatsapp'][number] | null>(null)

  const close = async () => {
    setModal(null)
    await router.invalidate()
  }

  return (
    <div style={{ marginTop: 16 }}>
      {data.whatsapp.map((a) => (
        <div key={a.id} className="acctrow">
          <span className={`dot ${a.status === 'online' ? 'on' : 'off'}`} />
          <div className="acctwho">
            <h3 style={{ marginBottom: 0 }}>{a.label}</h3>
            <p className="note" style={{ margin: 0 }}>
              {a.phone ? `+${a.phone}` : 'Number unknown until it connects'}
              {a.status === 'online' ? ' · online' : a.status === 'qr' ? ' · waiting for a scan' : ' · offline'}
            </p>
            <p className="note" style={{ margin: 0 }}>
              Every chat on this number arrives in the <Link to="/inbox">inbox</Link>
            </p>
            {/* What the socket last did with a message. A dropped one used to leave no
                trace at all, which is indistinguishable from a number nobody wrote to. */}
            {a.last_seen && (
              <p className={a.last_drop ? 'warn' : 'note'} style={{ margin: 0 }}>
                Last message {when(a.last_seen)}
                {a.last_drop ? ` · ${a.last_drop.replace(/^dropped: /, 'not filed — ')}` : ' · filed'}
              </p>
            )}
            <p className="note" style={{ margin: 0 }}>
              {traffic(statOf('whatsapp', a.id))}
            </p>
            <Answering data={data} channel="whatsapp" id={a.id} />
            {a.error && (
              <p className="err" style={{ margin: 0 }}>
                {a.error}
              </p>
            )}
          </div>
          <div className="acctactions">
            {a.status !== 'online' && (
              <button className="ghost" onClick={() => setModal({ existing: a })}>
                {a.status === 'qr' ? 'Show QR' : 'Reconnect'}
              </button>
            )}
            {/*
              Asked for, because unlinking is no longer only about the socket: the threads
              that arrived on this number go with it. They have to — a conversation carries
              the account id it arrived on, and that id is minted per link, so re-linking the
              same phone leaves every old thread pointing at a connection that no longer
              exists. Unanswerable, unreachable, and previously still sitting in the inbox.
            */}
            <button className="danger" disabled={!!busy} onClick={() => setUnlinking(a)}>
              {busy === a.id ? 'Unlinking…' : 'Unlink'}
            </button>
          </div>
        </div>
      ))}

      <div className="row" style={{ marginTop: data.whatsapp.length ? 12 : 0 }}>
        <button onClick={() => setModal({})}>
          {data.whatsapp.length ? 'Link another number' : 'Link a WhatsApp number'}
        </button>
        <span className="note">Links your own WhatsApp, no Business API needed.</span>
      </div>

      {err && (
        <p className="err" style={{ marginBottom: 0 }}>
          {err}
        </p>
      )}

      {modal && (
        <WhatsAppModal
          existing={modal.existing}
          open={(label) => link({ data: label })}
          reopen={(id) => reopen({ data: id })}
          poll={(id) => poll({ data: id })}
          onClose={close}
        />
      )}

      {unlinking && (
        <ConfirmRemove
          title={`Unlink ${unlinking.label}?`}
          note="The socket closes and this number stops reaching the inbox."
          takes="Every thread that arrived on this number goes, with its messages. They belong to this link — once it is gone they cannot be answered or reached again."
          confirmLabel={`Unlink ${unlinking.label}`}
          busy={busy === unlinking.id}
          onClose={() => setUnlinking(null)}
          onConfirm={() => {
            const id = unlinking.id
            void act(id, () => unlink({ data: id })).then(() => setUnlinking(null))
          }}
        />
      )}
    </div>
  )
}

/**
 * The connected mailboxes, and the way to add another.
 *
 * Consent is what links one, so "connect another" is the same button as "connect the
 * first" — pick a different account on the provider's screen and it lands here as a new
 * row. Coming back with an address that is already listed repairs that row instead.
 */
function Mailboxes({
  data,
  provider,
  boxes,
  ready,
  statOf,
}: {
  data: Data
  provider: EmailId
  boxes: Data['mailboxes']
  ready: boolean
  statOf: StatOf
}) {
  const connect = useServerFn(connectMailbox)
  const drop = useServerFn(dropMailbox)
  const sync = useServerFn(syncMailbox)
  const since = useServerFn(setSince)
  const { busy, err, act, router } = useAct()
  const [configuring, setConfiguring] = useState<Data['mailboxes'][number] | null>(null)
  /** The mailbox whose disconnection is being confirmed. It takes its threads with it. */
  const [removing, setRemoving] = useState<Data['mailboxes'][number] | null>(null)

  return (
    <div style={{ marginTop: 16 }}>
      {boxes.map((m) => (
        <div key={m.id} className="acctrow">
          <span className={`dot ${m.last_error ? 'off' : 'on'}`} />
          <div className="acctwho">
            <h3 style={{ marginBottom: 0 }}>{m.address}</h3>
            <p className="note" style={{ margin: 0 }}>
              {traffic(statOf('email', m.id))}
            </p>
            <Answering data={data} channel="email" id={m.id} />
            <p className="note" style={{ margin: 0 }}>
              {m.last_sync ? `Last checked ${when(m.last_sync)}` : 'Never checked'}
              {` · reading mail from ${m.since} onwards`}
            </p>
            {m.last_error && (
              <p className="err" style={{ margin: 0 }}>
                {m.last_error}
              </p>
            )}
          </div>
          <div className="acctactions">
            <button className="ghost" disabled={!!busy} onClick={() => act(m.id, () => sync({ data: m.id }))}>
              {busy === m.id ? 'Checking…' : 'Check now'}
            </button>
            <button className="ghost" onClick={() => setConfiguring(m)}>
              Config
            </button>
            <button className="danger" disabled={!!busy} onClick={() => setRemoving(m)}>
              {busy === `rm-${m.id}` ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ))}

      <div className="row" style={{ marginTop: boxes.length ? 12 : 0 }}>
        <button
          disabled={!ready || !!busy}
          title={ready ? undefined : 'This server has no OAuth application for that provider'}
          onClick={() =>
            act('add', async () => {
              // Consent happens on the provider's own site, so this leaves the app.
              window.location.href = await connect({ data: provider })
            })
          }
        >
          {busy === 'add' ? 'Connecting…' : boxes.length ? 'Connect another mailbox' : 'Connect a mailbox'}
        </button>
        <span className="note">
          {boxes.length ? 'Every mailbox files into the same inbox.' : 'Sign in to the account you want read.'}
        </span>
      </div>

      {err && (
        <p className="err" style={{ marginBottom: 0 }}>
          {err}
        </p>
      )}

      {configuring && (
        <MailboxModal
          address={configuring.address}
          since={configuring.since}
          onSave={async (value) => {
            await since({ data: { id: configuring.id, since: value } })
          }}
          onClose={async () => {
            setConfiguring(null)
            await router.invalidate()
          }}
        />
      )}

      {removing && (
        <ConfirmRemove
          title={`Disconnect ${removing.address}?`}
          note="The refresh token is dropped, so nothing is fetched from this mailbox again."
          takes="Every thread that arrived in this mailbox goes, with its messages. Without the token nothing can be fetched or replied to on them."
          confirmLabel="Disconnect"
          busy={busy === removing.id}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const id = removing.id
            void act(id, () => drop({ data: id })).then(() => setRemoving(null))
          }}
        />
      )}
    </div>
  )
}
