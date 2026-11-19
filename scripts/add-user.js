// Usage: npm run user:add -- <username> [--admin] [--name "Display Name"] [--show]
// Password, in order of preference:
//   1. the SIDESCRIPT_PASSWORD environment variable (for terminals that can't hide typing)
//   2. a hidden prompt (asked twice), so it never lands in shell history
//   3. a line piped in on stdin when there is no terminal
// --show makes the prompt visible, for web terminals that don't display hidden input.
import readline from 'node:readline'
import { initStorage, updateUsers } from '../server/storage.js'
import { hashPassword, USERNAME_RE } from '../server/auth.js'

const args = process.argv.slice(2)
const username = (args.find((a) => !a.startsWith('--')) || '').toLowerCase()
const admin = args.includes('--admin')
const nameIdx = args.indexOf('--name')
const displayName = nameIdx >= 0 ? args[nameIdx + 1] : username

if (!USERNAME_RE.test(username)) {
  console.error('Usage: npm run user:add -- <username> [--admin] [--name "Display Name"]')
  process.exit(1)
}

function ask(q, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(q) ? s : '')
  return new Promise((r) => rl.question(q, (a) => (rl.close(), process.stdout.write('\n'), r(a))))
}

async function readPassword() {
  if (process.env.SIDESCRIPT_PASSWORD) return process.env.SIDESCRIPT_PASSWORD
  if (!process.stdin.isTTY) return (await ask('', false)).trim()
  const hidden = !args.includes('--show')
  const first = await ask('Password (min 10 chars): ', hidden)
  if (first.length < 10) return first
  const again = await ask('Type it again: ', hidden)
  if (again !== first) {
    console.error('Passwords do not match. Nothing was changed.')
    process.exit(1)
  }
  return first
}

await initStorage()
const password = await readPassword()
if (password.length < 10) {
  console.error('Password too short (min 10 characters). Nothing was changed.')
  process.exit(1)
}
const hash = await hashPassword(password)
await updateUsers((users) => {
  const existing = users[username]
  users[username] = {
    color: '#6d5dfc',
    createdAt: new Date().toISOString(),
    ...existing,
    displayName: displayName || existing?.displayName || username,
    passwordHash: hash,
    isAdmin: admin || !!existing?.isAdmin,
    sessionVersion: (existing?.sessionVersion || 0) + (existing ? 1 : 0),
  }
})
console.log(`User "${username}" saved${admin ? ' (admin)' : ''}.`)
