import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { requireSession } from '../server/auth'
import * as bots from '../server/bot'
import { identityState, setCompanyIdentity, useDerived } from '../server/identity'
import { CompanyIdentity } from '../components/CompanyIdentity'

const load = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await requireSession()
  return {
    bots: await bots.list(s.workspaceId),
    identity: await identityState(s.workspaceId),
  }
})

/** Who every bot in this workspace answers for. One company, so one place to say it. */
const saveIdentity = createServerFn({ method: 'POST' })
  .validator((text: string) => text)
  .handler(async ({ data }) => setCompanyIdentity((await requireSession()).workspaceId, data))

/** Throw away what was typed and read the knowledge base again, now. */
const rederiveIdentity = createServerFn({ method: 'POST' }).handler(async () =>
  useDerived((await requireSession()).workspaceId),
)

const setDefault = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => bots.makeDefault((await requireSession()).workspaceId, data))

const drop = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(async ({ data }) => bots.remove((await requireSession()).workspaceId, data))

export const Route = createFileRoute('/chatbots')({ loader: () => load(), component: Gallery })

function Gallery() {
  const { bots: list, identity } = Route.useLoaderData()
  const router = useRouter()
  const defaultFn = useServerFn(setDefault)
  const dropFn = useServerFn(drop)
  const saveIdentityFn = useServerFn(saveIdentity)
  const rederiveFn = useServerFn(rederiveIdentity)
  const [busy, setBusy] = useState(0)
  const [err, setErr] = useState('')

  const act = async (id: number, fn: () => Promise<unknown>) => {
    setBusy(id)
    setErr('')
    try {
      await fn()
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(0)
    }
  }

  return (
    <>
      <div className="pagehead">
        <div className="titles">
          <h1>Chatbots</h1>
          <p className="lede">
            One for each job. A support bot on the help site and a sales bot on the pricing page can know
            different things, answer to different rules, and be read by different people.
          </p>
        </div>
        <div className="actions">
          <Link to="/chatbot/new" className="button primary">
            New chatbot
          </Link>
        </div>
      </div>

      {err && (
        <p className="err" role="alert">
          {err}
        </p>
      )}

      <CompanyIdentity
        identity={identity?.identity ?? null}
        manual={!!identity?.identity_manual}
        documents={identity?.documents ?? 0}
        stale={!!identity?.stale}
        onSave={async (text) => {
          await saveIdentityFn({ data: text })
          await router.invalidate()
        }}
        onRederive={async () => {
          await rederiveFn({})
          await router.invalidate()
        }}
      />

      {list.length === 0 ? (
        <div className="card empty">
          <h3>No chatbots yet</h3>
          <p className="note">
            A chatbot is a set of instructions, a slice of your knowledge base, and the places it is allowed to
            answer. Making one takes about a minute.
          </p>
          <Link to="/chatbot/new" className="button primary" style={{ marginTop: 14 }}>
            Create the first one
          </Link>
        </div>
      ) : (
        <div className="cards">
          {list.map((bot) => (
            <div key={bot.id} className="card botcard">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <Link to="/chatbot/$id" params={{ id: String(bot.id) }} search={{ tab: 'identity' }} className="botname">
                  {bot.name}
                </Link>
                <span className="row" style={{ gap: 6 }}>
                  <span className={bot.mode === 'live' ? 'pill ok' : bot.mode === 'learning' ? 'pill warn' : 'pill'}>
                    {bot.mode}
                  </span>
                </span>
              </div>

              <p className="note desc">{bot.description || 'No description.'}</p>

              <dl className="facts">
                <div>
                  <dt>Answers on</dt>
                  <dd>
                    {bot.connections > 0
                      ? `${bot.connections} connection${bot.connections === 1 ? '' : 's'}`
                      : 'nothing yet'}
                  </dd>
                </div>
                <div>
                  <dt>Knows</dt>
                  <dd>{bot.sources ? `${bot.sources} source${bot.sources === 1 ? '' : 's'}` : 'nothing yet'}</dd>
                </div>
                <div>
                  <dt>Conversations</dt>
                  <dd>{bot.conversations}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd className="mono">{bot.model ?? 'server default'}</dd>
                </div>
              </dl>

              <div className="row cardfoot">
                <Link to="/chatbot/$id" params={{ id: String(bot.id) }} search={{ tab: 'identity' }} className="button ghost small">
                  Configure
                </Link>
                <Link to="/inbox" search={{ bot: bot.id }} className="button ghost small">
                  Messages
                </Link>
                {bot.is_default ? (
                  /*
                   * Not a button. Nothing routes here on its own any more — a connection is
                   * answered only once it is assigned — so this marks the one offered first
                   * when a connector is set up, and making another default is how it moves.
                   */
                  <span className="pill" title="Offered first when a connection is set up">
                    default
                  </span>
                ) : (
                  <>
                    <button
                      className="ghost small"
                      disabled={!!busy}
                      title="Offer this one first when a connection is set up"
                      onClick={() => act(bot.id, () => defaultFn({ data: bot.id }))}
                    >
                      Make default
                    </button>
                    <button
                      className="ghost small danger"
                      disabled={!!busy}
                      onClick={() =>
                        confirm(`Delete ${bot.name}? Its conversations stay, but nothing will answer them.`) &&
                        act(bot.id, () => dropFn({ data: bot.id }))
                      }
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
