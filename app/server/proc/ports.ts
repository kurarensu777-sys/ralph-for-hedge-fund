import { execFile } from 'node:child_process'
import { connect } from 'node:net'

/** TCP connect to host:port; true when something accepts within `timeoutMs` */
export function portOpen(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise(res => {
    const s = connect({ port, host })
    const done = (v: boolean) => { s.removeAllListeners(); s.destroy(); res(v) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** poll until the port is `open` (true) or closed (false); resolves whether it got there */
export async function waitPort(port: number, open: boolean, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const end = Date.now() + timeoutMs
  for (;;) {
    if ((await portOpen(port, '127.0.0.1', 500)) === open) return true
    if (Date.now() >= end) return false
    await new Promise(r => setTimeout(r, stepMs))
  }
}

function run(file: string, args: string[], timeoutMs = 8000): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      res({ code, out: String(stdout) + String(stderr) })
    })
  })
}

/**
 * Parse `netstat -ano -p TCP` output: the pid LISTENING on a local port (IPv4 or IPv6,
 * any bind address). Pure, so the parser is testable against captured text.
 */
export function parseNetstatListener(text: string, port: number): number | null {
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue
    if (cols[3].toUpperCase() !== 'LISTENING') continue
    const local = cols[1]
    const p = Number(local.slice(local.lastIndexOf(':') + 1))
    const pid = Number(cols[4])
    if (p === port && Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

/** the pid listening on a local TCP port, or null (Windows netstat; lsof elsewhere) */
export async function pidOnPort(port: number): Promise<number | null> {
  if (process.platform === 'win32') {
    const r = await run('netstat', ['-ano', '-p', 'TCP'])
    return parseNetstatListener(r.out, port)
  }
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  const pid = Number(r.out.trim().split(/\s+/)[0])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** a process's command line (Windows: CIM; elsewhere ps), or null when unreadable */
export async function pidCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const r = process.platform === 'win32'
    ? await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], 10000)
    : await run('ps', ['-o', 'args=', '-p', String(pid)])
  const s = r.out.trim()
  return r.code === 0 && s ? s : null
}

/** kill a process and its whole tree. Windows: taskkill /T /F. Resolves whether it ran clean. */
export async function killTree(pid: number): Promise<{ ok: boolean; out: string }> {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, out: `bad pid ${pid}` }
  if (process.platform === 'win32') {
    const r = await run('taskkill', ['/PID', String(pid), '/T', '/F'])
    return { ok: r.code === 0, out: r.out.trim() }
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch (e: any) { return { ok: false, out: String(e.message) } } }
  return { ok: true, out: '' }
}

/** is this pid alive? */
export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

const startCache = new Map<number, number | null>()
/** process start time (ms) for an adopted pid, cached per pid; null when unreadable */
export async function pidStartTime(pid: number): Promise<number | null> {
  if (startCache.has(pid)) return startCache.get(pid)!
  let t: number | null = null
  if (process.platform === 'win32') {
    const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], 10000)
    const ms = Date.parse(r.out.trim())
    t = r.code === 0 && Number.isFinite(ms) ? ms : null
  }
  startCache.set(pid, t)
  return t
}
