import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deskChart, parseBand } from '../server/lab/chart.ts'
import { nextRunId, parseBeliefs, parseMechanics } from '../server/lab/desk.ts'
import { groupRuns } from '../server/lab/runs.ts'
import { readStages, serialize, setStage, StageRefused } from '../server/lab/stages.ts'
import { BadInput, preregArgs, readArgs, ReadJobs, refusalOf, runTool, type SpawnFn } from '../server/lab/tools.ts'

const tmps: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'lab-loop-')); tmps.push(d); return d }
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }) })

const MECH = `# Mechanics
| ID | Mechanic | What it does | Our shots | External corpus | Status |
|---|---|---|---|---|---|
| M0 | verify-pass | run verify | 005 | - | \`^\` reading |
| M1 | delta-neutral funding capture | short the perp | 001 · 002 | lit | \`^\` reading - it pays |
| M7 | mirror-and-decompose | run the opposite | 003 | - | \`*\` **PROVEN** |
`

describe('desk facts', () => {
  it('reads every M<n> row with its name and status cell', () => {
    const m = parseMechanics(MECH)
    expect(m.map(x => x.id)).toEqual(['M0', 'M1', 'M7'])
    expect(m[1].name).toBe('delta-neutral funding capture')
    expect(m[2].status).toBe('* PROVEN')
    expect(parseMechanics(null)).toEqual([])
  })
  it('reads beliefs as ### B<n> headings and flags the template placeholder', () => {
    const b = parseBeliefs('## Beliefs\n### B1 · The reserve is the window - WEAK\nbody\n### B2 · <claim>\n')
    expect(b).toEqual([{ id: 'B1', claim: 'The reserve is the window - WEAK', placeholder: false }, { id: 'B2', claim: '<claim>', placeholder: true }])
  })
  it('suggests the next run id in the desk own shape', () => {
    expect(nextRunId(['001', '002', '008'])).toBe('009')
    expect(nextRunId(['carry-014', 'carry-009'])).toBe('carry-015')
    expect(nextRunId(['099'])).toBe('100')
    expect(nextRunId([])).toBe('001')
  })
})

describe('stages.json', () => {
  const desk = 'lab/platform/carry'
  const root = () => { const r = tmp(); mkdirSync(join(r, desk), { recursive: true }); return r }
  const known = ['M0', 'M1', 'M7', 'M10']

  it('a desk with no file has every mechanic UNSET (not idea)', () => {
    const s = readStages(root(), desk)
    expect(s).toMatchObject({ exists: false, bad: null, mechanics: {} })
  })
  it('writes a stable, reviewable file: M-number order, LF, trailing newline, the format note', () => {
    const r = root()
    setStage(r, desk, 'M10', 'idea', { known, today: '2026-09-24' })
    setStage(r, desk, 'M1', 'tested', { known, today: '2026-09-24', note: 'two shots' })
    const text = readFileSync(join(r, desk, 'stages.json'), 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).not.toContain('\r')
    const j = JSON.parse(text)
    expect(Object.keys(j.mechanics)).toEqual(['M1', 'M10'])
    expect(j.$format).toMatch(/live is written by the owner/)
    expect(j.mechanics.M1).toEqual({ stage: 'tested', since: '2026-09-24', note: 'two shots' })
  })
  it('keeps `since` when the stage does not change, resets it when it does', () => {
    const r = root()
    setStage(r, desk, 'M1', 'tested', { known, today: '2026-09-20' })
    expect(setStage(r, desk, 'M1', 'tested', { known, today: '2026-09-24', note: 'n' }).mechanics.M1.since).toBe('2026-09-20')
    expect(setStage(r, desk, 'M1', 'paper', { known, today: '2026-09-24' }).mechanics.M1.since).toBe('2026-09-24')
  })
  it('clears a stage with null', () => {
    const r = root()
    setStage(r, desk, 'M1', 'idea', { known })
    expect(setStage(r, desk, 'M1', null, { known }).mechanics).toEqual({})
  })
  it('REFUSES to set live, and refuses to move a mechanic the owner put live', () => {
    const r = root()
    expect(() => setStage(r, desk, 'M1', 'live', { known })).toThrow(/owner/)
    writeFileSync(join(r, desk, 'stages.json'), serialize({ M7: { stage: 'live', since: '2026-09-01' } }))
    expect(readStages(r, desk).mechanics.M7.stage).toBe('live')
    expect(() => setStage(r, desk, 'M7', 'paper', { known })).toThrow(StageRefused)
    expect(() => setStage(r, desk, 'M7', null, { known })).toThrow(/only the owner/)
    expect(readStages(r, desk).mechanics.M7.stage).toBe('live')
  })
  it('refuses an unknown mechanic and a stage that is not on the ladder', () => {
    const r = root()
    expect(() => setStage(r, desk, 'M99', 'idea', { known })).toThrow(/not a row/)
    expect(() => setStage(r, desk, 'M1', 'shipped' as any, { known })).toThrow(/idea \| tested \| paper/)
  })
  it('refuses to rewrite a file it cannot parse (it would drop what is in it)', () => {
    const r = root()
    writeFileSync(join(r, desk, 'stages.json'), '{ nope')
    expect(readStages(r, desk).bad).toMatch(/not JSON/)
    expect(() => setStage(r, desk, 'M1', 'idea', { known })).toThrow(/fix it by hand/)
    expect(readFileSync(join(r, desk, 'stages.json'), 'utf8')).toBe('{ nope')
  })
  it('reports, not hides, an entry whose stage is not on the ladder', () => {
    const r = root()
    writeFileSync(join(r, desk, 'stages.json'), JSON.stringify({ mechanics: { M1: { stage: 'idea' }, M7: { stage: 'wat' } } }))
    const s = readStages(r, desk)
    expect(Object.keys(s.mechanics)).toEqual(['M1'])
    expect(s.bad).toMatch(/M7/)
  })
})

