import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveLaunch, splitCmd } from '../server/proc/cmd.ts'
import { dashStatus, parseEvery, reconcilePort, resolveCheckPath, runCheck } from '../server/proc/health.ts'
import { startProcess, stopProcess, tailLines } from '../server/proc/manager.ts'
import { parseNetstatListener, pidOnPort, portOpen, waitPort } from '../server/proc/ports.ts'

describe('splitCmd', () => {
  it('splits on whitespace and keeps empty = values', () => {
    expect(splitCmd('.venv/Scripts/python.exe -m jupyterlab --no-browser --port 8890 --ServerApp.token= --ServerApp.root_dir=research'))
      .toEqual(['.venv/Scripts/python.exe', '-m', 'jupyterlab', '--no-browser', '--port', '8890', '--ServerApp.token=', '--ServerApp.root_dir=research'])
  })
  it('groups quotes and keeps backslashes literal', () => {
    expect(splitCmd(`node -e "console.log('a b')"  'x y' C:\\a\\b`)).toEqual(['node', '-e', "console.log('a b')", 'x y', 'C:\\a\\b'])
    expect(splitCmd('a "" b')).toEqual(['a', '', 'b'])
  })
  it('never interprets shell metacharacters', () => {
    expect(splitCmd('python -m fundplat.dashboards.terminal & del x | more > out')).toEqual(['python', '-m', 'fundplat.dashboards.terminal', '&', 'del', 'x', '|', 'more', '>', 'out'])
  })
  it('refuses an unterminated quote', () => {
    expect(() => splitCmd('a "b')).toThrow(/unterminated/)
  })
})

describe('resolveLaunch', () => {
  const root = process.platform === 'win32' ? 'C:\\fund' : '/fund'
  it('resolves a fund-relative exe and cwd', () => {
    const l = resolveLaunch('.venv/Scripts/python.exe -m fundplat.dashboards.terminal', 'platform', root)
    expect(l.exe).toBe(join(root, '.venv', 'Scripts', 'python.exe'))
    expect(l.cwd).toBe(join(root, 'platform'))
    expect(l.args).toEqual(['-m', 'fundplat.dashboards.terminal'])
  })
  it('keeps a bare program name for PATH lookup', () => {
    expect(resolveLaunch('node server.js', '.', root).exe).toBe('node')
  })
  it('refuses escapes, absolute paths and batch files', () => {
    expect(() => resolveLaunch('../evil/x.exe', '.', root)).toThrow(/escapes/)
    expect(() => resolveLaunch('node x', '..', root)).toThrow(/escapes/)
    expect(() => resolveLaunch('node x', root, root)).toThrow(/fund-relative/)
    expect(() => resolveLaunch('start.bat', '.', root)).toThrow(/batch/)
    expect(() => resolveLaunch('tools/run.cmd', '.', root)).toThrow(/batch/)
  })
})

describe('dashStatus (the rule)', () => {
  it('port closed is stopped, never failing', () => {
    expect(dashStatus(false, ['fail', 'fail']).state).toBe('stopped')
  })
  it('port up: fail > warn > running', () => {
    expect(dashStatus(true, ['ok', 'fail', 'warn']).state).toBe('failing')
    expect(dashStatus(true, ['ok', 'warn']).state).toBe('stale')
    expect(dashStatus(true, ['ok', 'ok']).state).toBe('running')
    expect(dashStatus(true, ['ok'], true).state).toBe('dev')
  })
  it('unmeasured checks are reported, not called healthy', () => {
    expect(dashStatus(true, ['ok', 'unknown'])).toEqual({ state: 'running', measured: false })
    expect(dashStatus(true, ['ok']).measured).toBe(true)
  })
  it('parses every', () => {
    expect(parseEvery('5m')).toBe(300_000)
    expect(parseEvery('1h')).toBe(3_600_000)
    expect(parseEvery(undefined)).toBe(900_000)
    expect(parseEvery('junk')).toBe(900_000)
  })
})

