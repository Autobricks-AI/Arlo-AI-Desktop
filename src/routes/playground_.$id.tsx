import { useEffect, useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { NotFound } from '../components/NotFound'
import { requireSession } from '../server/auth'
import * as agent from '../server/agent'
import * as bots from '../server/bot'
import type { Cite } from '../server/conversations'
import type { Sendable } from '../server/resources'
import { CHAT_FILE, CHAT_FILE_ACCEPT, MAX_RESOURCE_MB } from '../types'
import { Attached, useChatFiles } from '../components/ChatFiles'
import { Peek } from '../components/Modal'

/**
 * Talk to a bot, and find out what it has actually learned.
 *
 * ---------------------------------------------------------------- why a page, and why nothing is kept
 *
 * Before this, trying a bot out meant switching it live, messaging it from a real channel,
 * reading one thread in the inbox and remembering to switch it back — with every other customer
 * answered live in the meantime. `answers_live` (068) softened that to one existing thread, but
 * it still needs a real customer to have written in first.
 *
 * Here there is no customer and no thread. The transcript lives in this component for as long as
 * the page is open and goes nowhere else: leave, and the session is gone. That is not a
 * limitation to work around later — it is what makes the page safe to open on a live bot in the
 * middle of a working day, and what makes every open a fresh stranger rather than a thread that
 * remembers yesterday's experiment.
 *
 * Its own destination rather than a modal over the editor: a conversation is a thing you sit in
 * for a while, and it is reached from the rail as often as from one bot's settings. The picker
 * next door (`playground.tsx`) is the front door; this is the same page with a bot already
 * chosen.
 */

const load = createServerFn({ method: 'GET' })
  .validator((id: number) => id)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const bot = await bots.get(s.workspaceId, data)
    // Three fields: everything else on the page is typed by a person or said by the model.
    return bot ? { id: bot.id, name: bot.name, mode: bot.mode } : null
  })

/**
 * One turn, against nothing.
 *
 * The transcript arrives from the browser and goes back to it. The session is re-checked rather
 * than trusted from the page, because this is reachable by POST whether or not anybody opened
 * the page — the same reason every other action on a record checks for itself.
 */
const ask = createServerFn({ method: 'POST' })
  /*
   * FormData, for the reason every other upload here gives: a file may be megabytes, and
   * base64 in a JSON body is a third bigger and held twice. The transcript rides along as a
   * JSON field because it is text and there is nothing to gain from a second request.
   */
  .validator((d: FormData) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    const bot = await bots.get(s.workspaceId, Number(data.get('botId')))
    if (!bot) throw new Error('No such chatbot')

    const files: { name: string; mime: string; bytes: Buffer }[] = []
    for (const part of data.getAll('file')) {
      if (!(part instanceof File)) continue
      /*
       * Checked here as well as in the browser. The page refuses the wrong kind before
       * spending a minute uploading it, which is a courtesy; this is the rule.
       */
      if (!CHAT_FILE.test(part.type)) throw new Error(`${part.name} is ${part.type || 'an unknown type'} — send a picture or a PDF`)
      if (part.size > MAX_RESOURCE_MB * 1048576) throw new Error(`${part.name} is over the ${MAX_RESOURCE_MB}MB limit`)
      files.push({ name: part.name, mime: part.type, bytes: Buffer.from(await part.arrayBuffer()) })
    }

    /*
     * Capped on both sides. The question is somebody's typing and the history is whatever a
     * browser chose to send, and every turn of it is paid for in tokens on each round. Ten is
     * what a real conversation gets — `recent()`'s default in agent.ts.
     */
    const history = JSON.parse(String(data.get('history') ?? '[]')) as { direction: 'in' | 'out'; body: string }[]
    return agent.preview(s.workspaceId, bot, String(data.get('text') ?? '').slice(0, 2000), history.slice(-10), files)
  })

export const Route = createFileRoute('/playground_/$id')({
  loader: ({ params }) => load({ data: Number(params.id) }),
  component: Playground,
})

type Bot = NonNullable<Awaited<ReturnType<typeof load>>>

type Turn = {
  direction: 'in' | 'out'
  body: string
  cited?: Cite[]
  used?: { examples: string[]; sends: Sendable[]; flagged: string | null }
  /** Waiting on the model. One of these at a time, and it is the only thing stopping a second. */
  thinking?: boolean
  /**
   * What went up with this turn, kept so the transcript shows it.
   *
   * The browser's own `File` objects, not anything the server sent back — there is nothing on
   * the server to send back, which is the point of the page.
   */
  sent?: File[]
}

