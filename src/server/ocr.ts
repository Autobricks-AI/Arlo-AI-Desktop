/**
 * Reading a scan.
 *
 * A scanned PDF has no text in it — every page is a photograph of a page — so the only way
 * in is to look at the pixels. Tesseract does that locally: no per-page cost, no document
 * leaving the machine, which matters when the thing being read is somebody's internal
 * handbook.
 *
 * ---------------------------------------------------------------- what it costs
 *
 * Seconds per page, and a worker that takes a few seconds to start. That is why this is
 * only ever reached from the background job — and why it is a fallback rather than a first
 * choice. A PDF with a text layer is read from the text layer, always: that text is exact
 * and this text is a guess, however good a guess.
 *
 * ---------------------------------------------------------------- when it runs
 *
 * OCR_LANGS decides. Empty means off, which is what the tests set, so `npm test` never
 * downloads a language model or spends a minute reading pictures. Otherwise it is the
 * Tesseract language list — `eng`, or `eng+chi_sim` for a workspace whose documents are in
 * two languages.
 */
import { pictures } from './pdfimages.ts'

/** Off when blank. Set in the test harness, so nothing here runs during a test run. */
export const langs = () => (process.env.OCR_LANGS ?? 'eng').trim()
export const enabled = () => !!langs()

/**
 * Where the language data lives once it has been fetched.
 *
 * Tesseract downloads it on first use — about 15MB for English — and caches it. Pinned to
 * a directory rather than left to default into the working directory, because the working
 * directory of a production server is not a place to be writing model files.
 */
const cachePath = () => process.env.OCR_CACHE_DIR || 'node_modules/.cache/tesseract'

/**
 * Below this, Tesseract is guessing at a picture rather than reading a word.
 *
 * Not a number picked out of the air — it is where the two populations separate on real
 * pages. Text scores in the nineties (`compounding` 95, `Singaporean` 95, `lifestyle—and`
 * 89); an illustration read as if it were writing scores in the tens (`Zr` 14, `yaa` 20,
 * `Na` 24). There is very little in between, which is what makes one threshold work.
 */
const CONFIDENT = 60

/**
 * Rebuild the page from the words Tesseract was sure of.
 *
 * The reason this is per word rather than per line: a slide has prose on the left and
 * artwork on the right, and OCR reads straight across, so one line arrives as
 * `The compounding cost of the Singaporean A Na | - "4 \ a` — real content and noise glued
 * together. No amount of line filtering separates those. Confidence does.
 */
export function confidentText(data: { text: string; blocks?: unknown }): string {
  const lines: string[] = []

  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node.words)) {
      const kept = node.words.filter((w: any) => w.confidence >= CONFIDENT).map((w: any) => w.text)
      if (kept.length) lines.push(kept.join(' '))
      return
    }
    for (const key of ['blocks', 'paragraphs', 'lines']) if (Array.isArray(node[key])) node[key].forEach(walk)
  }
  walk(data)

  // No word detail — an older engine build, or a page it could not segment. The plain text
  // is worse but it is not nothing, and denoise still has a pass at it.
  return lines.length ? lines.join('\n') : data.text
}

/**
 * Throw away the lines that are still not words.
 *
 * The second pass, and a cheaper one: a line of pure punctuation can survive on confidence
 * alone. What is left matters, because a junk line becomes a passage, a passage can match a
 * question, and a matched passage is quoted back to a customer as something the company
 * said.
 *
 * Deliberately generous — a line survives on one real word and a majority of ordinary
 * characters. Cutting real content to be rid of noise would be the worse trade, because
 * the noise is merely embarrassing and the missing line is an answer nobody gets.
 */
export function denoise(text: string): string {
  const kept = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      /*
       * One real word, meaning four letters running together.
       *
       * Three is too generous: `Lh Sa b oo® - ort` is a photograph of a neuron read as
       * text, and it clears a three-letter bar. Four is where scattered fragments stop and
       * vocabulary starts — the cost is a heading that is only ever "FAQ", which carries
       * nothing retrievable on its own anyway.
       */
      if (!/[A-Za-z]{4}/.test(line)) return false
      const ordinary = (line.match(/[A-Za-z0-9 .,;:'"()%$&/-]/g) ?? []).length
      return ordinary / line.length >= 0.6
    })
  // Blank lines between what is left, so paragraphs still read as paragraphs.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * Read every page of a scanned PDF.
 *
 * Returns '' when OCR is switched off or there was nothing to look at, which the caller
 * treats the same as "no text layer" — the honest answer in both cases is that this file
 * has no readable content.
 */
export async function readScan(pdf: Buffer, onPage?: (done: number, total: number) => void): Promise<string> {
  if (!enabled()) return ''

  const { found, skipped } = await pictures(pdf)
  if (!found.length) return ''

  /*
   * Imported here rather than at the top of the file.
   *
   * Tesseract pulls in a WebAssembly runtime and is the largest dependency in the app. A
   * server that never receives a scan should never pay to load it, and every path into
   * this module is already async.
   */
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker(langs(), undefined, { cachePath: cachePath(), logger: () => {} })

  const pages: string[] = []
  try {
    for (const [i, picture] of found.entries()) {
      // `blocks` is what carries the per-word confidence, and it is the whole reason the
      // artwork on a slide does not end up in the knowledge base.
      const { data } = await worker.recognize(picture.bytes, {}, { text: true, blocks: true })
      const text = denoise(confidentText(data))
      // A page that came back empty is a blank page, a photograph, or a page Tesseract
      // could not read. None of those is worth a heading in the middle of a document.
      if (text) pages.push(text)
      onPage?.(i + 1, found.length)
    }
  } finally {
    // Always: a worker left running holds a WebAssembly instance and its memory for the
    // life of the process, and this runs once per upload.
    await worker.terminate()
  }

  if (!pages.length) return ''

  /*
   * The count is part of the text, on purpose.
   *
   * Retrieval quotes passages back with a citation, and "read from a scan" is something a
   * person checking an answer deserves to know — OCR is a good guess, not a transcript.
   * Saying how many pages were skipped in the same breath keeps a truncated document from
   * reading as a complete one.
   */
  const note = skipped
    ? `\n\n[Read from a scan by OCR. ${skipped} page(s) could not be read.]`
    : `\n\n[Read from a scan by OCR.]`
  return pages.join('\n\n') + note
}
