/**
 * Which providers this instance can finish a consent flow for, and who finishes each one.
 *
 * There was an allowlist here before this file existed, and it was `EMAIL_IDS`: the callback
 * route checked the provider in the path against the two mailbox providers and handed the
 * code to `email.callback()`. That works for exactly as long as every OAuth connector is a
 * mailbox. A Facebook Page, an Instagram account and a TikTok business account are not, and
 * adding one of their names to `EMAIL_IDS` would put it in the mailbox provider union, the
 * mailbox size table and the connectors page's mailbox section — the wrong table, not a near
 * miss.
 *
 * So the allowlist is a registry. Each entry carries where to send the browser, where to
 * spend the code, what to ask for, and — the field that makes this a registry rather than a
 * table of URLs — `finish`, which is what stops the route knowing that mailboxes exist. The
 * route's job shrinks to: reject an unknown provider, refuse a callback with no code, redeem
 * the state, exchange the code, call `finish`.
 *
 * ---------------------------------------------------------------- what decides the workspace
 *
 * Not the session, and this is the one property in here worth reading twice. `redeem()` in
 * `oauthstate.ts` is what says which workspace a callback belongs to, because the state row
 * was written when somebody signed in to that workspace pressed Connect. `finish` therefore
 * *receives* a workspace id rather than looking one up, and it is the first argument like
 * every other server function that touches data. The attack this closes is written out at
 * the top of `oauthstate.ts`; the ordinary failure it avoids is a browser that declines to
 * send our cookie back from the provider's own site.
 *
 * PKCE is issued for every provider and verified by the ones that support it. `issue()`
 * mints a verifier and a challenge on every call and costs one hash, so there is no branch
 * to write: a provider that ignores `code_challenge` ignores it, and the state binding —
 * which is the part that actually stops the attack — works identically either way.
 *
 * ---------------------------------------------------------------- what is deliberately absent
 *
 * **Per-workspace OAuth applications.** `connector_configs` exists for a workspace bringing
 * its own client id and secret and has had no consumer since `006_channels.sql`. It gets
 * none here: one app per instance means one signing secret, and one secret is what lets a
 * webhook verify a signature without first trusting the body that says which workspace sent
 * it.
 *
 * **Dynamic client registration, discovery documents, anything read at runtime.** A handful
 * of hardcoded entries in a typed object is the whole requirement.
 *
 * ponytail: `gmail` and `outlook` are declared here *as well as* in `channels/email.ts`'s
 * private `SPEC`, because consent still starts through `email.authUrl()` while the callback
 * now comes back through this registry. Two copies of two URLs, and the ceiling is that they
 * can drift. The upgrade path is one deletion: when `email.ts` is next opened, drop its
 * `SPEC` and its `callback()` and point `authUrl()` at `authUrl()` below. That is a change
 * against a live mailbox path and it belongs in its own commit, not in the middle of
 * building three channels.
 */
import { randomBytes } from 'node:crypto'
import { one, run, withWorkspace } from './db.ts'
import { issue } from './oauthstate.ts'
import { seal } from './secrets.ts'

/** What a token endpoint hands back. Every provider here speaks some subset of this. */
export type Tokens = {
  access_token: string
  refresh_token?: string
  /** Seconds, per RFC 6749. Absent means "the provider did not say", not "forever". */
  expires_in?: number
  /** Seconds, and only where the refresh credential expires separately. TikTok does. */
  refresh_expires_in?: number
  /** Whatever else came back. TikTok's account id and Meta's granted scopes ride here. */
  [key: string]: unknown
}

/**
 * How a connection's access token is kept alive. Declared rather than inferred, because
 * "the token looks expired" and "there is a grant that can mint another one" are different
 * questions and only the provider knows the second.
 *
 * `lazy` refreshes on use, which is the only mode anything here needs: every provider below
 * holds a refresh token that outlives any quiet period.
 */
export type RefreshMode = 'none' | 'lazy'

