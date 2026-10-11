import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CONTINUE_GAP_MS, CRASH_LOOP_MS, CUT_NOTE, JOURNAL, RESTART_BATCH_MS, RESTART_CODE, Restarter, SCANNED, SCAN_WINDOW_MS, busyReasons, childNames,
  continueMessage, cutNote, restoreAtBoot, stopProd, supervise,
  type LiveConv, type Reopen, type RestartDeps, type SavedLive,
} from '../server/restart.ts'

// B-0174 part 2: fundd restarts for new server code ONLY at an idle moment, saves the open
// conversations, and the next fundd reopens them - unless it is crash-looping. Every clock, process
// and file here is a fake or a scratch folder: nothing restarts for real.

const TMP = mkdtempSync(join(tmpdir(), 'restart-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const T0 = 1_800_000_000_000
function rig(o: { convs?: LiveConv[]; supervised?: boolean; commitAt?: number | null; startedAgo?: number; blockers?: () => Promise<string[]>; batchMs?: number } = {}) {
  let now = T0
  const convs = o.convs ?? []
  const saved: SavedLive[] = []
  const exits: number[] = []
  let shut = 0
  const d: RestartDeps = {
    now: () => now,
    started: T0 - (o.startedAgo ?? 5 * 60_000),
    supervised: o.supervised ?? true,
    serverCommit: async () => (o.commitAt === undefined ? T0 - 60_000 : o.commitAt),
    blockers: o.blockers ?? (async () => busyReasons({ convs, terminals: [] })),
    live: () => convs,
    save: s => { saved.push(s) },
    shutdown: async () => { shut++ },
    exit: c => { exits.push(c) },
    batchMs: o.batchMs ?? 0,          // the batch (B-0254) has its own tests below
    setTimer: fn => { queueMicrotask(fn); return 1 },
  }
  return { r: new Restarter(d), convs, saved, exits, shut: () => shut, advance: (ms: number) => { now += ms } }
}

describe('the idle restart waits for idle', () => {
  it('new server code while a turn runs: it WAITS, saves nothing and never exits; the turn ends, it restarts', async () => {
    const x = rig({ convs: [{ id: 'c1', busy: true, waiting: false }, { id: 'c2', busy: false, waiting: false }] })
    expect(await x.r.tick()).toBe('waiting')
    expect(await x.r.request()).toBe('waiting')          // the owner's plain restart waits too
    expect(x.r.status.waitingOn).toEqual(['1 turn running'])
    expect(x.exits).toEqual([])
    expect(x.saved).toEqual([])
    x.convs[0].busy = false                               // the turn finished
    expect(await x.r.tick()).toBe('restarting')
    expect(x.saved).toHaveLength(1)
    expect(x.saved[0].conversations).toEqual([{ id: 'c1', cutOff: false }, { id: 'c2', cutOff: false }])
    expect(x.shut()).toBe(1)
    expect(x.exits).toEqual([RESTART_CODE])
    expect(await x.r.tick()).toBe('restarting')           // once
    expect(x.exits).toEqual([RESTART_CODE])
  })
  it('a decision parked on the owner and a terminal running a command hold it the same way', async () => {
    expect(busyReasons({ convs: [{ id: 'a', busy: true, waiting: true }], terminals: [] })).toEqual(['1 decision waiting on the owner'])
    expect(busyReasons({ convs: [], terminals: [{ id: 't1', title: null, children: ['PING.EXE'] }, { id: 't2', title: 'pwsh', children: [] }] })).toEqual(['terminal t1 running PING.EXE'])
    expect(busyReasons({ convs: [], terminals: [{ id: 't3', title: 'x', children: null }] })).toEqual(['terminal x: its processes could not be read'])
    expect(busyReasons({ convs: [], terminals: [], building: true })).toEqual(['a UI build'])
    const x = rig({ convs: [{ id: 'a', busy: true, waiting: true }] })
    expect(await x.r.tick()).toBe('waiting')
    expect(x.exits).toEqual([])
  })
  it('a FORCED restart does not wait: the cut-off turn is saved as cut off', async () => {
    const x = rig({ convs: [{ id: 'c1', busy: true, waiting: false }] })
    expect(await x.r.request(true)).toBe('restarting')
    expect(x.saved[0]).toMatchObject({ reason: 'forced by the owner', conversations: [{ id: 'c1', cutOff: true }] })
    expect(x.exits).toEqual([RESTART_CODE])
  })
  it('no new code: nothing happens; unsupervised: it only tells; a young fundd waits out the crash-loop window', async () => {
    const cur = rig({ commitAt: T0 - 10 * 60_000 })         // the newest commit is older than this fundd
    expect(await cur.r.tick()).toBe('current')
    expect(cur.r.status.stale).toBe(false)
    const lone = rig({ supervised: false })
    expect(await lone.r.tick()).toBe('unsupervised')
    expect(lone.r.status.stale).toBe(true)
    expect(lone.exits).toEqual([])
    const young = rig({ startedAgo: 10_000, commitAt: T0 - 5_000 })
    expect(await young.r.tick()).toBe('waiting')
    expect(young.r.status.waitingOn).toEqual(['fundd started under a minute ago'])
    young.advance(CRASH_LOOP_MS)
    expect(await young.r.tick()).toBe('restarting')
  })
  it('an idle check that throws is a reason to wait, never a green light', async () => {
    const x = rig({ blockers: async () => { throw new Error('boom') } })
    expect(await x.r.tick()).toBe('waiting')
    expect(x.exits).toEqual([])
  })
})

describe('the next fundd reopens what was saved', () => {
  const files = (name: string) => ({ bootFile: join(TMP, `${name}-boot.json`), liveFile: join(TMP, `${name}-live.json`) })
  const save = (f: string, s: SavedLive) => writeFileSync(f, JSON.stringify(s))

  it('reopens each saved conversation that was cut or lost work, from its transcript, with a note when cut; a plain idle one stays closed (B-0420); consumes the list', async () => {
    const f = files('ok')
    writeFileSync(f.bootFile, JSON.stringify({ bootAt: T0 - 30 * 60_000 }))
    save(f.liveFile, { savedAt: T0 - 5_000, reason: 'new server code', conversations: [{ id: 'c1', cutOff: false, lost: ['monitor "x"'] }, { id: 'c2', cutOff: true }, { id: 'gone', cutOff: true }, { id: 'quiet', cutOff: false }] })
    const calls: [string, string | null][] = []
    const r = await restoreAtBoot({ now: () => T0, pid: 42, ...f, sleep: async () => {}, reopen: async (id, o) => { if (id === 'gone') throw new Error('no such conversation'); calls.push([id, o.note]) } })
    expect(calls).toEqual([['c1', null], ['c2', cutNote('new server code', true)]])
    expect(r).toMatchObject({ rapid: false, saved: 4, reopened: ['c1', 'c2'], failed: ['gone'], skipped: null, continued: ['c1', 'c2'], idle: ['quiet'] })
    expect(existsSync(f.liveFile)).toBe(false)
    expect(JSON.parse(readFileSync(f.bootFile, 'utf8'))).toEqual({ bootAt: T0, pid: 42 })
  })
  it('the crash-loop guard: a start under 60 s after the previous one reopens nothing (and still consumes the list)', async () => {
    const f = files('loop')
    writeFileSync(f.bootFile, JSON.stringify({ bootAt: T0 - 20_000 }))
    save(f.liveFile, { savedAt: T0 - 10_000, reason: 'new server code', conversations: [{ id: 'c1', cutOff: false }] })
    const calls: string[] = []
    const r = await restoreAtBoot({ now: () => T0, pid: 1, ...f, reopen: async id => { calls.push(id) } })
    expect(r.rapid).toBe(true)
    expect(r.skipped).toMatch(/crash loop/)
    expect(calls).toEqual([])
    expect(existsSync(f.liveFile)).toBe(false)
  })
  it('a saved list from another day is not a restart; no list and no previous boot are a plain start', async () => {
    const f = files('old')
    save(f.liveFile, { savedAt: T0 - 3 * 3_600_000, reason: 'new server code', conversations: [{ id: 'c1', cutOff: false }] })
    const calls: string[] = []
    const r = await restoreAtBoot({ now: () => T0, pid: 1, ...f, reopen: async id => { calls.push(id) } })
    expect(r.skipped).toMatch(/older than 10 minutes/)
    expect(calls).toEqual([])
    const g = files('fresh')
    expect(await restoreAtBoot({ now: () => T0, pid: 1, ...g, reopen: async () => {} })).toEqual({ rapid: false, saved: 0, reopened: [], failed: [], skipped: null, scanned: [], continued: [], idle: [] })
  })
})

describe('the supervisor (scripts/prod.mjs)', () => {
  const fake = (codes: (number | null)[]) => {
    const pids: number[] = []
    let n = 0
    return { pids, start: () => { const pid = 100 + n; const code = codes[n++]; pids.push(pid); return { pid, exited: Promise.resolve(code) } } }
  }
  it('starts fundd again after each restart exit and stops on any other', async () => {
    const f = fake([RESTART_CODE, RESTART_CODE, 0])
    const seen: [number | undefined, number][] = []
    expect(await supervise({ start: f.start, started: (pid, n) => seen.push([pid, n]) })).toBe(0)
    expect(seen).toEqual([[100, 0], [101, 1], [102, 2]])
    const crash = fake([1, 0])
    expect(await supervise({ start: crash.start })).toBe(1)
    expect(crash.pids).toEqual([100])
  })
})

describe('a terminal running a command is seen', () => {
  it('a live child of this process is listed by name; a bad pid is unreadable', async () => {
    expect(await childNames(-1)).toBeNull()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { windowsHide: true, stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 300))
      const names = await childNames(process.pid)
      expect(names).not.toBeNull()
      expect(names!.map(n => n.toLowerCase().replace(/\.exe$/, ''))).toContain('node')
    } finally { child.kill() }
  }, 20_000)
})

