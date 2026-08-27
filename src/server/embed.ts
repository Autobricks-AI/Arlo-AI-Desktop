/**
 * Turning text into a vector.
 *
 * ---------------------------------------------------------------- the one exception
 *
 * Everything else in this app calls a model through `llm.ts`, on the key the workspace saved
 * in Settings. **This file reads the environment instead**, so it is the one call configured
 * per install rather than per workspace, and the one that can be pointed somewhere else:
 * anything OpenAI-shaped answers on `EMBEDDINGS_URL`.
 *
 * Autobricks serves `/v1/embeddings`, so the ordinary setup is to point all three variables
 * at it and use the same key. Reading the workspace's saved key directly would mean a
 * `workspaceId` on `embed()`, on all six of its callers, and a `sweepEmbeddings()` that
 * groups its backfill per workspace — one config line does the same job for a build that
 * has one workspace.
 *
 * ---------------------------------------------------------------- when it does nothing
 *
 * With no key this returns null rather than throwing, and every caller has an answer for
 * null: ingest stores chunks with a NULL embedding, and retrieval falls back to Postgres
 * full-text search. The whole product works without it, slightly worse. That is also what
 * keeps `npm test` off the network.
 */
import { all, asSystem, run } from './db.ts'
import { ownsSingletons } from './singleton.ts'

/** Must match the `vector(n)` columns — `chunks` and `lessons` — in migrations/001_schema.sql. */
// `||`, not `??`: an empty EMBEDDINGS_DIMS is somebody leaving the field blank, and
// Number('') is 0 — which would have made the width check below refuse every vector.
export const DIMS = Number(process.env.EMBEDDINGS_DIMS || 1536)

/**
 * Both, or neither.
 *
 * No borrowing another key that happens to be lying around: this is the one path that can
 * reach a provider the rest of the app never talks to, so it fires only when somebody has
 * written down both where to send it and what to send. `.env.example` ships them blank on
 * purpose — retrieval falls back to full-text search until both are filled in.
 */
const key = () => (process.env.EMBEDDINGS_URL ? process.env.EMBEDDINGS_KEY || '' : '')

export const configured = () => !!key()

/** How many passages go in one request. Provider limits are far higher; this bounds latency. */
const BATCH = 64

/** How many rows the backfill embeds per tick. Eight provider calls a minute. */
const BACKFILL = 500

/**
 * Embed a batch of texts, in order. Null means no provider is configured — never an
 * error, because "we have no embeddings" is a supported state, not a failure.
 *
 * A provider that *is* configured and fails does throw: that is a real problem with a
 * real key, and swallowing it would silently downgrade every future search to full-text
 * without anybody noticing.
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!configured()) return null
  if (!texts.length) return []

  // `configured()` already refused an unset URL, so this is never the fallback in practice —
  // it is here so the shape of the call does not depend on reading that check first.
  const url = process.env.EMBEDDINGS_URL || 'https://api.autobricksai.com/v1/embeddings'
  // Providers spell the same model differently — Autobricks prefixes `autobricksai/`,
  // OpenRouter `openai/` — which is why the name sits beside the URL in .env rather than
  // being guessed from it.
  const model = process.env.EMBEDDINGS_MODEL || 'autobricksai/text-embedding-3-small'
  const out: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key()}`,
        'content-type': 'application/json',
      },
      /*
       * `dimensions` only when somebody asked for one.
       *
       * OpenRouter's body does not document the field, and a model's native width is the
       * right answer whenever nobody has said otherwise — `text-embedding-3-small` is 1536
       * either way. Sent unconditionally, it was a field that either did nothing or made a
       * provider complain about a parameter the caller never chose.
       */
      body: JSON.stringify({
        model,
        input: slice,
        ...(process.env.EMBEDDINGS_DIMS ? { dimensions: DIMS } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`Embeddings provider said ${res.status}: ${(await res.text()).slice(0, 300)}`)

    const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] }
    const data = json.data
    if (!data || data.length !== slice.length)
      throw new Error(`Embeddings provider returned ${data?.length ?? 0} vectors for ${slice.length} passages`)

    /*
     * The width, checked once per batch rather than never.
     *
     * The columns are `vector(1536)` in SQL and nothing negotiates that at runtime, so a
     * model of another size is a configuration mistake — and without this it surfaced as a
     * pgvector type error from inside a transaction, which says nothing about the model
     * anybody actually picked.
     */
    const width = data[0]?.embedding?.length ?? 0
    if (width !== DIMS)
      throw new Error(
        `${model} returns ${width}-wide vectors and this database stores ${DIMS}. Use a model of that width — ` +
          `openai/text-embedding-3-small is ${DIMS} — or migrate the vector columns and re-embed everything.`,
      )

    // The API documents that `data` may come back out of order, and index is how it says
    // which is which. Sorting is cheaper than being subtly wrong about every answer.
    for (const d of [...data].sort((a, b) => a.index - b.index)) out.push(d.embedding)
  }
  return out
}

