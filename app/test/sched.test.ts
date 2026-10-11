import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// THE SCHEDULER (server/sched): the pure plan, pinned on a fixed local clock, then one real pass
// against a scratch fund root with a scratch database.
const TMP = mkdtempSync(join(tmpdir(), 'cockpit-sched-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')

const { loadJobs, occurrences, plan, resolveArgv } = await import('../server/sched/plan.ts')
const { ops, settled } = await import('../server/db.ts')
const { latestReading } = await import('../server/system/probes.ts')
const SCHED = await import('../server/sched/index.ts')
const { Scheduler, lastRunPerJob, recentRuns, exitStatus } = SCHED

const NOW = new Date(2026, 8, 24, 16, 55, 0).getTime()   // Thu 2026-09-24 16:55 LOCAL
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m, 0).getTime()
const job = (over: Record<string, unknown>) => loadJobs({ jobs: [{ id: 'j', cadence: 'daily 06:30', cwd: '.', cmd: ['python', 'x.py'], window_s: 21600, timeout_s: 60, ...over }] }).jobs[0]
const base = { now: NOW, lastDue: new Map<string, number>(), running: new Set<string>(), stopped: false, exists: () => true }

describe('schedule.json loading', () => {
  it('reads the live app/schedule.json with no errors', () => {
    const live = JSON.parse(readFileSync(resolve(__dirname, '..', 'schedule.json'), 'utf8'))
    const { jobs, errors } = loadJobs(live)
    expect(errors).toEqual([])
    expect(jobs.length).toBeGreaterThan(0)
    for (const j of jobs) {
      expect(j.kind).toBe('script')
      expect(j.cmd.length).toBeGreaterThan(0)
      // a one-shot "at <iso>" still in the future has no occurrence yet; every recurring cadence has one
      if (/^at\s/i.test(j.cadence)) expect(occurrences(j.cadence, NOW, 1).length).toBeLessThanOrEqual(1)
      else expect(occurrences(j.cadence, NOW, 1)).toHaveLength(1)
    }
  })
  it('every script a live job runs from the fund root exists there (the 2026-09-25 move: tools/ -> app/tools, app/loop/tools)', () => {
    const live = JSON.parse(readFileSync(resolve(__dirname, '..', 'schedule.json'), 'utf8'))
    const fund = resolve(__dirname, '..', '..')
    const scripts = loadJobs(live).jobs.filter(j => j.kind === 'script' && j.cwd === '.').flatMap(j => j.cmd.filter(a => /\.(py|mjs)$/.test(a)))
    expect(scripts.length).toBeGreaterThan(5)
    for (const s of scripts) expect(existsSync(join(fund, s)), s).toBe(true)
  })
  it('accepts the retired fundcli shape (command / kind / desk / prompt)', () => {
    const { jobs, errors } = loadJobs({ defaults: { window_s: 60 }, jobs: [
      { id: 'a', kind: 'script', command: ['python', '-m', 'x'], cwd: 'crypto', cadence: 'every 1h', enabled: false },
      { id: 'b', kind: 'agent', desk: 'desks/app', prompt: '/retro', cadence: 'weekly SUN 18:00' },
    ] })
    expect(errors).toEqual([])
    expect(jobs[0]).toMatchObject({ cmd: ['python', '-m', 'x'], enabled: false, windowS: 60 })
    expect(jobs[1]).toMatchObject({ kind: 'agent', unattended: false, desk: 'desks/app' })
  })
  it('a job that cannot run as written is an error naming it, never a silent no-op', () => {
    const { jobs, errors } = loadJobs({ jobs: [
      { id: 'shell', cmd: 'python x.py', cadence: 'daily 06:00' },
      { id: 'badcad', cmd: ['x'], cadence: 'hourly' },
      { id: 'badtime', cmd: ['x'], cadence: 'daily 25:00' },
      { id: 'nocmd', cadence: 'daily 06:00' },
      { id: 'bad id!', cmd: ['x'], cadence: 'daily 06:00' },
      { id: 'dup', cmd: ['x'], cadence: 'daily 06:00' }, { id: 'dup', cmd: ['x'], cadence: 'daily 06:00' },
    ] })
    expect(jobs.map(j => j.id)).toEqual(['dup'])
    expect(errors).toHaveLength(6)
    expect(errors.join('\n')).toMatch(/shell: cmd must be an argv LIST/)
    expect(errors.join('\n')).toMatch(/badcad: cadence/)
    expect(errors.join('\n')).toMatch(/badtime: cadence/)
  })
  it('python and a fund-relative venv path both mean the fund venv', () => {
    expect(resolveArgv(['python', 'a.py'], 'V')).toEqual(['V', 'a.py'])
    expect(resolveArgv(['python3', 'a.py'], 'V')).toEqual(['V', 'a.py'])
    expect(resolveArgv(['.venv/Scripts/python.exe', 'a.py'], 'V')).toEqual(['.venv/Scripts/python.exe', 'a.py'])
  })
})

