import { useState } from 'react'
import { Pager } from '../components/Pager'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { changeCredentials, providerSettings, requireSession, setProvider, usingDefaultPassword } from '../server/auth'
import { byBot as llmByBot, byModel as llmByModel, spend as llmSpend, usage as llmUsage } from '../server/llm'
import { pageOf } from '../types'

const load = createServerFn({ method: 'GET' }).handler(async () => {
  const s = await requireSession()
  return {
    username: s.email,
    isDefault: await usingDefaultPassword(),
    ...(await providerSettings(s.workspaceId)),
    usage: await llmUsage(s.workspaceId),
    spend: await llmSpend(s.workspaceId),
    models: await llmByModel(s.workspaceId),
    bots: await llmByBot(s.workspaceId),
  }
})

/**
 * Change the username, the password, or both.
 *
 * The account comes from the session and the current password is checked in `auth.ts`,
 * never here — a server function is reachable by POST without this page's loader ever
 * having run, so "they had a session" is not the same as "they know the password".
 */
const saveCredentials = createServerFn({ method: 'POST' })
  .validator((d: { current: string; username?: string; password?: string }) => d)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await changeCredentials(s.userId, data.current, { username: data.username, password: data.password })
  })

const saveProvider = createServerFn({ method: 'POST' })
  .validator((data: { key: string }) => data)
  .handler(async ({ data }) => {
    const s = await requireSession()
    await setProvider(s.workspaceId, data.key)
  })

const TABS = [
  ['general', 'General'],
  ['provider', 'Model provider'],
] as const

export const Route = createFileRoute('/settings')({
  // Optional, so the default tab is the absent param — a bare /settings, not /settings?tab=general.
  validateSearch: (s: Record<string, unknown>): { tab?: string } =>
    TABS.some(([id]) => id === s.tab) ? { tab: s.tab as string } : {},
  loader: () => load(),
  component: Settings,
})