describe('bands (the _common.parse_band grammar)', () => {
  it('parses every form the tool accepts', () => {
    expect(parseBand('20..30')).toMatchObject({ lo: 20, hi: 30, kind: 'band' })
    expect(parseBand('-6 to -2')).toMatchObject({ lo: -6, hi: -2 })
    expect(parseBand('30..20')).toMatchObject({ lo: 20, hi: 30 })
    expect(parseBand('>= 0')).toMatchObject({ lo: 0, hi: null, kind: 'open' })
    expect(parseBand('<= 5')).toMatchObject({ lo: null, hi: 5 })
    expect(parseBand('0')).toMatchObject({ lo: 0, hi: 0, kind: 'count' })
  })
  it('a float point estimate is not a band', () => {
    expect(parseBand('12.5')).toBeNull()
    expect(parseBand('about 10')).toBeNull()
  })
})

describe('desk chart', () => {
  const T = '2026-09-14T00:00:00Z'
  const rows = [
    { run: '001', stage: 'result', ts: T, kind: 'import', mechanic: 'M1', preregistered: false, predicted: {}, metrics: { ann_pct: 26.1, sharpe: 1.4 } },
    { run: '002', stage: 'preflight', ts: '2026-09-15T00:00:00Z', kind: 'exploit', mechanic: 'M1', predicted: { ann_pct: '10..20' } },
    { run: '002', stage: 'result', ts: '2026-09-16T00:00:00Z', kind: 'exploit', mechanic: 'M1', predicted: { ann_pct: '10..20' }, metrics: { ann_pct: 24 } },
    { run: '002', stage: 'read', age: '7d', ts: '2026-09-23T00:00:00Z', state: 'on-time', metrics: { ann_pct: 18 } },
    { run: '003', stage: 'preflight', ts: '2026-09-17T00:00:00Z', kind: 'explore', mechanic: 'M2', predicted: { ann_pct: '>= 5', liquidations: '0' } },
  ]
  const runs = groupRuns('lab/x', rows, Date.parse('2026-09-24T00:00:00Z'))

  it('picks the metric with the most predictions, and orders runs by time', () => {
    const c = deskChart('lab/x', runs)
    expect(c.metric).toBe('ann_pct')
    expect(c.points.map(p => p.run)).toEqual(['001', '002', '003'])
  })
  it('grades hit/miss only where a band AND a measurement exist', () => {
    const p = deskChart('lab/x', runs).points
    expect(p[0]).toMatchObject({ band: null, measured: 26.1, hit: null, preregistered: false })
    expect(p[1]).toMatchObject({ measured: 24, hit: false, reads: { '7d': 18, '30d': null } })
    expect(p[1].band).toMatchObject({ lo: 10, hi: 20 })
    expect(p[2]).toMatchObject({ measured: null, hit: null })
  })
  it('honours a requested metric, and falls back when it is unknown', () => {
    expect(deskChart('lab/x', runs, 'liquidations').points.map(p => p.run)).toEqual(['003'])
    expect(deskChart('lab/x', runs, 'nope').metric).toBe('ann_pct')
    expect(deskChart('lab/x', []).metric).toBeNull()
  })
})

