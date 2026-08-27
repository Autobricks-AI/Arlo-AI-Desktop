import { inflate } from 'node:zlib'
import { promisify } from 'node:util'

// Async, not inflateSync: a PDF is many streams and this runs over all of them, so on the
// event loop it blocked every other request the worker held for the length of a document.
// libuv's threadpool takes it instead. maxOutputLength still bounds the bomb case.
const inflateP = promisify(inflate)

// ponytail: a text-layer scraper, not a PDF parser. It reads the text-showing
// operators out of the content streams, which is enough for the digitally
// generated documents most companies upload. Scanned or image-only PDFs come back
// empty, and kb.ts records that rather than filing a document with no text in it.

/**
 * A ceiling on what one compressed content stream may decompress to.
 *
 * Unlike an image, a text stream carries no declared size to bound it by — it is
 * PostScript-like operators, not a fixed W×H raster — so this is a flat number rather
 * than a computed one. 20MB is far past what real page content ever reaches (a dense page
 * of text operators is tens of kilobytes) and still small enough that a stream crafted to
 * exceed it is not a page, whatever compression ratio produced it.
 */
const MAX_STREAM_BYTES = 20 * 1024 * 1024

const unescape = (s: string) =>
  s
    .replace(/\\([nrtbf])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c as 'n'])
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, '$1')

/**
 * How much of this could a person read? Tabs and newlines count; NUL and the other control
 * codes do not.
 *
 * This is the whole defence against reading things that are not text. A PDF is mostly
 * binary — images, font programs, colour profiles — and every one of those is wrapped in
 * the same `stream`/`endstream` markers as a page's instructions. Told apart by what they
 * look like, because the alternative is parsing the object graph to ask.
 */
const legible = (c: number) =>
  // Tab, newline, carriage return, then everything from space up — minus DEL and the C1
  // block above it. Those thirty-three codes are the tell: no producer sets them as text,
  // and a quarter of any binary run lands in them.
  c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127 && !(c >= 0x80 && c <= 0x9f))

function readable(s: string) {
  if (!s) return 0
  let ok = 0
  for (let i = 0; i < s.length; i++) if (legible(s.charCodeAt(i))) ok++
  return ok / s.length
}

/**
 * Drop what `readable` would not have counted.
 *
 * Mostly-text is still text, and one stray control byte in a paragraph is not a reason to
 * throw the paragraph away — but it is every reason not to carry the byte onward. A NUL in
 * particular is not bad data downstream, it is a failed INSERT that loses the document.
 */
const strip = (s: string) => {
  let out = ''
  for (let i = 0; i < s.length; i++) if (legible(s.charCodeAt(i))) out += s[i]
  return out
}

/**
 * The C1 range under WinAnsiEncoding, which is what most PDFs are written in.
 *
 * Latin-1 leaves 0x80–0x9F as control codes; WinAnsi puts the typographic punctuation
 * there instead. So a byte this table covers is text — and reading it as a control code
 * threw away every phrase containing a curly quote or an em dash, which in real documents
 * is most of them. Blanks are the five positions WinAnsi genuinely leaves unused.
 */
// prettier-ignore
const WIN_ANSI = [
  0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021,   // 80-87  euro, low quotes, dagger
  0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0,   // 88-8f
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,   // 90-97  the curly quotes and the dashes
  0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178,   // 98-9f
]
const winAnsi = (s: string) =>
  s.replace(/[\u0080-\u009f]/g, (c) => {
    const point = WIN_ANSI[c.charCodeAt(0) - 0x80]
    // Zero is one of the five positions WinAnsi genuinely leaves unused.
    return point ? String.fromCharCode(point) : ''
  })

/**
 * One string operand, as characters.
 *
 * Modern producers embed a subset of each font and address it two bytes at a time, so a
 * string arrives as pairs rather than as single bytes. When the pairs are code points this
 * reads them; when they are glyph numbers in a subset font, only that font's ToUnicode
 * table could say what they mean and we do not read those — so it returns '' rather than
 * the mojibake, and pdfText treats that as text it could not map.
 */
