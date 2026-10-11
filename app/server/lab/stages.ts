import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deskDir } from '../paths.ts'

/**
 * PROMOTION STAGES - one per desk mechanic, in `lab/<desk>/stages.json` (git-tracked, beside
 * mechanics.md). The ladder is idea -> tested -> paper -> live:
 *
 *   idea    named in mechanics.md, not yet run as a pre-registered experiment
 *   tested  has pre-registered runs with results behind it
 *   paper   running on paper (a forward read, no money)
 *   live    trading money. DISPLAY-ONLY here: the owner writes it into the file by hand, and the
 *           cockpit refuses to set it, clear it, or move a mechanic off it.
 *
 * A mechanic with no entry is UNSET - never shown as `idea` by default, because nobody said so.
 * The file carries no history (git log is the history); `since` is the day the current stage
 * was set, so a stale promotion is visible at a glance.
 */

export const STAGES = ['idea', 'tested', 'paper', 'live'] as const
export type Stage = typeof STAGES[number]
/** the stages the cockpit may write */
export const SETTABLE: readonly Stage[] = ['idea', 'tested', 'paper']

export type StageEntry = { stage: Stage; since?: string; note?: string }
export type StagesFile = { $format?: string; mechanics: Record<string, StageEntry> }
export type StagesRead = { file: string; exists: boolean; bad: string | null; mechanics: Record<string, StageEntry> }

export const FORMAT = 'promotion stage per mechanic of this desk: idea | tested | paper | live. '
  + 'Keys are mechanics.md row ids. live is written by the owner by hand; the cockpit never sets or clears it. '
  + 'since = the UTC day the current stage was set; git log is the history.'

export class StageRefused extends Error {}

const rel = (desk: string) => `${desk}/stages.json`

export function readStages(fundRoot: string, desk: string): StagesRead {
  const file = join(deskDir(desk, fundRoot), 'stages.json')
  if (!existsSync(file)) return { file: rel(desk), exists: false, bad: null, mechanics: {} }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const m = raw && typeof raw === 'object' && raw.mechanics && typeof raw.mechanics === 'object' ? raw.mechanics : null
    if (!m) return { file: rel(desk), exists: true, bad: 'no "mechanics" object', mechanics: {} }
    const out: Record<string, StageEntry> = {}
    const skipped: string[] = []
    for (const [k, v] of Object.entries<any>(m)) {
      if (v && typeof v === 'object' && (STAGES as readonly string[]).includes(v.stage)) out[k] = { stage: v.stage, since: v.since, note: v.note }
      else skipped.push(k)
    }
    return { file: rel(desk), exists: true, bad: skipped.length ? `unreadable stage for ${skipped.join(', ')}` : null, mechanics: out }
  } catch (e: any) {
    return { file: rel(desk), exists: true, bad: `not JSON: ${e?.message ?? e}`, mechanics: {} }
  }
}

const mnum = (k: string) => { const m = /^M(\d+)$/.exec(k); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER }

/** stable, reviewable bytes: keys in M-number order, 2-space indent, LF, trailing newline */
export function serialize(mechanics: Record<string, StageEntry>): string {
  const keys = Object.keys(mechanics).sort((a, b) => mnum(a) - mnum(b) || a.localeCompare(b))
  const body: StagesFile = { $format: FORMAT, mechanics: {} }
  for (const k of keys) {
    const e = mechanics[k]
    body.mechanics[k] = { stage: e.stage, ...(e.since ? { since: e.since } : {}), ...(e.note ? { note: e.note } : {}) }
  }
  return JSON.stringify(body, null, 2) + '\n'
}

/**
 * Set (or clear, with stage null) one mechanic's stage. Refuses: an unknown mechanic, a stage the
 * cockpit may not write (live), any change to a mechanic that is live, and a file it cannot read
 * (rewriting a file we could not parse would drop whatever was in it).
 */
export function setStage(fundRoot: string, desk: string, mechanic: string, stage: Stage | null, opts: { known: string[]; note?: string; today?: string }): StagesRead {
  if (!opts.known.includes(mechanic)) throw new StageRefused(`${mechanic} is not a row in ${desk}/mechanics.md`)
  if (stage !== null && !SETTABLE.includes(stage)) {
    throw new StageRefused(stage === 'live'
      ? `live is the owner's call: it is written into ${rel(desk)} by hand, never from the cockpit`
      : `stage must be one of ${SETTABLE.join(' | ')}`)
  }
  const cur = readStages(fundRoot, desk)
  if (cur.exists && cur.bad && cur.bad.startsWith('not JSON')) throw new StageRefused(`${rel(desk)} is ${cur.bad}; fix it by hand first`)
  if (cur.exists && cur.bad?.startsWith('no "mechanics"')) throw new StageRefused(`${rel(desk)} has ${cur.bad}; fix it by hand first`)
  if (cur.mechanics[mechanic]?.stage === 'live') throw new StageRefused(`${mechanic} is live: only the owner moves a live mechanic, by hand in ${rel(desk)}`)
  const next = { ...cur.mechanics }
  if (stage === null) delete next[mechanic]
  else {
    const same = next[mechanic]?.stage === stage
    next[mechanic] = { stage, since: same ? next[mechanic].since : (opts.today ?? new Date().toISOString().slice(0, 10)), note: (opts.note ?? (same ? next[mechanic].note : '') ?? '').trim() || undefined }
  }
  const file = join(deskDir(desk, fundRoot), 'stages.json')
  const tmp = file + '.tmp'
  writeFileSync(tmp, serialize(next), 'utf8')
  renameSync(tmp, file)
  return readStages(fundRoot, desk)
}