describe('preregister argv', () => {
  const base = { desk: 'lab/platform/carry', run: '009', mechanic: 'M1', kind: 'exploit', ancestor: '008', variables: ['window rolled', ''], predict: ['ann_pct=-6..-2', 'liquidations=0'], cmd: 'python -m fundplat.quant.crypto.backtest.carry.hip3 --study pro', from: '2026-02-20', to: '2026-09-24' }

  it('passes every value as --flag=value, so a negative band can never parse as a flag', () => {
    const a = preregArgs(base)
    expect(a[0]).toBe('app/loop/tools/preregister.py')
    expect(a).toContain('--predict=ann_pct=-6..-2')
    expect(a).toContain('--variables=window rolled')
    expect(a).not.toContain('--variables=')
    expect(a).toContain('--window=2026-02-20..2026-09-24')
    expect(a).toContain('--cwd=platform')
    expect(a).toContain('--cmd=python -m fundplat.quant.crypto.backtest.carry.hip3 --study pro')
    expect(a.at(-1)).toBe('--json')
    expect(preregArgs({ ...base, dry: true }).at(-1)).toBe('--dry')
  })
  it('leaves the CONTRACT to the tool: an unknown mechanic or a point band still reaches it', () => {
    const a = preregArgs({ ...base, mechanic: 'M99', predict: ['ann_pct=12.5'] })
    expect(a).toContain('--mechanic=M99')
    expect(a).toContain('--predict=ann_pct=12.5')
  })
  it('refuses only bad SHAPE: a desk outside lab/, a multi-word run, an unknown cwd', () => {
    expect(() => preregArgs({ ...base, desk: '../etc' })).toThrow(BadInput)
    expect(() => preregArgs({ ...base, desk: 'lab/../spine' })).toThrow(BadInput)
    expect(() => preregArgs({ ...base, run: 'two words' })).toThrow(/single token/)
    expect(() => preregArgs({ ...base, cwd: 'C:/Windows' })).toThrow(/cwd/)
    expect(() => preregArgs({ ...base, hours: '12h' })).toThrow(/whole number/)
  })
  it('flattens newlines so one field cannot smuggle a second line into the log', () => {
    expect(preregArgs({ ...base, note: 'a\nb' })).toContain('--note=a b')
  })
  it('remeasure argv: 7d | 30d only', () => {
    expect(readArgs('lab/platform/carry', '008', '7d', true)).toEqual(['app/loop/tools/remeasure.py', '--desk=lab/platform/carry', '--run=008', '--age=7d', '--dry'])
    expect(() => readArgs('lab/platform/carry', '008', '14d', false)).toThrow(/7d or 30d/)
  })
})

describe('refusals are shown verbatim', () => {
  it('returns the REFUSED line exactly as the tool printed it', () => {
    const msg = "REFUSED: mechanic 'M99' is not a row in lab/platform/carry/mechanics.md (rows: M0, M1). Add the row first - that is where sample size accumulates across runs."
    expect(refusalOf({ code: 1, stdout: '', stderr: msg + '\n', ms: 1 })).toBe(msg)
  })
  it('is null on success and on a usage error (exit 2 is not a refusal)', () => {
    expect(refusalOf({ code: 0, stdout: 'ok', stderr: '', ms: 1 })).toBeNull()
    expect(refusalOf({ code: 2, stdout: '', stderr: 'usage: ...', ms: 1 })).toBeNull()
  })
})

/** a fake child: emits the given output then closes with `code` on the next tick (or never) */
function fakeSpawn(script: { out?: string; err?: string; code: number | null; hang?: boolean }, calls: any[]): SpawnFn {
  return ((exe: string, args: string[], opts: any) => {
    calls.push({ exe, args, opts })
    const c: any = new EventEmitter()
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter()
    c.kill = () => setTimeout(() => c.emit('close', null), 0)
    setTimeout(() => {
      if (script.out) c.stdout.emit('data', Buffer.from(script.out))
      if (script.err) c.stderr.emit('data', Buffer.from(script.err))
      if (!script.hang) c.emit('close', script.code)
    }, 5)
    return c
  }) as SpawnFn
}

const until = async (f: () => boolean, ms = 2000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 5)) } }

