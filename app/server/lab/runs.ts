import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chains, fpOf, pinCount, sameWindow, truncated, type Fingerprint, type PinCount } from './fingerprint.ts'
import { deskDir, labRel } from '../paths.ts'

/**
 * The lab reads the fund's run ledger exactly as app/loop/tools writes it (see _common.py):
 * `lab/<desk>/data/runs.jsonl`, one JSON object per line, keyed by (run, stage) where
 * stage is preflight | result | read. `preregistered: false` marks an IMPORTED row
 * (backfill.py): evidence, never a prediction. Fixed-age reads fall due at the RESULT's
 * `ts` + 7d / + 30d (remeasure.py `due_at`), and a read later than 4 days past due is
 * written `missed` by remeasure (its default --tolerance-days).
 */

export const AGES = { '7d': 7, '30d': 30 } as const
export type Age = keyof typeof AGES
export const TOLERANCE_DAYS = 4
const DAY = 86_400_000

export type Raw = Record<string, any>

export type ReadCell = {
  age: Age
  due: number | null           // ms; null when the run has no result yet
  state: 'done' | 'missed' | 'due' | 'late' | 'pending' | 'void' | 'none'
  row?: Raw                    // the read row, when one is written
  fp?: string | null           // the read's window digest (fingerprint.py), when it carries one
  match?: boolean | null       // the read's window against the run's: true = the same window; null = cannot tell
}

export type Run = {
  key: string                  // "<desk>#<run>"
  desk: string                 // fund-relative desk folder
  run: string
  kind: string | null          // exploit | explore | wild | import
  mechanic: string | null
  preregistered: boolean       // false = imported (backfill)
  predicted: Record<string, string>
  window: { from?: string; to?: string; hours?: number; regimes?: number; kind?: string } | null
  verify: { suite?: string; passed?: number | null; total?: number | null; none_because?: string } | null
  headline: string
  metrics: Record<string, number>
  ts: number | null            // the result's ts (ms), else the preflight's
  stage: 'preflight' | 'result'
  void: string | null
  reads: Record<Age, ReadCell>
  fingerprint: Fingerprint | null  // the result's window fingerprint; null on a legacy row
  fp: string | null            // its 8-hex digest
  trunc: boolean | null        // the store's head starts after the window's from; null = cannot tell
  pins: PinCount | null        // its inputs pinned (kept past eviction) of all; null = no fingerprint
  chain: string[]              // the other runs (keys) that read the same window: together ONE observation
  rows: Raw[]                  // every raw row for this run, file order
  bad: number                  // lines in the file that were not JSON objects
}

/** tolerant of shape (as _common.read_jsonl): blank and non-JSON lines are skipped and counted */
export function parseJsonl(text: string): { rows: Raw[]; bad: number } {
  const rows: Raw[] = []
  let bad = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const o = JSON.parse(s)
      if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o)
      else bad++
    } catch { bad++ }
  }
  return { rows, bad }
}

function iso(s: unknown): number | null {
  if (typeof s !== 'string' || !s) return null
  let t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00Z'
  else if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += 'Z'
  const n = Date.parse(t)
  return Number.isFinite(n) ? n : null
}

/** group one desk's rows into runs; result wins over preflight for the shown fields */
export function groupRuns(desk: string, rows: Raw[], now: number, bad = 0, pinned: ReadonlySet<string> | null = null): Run[] {
  const by = new Map<string, Raw[]>()
  for (const r of rows) {
    const id = r.run === undefined || r.run === null ? '' : String(r.run)
    if (!id) continue
    if (!by.has(id)) by.set(id, [])
    by.get(id)!.push(r)
  }
  const out: Run[] = []
  for (const [id, rs] of by) {
    const pre = rs.filter(r => r.stage === 'preflight').at(-1) ?? null
    const res = rs.filter(r => r.stage === 'result').at(-1) ?? null
    const reads = rs.filter(r => r.stage === 'read')
    const main = res ?? pre ?? rs[rs.length - 1]
    const resTs = res ? iso(res.ts) : null
    const isVoid = res && typeof res.void === 'string' ? res.void : null
    const fingerprint = fpOf(res)
    const cell = (age: Age): ReadCell => {
      const row = reads.filter(r => r.age === age).at(-1)
      const due = resTs === null ? null : resTs + AGES[age] * DAY
      if (row) {
        const rf = fpOf(row)
        return { age, due, state: row.state === 'missed' ? 'missed' : 'done', row, fp: rf?.digest ?? null, match: rf && fingerprint ? sameWindow(rf, fingerprint) : null }
      }
      if (due === null) return { age, due, state: 'none' }
      if (isVoid) return { age, due, state: 'void' }
      if (now < due) return { age, due, state: 'pending' }
      return { age, due, state: now - due > TOLERANCE_DAYS * DAY ? 'late' : 'due' }
    }
    out.push({
      key: `${desk}#${id}`,
      desk,
      run: id,
      kind: main.kind ?? pre?.kind ?? null,
      mechanic: main.mechanic ?? pre?.mechanic ?? null,
      preregistered: !(res?.preregistered === false || main.preregistered === false),
      predicted: (res?.predicted && Object.keys(res.predicted).length ? res.predicted : pre?.predicted) ?? {},
      window: main.window ?? pre?.window ?? null,
      verify: res?.verify ?? null,
      headline: String(res?.headline ?? ''),
      metrics: res?.metrics ?? {},
      ts: resTs ?? iso(pre?.ts),
      stage: res ? 'result' : 'preflight',
      void: isVoid,
      reads: { '7d': cell('7d'), '30d': cell('30d') },
      fingerprint,
      fp: fingerprint?.digest ?? null,
      trunc: truncated(fingerprint, (main.window ?? pre?.window)?.from, pinned),
      pins: pinCount(fingerprint, pinned),
      chain: [],
      rows: rs,
      bad,
    })
  }
  return out
}

