import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AutoBuild, BuildGate, distStale, liveTell, reloadCheck, type BuildResult } from '../server/uibuild.ts'
import { IDLE_MS, shouldReload } from '../src/shell/uifresh.ts'

// B-0174 parts 1 and 3: Reload rebuilds a stale dist/ (one build at a time) and the status bar's
// landed-but-not-live tell. The build runner is injected: vite never runs here.

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** a scratch app: dist/index.html built at `built`, one UI source written at `src` (seconds) */
function scratch(built: number, src: number): string {
  const app = mkdtempSync(join(tmpdir(), 'uibuild-'))
  dirs.push(app)
  mkdirSync(join(app, 'dist'))
  mkdirSync(join(app, 'src', 'shell'), { recursive: true })
  writeFileSync(join(app, 'dist', 'index.html'), '<html></html>')
  writeFileSync(join(app, 'src', 'shell', 'Shell.tsx'), 'export {}')
  utimesSync(join(app, 'dist', 'index.html'), built, built)
  utimesSync(join(app, 'src', 'shell', 'Shell.tsx'), src, src)
  return app
}

const T = 1_790_000_000
const ok = (): BuildResult => ({ ok: true, ms: 5, out: '' })

describe('Reload rebuilds an out-of-date dist/', () => {
  it('a source newer than dist/ is stale, and the build runs', async () => {
    const app = scratch(T, T + 60)
    expect(distStale(app)).toMatch(/src\/shell\/Shell\.tsx is newer than dist/)
    const calls: string[] = []
    const gate = new BuildGate(async a => { calls.push(a); return ok() })
    const a = await reloadCheck(app, { serveDist: true, gate })
    expect(a).toMatchObject({ mode: 'dist', built: true })
    expect(a.stale).toMatch(/newer than dist/)
    expect(calls).toEqual([app])
  })

  it('a current dist/ builds nothing; no dist/ at all is stale', async () => {
    const app = scratch(T + 60, T)
    expect(distStale(app)).toBeNull()
    let n = 0
    const gate = new BuildGate(async () => { n++; return ok() })
    expect(await reloadCheck(app, { serveDist: true, gate })).toMatchObject({ built: false, stale: null })
    expect(n).toBe(0)
    rmSync(join(app, 'dist'), { recursive: true })
    expect(distStale(app)).toBe('no dist/')
  })

  it('dev (vite) answers that no build is needed, however stale dist/ is', async () => {
    const app = scratch(T, T + 60)
    let n = 0
    const gate = new BuildGate(async () => { n++; return ok() })
    expect(await reloadCheck(app, { serveDist: false, gate })).toEqual({ mode: 'dev', stale: null, built: false, ms: null })
    expect(n).toBe(0)
  })

  it('a failed build throws with vite\'s tail, and the page is not reloaded onto it', async () => {
    const app = scratch(T, T + 60)
    const gate = new BuildGate(async () => ({ ok: false, ms: 1, out: 'x\nerror TS1005: bad' }))
    await expect(reloadCheck(app, { serveDist: true, gate })).rejects.toThrow(/vite build failed: .*TS1005/)
  })
})

describe('one build at a time', () => {
  it('a second request while a build runs joins it; the next one after it builds again', async () => {
    let n = 0
    let release!: () => void
    const gate = new BuildGate(() => { n++; return new Promise<BuildResult>(r => { release = () => r(ok()) }) })
    const a = gate.run('app')
    const b = gate.run('app')
    expect(gate.busy).toBe(true)
    expect(n).toBe(1)
    release()
    expect(await a).toBe(await b)
    expect(gate.busy).toBe(false)
    const c = gate.run('app')
    expect(n).toBe(2)
    release()
    await c
  })

  it('a Reload that finds dist/ current while a build runs still waits for that build', async () => {
    const app = scratch(T + 60, T)
    let release!: () => void
    const gate = new BuildGate(() => new Promise<BuildResult>(r => { release = () => r(ok()) }))
    const first = gate.run(app)
    let done = false
    const second = reloadCheck(app, { serveDist: true, gate }).then(x => { done = true; return x })
    await Promise.resolve()
    expect(done).toBe(false)
    release()
    await first
    expect((await second).built).toBe(true)
  })
})

