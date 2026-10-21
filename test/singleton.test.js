/**
 * tryOwnLiveSingletons(): the cross-process guard around WhatsApp and the poller.
 *
 * A real Postgres session-level advisory lock, so this proves the actual mechanism rather
 * than a mock of it — two calls in this one process open two real backend connections, and
 * Postgres itself is what tells the second one no. That is the same thing that happens
 * across two OS processes; this file just never needs to start a second one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { useSchema } from './helper.js'
const db_ = await useSchema('singleton')
const { tryOwnLiveSingletons, releaseLiveSingletons } = await import('../src/server/singleton.ts')

test.after(async () => {
  // Whichever call last won is still holding a connection out of the pool on purpose — the
  // same thing a live process does. pool.end() inside drop() would wait forever for it back.
  await releaseLiveSingletons()
  return db_.drop()
})

test('one caller wins, a second is refused without blocking, and releasing frees it for a third', async () => {
  assert.equal(await tryOwnLiveSingletons(), true, 'the first caller should win the lock')

  const start = Date.now()
  assert.equal(await tryOwnLiveSingletons(), false, 'a second caller must not also win while the first still holds it')
  assert.ok(Date.now() - start < 2000, 'a losing call must return immediately, not block waiting for the lock')

  // The same thing a killed process does — the connection drops, not an explicit unlock.
  await releaseLiveSingletons()
  assert.equal(await tryOwnLiveSingletons(), true, 'closing the holder\'s connection must free the lock for a later caller')
})
