import { createFileRoute } from '@tanstack/react-router'
import { asSystem } from '../server/db'
import { byToken } from '../server/resources'

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

/** Inline for the things a browser renders safely, matching api.attachment.$id.ts. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/

export const Route = createFileRoute('/api/resource/$token')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // Shape-checked before it reaches a query: this is the one identifier in the app
        // that arrives from a stranger with no session behind it.
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(params.token)) return new Response('Not found', { status: 404 })

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
            // The token names one immutable file, so this can never go stale.
            'cache-control': 'public, max-age=86400',
            // Never let a browser guess at the bytes, and never let the response act as a
            // page even if something upstream is ever wrong about the type again.
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
          },
        })
      },
    },
  },
})
