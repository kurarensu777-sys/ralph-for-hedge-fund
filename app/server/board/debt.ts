import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ops, transaction, type Queryable } from '../db.ts'
import { dueReads } from '../lab/due.ts'
import { allDesks, loadAll, parseJsonl } from '../lab/runs.ts'
import { canonicalDesk, deskDir, deskRel } from '../paths.ts'
import { noLessonRows, readOr, retroStatus, type Lesson, type NoLesson } from '../loop/sources.ts'
import { createItem, type Item } from './store.ts'

/**
 * THE DEBT SCANNER: debt the tree already states about itself, shown on the board as SUGGESTIONS.
 *
 * A suggestion lives in the ops store (ops.board_suggested), never in app/board/, so auto-pickup can never
 * see one. Start turns it into a real item (backlog, from you, owner = the owning agent, no auto
 * label); Dismiss records its fingerprint forever (board_suggested_done), so it never returns while
 * its text is unchanged. Sources:
 *
 *   (a) file markers in CLAUDE.md / SUMMARY.md / HQ.md / board.md under the fund root:
 *       `Follow-up for <x>`, `Known, NOT fixed`, `Still open`, `still unscheduled`
 *   (b) the loop: retros due (retroStatus) and five no-lesson stand-downs in a row at one desk
 *   (c) the lab: fixed-age reads due or late (server/lab/due.ts, the lab room's own rule)
 *
 * The fingerprint is sha1(path + normalized marker text): it ignores the line number (an edit above
 * a marker does not resurrect a dismissed finding) and changes when the text does.
 */

export type Source = 'file' | 'loop' | 'lab'
export type DebtKind = 'follow-up' | 'not-fixed' | 'still-open' | 'unscheduled' | 'retro' | 'no-lesson' | 'read'

export type Finding = {
  fp: string
  source: Source
  kind: DebtKind
  path: string            // fund-relative file, or the desk for loop/lab findings
  line: number | null
  ref: string             // the chip: "HQ.md:27", "loop", "lab"
  quote: string           // the whole marker sentence (the chip's tooltip, the item's body)
  title: string           // one line
  owner: string | null    // a roster agent id
}

export type AgentLike = { id: string; cwd: string; writes: string[] }

