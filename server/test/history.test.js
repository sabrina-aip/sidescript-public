import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidescript-history-'))
process.env.DATA_DIR = dataDir
const storage = await import('../storage.js')

before(() => storage.initStorage())
after(() => fs.rmSync(dataDir, { recursive: true, force: true })) // test temp dir only

const words = (n) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(' ')
const same = (a, b) => Y.equalSnapshots(Y.snapshot(a), Y.snapshot(b)) && a.getText('t').toString() === b.getText('t').toString()
const load = (buf) => {
  const d = new Y.Doc({ gc: false })
  Y.applyUpdate(d, buf)
  return d
}

test('every version rebuilds exactly; only the first is a full copy; change files are tiny', async () => {
  const meta = await storage.createDoc({ owner: 'a', title: 'h' })
  const doc = new Y.Doc()
  const text = doc.getText('t')
  text.insert(0, words(40000)) // a long script
  const expected = []
  const t0 = Date.UTC(2026, 0, 1, 9)
  for (let i = 0; i < 30; i++) {
    if (i) {
      text.insert(Math.floor(text.length / 2), ` edit ${i} `.repeat(20)) // an hour of typing, roughly
      if (i % 5 === 0) text.delete(10, 50) // and some deletions
    }
    const name = await storage.writeSnapshot(meta.id, Y.encodeStateAsUpdate(doc), i === 7 ? 'named version' : '', { now: t0 + i * 10 * 60 * 1000 })
    expected.push({ name, state: Y.encodeStateAsUpdate(doc) })
  }
  const list = (await storage.listSnapshots(meta.id)).reverse()
  assert.equal(list.length, 30)
  assert.equal(list[0].kind, 'full')
  assert.ok(list.slice(1).every((v) => v.kind === 'delta'))
  assert.equal(list[7].label, 'named version')
  for (const { name, state } of expected) assert.ok(same(load(await storage.readSnapshot(meta.id, name)), load(state)), name)
  const full = list[0].size
  const biggestDelta = Math.max(...list.slice(1).map((v) => v.size))
  assert.ok(biggestDelta < full / 20, `delta ${biggestDelta} B vs full ${full} B`)
  // Old text that was deleted later is still in the older versions.
  assert.match(load(await storage.readSnapshot(meta.id, expected[4].name)).getText('t').toString().slice(0, 80), /word2 word3/)
})

test('a new full copy starts after 24 hours', async () => {
  const meta = await storage.createDoc({ owner: 'a', title: 'k' })
  const doc = new Y.Doc()
  const t0 = Date.UTC(2026, 0, 2, 9)
  const kinds = []
  for (const hours of [0, 1, 2, 25, 26]) {
    doc.getText('t').insert(0, `h${hours} `)
    const name = await storage.writeSnapshot(meta.id, Y.encodeStateAsUpdate(doc), '', { now: t0 + hours * 3600e3 })
    kinds.push(name.endsWith('.full.gz') ? 'full' : 'delta')
  }
  assert.deepEqual(kinds, ['full', 'delta', 'delta', 'full', 'delta'])
})

test('older uncompressed versions still work, and new change files build on them', async () => {
  const meta = await storage.createDoc({ owner: 'a', title: 'legacy' })
  const doc = new Y.Doc()
  doc.getText('t').insert(0, 'from the old format')
  const legacyName = '20260101T090000000Z.bin'
  fs.writeFileSync(path.join(dataDir, 'docs', meta.id, 'history', legacyName), Y.encodeStateAsUpdate(doc))
  doc.getText('t').insert(0, 'new ')
  const name = await storage.writeSnapshot(meta.id, Y.encodeStateAsUpdate(doc), '', { now: Date.UTC(2026, 0, 1, 10) })
  assert.ok(name.endsWith('.delta.gz'))
  assert.equal(load(await storage.readSnapshot(meta.id, legacyName)).getText('t').toString(), 'from the old format')
  assert.equal(load(await storage.readSnapshot(meta.id, name)).getText('t').toString(), 'new from the old format')
})

test('compact-history converts old versions, verifies each one, and backs up first', async () => {
  const { execFileSync } = await import('node:child_process')
  const meta = await storage.createDoc({ owner: 'a', title: 'to compact' })
  const hist = path.join(dataDir, 'docs', meta.id, 'history')
  const doc = new Y.Doc()
  const states = []
  for (let i = 0; i < 6; i++) {
    doc.getText('t').insert(0, `${words(3000)} v${i} `)
    if (i === 3) doc.getText('t').delete(0, 100)
    const name = `2026010${1 + Math.floor(i / 3)}T0${i}0000000Z${i === 2 ? '-named' : ''}.bin` // spans two days
    fs.writeFileSync(path.join(hist, name), Y.encodeStateAsUpdate(doc))
    states.push(Y.encodeStateAsUpdate(doc))
  }
  // a new-format change file on top of the old ones
  doc.getText('t').insert(0, 'after upgrade ')
  const newer = await storage.writeSnapshot(meta.id, Y.encodeStateAsUpdate(doc), '', { now: Date.UTC(2026, 0, 2, 12) })
  const backups = fs.mkdtempSync(path.join(os.tmpdir(), 'sidescript-backups-'))
  const run = (...args) => execFileSync(process.execPath, ['scripts/compact-history.js', ...args], { cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backups }, encoding: 'utf8' })
  // (other tests in this data folder left old-format files too; they get converted as well)
  const allOld = fs.readdirSync(path.join(dataDir, 'docs')).flatMap((d) => fs.readdirSync(path.join(dataDir, 'docs', d, 'history')).filter((f) => f.endsWith('.bin'))).length
  try {
    assert.match(run(), new RegExp(`Would convert ${allOld} versions`))
    assert.equal(fs.readdirSync(hist).filter((f) => f.endsWith('.bin')).length, 6) // dry run changes nothing
    assert.match(run('--apply'), new RegExp(`Converted ${allOld} versions`))
    assert.equal(fs.readdirSync(backups).length, 1) // a backup was taken first
    const files = fs.readdirSync(hist).sort()
    assert.equal(files.filter((f) => f.endsWith('.bin')).length, 0)
    assert.deepEqual(files.map((f) => f.split('.').slice(1).join('.')), ['full.gz', 'delta.gz', 'delta.gz', 'full.gz', 'delta.gz', 'delta.gz', 'delta.gz'])
    assert.ok(files.some((f) => f.includes('-named.')))
    const list = (await storage.listSnapshots(meta.id)).reverse()
    for (let i = 0; i < 6; i++) assert.ok(same(load(await storage.readSnapshot(meta.id, list[i].name)), load(states[i])), list[i].name)
    assert.match(load(await storage.readSnapshot(meta.id, newer)).getText('t').toString(), /^after upgrade/)
  } finally {
    fs.rmSync(backups, { recursive: true, force: true }) // test temp dir only
  }
})
