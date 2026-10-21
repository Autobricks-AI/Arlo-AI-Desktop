import { createFileRoute, redirect } from '@tanstack/react-router'
import { PROVIDERS, exchange, redirectUrl } from '../server/oauth'
import { redeem } from '../server/oauthstate'

/**
 * Where an OAuth provider sends the browser back after consent.
 *
 * Which provider is allowed here, and what happens once the code has been spent, both come
 * from the registry in `server/oauth.ts`. This file deliberately knows neither: it used to
 * allowlist the two mailbox providers and call into `channels/email.ts`, which is why a
 * connector that is not a mailbox could not come back through it at all.
 *
 * Which workspace is connecting comes from the `state`, not from the session — see
 * server/oauthstate.ts. That is both the safer answer and the only one that survives the
 * trip: this request arrives from the provider's own site, and a browser is entitled not
 * to send our cookie on that hop. It stopped sending it the day this deployment moved from
 * http to https, and the consent was lost with a bounce to the sign-in page.
 *
 * So no session is required to finish a flow. Nothing is granted by finishing one either:
 * the state is single-use, expires in ten minutes, and is only ever handed to somebody who
 * was signed in to that workspace when they pressed Connect.
 */

const base = (request: Request) => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '')
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() ?? url.protocol.slice(0, -1)
  return `${proto}://${url.host}`
}

/** Back to the connectors page, saying what happened, rather than to a blank JSON body. */
const back = (message: string, ok: boolean) =>
  redirect({ to: '/connectors', search: { [ok ? 'connected' : 'error']: message } }) as unknown as Response

export const Route = createFileRoute('/api/oauth/$provider')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const provider = params.provider
        const spec = PROVIDERS[provider]
        if (!spec) return new Response('Unknown provider', { status: 404 })

        const url = new URL(request.url)
        const denied = url.searchParams.get('error')
        if (denied) throw back(`${provider} said: ${denied}`, false)

        /*
         * `code` is RFC 6749's name and what every other provider sends. TikTok's account
         * holder flow spells it `auth_code` on the redirect — "the redirect URL will be
         * appended with an auth_code" — so both are read here rather than in a per-provider
         * branch: a provider that sends neither is the error, and one that sends either is not.
         */
        const code = url.searchParams.get('code') ?? url.searchParams.get('auth_code')
        if (!code) throw back('That sign-in did not come back with a code.', false)

        let label: string
        try {
          /*
           * The state is checked before the code is spent: an unrecognised one means this
           * callback is not a flow we started, and spending the code anyway is precisely the
           * attack the state exists to stop.
           */
          const flow = await redeem(url.searchParams.get('state'), provider)
          if (!flow) throw new Error('That sign-in link has expired or was not started here. Try connecting again.')

          /*
           * `spend` when the provider does not speak RFC 6749's default, `exchange` when it
           * does. TikTok is the only one today: JSON, the code named `auth_code`, and the
           * grant wrapped in a `data` envelope that `exchange` reads as a refusal.
           */
          const redirect = redirectUrl(base(request), provider)
          const tokens = spec.spend
            ? await spec.spend(code, redirect, flow.verifier)
            : await exchange(provider, {
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirect,
                code_verifier: flow.verifier,
              })
          ;({ label } = await spec.finish(flow.workspaceId, tokens, base(request)))
        } catch (e) {
          throw back(e instanceof Error ? e.message : String(e), false)
        }
        // Named, because somebody connecting a second account needs to know which one this was.
        throw back(`${label} connected.`, true)
      },
    },
  },
})
