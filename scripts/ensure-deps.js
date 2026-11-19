// Installs dependencies when package-lock.json has changed since the last `npm install`
// (e.g. after `git pull` brought in new packages), so dev/build don't fail on missing imports.
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mtime = (f) => {
  try {
    return fs.statSync(path.join(root, f)).mtimeMs
  } catch {
    return 0
  }
}

export function ensureDeps() {
  const lock = mtime('package-lock.json')
  const installed = mtime('node_modules/.package-lock.json')
  if (installed && installed >= lock) return
  console.log(installed ? 'Packages changed since your last install — running npm install…' : 'Installing packages…')
  execSync('npm install --no-audit --no-fund', { cwd: root, stdio: 'inherit' })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) ensureDeps()
