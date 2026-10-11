import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ANNALS, eraCount, erasWithCounts, isDay, logRangeArgs, nextDay, parseEra, rangeArgs, readEras } from '../server/git/eras.ts'
import { git } from '../server/git/run.ts'
import { LOG_FORMAT, parseLog } from '../server/git/parse.ts'
import { eraRange, eraSpan } from '../src/rooms/git/eras.ts'

const fm = (lines: string[]) => ['---', ...lines, '---', '', '# body', ''].join('\n')

describe('era frontmatter', () => {
  it('a good closed era', () => {
    expect(parseEra('01-the-desks.md', fm(['title: The desks', 'from: 2026-09-21', 'to: 2026-09-23']))).toEqual({
      id: '01-the-desks', book: `${ANNALS}/01-the-desks.md`, title: 'The desks', from: '2026-09-21', to: '2026-09-23', error: null, counts: {},
    })
  })
  it('an open era, quoted values, CRLF and a BOM', () => {
    const raw = '﻿' + fm(['title: "The spine"', "from: '2026-09-24'", 'to: open']).replace(/\n/g, '\r\n')
    expect(parseEra('02-the-spine.md', raw)).toMatchObject({ title: 'The spine', from: '2026-09-24', to: 'open', error: null })
  })
  it('bad frontmatter is kept with its reason, never dropped', () => {
    expect(parseEra('03-x.md', '# no frontmatter\n').error).toBe('no frontmatter')
    expect(parseEra('03-x.md', fm(['from: 2026-09-21', 'to: open'])).error).toBe('title missing')
    expect(parseEra('03-x.md', fm(['title: X', 'from: 21 Sep', 'to: open'])).error).toMatch(/from "21 Sep" is not YYYY-MM-DD/)
    expect(parseEra('03-x.md', fm(['title: X', 'from: 2026-09-21', 'to: soon'])).error).toMatch(/to "soon"/)
    expect(parseEra('03-x.md', fm(['title: X', 'from: 2026-09-21'])).error).toBe('to missing')
    expect(parseEra('03-x.md', fm(['title: X', 'from: 2026-09-22', 'to: 2026-09-21'])).error).toBe('to is before from')
    expect(parseEra('03-x.md', fm(['title: X', 'from: 2026-02-30', 'to: open'])).error).toMatch(/from/)
  })
  it('days', () => {
    expect(isDay('2026-09-21')).toBe(true)
    expect(isDay('2026-02-29')).toBe(false)
    expect(isDay('2026-9-21')).toBe(false)
    expect(nextDay('2026-09-30')).toBe('2026-10-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(rangeArgs('2026-09-21', '2026-09-23')).toEqual(['--since=2026-09-21 00:00:00', '--until=2026-09-24 00:00:00'])
    expect(rangeArgs('2026-09-21', 'open')).toEqual(['--since=2026-09-21 00:00:00'])
    expect(logRangeArgs(null)).toEqual(['-50'])
    expect(logRangeArgs({ since: '2026-09-21', until: null })).toEqual(['-500', '--since=2026-09-21 00:00:00'])
  })
  it('the UI helpers: span words and the log range of a picked era', () => {
    const y = new Date().getFullYear()
    expect(eraSpan(`${y}-09-21`, `${y}-09-24`)).toBe('Sep 21 - Sep 24')
    expect(eraSpan(`${y}-09-21`, 'open')).toBe('Sep 21 - now')
    expect(eraSpan('2020-01-02', '2020-02-03')).toBe('Jan 2 2020 - Feb 3 2020')
    expect(eraSpan(`${y}-09-24`, `${y}-09-24`)).toBe('Sep 24')
    const eras = [parseEra('01-a.md', fm(['title: A', 'from: 2026-09-21', 'to: open'])), parseEra('02-b.md', 'bad')]
    expect(eraRange(eras, '01-a')).toEqual({ since: '2026-09-21', until: 'open' })
    expect(eraRange(eras, '02-b')).toBeNull()   // a bad era never filters
    expect(eraRange(eras, 'gone')).toBeNull()
    expect(eraRange(eras, '')).toBeNull()
  })
})

// ---- a temp fund: an annals series + a repo whose commits carry fixed dates ----

let root = ''
const dated = (dir: string, when: string, msg: string) => {
  writeFileSync(join(dir, 'f.txt'), `${msg}\n`)
  execFileSync('git', ['add', 'f.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '--no-verify', '-m', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'eras-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  execFileSync('git', ['config', 'core.hooksPath', '.nohooks'], { cwd: root })
  // local wall-clock stamps (no zone): git reads the era bounds in the same local zone
  dated(root, '2026-09-20T12:00:00', 'before')
  dated(root, '2026-09-21T00:30:00', 'day one early')
  dated(root, '2026-09-22T12:00:00', 'day two')
  dated(root, '2026-09-23T23:30:00', 'day three late')
  dated(root, '2026-09-24T09:00:00', 'after')
}, 30000)
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('era counts against real commits', { timeout: 30000 }, () => {
  it('an inclusive closed range and an open one', async () => {
    expect(await eraCount(root, '2026-09-21', '2026-09-23')).toBe(3)
    expect(await eraCount(root, '2026-09-24', 'open')).toBe(1)
    expect(await eraCount(root, '2026-09-20', 'open')).toBe(5)
    expect(await eraCount(root, '2026-10-01', 'open')).toBe(0)
    // a directory that is not a repo cannot say: null, never 0
    const bare = mkdtempSync(join(tmpdir(), 'eras-none-'))
    try { expect(await eraCount(bare, '2026-09-21', 'open')).toBeNull() } finally { rmSync(bare, { recursive: true, force: true }) }
  })
  it('the series: missing = no eras; books in file order with counts per repo; a bad book keeps no counts', async () => {
    expect(readEras(root)).toEqual([])
    expect(await erasWithCounts(root, [{ id: 'fund', dir: root }])).toEqual([])
    const dir = join(root, ANNALS)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '_series.md'), '---\ntitle: The Annals\n---\n')
    writeFileSync(join(dir, '02-now.md'), fm(['title: Now', 'from: 2026-09-24', 'to: open']))
    writeFileSync(join(dir, '01-then.md'), fm(['title: Then', 'from: 2026-09-21', 'to: 2026-09-23']))
    writeFileSync(join(dir, '03-broken.md'), fm(['title: Broken', 'from: yesterday', 'to: open']))
    writeFileSync(join(dir, 'notes.md'), fm(['title: not an era', 'from: 2026-09-21', 'to: open']))
    const eras = await erasWithCounts(root, [{ id: 'fund', dir: root }, { id: 'ghost', dir: join(root, 'no-such-dir') }])
    expect(eras.map(e => e.id)).toEqual(['01-then', '02-now', '03-broken'])
    expect(eras[0].counts).toEqual({ fund: 3, ghost: null })
    expect(eras[1].counts).toEqual({ fund: 1, ghost: null })
    expect(eras[2]).toMatchObject({ error: expect.stringMatching(/from "yesterday"/), counts: {} })
  })
  it('since/until bounds the log (the args the route passes)', async () => {
    const log = async (range: { since: string; until: string | null } | null) => {
      const out = await git(root, ['log', ...logRangeArgs(range), `--format=${LOG_FORMAT}`, '--name-only'])
      return parseLog(out.stdout).map(e => e.subject)
    }
    expect(await log({ since: '2026-09-21', until: '2026-09-23' })).toEqual(['day three late', 'day two', 'day one early'])
    expect(await log({ since: '2026-09-22', until: '2026-09-22' })).toEqual(['day two'])
    expect(await log({ since: '2026-09-24', until: null })).toEqual(['after'])
    expect(await log(null)).toHaveLength(5)
  })
})
