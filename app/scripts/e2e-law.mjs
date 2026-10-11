// The standing e2e check for the chats Law chip (B-0030).
//   node scripts/e2e-law.mjs [--conv <id>] [--url http://127.0.0.1:4688] [--api http://127.0.0.1:4689] [--widths 1440,1920]
// Needs the dev server up. Read-only: it opens a conversation pane in a fresh headless Chrome
// profile (a pane shows the transcript; nothing boots until a message is sent) and asserts, at
// each width:
//   the Law chip renders "<rows> · <k> tok" matching GET /api/chats/:id/law;
//   the popover lists one row per law row, each tag carrying its data-source;
//   a derived row's tag is DASHED, a hook / launch row's is SOLID;
//   0 console errors, 0 page errors, no body h-scroll.
// Picks the newest conversation whose manifest has rows (preferring one with a derived AND a
// non-derived row) unless --conv names one. Exit 0 all pass, 1 any miss, 2 could not run.
import { chromium } from 'playwright-core'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const base = arg('--url', 'http://127.0.0.1:4688')
const apiBase = arg('--api', base)
const widths = arg('--widths', '1440,1920').split(',').map(Number).filter(Boolean)
const get = async p => { const r = await fetch(apiBase + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json() }
const kfmt = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

let conv = arg('--conv', null), law = null
try {
  if (conv) law = await get(`/api/chats/${conv}/law`)
  else {
    const { conversations } = await get('/api/chats?limit=100')
    let fallback = null
    for (const c of conversations) {
      const l = await get(`/api/chats/${c.id}/law`)
      if (!l.rows?.length) continue
      const src = new Set(l.rows.map(r => r.source))
      if (src.has('derived') && [...src].some(s => s !== 'derived')) { conv = c.id; law = l; break }
      fallback ??= { id: c.id, l }
    }
    if (!conv && fallback) { conv = fallback.id; law = fallback.l }
  }
} catch (e) { console.error(`e2e-law: cannot read the API: ${e.message}`); process.exit(2) }
if (!conv || !law?.rows?.length) { console.error('e2e-law: no conversation with a law manifest to check'); process.exit(2) }

const expectChip = `${law.rows.length} · ${kfmt(law.tokens)} tok`
const expectSrc = law.rows.map(r => r.source ?? 'unknown')
console.log(`e2e-law ${conv}: ${law.rows.length} rows (${[...new Set(expectSrc)].join(' ')}), chip "${expectChip}"`)

const misses = []
const miss = (w, m) => { misses.push(`${w}: ${m}`); console.log(`  MISS ${m}`) }
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const width of widths) {
    console.log(`@${width}`)
    const page = await browser.newPage({ viewport: { width, height: Math.round(width * 0.5625) } })
    const errors = []
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('pageerror', e => errors.push(String(e)))
    await page.goto(base)
    await page.evaluate(id => {
      localStorage.setItem('fundos.room', JSON.stringify('chats'))
      localStorage.setItem('fundos.sel', JSON.stringify({ chats: id }))
      localStorage.setItem('fundos.chats.panes', JSON.stringify([id]))
    }, conv)
    await page.reload({ waitUntil: 'networkidle' })
    const chip = page.locator('button.chats-law')
    try { await chip.first().waitFor({ timeout: 8000 }) } catch { miss(width, 'Law chip did not render as a button'); await page.close(); continue }
    const text = (await chip.first().innerText()).trim()
    if (text !== expectChip) miss(width, `chip reads "${text}", expected "${expectChip}"`)
    else console.log(`  chip "${text}"`)
    await chip.first().click()
    const rows = page.locator('.chats-law-pop .chats-law-r')
    try { await rows.first().waitFor({ timeout: 4000 }) } catch { miss(width, 'popover did not open'); await page.close(); continue }
    const got = await rows.evaluateAll(els => els.map(el => {
      const tag = el.querySelector('.tag[data-source]')
      return tag ? { src: tag.getAttribute('data-source'), border: getComputedStyle(tag).borderTopStyle } : null
    }))
    if (got.length !== law.rows.length) miss(width, `popover lists ${got.length} rows, the manifest has ${law.rows.length}`)
    const bad = got.map((g, i) => {
      if (!g) return `row ${i + 1}: tag has no data-source`
      if (g.src !== expectSrc[i]) return `row ${i + 1}: source ${g.src}, expected ${expectSrc[i]}`
      const want = g.src === 'derived' ? 'dashed' : 'solid'
      return g.border === want ? null : `row ${i + 1} (${g.src}): border ${g.border}, expected ${want}`
    }).filter(Boolean)
    for (const b of bad) miss(width, b)
    if (!bad.length && got.length === law.rows.length) {
      const n = {}; for (const g of got) n[g.src] = (n[g.src] ?? 0) + 1
      console.log(`  popover ${got.length} rows ${JSON.stringify(n)}, derived dashed / others solid`)
    }
    const hs = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    if (hs) miss(width, 'body h-scroll')
    if (errors.length) miss(width, `${errors.length} console/page errors: ${errors.join(' | ').slice(0, 400)}`)
    else console.log('  0 console errors' + (hs ? '' : ', no h-scroll'))
    await page.close()
  }
} finally { await browser.close() }

console.log(misses.length ? `FAIL ${misses.length} miss${misses.length > 1 ? 'es' : ''}` : `PASS ${widths.join(' ')}`)
process.exit(misses.length ? 1 : 0)