export const SCAN_CAP = 2000
export const DEBT_FILES = new Set(['CLAUDE.md', 'SUMMARY.md', 'HQ.md', 'board.md'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist'])

/** a folder named `data` is RUNTIME data (skipped) when it sits under a lab desk or holds no debt
 * file; the platform's data PACKAGE (fundplat/data, its CLAUDE.md + SUMMARY.md) is scanned like any
 * other. Skipping every `data` hid that package's markers from the Board room (B-0085). */
export function isRuntimeData(name: string, rel: string, entries: string[]): boolean {
  if (name !== 'data') return false
  if (rel === 'lab' || rel.startsWith('lab/') || rel.includes('/lab/')) return true
  return !entries.some(n => DEBT_FILES.has(n))
}

// ---------- (a) markers ----------

type Marker = { kind: DebtKind; re: RegExp }
/** Follow-up takes a name (`Follow-up for \`data-engineer\`:`); the others are fixed phrases */
export const MARKERS: Marker[] = [
  { kind: 'follow-up', re: /\bfollow-ups? for\s+`?([A-Za-z0-9_:.\-]+)`?\s*:?/gi },
  { kind: 'not-fixed', re: /\bKnown, NOT fixed\b/g },
  { kind: 'still-open', re: /\bStill open\b/g },
  { kind: 'unscheduled', re: /\bstill unscheduled\b/gi },
]

export type Hit = { kind: DebtKind; line: number; quote: string; title: string; named: string | null }

const BACK = 220, FWD = 320
const clean = (s: string) => s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim()

/** the sentence around [a, b) on one line: back to the last ". " / "; " / bullet, on to the next */
function sentence(line: string, a: number, b: number): string {
  const lo = Math.max(0, a - BACK)
  const before = line.slice(lo, a)
  let s = lo
  const bound = /(?:[.;!?]\s+|^\s*[-*]\s+|\(\s*)/g
  for (const m of before.matchAll(bound)) s = lo + m.index! + m[0].length
  const after = line.slice(b, b + FWD)
  const e = /[.;](?:\s|$)/.exec(after)
  const end = e ? b + e.index : Math.min(line.length, b + FWD)
  return clean(line.slice(s, end)) + (end < line.length && !e ? ' ...' : '')
}

/** one line of title: the words AFTER the marker, or the sentence when the marker ends it */
function titleOf(quote: string, markerText: string): string {
  const i = quote.toLowerCase().indexOf(markerText.toLowerCase())
  let t = i >= 0 ? quote.slice(i + markerText.length) : quote
  t = t.replace(/^\s*\([^)]{0,60}\)/, '')                  // "(model, not verification):"
  t = t.replace(/^\s*,[^:]{0,40}:/, '')                     // ", stated in the notebook:"
  t = t.replace(/^[\s:,.-]+/, '')
  if (t.replace(/\W/g, '').length < 8) t = quote            // the marker ended the sentence
  t = t.replace(/`/g, '').replace(/\s+\.\.\.$/, '').trim()
  if ((t.match(/\)/g)?.length ?? 0) > (t.match(/\(/g)?.length ?? 0)) t = t.replace(/\)+$/, '').trim()   // "...automatically**)"
  if (t.length > 90) t = t.slice(0, 90).replace(/\s+\S*$/, '') + ' ...'
  return t ? t[0].toUpperCase() + t.slice(1) : markerText
}

/** every marker in a file's text, one per (line, marker) */
export function markersIn(text: string): Hit[] {
  const out: Hit[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  lines.forEach((line, n) => {
    for (const m of MARKERS) {
      m.re.lastIndex = 0
      for (const x of line.matchAll(m.re)) {
        const quote = sentence(line, x.index!, x.index! + x[0].length)
        out.push({ kind: m.kind, line: n + 1, quote, title: titleOf(quote, x[0]), named: m.kind === 'follow-up' ? x[1] : null })
      }
    }
  })
  return out
}

// ---------- owners ----------

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/^\/+/, '')

/**
 * Agent names the old code repo's docs still use (`Follow-up for data-engineer`): each is read as
 * the folder that role's code lives in TODAY (api/data -> fundplat/data, api/lib -> fundplat/quant,
 * app/ -> the terminal, api/execution -> the execution repo), and that folder's owner answers for it.
 */
export const LEGACY_AGENT_PATHS: Record<string, string> = {
  'data-engineer': 'platform/fundplat/data/',
  'quant-researcher': 'platform/fundplat/quant/',
  'dashboard-dev': 'platform/dashboards/terminal/',
  'research-analyst': 'platform/research/',
  'execution-engineer': 'execution/',
}

/** the agent whose `writes` cover the path (longest prefix), else whose cwd holds it (longest) */
export function ownerOfPath(path: string, agents: AgentLike[]): string | null {
  const p = norm(path)
  let best: { id: string; n: number } | null = null
  for (const a of agents) for (const w of a.writes) {
    const x = norm(w)
    if (!x) continue
    const hit = x.endsWith('/') ? (p + '/').startsWith(x) : p === x || p.startsWith(x + '/')
    if (hit && (!best || x.length > best.n)) best = { id: a.id, n: x.length }
  }
  if (best) return best.id
  let cw: { id: string; n: number } | null = null
  for (const a of agents) {
    const c = norm(a.cwd).replace(/\/$/, '')
    if (c === '' || p === c || p.startsWith(c + '/')) if (!cw || c.length > cw.n) cw = { id: a.id, n: c.length }
  }
  return cw?.id ?? null
}

/** a named agent wins (a roster id, or a legacy name mapped to its old folder); else the file's desk */
export function resolveOwner(named: string | null, path: string, agents: AgentLike[]): string | null {
  if (named) {
    const n = named.toLowerCase()
    const a = agents.find(x => x.id.toLowerCase() === n)
    if (a) return a.id
    const legacy = LEGACY_AGENT_PATHS[n]
    if (legacy) { const o = ownerOfPath(legacy, agents); if (o) return o }
  }
  return ownerOfPath(path, agents)
}

// ---------- fingerprint ----------

export const normalizeMarker = (s: string) => s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()
export const fingerprint = (path: string, text: string) => createHash('sha1').update(`${norm(path)}\n${normalizeMarker(text)}`).digest('hex')

// ---------- the walk ----------

export type Walk = { files: string[]; visited: number; capped: boolean }

/** fund-relative paths of every debt file, visiting at most `cap` files */
export function walkDebtFiles(root: string, cap = SCAN_CAP): Walk {
  const files: string[] = []
  let visited = 0, capped = false
  const walk = (dir: string, rel: string) => {
    if (capped) return
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of ents) {
      if (capped) return
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        if (e.name === 'data') {
          let inside: string[] = []
          try { inside = readdirSync(join(dir, e.name)) } catch { continue }
          if (isRuntimeData(e.name, rel, inside)) continue
        }
        walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name)
      } else if (e.isFile()) {
        if (++visited > cap) { capped = true; visited = cap; return }
        if (DEBT_FILES.has(e.name)) files.push(rel ? `${rel}/${e.name}` : e.name)
      }
    }
  }
  walk(root, '')
  return { files, visited, capped }
}

const base = (p: string) => p.split('/').pop() ?? p

export function fileFindings(root: string, agents: AgentLike[], cap = SCAN_CAP): { findings: Finding[]; walk: Walk } {
  const w = walkDebtFiles(root, cap)
  const found: Finding[] = []
  for (const f of w.files) {
    let text: string
    try { text = readFileSync(join(root, f), 'utf8') } catch { continue }
    for (const h of markersIn(text)) {
      found.push({
        fp: fingerprint(f, h.quote), source: 'file', kind: h.kind, path: f, line: h.line,
        ref: `${base(f)}:${h.line}`, quote: h.quote, title: h.title, owner: resolveOwner(h.named, f, agents),
      })
    }
  }
  // HQ.md is GENERATED from each package's SUMMARY.md: the same sentence in both is one debt, kept
  // at the SUMMARY (the file a fix edits). Same fingerprint twice in one file is one finding too.
  const byText = new Map<string, Finding>()
  for (const x of found) {
    const k = normalizeMarker(x.quote)
    const had = byText.get(k)
    if (!had || (base(had.path) === 'HQ.md' && base(x.path) !== 'HQ.md')) byText.set(k, x)
  }
  return { findings: [...byText.values()], walk: w }
}

// ---------- (b) the loop ----------

const DAY = 86_400_000
const deskKey = (d: string) => (d === '.' || d === '' ? '.' : canonicalDesk(d))

export function loopFindings(root: string, agents: AgentLike[], now: number, lessons: Pick<Lesson, 'ts' | 'desk'>[] | null, noLesson: NoLesson[] | null = null): Finding[] {
  const out: Finding[] = []
  for (const desk of allDesks(root)) {
    const beliefs = readOr(join(deskDir(desk, root), 'beliefs.md'))
    const runs = readOr(join(deskDir(desk, root), 'data', 'runs.jsonl'))
    const r = retroStatus(desk, beliefs, runs === null ? [] : parseJsonl(runs).rows, now)
    if (!r.due) continue
    const quote = `Retro due at ${desk}: ${r.reasons.join('; ')}`
    out.push({
      fp: fingerprint(`loop:${desk}`, `retro due since ${r.stamp.date ?? 'never'}`),
      source: 'loop', kind: 'retro', path: desk, line: null, ref: 'loop', quote,
      title: `Retro ${desk.replace(/^lab\//, '')}`, owner: ownerOfPath(deskRel(desk, root) + '/', agents),
    })
  }
  // five stand-downs with no lesson in a row at one desk, and no book landed there since the first
  // of them (lessons null = git could not answer: no finding rather than a guess)
  if (noLesson !== null && lessons !== null) {
    const byDesk = new Map<string, { ts: number; subject: string }[]>()
    for (const x of noLesson) {
      if (x.ts === null) continue
      const d = deskKey(x.desk)
      if (!byDesk.has(d)) byDesk.set(d, [])
      byDesk.get(d)!.push({ ts: x.ts, subject: x.subject })
    }
    for (const [desk, rows] of byDesk) {
      const lastBook = lessons.filter(l => deskKey(l.desk) === desk).reduce((m, l) => Math.max(m, l.ts), 0)
      const streak = rows.filter(x => x.ts > lastBook).sort((a, b) => a.ts - b.ts)
      if (streak.length < 5) continue
      const first = new Date(streak[0].ts).toISOString().slice(0, 10)
      const name = desk === '.' ? 'fund' : desk.replace(/^lab\//, '')
      out.push({
        fp: fingerprint(`loop:${desk}`, `no-lesson streak from ${new Date(streak[0].ts).toISOString()}`),
        source: 'loop', kind: 'no-lesson', path: desk, line: null, ref: 'loop',
        quote: `${streak.length} stand-downs with no lesson in a row at ${desk === '.' ? 'the fund root' : desk} since ${first}, no book landed there since. Latest: ${streak.at(-1)!.subject}`,
        title: `No lesson x${streak.length} ${name}`,
        owner: desk === '.' ? ownerOfPath('CLAUDE.md', agents) : ownerOfPath(deskRel(desk, root) + '/', agents),
      })
    }
  }
  return out
}

// ---------- (c) the lab ----------

export function labFindings(root: string, agents: AgentLike[], now: number): Finding[] {
  const runs = loadAll(root, now).flatMap(d => d.runs)
  return dueReads(runs).map(r => ({
    fp: fingerprint(`lab:${r.desk}`, `read ${r.run} ${r.age}`),
    source: 'lab' as const, kind: 'read' as const, path: r.desk, line: null, ref: 'lab',
    quote: `Read ${r.age} of run ${r.run} at ${r.desk} is ${r.state}${r.due ? ` (due ${new Date(r.due).toISOString().slice(0, 10)}, ${Math.max(0, Math.floor((now - r.due) / DAY))}d ago)` : ''}`,
    title: `Read ${r.run} +${r.age}${r.state === 'late' ? ' late' : ''}`,
    owner: ownerOfPath(r.desk + '/', agents),
  }))
}

// ---------- the scan ----------

export type ScanDeps = {
  root: string
  /** the no-lesson stand-downs (default: the ops store's no_lesson table); a throw = unknown (the rule
   *  is skipped, the error kept) */
  noLesson?: () => Promise<NoLesson[]>
  agents: AgentLike[]
  now?: number
  cap?: number
  /** book commits for the no-lesson rule; a throw or null = unknown (the rule is skipped, the error kept) */
  lessons?: (sinceMs: number) => Promise<Pick<Lesson, 'ts' | 'desk'>[] | null>
}

export type ScanResult = { findings: Finding[]; files: number; visited: number; capped: boolean; errors: string[]; ms: number }

export async function scan(d: ScanDeps): Promise<ScanResult> {
  const t0 = Date.now()
  const now = d.now ?? Date.now()
  const errors: string[] = []
  const guard = <T>(label: string, fn: () => T, dflt: T): T => { try { return fn() } catch (e: any) { errors.push(`${label}: ${String(e?.message ?? e)}`); return dflt } }
  const f = guard('files', () => fileFindings(d.root, d.agents, d.cap ?? SCAN_CAP), { findings: [], walk: { files: [], visited: 0, capped: false } })
  let lessons: Pick<Lesson, 'ts' | 'desk'>[] | null = null
  if (d.lessons) {
    try { lessons = await d.lessons(now - 180 * DAY) } catch (e: any) { errors.push(`lessons: ${String(e?.message ?? e)}`) }
    if (lessons === null && !errors.some(e => e.startsWith('lessons'))) errors.push('lessons: git gave no answer; the no-lesson rule was skipped')
  }
  let noLesson: NoLesson[] | null = null
  try { noLesson = await (d.noLesson ?? (async () => noLessonRows(await ops.listNoLesson({ limit: 5000 }))))() } catch (e: any) { errors.push(`no-lesson: ${String(e?.message ?? e)}`) }
  const loop = guard('loop', () => loopFindings(d.root, d.agents, now, lessons, noLesson), [])
  const lab = guard('lab', () => labFindings(d.root, d.agents, now), [])
  const seen = new Set<string>()
  const findings = [...f.findings, ...loop, ...lab].filter(x => (seen.has(x.fp) ? false : (seen.add(x.fp), true)))
  return { findings, files: f.walk.files.length, visited: f.walk.visited, capped: f.walk.capped, errors, ms: Date.now() - t0 }
}

// ---------- the store (the ops store: ops.board_suggested, board_suggested_done, board_scan) ----------

export type Suggested = Finding & { first_seen: number; last_seen: number }
export type ScanRow = { ts: number; files: number; visited: number; capped: boolean; errors: string[]; ms: number; found: number }

/** replace the current suggestions with this scan's findings (first_seen survives a rescan) */
export async function saveScan(r: ScanResult, at = Date.now(), q?: Queryable) {
  await transaction(async c => {
    await ops.syncBoardSuggestions(r.findings.map(x => ({ fp: x.fp, source: x.source, kind: x.kind, path: x.path, line: x.line, ref: x.ref, quote: x.quote,
      title: x.title, owner: x.owner })), { ts: at }, c)
    await ops.setBoardScan({ ts: at, files: r.files, visited: r.visited, capped: r.capped, errors_json: r.errors, ms: r.ms, found: r.findings.length }, c)
  }, q)
}

/** the open suggestions: scanned, never dismissed, never started */
export async function listSuggested(q?: Queryable): Promise<Suggested[]> {
  const rows = await ops.listOpenBoardSuggestions(q)
  return rows.map(r => ({ ...r, source: r.source as Suggested['source'], kind: r.kind as Suggested['kind'], line: r.line ?? null, owner: r.owner ?? null }))
}

export async function lastScan(q?: Queryable): Promise<ScanRow | null> {
  const r = await ops.getBoardScan(q)
  if (!r) return null
  // errors_json is jsonb (an array); anything else is said, never dropped
  const errors = Array.isArray(r.errors_json) ? r.errors_json.map(String) : ['errors_json unreadable']
  return { ts: r.ts, files: r.files, visited: r.visited, capped: !!r.capped, errors, ms: r.ms, found: r.found }
}

export class DebtError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function openOne(fp: string, q?: Queryable): Promise<Suggested> {
  if (!/^[0-9a-f]{40}$/.test(fp)) throw new DebtError(400, `not a fingerprint: ${fp}`)
  const done = await ops.get('board_suggested_done', fp, q)
  if (done) throw new DebtError(409, done.state === 'started' ? `already started as ${done.item}` : 'already dismissed')
  const s = (await listSuggested(q)).find(x => x.fp === fp)
  if (!s) throw new DebtError(404, 'no such suggestion (rescanned away?)')
  return s
}

/** forever: the fingerprint is recorded, so the same text never comes back */
export async function dismiss(fp: string, q?: Queryable): Promise<Suggested> {
  const s = await openOne(fp, q)
  await ops.markSuggestionDone(fp, 'dismissed', { item: null, title: s.title }, q)
  return s
}

export function bodyOf(s: Finding): string {
  const where = s.source === 'file' ? `${s.path}:${s.line}` : `${s.source}: ${s.path}`
  return `> ${s.quote.replace(/\n/g, '\n> ')}\n\n\`${where}\``
}

/** a real board item: backlog, from you, the owning agent, no auto label (so auto-pickup holds it) */
export async function start(fp: string, boardDir: string, q?: Queryable): Promise<{ item: Item; suggestion: Suggested }> {
  const s = await openOne(fp, q)
  const item = createItem(boardDir, { title: s.title, status: 'backlog', kind: 'todo', from: 'you', owner: s.owner ?? '', labels: [], body: bodyOf(s) })
  await ops.markSuggestionDone(fp, 'started', { item: item.id, title: s.title }, q)
  return { item, suggestion: s }
}
