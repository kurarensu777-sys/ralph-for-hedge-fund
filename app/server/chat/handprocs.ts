import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { APP_ROOT } from '../paths.ts'

// THE HANDS AS PROCESSES (B-0420 parts 4 and 5). A hand is the claude binary the Agent SDK ships in
// THIS app's node_modules, started with `--input-format stream-json`; its MCP servers are its children.
// What the System room reports (open, GB held) and what the boot sweep kills (a hand whose parent is
// gone) both come from one process listing. The owner's own terminal sessions run the globally
// installed claude, never this path: they are listed, never touched.

export type Proc = { pid: number; ppid: number; name: string; rssB: number; cmd: string }

/** the SDK's claude binary folder in this app: a hand's command line starts with it */
export const SDK_DIR = join(APP_ROOT, 'node_modules', '@anthropic-ai')
const norm = (s: string) => s.replace(/^"/, '').replace(/\\/g, '/').toLowerCase()

/** tab-separated `pid ppid rss-bytes name command` per line (the command clipped, newlines gone) */
export function parseProcs(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split(/\r?\n/)) {
    const [pid, ppid, rss, name, ...cmd] = line.split('\t')
    const p = Number(pid), pp = Number(ppid), r = Number(rss)
    if (!Number.isInteger(p) || p <= 0 || !Number.isInteger(pp) || !name) continue
    out.push({ pid: p, ppid: pp, name, rssB: Number.isFinite(r) && r > 0 ? r : 0, cmd: cmd.join('\t') })
  }
  return out
}

const isClaude = (p: Proc) => /^claude(\.exe)?$/i.test(p.name)
/** the owner's own claude CLI: the lower-case binary (the desktop app is Claude.exe, an Electron one with --type= helpers) */
const isTerminalClaude = (p: Proc) => /^claude(\.exe)?$/.test(p.name) && !/--type=/.test(p.cmd)

/** one of THIS app's hands: the SDK's claude binary, in stream-json mode */
export function isHand(p: Proc, sdkDir = SDK_DIR): boolean {
  if (!isClaude(p)) return false
  const c = norm(p.cmd)
  return c.startsWith(`${norm(sdkDir)}/claude-agent-sdk`) && c.includes('--input-format stream-json')
}

export type HandsReading = {
  /** hands whose parent is alive, with the memory of the hand and its children */
  hands: { pid: number; ppid: number; bytes: number }[]
  /** hands whose parent process is gone: nobody will ever close them */
  orphans: { pid: number; ppid: number; bytes: number }[]
  /** claude processes that are not hands (the owner's terminal sessions): counted, never touched */
  others: { pid: number; bytes: number }[]
  bytes: number
}

/** the hand's memory: its own working set plus every descendant's */
function treeBytes(root: Proc, kids: Map<number, Proc[]>): number {
  let sum = 0
  const seen = new Set<number>()
  const walk = (p: Proc) => { if (seen.has(p.pid)) return; seen.add(p.pid); sum += p.rssB; for (const k of kids.get(p.pid) ?? []) walk(k) }
  walk(root)
  return sum
}

export function readHands(procs: Proc[], sdkDir = SDK_DIR): HandsReading {
  const alive = new Set(procs.map(p => p.pid))
  const kids = new Map<number, Proc[]>()
  for (const p of procs) { const a = kids.get(p.ppid) ?? []; a.push(p); kids.set(p.ppid, a) }
  const out: HandsReading = { hands: [], orphans: [], others: [], bytes: 0 }
  for (const p of procs) {
    if (isHand(p, sdkDir)) {
      const h = { pid: p.pid, ppid: p.ppid, bytes: treeBytes(p, kids) }
      // a parent pid that is not in the listing is a parent that exited (pid 0 / 4 are the system itself: not a parent fundd could have been)
      if (p.ppid > 4 && !alive.has(p.ppid)) out.orphans.push(h)
      else out.hands.push(h)
      out.bytes += h.bytes
    } else if (isTerminalClaude(p)) out.others.push({ pid: p.pid, bytes: p.rssB })
  }
  return out
}

const PS_WIN = `Get-CimInstance Win32_Process | ForEach-Object { $c = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(500, $_.CommandLine.Length)) -replace '[\\r\\n\\t]', ' ' } else { '' }; ($_.ProcessId, $_.ParentProcessId, $_.WorkingSetSize, $_.Name, $c) -join [char]9 }`

/** every process, or null when the listing could not be read (unknown is not "none") */
export function listProcs(): Promise<Proc[] | null> {
  const [file, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_WIN]]
    : ['ps', ['-axo', 'pid=,ppid=,rss=,comm=,args=']]
  return new Promise(res => {
    execFile(file as string, args as string[], { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return res(null)
      const text = String(stdout)
      if (process.platform === 'win32') return res(parseProcs(text))
      // ps: whitespace columns, rss in KiB
      res(text.split('\n').flatMap(l => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l)
        return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), rssB: Number(m[3]) * 1024, name: m[4].split('/').pop()!, cmd: m[5] }] : []
      }))
    })
  })
}