describe('occurrences (fundcli grammar, most recent first)', () => {
  it('daily / weekly / every / at', () => {
    expect(occurrences('daily 06:30', NOW, 3)).toEqual([at(24, 6, 30), at(23, 6, 30), at(22, 6, 30)])
    expect(occurrences('weekly mon 08:00', NOW, 2)).toEqual([at(21, 8), at(14, 8)])
    expect(occurrences('every 4h', NOW, 2).map(t => new Date(t).getHours())).toEqual([16, 12])
    expect(occurrences('every 15m', NOW, 2).map(t => new Date(t).getMinutes())).toEqual([45, 30])
    expect(occurrences('at 2026-09-24T09:00', NOW)).toEqual([at(24, 9)])
    expect(occurrences('at 2026-09-30T09:00', NOW)).toEqual([])
  })
})

describe('plan: due / missed / skipped', () => {
  it('a job with no history takes only its latest occurrence (no invented backlog)', () => {
    // past its grace: nothing is written - a job added after that occurrence never missed it (B-0038)
    expect(plan({ ...base, jobs: [job({})] })).toEqual([])
    expect(plan({ ...base, jobs: [job({ enabled: false })] })).toEqual([])
    expect(plan({ ...base, jobs: [job({ window_s: 40000 })] })).toEqual([{ job: 'j', due: at(24, 6, 30), action: 'run', detail: '' }])
  })
  it('occurrences after the newest recorded one: expired ones MISSED (never run late), the live one runs', () => {
    const d = plan({ ...base, jobs: [job({ cadence: 'every 1h', window_s: 3600 })], lastDue: new Map([['j', at(24, 13)]]) })
    expect(d.map(x => [new Date(x.due).getHours(), x.action])).toEqual([[14, 'missed'], [15, 'missed'], [16, 'run']])
  })
  it('already recorded: nothing to do', () => {
    expect(plan({ ...base, jobs: [job({ window_s: 40000 })], lastDue: new Map([['j', at(24, 6, 30)]]) })).toEqual([])
  })
  it('two occurrences inside the window: only the newest runs, the older is superseded', () => {
    const d = plan({ ...base, jobs: [job({ cadence: 'every 15m', window_s: 3600 })], lastDue: new Map([['j', at(24, 16, 15)]]) })
    expect(d.map(x => x.action)).toEqual(['skipped', 'run'])
    expect(d[0].detail).toMatch(/superseded/)
  })
  it('floor/STOP: everything due is SKIPPED, and an expired one is still MISSED', () => {
    const d = plan({ ...base, stopped: true, jobs: [job({ cadence: 'every 1h', window_s: 3600 })], lastDue: new Map([['j', at(24, 14)]]) })
    expect(d.map(x => [x.action, x.detail])).toEqual([['missed', 'no run within its 1h grace'], ['skipped', 'stopped (floor/STOP)']])
  })
  it('disabled, requires missing, still running, agent not unattended: skipped with the reason', () => {
    const w = { window_s: 40000 }
    expect(plan({ ...base, jobs: [job({ ...w, enabled: false })] })[0]).toMatchObject({ action: 'skipped', detail: 'disabled in schedule.json' })
    expect(plan({ ...base, exists: () => false, jobs: [job({ ...w, requires: 'desks' })] })[0]).toMatchObject({ action: 'skipped', detail: 'requires desks, which is missing' })
    expect(plan({ ...base, running: new Set(['j']), jobs: [job(w)] })[0]).toMatchObject({ action: 'skipped', detail: 'previous run still running' })
    const agent = loadJobs({ jobs: [{ id: 'j', kind: 'agent', prompt: '/retro', cadence: 'daily 06:30', window_s: 40000 }] }).jobs
    expect(plan({ ...base, jobs: agent })[0]).toMatchObject({ action: 'skipped' })
    expect(plan({ ...base, jobs: [{ ...agent[0], unattended: true }] })[0]).toMatchObject({ action: 'run' })
  })
})

