/**
 * Getting the pictures out of a PDF, so a scan can be read.
 *
 * A scanned page has no text in it — it is one photograph of a page. The only way to turn
 * that into knowledge is to look at the pixels, and this is the part that hands them over:
 * find the image objects, undo whatever compression they arrived in, and produce a file an
 * OCR engine will accept.
 *
 * ---------------------------------------------------------------- what it does not do
 *
 * ponytail: this reads image XObjects by pattern, it does not parse the document. There is
 * no page tree here, so the images come back in file order rather than page order, and an
 * image used twice appears once. For a scan — one full-page picture per page, in order,
 * which is what a scanner produces — those are the same thing. For a magazine layout with
 * forty decorative crops they are not, and the answer then is a real PDF library.
 *
 * The formats are the two that scans actually use: JPEG, which is already a file and is
 * handed straight over, and Flate, which is raw samples and gets wrapped into a PNG.
 * Anything else — CCITT fax, JBIG2, JPEG2000 — is skipped rather than guessed at.
 */
import { crc32, deflate, inflate } from 'node:zlib'
import { promisify } from 'node:util'

// Async, not the *Sync pair. Decompressing a scanned page and re-encoding it as a PNG is
// the heaviest CPU in an ingest, and on the event loop it stopped every other request the
// worker was holding. libuv's threadpool runs these instead; maxOutputLength and the
// errors it throws behave identically.
const deflateP = promisify(deflate)
const inflateP = promisify(inflate)

/** One picture, as a file an OCR engine can open. */
export type Picture = { bytes: Buffer; mime: 'image/png' | 'image/jpeg'; width: number; height: number }

/**
 * A cap, because OCR is measured in seconds per page and somebody will upload a book.
 *
 * Reached rather than guessed at: the caller is told how many were skipped so it can say
 * so, instead of quietly filing the first fifty pages of a three-hundred-page manual and
 * letting a bot answer confidently from a third of a document.
 */
export const MAX_PAGES = Number(process.env.OCR_MAX_PAGES ?? 60)

/**
 * A ceiling on /Width × /Height, read straight out of a stranger's PDF before a single
 * byte of the stream itself is touched. `toPng` sizes its output buffer from this pair
 * unconditionally, so an unchecked one is a memory allocation a hostile document controls
 * directly — no compression bomb needed, just a lie about the dimensions.
 *
 * 60 million pixels is a 600 DPI US Letter page (~34 million) with real headroom above it;
 * nothing a scanner produces gets close to this.
 */
const MAX_PIXELS = 60_000_000

