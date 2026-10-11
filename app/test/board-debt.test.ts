import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// THE DEBT SCANNER (server/board/debt.ts): findings are suggestions in the ops store, never board
// files. The store is this file's own throwaway database (test/pg/setup.ts).
const TMP = mkdtempSync(join(tmpdir(), 'cockpit-debt-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')
const debt = await import('../server/board/debt.ts')
const { listItems, readItem } = await import('../server/board/store.ts')
const { holdReason } = await import('../server/board/auto.ts')

const AGENTS = [
  { id: 'fund', cwd: '.', writes: ['agents.json', 'repos.json', 'schedule.json', 'board/', 'library/', 'lab/', 'CLAUDE.md'] },
  { id: 'app', cwd: 'app', writes: ['app/'] },
  { id: 'platform', cwd: 'platform', writes: ['platform/fundplat/data/', 'platform/fundplat/quant/', 'platform/HQ.md', 'lab/feeds/'] },
  { id: 'research', cwd: 'research', writes: ['research/', 'lab/predmkts/'] },
  { id: 'execution', cwd: 'execution', writes: ['execution/', 'library/craft/execution/'] },
  { id: 'dash:trade', cwd: 'platform/fundplat/dashboards/terminal', writes: ['platform/fundplat/dashboards/terminal/static/'] },
]

const root = join(TMP, 'fund')
const w = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text) }
w('platform/HQ.md', [
  '# HQ',
  '- status: the scanner is live; the daily sweep task is still unscheduled',
  '- Known, NOT fixed (model, not verification): the per-leg liquidation loss is capped at the leg margin. Next.',
].join('\n'))
w('platform/fundplat/dashboards/terminal/SUMMARY.md', 'Verified. Follow-up for `data-engineer`: the feed still lists ~130 SETTLING symbols. Done.\n')
w('research/SUMMARY.md', 'x\nStill open, stated in the notebook: the engine cannot express a DIRECTIONAL financing split.\n')
w('app/node_modules/pkg/CLAUDE.md', 'Still open: this must never be scanned\n')
w('platform/fundplat/data/SUMMARY.md', 'Still open: the data package marker IS read\n')   // a package named data, not runtime data (B-0085)
w('lab/feeds/acme/data/CLAUDE.md', 'Still open: nor this - runtime data under a desk\n')
w('notes/other.md', 'Still open: not a debt file\n')
mkdirSync(join(root, 'board'), { recursive: true })
// a desk whose retro is due, with a read late
w('lab/feeds/acme/cadence.md', '# cadence\n')
w('lab/feeds/acme/beliefs.md', '```\nLast retro: 2026-08-01 · through run 01 · next bet: x\n```\n')
const old = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
w('lab/feeds/acme/data/runs.jsonl', JSON.stringify({ run: '01', stage: 'result', ts: old(20), preregistered: true }) + '\n')
// five no-lessons in a row at the fund root, in the ops store (the scanner's default source)
const { ops } = await import('../server/db.ts')
let seeded: Promise<unknown> | null = null
const seed = () => (seeded ??= Promise.all([1, 2, 3, 4, 5].map(i => ops.addNoLesson('.', `s${i}`, 'r', { ts: Date.parse(old(10 - i)) }))))

const BOARD = join(root, 'board')
const run = async (lessons: { ts: number; desk: string }[] | null = []) => { await seed(); return debt.scan({ root, agents: AGENTS, lessons: async () => lessons }) }