function Settings() {
  const { username, isDefault, hasKey, fromEnv, usage, spend, models, bots } = Route.useLoaderData()
  const { tab = 'general' } = Route.useSearch()
  const router = useRouter()

  /*
   * All four, unconditionally — hooks cannot live inside the `tab === 'provider'` branch the
   * tables render in. Cheap: each is a slice and a number.
   */
  const pProvider = usePage(usage)
  const pSpend = usePage(spend)
  const pModels = usePage(models)
  const pBots = usePage(bots)

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">What this workspace is called, what can write into it, and what answers for it.</p>

      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab on' : 'tab'}
            // General is the default, so it is the absent one — a bare /settings is it.
            onClick={() => router.navigate({ to: '/settings', search: id === 'general' ? {} : { tab: id } })}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'general' && <Credentials username={username} isDefault={isDefault} />}

      {tab === 'provider' && (
        <>
          <p className="note" style={{ maxWidth: '62ch', marginTop: 20 }}>
            Every answer, tool call and extraction this workspace's bots make goes out on your Autobricks key
            and bills to that account. It is the only provider this build talks to — another one means editing
            <code> src/server/llm.ts</code>.
          </p>
          <ProviderSection hasKey={hasKey} fromEnv={fromEnv} />

          {/*
            Four questions, side by side rather than a single column down the left.

            They are read against each other — "answering cost the most" only means something
            beside "and it ran on the expensive model" — so stacking them put the comparison a
            scroll apart on a screen with room for both. `grid two` is auto-fit at 360px, so
            this is two columns on a laptop and one on a phone without a second layout.
          */}
          <h2 style={{ marginTop: 28 }}>Usage</h2>
          {usage.length ? (
            <div className="grid two">
              <section>
                <h3 style={{ marginTop: 0 }}>By provider</h3>
                <p className="note" style={{ marginTop: 0 }}>Everything, since the beginning.</p>
                <table className="card">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Tokens</th>
                      <th>Credits</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pProvider.shown.map((u) => (
                      <tr key={u.provider}>
                        <td>{u.provider === 'autobricks' ? 'Autobricks' : u.provider}</td>
                        <td>{u.tokens.toLocaleString()}</td>
                        <td><Credits r={u} /></td>
                        <td className="note">{new Date(u.last_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pager {...pProvider} />
              </section>

              {/*
                What the provider total cannot say. A total answers "how much" and immediately
                raises "why so much?", and until this existed the only way to answer that was
                to read timestamps beside prompt sizes and guess. `calls` beside the total is
                the part that matters: nine ordinary calls and one runaway call look identical
                as a sum and are entirely different problems.
              */}
              {spend.length > 0 && (
                <section>
                  <h3 style={{ marginTop: 0 }}>Where it went</h3>
                  <p className="note" style={{ marginTop: 0 }}>Answering one message is several calls.</p>
                  <table className="card">
                    <thead>
                      <tr>
                        <th>What for</th>
                        <th>Calls</th>
                        <th>Tokens</th>
                        <th>Credits</th>
                        <th>Each</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pSpend.shown.map((s) => (
                        <tr key={s.purpose}>
                          <td>{PURPOSES[s.purpose] ?? s.purpose}</td>
                          <td>{s.calls.toLocaleString()}</td>
                          <td>{s.tokens.toLocaleString()}</td>
                          <td><Credits r={s} /></td>
                          {/* Per call, divided out of the figure beside it rather than summed
                              separately, so the two cells cannot disagree. Where the charge is
                              a per-request minimum this average is what reveals it: a row of
                              short calls averages almost exactly one credit each. */}
                          <td className="note">
                            {s.per_call.toLocaleString()}
                            {s.credits != null &&
                              ` · ${Math.round((s.credits / Math.max(1, s.calls)) * 100) / 100} cr`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pager {...pSpend} />
                </section>
              )}

              {/*
                Which model, and what it was doing. The two belong together: the same model is
                cheap answering a question and expensive reading a hundred threads for
                training, so a list of models with no purposes against them invites the wrong
                conclusion about which one to change.
              */}
              {models.length > 0 && (
                <section>
                  <h3 style={{ marginTop: 0 }}>Models</h3>
                  <p className="note" style={{ marginTop: 0 }}>What ran, and what it was doing.</p>
                  <table className="card">
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Calls</th>
                        <th>Tokens</th>
                        <th>Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pModels.shown.map((m) => (
                        <tr key={m.model}>
                          <td>
                            {/* The provider prefix is the same on every row and the part
                                nobody is reading — the model is the last segment. */}
                            {m.model.includes('/') ? m.model.split('/').slice(1).join('/') : m.model}
                            <br />
                            <span className="note">
                              {m.purposes
                                .split(', ')
                                .map((p) => PURPOSES[p] ?? p)
                                .join(' · ')}
                            </span>
                          </td>
                          <td>{m.calls.toLocaleString()}</td>
                          <td>{m.tokens.toLocaleString()}</td>
                          <td><Credits r={m} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Pager {...pModels} />
                </section>
              )}

              {/*
                Per chatbot, as a share as well as a total.

                The share is the useful half: "forty thousand tokens" means nothing without
                knowing whether that is most of the bill or a rounding error beside another
                bot. Worked out against the sum of the bots rather than the workspace total,
                because the rows that belong to no bot are not shown — a percentage that did
                not add to a hundred would read as a bug.
              */}
              {bots.length > 0 && (
                <section>
                  <h3 style={{ marginTop: 0 }}>By chatbot</h3>
                  <p className="note" style={{ marginTop: 0 }}>
                    Answering and training. Work with no conversation behind it — reading a knowledge base,
                    working out what the company does — belongs to no bot and is left out.
                  </p>
                  <table className="card">
                    <thead>
                      <tr>
                        <th>Chatbot</th>
                        <th>Share</th>
                        <th>Tokens</th>
                        <th>Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pBots.shown.map((b) => {
                        const total = bots.reduce((n, x) => n + x.tokens, 0)
                        const share = total ? Math.round((b.tokens / total) * 100) : 0
                        return (
                          <tr key={b.bot_id ?? 'none'}>
                            <td>{b.name ?? 'No chatbot assigned'}</td>
                            <td>
                              {/* The bar is the comparison; the number is for the one row
                                  somebody actually wants to read out. */}
                              <span className="sharebar" aria-hidden="true">
                                <span style={{ width: Math.max(2, share) + '%' }} />
                              </span>
                              <span className="note"> {share}%</span>
                            </td>
                            <td>{b.tokens.toLocaleString()}</td>
                            <td><Credits r={b} /></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <Pager {...pBots} />
                </section>
              )}
            </div>
          ) : (
            <p className="note">Nothing recorded yet — this fills in the first time a bot answers.</p>
          )}

        </>
      )}
    </>
  )
}

/**
 * What the provider charged, in its own unit.
 *
 * Credits rather than converted money, because credits are the exact figure: the provider
 * bills whole credits per request with a minimum of one, and the conversion to dollars was a
 * fixed rate that moves -- so the money column was the only approximate thing on a page whose
 * point is reconciling against the account.
 *
 * Null is a call made before the provider reported its charge, and says so rather than
 * showing a zero somebody would add up.
 */
const Credits = ({ r }: { r: { credits: number | null } }) =>
  r.credits == null ? <span className="note">not recorded</span> : <>{r.credits.toLocaleString()} cr</>

/**
 * What each kind of call is, in words somebody paying for it would use.
 *
 * Anything unrecognised falls through to its raw name rather than being hidden or relabelled
 * — a new caller should show up here the day it is written, not the day somebody remembers
 * to add it to this list.
 */
const PURPOSES: Record<string, string> = {
  answer: 'Answering a customer',
  tool_round: 'Looking something up mid-answer',
  file_check: 'Checking a file belongs with the answer',
  contact: 'Reading a conversation for what the customer said about themselves',
  identity: 'Working out what the company does',
  catchup: 'Summarising a conversation',
  chat: 'Other',
  unrecorded: 'Before this was recorded',
}

/**
 * The one account's username and password.
 *
 * Both optional and both in one form, because they are one errand: somebody who has just
 * been told the shipped credential is public is going to change both, and two forms with
 * two "current password" boxes would be asking the same question twice.
 *
 * Nothing is pre-filled but the username. A password box that arrives holding something is
 * a password box a browser filled in, and saving that by accident is how somebody locks
 * themselves out of their own machine.
 */
function Credentials({ username, isDefault }: { username: string; isDefault: boolean }) {
  const router = useRouter()
  const saveFn = useServerFn(saveCredentials)
  const [current, setCurrent] = useState('')
  const [name, setName] = useState(username)
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState(false)

  const changingName = name.trim().toLowerCase() !== username.toLowerCase()
  const nothingToDo = !changingName && !next
  const mismatch = !!next && next !== again

  const save = async () => {
    if (nothingToDo || mismatch) return
    setBusy(true)
    setErr('')
    setSaved(false)
    try {
      await saveFn({
        data: { current, username: changingName ? name.trim() : undefined, password: next || undefined },
      })
      setCurrent('')
      setNext('')
      setAgain('')
      setSaved(true)
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 520, marginTop: 20 }}>
      <h2 style={{ marginTop: 0, fontSize: 17 }}>Sign-in</h2>
      <p className="note" style={{ marginTop: 4 }}>
        {isDefault
          ? 'Still the password this build ships with, which is published in its own README. Change it.'
          : 'Changing the password signs out every other browser this account is open in.'}
      </p>

      <label htmlFor="cur">Current password</label>
      <input id="cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />

      <label htmlFor="user" style={{ marginTop: 14, display: 'block' }}>
        Username
      </label>
      <input id="user" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} />

      <label htmlFor="new" style={{ marginTop: 14, display: 'block' }}>
        New password
      </label>
      <input
        id="new"
        type="password"
        autoComplete="new-password"
        placeholder="Leave blank to keep it"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />

      {!!next && (
        <>
          <label htmlFor="again" style={{ marginTop: 14, display: 'block' }}>
            New password again
          </label>
          <input id="again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </>
      )}

      {mismatch && (
        <p className="err" style={{ marginTop: 12 }} role="alert">
          Those two do not match.
        </p>
      )}
      {err && (
        <p className="err" style={{ marginTop: 12 }} role="alert">
          {err}
        </p>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" disabled={busy || !current || nothingToDo || mismatch} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="pill ok">Saved</span>}
      </div>
    </div>
  )
}

/** Save an Autobricks key without ever displaying one back. */
function ProviderSection({ hasKey, fromEnv }: { hasKey: boolean; fromEnv: boolean }) {
  const router = useRouter()
  const saveFn = useServerFn(saveProvider)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (!key.trim()) return
    setBusy(true)
    setErr('')
    setSaved(false)
    try {
      await saveFn({ data: { key: key.trim() } })
      setKey('')
      setSaved(true)
      await router.invalidate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <label htmlFor="autobricks-key">Autobricks API key</label>
      <input
        id="autobricks-key"
        type="password"
        autoComplete="off"
        placeholder={
          hasKey
            ? fromEnv
              ? '•••••••••••••••• (in use — paste one here to replace it)'
              : '•••••••••••••••• (saved — paste a new one to replace it)'
            : 'Paste your key'
        }
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
        {fromEnv ? (
          <>
            Currently answering on the <code>AUTOBRICKS_API_KEY</code> in your <code>.env</code>. Saving one here
            encrypts a copy into this workspace as well, which is what the usage table reads.
          </>
        ) : (
          <>
            Saved encrypted here and written to your <code>.env</code>, so it survives rebuilding the container.
            {hasKey ? '' : ' Until one is saved, every question goes to a person instead of being answered.'}
          </>
        )}
      </p>

      {err && (
        <p className="err" style={{ marginTop: 12 }} role="alert">
          {err}
        </p>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <button disabled={busy || !key.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="pill ok">Saved</span>}
      </div>
    </div>
  )
}

/**
 * A credential on screen, covered by default.
 *
 * Almost every reason to open this page is to copy the thing, not to read it — and the
 * times somebody is looking at this page are exactly the times a screen is being shared or
 * a shoulder is being looked over. So: dots, a copy button that never reveals it, and
 * showing it is a deliberate act that says so.
 */
function Secret({ value, label }: { value: string; label: string }) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)

  return (
    <div className="row secret">
      <input
        readOnly
        aria-label={label}
        // A password field, so browsers and screen readers already know what it is and
        // password managers leave it alone.
        type={shown ? 'text' : 'password'}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button className="ghost" onClick={() => setShown((v) => !v)}>
        {shown ? 'Hide' : 'Show'}
      </button>
      <button
        onClick={async () => {
          await navigator.clipboard?.writeText(value)
          setCopied(true)
          // Long enough to read, short enough that the button is a button again by the
          // time anybody wants it twice.
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * A page of rows, and the state to move between them.
 *
 * A hook rather than a wrapper component because the rows belong inside a `<tbody>`, and a
 * component that owned them would have to own the whole table to put them there — four
 * near-identical tables with different columns is exactly the abstraction not worth having.
 * This owns the arithmetic; each table keeps its own markup.
 *
 * `page` is clamped on read rather than corrected in an effect: the row count can shrink
 * under a page that is already open — a filter, a reload — and a stale index would render an
 * empty table with no way back. Clamping means the last page simply becomes the last page.
 */
function usePage<T>(rows: T[], size = 5) {
  const [page, setPage] = useState(0)
  const { at, pages, from, to } = pageOf(rows.length, size, page)
  return { shown: rows.slice(from, to), at, pages, setPage }
}

