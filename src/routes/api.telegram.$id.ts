import { createFileRoute } from '@tanstack/react-router'
import { handle } from '../server/channels/telegram'

/**
 * One bot's webhook.
 *
 * Always answers 200, whatever happened. Telegram retries anything that is not a 2xx, so
 * a 500 on a message we could not process becomes a delivery loop that repeats the same
 * failure every few seconds — and the one thing worse than dropping a message is dropping
 * it forever, loudly, in a way that also delays every message behind it.
 *
 * What actually went wrong is in the response body and the logs, where a person can read
 * it, rather than in a status code only Telegram will see.
 */
export const Route = createFileRoute('/api/telegram/$id')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let update: unknown
        try {
          update = await request.json()
        } catch {
          return Response.json({ ok: true, ignored: 'not JSON' })
        }

        try {
          const result = await handle(params.id, request.headers.get('x-telegram-bot-api-secret-token'), update)

          if (result.status === 'deferred')
            return new Response(JSON.stringify({ ok: false, ...result }), {
              status: 429,
              headers: {
                'content-type': 'application/json',
                // From the limiter, not a constant: a hardcoded number either retries into the
                // same refusal or waits far longer than the window has left.
                'retry-after': String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
              },
            })

          return Response.json({ ok: true, ...result })
        } catch (e) {
          console.error('[telegram] webhook failed:', e instanceof Error ? e.message : e)
          return Response.json({ ok: true, error: 'handler failed' })
        }
      },
    },
  },
})
