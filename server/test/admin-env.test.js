import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureAdminFromEnv, verifyPassword } from '../auth.js'

const store = () => {
  const users = {}
  return { users, update: async (fn) => fn(users) }
}
const quiet = async (fn) => {
  const log = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = log }
}

test('ADMIN_PASSWORD creates the admin, keeps it stable, and resets it when changed', async () => {
  const { users, update } = store()
  await quiet(() => ensureAdminFromEnv({ ADMIN_USERNAME: 'Boss', ADMIN_PASSWORD: 'first-password-1' }, update))
  assert.equal(users.boss.isAdmin, true)
  assert.equal(await verifyPassword('first-password-1', users.boss.passwordHash), true)
  const hash = users.boss.passwordHash

  await quiet(() => ensureAdminFromEnv({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'first-password-1' }, update))
  assert.equal(users.boss.passwordHash, hash, 'same password: untouched')
  assert.equal(users.boss.sessionVersion, 0)

  users.boss.disabled = true
  await quiet(() => ensureAdminFromEnv({ ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'second-password-2' }, update))
  assert.equal(await verifyPassword('second-password-2', users.boss.passwordHash), true)
  assert.equal(users.boss.disabled, false)
  assert.equal(users.boss.sessionVersion, 1, 'reset signs the admin out everywhere')
})

test('unset, short or invalid settings change nothing', async () => {
  const { users, update } = store()
  const err = console.error
  console.error = () => {}
  try {
    await ensureAdminFromEnv({}, update)
    await ensureAdminFromEnv({ ADMIN_PASSWORD: 'short' }, update)
    await ensureAdminFromEnv({ ADMIN_USERNAME: '!!', ADMIN_PASSWORD: 'long-enough-pass' }, update)
  } finally {
    console.error = err
  }
  assert.deepEqual(users, {})
})
