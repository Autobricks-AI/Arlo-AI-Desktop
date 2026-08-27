/**
 * The web chat widget.
 *
 * The simplest possible channel, and the reason it was built first: no third-party
 * account, no OAuth, no webhook to expose — so the whole inbound-to-reply loop can be
 * exercised end to end on the first day, and every channel after it is a variation on a
 * path that already works.
 *
 * "Sending" is storing. The widget polls `/api/chat` for messages after the last id it
 * saw, so an outbound message is delivered by the act of being recorded.
 *
 * ponytail: polling, not a socket. A socket per visitor means connection state in a
 * process that gets forked, and a poll every two seconds is indistinguishable from live
 * in a support chat. Swap in server-sent events if a conversation ever needs to feel
 * faster than that.
 */
import { randomBytes } from 'node:crypto'
import { all, asSystem, one, run } from '../db.ts'
import type { Conversation } from '../conversations.ts'
import { removeConnection } from '../conversations.ts'

export const id = 'web'
export const label = 'Web chat'

/**
 * One row per embedded snippet, so a workspace can run several sites at once.
 *
 * `key` is public — it sits in the page source wherever the tag is pasted — and names the
 * widget rather than the workspace. That is what makes one site revocable without taking
 * the others down, and what says which site a question arrived from.
 */
export type Widget = { id: string; label: string; key: string; created_at: string }

export const list = (workspaceId: number) =>
  all<Widget>(
    `SELECT id, label, key, created_at FROM web_widgets WHERE workspace_id = ? ORDER BY created_at`,
    workspaceId,
  )

export async function add(workspaceId: number, label?: string) {
  const widgetId = randomBytes(8).toString('hex')
  await run(
    `INSERT INTO web_widgets (id, workspace_id, label, key) VALUES (?,?,?,?)`,
    widgetId,
    workspaceId,
    label?.trim().slice(0, 120) || 'Website',
    randomBytes(16).toString('hex'),
  )
  // The row rather than the id: whoever just added a site wants its snippet, and the key
  // is the only part of it that is not already known.
  return (await one<Widget>(
    `SELECT id, label, key, created_at FROM web_widgets WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    widgetId,
  ))!
}

export async function remove(workspaceId: number, widgetId: string) {
  // Looked up rather than inferred from the delete's row count, so the threads can go first.
  const found = await one<{ id: string }>(
    `SELECT id FROM web_widgets WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    widgetId,
  )
  if (!found) throw new Error('No such widget')

  // The chats this widget carried. Nothing can answer them once it is gone — the public key
  // stops resolving — so they would sit in the inbox as rows that only ever error. This order
  // leaves the widget still listed if it fails, which is retryable; the reverse leaves the
  // orphans that are the whole problem.
  await removeConnection(workspaceId, id, widgetId)
  await run(`DELETE FROM web_widgets WHERE workspace_id = ? AND id = ?`, workspaceId, widgetId)
}

/**
 * The widget a public key belongs to, or null.
 *
 * A system read, and the only one this channel has: the caller is an anonymous visitor on
 * somebody else's website, so which workspace to open is exactly what this decides.
 */
export const forKey = (key: string) =>
  asSystem(() =>
    one<{ id: string; workspace_id: number; label: string }>(
      `SELECT id, workspace_id, label FROM web_widgets WHERE key = ?`,
      key,
    ),
  )

export async function send(_conversation: Conversation, _text: string): Promise<string | null> {
  // Nothing to do: deliver() already recorded the message, and recording is delivery here.
  return null
}
