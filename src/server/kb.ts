/**
 * The knowledge base: getting company knowledge in, and keeping it current.
 *
 * Everything arrives as text in the end, so there is one write path — `store()` — and the
 * differences between an uploaded PDF and a crawled page live only in how the text was
 * obtained. Chunking and embedding happen on the way in, once, because a question should
 * not be paying for them.
 *
 * Every function takes `workspaceId` first, from the session, never from the browser. The
 * RLS scope is already open around the request; passing it explicitly is what makes a
 * query that forgot readable as wrong in review, rather than only at runtime.
 */
import { createHash } from 'node:crypto'
import { all, insert, one, run, tx } from './db.ts'
import { chunk } from './chunk.ts'
import { embed, toVector } from './embed.ts'

import { describe, pdfText } from './pdftext.ts'
import { enabled as ocrEnabled, readScan } from './ocr.ts'

export type Document = {
  id: number
  source: string
  uri: string | null
  title: string
  mime: string | null
  hash: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** What ingesting one thing did, in the words the UI shows. */
export type Filed = { documentId: number; title: string; chunks: number; status: 'created' | 'updated' | 'unchanged' }

// ---------------------------------------------------------------- the write path

/**
 * File one document and its chunks.
 *
 * Three outcomes, and the difference between them is what makes re-crawling cheap:
 *   unchanged  the same text is already filed under this hash — nothing to do
 *   updated    this address is filed but the text has changed — replace it
 *   created    new
 *
 * The whole thing is one transaction. A document whose chunks half-wrote would answer
 * questions from a fragment of itself and give no sign anything was wrong.
 */
export async function store(
  workspaceId: number,
  doc: {
    /*
     * Where it came from, which is the only thing that separates the three lists on a
     * knowledge base's page:
     *   'url'     crawled from a website, and re-read on the next crawl.
     *   'upload'  a document somebody sent in, read once.
     *   'text'    typed straight into the app by a person.
     *   'reply'   a fact the team stated in a conversation, approved and filed.
     */
    source: 'upload' | 'url' | 'reply' | 'text'
    uri: string | null
    title: string
    mime: string | null
    text: string
    /** The site this page was crawled from. Null for uploads, which have no parent. */
    siteId?: number | null
    /** Which knowledge base it belongs to. Every document has one. */
    baseId: number
  },
): Promise<Filed> {
  const text = doc.text.trim()
  if (!text) throw new Error(`Nothing readable in ${doc.title}`)
  const hash = sha256(text)

  const filed = await tx(async () => {
    // Within this base, not the workspace. Two bases holding the same page hold their own
    // copy of it — see the indexes in migration 021 for why that has to be true.
    const same = await one<{ id: number }>(
      `SELECT id FROM documents WHERE workspace_id = ? AND base_id = ? AND hash = ?`,
      workspaceId,
      doc.baseId,
      hash,
    )
    if (same) {
      /*
       * Byte-identical text we already hold. Nothing to re-chunk — but the parent is still
       * updated, because a page can be reached from a new root without its content
       * changing, and it belongs under whichever site last found it. Without this a
       * re-crawl leaves pages stranded under the site that first saw them.
       */
      await run(
        `UPDATE documents SET site_id = COALESCE(?, site_id), base_id = ? WHERE id = ?`,
        doc.siteId ?? null,
        doc.baseId,
        same.id,
      )
      const n = await countChunks(same.id)
      return { documentId: same.id, title: doc.title, chunks: n, status: 'unchanged' as const }
    }

    // Same address, different text: the page changed. One row per address, so this
    // replaces rather than accumulating a second copy of a page that gets edited weekly.
    const existing = doc.uri
      ? await one<{ id: number }>(
          `SELECT id FROM documents WHERE workspace_id = ? AND base_id = ? AND uri = ?`,
          workspaceId,
          doc.baseId,
          doc.uri,
        )
      : undefined

    let documentId: number
    if (existing) {
      await run(
        /*
         * `edited_at = NULL` because this is the moment a hand edit stops being true: the text
         * somebody wrote has just been replaced by whatever the live page says now. Leaving the
         * flag set would have the page claim an edit that no longer exists.
         */
        `UPDATE documents SET title = ?, mime = ?, text = ?, hash = ?, site_id = COALESCE(?, site_id),
                base_id = ?, status = 'ready', error = NULL, updated_at = now(), edited_at = NULL
          WHERE id = ?`,
        doc.title,
        doc.mime,
        text,
        hash,
        doc.siteId ?? null,
        doc.baseId,
        existing.id,
      )
      await run(`DELETE FROM chunks WHERE document_id = ?`, existing.id)
      documentId = existing.id
    } else {
      documentId = await insert(
        `INSERT INTO documents (workspace_id, source, uri, title, mime, text, hash, site_id, base_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        workspaceId,
        doc.source,
        doc.uri,
        doc.title,
        doc.mime,
        text,
        hash,
        doc.siteId ?? null,
        doc.baseId,
      )
    }

    const n = await writeChunks(workspaceId, documentId, text, doc.title)
    return { documentId, title: doc.title, chunks: n, status: existing ? ('updated' as const) : ('created' as const) }
  })

  return filed
}

/**
 * Chunk, embed, insert. Called on the way in and again by `reindex`.
 *
 * A NULL embedding is a supported state, not a failure: with no provider configured the
 * column stays empty and retrieval uses the generated tsvector instead.
 *
 * ---------------------------------------------------------------- why the title is here
 *
 * Every passage carries its document's title. Retrieval searches `chunks`, and nothing
 * else — not `documents.title` — so a title that is not in the passage text is not
 * searchable at all. That matters most on exactly the pages that need it: a product
 * category page whose listing is drawn in the browser arrives as navigation furniture,
 * and its title is the only thing on it that says what it is about.
 *
 * On every passage rather than only the first, because a question matches one passage, not
 * a document — passage nine of a long page should still know which page it is from.
 */
async function writeChunks(workspaceId: number, documentId: number, text: string, title: string) {
  const heading = title.trim()
  const pieces = chunk(text).map((piece) =>
    // Not repeated when the text already opens with it, which is common in Markdown.
    heading && !piece.startsWith(heading) ? `${heading}\n\n${piece}` : piece,
  )
  if (!pieces.length) return 0

  const vectors = await embed(pieces)
  for (const [ord, piece] of pieces.entries()) {
    await run(
      `INSERT INTO chunks (workspace_id, document_id, ord, text, embedding) VALUES (?,?,?,?,?)`,
      workspaceId,
      documentId,
      ord,
      piece,
      vectors ? toVector(vectors[ord]) : null,
    )
  }
  return pieces.length
}

const countChunks = async (documentId: number) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n FROM chunks WHERE document_id = ?`, documentId))?.n ?? 0

// ---------------------------------------------------------------- the sources

/** What an uploaded file is, once the route has read it off the request. */
export type Upload = { name: string; mime: string; bytes: Buffer }

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml))/i

/**
 * What we will try to read a file as, or null when we have no idea.
 *
 * Separate from reading it because the two questions are answerable at different moments.
 * The *type* is knowable the instant somebody picks the file, so an unsupported one can be
 * refused on the form. Whether a PDF actually has a text layer can only be discovered by
 * parsing it, which is the background job's business — see uploads.ts.
 */
export function kindOf(file: { name: string; mime: string }): 'pdf' | 'html' | 'text' | null {
  if (/pdf/i.test(file.mime) || /\.pdf$/i.test(file.name)) return 'pdf'
  if (/html/i.test(file.mime) || /\.html?$/i.test(file.name)) return 'html'
  if (TEXTUAL.test(file.mime) || /\.(txt|md|markdown|csv|json|ya?ml|log)$/i.test(file.name)) return 'text'
  return null
}

/** The message shown when we cannot read a file at all. One wording, two callers. */
export const unreadable = (file: { name: string; mime: string }) =>
  `${file.name} is ${file.mime || 'an unrecognised type'} — upload text, Markdown, HTML or a PDF`

/** Read the text out of an upload. Throws when there is none, which is the useful answer. */
export async function textOf(file: Upload): Promise<string> {
  const kind = kindOf(file)
  if (kind === 'pdf') {
    // pdfText throws when it found text it could not map, which is a different problem
    // from a scan and gets its own message. Named here so the message says which file.
    let text: string
    try {
      text = (await pdfText(file.bytes)).trim()
    } catch (e) {
      throw new Error(`${file.name}: ${e instanceof Error ? e.message : e}`)
    }
    if (!text) {
      // Say which problem it is. A file with pages and images and no fonts cannot contain
      // text at all — that is a fact about the file, not a guess about it, and somebody
      // deciding what to do next deserves the difference.
      const { pages, images, fonts } = describe(file.bytes)
      throw new Error(
        images && !fonts
          ? `${file.name} is a scan: ${pages} page(s), ${images} image(s) and no fonts, so there is no text in it to read. ` +
            `It needs to be run through OCR, or exported again from whatever produced it.`
          : `${file.name} has no text layer — it is probably a scan. Export it as text, or paste the content in.`,
      )
    }
    return text
  }
  if (kind) return file.bytes.toString('utf8')
  throw new Error(unreadable(file))
}

/**
 * Read a file and file it. Reached from the background job in uploads.ts, never from a
 * request — on a large PDF this is minutes of parsing and embedding.
 *
 * `onPage` is how a scan reports progress, and only a scan has any to report.
 */
export async function addUpload(
  workspaceId: number,
  baseId: number,
  file: Upload,
  onPage?: (done: number, total: number) => void,
): Promise<Filed> {
  let raw: string
  try {
    raw = await textOf(file)
  } catch (e) {
    /*
     * No text layer. Look at the pixels instead.
     *
     * Strictly a fallback, and the order is the point: a PDF that has text is read from its
     * text, always, because that text is exact and OCR is a good guess. This runs only when
     * there was nothing to read — and if it also finds nothing, the original complaint is
     * the one worth showing, because "this is a scan" is more use than "OCR found nothing".
     */
    if (kindOf(file) !== 'pdf' || !ocrEnabled()) throw e
    const read = await readScan(file.bytes, onPage)
    if (!read) throw e
    return store(workspaceId, {
      baseId,
      source: 'upload',
      uri: null,
      title: file.name,
      mime: file.mime || null,
      text: read,
    })
  }

  const isHtml = kindOf(file) === 'html'
  const { stripHtml } = await import('./scrape.ts')
  return store(workspaceId, {
    baseId,
    source: 'upload',
    // Files have no address, and two different uploads may share a name. The hash is what
    // makes them the same document; the name is only a label.
    uri: null,
    title: file.name,
    mime: file.mime || null,
    text: isHtml ? stripHtml(raw) : raw,
  })
}

// Adding from the web lives in sites.ts. It is a background job with a parent row and a
// progress bar, not a function that returns when the internet is finished.

// ---------------------------------------------------------------- reading and tidying

/**
 * Every document, with its passage count and its parent.
 *
 * The text column is deliberately not selected: this feeds a list, and a knowledge base of
 * any size would ship megabytes of prose to render a table of titles.
 */
export const listDocuments = (workspaceId: number, baseId?: number) =>
  all<Document & { chunks: number; site_id: number | null; base_id: number; edited_at: string | null }>(
    `SELECT d.id, d.source, d.uri, d.title, d.mime, d.hash, d.status, d.error, d.site_id, d.base_id,
            d.created_at, d.updated_at, d.edited_at,
            (SELECT count(*)::int FROM chunks c WHERE c.document_id = d.id) AS chunks
       FROM documents d
      WHERE d.workspace_id = ? AND (?::int IS NULL OR d.base_id = ?)
      ORDER BY d.updated_at DESC`,
    workspaceId,
    baseId ?? null,
    baseId ?? null,
  )

export type Passage = { id: number; ord: number; text: string; embedded: boolean }

/**
 * The passages a document was cut into — what retrieval actually searches, as opposed to
 * the text that went in.
 *
 * Worth being able to look at: "why did it answer that" and "why did it not find this" are
 * both questions about where the cuts landed and whether the passage carries a vector, and
 * neither is answerable from the original document.
 */
export const passagesOf = (workspaceId: number, documentId: number) =>
  all<Passage>(
    `SELECT id, ord, text, (embedding IS NOT NULL) AS embedded
       FROM chunks WHERE workspace_id = ? AND document_id = ? ORDER BY ord`,
    workspaceId,
    documentId,
  )

/** As many hits as a person will read before narrowing the search instead. */
export const FOUND_LIMIT = 60

/** A passage somebody searched for, and enough around the hit to recognise it. */
export type Found = {
  id: number
  document_id: number
  ord: number
  title: string
  uri: string | null
  source: string
  edited_at: string | null
  excerpt: string
}

/**
 * Where does this knowledge base actually say that?
 *
 * The question somebody asks after a bot says something surprising. Answering it used to mean
 * opening pages one at a time and reading them -- a bot quoted a course that had been
 * discontinued, and finding the sentence meant going through nineteen crawled pages by hand.
 *
 * Substring rather than the full-text search retrieval uses, and that is the point. Retrieval
 * answers "what is this about", which is a question about meaning; this answers "where do these
 * words appear", which is a question about text. Somebody hunting "64-hour" wants the passage
 * containing those characters, not the passages Postgres thinks are related to it -- and the
 * stemmer would not have matched that one anyway.
 *
 * Titles as well as bodies, because the page somebody wants is often named after the thing.
 */
export async function findPassages(
  workspaceId: number,
  baseId: number,
  q: string,
): Promise<{ hits: Found[]; more: boolean }> {
  const needle = q.trim()
  // One character matches half the base and tells nobody anything.
  if (needle.length < 2) return { hits: [], more: false }

  /*
   * position() rather than ILIKE, so there is nothing to escape.
   *
   * The ILIKE version needed the needle's own % and _ escaped and an ESCAPE clause to do it
   * with, and got both wrong -- quietly, because Postgres reads ESCAPE '' as "no escape
   * character" instead of rejecting it, so a search for "50%" matched half the base rather
   * than failing. position() takes the needle as plain text: no wildcards, nothing to get
   * right. Unindexed either way; a base is thousands of passages, not millions.
   */
  const rows = await all<Found & { text: string }>(
    `SELECT c.id, c.document_id, c.ord, c.text, d.title, d.uri, d.source, d.edited_at
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = ? AND d.base_id = ?
        AND (position(lower(?) in lower(c.text)) > 0 OR position(lower(?) in lower(d.title)) > 0)
      ORDER BY d.title, c.ord
      LIMIT ?`,
    workspaceId,
    baseId,
    needle,
    needle,
    FOUND_LIMIT + 1,
  )

  // One over the limit, so the page can say it is showing a page of a longer list rather than
  // presenting a truncated answer as the whole one.
  return {
    hits: rows.slice(0, FOUND_LIMIT).map(({ text, ...row }) => ({ ...row, excerpt: around(text, needle) })),
    more: rows.length > FOUND_LIMIT,
  }
}

/** The hit with enough either side to read, or the opening if the match was in the title. */
function around(text: string, needle: string) {
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at === -1) return text.slice(0, 220).trim()
  const from = Math.max(0, at - 90)
  return (from ? '…' : '') + text.slice(from, at + needle.length + 150).trim() + '…'
}


export const getDocument = (workspaceId: number, id: number) =>
  one<Document & { text: string; base_id: number; site_id: number | null }>(
    `SELECT * FROM documents WHERE workspace_id = ? AND id = ?`,
    workspaceId,
    id,
  )

export async function removeDocument(workspaceId: number, id: number) {
  /*
   * `uploads.document_id` is `on delete cascade`, and one upload going with its document is
   * deliberate — `test/uploads.test.js` pins it, so that deleting knowledge does not leave
   * bytes behind with nothing pointing at them.
   *
   * The case that is not deliberate is *two*. Identical text is deduplicated onto one
   * `documents` row, so two files uploaded under different names share it, and deleting the
   * document from Knowledge took both — including the one nobody selected and nothing warned
   * about. `uploads.remove()` has guarded the mirror image of this from the start.
   *
   * So the guard is on the plural, not on the existence: one upload still cascades as designed,
   * two or more refuse and say which. Refusing rather than orphaning, because an upload with no
   * document behind it is a row the reader cannot open — that trades a silent deletion for a
   * silent breakage.
   *
   * The workspace is in the WHERE as well as in the policy. Belt and braces, and it makes the
   * intent readable without knowing the policies exist.
   */
  const held = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM uploads WHERE workspace_id = ? AND document_id = ?`,
    workspaceId,
    id,
  )
  if (held && held.n > 1)
    throw new Error(
      `That text came from ${held.n} different uploads, and deleting it here would delete all ${held.n} files. Remove them from Uploads instead.`,
    )

  const { changes } = await run(`DELETE FROM documents WHERE workspace_id = ? AND id = ?`, workspaceId, id)
  if (!changes) throw new Error('No such document')
}

/**
 * Re-chunk and re-embed a document from the text already stored.
 *
 * What this is for: embeddings were configured after the document went in, so its chunks
 * have no vectors and it is invisible to anything but full-text search.
 */
/**
 * Correct what was extracted.
 *
 * The text is the editable thing, not the passages, and that is forced rather than chosen:
 * `chunk()` collapses whitespace and overlaps consecutive passages, so a passage is not a
 * slice of the document and cannot be written back into one. An edit stored on a passage
 * would also be destroyed by the next Reindex, which rebuilds every passage from this text
 * — a trap worth not building.
 *
 * So this is the same path as `reindex`, with new text: replace it, cut it again, embed it
 * again, and rebuild the graph from it. What somebody fixes here is what the bot quotes.
 */
/**
 * File a passage somebody typed.
 *
 * Thin on purpose — `store()` already chunks, embeds, dedupes by hash and builds the graph,
 * and this only decides what such a document is called and where it says it came from. The
 * uri is null because there is nowhere it came from; that is the point of it.
 */
export const saveNote = (workspaceId: number, baseId: number, title: string, text: string) =>
  store(workspaceId, { source: 'text', uri: null, title, mime: 'text/plain', text, baseId })

export async function saveText(workspaceId: number, id: number, text: string) {
  const clean = text.trim()
  if (!clean) throw new Error('The text cannot be empty — remove the document instead.')

  const doc = await getDocument(workspaceId, id)
  if (!doc) throw new Error('No such document')

  const hash = sha256(clean)
  // The same guard the write path uses, said in the words of somebody who just pressed
  // Save rather than of the crawler.
  const clash = await one<{ title: string }>(
    `SELECT title FROM documents WHERE workspace_id = ? AND base_id = ? AND hash = ? AND id <> ?`,
    workspaceId,
    doc.base_id,
    hash,
    id,
  )
  if (clash) throw new Error(`"${clash.title}" in this knowledge base already holds exactly this text.`)

  const n = await tx(async () => {
    /*
     * `edited_at` as well as `updated_at`, and they are not the same question. `updated_at`
     * moves whenever anything touches the row, reindex included; this moves only when a person
     * has changed what the document says. A crawl of the same page clears it again -- see the
     * UPDATE in store() above.
     */
    await run(
      `UPDATE documents SET text = ?, hash = ?, updated_at = now(), edited_at = now() WHERE id = ?`,
      clean,
      hash,
      id,
    )
    await run(`DELETE FROM chunks WHERE document_id = ?`, id)
    return writeChunks(workspaceId, id, clean, doc.title)
  })

  return n
}

export async function reindex(workspaceId: number, id: number) {
  const doc = await getDocument(workspaceId, id)
  if (!doc) throw new Error('No such document')
  const n = await tx(async () => {
    await run(`DELETE FROM chunks WHERE document_id = ?`, id)
    const chunks = await writeChunks(workspaceId, id, doc.text, doc.title)
    await run(`UPDATE documents SET updated_at = now() WHERE id = ?`, id)
    return chunks
  })
  return n
}

/**
 * How much is known, and how much of it is searchable by meaning.
 *
 * Scoped to one base when given one, because that is the question the page asks: the
 * counts under a heading have to be the counts of what is under that heading.
 */
export const stats = async (workspaceId: number, baseId?: number) =>
  (await one<{ documents: number; chunks: number; embedded: number }>(
    `SELECT count(DISTINCT d.id)::int                                          AS documents,
            count(c.id)::int                                                   AS chunks,
            count(c.id) FILTER (WHERE c.embedding IS NOT NULL)::int            AS embedded
       FROM documents d
       LEFT JOIN chunks c ON c.document_id = d.id
      WHERE d.workspace_id = ? AND (?::int IS NULL OR d.base_id = ?)`,
    workspaceId,
    baseId ?? null,
    baseId ?? null,
  ))!

/**
 * Take one passage out of a document for good.
 *
 * Deleting the chunk row alone would not last: passages are rebuilt from `documents.text`
 * whenever anything reindexes, so the next crawl, edit or Reindex press brings it straight
 * back. So the passage is cut out of the stored text — the actual source — and the document
 * is re-chunked from what is left.
 *
 * Matched on the text rather than on an offset, because chunking overlaps: a chunk's
 * boundaries are not a slice of the original anybody can compute back, and the first exact
 * occurrence is the one somebody is looking at.
 */
export async function removePassage(workspaceId: number, chunkId: number) {
  const chunk = await one<{ document_id: number; text: string }>(
    `SELECT c.document_id, c.text FROM chunks c
       JOIN documents d ON d.id = c.document_id
      WHERE c.workspace_id = ? AND c.id = ?`,
    workspaceId,
    chunkId,
  )
  if (!chunk) throw new Error('No such passage')

  const doc = await getDocument(workspaceId, chunk.document_id)
  if (!doc) throw new Error('No such document')

  /*
   * The stored passage carries the document's title as a heading and the document text does
   * not — `writeChunks` prefixes every piece so a title is searchable, since retrieval reads
   * `chunks` and never `documents.title`. Searching for the prefixed form in the unprefixed
   * source therefore never matched, and *every* attempt to remove a passage failed with the
   * message below, which says the document changed when nothing had.
   *
   * Stripped rather than searched around, and only when it is really the prefix this function
   * put there: a document that genuinely opens with its own title keeps it, which is the same
   * case `writeChunks` declines to double up.
   */
  const heading = doc.title.trim()
  const body =
    heading && chunk.text.startsWith(`${heading}\n\n`) ? chunk.text.slice(heading.length + 2) : chunk.text

  const at = doc.text.indexOf(body)
  /*
   * Not found means the text has moved on since this passage was cut from it — somebody
   * edited the document in another tab. Refusing is the honest answer: cutting the nearest
   * thing would delete something they did not choose.
   */
  /*
   * ponytail: a verbatim search, so a passage `chunk()` trimmed at a boundary that does not
   * fall on a substring of the source still refuses. Before the heading strip above, *every*
   * passage refused; now it is the minority that start mid-paragraph. Refusing is the safe
   * direction and the message is honest about the outcome if not the cause — the upgrade path
   * is to store each chunk's offset in the source when it is written, which makes this an
   * index lookup rather than a search, and is a migration on `chunks`.
   */
  if (at === -1) throw new Error('That passage is no longer part of this document — reload and try again.')

  const left = (doc.text.slice(0, at) + doc.text.slice(at + body.length)).replace(/\n{3,}/g, '\n\n').trim()
  if (!left) throw new Error('That is the whole document — remove the document instead.')

  await saveText(workspaceId, chunk.document_id, left)
}
