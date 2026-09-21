#!/usr/bin/env node
// Dev runner: build once, keep tsup watching, launch Electron.
// Main-process changes need an Electron restart; preload changes only need
// Cmd+R (the window reload re-reads the built preload file).
import { spawn, spawnSync } from 'node:child_process'

console.log('[fi] building main + preload…')
const build = spawnSync('pnpm', ['exec', 'tsup'], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

const watch = spawn('pnpm', ['exec', 'tsup', '--watch'], { stdio: 'inherit' })
const electron = spawn('pnpm', ['exec', 'electron', '.'], { stdio: 'inherit' })

electron.on('exit', (code) => {
  watch.kill('SIGTERM')
  process.exit(code ?? 0)
})
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    electron.kill(sig)
    watch.kill(sig)
  })
}