describe('B-0254: every way a fundd ends keeps what was open', () => {
  it('THE JOURNAL: while fundd runs, the live file holds the open conversations, a running turn cut; a planned exit freezes it', async () => {
    const x = rig({ convs: [{ id: 'c1', busy: true, waiting: false }, { id: 'c2', busy: false, waiting: false, later: ['wake-up 0 9 * * *'] }], commitAt: null })
    x.r.journal(true)
    expect(x.saved.at(-1)).toMatchObject({ reason: JOURNAL, conversations: [{ id: 'c1', cutOff: true }, { id: 'c2', cutOff: false, lost: ['wake-up 0 9 * * *'] }] })
    x.convs[0].busy = false
    x.r.journal()                                              // debounced: written a moment later
    await Promise.resolve()
    expect(x.saved.at(-1)!.conversations[0]).toEqual({ id: 'c1', cutOff: false })
    await x.r.request(true)                                    // a planned exit writes its own list...
    const n = x.saved.length
    x.convs.length = 0                                         // ...and the hands closing after it
    x.r.journal(); x.r.journal(true); await Promise.resolve()  // never overwrite it
    expect(x.saved).toHaveLength(n)
    expect(x.saved.at(-1)!.reason).toBe('forced by the owner')
  })
  it('a journal found at boot reopens with the note that names an unplanned stop', async () => {
    const f = { bootFile: join(TMP, 'j-boot.json'), liveFile: join(TMP, 'j-live.json') }
    writeFileSync(f.liveFile, JSON.stringify({ savedAt: T0 - 30_000, reason: JOURNAL, conversations: [{ id: 'c1', cutOff: true, lost: ['local_bash "x"'] }] }))
    const calls: unknown[] = []
    await restoreAtBoot({ now: () => T0, pid: 1, ...f, reopen: async (...a) => { calls.push(a) } })
    expect(calls).toEqual([['c1', { note: cutNote(JOURNAL, true), lost: ['local_bash "x"'], say: 'continue', at: T0 }]])
    expect(cutNote(JOURNAL)).not.toBe(CUT_NOTE)
  })
  it('LEAVE (prod.mjs --stop): refused while a turn runs; forced, it saves the cut and exits 0 so the supervisor stops', async () => {
    const x = rig({ convs: [{ id: 'c1', busy: true, waiting: false }] })
    expect(await x.r.leave()).toEqual({ left: false, waitingOn: ['1 turn running'] })
    expect(x.exits).toEqual([])
    expect(await x.r.leave(true, 'stopped by prod.mjs --stop')).toEqual({ left: true, waitingOn: [] })
    expect(x.saved.at(-1)).toMatchObject({ reason: 'stopped by prod.mjs --stop, forced', conversations: [{ id: 'c1', cutOff: true }] })
    expect(x.exits).toEqual([0])
    const idle = rig({ convs: [{ id: 'c2', busy: false, waiting: false }] })
    expect((await idle.r.leave()).left).toBe(true)
    expect(idle.exits).toEqual([0])
  })
  it('background work: a command or subagent holds a restart like a turn; a watcher or a wake-up does not', () => {
    expect(busyReasons({ convs: [{ id: 'a', busy: false, waiting: false, tasks: ['local_bash "npm run verify"'] }], terminals: [] }))
      .toEqual(['1 conversation waiting on background work (local_bash "npm run verify")'])
    expect(busyReasons({ convs: [{ id: 'a', busy: false, waiting: false, later: ['monitor "x"', 'cron */5 * * * *'] }], terminals: [] })).toEqual([])
    expect(busyReasons({ convs: [{ id: 'a', busy: true, waiting: false, tasks: ['x'] }], terminals: [] })).toEqual(['1 turn running'])
  })
})