/** What each mode means for somebody testing rather than being answered. */
const MODE_HERE: Record<string, string> = {
  paused: 'This bot is paused, so it says nothing to customers. Here it answers, so you can see what it knows before switching it on.',
  draft: 'In Draft mode it writes into the inbox for a person to send. Here it answers you directly.',
  learning: 'In Learning mode it reads conversations and proposes training without replying. Here it answers you directly.',
}

function Playground() {
  const bot = Route.useLoaderData()
  if (!bot) return <NotFound what="chatbot" to="/chatbots" label="Back to the list." />
  /*
   * Keyed, so a different bot is a different session.
   *
   * Going from one bot's playground to another's is the same mounted route with a new param —
   * React keeps the state and the transcript would follow you to a bot that never said any of
   * it. The same trap the editor documents for its own draft.
   */
  return <Session key={bot.id} bot={bot} />
}

function Session({ bot }: { bot: Bot }) {
  const askFn = useServerFn(ask)
  const [turns, setTurns] = useState<Turn[]>([])
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const busy = turns.some((t) => t.thinking)
  const foot = useRef<HTMLDivElement>(null)
  const chat = useChatFiles(setErr)

  // Scroll the marker rather than the last bubble: a zero-height div lands at the bottom,
  // where centring a tall bubble does not. Lifted from the inbox.
  useEffect(() => {
    const at = requestAnimationFrame(() => foot.current?.scrollIntoView({ block: 'end' }))
    return () => cancelAnimationFrame(at)
  }, [turns.length])

  const send = async () => {
    const question = text.trim()
    const sending = chat.files
    // A picture on its own is a question — "what is this?" — so files alone are enough to send.
    if ((!question && !sending.length) || busy) return
    setText('')
    chat.clear()
    setErr('')
    // What the server gets is the transcript before this question; `preview()` appends the
    // question itself, because that is the shape `answer()` expects to read back.
    const history = turns.filter((t) => !t.thinking).map(({ direction, body }) => ({ direction, body }))
    setTurns((t) => [
      ...t,
      { direction: 'in', body: question, sent: sending },
      { direction: 'out', body: '', thinking: true },
    ])

    const body = new FormData()
    body.set('botId', String(bot.id))
    body.set('text', question)
    body.set('history', JSON.stringify(history))
    for (const file of sending) body.append('file', file)

    try {
      const r = await askFn({ data: body })
      setTurns((t) => [
        ...t.slice(0, -1),
        {
          direction: 'out',
          // A bot that could not answer says why rather than showing an empty bubble.
          body: r.reply ?? `No answer — ${r.status}.`,
          cited: r.cited,
          used: r.used,
        },
      ])
    } catch (e) {
      // The question stays on screen; only the bubble waiting on a reply goes. The files come
      // back too, or retrying a send that failed for its own reasons means finding them again.
      setTurns((t) => t.slice(0, -1))
      chat.take(sending)
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="page fullheight">
      <Link to="/playground" className="backlink">
        ← Playground
      </Link>
      <div className="pagehead">
        <div className="titles">
          <h1 style={{ fontSize: 30 }}>Playground</h1>
          <p className="lede" style={{ marginBottom: 12 }}>
            {bot.name}, answering as it would a stranger. Nothing here is saved — leaving this page ends the session.
          </p>
        </div>
        <div className="actions">
          {turns.length > 0 && (
            <button className="ghost" onClick={() => setTurns([])}>
              Start over
            </button>
          )}
          {/* The way to the bot itself, for when a test turns into a change. */}
          <Link to="/chatbot/$id" params={{ id: String(bot.id) }} search={{ tab: 'identity' }} className="button ghost">
            Configure
          </Link>
        </div>
      </div>

      {MODE_HERE[bot.mode] && <p className="warn">{MODE_HERE[bot.mode]}</p>}
      {err && <p className="bad">{err}</p>}

      <div className="card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="msgs">
          {turns.length === 0 && (
            <p className="note">Ask it something a customer would ask. It answers from what it has been taught.</p>
          )}
          {turns.map((t, i) => (
            /*
              `in` is you and `out` is the bot — the way round the widget has it, and the
              opposite of the inbox, where `out` is the team. Each bubble says who is speaking
              so nobody reads a test as having answered a real customer.
            */
            <div className={`bubble ${t.direction}`} key={i}>
              {t.thinking ? 'Thinking…' : t.body}
              {/* What was sent with it, shown the way the inbox shows a file on a message. */}
              {t.sent?.map((f, n) => <SentFile key={n} file={f} />)}
              <small>{t.direction === 'in' ? 'you, as a customer' : bot.name}</small>
              {t.cited?.length ? (
                <small>
                  From{' '}
                  {t.cited
                    .map((c) => c.title)
                    .filter((x, n, a) => a.indexOf(x) === n)
                    .join(', ')}
                </small>
              ) : null}
              {t.used?.examples.length ? <small>Taught by: “{t.used.examples.join('”, “')}”</small> : null}
              {/*
                Attached, not listed. A real conversation gets the file; so does this, at the
                same public address, so what is tested here is what a customer would receive.
              */}
              {t.used?.sends.length ? (
                <>
                  <small>Sent with this answer:</small>
                  {t.used.sends.map((f) => <SentResource key={f.id} file={f} />)}
                </>
              ) : null}
              {t.used?.flagged ? <small>Would ask a person: {t.used.flagged}</small> : null}
            </div>
          ))}
          <div ref={foot} />
        </div>

        {/*
          The drop target and the paste target are the whole composer, not the textarea.
          Somebody dragging a screenshot aims at the box they type in, which includes the
          padding around it — and a paste only lands on the textarea if it already has focus.
        */}
        <div className={`composer${chat.dragging ? ' dragging' : ''}`} {...chat.bind}>
          <Attached
            files={chat.files}
            onRemove={chat.remove}
            onPick={chat.take}
            picker={chat.picker}
            disabled={busy}
          />
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <textarea
              rows={2}
              style={{ flex: 1 }}
              placeholder={`Ask ${bot.name} something, or paste a screenshot…`}
              aria-label="Your message"
              value={text}
              onChange={(e) => setText(e.target.value)}
              // Enter sends, Shift+Enter is a newline — what every chat client does.
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && (text.trim() || chat.files.length)) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button className="ghost" onClick={chat.open} disabled={busy} title="Attach a picture or a PDF">
              Attach
            </button>
            {/*
              ponytail: one turn at a time is the only cap. The live path is throttled inside
              deliver(), which this deliberately skips — sharing that budget would let a test
              session starve real replies. Add take('playground:<workspace>') if a bill
              surprises somebody.
            */}
            <button onClick={() => void send()} disabled={busy || (!text.trim() && !chat.files.length)}>
              {busy ? 'Thinking…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A file on a turn that was never uploaded anywhere — the browser's own copy of it. */
function SentFile({ file }: { file: File }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!file.type.startsWith('image/')) return
    const made = URL.createObjectURL(file)
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [file])

  // An image is its own thumbnail, the rule the inbox follows. A PDF is a name and a size.
  return url ? (
    <img className="sentimg" src={url} alt={file.name} />
  ) : (
    <small>
      {file.name} · {Math.max(1, Math.round(file.size / 1024))} kB
    </small>
  )
}

/**
 * A file the bot attached, shown the way the inbox shows one on a message.
 *
 * Openable, not named. The point of testing a send is seeing that the right file goes out,
 * and a title alone cannot tell you that -- two brochures a version apart have almost the
 * same name. The address is the public one a customer would get, which is the other half of
 * what is being tested: if this will not open here it will not open for them either.
 */
function SentResource({ file }: { file: Sendable }) {
  const [peek, setPeek] = useState(false)
  const link = file.kind === 'link'
  const href = link ? (file.url ?? '') : `/api/resource/${file.token}`

  if (link)
    return (
      <a className="file card" href={href} target="_blank" rel="noreferrer" title={`Open ${file.title}`}>
        <span className="filekind" aria-hidden="true">
          ↗
        </span>
        <span className="filewho">
          <b>{file.title}</b>
          <small>{href}</small>
        </span>
      </a>
    )

  // An image is its own thumbnail; everything else is a card with its kind, name and size.
  const image = file.mime?.startsWith('image/')
  return (
    <>
      <button
        type="button"
        onClick={() => setPeek(true)}
        className={`file ${image ? 'image' : 'card'}`}
        title={`Open ${file.title}`}
      >
        {image ? (
          <>
            <img src={href} alt={file.title} loading="lazy" />
            <small>{file.title}</small>
          </>
        ) : (
          <>
            <span className="filekind" aria-hidden="true">
              {(file.title.split('.').pop() ?? 'file').slice(0, 4).toUpperCase()}
            </span>
            <span className="filewho">
              <b>{file.title}</b>
              <small>{Math.max(1, Math.round(file.size_bytes / 1024))} kB</small>
            </span>
          </>
        )}
      </button>
      {peek && <Peek at={{ title: file.title, href, mime: file.mime }} onClose={() => setPeek(false)} />}
    </>
  )
}
