import { createFileRoute, redirect } from '@tanstack/react-router'
import { PROVIDERS, callback } from '../server/channels/email'
import type { Provider } from '../server/channels/email'

/**
 * Where a mailbox provider sends the browser back after consent.
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
        const provider = params.provider as Provider
        if (!PROVIDERS.includes(provider)) return new Response('Unknown provider', { status: 404 })

        const url = new URL(request.url)
        const denied = url.searchParams.get('error')
        if (denied) throw back(`${provider} said: ${denied}`, false)

        const code = url.searchParams.get('code')
        if (!code) throw back('That sign-in did not come back with a code.', false)

        let connected: Awaited<ReturnType<typeof callback>>
        try {
          connected = await callback(provider, code, url.searchParams.get('state'), base(request))
        } catch (e) {
          throw back(e instanceof Error ? e.message : String(e), false)
        }
        // Named, because somebody connecting a second mailbox needs to know which one this was.
        throw back(`${connected.address} connected.`, true)
      },
    },
  },
})
