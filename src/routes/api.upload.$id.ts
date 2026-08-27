import { createFileRoute } from '@tanstack/react-router'
import { sessionFrom } from '../server/auth'
import { fileOf } from '../server/uploads'

/**
 * An uploaded file, back as it went in.
 *
 * The opposite of api.resource.$token: that one is public because it is *sent* to
 * customers, this one is a company's own material and never leaves the workspace that put
 * it there. So it is the session that decides, and the workspace comes from the session —
 * `/api/upload/7` from another account resolves against that account's workspace and finds
 * nothing, which is the same answer as "no such file".
 *
 * A route rather than a server function because the answer is a file: a content type, a
 * filename and a stream of bytes, none of which survive being JSON.
 */
export const Route = createFileRoute('/api/upload/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await sessionFrom(request)
        if (!session) return new Response('Not signed in', { status: 401 })

        const id = Number(params.id)
        if (!Number.isInteger(id) || id < 1) return new Response('Not found', { status: 404 })

        // The tenant scope is already open around the request, so this reads as the
        // workspace and nothing else needs saying.
        const file = await fileOf(session.workspaceId, id)
        if (!file) return new Response('Not found', { status: 404 })

        return new Response(new Uint8Array(file.bytes), {
          headers: {
            'content-type': file.mime,
            /*
             * attachment, not inline: somebody clicking Download on their own upload wants
             * the file on their disk, not a PDF viewer in a new tab. The opposite choice
             * to a resource, for the opposite reason.
             */
            'content-disposition': `attachment; filename="${file.filename.replace(/["\\]/g, '')}"`,
            // Never let a browser guess at bytes somebody uploaded.
            'x-content-type-options': 'nosniff',
            // Private: this is one workspace's material and no proxy should hold a copy.
            'cache-control': 'private, no-store',
          },
        })
      },
    },
  },
})
