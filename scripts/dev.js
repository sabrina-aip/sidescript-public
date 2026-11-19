// Runs the API/collab server (auto-restarting) and the Vite dev server together.
import { spawn } from 'node:child_process'
import { ensureDeps } from './ensure-deps.js'

ensureDeps()

const procs = [
  spawn(process.execPath, ['--watch-path=server', 'server/index.js'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '8080' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
]
const stop = () => procs.forEach((p) => p.kill('SIGINT'))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
procs.forEach((p) => p.on('exit', (code) => code && stop()))