export type Provider = {
  /** The consent URL the browser is sent to. */
  authorize: string
  /** The code-exchange and refresh endpoint. */
  token: string
  /** Space separated, per the provider's own spelling. */
  scopes: string
  /** Quirks that belong on the consent URL and nowhere else. */
  extra: Record<string, string>
  /** The two environment variables holding this instance's app credentials. */
  env: { id: string; secret: string }
  /** What `tokens.fresh()` is allowed to do when the access token is close to expiry. */
  refresh: RefreshMode
  /**
   * Finish the flow: store what came back and say what to call the thing that connected.
   * The label is shown to whoever pressed Connect, so it is the account's own name.
   */
  finish: (workspaceId: number, tokens: Tokens, base: string) => Promise<{ label: string }>
  /**
   * How this provider spends a refresh credential, when it is not the RFC 6749 default of
   * `grant_type=refresh_token`. Instagram is the case that needs it: `ig_refresh_token`
   * takes the current *access* token and hands back a new one, so there is no refresh token
   * to send and the default would post an empty parameter and read the refusal as fatal.
   */
  renew?: (held: { access: string | null; refresh: string | null }) => Promise<Tokens>
  /**
   * How this provider spends an authorization code, when it is not the RFC 6749 default that
   * `exchange()` implements — a form-encoded POST carrying `code`, answering a top-level
   * `access_token`. TikTok is the case that needs it: its business host wants a JSON body
   * naming the code `auth_code`, and answers `{ code, message, data: { access_token, … } }`.
   * `exchange()` reads that successful grant as a refusal and throws before `finish` is ever
   * reached, so the connection can never complete.
   *
   * Symmetric with `renew` above and for the same reason: the provider's own spelling belongs
   * beside the provider, not as a branch inside the shared path that every other one pays for.
   */
  spend?: (code: string, redirectUri: string, verifier: string | null) => Promise<Tokens>
}

// ---------------------------------------------------------------- the registry

/**
 * Every provider this instance can finish a flow for.
 *
 * Mutable, and `register()` below is why: a channel declares its own entry next to its own
 * `finish`, so this module never imports a channel module. That is not tidiness: a channel
 * importing this file while this file imported the channel would close a cycle, and
 * module-evaluation order is not worth debugging twice. Registration happens when the channel
 * module is first loaded, which
 * `channels/index.ts` does for every channel at boot.
 */
export const PROVIDERS: Record<string, Provider> = {
  gmail: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    // access_type=offline plus prompt=consent is the only combination Google reliably
    // returns a refresh token for — without it a reconnect silently yields none, and the
    // mailbox stops syncing an hour later for no visible reason.
    extra: { access_type: 'offline', prompt: 'consent' },
    env: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
    // Mailboxes are not on the token service yet: they have no `expires_at` to check and
    // the poller's serialization means they have no race to fix. The mode is what they
    // would be if they were, and it is what stops a sweep ever selecting one.
    refresh: 'lazy',
    finish: (workspaceId, tokens) => connectMailbox(workspaceId, 'gmail', tokens),
  },
  outlook: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: 'offline_access User.Read Mail.Read Mail.Send',
    extra: {},
    env: { id: 'OUTLOOK_CLIENT_ID', secret: 'OUTLOOK_CLIENT_SECRET' },
    refresh: 'lazy',
    finish: (workspaceId, tokens) => connectMailbox(workspaceId, 'outlook', tokens),
  },
}

/**
 * Declare a provider. Called by the channel that owns it, at module load.
 *
 * Refuses to replace an entry rather than silently taking the last one loaded: two modules
 * claiming `instagram` is a mistake somebody has to see, and the failure mode of the quiet
 * version is a callback finishing into the wrong table.
 */
export function register(id: string, provider: Provider) {
  if (PROVIDERS[id] && PROVIDERS[id] !== provider)
    throw new Error(`Two modules both claim the OAuth provider "${id}"`)
  PROVIDERS[id] = provider
}

/** The entry, or a refusal naming the provider rather than `undefined` three frames later. */
export const spec = (provider: string): Provider => {
  const found = PROVIDERS[provider]
  if (!found) throw new Error(`No OAuth provider called "${provider}"`)
  return found
}

/** Does this instance have an app registered for that provider at all? */
export const configured = (provider: string) => {
  const found = PROVIDERS[provider]
  return !!found && !!process.env[found.env.id] && !!process.env[found.env.secret]
}

const credentials = (provider: string) => {
  const { env } = spec(provider)
  const clientId = process.env[env.id]
  const clientSecret = process.env[env.secret]
  if (!clientId || !clientSecret)
    throw new Error(`${provider} is not configured on this server — set ${env.id} and ${env.secret}`)
  return { clientId, clientSecret }
}

