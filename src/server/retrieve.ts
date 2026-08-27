/**
 * Finding the passages an answer should be built from.
 *
 * Two ways in, and which one runs is decided by whether an embeddings provider is
 * configured — not by a setting somebody has to remember to flip:
 *
 *   embeddings   cosine nearest-neighbour over `chunks.embedding`, which finds passages
 *                that mean the same thing as the question rather than sharing its words.
 *   otherwise    Postgres full-text search over the generated `tsv` column.
 *
 * The fallback is load-bearing, not a courtesy. It is what lets the whole product be
 * exercised — and tested — with no API key at all, and what keeps a workspace answering
 * during a provider outage instead of going silent.
 */
import { all } from './db.ts'
import { configured, embed, toVector } from './embed.ts'

export type Passage = {
  chunk_id: number
  document_id: number
  title: string
  uri: string | null
  text: string
  /** Where the document came from: `'reply'` is something the team taught in the inbox. */
  source: string
  /** Higher is closer. Not comparable between the two paths — only within one result set. */
  score: number
  /**
   * How this passage was reached. Only ever `'match'` here: it matched the question.
   *
   * Kept as a field rather than dropped because everything that stores a citation reads it,
   * and because the distinction comes back the moment there is more than one way in.
   */
  via?: 'match'
}

const SELECT = `c.id AS chunk_id, c.document_id, d.title, d.uri, d.source, c.text`

/**
 * Which sources a search may read.
 *
 * `null` means everything in the workspace, which is the default and the common case. A
 * scope narrows it, and is how a bot connected to some knowledge sources and not others
 * stops answering from the ones it was not given.
 */
export type Scope = {
  baseIds: number[]
  /**
   * Documents this bot may not read even though their base is connected.
   *
   * One case, and it is why this is a list of addresses rather than a second id: a calendar
   * publishes itself into an ordinary knowledge base as an ordinary document, so a bot
   * connected to that base would read every calendar in it. Which calendars a bot may see
   * is decided per bot, and the only thing that separates those documents from the rest is
   * their synthetic uri.
   */
  notUris?: string[]
} | null

/**
 * The scope as a SQL fragment plus its arguments.
 *
 * One comparison, because a document names its knowledge base directly. This used to be
 * two — a list of crawled sites, plus a flag for the uploaded files — which is the same
 * idea said twice and could not express "the internal handbook" at all.
 *
 * Built rather than interpolated: the ids come from a form, so they go in as a single
 * array parameter and are compared by the database. `= ANY(?::int[])` also behaves
 * correctly on an empty array, where an `IN ()` list would be a syntax error.
 */
function scoped(scope: Scope): { sql: string; args: unknown[] } {
  if (!scope) return { sql: '', args: [] }
  // Connected to nothing at all: retrieve nothing, rather than quietly retrieving all.
  if (!scope.baseIds.length) return { sql: ` AND false`, args: [] }
  if (!scope.notUris?.length) return { sql: ` AND d.base_id = ANY(?::int[])`, args: [scope.baseIds] }
  return {
    sql: ` AND d.base_id = ANY(?::int[]) AND (d.uri IS NULL OR d.uri <> ALL(?::text[]))`,
    args: [scope.baseIds, scope.notUris],
  }
}

/**
 * The `k` passages most likely to answer this question.
 *
 * Returns an empty list rather than throwing when nothing matches — "we do not know" is
 * an answer the agent has to be able to give, and it is the honest one when the knowledge
 * base is empty.
 */
export async function retrieve(
  workspaceId: number,
  query: string,
  { k = 8, scope = null as Scope } = {},
): Promise<Passage[]> {
  const q = query.trim()
  if (!q) return []

  const matches = await match(workspaceId, q, k, scope)
  if (!matches.length) return []

  return [
    /*
     * What the team taught, first.
     *
     * A learned fact was said by a person to a real customer last week and approved by a
     * person since; a crawled brochure may be years old and was written for nobody in
     * particular. When both match a question — "how do I buy" against a shop link the team
     * gave out, and against a PDF saying to find a distributor — the taught one is the
     * better answer, and it has to lead rather than sit fourth in the list.
     *
     * A re-sort of what was already retrieved rather than a term in the SQL: the vector
     * search orders by the raw operator so the HNSW index can be used, and an expression
     * the planner cannot match turns it into a scan of every chunk in the workspace.
     */
    ...matches.map((m) => ({ ...m, via: 'match' as const })).sort(taughtFirst),
  ]
}

