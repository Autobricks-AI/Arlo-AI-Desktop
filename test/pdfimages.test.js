/**
 * Getting the pictures out of a PDF, which is what makes reading a scan possible.
 *
 * Pure and offline: no database, no OCR, no language model downloaded. The OCR itself is
 * switched off in the test harness on purpose — what is worth proving here is that the
 * right pictures come out, at the right size, in a format something can open. Whether
 * Tesseract can read them is Tesseract's business.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync, inflateSync } from 'node:zlib'

const { pictures } = await import('../src/server/pdfimages.ts')
const { denoise } = await import('../src/server/ocr.ts')

/** An object holding one image, as a PDF writes it. */
const imageObj = (n, dict, body) =>
  Buffer.concat([
    Buffer.from(`${n} 0 obj\n<< /Subtype /Image ${dict} /Length ${body.length} >>\nstream\n`),
    body,
    Buffer.from('\nendstream\nendobj\n'),
  ])

const file = (...objs) => Buffer.concat([Buffer.from('%PDF-1.4\n'), ...objs, Buffer.from('%%EOF\n')])

/** A page-sized block of raw RGB samples — what a Flate-compressed scan actually holds. */
const rgb = (w, h) => {
  const b = Buffer.alloc(w * h * 3)
  for (let i = 0; i < b.length; i++) b[i] = (i * 13) % 256
  return b
}

// ---------------------------------------------------------------- what comes out

test('a Flate page becomes a PNG of the right size', async () => {
  const w = 600
  const h = 500
  const pdf = file(imageObj(1, `/Filter /FlateDecode /Width ${w} /Height ${h} /BitsPerComponent 8 /ColorSpace /DeviceRGB`, deflateSync(rgb(w, h))))

  const { found, skipped } = await pictures(pdf)
  assert.equal(found.length, 1)
  assert.equal(skipped, 0)
  assert.equal(found[0].mime, 'image/png')
  assert.equal(found[0].width, w)
  assert.equal(found[0].height, h)

  // A real PNG: the signature, then IHDR carrying the dimensions we claimed.
  const png = found[0].bytes
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR')
  assert.equal(png.readUInt32BE(16), w)
  assert.equal(png.readUInt32BE(20), h)
  assert.equal(png[24], 8, 'eight bits per sample')
  assert.equal(png[25], 2, 'colour type 2 is RGB')

  // And the pixels survived. One filter byte per row is the whole difference between
  // PDF samples and PNG scanlines, and getting it wrong shears the image diagonally.
  const idatAt = png.indexOf('IDAT', 0, 'latin1')
  const idatLen = png.readUInt32BE(idatAt - 4)
  const raster = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + idatLen))
  assert.equal(raster.length, (w * 3 + 1) * h)
  assert.equal(raster[0], 0, 'filter: none')
  assert.deepEqual([...raster.subarray(1, 5)], [...rgb(w, h).subarray(0, 4)])
})

test('a JPEG page is handed over as it is', async () => {
  // Already a file. Re-encoding it would cost time and quality for nothing.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), rgb(600, 500).subarray(0, 90_000)])
  const pdf = file(imageObj(1, '/Filter /DCTDecode /Width 600 /Height 500', jpeg))

  const { found } = await pictures(pdf)
  assert.equal(found.length, 1)
  assert.equal(found[0].mime, 'image/jpeg')
  assert.ok(found[0].bytes.equals(jpeg), 'the JPEG should be byte-identical, not re-encoded')
})

test('greyscale works, and a colour space we cannot read is skipped rather than guessed', async () => {
  const grey = Buffer.alloc(600 * 500)
  const ok = file(imageObj(1, '/Filter /FlateDecode /Width 600 /Height 500 /BitsPerComponent 8 /ColorSpace /DeviceGray', deflateSync(grey)))
  assert.equal((await pictures(ok)).found[0].bytes[25], 0, 'colour type 0 is greyscale')

  // CMYK would need a conversion, and a wrong one hands OCR a picture of the wrong colours.
  const cmyk = file(imageObj(1, '/Filter /FlateDecode /Width 600 /Height 500 /BitsPerComponent 8 /ColorSpace /DeviceCMYK', deflateSync(Buffer.alloc(600 * 500 * 4))))
  const out = await pictures(cmyk)
  assert.deepEqual(out.found, [])
  assert.equal(out.skipped, 1, 'skipped is counted so the message can say pages were missed')
})

test('a codec we have no decoder for is counted, not silently dropped', async () => {
  // Fax and JPEG2000 each need a real decoder. A page nobody read is a hole in the
  // knowledge base, and a hole nobody is told about is the worse kind.
  const pdf = file(imageObj(1, '/Filter /CCITTFaxDecode /Width 1700 /Height 2200', Buffer.alloc(4000)))
  assert.deepEqual(await pictures(pdf), { found: [], skipped: 1 })
})

