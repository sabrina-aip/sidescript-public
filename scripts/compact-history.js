// Convert older version-history files (full, uncompressed .bin copies) to the compact format:
// a compressed full copy per day plus compressed "changes since the previous version" files.
//
//   node scripts/compact-history.js            # dry run: shows what would change and the space saved
//   node scripts/compact-history.js --apply    # backs up DATA_DIR first, then converts
//
// Every converted version is rebuilt and compared with the original before the original is
// removed; if anything doesn't match, that script's originals are left untouched.
// Stop the Sidescript server while this runs.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import zlib from 'node:zlib'
import * as Y from 'yjs'
import { config } from '../server/config.js'
import { initStorage, listDocs, readSnapshot, _history } from '../server/storage.js'

const apply = process.argv.includes('--apply')
const skipBackup = process.argv.includes('--skip-backup')
const kb = (n) => `${(n / 1024).toFixed(0)} KB`

await initStorage()
if (apply && !skipBackup) {
  console.log('Backing up the data folder first…')
  execFileSync(process.execPath, [path.join(config.root, 'scripts/backup.js')], { stdio: 'inherit' })
}

let before = 0
let after = 0
let converted = 0
let failed = 0
for (const doc of listDocs()) {
  const files = await _history.versionFiles(doc.id)
  if (!files.some((v) => !v.gz)) continue
  let prev = null // full state of the previous version
  let lastFullMs = 0
  let deltas = 0
  try {
    for (const v of files) {
      const state = new Uint8Array(await readSnapshot(doc.id, v.name))
      const ms = _history.stampToMs(v.stamp)
      if (v.gz) {
        if (v.kind === 'full') (lastFullMs = ms), (deltas = 0)
        else deltas++
      } else {
        const full = !prev || ms - lastFullMs >= _history.FULL_EVERY_MS || deltas >= _history.FULL_EVERY
        const data = full ? state : Y.diffUpdate(state, Y.encodeStateVectorFromUpdate(prev))
        const newName = v.name.replace(/\.bin$/, full ? '.full.gz' : '.delta.gz')
        before += state.length
        after += zlib.gzipSync(data, { level: 9 }).length
        if (apply) await _history.replaceVerified(doc.id, v.name, newName, data, state)
        converted++
        if (full) (lastFullMs = ms), (deltas = 0)
        else deltas++
      }
      prev = state
    }
  } catch (e) {
    failed++
    console.error(`  ${doc.title}: stopped (${e.message}); remaining originals left as they were`)
  }
}

console.log(`${apply ? 'Converted' : 'Would convert'} ${converted} version${converted === 1 ? '' : 's'}: ${kb(before)} → ${kb(after)}${before ? ` (${Math.round((1 - after / before) * 100)}% smaller)` : ''}.`)
if (failed) console.log(`${failed} script(s) had a problem and were left partly or wholly unconverted.`)
if (!apply && converted) console.log('Run with --apply to convert (a backup is made first).')