/** `63 0 R` → the dictionary that object holds. Enough resolution for image parameters. */
function resolve(raw: string, value: string): string {
  const ref = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(value)
  if (!ref) return value
  const found = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+0\\s+obj([\\s\\S]{0,2000}?)endobj`).exec(raw)
  return found ? found[1] : value
}

const num = (dict: string, key: string) => {
  const m = new RegExp(`/${key}\\s+(\\d+)`).exec(dict)
  return m ? Number(m[1]) : 0
}

/** How many samples per pixel. The colour space decides, and it may be behind a reference. */
function components(raw: string, dict: string): number {
  const m = /\/ColorSpace\s*(\/\w+|\d+\s+\d+\s+R|\[[^\]]*\])/.exec(dict)
  const space = m ? resolve(raw, m[1]) : ''
  if (/DeviceCMYK/.test(space)) return 4
  if (/DeviceGray|CalGray/.test(space)) return 1
  if (/DeviceRGB|CalRGB/.test(space)) return 3
  /*
   * ICCBased carries the count in /N, which is the whole reason it needs resolving — and it
   * comes out of the file, so it is attacker-controlled. It feeds the zlib output bound below
   * as `(width * comps + 1) * height`, and MAX_PIXELS caps only the other two factors: an
   * `/N 999999999` made that bound about 10^14, which is no bound at all, and the inflate ran
   * until the process died. Four is the largest colour space this reader knows how to turn
   * into a PNG, so anything above it is already unusable and can be clamped rather than
   * trusted — `toPng` rejects the value afterwards either way, but only after inflating.
   */
  const n = num(space, 'N')
  return n >= 1 && n <= 4 ? n : 3
}

// ---------------------------------------------------------------- PNG

const chunk = (type: string, body: Buffer) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  const tail = Buffer.alloc(4)
  // The CRC covers the type and the body, not the length.
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, tail])
}

/**
 * Raw samples into a PNG.
 *
 * The two formats are closer than they look: PNG's image data is exactly zlib-compressed
 * scanlines, each with a leading filter byte. So this is a header, a filter byte per row,
 * and the same deflate the PDF already used.
 *
 * `predicted` is the case where the PDF applied a PNG predictor on the way in — the filter
 * bytes are already there and re-inserting them would shift every row by a pixel.
 */
async function toPng(samples: Buffer, width: number, height: number, comps: number, predicted: boolean): Promise<Buffer | null> {
  const colour = comps === 1 ? 0 : comps === 3 ? 2 : -1
  // CMYK and paletted images are not what a scanner makes, and guessing at a conversion
  // would hand OCR a picture of the wrong colours.
  if (colour < 0) return null

  const stride = width * comps
  let raster: Buffer
  if (predicted) {
    if (samples.length < (stride + 1) * height) return null
    raster = samples.subarray(0, (stride + 1) * height)
  } else {
    if (samples.length < stride * height) return null
    raster = Buffer.alloc((stride + 1) * height)
    for (let y = 0; y < height; y++) {
      raster[y * (stride + 1)] = 0 // filter: none
      samples.copy(raster, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bits per sample
  ihdr[9] = colour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflateP(raster)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- the pictures

/**
 * Every page-sized picture in the file, in the order they appear.
 *
 * Small images are dropped on purpose. A scan is one big photograph per page; a logo in a
 * header, a signature, a bullet glyph and a QR code are all images too, and running OCR on
 * a 40×40 icon costs a second and returns noise.
 */
export async function pictures(pdf: Buffer, limit = MAX_PAGES): Promise<{ found: Picture[]; skipped: number }> {
  const raw = pdf.toString('latin1')
  const found: Picture[] = []
  let skipped = 0

  /*
   * Object numbers that are somebody's transparency mask.
   *
   * A mask is an image object in its own right, the same size as the picture it belongs
   * to, so nothing about the object itself says it is not a page. What says so is being
   * pointed at by /SMask — which is why this is collected from the whole file first. Miss
   * it and every page is read twice: once as the photograph and once as its alpha channel,
   * which OCRs to nothing and doubles the time.
   */
  const masks = new Set([...raw.matchAll(/\/S?Mask\s+(\d+)\s+\d+\s+R/g)].map((x) => x[1]))

  const re = /stream\r?\n?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) continue

    const dict = raw.slice(Math.max(0, m.index - 600), m.index)
    if (!/\/Subtype\s*\/Image/.test(dict)) continue

    const width = num(dict, 'Width')
    const height = num(dict, 'Height')
    // Under a quarter of a megapixel is furniture, not a page. Over MAX_PIXELS is not a
    // real scan — a 600 DPI US Letter page is ~34 million pixels, so this has headroom —
    // it is /Width and /Height doing the one thing a hostile PDF needs them to: name a
    // buffer size. `toPng` allocates `(width * comps + 1) * height` unconditionally,
    // before it has read a byte of the stream, so an unchecked pair is a multi-gigabyte
    // allocation attempt with no compression bomb required at all.
    const pixels = width * height
    if (pixels < 250_000 || pixels > MAX_PIXELS) continue

    // Whose object is this? The last `N 0 obj` before the stream is its own.
    const self = [...dict.matchAll(/(\d+)\s+0\s+obj/g)].at(-1)?.[1]
    if (self && masks.has(self)) continue

    if (found.length >= limit) {
      skipped++
      continue
    }

    /*
     * The format requires an end-of-line between the data and `endstream`, and it is not
     * part of the data. Flate shrugs a stray byte off; a JPEG handed straight to a decoder
     * does not necessarily, and it would no longer be the file that went in.
     */
    let stop = end
    if (pdf[stop - 1] === 0x0a) stop--
    if (pdf[stop - 1] === 0x0d) stop--
    const body = pdf.subarray(start, stop)

    // Already a file. Nothing to do but hand it over, which is why JPEG scans are cheap.
    if (/\/DCTDecode/.test(dict)) {
      found.push({ bytes: body, mime: 'image/jpeg', width, height })
      continue
    }
    // Fax and wavelet codecs need a real decoder each. Counted as skipped rather than
    // silently dropped, so the message can say the pages were not read.
    if (!/\/FlateDecode/.test(dict)) {
      skipped++
      continue
    }

    try {
      const parms = resolve(raw, (/\/DecodeParms\s*(<<[\s\S]*?>>|\d+\s+\d+\s+R)/.exec(dict) ?? ['', ''])[1] ?? '')
      const comps = components(raw, dict)
      /*
       * The exact ceiling, not a round number picked to feel generous. `toPng` never
       * reads past `(stride + 1) * height` of decompressed data in either branch — that
       * is the whole predicted raster, one filter byte per row — so a stream inflating
       * past that is already lying about what it contains, whatever /Width and /Height
       * said. Width and height are themselves bounded by MAX_PIXELS above, so this can
       * never be asked to hold more than that ceiling implies either.
       */
      const bound = (width * comps + 1) * height
      // Anything from 10 up is one of the PNG predictors, which is the case where the
      // filter bytes survive decompression.
      const png = await toPng(await inflateP(body, { maxOutputLength: bound }), width, height, comps, num(parms, 'Predictor') >= 10)
      if (png) found.push({ bytes: png, mime: 'image/png', width, height })
      else skipped++
    } catch {
      skipped++
    }
  }

  return { found, skipped }
}
