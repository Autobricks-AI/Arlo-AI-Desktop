import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { requireSession } from '../server/auth'
import * as bots from '../server/bot'

/**
 * Pick a bot to talk to.
 *
 * The front door to the playground, for the times somebody wants to try a bot rather than
 * change one — which is most of them. Coming from a bot's own settings skips this and lands
 * straight in the conversation; both end up on the same page.
 *
 * Deliberately not the Chatbots gallery with an extra button. That page is where a bot is
 * configured, counted and compared, and its cards carry five numbers and four links to prove
 * it. Here there is exactly one thing to do with a bot, so a card says who it is, what state
 * it is in, and nothing else.
 */
const load = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await requireSession()
  const list = await bots.list(s.workspaceId)
  // Only what a card draws. The gallery's counts are a different question from "which one".
  return list.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    mode: b.mode,
    sources: b.sources,
  }))
})

export const Route = createFileRoute('/playground')({
  loader: () => load(),
  component: Playground,
})

/** What each mode means for somebody about to test rather than about to go live. */
const MODE_NOTE: Record<string, string> = {
  live: 'answering customers now',
  draft: 'writing drafts for a person',
  learning: 'reading conversations, not replying',
  paused: 'saying nothing to customers',
}

function Playground() {
  const all = Route.useLoaderData()
  const [find, setFind] = useState('')

  /*
   * In the browser, not in SQL. A workspace has a handful of bots -- the gallery is three
   * across and nobody has a hundred -- so this is a filter over a list that is already here,
   * and a round trip per keystroke would be slower than the thing it replaced.
   */
  const term = find.trim().toLowerCase()
  const list = term
    ? all.filter((b) => `${b.name} ${b.description ?? ''}`.toLowerCase().includes(term))
    : all

  return (
    <div className="page">
      <div className="pagehead">
        <div className="titles">
          <h1>Playground</h1>
          <p className="lede">
            Talk to any of your chatbots the way a customer would, and see what it has learned. Nothing is saved —
            leaving a session ends it.
          </p>
        </div>
      </div>

      {all.length === 0 ? (
        <div className="card empty">
          <h3>No chatbots yet</h3>
          <p className="note">There is nothing to talk to until there is a bot. Making one takes about a minute.</p>
          <Link to="/chatbot/new" className="button primary" style={{ marginTop: 14 }}>
            Create the first one
          </Link>
        </div>
      ) : (
        <>
          {/* Only once there is enough to be worth searching — the rule the attachment picker
              and the review queue both use. A filter over four cards is furniture. */}
          {all.length > 6 && (
            <input
              className="search"
              aria-label="Search chatbots"
              placeholder={`Search ${all.length} chatbots`}
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
          )}

          {list.length === 0 ? (
            <p className="note">Nothing matches “{find.trim()}”.</p>
          ) : (
            <div className="cards">
              {list.map((bot) => (
                /*
                  The whole card is the link. There is one thing to do here, so making somebody
                  find a button inside it would be asking them to aim at a target that has no
                  competition.
                */
                <Link
                  key={bot.id}
                  to="/playground/$id"
                  params={{ id: String(bot.id) }}
                  className="card botcard pickbot"
                >
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong className="botname">{bot.name}</strong>
                    <span
                      className={bot.mode === 'live' ? 'pill ok' : bot.mode === 'learning' ? 'pill warn' : 'pill'}
                    >
                      {bot.mode}
                    </span>
                  </div>

                  <p className="note desc">{bot.description || 'No description.'}</p>

                  <p className="note">
                    {bot.sources ? `Knows ${bot.sources} source${bot.sources === 1 ? '' : 's'}` : 'Knows nothing yet'} ·{' '}
                    {MODE_NOTE[bot.mode] ?? bot.mode}
                  </p>

                  <span className="go">Talk to it ›</span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
