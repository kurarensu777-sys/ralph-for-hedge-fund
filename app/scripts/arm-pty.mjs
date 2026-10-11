import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// node-pty's prebuilt `spawn-helper` arrives from npm without the executable bit, and every
// pty spawn then dies with `posix_spawnp failed` (measured here 2026-08-10 - the terminals
// looked broken with no useful error anywhere). npm runs this after every install; pty.ts
// repeats it at load so a tree installed before this script existed still works.

const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(STUDIO, 'node_modules', 'node-pty', 'prebuilds')
if (existsSync(dir)) {
  for (const plat of readdirSync(dir)) {
    const helper = join(dir, plat, 'spawn-helper')
    if (existsSync(helper)) {
      try { chmodSync(helper, 0o755) } catch (e) { console.warn(`[arm-pty] ${helper}: ${e.message}`) }
    }
  }
}