// ---------------------------------------------------------------- what stays out

test('logos and icons are not pages', async () => {
  // A scan is one big photograph per page. Running OCR on a 64x64 icon costs a second and
  // returns noise, and every header on every page has one.
  const icon = file(imageObj(1, '/Filter /FlateDecode /Width 64 /Height 64 /BitsPerComponent 8 /ColorSpace /DeviceRGB', deflateSync(rgb(64, 64))))
  assert.deepEqual(await pictures(icon), { found: [], skipped: 0 })
})

test('a transparency mask is not read as a second copy of its own page', async () => {
  /*
   * A mask is an image object the same size as the picture it belongs to, so nothing about
   * the object itself says it is not a page. Missing this read every page twice — once as
   * the photograph and once as its alpha channel, which OCRs to nothing and doubles the
   * time. It is what the real file that prompted all this actually does.
   */
  const page = imageObj(63, '/Filter /FlateDecode /Width 600 /Height 500 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask 64 0 R', deflateSync(rgb(600, 500)))
  const mask = imageObj(64, '/Filter /FlateDecode /Width 600 /Height 500 /BitsPerComponent 8 /ColorSpace /DeviceGray', deflateSync(Buffer.alloc(600 * 500)))

  const { found } = await pictures(file(page, mask))
  assert.equal(found.length, 1, 'one page, not the page and its own alpha channel')
  assert.equal(found[0].bytes[25], 2, 'and the one kept is the colour photograph')
})

test('the page cap holds, and says how much it left', async () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    imageObj(i + 1, `/Filter /FlateDecode /Width 600 /Height 500 /BitsPerComponent 8 /ColorSpace /DeviceRGB`, deflateSync(rgb(600, 500))),
  )
  const { found, skipped } = await pictures(file(...many), 4)
  assert.equal(found.length, 4)
  // OCR is seconds a page and somebody will upload a book. Silently reading the first
  // forty pages of a three-hundred-page manual would let a bot answer confidently from a
  // seventh of a document.
  assert.equal(skipped, 2)
})

// ---------------------------------------------------------------- hostile dimensions and streams

test('a declared size that would demand gigabytes is refused before the stream is even read', async () => {
  /*
   * toPng allocates its output buffer from /Width and /Height alone, before a byte of the
   * stream is touched — so an untrusted pair naming a 10-billion-pixel image is a memory
   * allocation the file controls directly, no compression bomb required. The stream body
   * here is a single byte, which is the point: what refuses this is the declared size.
   */
  const huge = file(imageObj(1, '/Filter /FlateDecode /Width 100000 /Height 100000 /BitsPerComponent 8 /ColorSpace /DeviceGray', Buffer.from([0])))
  const t0 = Date.now()
  assert.deepEqual(await pictures(huge), { found: [], skipped: 0 })
  assert.ok(Date.now() - t0 < 200, 'refused on the declared size, not on failing to decode the stream')
})

test('a stream that inflates to far more than its own declared size claims is refused, not truncated', async () => {
  /*
   * The companion case: dimensions modest enough to pass the size ceiling on their own
   * (1000x1000 needs roughly a megabyte), but the stream is a bomb that inflates to 60MB —
   * lying about its own content rather than about its dimensions. maxOutputLength is keyed
   * to what the declared width/height actually need, so a mismatch this large is refused.
   */
  const bomb = file(imageObj(1, '/Filter /FlateDecode /Width 1000 /Height 1000 /BitsPerComponent 8 /ColorSpace /DeviceGray', deflateSync(Buffer.alloc(60 * 1024 * 1024, 1))))
  const t0 = Date.now()
  const { found, skipped } = await pictures(bomb)
  assert.equal(found.length, 0)
  assert.equal(skipped, 1, 'counted as skipped, the same as any other stream that fails to decode')
  assert.ok(Date.now() - t0 < 2000, 'refusing it must not itself take as long as inflating it would')
})

// ---------------------------------------------------------------- what OCR gives back

test('illustration noise is dropped, and words are not', async () => {
  /*
   * OCR reads whatever is in front of it, and a slide is half picture. `Lh Sa b oo®` is
   * not harmless — it becomes a passage, a passage can match a question, and a matched
   * passage is quoted back to a customer as something the company said.
   */
  const raw = [
    'We live for the food. We pay with our cells.',
    'Lh Sa b oo® - ort',
    '~ + £4 A) Gr',
    'MONEY (SGD) vs CELLULAR ENERGY (ATP)',
    '€P)',
    'Delivery takes 2-3 working days.',
  ].join('\n')

  const got = denoise(raw).split('\n')
  assert.deepEqual(got, [
    'We live for the food. We pay with our cells.',
    'MONEY (SGD) vs CELLULAR ENERGY (ATP)',
    'Delivery takes 2-3 working days.',
  ])
})

