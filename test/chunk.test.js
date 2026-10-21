import assert from 'node:assert/strict'
import test from 'node:test'

// Pure and I/O free — no schema, no database, no imports from the harness.
import { chunk } from '../src/server/chunk.ts'

test('nothing in, nothing out', () => {
  assert.deepEqual(chunk(''), [])
  assert.deepEqual(chunk('   \n\n \t '), [])
})

test('a short document is one chunk, unchanged', () => {
  assert.deepEqual(chunk('Refunds take five working days.'), ['Refunds take five working days.'])
})

test('it breaks where the author broke, and keeps every word', () => {
  const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`.trim())
  const out = chunk(paras.join('\n\n'), { size: 400, overlap: 40 })

  assert.ok(out.length > 1, 'should have split')
  // Every paragraph survives somewhere, which is the property that matters: a chunker
  // that silently drops text makes the knowledge base quietly incomplete.
  for (const p of paras) assert.ok(out.some((c) => c.includes(`Paragraph ${p.split(' ')[1]} `)), p.slice(0, 20))
})

test('consecutive chunks overlap, so a fact on a boundary is whole somewhere', () => {
  const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
  const out = chunk(text, { size: 120, overlap: 40 })
  assert.ok(out.length > 2)

  // The start of each chunk after the first appears at the end of the one before it.
  for (let i = 1; i < out.length; i++) {
    const head = out[i].slice(0, 12)
    assert.ok(out[i - 1].includes(head), `chunk ${i} does not overlap chunk ${i - 1}`)
  }
})

test('a paragraph with no breaks at all is still cut to size', () => {
  // A minified stylesheet, or a table with no punctuation: no paragraph break, no
  // sentence end, nothing to prefer. It must not come back as one enormous chunk.
  const blob = 'x'.repeat(5000)
  const out = chunk(blob, { size: 500, overlap: 50 })
  assert.ok(out.length >= 10)
  for (const c of out) assert.ok(c.length <= 550, `chunk of ${c.length} exceeds size + overlap`)
})

test('chunks stay within size plus overlap', () => {
  const text = Array.from({ length: 60 }, (_, i) => `Item ${i}. ${'detail '.repeat(15)}`).join('\n\n')
  for (const c of chunk(text, { size: 600, overlap: 80 })) assert.ok(c.length <= 680, `chunk of ${c.length}`)
})

test('windows line endings and runs of blank lines do not change the result', () => {
  const unix = 'One paragraph.\n\nTwo paragraph.'
  const windows = 'One paragraph.\r\n\r\n\r\n\r\nTwo paragraph.'
  assert.deepEqual(chunk(windows), chunk(unix))
})

test('an overlap that is not smaller than the size is refused', () => {
  // It would make every chunk start with the whole of the previous one, and never finish.
  assert.throws(() => chunk('some text', { size: 100, overlap: 100 }), /smaller/)
})
