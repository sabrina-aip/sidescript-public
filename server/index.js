import http from 'node:http'
import { config } from './config.js'
import { initStorage, updateUsers, getUsers } from './storage.js'
import { ensureAdminFromEnv, getSetupCode } from './auth.js'
import { handle } from './http.js'
import { attachCollab, saveAll } from './collab.js'

await initStorage()
await ensureAdminFromEnv(process.env, updateUsers)

const server = http.createServer(handle)
server.requestTimeout = 10 * 60 * 1000 // allow large media uploads on slow links
attachCollab(server)

server.listen(config.port, config.host, () => {
  console.log(`Sidescript running at http://${config.host}:${config.port}`)
  console.log(`Data directory: ${config.dataDir}`)
  getUsers().then((users) => {
    if (Object.keys(users).length > 0) return
    console.log('')
    console.log('No accounts yet. Open Sidescript in your browser to create the admin account.')
    console.log(`Setup code: ${config.setupCode ? '(the SETUP_CODE you set)' : getSetupCode()}`)
    console.log('')
  })
})

// Flush every open document to disk before exiting.
let stopping = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return
    stopping = true
    console.log('Saving open documents…')
    await saveAll()
    process.exit(0)
  })
}