function decode(s: string) {
  // Single byte per character first, through WinAnsi, because that is the common case and
  // the punctuation has to survive it.
  const latin = winAnsi(s)
  if (readable(latin) > 0.9) return strip(latin)

  if (s.length < 2 || s.length % 2) return ''
  let zeros = 0
  for (let i = 0; i < s.length; i += 2) if (s.charCodeAt(i) === 0) zeros++
  // Mostly-zero high bytes is what two-byte text looks like. Not all, because one curly
  // quote in a paragraph is U+2019 and its high byte is 0x20.
  if (zeros < s.length / 2 - Math.max(1, s.length / 20)) return ''

  let out = ''
  for (let i = 0; i < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1))
  // Glyph numbers in a subset font are small integers, so they decode to control
  // characters. That is the tell, and it is the difference between text and nonsense.
  return readable(out) > 0.9 ? strip(out) : ''
}

/** `<48656c6c6f>` — the other way to write a string, and the usual one for embedded fonts. */
const fromHex = (s: string) => {
  const hex = s.replace(/[^0-9a-f]/gi, '')
  return decode(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex').toString('latin1'))
}

/** Adobe ASCII85 — ReportLab chains it in front of Flate by default. */
function ascii85(input: Buffer): Buffer {
  const out: number[] = []
  let tuple = 0
  let count = 0
  for (const ch of input.toString('latin1')) {
    if (ch === '~') break
    if (ch <= ' ') continue
    if (ch === 'z' && count === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    tuple = tuple * 85 + (ch.charCodeAt(0) - 33)
    if (++count === 5) {
      for (let s = 24; s >= 0; s -= 8) out.push((tuple >>> s) & 0xff)
      tuple = 0
      count = 0
    }
  }
  if (count > 1) {
    // A partial group encodes count-1 bytes; pad the rest with the max digit.
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84
    for (let s = 24, n = 0; n < count - 1; s -= 8, n++) out.push((tuple >>> s) & 0xff)
  }
  return Buffer.from(out)
}

/**
 * Why a PDF gave up no text, in the terms of what is actually in it.
 *
 * A file with pages and images and *no fonts* cannot contain text — nothing can be drawn
 * without a font — so that is not a guess, it is a fact worth stating plainly. "Probably a
 * scan" about a file that is definitely a scan is the kind of hedge that teaches people to
 * stop reading the message.
 *
 * Counted off the raw bytes rather than parsed: the object graph would have to be resolved
 * to do better, and these three numbers are enough to say which problem this is.
 */
export function describe(pdf: Buffer) {
  const raw = pdf.toString('latin1')
  const count = (re: RegExp) => (raw.match(re) ?? []).length
  return {
    pages: count(/\/Type\s*\/Page[^s]/g),
    images: count(/\/Subtype\s*\/Image/g),
    fonts: count(/\/Type\s*\/Font/g),
  }
}

/** Content streams, decoded through whatever filter chain the producer used. */
async function streams(pdf: Buffer): Promise<string[]> {
  const raw = pdf.toString('latin1')
  const out: string[] = []
  const re = /stream\r?\n?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) continue

    const header = raw.slice(Math.max(0, m.index - 400), m.index)

    /*
     * Skip what is declared not to be text before decoding it.
     *
     * A scanned page is one enormous JPEG, and inflating or scanning it costs real time on
     * a document that is hundreds of them. More to the point, binary run through a search
     * for text operators does occasionally match, and what comes back is not text — it is
     * the reason a scanned PDF used to produce a page of control characters instead of the
     * honest answer that there is nothing here to read.
     */
    if (/\/Subtype\s*\/Image|\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode)/.test(header)) continue

    const filters = [...header.matchAll(/\/(ASCII85Decode|FlateDecode|ASCIIHexDecode)/g)].map((f) => f[1])
    let body = pdf.subarray(start, end)
    try {
      for (const f of filters) {
        if (f === 'ASCII85Decode') body = ascii85(body)
        else if (f === 'FlateDecode') body = await inflateP(body, { maxOutputLength: MAX_STREAM_BYTES })
        else body = Buffer.from(body.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex')
      }
    } catch {
      continue // A stream we cannot decode is one we cannot read — keep the rest.
    }

    const text = body.toString('latin1')
    // Nothing to find, and everything to gain by not searching binary for it: a content
    // stream is ASCII operators, and anything that is not — an undeclared image, a font
    // program, a colour profile — has no BT..ET in it that means what it says.
    if (!text.includes('BT') || readable(text) < 0.8) continue
    out.push(text)
  }
  return out
}