describe('B-0254 (4): the batch - new server code restarts at most once per window', () => {
  it("inside the window it waits and says until when; the owner's request skips it; after the window it goes", async () => {
    const x = rig({ startedAgo: 5 * 60_000, batchMs: RESTART_BATCH_MS })
    expect(await x.r.tick()).toBe('waiting')
    expect(x.r.status.batchUntil).toBe(T0 - 5 * 60_000 + RESTART_BATCH_MS)
    expect(x.r.status.waitingOn[0]).toMatch(/^the batch: new server code restarts at most once per 30 min, next from \d\d:\d\dZ/)
    x.advance(RESTART_BATCH_MS - 5 * 60_000)
    expect(await x.r.tick()).toBe('restarting')
    expect(x.saved.at(-1)!.reason).toBe('new server code')
    const y = rig({ startedAgo: 5 * 60_000, batchMs: RESTART_BATCH_MS })
    expect(await y.r.tick()).toBe('waiting')
    expect(await y.r.request()).toBe('restarting')                // the owner's click
    expect(y.saved.at(-1)!.reason).toBe('asked by the owner')
    const z = rig({ startedAgo: 5 * 60_000, batchMs: RESTART_BATCH_MS, convs: [{ id: 'c', busy: true, waiting: false }] })
    expect(await z.r.request()).toBe('waiting')                   // the click skips the batch, never the idle check
    expect(z.r.status.waitingOn).toEqual(['1 turn running'])
  })
})

