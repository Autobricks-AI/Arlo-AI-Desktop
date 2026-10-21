import { createFileRoute } from '@tanstack/react-router'
import { asSystem } from '../server/db'
import { byToken, liveToken } from '../server/resources'

/**
 * A file a bot sent to a customer.
 *
 * Public, and it has to be: the address arrives in a WhatsApp message that gets forwarded
 * to a colleague, opened on a phone that has never signed in to anything. There is no
 * session to check, so the token is the whole authority — 24 random bytes, unguessable and
 * un-walkable, and deleting the resource is what revokes it.
 *
 * A system read for the same reason: nothing here knows which workspace it is in until the
 * token says.
 *
 * The MIME served is never trusted as-is. It is whatever the uploader's browser reported
 * at upload time (`file.type`, in the chatbot editor) with nothing checking it server-side
 * — so a resource uploaded as `text/html` would otherwise render as a page on this app's
 * own origin, unauthenticated, with every signed-in visitor's cookies live behind it.
 * `api.attachment.$id.ts` already draws this line correctly for the other public file
 * route; this is the same gate.
 */

/**
 * The headers this route relaxes, and the reason they are a constant.
 *
 * `sandbox` is what makes a file safe to show: it is inert, whatever it claims to be.
 * `frame-ancestors 'self'` then lets our own pages put it in an iframe — the only way to look
 * at a PDF without leaving the queue — while still refusing every other origin. The global
 * rule is `'none'`, and the `x-frame-options` beside it has to be relaxed in step or the older
 * header wins and Firefox refuses the frame on its own.
 *
 * **Every response from this route carries both, including the 304, and that is not tidiness.**
 * `withSecurityHeaders` in server.ts fills in any header a handler did not set, so a response
 * that leaves them out gets the global `DENY` and `frame-ancestors 'none'`. A cache must then
 * update its stored entry with the fields from the 304 (RFC 9111 §4.3.4), so a 304 missing these
 * two would overwrite the permissive copies on the already-cached 200 — and PDF previews would
 * stop framing about a day later, on a file that worked yesterday, with nothing in the diff to
 * explain it. One object spread into both responses is what stops them drifting apart again.
 */
const FRAMEABLE = {
  'content-security-policy': "default-src 'none'; sandbox; frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
  // Never let a browser guess at the bytes, and never let the response act as a page even if
  // something upstream is ever wrong about the type again.
  'x-content-type-options': 'nosniff',
  // The token names one immutable file, so this can never go stale — and is also why the token
  // itself is a sound strong validator.
  'cache-control': 'public, max-age=86400',
} as const

/** Inline for the things a browser renders safely, matching api.attachment.$id.ts. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/

export const Route = createFileRoute('/api/resource/$token')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        // Shape-checked before it reaches a query: this is the one identifier in the app
        // that arrives from a stranger with no session behind it.
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(params.token)) return new Response('Not found', { status: 404 })

        /*
         * The token is its own validator, because it names bytes that never change.
         *
         * Worth the few lines on this route specifically: a WhatsApp template header is a URL
         * Meta fetches for itself and comes back to — it caches by address for upwards of forty
         * minutes and then may ask again — so a broadcast of a four-megabyte brochure otherwise
         * reads the same `bytea` out of Postgres once per region per expiry, to send bytes the
         * other end already has.
         *
         * **Checked against the row, not answered from the token alone.** Deleting the resource
         * is what revokes the link, and a 304 issued without looking would keep handing a
         * cached copy back after it had been revoked — which is the one promise this route
         * makes. So the cheap query runs, and only the file is skipped. `max-age` stays where
         * it was for the same reason: a longer window would weaken revocation whatever this
         * does, and that is not a trade a cache hit is worth.
         */
        const etag = `"${params.token}"`
        if (request.headers.get('if-none-match') === etag) {
          if (!(await asSystem(() => liveToken(params.token))))
            return new Response('Not found', { status: 404 })
          return new Response(null, { status: 304, headers: { ...FRAMEABLE, etag } })
        }

        const found = await asSystem(() => byToken(params.token))
        if (!found?.bytes) return new Response('Not found', { status: 404 })

        const mime = found.mime ?? 'application/octet-stream'
        const name = found.title.replace(/["\\]/g, '')
        // Everything outside the allowlist forces a download instead of guessing — a
        // spreadsheet or a Word doc a business genuinely sends is still reachable, just not
        // rendered on this origin.
        const safe = INLINE.test(mime)

        return new Response(new Uint8Array(found.bytes), {
          headers: {
            // The true type either way — a forced download below is what makes the unsafe
            // case safe, not hiding what the file actually is.
            'content-type': mime,
            /*
             * inline, not attachment, for the shapes above: most of these are a PDF or an
             * image somebody wants to look at on a phone, and a forced download is a worse
             * answer to "can you send me the price list". Everything else downloads.
             */
            'content-disposition': `${safe ? 'inline' : 'attachment'}; filename="${name}"`,
            // Framing, sniffing and caching, shared with the 304 so the two cannot disagree.
            ...FRAMEABLE,
            etag,
          },
        })
      },
    },
  },
})