describe('netstat parser', () => {
  const text = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1220
  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       40112
  TCP    127.0.0.1:8787         127.0.0.1:50122        ESTABLISHED     40112
  TCP    127.0.0.1:50122        127.0.0.1:8787         ESTABLISHED     9001
  TCP    [::]:4689              [::]:0                 LISTENING       777
`
  it('finds the listener pid', () => {
    expect(parseNetstatListener(text, 8787)).toBe(40112)
    expect(parseNetstatListener(text, 4689)).toBe(777)
    expect(parseNetstatListener(text, 50122)).toBeNull()
    expect(parseNetstatListener(text, 9999)).toBeNull()
  })
})

// ---- live checks against a throwaway local server (never :8787 / :8890) ----
let srv: Server
let port = 0
let dir = ''
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dash-test-'))
  srv = createServer((req, res) => {
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 3000)
    res.writeHead(req.url === '/ok' ? 200 : 503).end('x')
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()))
  port = (srv.address() as any).port
})
afterAll(() => { srv?.close(); rmSync(dir, { recursive: true, force: true }) })

describe('health checks', () => {
  it('a port check is not ok while the api on that port fails (a foreign listener)', () => {
    const checks = [{ id: 'port', check: 'port' as const, port: 8791 }, { id: 'api', check: 'http' as const, url: 'http://127.0.0.1:8791/api/health' }]
    const out = reconcilePort(checks, [{ status: 'ok', reading: ':8791 open' }, { status: 'fail', reading: '404 3ms' }])
    expect(out[0]).toMatchObject({ status: 'warn', reading: ':8791 open, but api fails (404 3ms)' })
    expect(out[1].status).toBe('fail')
    expect(reconcilePort(checks, [{ status: 'ok', reading: ':8791 open' }, { status: 'ok', reading: '200' }])[0].status).toBe('ok')
    const other = [{ id: 'port', check: 'port' as const, port: 8791 }, { id: 'api', check: 'http' as const, url: 'http://127.0.0.1:9999/x' }]
    expect(reconcilePort(other, [{ status: 'ok', reading: ':8791 open' }, { status: 'fail', reading: 'x' }])[0].status).toBe('ok')
  })
  it('port: open and closed', async () => {
    expect((await runCheck({ id: 'p', check: 'port', port }, { fundRoot: dir })).status).toBe('ok')
    const closed = await runCheck({ id: 'p', check: 'port', port: 47391 }, { fundRoot: dir })
    expect(closed.status).toBe('fail')
  })
  it('http: 2xx ok, 5xx fail, timeout fail', async () => {
    expect((await runCheck({ id: 'h', check: 'http', url: `http://127.0.0.1:${port}/ok` }, { fundRoot: dir })).status).toBe('ok')
    const bad = await runCheck({ id: 'h', check: 'http', url: `http://127.0.0.1:${port}/bad` }, { fundRoot: dir })
    expect(bad).toMatchObject({ status: 'fail' })
    expect(bad.reading).toMatch(/^503/)
    const slow = await runCheck({ id: 'h', check: 'http', url: `http://127.0.0.1:${port}/slow` }, { fundRoot: dir, httpTimeoutMs: 300 })
    expect(slow).toMatchObject({ status: 'fail', reading: 'timeout' })
    const refused = await runCheck({ id: 'h', check: 'http', url: 'http://127.0.0.1:47392/' }, { fundRoot: dir })
    expect(refused.status).toBe('fail')
  })
  it('exists: present, missing, escape', async () => {
    writeFileSync(join(dir, 'a.txt'), 'x')
    expect((await runCheck({ id: 'e', check: 'exists', path: 'a.txt' }, { fundRoot: dir })).status).toBe('ok')
    expect((await runCheck({ id: 'e', check: 'exists', path: 'nope.txt' }, { fundRoot: dir })).status).toBe('fail')
    expect((await runCheck({ id: 'e', check: 'exists', path: '../../etc' }, { fundRoot: dir })).reading).toMatch(/escapes/)
  })
  it('file_age: newest file under a tree, ~ = home; ok inside max_h, warn when older', async () => {
    const home = join(dir, 'home')
    mkdirSync(join(home, 'data', 'deep'), { recursive: true })
    const oldF = join(home, 'data', 'old.json')
    const newF = join(home, 'data', 'deep', 'new.json')
    writeFileSync(oldF, '1'); writeFileSync(newF, '2')
    const now = Date.now()
    utimesSync(oldF, (now - 500 * 3600e3) / 1000, (now - 500 * 3600e3) / 1000)
    utimesSync(newF, (now - 2 * 3600e3) / 1000, (now - 2 * 3600e3) / 1000)
    expect(resolveCheckPath('~/data', dir, home)).toBe(join(home, 'data'))
    const ok = await runCheck({ id: 'f', check: 'file_age', path: '~/data', max_h: 168 }, { fundRoot: dir, home, now })
    expect(ok).toMatchObject({ status: 'ok', reading: '2h old' })
    utimesSync(newF, (now - 200 * 3600e3) / 1000, (now - 200 * 3600e3) / 1000)
    const warn = await runCheck({ id: 'f', check: 'file_age', path: '~/data', max_h: 168 }, { fundRoot: dir, home, now })
    expect(warn.status).toBe('warn')
    expect((await runCheck({ id: 'f', check: 'file_age', path: '~/none', max_h: 1 }, { fundRoot: dir, home })).status).toBe('fail')
  })
})

