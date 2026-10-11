import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { backupDir } from '@fund/db'
import { ceilings, colorSlots, spendSeries } from '../server/system/spend.ts'
import { absorb, helpSaysAvailable, lawFor, Remote, type Bridge } from '../server/system/remote.ts'

const tmp = mkdtempSync(join(tmpdir(), 'system-ops-'))
// Windows can hold a just-closed file (a killed fake bridge) for a moment: retry, and never fail the suite on temp cleanup
afterAll(() => { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* temp dir: the OS reaps it */ } })

describe('backup (moved to the data layer 2026-09-25)', () => {
  it('the System room lists the folder the data layer writes: @fund/db backupDir(), the one `python -m fund_db backup` uses', async () => {
    const OPS = await import('../server/system/ops.ts')
    expect(OPS.BACKUP_DIR).toBe(backupDir())
    expect(OPS.BACKUP_JOB).toBe('db-backup')
  })
  it('the nightly job runs the data layer backup, not a cockpit script', () => {
    const sched = JSON.parse(readFileSync(join(__dirname, '..', 'schedule.json'), 'utf8'))
    const job = sched.jobs.find((j: any) => j.id === 'db-backup')
    expect(job.cmd.slice(-3)).toEqual(['-m', 'fund_db', 'backup'])
    expect(existsSync(join(__dirname, '..', 'server', 'system', 'backup.ts'))).toBe(false)
  })
})

describe('spend series', () => {
  const rows = [
    { agent: 'fund', day: '2026-09-24', billable: 100, cost: 0, n: 1 },
    { agent: 'platform', day: '2026-09-24', billable: 300, cost: 0, n: 1 },
    { agent: 'fund', day: '2026-09-20', billable: 50, cost: 0, n: 1 },
    { agent: 'fund', day: '2026-08-01', billable: 999, cost: 0, n: 1 },   // outside 30 days
    { agent: 'quiet', day: '2026-09-22', billable: 0, cost: 0, n: 1 },
  ]
  it('thirty days ending today, every day present, oldest first', () => {
    const s = spendSeries(rows, '2026-09-24', 30)
    expect(s.days).toHaveLength(30)
    expect(s.days[0]).toBe('2026-08-26')
    expect(s.days[29]).toBe('2026-09-24')
    expect(s.agents).toEqual(['platform', 'fund'])      // most spend first; zero-spend agents dropped
    expect(s.totals[29]).toBe(400)
    expect(s.cells[25]).toEqual([0, 50])
    expect(s.max).toBe(400)
    expect(s.totals.reduce((a, b) => a + b, 0)).toBe(450)
  })
  it('crosses a month boundary without a gap or a duplicate', () => {
    const s = spendSeries([], '2026-10-02', 5)
    expect(s.days).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
    expect(s.max).toBe(0)
  })
  it('ceilings come from the config only; none written down is null', () => {
    expect(ceilings({ agents: [{ id: 'a' }, { id: 'b', budgetTokensPerDay: 5e6 }] }).byAgent).toEqual({ a: null, b: 5e6 })
    expect(ceilings({ defaults: { budgetTokensPerDay: 1e6 }, agents: [{ id: 'a' }, { id: 'b', budgetTokensPerDay: -1 }] }).byAgent).toEqual({ a: 1e6, b: 1e6 })
    expect(ceilings(null)).toEqual({ byAgent: {}, fallback: null })
  })
  it('colour follows the entity: config order, never spend rank; the rest share "other"', () => {
    const order = ['fund', 'platform', 'research', 'app', 'dash:trade', 'dash:x']
    expect(colorSlots(['platform', 'fund'], order)).toEqual({ fund: 0, platform: 1 })
    expect(colorSlots(['fund', 'platform'], order)).toEqual({ fund: 0, platform: 1 })
    const many = colorSlots(['zz', ...order], order)
    expect(many['dash:trade']).toBe(4)
    expect(many['dash:x']).toBe(5)
    expect(many.zz).toBe(5)
  })
})

describe('remote', () => {
  it('reads availability off the usage text, not the exit code (the help does not exit)', () => {
    expect(helpSaysAvailable('Remote Control - ...\n\nUSAGE\n  claude remote-control [options]\n', 1)).toBe(true)
    expect(helpSaysAvailable("error: unknown command 'remote-control'", 1)).toBe(false)
    expect(helpSaysAvailable('Usage: claude [options] [command] [prompt]', 0)).toBe(false)
  })

  it('only the fund root carries a bridge (the deny list loads only there)', () => {
    const root = join(tmp, 'fundroot'); mkdirSync(join(root, '.claude'), { recursive: true })
    expect(lawFor('.', root).allowed).toBe(false)
    writeFileSync(join(root, '.claude', 'settings.json'), '{}')
    expect(lawFor('.', root)).toEqual({ allowed: true, blocked: null })
    expect(lawFor('app', root).allowed).toBe(false)
  })

  it('absorb parses the bridge output into state', () => {
    const s: Bridge = { repo: 'fund', path: '.', allowed: true, blocked: null, running: true, status: 'starting', name: 'n', pid: 1, url: null, sessions: 0, capacity: 0, error: null, since: 0, tail: [] }
    expect(absorb(s, '\x1b[32mConnecting\x1b[0m\n')).toBe(true)
    expect(s.status).toBe('connecting')
    absorb(s, 'Environment ID: env_ABC123\nReady\nCapacity: 1 / 32\n')
    expect(s).toMatchObject({ status: 'connected', url: 'https://claude.ai/code?environment=env_ABC123', sessions: 1, capacity: 32 })
    absorb(s, 'Remote Control is not yet enabled for your account\n')
    expect(s.status).toBe('error')
    expect(s.error).toMatch(/not enabled/)
  })

  it('start and stop a bridge (a fake CLI: node running ./remote-control in the fund root)', async () => {
    const root = join(tmp, 'fakefund'); mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), '{}')
    writeFileSync(join(root, 'remote-control'), "console.log('Connecting'); setTimeout(() => console.log('Environment ID: env_T1\\nReady\\nCapacity: 0 / 32'), 100); setInterval(() => {}, 1000)\n")
    let changes = 0
    const killed: number[] = []
    const r = new Remote({
      fundRoot: root, stateFile: join(root, 'remote.json'),
      repos: () => [{ id: 'fund', path: '.' }, { id: 'app', path: 'app' }],
      env: () => ({ ...process.env }), onChange: () => { changes++ }, log: () => {},
      killTree: async pid => { killed.push(pid); try { process.kill(pid) } catch { /* gone */ } },
      bin: () => process.execPath,
    })
    expect(() => r.start('app')).toThrow(/own workspace/)
    expect(() => r.start('nope')).toThrow(/no repo/)
    const b = r.start('fund')
    expect(b).toMatchObject({ running: true, status: 'starting', name: 'fund-fund' })
    for (let i = 0; i < 50 && r.list()[0].status !== 'connected'; i++) await new Promise(res => setTimeout(res, 100))
    expect(r.list()[0]).toMatchObject({ status: 'connected', url: 'https://claude.ai/code?environment=env_T1', capacity: 32 })
    expect(r.start('fund').pid).toBe(b.pid)                 // idempotent: the running bridge is returned
    const after = await r.stop('fund')
    expect(killed).toEqual([b.pid])
    expect(after).toMatchObject({ running: false, status: 'off' })
    expect(changes).toBeGreaterThan(1)
  }, 15_000)
})
