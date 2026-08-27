import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { authenticate, secureCookies, usingDefaultPassword } from './server/auth.ts'
import { migrate, withWorkspace } from './server/db.ts'
import { resume } from './server/channels/whatsapp.ts'
import { startPolling } from './server/poller.ts'
import { recover as recoverCrawls } from './server/sites.ts'
import { recover as recoverUploads } from './server/uploads.ts'
import { ownsSingletons, serveSingletons, tryOwnLiveSingletons } from './server/singleton.ts'
import { resumePolling as resumeTelegram } from './server/channels/telegram.ts'

/*
 * Boot work that must happen once per *deployment*, not once per process.
 *
 * In development and in tests there is one process and this is simply the boot path. In
 * production `server/prod.mjs` forks web workers, and only the parent gets here with
 * ownsSingletons true — so the schema is applied once and one process holds the WhatsApp
 * sockets, however many workers are serving. The workers import this same module and skip
 * straight to the handler, and nothing serves a request until the parent's migrate() has
 * finished, because it forks only after.
 *
 * ownsSingletons only answers "am I a forked worker of my own cluster primary" — it cannot
 * see a second, entirely separate process (a second `vite dev`, or a prod started alongside
 * one). tryOwnLiveSingletons() answers that wider question with a Postgres session-scoped
 * advisory lock, so WhatsApp and the poller still start exactly once across every process
 * pointed at this database, not once per process. See singleton.ts.
 */
if (ownsSingletons) {
  // Applied here rather than as a side effect of importing a module, so there is one
  // place it happens and no window where a worker serves against a stale schema. Safe to
  // run from more than one process: each migration is its own transaction and
  // schema_migrations' primary key makes a second attempt a no-op.
  await migrate()

  // Neither a crawl nor a file being read can have survived the restart, so say so rather
  // than leaving a progress bar that will never move; anything still queued starts here.
  // Both are a claim-reset (`UPDATE ... WHERE status = 'running'`), safe from more than one
  // process: a second identical UPDATE matches nothing and no-ops.
  await recoverCrawls()
  await recoverUploads()

  if (await tryOwnLiveSingletons()) {
    // An already-linked WhatsApp number reconnects at boot, so a customer's message arrives
    // without anybody having opened the UI first.
    resume()

    // Any Telegram bot receiving by polling, for the same reason: a question must arrive
    // without anybody having a page open. Only here, because two processes polling one bot
    // both get updates the other never sees.
    void resumeTelegram()

    // Mail is pull-based and reminders are due at a time, so both need a timer. Started at
    // boot for the same reason: nobody should have to be logged in for either to happen.
    startPolling()
  } else {
    console.log('[boot] another process already owns WhatsApp and the poller — serving requests only')
  }

  /*
   * Said once at boot, and again on every page until it is fixed.
   *
   * The password this ships with is in the README, so it is public knowledge — the only
   * thing between this instance and anyone who can reach it is somebody actually changing
   * it. A log line alone would scroll past, which is why there is a banner too; a banner
   * alone would miss whoever runs this headless and never opens it.
   */
  if (await usingDefaultPassword())
    console.warn(
      '[auth] still using the default password (arlo/arlo) — anyone who can reach this port can sign in. Change it in Settings.',
    )
}

/** Re-exported for server/prod.mjs, which only ever sees the built bundle. */
export { serveSingletons }

const handler = createStartHandler(defaultStreamHandler)

/*
 * The app had no security headers at all before this. Every response gets these.
 *
 *   script-src / style-src 'unsafe-inline'
 *     Not a preference — a fetch of the app's own pages shows two inline <script> tags
 *     with no `src=` (scroll restoration and the streamed loader-data payload React
 *     Start injects per request), and the one CSS block in __root.tsx is an inline
 *     <style>. A CSP without 'unsafe-inline' on both would break hydration on every
 *     page load, not tighten anything. What this still buys: no *externally hosted*
 *     script or stylesheet loads, which is what a typical injected payload reaches for
 *     — `<script src="https://evil.example/x.js">` is blocked either way.
 *
 *   frame-ancestors 'none'
 *     Nothing legitimately frames this app. The embeddable widget (api.widget[.]js.ts)
 *     builds its UI directly into the customer's page with a shadow DOM and talks to
 *     /api/chat over fetch — it never puts an Arlo page in an iframe, so there is no
 *     case to carve out. This is what closes the clickjacking gap on the inbox and
 *     closes the second line of defence the resource-token route was missing.
 *
 *   connect-src 'self'
 *     Every fetch the app's own client code makes is same-origin — server functions
 *     and the API routes. Nothing here talks to a third-party endpoint from the
 *     browser (that only happens server-side, e.g. OpenRouter, which this header
 *     cannot see and does not need to).
 */
const HEADERS: Record<string, string> = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  // frame-ancestors above is what actually stops framing in every modern browser; this is
  // the same rule for the one still-relevant legacy reader.
  'x-frame-options': 'DENY',
}

/** Set once, added to every response. Skips a header a handler already chose to set. */
function withSecurityHeaders(response: Response, request: Request): Response {
  for (const [name, value] of Object.entries(HEADERS)) if (!response.headers.has(name)) response.headers.set(name, value)

  // Meaningless and occasionally rejected outright over plain http, and there is no
  // certificate to promise on a loopback dev server.
  if (secureCookies(request) && !response.headers.has('strict-transport-security'))
    response.headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains')

  return response
}

/**
 * Open the tenant scope once, around the whole request.
 *
 * Row-level security reads the workspace off the connection, so something has to put it
 * there. Doing it here means every server function and page loader inherits it without a
 * line of their own — and a request with no session simply runs unscoped, which is the
 * right answer for the sign-in form and the landing page.
 *
 * Unscoped is also *safe*: every tenant table default-denies when `app.workspace_id` is
 * unset, so a path that slips through without a scope reads nothing rather than reading
 * somebody else's knowledge base. The identity tables carry no policy, which is what lets
 * sign-in work before a workspace exists.
 *
 * The webhook endpoints are the deliberate exception: they arrive with a token instead of
 * a cookie, so they resolve their own workspace and open their own scope.
 *
 * ponytail: one transaction for the length of the request, which also spans the SSR
 * render. Nothing renders from the database — components read loader data — so the
 * transaction is idle by then. Move this to per-server-function middleware if a slow
 * render ever starts holding connections that matter.
 */
export default {
  fetch: async (request: Request): Promise<Response> => {
    /*
     * Resolving the session may renew it. This is the only place holding both the request
     * and the response, so it is the only place that can — `authenticate` hands back a
     * request carrying the new token and the cookies to put it in the browser.
     */
    const { request: req, session, cookies } = await authenticate(request)
    const response = session ? await withWorkspace(session, async () => handler(req)) : await handler(req)

    /*
     * Appended, never set. A handler that signed in or out during this same request has
     * already written its own cookies, and replacing the header would undo it — signing
     * somebody straight back out of the session they just started.
     */
    for (const cookie of cookies) response.headers.append('set-cookie', cookie)
    return withSecurityHeaders(response, request)
  },
}