describe('markers', () => {
  it('finds the four markers with the sentence around them', () => {
    const hits = debt.markersIn([
      '- a; the daily sweep task is still unscheduled',
      'Known, NOT fixed (model): the loss is capped. Other.',
      'Checked. follow-up for `data-engineer`: a `seed_segments` key would be drawn**)',
      'Still open, stated in the notebook: the engine cannot split.',
      'prose that is still open in lowercase, or Still opened, is no marker',
    ].join('\n'))
    expect(hits.map(h => [h.kind, h.line])).toEqual([['unscheduled', 1], ['not-fixed', 2], ['follow-up', 3], ['still-open', 4]])
    expect(hits[0].quote).toBe('the daily sweep task is still unscheduled')
    expect(hits[0].title).toBe('The daily sweep task is still unscheduled')
    expect(hits[1].title).toBe('The loss is capped')
    expect(hits[2].named).toBe('data-engineer')
    expect(hits[2].title).toMatch(/^A seed_segments key would be drawn/)
    expect(hits[3].title).toBe('The engine cannot split')
  })
  it('walks only debt files and skips node_modules / .git / data dirs', () => {
    const wk = debt.walkDebtFiles(root)
    expect(wk.files.sort()).toEqual(['platform/HQ.md', 'platform/fundplat/dashboards/terminal/SUMMARY.md', 'platform/fundplat/data/SUMMARY.md', 'research/SUMMARY.md'])
    expect(wk.capped).toBe(false)
    expect(debt.walkDebtFiles(root, 2).capped).toBe(true)
  })
  it('a folder named data is runtime data only under a lab desk, or when it holds no debt file (B-0085)', () => {
    expect(debt.isRuntimeData('data', 'platform/fundplat', ['CLAUDE.md', 'SUMMARY.md', 'core'])).toBe(false)   // the data PACKAGE
    expect(debt.isRuntimeData('data', 'lab/feeds/acme', ['CLAUDE.md'])).toBe(true)                        // a desk under the root lab/
    expect(debt.isRuntimeData('data', 'platform/lab/carry', ['CLAUDE.md'])).toBe(true)                     // a desk in its platform home
    expect(debt.isRuntimeData('data', 'platform/dashboards/vol', ['runs.jsonl'])).toBe(true)               // no debt file: runtime
    expect(debt.isRuntimeData('cache', 'lab/x', [])).toBe(false)                                           // only a folder named data
  })
})

describe('owners', () => {
  it('a named agent wins; a legacy name maps to its old folder; else the file\'s desk', () => {
    expect(debt.resolveOwner('research', 'platform/HQ.md', AGENTS)).toBe('research')
    expect(debt.resolveOwner('data-engineer', 'platform/fundplat/dashboards/terminal/SUMMARY.md', AGENTS)).toBe('platform')
    expect(debt.resolveOwner(null, 'platform/HQ.md', AGENTS)).toBe('platform')
    expect(debt.resolveOwner(null, 'platform/fundplat/dashboards/terminal/SUMMARY.md', AGENTS)).toBe('dash:trade')   // by cwd
    expect(debt.resolveOwner('execution-engineer', 'platform/HQ.md', AGENTS)).toBe('execution')   // api/execution is the execution repo now
    expect(debt.resolveOwner('nobody', 'research/SUMMARY.md', AGENTS)).toBe('research')
    expect(debt.ownerOfPath('lab/feeds/acme/', AGENTS)).toBe('platform')                         // longest writes prefix
    expect(debt.ownerOfPath('somewhere/else.md', AGENTS)).toBe('fund')                            // the root's cwd
  })
})

