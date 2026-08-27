import { createFileRoute } from '@tanstack/react-router'
import { handle } from '../server/agent'
import { find, messages } from '../server/conversations'
import { forMessages } from '../server/attachments'
import { withWorkspace } from '../server/db'
import { forKey } from '../server/channels/web'
import { WEBHOOK, take } from '../server/throttle'

/**
 * The web widget's endpoint.
 *
 * Public by design: it is called from the customer's own website by people who are not
 * signed in to anything. That shapes every decision here.
 *
 *   identity     a `key` in the query string names one widget, and through it the
 *                workspace. Not the ingest token — that is a bearer secret and this URL is
 *                in the page source of every visitor. See migrations/010_web_widgets.sql.
 *   the visitor  a random token the widget keeps in localStorage. It is the thread's
 *                identity and the customer's, and it is theirs to lose: clearing storage
 *                starts a new conversation, which is the right behaviour on a shared
 *                computer.
 *   no cookies   so `Access-Control-Allow-Origin: *` is safe. There is no ambient
 *                authority for another origin to borrow.
 *   rate limit   per visitor, before anything else happens.
 */

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  // No credentials, no varying by origin — see above.
  'cache-control': 'no-store',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } })

/**
 * The thread this visitor is in, on this widget.
 *
 * The widget id is part of the reference for the same reason the bot id is on Telegram and
 * the account id on WhatsApp: a workspace runs more than one of these, and two sites
 * sharing a browser must not share a conversation.
 */
const ref = (widgetId: string, visitor: string) => `${widgetId}:${visitor}`

/** A visitor token has to be ours in shape, or it is a way to write arbitrary keys into our tables. */
const validVisitor = (v: string) => /^[A-Za-z0-9_-]{16,64}$/.test(v)

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: cors }),

      /** Poll: everything in this thread after `since`. */
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const key = url.searchParams.get('key') ?? ''
        const visitor = url.searchParams.get('visitor') ?? ''
        if (!validVisitor(visitor)) return json({ error: 'Bad visitor token' }, 400)

        const widget = await forKey(key)
        if (!widget) return json({ error: 'Unknown widget key' }, 404)
        const workspaceId = widget.workspace_id

        const since = Number(url.searchParams.get('since') ?? 0)
        return withWorkspace({ workspaceId }, async () => {
          const conversation = await find(workspaceId, 'web', ref(widget.id, visitor))
          if (!conversation) return json({ messages: [], status: 'bot' })
          const all = await messages(workspaceId, conversation.id)
          const fresh = all.filter((m) => m.id > since)

          /*
           * The files that went out with these messages.
           *
           * Addressed by the resource's own token rather than `/api/attachment/<id>`: that
           * route wants a signed-in session, and a visitor on somebody's website has not got
           * one. The resource route is token-authenticated and public, which is exactly the
           * case it was built for.
           */
          const files = await forMessages(workspaceId, fresh.map((m) => m.id))
          const enclosures = (id: number) =>
            files
              .filter((f) => f.message_id === id && f.external_ref?.startsWith('resource:'))
              .map((f) => ({ name: f.name, url: `/api/resource/${f.external_ref!.slice('resource:'.length)}` }))

          return json({
            status: conversation.status,
            messages: fresh.map((m) => ({
              id: m.id,
              direction: m.direction,
              body: m.body,
              at: m.created_at,
              files: enclosures(m.id),
            })),
          })
        })
      },

      /** Ask a question. */
      POST: async ({ request }) => {
        const url = new URL(request.url)
        const key = url.searchParams.get('key') ?? ''

        let body: { visitor?: string; text?: string; name?: string; email?: string }
        try {
          body = (await request.json()) as typeof body
        } catch {
          return json({ error: 'Expected JSON' }, 400)
        }

        const visitor = body.visitor ?? ''
        if (!validVisitor(visitor)) return json({ error: 'Bad visitor token' }, 400)

        const text = (body.text ?? '').trim().slice(0, 4000)
        if (!text) return json({ error: 'Nothing to answer' }, 400)

        // Counted per visitor before the workspace is even looked up, so a flood costs one
        // upsert rather than a model call.
        const wait = await take(`chat:${key}:${visitor}`, WEBHOOK)
        if (wait) return json({ error: 'Too many messages. Slow down.' }, 429)

        const widget = await forKey(key)
        if (!widget) return json({ error: 'Unknown widget key' }, 404)
        const workspaceId = widget.workspace_id

        return withWorkspace({ workspaceId }, async () => {
          const result = await handle(workspaceId, {
            channel: 'web',
            channelRef: ref(widget.id, visitor),
            from: visitor,
            text,
            name: body.name?.slice(0, 120) ?? null,
            email: body.email?.slice(0, 200) ?? null,
          })
          return json({ status: result.status, reply: result.reply })
        })
      },
    },
  },
})
