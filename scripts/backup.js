// Copies the whole data directory to BACKUP_DIR/sidescript-<timestamp>/.
// Never overwrites or removes an earlier backup. Safe to run while the server is up
// (every file in data/ is replaced atomically, so each copied file is complete).
//
//   BACKUP_DIR=/mnt/external/sidescript npm run backup
//
// Schedule it with cron, e.g. hourly:  0 * * * *  cd /opt/sidescript && npm run backup
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config } from '../server/config.js'

const dest = path.resolve(process.env.BACKUP_DIR || path.join(config.root, 'backups'))
const name = `sidescript-${new Date().toISOString().replace(/[:.]/g, '-')}`
const target = path.join(dest, name)

await fsp.mkdir(dest, { recursive: true })
await fsp.cp(config.dataDir, target, {
  recursive: true,
  errorOnExist: true,
  force: false,
  preserveTimestamps: true,
  filter: (src) => !path.basename(src).endsWith('.tmp'),
})
console.log(`Backed up ${config.dataDir} -> ${target}`)