describe('Scheduler: one real pass on a scratch fund root', () => {
  const root = join(TMP, 'fund')
  mkdirSync(join(root, 'floor'), { recursive: true })
  mkdirSync(join(root, 'app'), { recursive: true })
  // the jobs file sits in the machine since 2026-09-25: <fund>/app/schedule.json
  const write = (jobs: unknown[]) => writeFileSync(join(root, 'app', 'schedule.json'), JSON.stringify({ jobs }))
  const node = process.execPath
  const s = new Scheduler({ fundRoot: root, floorDir: join(root, 'floor'), logDir: join(TMP, 'logs'), python: node })
  const settle = async (id: string) => { for (let k = 0; k < 200 && s.running().has(id); k++) await new Promise(r => setTimeout(r, 25)) }
  // a job's reading and the scheduler's own are rows of the ops store (system:<id>), queued writes
  const reading = async (id: string) => { await settled(); return latestReading(id) }

  it('runs a due job once, logs ok + exit + a log file, records both readings, env scrubbed', async () => {
    process.env.EXCHANGE_API_KEY = 'must-not-cross'
    write([{ id: 'hello', cadence: 'every 1m', window_s: 600, timeout_s: 30, cwd: '.', health: true,
      cmd: ['python', '-e', "console.log('hi', process.cwd().length > 0, process.env.EXCHANGE_API_KEY ?? 'scrubbed', process.env.FUND_JOB, process.env.FUND_JOB_TRIGGER)"] }])
    const d = await s.pass()
    expect(d.map(x => x.action)).toEqual(['run'])
    await settle('hello')
    const r = (await lastRunPerJob()).get('hello')!
    expect(r).toMatchObject({ status: 'ok', exit_code: 0, trigger: 'schedule' })
    const log = readFileSync(r.log_path!, 'utf8')
    expect(log).toMatch(/hi true scrubbed hello schedule/)
    expect(log).not.toMatch(/must-not-cross/)
    expect(await s.pass()).toEqual([])                       // same occurrence: not run twice
    const own = await reading('hello')
    expect(own).toMatchObject({ id: 'hello', status: 'ok', window_s: 660, owner: 'scheduler' })   // the 1m period + its 600s grace
    const sch = await reading('scheduler')
    expect(sch!.reading).toMatch(/^1 ok \(jobs, newest run\)/)
    expect(sch!.detail.runs24h).toMatchObject({ ran: 1, failed: 0, missed: 0 })
    expect(existsSync(join(root, 'floor', 'health'))).toBe(false)             // no file on the floor any more
    delete process.env.EXCHANGE_API_KEY
  })

  it('health:false never records the job reading (the tool owns it); exit 1 is fail', async () => {
    await ops.recordHealth('system:own', 'system', 'ok', { reading: 'the tool\'s own', detail: { id: 'own', status: 'ok' }, ts: 1 })
    write([{ id: 'own', cadence: 'every 1m', window_s: 600, timeout_s: 30, cwd: '.', health: false, cmd: ['python', '-e', 'process.exit(1)'] }])
    await s.pass()
    await settle('own')
    expect((await lastRunPerJob()).get('own')).toMatchObject({ status: 'fail', exit_code: 1 })
    expect(await reading('own')).toMatchObject({ status: 'ok', reading: 'the tool\'s own' })
  })

  it('exit 2 is UNKNOWN (the probe contract), never counted as a fail', async () => {
    write([{ id: 'probe', cadence: 'every 1m', window_s: 600, timeout_s: 30, cwd: '.', health: true, cmd: ['python', '-e', 'process.exit(2)'] }])
    await s.pass()
    await settle('probe')
    expect((await lastRunPerJob()).get('probe')).toMatchObject({ status: 'unknown', exit_code: 2 })
    expect((await reading('probe'))!.status).toBe('unknown')
    const c = await s.counts(0)
    expect(c.unknown).toBe(1)
    expect(c.failed).toBe(1)   // only the exit-1 run above
    expect(exitStatus(0, null)).toBe('ok')
    expect(exitStatus(1, null)).toBe('fail')
    expect(exitStatus(2, null)).toBe('unknown')
    expect(exitStatus(null, null)).toBe('fail')
    expect(exitStatus(2, 'timeout after 1s')).toBe('fail')
  })

  it('a job may map its own exit codes (retro-due: 1 = due is a nag, not a fail); a kill still fails', async () => {
    write([{ id: 'nag', cadence: 'every 1m', window_s: 600, timeout_s: 30, cwd: '.', health: true, exit: { 1: 'unknown' }, cmd: ['python', '-e', 'process.exit(1)'] }])
    await s.pass()
    await settle('nag')
    expect((await lastRunPerJob()).get('nag')).toMatchObject({ status: 'unknown', exit_code: 1 })
    expect((await reading('nag'))!.status).toBe('unknown')
    expect(exitStatus(1, null, { 1: 'unknown' })).toBe('unknown')
    expect(exitStatus(1, 'timeout after 1s', { 1: 'unknown' })).toBe('fail')
    expect(loadJobs({ jobs: [{ id: 'x', cadence: 'every 1m', cmd: ['a'], exit: { 1: 'warn' } }] }).errors[0]).toMatch(/exit maps/)
    expect(loadJobs({ jobs: [{ id: 'x', cadence: 'every 1m', cmd: ['a'], exit: 'unknown' }] }).errors[0]).toMatch(/must be an object/)
  })

  it('timeout_s kills the tree and the row says so', async () => {
    write([{ id: 'slow', cadence: 'every 1m', window_s: 600, timeout_s: 1, cwd: '.', cmd: ['python', '-e', 'setTimeout(() => {}, 60000)'] }])
    await s.pass()
    await settle('slow')
    const r = (await lastRunPerJob()).get('slow')!
    expect(r.status).toBe('fail')
    expect(r.detail).toMatch(/timeout after 1s/)
  }, 15_000)

  it('its own reading is recorded when it changes or a heartbeat has passed, never once a pass', async () => {
    const quiet = new Scheduler({ fundRoot: root, floorDir: join(root, 'floor'), logDir: join(TMP, 'logs'), python: node })
    const T = 1e12                                                            // 2001: older than every real pass here
    const rows = async () => (await ops.healthHistory('system:scheduler', { since: T })).filter(r => r.ts < T + 86_400_000).length
    await quiet.writeHealth(T, [], [])
    await quiet.writeHealth(T + 60_000, [], [])                              // the same reading a pass later: held
    expect(await rows()).toBe(1)
    await quiet.writeHealth(T + 120_000, ['bad job'], [])                    // changed: recorded at once
    expect(await rows()).toBe(2)
    await quiet.writeHealth(T + 120_000 + Scheduler.HEARTBEAT_MS, ['bad job'], [])   // unchanged, a heartbeat on
    expect(await rows()).toBe(3)
    const last = (await ops.healthHistory('system:scheduler', { since: T })).filter(r => r.ts < T + 86_400_000)[0]
    expect(last.detail_json).toMatchObject({ status: 'fail', window_s: 3 * Scheduler.HEARTBEAT_MS / 1000 })
  })

  it('floor/STOP: nothing starts, the occurrence is skipped, Run now refuses', async () => {
    writeFileSync(join(root, 'floor', 'STOP'), 'stopped\n')
    write([{ id: 'halted', cadence: 'every 1m', window_s: 600, timeout_s: 30, cwd: '.', cmd: ['python', '-e', '0'] }])
    const d = await s.pass()
    expect(d).toMatchObject([{ action: 'skipped', detail: 'stopped (floor/STOP)' }])
    await expect(s.runNow('halted')).rejects.toThrow(/stopped/)
    expect((await reading('scheduler'))!.status).toBe('unknown')                 // a changed reading is recorded at once
  })

  it('Run now records a manual row; a cwd off disk is a fail, not a crash', async () => {
    const { rmSync } = await import('node:fs'); rmSync(join(root, 'floor', 'STOP'))
    write([{ id: 'manual', cadence: 'weekly sun 03:00', window_s: 60, timeout_s: 30, cwd: '.', cmd: ['python', '-e', '0'] },
      { id: 'nowhere', cadence: 'weekly sun 03:00', window_s: 60, timeout_s: 30, cwd: 'gone', cmd: ['python', '-e', '0'] }])
    await s.runNow('manual')
    await settle('manual')
    expect((await recentRuns('manual'))[0]).toMatchObject({ status: 'ok', trigger: 'manual', due_at: null })
    await s.runNow('nowhere')
    expect((await recentRuns('nowhere'))[0]).toMatchObject({ status: 'fail', detail: 'cwd gone is not on disk' })
    expect(existsSync(join(root, 'gone'))).toBe(false)
  })

  it('a fundd restart adopts a job whose pid still runs, closes one whose pid is gone, and never starts a second copy', async () => {
    const { spawn } = await import('node:child_process')
    write([{ id: 'orphan', cadence: 'weekly sun 03:00', window_s: 60, timeout_s: 30, cwd: '.', cmd: ['python', '-e', '0'] },
      { id: 'dead', cadence: 'weekly sun 03:00', window_s: 60, timeout_s: 30, cwd: '.', cmd: ['python', '-e', '0'] }])
    // a child the "old" fundd started: still running when the new one boots
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' })
    const ins = async (job: string, pid: number | null) => (await ops.insert('job_runs', { job_id: job, started_at: Date.now() - 1000, status: 'running', trigger: 'schedule', pid })).id
    const alive = await ins('orphan', child.pid ?? null)
    const gone = await ins('dead', 999_999)
    const fresh = new Scheduler({ fundRoot: root, floorDir: join(root, 'floor'), logDir: join(TMP, 'logs'), python: node })
    await fresh.recover()
    const { runRow } = await import('../server/sched/index.ts')
    expect(await runRow(gone)).toMatchObject({ status: 'fail' })
    expect((await runRow(gone))!.detail).toMatch(/pid 999999 was gone/)
    expect(await runRow(alive)).toMatchObject({ status: 'running' })
    expect(fresh.running().has('orphan')).toBe(true)
    await expect(fresh.runNow('orphan')).rejects.toThrow(/already running/)
    await new Promise(r => child.once('exit', r))
    for (let k = 0; k < 400 && fresh.running().has('orphan'); k++) await new Promise(r => setTimeout(r, 25))
    expect(await runRow(alive)).toMatchObject({ status: 'unknown' })
  }, 20_000)

  it('a missed occurrence is recorded after downtime and never run late', async () => {
    await ops.addJobRun('late', 'ok', { dueAt: Date.now() - 3 * 3600_000 })
    write([{ id: 'late', cadence: 'every 1h', window_s: 1, timeout_s: 30, cwd: '.', cmd: ['python', '-e', '0'] }])
    const d = await s.pass()
    expect(d.every(x => x.action === 'missed')).toBe(true)
    expect(d.length).toBeGreaterThanOrEqual(2)
  })
})

