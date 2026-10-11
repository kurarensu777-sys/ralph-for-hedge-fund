import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { LOOP_REL } from './proposals.ts'

/**
 * The loop's autonomy setting lives in the fund's configuration: a top-level `"loop"` object in
 * one of the configuration files (paths.ts CONFIG_FILES: app/loop/config.json, then app/schedule.json,
 * then repos.json; the first one carrying it wins; until 2026-09-25 it sat in the retired root
 * agents.json). Until one exists the loop proposes and measures but never applies by itself.
 */
export type LoopConfig = {
  autoApply: boolean       // AUTO: a pass applies what it may, SENDS the rest to the agent whose writes cover it, and reverts worse ones
  watchDays: number        // the watch window after an apply (and the baseline window before it)
  watchEvents: number      // ...or this many cohort turns after the apply, whichever comes first
  tolerance: number        // worse = the cohort score fell by more than this (absolute, 0..1)
  minEvents: number        // a window with fewer scored events (turns, grades, board outcomes) than this is no-signal
  noSignalExtends: number  // a due watch that reads no-signal is extended by another watchDays this many times, then closes VISIBLY unjudged
  unreadLedgerDays: number // "never read" is only claimed once the read ledger is this old
  source: string | null    // the file the setting came from (config.json); null = defaults
}

export const DEFAULTS: LoopConfig = { autoApply: false, watchDays: 7, watchEvents: 200, tolerance: 0.05, minEvents: 20, noSignalExtends: 1, unreadLedgerDays: 30, source: null }

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

export function parseConfig(raw: unknown, source: string | null): LoopConfig {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    autoApply: o.autoApply === true,
    watchDays: num(o.watchDays, DEFAULTS.watchDays, 1, 90),
    watchEvents: num(o.watchEvents, DEFAULTS.watchEvents, 10, 100_000),
    tolerance: num(o.tolerance, DEFAULTS.tolerance, 0, 1),
    minEvents: num(o.minEvents, DEFAULTS.minEvents, 1, 100_000),
    noSignalExtends: Math.round(num(o.noSignalExtends, DEFAULTS.noSignalExtends, 0, 12)),
    unreadLedgerDays: num(o.unreadLedgerDays, DEFAULTS.unreadLedgerDays, 1, 365),
    source,
  }
}

/** the first of `files` (absolute paths, in order) carrying a `loop` object; none = the defaults */
export function readConfig(files: string[]): LoopConfig {
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (j && typeof j === 'object' && j.loop && typeof j.loop === 'object') return parseConfig(j.loop, basename(f))
    } catch { /* a missing or broken file is another room's finding */ }
  }
  return { ...DEFAULTS }
}

/**
 * The owner's Auto / Manual switch (the Loop room's head): sets `loop.autoApply` in `file` (the
 * loop's own config.json), every other key kept as it stands. The loop engine never calls this:
 * only the owner's route does, which is why the file stays on the rails for the engine.
 */
export function setAutoApply(file: string, on: boolean): void {
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${basename(file)} is not JSON: ${(e as Error).message}`)
  }
  const loop = j.loop && typeof j.loop === 'object' ? j.loop as Record<string, unknown> : {}
  j.loop = { ...loop, autoApply: on }
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
}

// ---- the rails: what the loop may never write, whatever a proposal says ----

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')

/** is `p` (normalised, fund-relative) strictly inside one of `roots` (case-insensitive, like Windows)? */
const inside = (p: string, roots: string[]) => {
  const lower = p.toLowerCase()
  return roots.some(r => { const x = norm(r).replace(/\/+$/, '').toLowerCase(); return !!x && lower.startsWith(`${x}/`) })
}

/**
 * why the loop may not write this fund-relative path, or null when it may.
 *
 * `shelfRoots` = the REGISTERED shelf roots, fund-relative, as the Library room derives them
 * (server/shelves.ts shelfRoots / deriveShelves: every app/library/<x> - the one library). The
 * owner's call on B-0069 (2026-09-25, option b): a promote may land inside ANY registered shelf
 * root. Nothing else under app/, platform/ or database/ is ever writable. Left out, the machine's own shelves (`app/library/<x>/`) are the shelves.
 * Every other rail holds whatever the shelves say: never outside a shelf (or the loop's own
 * app/loop/records), never execution, never the law (app/library/law/*rails*, CLAUDE.md, .claude/),
 * never the roster (app/agents/), never the configuration (repos.json, app/schedule.json,
 * app/loop/config.json, a dashboard.json).
 */
export function railFor(path: string, shelfRoots?: string[]): string | null {
  const p = norm(path)
  const lower = p.toLowerCase()
  const owner = ownerRail(p)
  if (owner) return owner
  // the loop itself never writes execution; a proposal there goes to the agent whose writes cover it (ownerRail no longer refuses it, B-0453)
  if (/(^|\/)execution(\/|$)/.test(lower)) return 'execution is guarded'
  if (lower.startsWith('app/agents/') || lower === 'agents.json' || lower.startsWith('agents.json#')) return 'app/agents/: the loop never writes the roster'
  if (lower.startsWith(`${LOOP_REL}/`)) return null
  const inShelf = shelfRoots ? inside(p, shelfRoots) : /^app\/library\/[^/]+\/./.test(lower)
  if (/^(app|platform|database|research|repos)\//.test(lower)) {
    return inShelf ? null : "app/, platform/, database/: sub-repos are their agents' code (only a registered shelf root inside one is the loop's)"
  }
  if (inShelf) return null
  return `the loop writes only inside a registered shelf root and its own ${LOOP_REL}/ folder`
}

/**
 * The OWNER-ONLY rails: paths no agent is ever sent to change on the loop's behalf either (the law's
 * rails, execution, the fund's configuration, settings and the constitution chain). Everything else
 * the loop cannot write itself (the roster, a sub-repo's code) has an owner on the roster, and a pass
 * in auto mode sends the proposal to that agent (dispatch.ts); these stay with the owner.
 */
export function ownerRail(path: string): string | null {
  const p = norm(path)
  const lower = p.toLowerCase()
  if (!p || p.includes('..')) return 'path escapes the fund'
  if (/^(app\/library\/law|library\/fund)\/.*rails/.test(lower)) return 'app/library/law/*rails* is the law: owner only'
  if (/(^|\/)api\/execution(\/|$)/.test(lower)) return 'the old api/execution shim is guarded'
  if (['repos.json', 'app/schedule.json', 'schedule.json', 'app/loop/config.json'].includes(lower) || lower.endsWith('/dashboard.json')) return `${p}: the fund's configuration - the loop proposes, the owner edits`
  if (lower.startsWith('.claude/') || lower.includes('/.claude/') || lower.endsWith('claude.md')) return 'settings and the constitution chain are owner only'
  return null
}
