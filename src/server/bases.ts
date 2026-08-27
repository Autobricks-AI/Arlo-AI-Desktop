/**
 * Knowledge bases: a workspace's material, in more than one pile.
 *
 * A base is a body of knowledge with a purpose — the public help centre, the internal
 * handbook, last year's product catalogue. Sources go into one, bots are connected to
 * whole bases, and that is the entire mechanism: what a bot can answer from is the union
 * of the bases it has been given.
 *
 * The alternative, which this replaces, was pointing a bot at individual crawled sites
 * plus a boolean for the uploaded files. It could not express "the internal handbook" at
 * all, and every source added later had to be ticked onto every bot by hand.
 */
import { all, insert, one, run } from './db.ts'
import { STANDARD_BASES } from '../types.ts'

export type Base = {
  id: number
  name: string
  description: string
  created_at: string
}

/** What a base is worth showing in a list: how much is in it, and whether it can answer. */
export type BaseSummary = Base & {
  sites: number
  files: number
  documents: number
  passages: number
  /** True while a crawl or an upload in this base is still working. */
  busy: boolean
}

/**
 * Give a workspace the standard empty categories, and return their ids.
 *
 * All four are customer-facing, so all four are what a default bot is connected to. Keeping
 * material *away* from a bot is still a first-class thing to do — it is what an unticked
 * base is — but it is a decision about one company's material rather than a category every
 * company starts with.
 */
export async function seed(workspaceId: number): Promise<number[]> {
  const made: number[] = []
  for (const b of STANDARD_BASES) made.push((await create(workspaceId, b.name, b.description)).id)
  return made
}

export const list = (workspaceId: number) =>
  all<BaseSummary>(
    `SELECT k.id, k.name, k.description, k.created_at,
            (SELECT count(*)::int FROM sites     s WHERE s.base_id = k.id) AS sites,
            (SELECT count(*)::int FROM uploads   u WHERE u.base_id = k.id) AS files,
            (SELECT count(*)::int FROM documents d WHERE d.base_id = k.id) AS documents,
            (SELECT count(*)::int FROM chunks c JOIN documents d ON d.id = c.document_id
              WHERE d.base_id = k.id)                                      AS passages,
            (  EXISTS (SELECT 1 FROM sites   s WHERE s.base_id = k.id AND s.status IN ('queued','running'))
            OR EXISTS (SELECT 1 FROM uploads u WHERE u.base_id = k.id AND u.status IN ('queued','running'))
            )                                                              AS busy
       FROM knowledge_bases k
      WHERE k.workspace_id = ?
      ORDER BY k.created_at`,
    workspaceId,
  )

export const get = (workspaceId: number, id: number) =>
  one<Base>(
    `SELECT id, name, description, created_at FROM knowledge_bases WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )

/**
 * The base a workspace lands in when nothing says otherwise.
 *
 * Created on demand rather than being a column on `workspaces`: the oldest base is the
 * default by construction, and a column would be one more thing that can point at a row
 * somebody deleted.
 */
export async function first(workspaceId: number): Promise<Base> {
  const found = await one<Base>(
    `SELECT id, name, description, created_at FROM knowledge_bases
      WHERE workspace_id = ? ORDER BY created_at, id LIMIT 1`,
    workspaceId,
  )
  if (found) return found
  // A workspace with none is a workspace something went wrong in. Seed it rather than
  // returning nothing, so no page has to handle "there is nowhere to put this".
  await seed(workspaceId)
  return (await first(workspaceId))!
}

export async function create(workspaceId: number, name: string, description = ''): Promise<Base> {
  const clean = name.trim().slice(0, 120)
  if (!clean) throw new Error('Give it a name first.')
  const id = await insert(
    `INSERT INTO knowledge_bases (workspace_id, name, description) VALUES (?,?,?)`,
    workspaceId,
    clean,
    description.trim().slice(0, 500),
  )
  return (await get(workspaceId, id))!
}

export async function rename(workspaceId: number, id: number, name: string, description: string) {
  const clean = name.trim().slice(0, 120)
  if (!clean) throw new Error('Give it a name first.')
  const { changes } = await run(
    `UPDATE knowledge_bases SET name = ?, description = ? WHERE workspace_id = ? AND id = ?`,
    clean,
    description.trim().slice(0, 500),
    workspaceId,
    id,
  )
  if (!changes) throw new Error('No such knowledge base')
}

/**
 * Delete a base and everything filed in it.
 *
 * The cascades do the work — sites, uploads, documents and their passages all hang off
 * `base_id`. The last one cannot go: a workspace with no knowledge base has nowhere to put
 * the next thing somebody adds, and the page would have to invent one anyway.
 */
export async function remove(workspaceId: number, id: number) {
  const { n } = (await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM knowledge_bases WHERE workspace_id = ?`,
    workspaceId,
  ))!
  if (n <= 1) throw new Error('This is the only knowledge base. Make another one before removing it.')

  const { changes } = await run(`DELETE FROM knowledge_bases WHERE workspace_id = ? AND id = ?`, workspaceId, id)
  if (!changes) throw new Error('No such knowledge base')
}

// ---------------------------------------------------------------- per bot

/** Which bases this bot may answer from. Empty means none, which is the default. */
export const forBot = (workspaceId: number, botId: number) =>
  all<{ base_id: number }>(`SELECT base_id FROM bot_bases WHERE workspace_id = ? AND bot_id = ?`, workspaceId, botId)

export async function setForBot(workspaceId: number, botId: number, baseIds: number[]) {
  await run(`DELETE FROM bot_bases WHERE workspace_id = ? AND bot_id = ?`, workspaceId, botId)
  for (const id of [...new Set(baseIds)])
    // The SELECT is what refuses a base belonging to another workspace.
    await run(
      `INSERT INTO bot_bases (bot_id, base_id, workspace_id)
         SELECT ?, k.id, ? FROM knowledge_bases k WHERE k.workspace_id = ? AND k.id = ?
         ON CONFLICT DO NOTHING`,
      botId,
      workspaceId,
      workspaceId,
      id,
    )
}