describe('remeasure jobs (mocked spawn - no engine runs here)', () => {
  it('runs in the background, logs to the lab log dir, and fires onChange at start and exit', async () => {
    const logDir = join(tmp(), 'logs', 'lab')
    const calls: any[] = [], seen: any[] = []
    const jobs = new ReadJobs({ python: 'py.exe', fundRoot: 'C:/fund', env: {}, logDir, spawn: fakeSpawn({ out: '7d read for 008: on-time (rc 0)\n', code: 0 }, calls), onChange: j => seen.push({ ended: j.ended !== null, code: j.code }) })
    const j = jobs.start('lab/platform/carry', '008', '7d')
    expect(j.ended).toBeNull()
    expect(calls[0]).toMatchObject({ exe: 'py.exe', args: ['app/loop/tools/remeasure.py', '--desk=lab/platform/carry', '--run=008', '--age=7d', '--json'], opts: { cwd: 'C:/fund', shell: false } })
    expect(calls[0].opts.env.PYTHONUNBUFFERED).toBe('1')
    expect(jobs.running()).toHaveLength(1)
    await until(() => j.ended !== null)
    expect(j.code).toBe(0)
    expect(seen).toEqual([{ ended: false, code: null }, { ended: true, code: 0 }])
    const log = readFileSync(j.log, 'utf8')
    expect(j.log.startsWith(logDir)).toBe(true)
    expect(log).toContain('remeasure.py --desk=lab/platform/carry')
    expect(log).toContain('on-time (rc 0)')
    expect(log).toMatch(/# exit 0 after/)
  })
  it('refuses a second start of the same read while the first runs', async () => {
    const jobs = new ReadJobs({ python: 'p', fundRoot: '.', env: {}, logDir: tmp(), spawn: fakeSpawn({ code: 0, hang: true }, []) })
    jobs.start('lab/a', '001', '7d', true)
    expect(() => jobs.start('lab/a', '001', '7d', true)).toThrow(/already running/)
    expect(() => jobs.start('lab/a', '001', '30d', true)).not.toThrow()
  })
  it('a tool refusal is kept in the log and the exit code, never read as success', async () => {
    const jobs = new ReadJobs({ python: 'p', fundRoot: '.', env: {}, logDir: tmp(), spawn: fakeSpawn({ err: 'REFUSED: the 7d read for 008 is not due until 2026-09-28 00:00Z (3.3 days away). Reading early is a different age.\n', code: 1 }, []) })
    const j = jobs.start('lab/a', '008', '7d', true)
    await until(() => j.ended !== null)
    expect(j.code).toBe(1)
    expect(j.tail).toContain('REFUSED: the 7d read for 008 is not due')
    expect(j.log).toMatch(/__dry\.log$/)
  })
  it('kills a read that outlives the backstop and says so in the log', async () => {
    const jobs = new ReadJobs({ python: 'p', fundRoot: '.', env: {}, logDir: tmp(), timeoutMs: 30, spawn: fakeSpawn({ code: 0, hang: true }, []) })
    const j = jobs.start('lab/a', '001', '30d')
    await until(() => j.ended !== null)
    expect(j.code).toBeNull()
    expect(readFileSync(j.log, 'utf8')).toMatch(/killed after/)
  })
  it('a spawn that throws ends the job as failed rather than leaving it running', () => {
    const jobs = new ReadJobs({ python: 'p', fundRoot: '.', env: {}, logDir: tmp(), spawn: (() => { throw new Error('ENOENT') }) as any })
    const j = jobs.start('lab/a', '001', '7d')
    expect(j.code).toBe(-1)
    expect(jobs.running()).toHaveLength(0)
  })
})

// ---- the real tool, DRY: validates against the live carry desk and writes nothing ----
const FUND = resolve(__dirname, '..', '..')
const PY = join(FUND, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const REAL = existsSync(PY) && existsSync(join(FUND, 'lab', 'platform', 'carry', 'mechanics.md'))

describe.skipIf(!REAL)('preregister.py --dry, for real', () => {
  const deps = () => ({ python: PY, fundRoot: FUND, env: { ...process.env, FUND_ROOT: FUND } as NodeJS.ProcessEnv })
  it('its refusal of an unknown mechanic reaches us verbatim, and nothing is written', async () => {
    const before = readFileSync(join(FUND, 'lab/platform/carry/data/runs.jsonl'), 'utf8')
    const out = await runTool(deps(), preregArgs({ desk: 'lab/platform/carry', run: '999', mechanic: 'M99', kind: 'exploit', ancestor: '008', variables: ['x'], predict: ['ann_pct=10..20'], cmd: 'python -V', window: '2026-01-01..2026-02-01', dry: true }), 60_000)
    expect(out.code).toBe(1)
    expect(refusalOf(out)).toMatch(/^REFUSED: mechanic 'M99' is not a row in lab\/platform\/carry\/mechanics\.md/)
    expect(readFileSync(join(FUND, 'lab/platform/carry/data/runs.jsonl'), 'utf8')).toBe(before)
  }, 60_000)
  it('a valid form passes the dry run and prints the entry it would write', async () => {
    const out = await runTool(deps(), preregArgs({ desk: 'lab/platform/carry', run: '999', mechanic: 'M1', kind: 'exploit', ancestor: '008', variables: ['window rolled'], predict: ['ann_pct=-6..-2'], cmd: 'python -V', window: '2026-01-01..2026-02-01', dry: true }), 60_000)
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('DRY - valid')
    expect(out.stdout).toContain('predict: ann_pct -6..-2')
  }, 60_000)
})