describe('the landed-but-not-live tell', () => {
  const base = { serveDist: true, started: 1000, dist: 1000, uiCommit: 500, serverCommit: 500 }
  it('fresh when dist/ and fundd are newer than their newest commits', () => {
    expect(liveTell(base)).toEqual({ uiStale: false, serverStale: false })
  })
  it('dist/ older than the newest UI commit is stale; fundd older than the newest server commit is stale', () => {
    expect(liveTell({ ...base, uiCommit: 2000 })).toEqual({ uiStale: true, serverStale: false })
    expect(liveTell({ ...base, serverCommit: 2000 })).toEqual({ uiStale: false, serverStale: true })
    expect(liveTell({ ...base, dist: null })).toMatchObject({ uiStale: true })
  })
  it('dev never marks the UI stale, and an unread commit time is no verdict', () => {
    expect(liveTell({ ...base, serveDist: false, uiCommit: 2000, dist: null }).uiStale).toBe(false)
    expect(liveTell({ ...base, uiCommit: null, serverCommit: null, dist: null })).toEqual({ uiStale: false, serverStale: false })
  })
})

describe('the auto build: a landed UI commit goes live with no click', () => {
  const make = (o: { serveDist?: boolean; commit: number | null; dist: number | null; ok?: boolean }) => {
    let runs = 0
    const logs: string[] = []
    let dist = o.dist
    const gate = new BuildGate(async () => { runs++; if (o.ok !== false) dist = 9_999; return { ok: o.ok !== false, ms: 5, out: o.ok === false ? 'boom' : '' } })
    const a = new AutoBuild({ serveDist: o.serveDist ?? true, app: 'x', gate, uiCommit: async () => o.commit, dist: () => dist, log: m => { logs.push(m) } })
    return { a, runs: () => runs, logs }
  }
  it('builds when dist/ is older than the newest UI commit, then reads current', async () => {
    const m = make({ commit: 2000, dist: 1000 })
    expect(await m.a.tick()).toBe('built')
    expect(m.runs()).toBe(1)
    expect(await m.a.tick()).toBe('current')
    expect(m.runs()).toBe(1)
  })
  it('builds nothing when current, in dev, or with an unread commit time', async () => {
    for (const [o, want] of [[{ commit: 500, dist: 1000 }, 'current'], [{ serveDist: false, commit: 2000, dist: 1000 }, 'dev'], [{ commit: null, dist: 1000 }, 'unread']] as const) {
      const m = make(o)
      expect(await m.a.tick()).toBe(want)
      expect(m.runs()).toBe(0)
    }
  })
  it('a failed build is not retried for the same commit, and says so', async () => {
    const m = make({ commit: 2000, dist: 1000, ok: false })
    expect(await m.a.tick()).toBe('failed')
    expect(await m.a.tick()).toBe('failed-before')
    expect(m.runs()).toBe(1)
    expect(m.logs[0]).toMatch(/failed .*boom/)
  })
})

describe('a tab reloads onto a newer build only when the owner is away', () => {
  const base = { loaded: 1000, dist: 2000, hidden: false, idleMs: 0 }
  it('a newer build reloads a hidden or idle tab, never one in use', () => {
    expect(shouldReload({ ...base, hidden: true })).toBe(true)
    expect(shouldReload({ ...base, idleMs: IDLE_MS })).toBe(true)
    expect(shouldReload(base)).toBe(false)
  })
  it('the same or an unread build never reloads', () => {
    expect(shouldReload({ ...base, dist: 1000, hidden: true })).toBe(false)
    expect(shouldReload({ ...base, loaded: null, hidden: true })).toBe(false)
    expect(shouldReload({ ...base, dist: null, hidden: true })).toBe(false)
  })
})