describe('scan + store', () => {
  it('finds file, loop and lab debt with owners', async () => {
    const r = await run()
    const by = (k: string) => r.findings.filter(f => f.kind === k)
    expect(by('unscheduled')[0]).toMatchObject({ path: 'platform/HQ.md', line: 2, ref: 'HQ.md:2', owner: 'platform' })
    expect(by('follow-up')[0]).toMatchObject({ owner: 'platform', ref: 'SUMMARY.md:1' })
    expect(by('still-open').map(x => x.owner).sort()).toEqual(['platform', 'research'])   // the data package's marker (platform) and research's
    expect(by('retro')[0]).toMatchObject({ source: 'loop', owner: 'platform', path: 'lab/feeds/acme' })
    expect(by('no-lesson')[0]).toMatchObject({ source: 'loop', owner: 'fund' })
    expect(by('read').map(x => x.title)).toEqual(['Read 01 +7d late'])
    expect(r.findings.some(f => f.quote.includes('never be scanned') || f.quote.includes('nor this'))).toBe(false)
    // the platform's data PACKAGE is scanned; only runtime `data` folders are skipped (B-0085)
    expect(r.findings.some(f => f.quote.includes('data package marker IS read'))).toBe(true)
  })
  it('a book landed after the streak began breaks it; git unknown skips the rule', async () => {
    expect((await run([{ ts: Date.now() - 7 * 86_400_000, desk: '.' }])).findings.some(f => f.kind === 'no-lesson')).toBe(false)
    const down = await debt.scan({ root, agents: AGENTS, lessons: async () => [], noLesson: async () => { throw new Error('store down') } })
    expect(down.findings.some(f => f.kind === 'no-lesson')).toBe(false)
    expect(down.errors).toContain('no-lesson: store down')
    const u = await run(null)
    expect(u.findings.some(f => f.kind === 'no-lesson')).toBe(false)
    expect(u.errors.join()).toMatch(/lessons/)
  })
  it('the fingerprint is stable across rescans and line moves, and changes with the text', async () => {
    const a = (await run()).findings.map(f => f.fp).sort()
    const b = (await run()).findings.map(f => f.fp).sort()
    expect(b).toEqual(a)
    const fp = debt.fingerprint('x/HQ.md', 'Still  open: the `thing`')
    expect(debt.fingerprint('x/HQ.md', 'still open: the thing')).toBe(fp)
    expect(debt.fingerprint('y/HQ.md', 'still open: the thing')).not.toBe(fp)
    expect(debt.fingerprint('x/HQ.md', 'still open: another thing')).not.toBe(fp)
    // a line inserted above moves the marker; the finding keeps its fingerprint
    const before = debt.markersIn('Still open: X is broken.')[0]
    const after = debt.markersIn('new line\nStill open: X is broken.')[0]
    expect(after.line).toBe(2)
    expect(debt.fingerprint('f', after.quote)).toBe(debt.fingerprint('f', before.quote))
  })
  it('a dismissed finding stays hidden through rescans', async () => {
    await debt.saveScan(await run())
    const s = (await debt.listSuggested()).find(x => x.kind === 'still-open')!
    await debt.dismiss(s.fp)
    expect((await debt.listSuggested()).some(x => x.fp === s.fp)).toBe(false)
    await debt.saveScan(await run())
    expect((await debt.listSuggested()).some(x => x.fp === s.fp)).toBe(false)
    await expect(debt.dismiss(s.fp)).rejects.toThrow(/already dismissed/)
  })
  it('start files a backlog item from you, no auto label, that auto-pickup holds', async () => {
    await debt.saveScan(await run())
    const s = (await debt.listSuggested()).find(x => x.kind === 'unscheduled')!
    const { item } = await debt.start(s.fp, BOARD)
    const i = readItem(BOARD, item.id)
    expect(i).toMatchObject({ status: 'backlog', from: 'you', owner: 'platform', labels: [] })
    expect(i.body).toContain('> the daily sweep task is still unscheduled')
    expect(i.body).toContain('`platform/HQ.md:2`')
    expect(holdReason(i, [i], [{ id: 'platform', mode: 'active' }], () => true)).toBe('not auto')
    expect((await debt.listSuggested()).some(x => x.fp === s.fp)).toBe(false)
    await expect(debt.start(s.fp, BOARD)).rejects.toThrow(/already started/)
  })
  it('a rescan keeps first_seen, moves last_seen, drops what it no longer finds, and records the scan', async () => {
    const r = await run()
    await debt.saveScan(r, 1_000)
    const first = new Map((await debt.listSuggested()).map(x => [x.fp, x]))
    expect(first.size).toBeGreaterThan(0)
    const kept = r.findings[0]
    await debt.saveScan({ ...r, findings: [kept], errors: ['one error'], capped: true }, 2_000)
    const now = await debt.listSuggested()
    expect(now.map(x => x.fp)).toEqual(first.has(kept.fp) ? [kept.fp] : [])
    if (now.length) expect(now[0]).toMatchObject({ first_seen: first.get(kept.fp)!.first_seen, last_seen: 2_000 })
    expect(await debt.lastScan()).toMatchObject({ ts: 2_000, capped: true, errors: ['one error'], found: 1 })
  })
  it('scanning never writes to board/', async () => {
    const snap = () => readdirSync(BOARD).map(f => `${f}:${statSync(join(BOARD, f)).mtimeMs}`).sort().join('|')
    const n = listItems(BOARD).length
    const before = snap()
    const r = await run()
    await debt.saveScan(r)
    expect(snap()).toBe(before)
    expect(listItems(BOARD).length).toBe(n)
  })
})