/** Stable: only lifts what the team taught above everything else, order otherwise intact. */
const taughtFirst = (a: Passage, b: Passage) => Number(b.source === 'reply') - Number(a.source === 'reply')

/** Whichever of the two searches this deployment can do. */
async function match(workspaceId: number, q: string, k: number, scope: Scope): Promise<Passage[]> {
  if (configured()) {
    const [vector] = (await embed([q])) ?? []
    if (vector) {
      const hits = await byVector(workspaceId, vector, k, scope)
      // Only fall through when there was nothing embedded to compare against — an empty
      // result from a populated index is a real "we do not know", and answering it from
      // keyword overlap instead would be worse, not better.
      if (hits.length) return hits
    }
  }
  return byText(workspaceId, q, k, scope)
}

/**
 * `<=>` is pgvector's cosine distance: 0 is identical, 2 is opposite. Subtracting from 1
 * turns it into a similarity, which is the direction everything else in this file counts.
 *
 * Ordering by the raw operator, not by the derived column, is what lets the HNSW index be
 * used — an expression the planner cannot match to the index means a sequential scan of
 * every chunk in the workspace.
 */
const byVector = (workspaceId: number, vector: number[], k: number, scope: Scope) => {
  const where = scoped(scope)
  return all<Passage>(
    `SELECT ${SELECT}, 1 - (c.embedding <=> ?::vector) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = ? AND c.embedding IS NOT NULL${where.sql}
      ORDER BY c.embedding <=> ?::vector
      LIMIT ?`,
    toVector(vector),
    workspaceId,
    ...where.args,
    toVector(vector),
    k,
  )
}

/**
 * Full-text search, in two passes: every word, then any word.
 *
 * The second pass is not optional politeness — it is what makes this usable at all.
 * `websearch_to_tsquery` joins terms with AND, so "how long do refunds take" only matches
 * a passage containing *long*, *refund* and *take*; the paragraph that actually answers it
 * says "Refunds are issued within five working days" and would score zero. Requiring every
 * word of a question to appear in its answer is the wrong model for a question.
 *
 * So: try the precise reading first, because when it matches it is the better answer, and
 * loosen only when it finds nothing. ts_rank still sorts, so a passage carrying more of
 * the question outranks one carrying a single word of it.
 */
async function byText(workspaceId: number, query: string, k: number, scope: Scope): Promise<Passage[]> {
  // websearch_to_tsquery understands quoted phrases and -word, and — the part that
  // matters — never throws on punctuation a person typed.
  const strict = await search(workspaceId, `websearch_to_tsquery('english', ?)`, query, k, scope)
  if (strict.length) return strict

  return search(workspaceId, `to_tsquery('english', ?)`, anyWord(query), k, scope)
}

/**
 * A question reduced to `word | word | word`.
 *
 * Built here rather than by rewriting the tsquery Postgres produced, because that
 * rewriting has a trap: `refunds -shipping` parses to `refund & !ship`, and turning the
 * `&` into `|` yields `refund | !ship`, which matches every passage that fails to mention
 * shipping — the opposite of what was asked. Dropping to bare words loses the negation
 * instead of inverting it, which is the safe way to be less precise.
 *
 * Everything that is not a letter or digit goes, so nothing reaches to_tsquery that could
 * be read as syntax.
 */
const anyWord = (query: string) =>
  query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
    // A question long enough to need this bound is not a question.
    .slice(0, 24)
    .join(' | ')

const search = (workspaceId: number, toQuery: string, arg: string, k: number, scope: Scope) => {
  if (!arg) return Promise.resolve([] as Passage[])
  const where = scoped(scope)
  return all<Passage>(
    `SELECT ${SELECT}, ts_rank(c.tsv, ${toQuery}) AS score
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = ? AND c.tsv @@ ${toQuery}${where.sql}
      ORDER BY score DESC
      LIMIT ?`,
    arg,
    workspaceId,
    arg,
    ...where.args,
    k,
  )
}
