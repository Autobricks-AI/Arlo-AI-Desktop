import { useState } from 'react'
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router'
import { createServerFn, useServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { currentSession, signIn, startSession, usingDefaultPassword } from '../server/auth'
import { callerIp } from '../server/throttle'
import { OutboundSignInLinks } from '../components/GithubLink'
import { Logo } from '../components/Logo'
import { DEFAULT_PASSWORD, DEFAULT_USER } from '../types'
import { HOME } from './__root'

const whoami = createServerFn({ method: 'GET' }).handler(async () => !!(await currentSession()))

/**
 * Whether to print the shipped credential on the form.
 *
 * Only while it still works. A first run is somebody who has never seen this app being
 * asked for a password nobody gave them, and hiding the answer helps nobody — the account
 * is already reachable by anyone who can open the page. The moment it is changed, the hint
 * disappears rather than lingering as a lie.
 */
const firstRun = createServerFn({ method: 'GET' }).handler(async () => ({ default: await usingDefaultPassword() }))

const submit = createServerFn({ method: 'POST' })
  .validator((d: { username: string; password: string }) => d)
  .handler(async ({ data }) => {
    try {
      // The caller's address is read here, where the request is, and handed in — auth.ts
      // stays an ordinary module the tests can call without standing up a request.
      const { token } = await signIn(data.username, data.password, callerIp(getRequest()))
      startSession(token)
      return { ok: true as const }
    } catch (e) {
      // One message for a wrong password and an unknown username alike; auth.ts decides
      // that, not this. Rate-limit refusals come through as themselves, because being told
      // to wait is actionable and gives nothing away.
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  })

export const Route = createFileRoute('/login')({
  // Already signed in? There is nothing to do here.
  beforeLoad: async () => {
    if (await whoami()) throw redirect({ to: HOME })
  },
  loader: () => firstRun(),
  component: Login,
})

function Login() {
  const router = useRouter()
  const submitFn = useServerFn(submit)
  const { default: isDefault } = Route.useLoaderData()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const go = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = await submitFn({ data: { username, password } })
      if (r.ok) {
        await router.invalidate()
        router.navigate({ to: HOME })
      } else setErr(r.error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="authpage">
      <form className="card authcard" onSubmit={go}>
        <span className="brand" style={{ padding: 0, marginBottom: 10 }}>
          <Logo />
          <span>
            Arlo<span> Desktop</span>
          </span>
        </span>
        <h1 style={{ fontSize: 26, marginBottom: 4 }}>Sign in</h1>
        <p className="note" style={{ marginTop: 0, marginBottom: 20 }}>
          This machine's workspace and its knowledge base.
        </p>

        <div className="fields" style={{ gridTemplateColumns: '1fr' }}>
          <div>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              autoComplete="username"
              required
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>

        {err && (
          <p className="err" role="alert">
            {err}
          </p>
        )}

        <button className="primary" disabled={busy} style={{ marginTop: 16, width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {isDefault && (
          <p className="note" style={{ marginTop: 16, marginBottom: 0 }}>
            First run — sign in with <strong>{DEFAULT_USER}</strong> / <strong>{DEFAULT_PASSWORD}</strong>, then
            change both in Settings. Anyone who can reach this page can use them too.
          </p>
        )}

        <OutboundSignInLinks />
      </form>
    </div>
  )
}
