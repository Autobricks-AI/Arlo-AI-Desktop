/**
 * Reading a PDF, and — the part that broke — knowing when you have not.
 *
 * A PDF is mostly binary wearing the same wrapper as its text: an image, a font program
 * and a page of instructions are all `stream ... endstream`. Searching the binary ones for
 * text operators is how a scanned book produced a page of NUL bytes and a database error
 * instead of the honest answer that there is nothing here to read.
 *
 * No database and no schema — this is a pure function, so the tests are too.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

const { describe, pdfText } = await import('../src/server/pdftext.ts')

/** A PDF with one stream in it. Enough of the format for the extractor to find it. */
const pdf = (dict, body) =>
  Buffer.concat([
    Buffer.from(`%PDF-1.7\n1 0 obj\n<< ${dict} /Length ${body.length} >>\nstream\n`),
    Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
    Buffer.from('\nendstream\nendobj\n%%EOF\n'),
  ])

const flate = (dict, body) => pdf(`${dict} /Filter /FlateDecode`, deflateSync(Buffer.from(body, 'latin1')))

const NUL = '\u0000'

// ---------------------------------------------------------------- the ordinary case

test('text set as literal strings is read', async () => {
  const got = await pdfText(pdf('', 'BT (Open nine to five) Tj T* (Closed on Sunday) Tj ET'))
  assert.equal(got, 'Open nine to five\nClosed on Sunday')
})

test('a compressed content stream is read', async () => {
  assert.match(await pdfText(flate('', 'BT (Refunds within 30 days) Tj ET')), /Refunds within 30 days/)
})

test('kerning inside a TJ array becomes a space, not a number', async () => {
  const got = await pdfText(pdf('', 'BT [(Total) -400 (due)] TJ ET'))
  assert.equal(got, 'Total due')
  assert.doesNotMatch(got, /400/)
})

// ---------------------------------------------------------------- hex strings

test('text written as a hex string is read', async () => {
  // The other way the format allows, and the usual one once a font is embedded. Nothing
  // used to match this at all, so a document written this way came back empty.
  const hex = Buffer.from('Delivery takes 3 days', 'latin1').toString('hex')
  assert.equal(await pdfText(pdf('', `BT <${hex}> Tj ET`)), 'Delivery takes 3 days')
})

test('two-byte text is read as characters, not as every other byte', async () => {
  // What an embedded font addressed two bytes at a time produces. Each pair is a code
  // point here, so it reads exactly; the zero high bytes are what used to reach Postgres.
  const utf16 = [...'Warranty is 12 months'].map((c) => '00' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  assert.equal(await pdfText(pdf('', `BT <${utf16}> Tj ET`)), 'Warranty is 12 months')
})

test('a mixed TJ array of hex strings and kerns reads as one line', async () => {
  const h = (s) => Buffer.from(s, 'latin1').toString('hex')
  assert.equal(await pdfText(pdf('', `BT [<${h('Price')}> -500 <${h('list')}>] TJ ET`)), 'Price list')
})

// ---------------------------------------------------------------- what is not text

test('an image stream is never searched for text', async () => {
  /*
   * The bug, in one test. JPEG data that happens to contain BT and ET used to be scanned
   * as if it were instructions, and what came out was binary — including the NUL bytes
   * Postgres refuses, which is the error somebody actually saw.
   */
  const jpeg = Buffer.from(`\xff\xd8\xff\xe0BT (\x00\x01\x02) Tj ET\x00\x00\xff\xd9`, 'latin1')
  assert.equal(await pdfText(pdf('/Subtype /Image /Filter /DCTDecode', jpeg)), '')
})

test('a scanned page produces nothing rather than nonsense', async () => {
  // Two hundred pages of this is what a 17MB scan of a book looks like.
  const page = Buffer.alloc(4096)
  for (let i = 0; i < page.length; i++) page[i] = i % 256
  assert.equal(await pdfText(pdf('/Subtype /Image /Filter /DCTDecode', page)), '')
})

test('binary that never declared itself an image is still not read as text', async () => {
  // An embedded font program, a colour profile, a thumbnail with a lazy dictionary. The
  // declaration is a courtesy, so what it looks like has to be the real test.
  const font = Buffer.alloc(2048)
  for (let i = 0; i < font.length; i++) font[i] = (i * 7) % 256
  const withMarkers = Buffer.concat([Buffer.from('BT ('), font, Buffer.from(') Tj ET')])
  assert.equal(await pdfText(pdf('/Subtype /Type1C', withMarkers)), '')
})

test('nothing that comes out ever carries a NUL byte', async () => {
  /*
   * The invariant behind the reported error, stated once. Whatever this function returns
   * goes into a Postgres text column, and a NUL there is not bad data — it is a failed
   * statement that loses the whole document.
   */
  const nasty = [
    pdf('', `BT (before${NUL}after) Tj ET`),
    pdf('', `BT <0000000100020003> Tj ET`),
    pdf('/Subtype /Image /Filter /DCTDecode', Buffer.from(`BT (${NUL}${NUL}${NUL}) Tj ET`, 'latin1')),
  ]
  for (const p of nasty) {
    let out = ''
    try {
      out = await pdfText(p)
    } catch {
      continue // Refusing is a fine answer; filing NULs is not.
    }
    assert.ok(!out.includes(NUL), `NUL survived extraction: ${JSON.stringify(out.slice(0, 60))}`)
  }
})

test('typographic punctuation survives, rather than taking its sentence with it', async () => {
  /*
   * WinAnsiEncoding is what most PDFs are written in, and it puts curly quotes, dashes and
   * the ellipsis in the byte range Latin-1 reserves for control codes. Treating those as
   * binary threw away every phrase that contained one — which in real prose is most of them.
   */
  const oct = (n) => '\\' + n.toString(8)
  const body = `BT (Our ${oct(0x93)}no quibble${oct(0x94)} policy${oct(0x97)}30 days${oct(0x85)}) Tj ET`
  const got = await pdfText(pdf('', body))

  assert.match(got, /no quibble/, 'the sentence was dropped for containing a curly quote')
  assert.match(got, /“no quibble”/, 'curly quotes should read as curly quotes')
  assert.match(got, /policy—30 days…/, 'the em dash and ellipsis should survive too')
})

// ---------------------------------------------------------------- honest failure

test('a scan is described, not guessed at', async () => {
  // Pages, images and no fonts. Nothing can be drawn without a font, so this is a fact
  // about the file rather than a hunch about it.
  const page = Buffer.alloc(2048)
  for (let i = 0; i < page.length; i++) page[i] = i % 256
  const scanned = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page /MediaBox [0 0 612 792] >>\nendobj\n'),
    pdf('/Subtype /Image /Filter /FlateDecode /Width 100 /Height 100', page),
  ])

  const seen = describe(scanned)
  assert.equal(seen.pages, 1)
  assert.ok(seen.images >= 1)
  assert.equal(seen.fonts, 0, 'no fonts is what makes it certain')
  assert.equal(await pdfText(scanned), '')
})