/**
 * pgvector's text form. `pg` has no idea what a vector is — it is an extension type with
 * an OID assigned at install time — so it goes over the wire as a string and Postgres
 * casts it. One place that knows the format, rather than a template literal per query.
 */
export const toVector = (v: number[]) => `[${v.join(',')}]`

// ---------------------------------------------------------------- filling in what is missing

/**
 * Embed whatever was stored while there was no key.
 *
 * Switching embeddings on used to make retrieval *worse*, and quietly: `byVector` only sees
 * chunks that have a vector, and the keyword path is a fallback for finding nothing at all
 * rather than a second half of the same search. So one newly embedded document hid an
 * entire existing knowledge base, and every approved example — which needs its own vector
 * to be retrieved once a key exists — stopped being used. The only repair was a Reindex
 * button, per document, pressed by a person who had no way of knowing they needed to.
 *
 * An UPDATE rather than `kb.reindex()`, because the text is already in the row. Re-chunking
 * a document to fill in a column it could fill in place is work nobody asked for, and it
 * would rebuild the graph for every document on the instance.
 */
export async function sweepEmbeddings() {
  if (!ownsSingletons || !configured()) return

  try {
    // Instance-wide bookkeeping, so no workspace scope — the same reason the other sweeps
    // run as the owner.
    const chunks = await asSystem(() =>
      all<{ id: number; text: string }>(
        `SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?`,
        BACKFILL,
      ),
    )
    if (chunks.length) {
      const vectors = await embed(chunks.map((c) => c.text))
      if (vectors)
        await asSystem(async () => {
          for (const [i, c] of chunks.entries())
            await run(`UPDATE chunks SET embedding = ?::vector WHERE id = ?`, toVector(vectors[i]), c.id)
        })
      console.log('[embed] filled in', chunks.length, 'passages')
    }

    /*
     * Lessons too, and matched to what `harvest()` embeds — label and text together, so a
     * backfilled example is found by the same query as one embedded on the way in.
     *
     * A `resource` lesson is skipped by design: a file or a link is chosen by its
     * description at answer time, not by similarity, and it has no embedding to be missing.
     */
    const lessons = await asSystem(() =>
      all<{ id: number; question: string | null; answer: string }>(
        `SELECT id, question, answer FROM lessons
          WHERE embedding IS NULL AND kind <> 'resource' AND status <> 'rejected'
          ORDER BY id LIMIT ?`,
        BACKFILL,
      ),
    )
    if (lessons.length) {
      const vectors = await embed(lessons.map((l) => `${l.question ?? ''}\n${l.answer}`))
      if (vectors)
        await asSystem(async () => {
          for (const [i, l] of lessons.entries())
            await run(`UPDATE lessons SET embedding = ?::vector WHERE id = ?`, toVector(vectors[i]), l.id)
        })
      console.log('[embed] filled in', lessons.length, 'lessons')
    }
  } catch (e) {
    /*
     * Logged and left. The next tick tries the same rows, and there is deliberately no
     * attempt counter: unlike a crawl the input cannot be malformed, so a failure is the
     * provider being down or the key being wrong — both of which are fixed elsewhere and
     * then simply work.
     */
    console.error('[embed] backfill failed:', e instanceof Error ? e.message : e)
  }
}
