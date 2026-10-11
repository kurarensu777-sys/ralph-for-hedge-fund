import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deskDir } from '../paths.ts'

/**
 * What the pre-register form needs from one desk, read the way app/loop/tools/_common.py reads it:
 * mechanics = every `| M<n> |` row of mechanics.md (MECH_ROW), beliefs = every `### B<n>` heading
 * of beliefs.md (BELIEF_RE). The tool is the judge; this only fills the pickers, so a row the
 * parser here misses is still accepted or refused by preregister.py itself.
 */

export type Mechanic = { id: string; name: string; status: string }
export type Belief = { id: string; claim: string; placeholder: boolean }

const read = (p: string): string | null => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** the mechanics table: ID, name (column 2) and the Status cell (the last column) */
export function parseMechanics(text: string | null): Mechanic[] {
  if (!text) return []
  const out: Mechanic[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\|\s*(M\d+)\s*\|(.*)$/.exec(line)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    const cells = m[2].split('|').map(c => c.trim())
    if (cells.length && cells[cells.length - 1] === '') cells.pop()
    out.push({ id: m[1], name: (cells[0] ?? '').replace(/`/g, ''), status: (cells[cells.length - 1] ?? '').replace(/\*\*|`/g, '').trim() })
  }
  return out
}

export function parseBeliefs(text: string | null): Belief[] {
  if (!text) return []
  const out: Belief[] = []
  for (const m of text.matchAll(/^###\s+B(\d+)\s*(?:·|\|)?\s*(.*)$/gm)) {
    const claim = m[2].trim()
    out.push({ id: `B${m[1]}`, claim, placeholder: claim.startsWith('<') })
  }
  return out
}

/**
 * The desk's stage: the `**State: PRE-LIVE | OPENING | LIVE.**` line in the first 12 lines of
 * cadence.md, the rule of `desk_state` in app/loop/tools/_common.py. A line that still carries
 * several options reads PRE-LIVE (unfilled, not live); no file or no State line reads null (unknown).
 */
export function parseStage(text: string | null): string | null {
  if (!text) return null
  const m = /State:\s*([A-Z \-|]+)/.exec(text.split(/\r?\n/).slice(0, 12).join('\n'))
  if (!m) return null
  const opts = m[1].split('|').map(o => o.trim()).filter(Boolean)
  if (opts.length > 1) return 'PRE-LIVE'
  return opts[0] ?? null
}

/** the stage of the desk folder `deskAbs`, from its cadence.md */
export const readStage = (deskAbs: string): string | null => parseStage(read(join(deskAbs, 'cadence.md')))

/** the next run id after the desk's own: `008` -> `009`, `carry-014` -> `carry-015`; `001` for none */
export function nextRunId(ids: string[]): string {
  let best: { pre: string; n: number; w: number } | null = null
  for (const id of ids) {
    const m = /^(.*?)(\d+)$/.exec(id)
    if (!m) continue
    const n = Number(m[2])
    if (!best || n > best.n) best = { pre: m[1], n, w: m[2].length }
  }
  if (!best) return '001'
  return best.pre + String(best.n + 1).padStart(best.w, '0')
}

export function deskFacts(fundRoot: string, desk: string) {
  return {
    mechanics: parseMechanics(read(join(deskDir(desk, fundRoot), 'mechanics.md'))),
    beliefs: parseBeliefs(read(join(deskDir(desk, fundRoot), 'beliefs.md'))),
  }
}
