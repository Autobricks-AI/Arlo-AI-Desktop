import { createFileRoute } from '@tanstack/react-router'
import { currentSession } from '../server/auth'
import { open } from '../server/attachments'

/**
 * A file from a conversation, served to the inbox.
 *
 * The opposite of a resource in every way that matters. A resource goes *to* customers, so
 * it is addressed by a public token. This is a customer's own file — a receipt, a photo of
 * an ID, whatever they happened to send — so it is served only to somebody signed in to the
 * workspace that received it, and the workspace scope does the rest: an id from another
 * tenant reads as one that does not exist.
 */

/** Inline for the things a browser renders safely; a download for everything else. */
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/

export const Route = createFileRoute('/api/attachment/$id')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const id = Number(params.id)
        if (!Number.isInteger(id) || id <= 0) return new Response('Not found', { status: 404 })

        const session = await currentSession()
        if (!session) return new Response('Not signed in', { status: 401 })

        // The tenant scope is already open around the request — see server.ts.
        const found = await open(session.workspaceId, id)
        // No bytes means the row is a record of a file we did not keep — see attachments.ts.
        if (!found?.bytes) return new Response('Not found', { status: 404 })

        const mime = found.mime ?? 'application/octet-stream'
        const name = found.name.replace(/["\\]/g, '')

        return new Response(new Uint8Array(found.bytes), {
          headers: {
            'content-type': mime,
            'content-disposition': `${INLINE.test(mime) ? 'inline' : 'attachment'}; filename="${name}"`,
            /*
             * Never sniff, never frame, never cache in a shared cache. This is somebody
             * else's document served from our origin: a mislabelled HTML file rendering as
             * a page here would be a cross-site scripting hole with a session behind it.
             */
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
            'cache-control': 'private, max-age=300',
          },
        })
      },
    },
  },
})