describe('B-0254 (1): prod.mjs --stop asks, and a refusal kills nothing', () => {
  type Answer = { status: number; body: { left?: boolean; error?: string } } | null
  const deps = (leave: Answer, gone = true) => {
    const said: string[] = []
    let kills = 0
    return { said, kills: () => kills, d: { leave: async () => leave, gone: async () => gone, kill: () => { kills++ }, say: (m: string) => { said.push(m) }, waitMs: 300 } }
  }
  it('409 (a turn runs): exit 1, nothing killed, the reasons said', async () => {
    const x = deps({ status: 409, body: { error: 'fundd is not idle: 3 turns running' } })
    expect(await stopProd(x.d, false)).toBe(1)
    expect(x.kills()).toBe(0)
    expect(x.said[0]).toMatch(/refused: fundd is not idle: 3 turns running/)
  })
  it('agreed: waits until it is gone, never kills', async () => {
    const x = deps({ status: 200, body: { left: true } })
    expect(await stopProd(x.d, false)).toBe(0)
    expect(x.kills()).toBe(0)
  })
  it('a fundd that cannot be asked (older code: 404, or no answer) is killed only when forced', async () => {
    const x = deps({ status: 404, body: { error: 'no route' } })
    expect(await stopProd(x.d, false)).toBe(1)
    expect(x.kills()).toBe(0)
    expect(await stopProd(x.d, true)).toBe(0)
    expect(x.kills()).toBe(1)
    const y = deps(null)
    expect(await stopProd(y.d, false)).toBe(1)
    expect(y.kills()).toBe(0)
  })
  it('agreed but still up: not forced, nothing killed', async () => {
    const x = deps({ status: 200, body: { left: true } }, false)
    expect(await stopProd(x.d, false)).toBe(1)
    expect(x.kills()).toBe(0)
  })
})

