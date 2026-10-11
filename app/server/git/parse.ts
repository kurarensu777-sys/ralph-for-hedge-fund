// Pure parsers for git output. No I/O here, so every rule is testable on a string.

export type Trailers = {
  agent: string | null
  conversation: string | null
  why: string | null
  changeId: string | null
  loopChange: string | null
  all: Record<string, string>
}

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):\s+(.*)$/

/**
 * The trailer block is the LAST paragraph of the body when every line in it is `Key: value`
 * (a continuation line starting with whitespace folds into the previous value). A last
 * paragraph with one prose line in it is prose, not trailers - that is git's own rule
 * tightened, so a sentence like "Note: ..." in the middle of a body never becomes a trailer.
 */
export function parseTrailers(body: string): Trailers {
  const out: Trailers = { agent: null, conversation: null, why: null, changeId: null, loopChange: null, all: {} }
  const paras = body.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/)
  const last = paras[paras.length - 1] ?? ''
  if (!last.trim()) return out
  const all: Record<string, string> = {}
  let prev: string | null = null
  for (const line of last.split('\n')) {
    if (/^\s+\S/.test(line) && prev) { all[prev] += ' ' + line.trim(); continue }
    const m = TRAILER.exec(line.trim())
    if (!m) return out
    prev = m[1]
    all[prev] = all[prev] !== undefined ? `${all[prev]}, ${m[2].trim()}` : m[2].trim()
  }
  const get = (k: string) => {
    const key = Object.keys(all).find(x => x.toLowerCase() === k)
    return key ? all[key] : null
  }
  out.all = all
  out.agent = get('agent')
  out.conversation = get('conversation')
  out.why = get('why')
  out.changeId = get('change-id')
  out.loopChange = get('loop-change')
  return out
}

export type LogEntry = {
  sha: string
  author: string
  ts: number            // ms
  subject: string
  body: string
  files: string[]
  trailers: Trailers
  /** the book shrink report (server/git/shrink.ts): null = touched no library book */
  shrink?: { files: { path: string; linesPct: number; sectionsPct: number; lostHeadings: string[]; renamedHeadings?: { from: string; to: string }[]; deleted: boolean }[]; worst: number | null; ok: boolean; reason: string | null } | null
}

/**
 * WHO made a commit, as the cockpit shows it: its Agent: trailer, else "you" (the owner). The git
 * author name is never read (every format below leaves that field empty), because every commit on
 * this machine carries the owner's real name and no real name may reach the UI.
 */
export const authorRole = (agent: string | null | undefined): string => (agent ?? '').split(',')[0].trim() || 'you'

/** the --format git log is called with; parseLog reads exactly this (the author field is left empty) */
export const LOG_FORMAT = '%x1e%H%x1f%x1f%at%x1f%s%x1f%b%x1f'

/** `git log --format=LOG_FORMAT --name-only` -> entries (files follow each record) */
export function parseLog(stdout: string): LogEntry[] {
  const out: LogEntry[] = []
  for (const rec of stdout.split('\x1e')) {
    if (!rec.trim()) continue
    const f = rec.split('\x1f')
    if (f.length < 6) continue
    const [sha, , at, subject, body, rest] = f
    const trailers = parseTrailers(body)
    out.push({
      sha: sha.trim(),
      author: authorRole(trailers.agent),
      ts: Number(at) * 1000,
      subject,
      body: body.trim(),
      files: rest.split('\n').map(s => s.trim()).filter(Boolean),
      trailers,
    })
  }
  return out
}

export type Porcelain = { dirty: number; conflicts: number; files: { xy: string; path: string }[] }

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** `git status --porcelain` (v1). Every line is a dirty path; unmerged XY codes are conflicts. */
export function parsePorcelain(stdout: string): Porcelain {
  const files = stdout.split('\n').filter(l => l.length > 3).map(l => ({ xy: l.slice(0, 2), path: l.slice(3).trim() }))
  return { dirty: files.length, conflicts: files.filter(f => UNMERGED.has(f.xy)).length, files }
}

/** `git rev-list --left-right --count @{u}...HEAD` -> left = upstream only (behind), right = ours (ahead) */
export function parseCounts(stdout: string): { behind: number; ahead: number } | null {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout)
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null
}

/** the one line of a failed git command worth showing: a CONFLICT line, else an error/fatal, else the last line */
export function causeLine(text: string): string {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean)
  return lines.find(l => l.startsWith('CONFLICT')) ?? lines.find(l => /^(error|fatal):/i.test(l)) ?? lines[lines.length - 1] ?? 'unknown failure'
}