/**
 * Best-effort plain text from a PDF.
 *
 * Returns '' when there is no text layer at all — a scan, a page of images. Throws when
 * there *is* one and it could not be turned into characters, because those are different
 * problems with different answers: one needs OCR, the other needs the file exported again
 * from whatever produced it. Telling somebody "probably a scan" about a document that is
 * plainly not a scan is how they stop believing the messages.
 *
 * Line breaks follow the text-positioning operators, so table rows stay on one line.
 */
export async function pdfText(pdf: Buffer): Promise<string> {
  const lines: string[] = []
  /** Strings we found and could not read. The difference between empty and unreadable. */
  let unmapped = 0

  for (const content of await streams(pdf)) {
    // \b matters: without it the ET inside a word like "PAYMENT DETAILS" ends the
    // text object early and the whole line is lost.
    for (const block of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
      let line = ''
      /** One operand in, its characters out — and a tally when there are none. */
      const take = (s: string) => {
        const got = decode(s)
        if (got) line += got
        else if (s.length) unmapped++
      }

      // Td/TD/T*/TJ-with-newline all move the cursor; treat a move as a break.
      for (const op of block[1].matchAll(
        /\((?<lit>(?:\\.|[^()\\])*)\)\s*(?:Tj|TJ|'|")|<(?<hex>[0-9a-fA-F\s]*)>\s*(?:Tj|TJ|'|")|\[(?<arr>(?:[^\]\\]|\\.)*)\]\s*TJ|(?<move>T\*|Td|TD)/g,
      )) {
        const g = op.groups!
        if (g.move) {
          if (line.trim()) lines.push(line.trim())
          line = ''
        } else if (g.lit !== undefined) {
          take(unescape(g.lit))
        } else if (g.hex !== undefined) {
          const got = fromHex(g.hex)
          if (got) line += got
          else if (g.hex.trim()) unmapped++
        } else if (g.arr !== undefined) {
          // Both string forms appear inside a TJ array, mixed with the kerning numbers.
          for (const piece of g.arr.matchAll(/\((?:\\.|[^()\\])*\)|<[0-9a-fA-F\s]*>|-?\d+(?:\.\d+)?/g)) {
            const t = piece[0]
            if (t.startsWith('(')) take(unescape(t.slice(1, -1)))
            else if (t.startsWith('<')) {
              const got = fromHex(t.slice(1, -1))
              if (got) line += got
              else if (t.length > 2) unmapped++
            }
            // A large negative kern is a word gap, not a letter tweak.
            else if (Number(t) < -100) line += ' '
          }
        }
      }
      if (line.trim()) lines.push(line.trim())
    }
  }

  const text = lines.join('\n')
  /*
   * Found strings, read almost none of them. The usual cause is a font embedded as a
   * subset and addressed by glyph number, where the mapping back to characters lives in a
   * table this does not read.
   */
  if (unmapped > 20 && text.trim().length < unmapped)
    throw new Error(
      'the text is stored as glyph numbers in embedded fonts, which cannot be read back. ' +
        'Re-export it as PDF/A or as text, or paste the content in.',
    )
  return text
}