test('glyph numbers are refused, and say so in different words than a scan', async () => {
  /*
   * A subset font addressed by glyph index: real text, genuinely unreadable without the
   * font's own ToUnicode table. Small numbers, so decoding them as characters gives
   * control codes — which is the tell, and the reason this is refused rather than filed.
   */
  const glyphs = Array.from({ length: 40 }, (_, i) => (i + 1).toString(16).padStart(4, '0')).join('')
  const blocks = Array.from({ length: 30 }, () => `BT <${glyphs}> Tj ET`).join('\n')

  await assert.rejects(async () => pdfText(pdf('', blocks)), /glyph numbers/)
  // Not the scan message: this document is not a scan, and saying so would teach somebody
  // to stop reading the messages.
  await assert.rejects(async () => pdfText(pdf('', blocks)), (e) => !/scan/.test(e.message))
})

test('a document with no text layer at all is empty, not an error', async () => {
  // Empty and refused are different states with different answers — OCR versus re-export.
  assert.equal(await pdfText(Buffer.from('%PDF-1.4\n%%EOF\n')), '')
})

test('a little unreadable text does not condemn a readable document', async () => {
  // One decorative glyph in a heading must not throw away the pages around it.
  const body = `BT (Our returns policy is thirty days from delivery, no questions asked.) Tj ET\nBT <0001> Tj ET`
  assert.match(await pdfText(pdf('', body)), /returns policy is thirty days/)
})

// ---------------------------------------------------------------- decompression bombs

test('a stream that decompresses to far more than any page holds is skipped, not expanded', async () => {
  /*
   * A handful of compressed bytes standing for 60MB of decompressed space, wrapped in an
   * otherwise ordinary content stream. Before maxOutputLength this ran to completion and
   * held the whole 60MB in memory; here it has to be refused, and quickly.
   */
  const bomb = pdf('/Filter /FlateDecode', deflateSync(Buffer.alloc(60 * 1024 * 1024, 0x20)))
  const t0 = Date.now()
  assert.equal(await pdfText(bomb), '', 'a stream over the cap contributes no text')
  assert.ok(Date.now() - t0 < 2000, 'refusing it must not itself take as long as inflating it would')
})

test('an ordinary compressed page is nowhere near the cap and still reads', async () => {
  // The cap exists to catch a stream lying about its size, not to catch a real page —
  // a dense page of body text is tens of kilobytes, several orders of magnitude under it.
  assert.match(await pdfText(flate('', 'BT (Refunds within 30 days) Tj ET')), /Refunds within 30 days/)
})
