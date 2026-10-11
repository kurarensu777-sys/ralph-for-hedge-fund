import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readSync, statSync, writeSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLaunch } from './cmd.ts'
import { killTree, pidAlive, pidCommandLine, pidOnPort, portOpen, waitPort } from './ports.ts'

/**
 * The process manager. Pure of the database: callers record rows. A process is keyed by the
 * dashboard id, or by `start.shared` when several dashboards ride one server. Started
 * DETACHED with its own log file, so it outlives a fundd restart; stopped by killing the
 * whole tree of both the pid we launched and the pid actually listening on the port (a venv
 * python.exe is a launcher whose child owns the socket).
 */
export type StartSpec = { key: string; cmd: string; cwd: string; port: number }
export type Started = { pid: number; exe: string; args: string[]; cwd: string; logPath: string; cmdLine: string }

export function logPathFor(logDir: string, key: string) {
  return join(logDir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.log`)
}

export async function startProcess(spec: StartSpec, opts: { fundRoot: string; logDir: string; env?: NodeJS.ProcessEnv; onExit?: (code: number | null) => void }): Promise<Started> {
  if (await portOpen(spec.port)) {
    // name the squatter: a dashboard that "cannot run" is most often a stray listener on its port
    const pid = await pidOnPort(spec.port)
    const cmd = pid ? await pidCommandLine(pid) : null
    throw new Error(`port ${spec.port} is held${pid ? ` by pid ${pid}` : ''}${cmd ? ` (${cmd.length > 160 ? cmd.slice(0, 157) + '...' : cmd})` : ''}; stop it first`)
  }
  const l = resolveLaunch(spec.cmd, spec.cwd, opts.fundRoot)
  if (/[\\/]/.test(l.exe) && !existsSync(l.exe)) throw new Error(`executable not found: ${l.exe}`)
  if (!existsSync(l.cwd)) throw new Error(`cwd not found: ${l.cwd}`)
  const logPath = logPathFor(opts.logDir, spec.key)
  const fd = openSync(logPath, 'a')
  writeSync(fd, `\n---- ${new Date().toISOString()} start ${spec.cmd} (cwd ${spec.cwd})\n`)
  try {
    const child = spawn(l.exe, l.args, {
      cwd: l.cwd,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', fd, fd],
      env: { ...(opts.env ?? process.env), PYTHONUNBUFFERED: '1' },
    })
    const pid = await new Promise<number>((res, rej) => {
      child.once('error', rej)
      child.once('spawn', () => res(child.pid!))
    })
    child.once('exit', code => opts.onExit?.(code))
    child.unref()
    return { pid, exe: l.exe, args: l.args, cwd: l.cwd, logPath, cmdLine: spec.cmd }
  } finally {
    closeSync(fd)
  }
}

/** kill `pids` (trees) plus whatever listens on `port`; wait for the port to free */
export async function stopProcess(port: number, pids: (number | null | undefined)[], timeoutMs = 15_000): Promise<{ killed: number[]; freed: boolean; notes: string[] }> {
  const listener = await pidOnPort(port)
  const targets = [...new Set([...pids, listener].filter((p): p is number => !!p && p !== process.pid))]
  const killed: number[] = []
  const notes: string[] = []
  for (const pid of targets) {
    if (!pidAlive(pid)) continue
    const r = await killTree(pid)
    if (r.ok) killed.push(pid)
    else notes.push(`pid ${pid}: ${r.out}`)
  }
  const freed = await waitPort(port, false, timeoutMs)
  return { killed, freed, notes }
}

/** the last `n` lines of a log file (reads at most the last 2 MB) */
export function tailLines(path: string, n = 500, maxBytes = 2 * 1024 * 1024): { lines: string[]; size: number; mtime: number } | null {
  if (!existsSync(path)) return null
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    const len = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, st.size - len)
    let lines = buf.toString('utf8').split(/\r?\n/)
    if (len < st.size) lines = lines.slice(1)
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    return { lines: lines.slice(-n), size: st.size, mtime: statSync(path).mtimeMs }
  } finally {
    closeSync(fd)
  }
}