describe('process manager (throwaway node server on a 47xxx port)', () => {
  const P = 47000 + Math.floor(Math.random() * 900)
  const script = `require('http').createServer((q,r)=>r.end('hi')).listen(${P},'127.0.0.1',()=>console.log('listening ${P}'))`
  it('starts detached, logs, adopts by port, stops the tree', async () => {
    writeFileSync(join(dir, 'srv.js'), script)
    expect(await portOpen(P)).toBe(false)
    const s = await startProcess({ key: 'test-srv', cmd: 'node srv.js', cwd: '.', port: P }, { fundRoot: dir, logDir: dir })
    expect(s.pid).toBeGreaterThan(0)
    expect(await waitPort(P, true, 10_000)).toBe(true)
    // adopt: the listener pid is found from the port alone
    expect(await pidOnPort(P)).toBe(s.pid)
    // starting again on a busy port is refused
    await expect(startProcess({ key: 'test-srv', cmd: 'node srv.js', cwd: '.', port: P }, { fundRoot: dir, logDir: dir })).rejects.toThrow(/port \d+ is held by pid \d+ \(.*node.*\); stop it first/)
    // stop with NO known pid: found through the port, as for an adopted server
    const r = await stopProcess(P, [], 10_000)
    expect(r.freed).toBe(true)
    expect(r.killed).toContain(s.pid)
    expect(await portOpen(P)).toBe(false)
    const log = tailLines(s.logPath, 500)!
    expect(log.lines.join('\n')).toContain(`listening ${P}`)
    expect(log.lines.some(l => l.startsWith('---- ') && l.includes('start node srv.js'))).toBe(true)
  }, 30_000)
  it('restart = stop then start once the port frees', async () => {
    const s1 = await startProcess({ key: 'test-srv', cmd: 'node srv.js', cwd: '.', port: P }, { fundRoot: dir, logDir: dir })
    expect(await waitPort(P, true, 10_000)).toBe(true)
    await stopProcess(P, [s1.pid], 10_000)
    const s2 = await startProcess({ key: 'test-srv', cmd: 'node srv.js', cwd: '.', port: P }, { fundRoot: dir, logDir: dir })
    expect(await waitPort(P, true, 10_000)).toBe(true)
    expect(s2.pid).not.toBe(s1.pid)
    expect((await stopProcess(P, [s2.pid], 10_000)).freed).toBe(true)
  }, 30_000)
  it('tail keeps the last n lines', () => {
    const f = join(dir, 'big.log')
    writeFileSync(f, Array.from({ length: 1200 }, (_, i) => `line ${i}`).join('\n') + '\n')
    const t = tailLines(f, 500)!
    expect(t.lines.length).toBe(500)
    expect(t.lines[0]).toBe('line 700')
    expect(t.lines[499]).toBe('line 1199')
    expect(tailLines(join(dir, 'none.log'))).toBeNull()
  })
})