describe('jobTally: one basis for every scheduler count', () => {
  it('counts enabled jobs by their newest run', () => {
    const jobs = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }, { id: 'c', enabled: true }, { id: 'd', enabled: false }, { id: 'e', enabled: true }]
    const last = new Map([['a', { status: 'fail' }], ['b', { status: 'missed' }], ['c', { status: 'unknown' }], ['d', { status: 'fail' }]])
    const { jobTally, jobReading } = SCHED
    const t = jobTally(jobs, last)
    expect(t).toEqual({ on: 4, ok: 0, fail: 1, unknown: 1, missed: 1, never: 1 })
    expect(jobReading(t)).toBe('1 fail · 1 missed · 1 unknown of 4')
    expect(jobReading(jobTally([{ id: 'a', enabled: true }], new Map([['a', { status: 'ok' }]])))).toBe('1 ok')
  })
})

describe('runBanner / lastStarted: the Run probes banner reads the probe-sweep JOB', () => {
  it('a missed row never started, so it is not the banner; the newest STARTED row is', async () => {
    await ops.insert('job_runs', { job_id: 'banner-job', due_at: 1000, started_at: 2000, ended_at: 3000, status: 'ok', trigger: 'manual', exit_code: 0 })
    await ops.addJobRun('banner-job', 'missed', { dueAt: 5000, startedAt: null, endedAt: 9000, trigger: 'schedule' })
    const row = await SCHED.lastStarted('banner-job')
    expect(row?.status).toBe('ok')
    expect(SCHED.runBanner(row, 'tail')).toEqual({ what: 'banner-job', started: 2000, ended: 3000, code: 0, status: 'ok', tail: 'tail' })
    expect(await SCHED.lastStarted('no-such-job')).toBeNull()
  })
  it('a running row has no end and no code, whatever ended_at says', () => {
    expect(SCHED.runBanner({ job_id: 'x', started_at: 10, ended_at: 20, exit_code: 1, status: 'running' }, '')).toMatchObject({ ended: null, code: null })
    expect(SCHED.runBanner(null, '')).toBeNull()
    expect(SCHED.runBanner({ job_id: 'x', started_at: null, ended_at: 20, exit_code: null, status: 'missed' }, '')).toBeNull()
  })
})
