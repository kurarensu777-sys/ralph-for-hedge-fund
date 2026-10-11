// npm run dev: fundd (watched, restarts on server/ changes) + vite (the UI) in one window.
// fundd listens on 4689, the UI on 4688. Ctrl+C stops both.
import { spawn } from 'node:child_process'

const opts = { stdio: 'inherit', shell: true }
const procs = [
  spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'server/fundd.ts'], opts),
  spawn('npx', ['vite'], opts),
]
const stop = () => { for (const p of procs) p.kill(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
for (const p of procs) p.on('exit', code => { if (code) console.error(`[dev] a process exited with ${code}`) })