describe('B-0254 (5): after any restart a cut turn is continued ONCE, under the guards', () => {
  const files = (name: string) => ({ bootFile: join(TMP, `c5-${name}-boot.json`), liveFile: join(TMP, `c5-${name}-live.json`) })
  const boot = async (name: string, o: { list?: SavedLive['conversations']; reason?: string; bootAgo?: number; scan?: { id: string; waiting?: boolean; auto?: boolean }[]; stopped?: boolean } = {}) => {
    const f = files(name)
    writeFileSync(f.bootFile, JSON.stringify({ bootAt: T0 - (o.bootAgo ?? 30 * 60_000) }))
    if (o.list) writeFileSync(f.liveFile, JSON.stringify({ savedAt: T0 - 5_000, reason: o.reason ?? 'new server code', conversations: o.list }))
    const calls: [string, Reopen][] = []
    const slept: number[] = []
    let scans = 0
    let since = 0
    let excluded: string[] = []
    const r = await restoreAtBoot({
      now: () => T0, pid: 7, ...f, reopen: async (id, x) => { calls.push([id, x]) }, sleep: async ms => { slept.push(ms) },
      stopped: () => !!o.stopped,
      ...(o.scan ? { scan: async (s: number, ex: Set<string>) => { scans++; since = s; excluded = [...ex]; return o.scan! } } : {}),
    })
    return { r, calls, slept, scans: () => scans, since: () => since, excluded: () => excluded }
  }

  it('a cut turn gets ONE cockpit message: marked, not the owner, the lost tasks named; a turn that was not cut gets none', async () => {
    const x = await boot('once', { list: [{ id: 'cut', cutOff: true, lost: ['local_bash "npm run verify"'] }, { id: 'idle', cutOff: false }] })
    expect(x.calls).toEqual([
      ['cut', { note: cutNote('new server code', true), lost: ['local_bash "npm run verify"'], say: 'continue', at: T0 }],
    ])
    expect(x.r.idle).toEqual(['idle'])                               // a plain idle chat is not respawned (B-0420)
    expect(x.r.continued).toEqual(['cut'])
    const m = continueMessage(T0, ['local_bash "npm run verify"'])
    expect(m.startsWith('[cockpit] ')).toBe(true)
    expect(m).toContain('This is not a new instruction from the owner')
    expect(m).toContain('Check git status for your uncommitted files')
    expect(m).toContain('- local_bash "npm run verify"')
    expect(m).toContain('continue where you stopped')
    // once per restart: the list is consumed, the next boot sends nothing
    const again = await restoreAtBoot({ now: () => T0 + 5 * 60_000, pid: 8, ...files('once'), reopen: async () => { throw new Error('reopened twice') } })
    expect(again.reopened).toEqual([])
  })
  it('a crash loop continues nothing and does not even scan', async () => {
    const x = await boot('loop', { list: [{ id: 'cut', cutOff: true }], bootAgo: 20_000, scan: [{ id: 'hard' }] })
    expect(x.calls).toEqual([])
    expect(x.scans()).toBe(0)
    expect(x.r.skipped).toMatch(/crash loop/)
  })
  it('a chat parked on the owner is reopened with its note and NOT continued; nor one whose cut turn was itself an auto-continue', async () => {
    const x = await boot('guards', { list: [{ id: 'asks', cutOff: true, waiting: true }, { id: 'auto', cutOff: true, auto: true }] })
    expect(x.calls.map(([id, c]) => [id, c.say, c.note])).toEqual([['asks', null, cutNote('new server code')], ['auto', null, cutNote('new server code')]])
    expect(x.r.continued).toEqual([])
  })
  it('under floor/STOP nothing is messaged: cut turns reopen with the say-continue note', async () => {
    const x = await boot('stop', { list: [{ id: 'cut', cutOff: true }, { id: 'bg', cutOff: false, lost: ['monitor "x"'] }], stopped: true })
    expect(x.calls.map(([id, c]) => [id, c.say])).toEqual([['cut', null], ['bg', null]])
    expect(x.calls[0][1].note).toBe(cutNote('new server code'))
  })
  it('the boot scan: finds hard-stop cuts the list does not hold, over the last 30 min, and continues them; staggered', async () => {
    const x = await boot('scan', { list: [{ id: 'saved', cutOff: true }], scan: [{ id: 'hard' }, { id: 'hard-asks', waiting: true }, { id: 'hard-auto', auto: true }] })
    expect(x.since()).toBe(T0 - SCAN_WINDOW_MS)
    expect(x.excluded()).toEqual(['saved'])
    expect(x.r.scanned).toEqual(['hard', 'hard-asks', 'hard-auto'])
    expect(x.calls.map(([id, c]) => [id, c.say])).toEqual([['saved', 'continue'], ['hard', 'continue'], ['hard-asks', null], ['hard-auto', null]])
    expect(x.calls[1][1].note).toBe(cutNote(SCANNED, true))
    expect(x.r.continued).toEqual(['saved', 'hard'])
    expect(x.slept).toEqual([CONTINUE_GAP_MS])                       // the second continue waits; the first never does
  })
  it('a stale list is not reopened, but the scan still finds what the stop cut', async () => {
    const f = files('stale')
    writeFileSync(f.liveFile, JSON.stringify({ savedAt: T0 - 60 * 60_000, reason: JOURNAL, conversations: [{ id: 'old', cutOff: true }] }))
    const calls: string[] = []
    const r = await restoreAtBoot({ now: () => T0, pid: 1, ...f, reopen: async id => { calls.push(id) }, scan: async () => [{ id: 'old' }], sleep: async () => {} })
    expect(r.skipped).toMatch(/older than 10 minutes/)
    expect(calls).toEqual(['old'])
    expect(r.continued).toEqual(['old'])
  })
})