/** every desk = a folder under lab/ holding a cadence.md */
export function allDesks(fundRoot: string): string[] {
  const base = join(fundRoot, labRel(fundRoot))   // platform/lab (the root's lab/ before 2026-09-25); ids stay lab/<name>
  const out: string[] = []
  // The desk's OWN machine folders are skipped only INSIDE a desk. _common.all_desks skips any
  // folder named `data` anywhere, which hid the old lab/api/data and every desk under it.
  const always = new Set(['.git', '__pycache__', 'node_modules'])
  const inDesk = new Set(['data', 'issues', 'levers', 'memory'])
  const walk = (dir: string, rel: string) => {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const isDesk = ents.some(e => e.isFile() && e.name === 'cadence.md')
    if (isDesk) out.push(rel)
    for (const e of ents) {
      if (!e.isDirectory() || always.has(e.name) || (isDesk && inDesk.has(e.name))) continue
      walk(join(dir, e.name), `${rel}/${e.name}`)
    }
  }
  walk(base, 'lab')
  return out.sort()
}

export type DeskRuns = { desk: string; hasFile: boolean; runs: Run[]; bad: number }

/** fill every run's `chain`: the runs, across all desks, whose window it shares */
export function linkChains(runs: Run[]): void {
  const m = chains(runs.map(r => ({ key: r.key, fp: r.fingerprint })))
  for (const r of runs) r.chain = m.get(r.key) ?? []
}

/** every desk's runs; `pinned` = the pin index's hashes (server/lab/pins.ts), null when not read */
export function loadAll(fundRoot: string, now = Date.now(), pinned: ReadonlySet<string> | null = null): DeskRuns[] {
  const all = loadDesks(fundRoot, now, pinned)
  linkChains(all.flatMap(d => d.runs))
  return all
}

function loadDesks(fundRoot: string, now: number, pinned: ReadonlySet<string> | null): DeskRuns[] {
  return allDesks(fundRoot).map(desk => {
    const f = join(deskDir(desk, fundRoot), 'data', 'runs.jsonl')
    if (!existsSync(f)) return { desk, hasFile: false, runs: [], bad: 0 }
    const { rows, bad } = parseJsonl(readFileSync(f, 'utf8'))
    return { desk, hasFile: true, runs: groupRuns(desk, rows, now, bad, pinned), bad }
  })
}

// ---- results-log.md: the entry for one run (ports of _common.strip_fences / entry_block) ----

/** blank every fenced block, preserving length and line count, so offsets map back */
export function stripFences(text: string): string {
  const out: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const s = line.trimStart()
    const marker = s.startsWith('```') ? '```' : s.startsWith('~~~') ? '~~~' : ''
    if (fence === null) {
      if (marker) { fence = marker; out.push(' '.repeat(line.length)) } else out.push(line)
      continue
    }
    out.push(' '.repeat(line.length))
    if (marker === fence) fence = null
  }
  return out.join('\n')
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** the `### <run> ...` block up to the next `### ` or EOF, sliced from the ORIGINAL text */
export function entryBlock(text: string, runId: string): string | null {
  const scan = stripFences(text)
  const m = new RegExp(`^###\\s+${esc(runId)}\\b.*$`, 'm').exec(scan)
  if (!m) return null
  const start = m.index
  const after = start + m[0].length
  const nxt = /^###\s+/m.exec(scan.slice(after))
  return nxt ? text.slice(start, after + nxt.index) : text.slice(start)
}

/** the `**Pre-flight:** ...` sentence inside an entry, joined onto one line */
export function preflightLine(entry: string | null): string | null {
  if (!entry) return null
  const m = /\*\*Pre-flight:\*\*([\s\S]+?)(?:\n\s*\n|\n\s*-\s*\*\*|\n\*\*|$)/.exec(entry)
  return m ? m[1].replace(/\s+/g, ' ').trim() : null
}
