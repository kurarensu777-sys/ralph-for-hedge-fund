import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { spawn as ptySpawn, type IPty } from 'node-pty'
import { WebSocketServer, type WebSocket } from 'ws'
import { publish } from '../events.ts'
import { FUND_ROOT } from '../paths.ts'
import { agentEnv, prependPath } from './env.ts'
import { pathDirs } from './launch.ts'
import type { TerminalInfo } from './types.ts'

// TERMINALS (ported from machine/server/pty.ts). Real ptys owned by fundd - not by vite and not
// by the browser - so a UI reload or a closed tab leaves every shell running exactly where it was.
// The pane attaches over /ws/term/:id and gets the replay ring first. Output rides as BINARY
// frames; control (input, resize, exit, attached) is JSON text.
//
// The shell's env is scrubbed the same way an agent's is: a terminal can run `claude` or a
// script, and the credential boundary does not care who typed the command.

const BUFFER_CAP = 256 * 1024
const MAX_TERMINALS = 24

type Session = {
  id: string; agent: string | null; pty: IPty; cwd: string; title: string | null
  buffer: Buffer[]; bytes: number; exited: boolean; exitCode: number | null
  clients: Set<WebSocket>; createdAt: number
}
const SESSIONS = new Map<string, Session>()

const info = (s: Session): TerminalInfo => ({ id: s.id, agent: s.agent, cwd: s.cwd, title: s.title, alive: !s.exited, pid: s.pty.pid, createdAt: s.createdAt })
export const terminals = (): TerminalInfo[] => [...SESSIONS.values()].sort((a, b) => a.createdAt - b.createdAt).map(info)

const OSC_TITLE = /\x1b\][012];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
function sniff(s: Session, text: string) {
  let m: RegExpExecArray | null
  OSC_TITLE.lastIndex = 0
  while ((m = OSC_TITLE.exec(text))) {
    let t = m[1].trim().replace(/^[^:]+:\s*/, '').trim()
    // PowerShell announces its own full path; a lone path to an executable is that executable
    if (t && !/\s/.test(t) && /[\\/]/.test(t)) t = (t.split(/[\\/]/).pop() ?? t).replace(/\.exe$/i, '')
    if ((t || null) !== s.title) { s.title = t || null; publish('chat', { terminal: s.id }) }
  }
}

const pendingOut = new Map<string, Buffer[]>()
function emit(s: Session, chunk: Buffer) {
  s.buffer.push(chunk)
  s.bytes += chunk.byteLength
  while (s.bytes > BUFFER_CAP && s.buffer.length) s.bytes -= s.buffer.shift()!.byteLength
  sniff(s, chunk.toString('utf8'))
  let q = pendingOut.get(s.id)
  if (!q) {
    pendingOut.set(s.id, (q = []))
    setTimeout(() => {
      const out = pendingOut.get(s.id)
      pendingOut.delete(s.id)
      if (!out?.length) return
      const buf = Buffer.concat(out)
      for (const c of s.clients) { try { c.send(buf, { binary: true }) } catch { s.clients.delete(c) } }
    }, 8)
  }
  q.push(chunk)
}
const control = (s: Session, msg: unknown) => { const l = JSON.stringify(msg); for (const c of s.clients) { try { c.send(l) } catch { s.clients.delete(c) } } }

export function openTerminal(o: { cwd?: string; agent?: string | null; cols?: number; rows?: number }): TerminalInfo {
  if (SESSIONS.size >= MAX_TERMINALS) throw new Error(`${MAX_TERMINALS} terminals is the cap - close one first`)
  const cwd = o.cwd && existsSync(o.cwd) ? o.cwd : FUND_ROOT
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
  const id = `t${randomUUID()}`
  const env = prependPath(agentEnv({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FUND_ROOT, ...(o.agent ? { FUND_AGENT: o.agent } : {}) }), pathDirs()) as Record<string, string>
  const pty = ptySpawn(shell, process.platform === 'win32' ? ['-NoLogo'] : ['-l'], {
    name: 'xterm-256color', cols: Math.max(20, o.cols ?? 100), rows: Math.max(5, o.rows ?? 30), cwd, env,
  })
  const s: Session = { id, agent: o.agent ?? null, pty, cwd, title: null, buffer: [], bytes: 0, exited: false, exitCode: null, clients: new Set(), createdAt: Date.now() }
  SESSIONS.set(id, s)
  pty.onData(d => emit(s, Buffer.from(d, 'utf8')))
  pty.onExit(({ exitCode }) => {
    s.exited = true
    s.exitCode = exitCode
    control(s, { type: 'exit', exitCode })
    publish('chat', { terminal: id, exited: true })
  })
  publish('chat', { terminal: id })
  return info(s)
}

export function killTerminal(id: string): boolean {
  const s = SESSIONS.get(id)
  if (!s) return false
  SESSIONS.delete(id)
  pendingOut.delete(id)
  try { if (!s.exited) s.pty.kill() } catch { /* already gone */ }
  for (const c of s.clients) { try { c.close() } catch { /* gone */ } }
  publish('chat', { terminal: id, closed: true })
  return true
}

export const killAllTerminals = () => { for (const id of [...SESSIONS.keys()]) killTerminal(id) }

const wss = new WebSocketServer({ noServer: true })

export function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, params: Record<string, string>) {
  const s = SESSIONS.get(params.id)
  wss.handleUpgrade(req, socket, head, ws => {
    if (!s) { try { ws.send(JSON.stringify({ type: 'error', message: 'no such terminal' })); ws.close() } catch { /* gone */ } return }
    const replay = new URL(req.url ?? '/', 'http://x').searchParams.get('replay') !== '0'
    s.clients.add(ws)
    try {
      ws.send(JSON.stringify({ type: 'attached', id: s.id, cols: s.pty.cols, rows: s.pty.rows, cwd: s.cwd }))
      if (replay && s.bytes) ws.send(Buffer.concat(s.buffer), { binary: true })
      if (s.exited) ws.send(JSON.stringify({ type: 'exit', exitCode: s.exitCode ?? 0 }))
    } catch { /* vanished mid-handshake */ }
    ws.on('message', (raw: any, isBinary: boolean) => {
      if (s.exited) return
      if (isBinary) { try { s.pty.write(raw.toString('utf8')) } catch { /* dead pty */ } return }
      let m: any
      try { m = JSON.parse(String(raw)) } catch { return }
      if (m?.type === 'input' && typeof m.data === 'string') { try { s.pty.write(m.data) } catch { /* dead */ } }
      else if (m?.type === 'resize') { try { s.pty.resize(Math.max(20, Math.floor(Number(m.cols) || 80)), Math.max(5, Math.floor(Number(m.rows) || 24))) } catch { /* dead */ } }
    })
    const drop = () => s.clients.delete(ws)
    ws.on('close', drop)
    ws.on('error', drop)
  })
}
