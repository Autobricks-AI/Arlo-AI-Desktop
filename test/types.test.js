/**
 * The pure arithmetic in types.ts.
 *
 * Pulled out of the components so it can be checked here: the days a calendar asks the
 * database for against the days it then draws, what a call is estimated to cost, and where
 * a table's paging lands when the rows move under it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { calendarRange, shiftCalendar, dayKey } = await import('../src/types.ts')

test('the calendar asks for exactly the days it draws', () => {
  // The loader queries this range and the grid renders these keys. If the two disagreed, an
  // entry would land in a cell nobody is looking at.
  for (const view of ['day', 'week', 'month']) {
    const { keys, from, to } = calendarRange('2026-08-21', view)
    assert.equal(dayKey(from), keys[0], `${view}: the range starts before the first day drawn`)
    // Half-open, so `to` is the morning after the last day rather than inside it.
    assert.equal(dayKey(to) > keys[keys.length - 1], true, `${view}: the last day drawn is outside the range`)
  }

  const m = calendarRange('2026-08-21', 'month')
  assert.equal(m.keys.length % 7, 0)
  assert.ok(m.keys.includes('2026-08-01') && m.keys.includes('2026-08-31'))
  assert.deepEqual(calendarRange('2026-08-23', 'week').keys[0], '2026-08-17', 'a week starts on Monday')
  assert.equal(shiftCalendar('2026-01-31', 'month', 1), '2026-02-01', 'a month step must not skip February')
})

// ---------------------------------------------------------------- paging a table

const { pageOf } = await import('../src/types.ts')

test('a page that outlived its rows lands on the last one, not past the end', () => {
  /*
   * The edge worth having this function for. A page index survives the list it indexes —
   * fewer rows come back on a reload while page three is open — and slicing past the end
   * renders an empty table whose "next" button is already disabled, so there is no way back
   * to the rows that are still there.
   */
  assert.deepEqual(pageOf(12, 5, 2), { at: 2, pages: 3, from: 10, to: 15 })
  assert.deepEqual(pageOf(3, 5, 2), { at: 0, pages: 1, from: 0, to: 5 }, 'shrunk to one page: clamped back to it')
  assert.equal(pageOf(7, 5, 99).at, 1, 'far past the end is still the last page')
  assert.equal(pageOf(7, 5, -3).at, 0, 'and a negative page is the first')
})

test('an empty list is one empty page, not zero pages', () => {
  // `pages` of 0 would make the last index -1, and "1 of 0" is not a thing to render.
  assert.deepEqual(pageOf(0, 5, 0), { at: 0, pages: 1, from: 0, to: 5 })
})

test('a page size of nothing does not divide by zero', () => {
  // Not reachable from the callers today, which is exactly why it is worth pinning: a
  // default that someone later threads from a setting could arrive as 0 and yield Infinity.
  assert.equal(Number.isFinite(pageOf(10, 0, 0).pages), true)
})

// ---------------------------------------------------------------- whose turn it is

const { endsConversation } = await import('../src/types.ts')

/**
 * The check that decides whether a bot going live replies to a thread or just takes it back.
 *
 * Both directions are tested because they cost different things. Calling a question an
 * ending leaves a customer waiting, so that must not happen to anything with content in it.
 * Calling an ending a question sends one unnecessary message, which is the cheaper mistake
 * and the one the rule is allowed to make.
 */
test('a message made only of sign-offs ends the conversation', () => {
  for (const said of [
    'thanks',
    'Thanks!',
    'ok thanks',
    'thank you so much for your help',
    'got it, bye',
    'noted, cheers',
    'no problem, thanks a lot',
    'okay great',
    'all good thanks',
    "that's all for now, thank you",
  ])
    assert.equal(endsConversation(said), true, said)
})

test('a message with anything to answer in it does not', () => {
  for (const asked of [
    'tell me more about the delivery options',
    'ok but what about delivery?',
    'thanks, and how much is shipping?',
    'how much is it',
    'no i still need help',
    'what time do you open',
    'yo',
    'is the blue one in stock',
  ])
    assert.equal(endsConversation(asked), false, asked)
})

test('a reply with no words at all is an ending, not a question', () => {
  // A thumbs-up, a sticker, an empty body from a channel that sent only media. There is
  // nothing in any of them for a bot to answer, and answering anyway is how it looks broken.
  for (const nothing of ['\u{1F44D}', '!!!', '   ', '', null, undefined])
    assert.equal(endsConversation(nothing), true, JSON.stringify(nothing))
})
