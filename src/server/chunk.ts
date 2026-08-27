/**
 * Cutting a document into passages.
 *
 * Pure and I/O free, which is the point: chunking decides what every answer is allowed to
 * be built from, so it is the one part of retrieval worth being able to test exactly.
 *
 * The rule is: prefer to break where the author already broke. A paragraph boundary, then
 * a sentence boundary, and only then a hard cut mid-word — that last one exists so a
 * minified stylesheet or a table with no punctuation cannot produce a single chunk the
 * size of the file.
 *
 * Consecutive chunks overlap by a little, so a sentence that straddles a boundary is
 * whole in one of them. Without it, a fact stated across a break is retrievable from
 * neither side.
 */

/** About 300 tokens of English: big enough to hold an answer, small enough to be one. */
const SIZE = 1200
/** Roughly a long sentence carried into the next chunk. */
const OVERLAP = 150

/**
 * Split text into passages. A chunk may reach `size + overlap` characters, because the
 * overlap is carried in on top of a full piece rather than counted against it.
 */
export function chunk(input: string, { size = SIZE, overlap = OVERLAP } = {}): string[] {
  if (overlap >= size) throw new Error('chunk overlap must be smaller than the chunk size')

  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return []

  // Paragraphs first; any that is too big on its own is broken down further.
  const pieces = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (p.length <= size ? [p] : bySentence(p, size)))

  const out: string[] = []
  let buf = ''
  for (const piece of pieces) {
    if (buf && buf.length + 2 + piece.length > size) {
      out.push(buf)
      // Start the next chunk with the end of this one, so nothing falls in the crack.
      const carry = tail(buf, overlap)
      buf = carry ? `${carry}\n\n${piece}` : piece
    } else {
      buf = buf ? `${buf}\n\n${piece}` : piece
    }
  }
  if (buf) out.push(buf)
  return out
}

/** A paragraph too long to keep whole: break on sentence ends, then give up and cut. */
function bySentence(paragraph: string, size: number): string[] {
  const sentences = paragraph.match(/[^.!?]*[.!?]+[)\]'"`]*\s*|[^.!?]+$/g) ?? [paragraph]
  const out: string[] = []
  let buf = ''

  const flush = () => {
    if (buf.trim()) out.push(buf.trim())
    buf = ''
  }

  for (const s of sentences) {
    if (s.length > size) {
      // One "sentence" longer than a whole chunk is not prose. Cut it to length; the
      // alternative is a chunk nothing can embed.
      flush()
      for (let i = 0; i < s.length; i += size) {
        const slice = s.slice(i, i + size).trim()
        if (slice) out.push(slice)
      }
      continue
    }
    if (buf && buf.length + s.length > size) flush()
    buf += s
  }
  flush()
  return out
}

/** The last `n` characters, starting at a word boundary so the carry is not a fragment. */
function tail(s: string, n: number): string {
  if (n <= 0) return ''
  const cut = s.slice(-n)
  if (cut.length === s.length) return cut.trim()
  const space = cut.search(/\s/)
  return (space === -1 ? '' : cut.slice(space + 1)).trim()
}
