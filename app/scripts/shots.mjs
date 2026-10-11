// Screenshot every room with the installed Chrome (headless), for review.
//   node scripts/shots.mjs [--width 1440] [--room board] [--out <dir>]
// Needs the dev server up (npm run dev). Writes <out>/<room>-<width>.png (default ~/fund-data/shots)
// and prints any console errors or page errors per room.
//
// The room is opened BY ITS HASH (#/<room>), the route the shell reads first, and read back before
// the shot: seeding the stored room and reloading used to shoot Chats, because the first bare load
// writes #/chats into the URL and a hash beats the stored room (B-0200). A room the shell did not
// open fails the run rather than leaving a wrong-room PNG under the right name.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const width = Number(arg('--width', 1440))
const height = Math.round(width * 0.5625)
const only = arg('--room', null)
const out = arg('--out', join(homedir(), 'fund-data', 'shots'))
const base = arg('--url', 'http://127.0.0.1:4688')
const ROOMS = ['chats', 'board', 'dash', 'data', 'library', 'context', 'lab', 'research', 'loop', 'git', 'system', 'map']

mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width, height } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push(String(e)))

let wrong = 0
for (const room of only ? [only] : ROOMS) {
  errors.length = 0
  await page.goto(`${base}/#/${room}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  const shown = await page.evaluate(() => (location.hash.match(/^#\/([^/?]+)/) || [])[1] ?? null)
  if (shown !== room) { wrong++; console.log(`${room.padEnd(8)} REFUSED: the shell opened ${shown ?? 'no room'} - no shot written`); continue }
  const file = join(out, `${room}-${width}.png`)
  await page.screenshot({ path: file })
  const hs = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  console.log(`${room.padEnd(8)} ${file}${hs ? '  BODY H-SCROLL' : ''}${errors.length ? `\n  errors: ${errors.join(' | ')}` : ''}`)
}
await browser.close()
if (wrong) process.exit(1)
