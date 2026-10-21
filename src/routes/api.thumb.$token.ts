import { createFileRoute } from '@tanstack/react-router'
import { asSystem } from '../server/db'
import { thumbByToken } from '../server/resources'

/**
 * A picture of a file, for the media grid.
 *
 * Public, like the file it was cut from — the same token, the same authority, nothing newly
 * exposed: anyone who can fetch this could already fetch the brochure it is a picture of. A
 * session here would buy nothing and would be a second gate to keep in step with the first.
 *
 * ---------------------------------------------------------------- why not ?thumb on the resource route
 *
 * That route's ETag *is* the token, and it is sound only because the token names one immutable
 * file. Hanging a second body off the same name is how a cache ends up serving a thumbnail as a
 * brochure, or a brochure as a thumbnail — and the comment there that explains the whole 304
 * path would stop being true the moment it happened.
 *
 * A sibling path keeps that invariant exactly as written, and needs no ETag of its own: these
 * are ten kilobytes under a day of `max-age`, so a conditional request would save nothing worth
 * the branch.
 */
export const Route = createFileRoute('/api/thumb/$token')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // The same shape gate the resource route uses, for the same reason: an identifier from
        // a stranger, checked before it reaches a query.
        if (!/^[A-Za-z0-9_-]{16,64}$/.test(params.token)) return new Response('Not found', { status: 404 })

        const bytes = await asSystem(() => thumbByToken(params.token))
        // No preview was made, or the object is gone. Either way the card falls back to its
        // badge on the 404, which is what it draws when it never asks at all.
        if (!bytes) return new Response('Not found', { status: 404 })

        return new Response(new Uint8Array(bytes), {
          headers: {
            // We made these bytes, so we know what they are. The one thing this route can say
            // with certainty that the resource route cannot.
            'content-type': 'image/webp',
            /*
             * Tighter than the resource route's headers, because nothing needs to frame this.
             * It is drawn in an `img`, never opened on its own, so `default-src 'none'` with no
             * frame-ancestors relaxation is the whole policy.
             */
            'content-security-policy': "default-src 'none'",
            'x-content-type-options': 'nosniff',
            'cache-control': 'public, max-age=86400',
          },
        })
      },
    },
  },
})