test('a line of prose with artwork read into it keeps the prose and loses the artwork', async () => {
  /*
   * The case line filtering cannot touch. A slide has words on the left and a picture on
   * the right, and OCR reads straight across — so one line arrives as prose and noise glued
   * together, and the only thing that tells them apart is how sure the engine was.
   *
   * The numbers are real ones off the file that prompted this: text in the nineties,
   * illustration in the tens, and almost nothing in between.
   */
  const word = (text, confidence) => ({ text, confidence })
  const page = {
    text: 'ignored — the words are what count',
    blocks: [
      {
        paragraphs: [
          {
            lines: [
              {
                words: [
                  word('The', 96), word('compounding', 95), word('cost', 96), word('of', 96),
                  word('the', 96), word('Singaporean', 95),
                  word('A', 45), word('Na', 24), word('|', 52), word('\\', 0), word('a', 23),
                ],
              },
              { words: [word('Zr', 14), word('yaa', 20), word('i.', 0)] },
            ],
          },
        ],
      },
    ],
  }

  const { confidentText } = await import('../src/server/ocr.ts')
  assert.equal(confidentText(page), 'The compounding cost of the Singaporean')
})

test('a page with no word detail still gives back what it read', async () => {
  // An older engine build, or a page it could not segment. Plain text is worse than
  // per-word confidence and it is a great deal better than nothing.
  const { confidentText } = await import('../src/server/ocr.ts')
  assert.equal(confidentText({ text: 'Refunds within 30 days.' }), 'Refunds within 30 days.')
})

test('denoise keeps a line it is unsure about', async () => {
  // The trade is deliberate: noise is embarrassing, a dropped line is an answer nobody
  // gets. So one real word and mostly ordinary characters is enough to survive.
  assert.equal(denoise('Warranty: 12 months*'), 'Warranty: 12 months*')
  assert.equal(denoise('Prices from $9.99 — see table'), 'Prices from $9.99 — see table')
})

// ---------------------------------------------------------------- the card preview

test('a PDF with artwork gets a preview, and a text-only one does not', async () => {
  const { thumbnail } = await import('../src/server/media.ts')
  const sharp = (await import('sharp')).default

  const w = 600
  const h = 800
  const art = `/Filter /FlateDecode /Width ${w} /Height ${h} /BitsPerComponent 8 /ColorSpace /DeviceRGB`
  const got = await thumbnail(file(imageObj(1, art, deflateSync(rgb(w, h)))), 'application/pdf')

  // The route that serves these says image/webp, and it must not be lying.
  const meta = await sharp(got).metadata()
  assert.equal(meta.format, 'webp')
  assert.ok(meta.width <= 320 && meta.height <= 320, `still ${meta.width}x${meta.height}`)
  assert.ok(got.length < 40_000, `a card preview, not a page scan: ${got.length} bytes`)

  /*
   * A logo in a header is furniture, not a page, and `pictures()` already drops anything under
   * a quarter of a megapixel. So "nothing came back" and "nothing worth showing" are one
   * condition, and a contract drawn entirely in text falls back to its badge rather than to a
   * picture of its letterhead.
   */
  const logo = `/Filter /FlateDecode /Width 80 /Height 60 /BitsPerComponent 8 /ColorSpace /DeviceRGB`
  assert.equal(await thumbnail(file(imageObj(1, logo, deflateSync(rgb(80, 60)))), 'application/pdf'), null)

  // An image is its own thumbnail. Nothing is generated for one, whatever is inside it.
  assert.equal(await thumbnail(file(imageObj(1, art, deflateSync(rgb(w, h)))), 'image/png'), null)
})

test('the preview is cut from the biggest page, not the first one', async () => {
  const { thumbnail } = await import('../src/server/media.ts')
  const sharp = (await import('sharp')).default

  /*
   * pdfimages has no page tree, so what comes back is file order. On a real library the first
   * image was a wide header strip and the largest was the page artwork, so picking the first
   * gives a card a picture of a banner. Both are over the furniture threshold, so only the
   * choice separates them.
   */
  const strip = `/Filter /FlateDecode /Width 900 /Height 300 /BitsPerComponent 8 /ColorSpace /DeviceRGB`
  const page = `/Filter /FlateDecode /Width 700 /Height 900 /BitsPerComponent 8 /ColorSpace /DeviceRGB`
  const pdf = file(
    imageObj(1, strip, deflateSync(rgb(900, 300))),
    imageObj(2, page, deflateSync(rgb(700, 900))),
  )

  const meta = await sharp(await thumbnail(pdf, 'application/pdf')).metadata()
  // 700x900 scaled inside 320 is portrait; the strip would have come out landscape.
  assert.ok(meta.height > meta.width, `got ${meta.width}x${meta.height}, which is the header strip`)
})