/**
 * Where the provider sends the browser back.
 *
 * One shape for every provider, because it is also what has to be typed into each
 * provider's own console, and a per-provider shape is a per-provider mistake.
 */
export const redirectUrl = (base: string, provider: string) =>
  `${base.replace(/\/+$/, '')}/api/oauth/${provider}`

// ---------------------------------------------------------------- consent

/** Where to send somebody to grant access. */
export async function authUrl(workspaceId: number, provider: string, base: string) {
  const { clientId } = credentials(provider)
  const { state, challenge } = await issue(workspaceId, provider)

  const url = new URL(spec(provider).authorize)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUrl(base, provider))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', spec(provider).scopes)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(spec(provider).extra)) url.searchParams.set(k, v)
  return url.href
}

/**
 * One call to a token endpoint, for a code exchange or a refresh.
 *
 * Form-encoded with the client credentials in the body, which every provider here accepts
 * and which avoids a second code path for the ones that also take Basic auth. The error
 * message is the provider's own words where it gave any, because "the provider refused"
 * without them is a support ticket rather than an answer.
 */
export async function exchange(provider: string, body: Record<string, string>): Promise<Tokens> {
  const { clientId, clientSecret } = credentials(provider)
  const res = await fetch(spec(provider).token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
    signal: AbortSignal.timeout(30_000),
  })
  const json = (await res.json().catch(() => ({}))) as Tokens & { error_description?: string; error?: string }
  if (!res.ok || !json.access_token) {
    const said = json.error_description || json.error || `${res.status}`
    const error = new Error(`${provider} refused the token request: ${said}`)
    /*
     * Whether the refresh can ever work again, decided here rather than by reading the
     * message downstream. A 4xx on a token endpoint is the credential being rejected — the
     * grant is spent, revoked or was never valid — and no amount of retrying recovers it.
     * A 5xx or a timeout is the provider having a bad afternoon, which is `last_error` and
     * nothing more. Only the first should ever ask somebody to reconnect.
     */
    ;(error as Error & { rejected?: boolean }).rejected = res.status >= 400 && res.status < 500
    throw error
  }
  return json
}

// ---------------------------------------------------------------- mailboxes, for now

/**
 * Store a connected mailbox and say which address it was.
 *
 * This is `email.callback()`'s tail, moved here because the route may no longer import a
 * channel module to finish a flow. Its head — redeeming the state and spending the code —
 * is now the route's, done through this registry for every provider alike.
 */
async function connectMailbox(workspaceId: number, provider: 'gmail' | 'outlook', tokens: Tokens) {
  if (!tokens.refresh_token)
    throw new Error(`${provider} did not return a refresh token. Remove this app's access and connect again.`)

  const address = await whoami(provider, tokens.access_token)
  const refresh = seal(tokens.refresh_token)

  /*
   * The scope opens here rather than around the whole callback: the state has to be redeemed
   * before the workspace is known, and mailboxes are behind row-level security.
   */
  await withWorkspace({ workspaceId }, async () => {
    // One row per address per provider. Reconnecting replaces the token rather than creating
    // a second mailbox that syncs the same mail twice.
    const existing = await one<{ id: string }>(
      `SELECT id FROM mailboxes WHERE workspace_id = ? AND provider = ? AND lower(address) = lower(?)`,
      workspaceId,
      provider,
      address,
    )
    if (existing) {
      await run(`UPDATE mailboxes SET refresh_enc = ?, last_error = NULL WHERE id = ?`, refresh, existing.id)
      return
    }
    await run(
      `INSERT INTO mailboxes (id, workspace_id, provider, address, refresh_enc) VALUES (?,?,?,?,?)`,
      randomBytes(8).toString('hex'),
      workspaceId,
      provider,
      address,
      refresh,
    )
  })

  return { label: address }
}

async function whoami(provider: 'gmail' | 'outlook', accessToken: string) {
  const url =
    provider === 'gmail'
      ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
      : 'https://graph.microsoft.com/v1.0/me'
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`Could not read the account: ${provider} said ${res.status}`)
  const json = (await res.json()) as { emailAddress?: string; mail?: string; userPrincipalName?: string }
  const address = json.emailAddress ?? json.mail ?? json.userPrincipalName
  if (!address) throw new Error('That account has no email address')
  return address
}
