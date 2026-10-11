import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { EXACT_ID } from '../../shared/models.ts'
import { MAX_AUTO, MAX_AUTO_PER_DAY } from './auto.ts'

/**
 * The board's own setting, the owner's two switches in the Board room's head, kept in
 * app/board/config.json beside the items (the store reads B-NNNN.md only):
 *
 *   auto    Auto / Manual: does fundd start ready auto items on its own (server/board/auto.ts)?
 *           Manual holds every pickup; FUND_BOARD_AUTO=0 still turns pickup off for a test fundd.
 *   model   the model every conversation the board starts boots on (auto-pickup and the drawer's
 *   effort  Start), an EXACT id from Claude Code's permitted list; null = the owner agent's own
 *           roster model / effort.
 *   max     how many pickups may run at once (1 to MAX_AUTO_CEILING).
 *   perDay  how many pickups may start in one UTC day (1 to MAX_AUTO_PER_DAY_CEILING; absent = MAX_AUTO_PER_DAY).
 *
 * Until the file exists pickup is on and the agent's own model is used (what the board did before).
 */
export type BoardConfig = {
  auto: boolean
  model: string | null
  effort: string | null
  max: number             // pickups running at once
  perDay: number          // pickups started per UTC day
  source: string | null   // the file it came from; null = the defaults
}

/** the most the owner's box may ask for: the daily cap and the spend cap stay on top of it */
export const MAX_AUTO_CEILING = 8

/** the most pickups a day the setting may ask for: the spend cap and floor/STOP stay on top of it */
export const MAX_AUTO_PER_DAY_CEILING = 40

export const DEFAULTS: BoardConfig = { auto: true, model: null, effort: null, max: MAX_AUTO, perDay: MAX_AUTO_PER_DAY, source: null }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function parseConfig(raw: unknown, source: string | null): BoardConfig {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const model = str(o.model)
  return {
    auto: o.auto !== false,
    model: model && EXACT_ID.test(model) ? model : null,
    effort: str(o.effort),
    max: typeof o.max === 'number' && Number.isFinite(o.max) ? Math.min(MAX_AUTO_CEILING, Math.max(1, Math.round(o.max))) : MAX_AUTO,
    perDay: typeof o.perDay === 'number' && Number.isFinite(o.perDay) ? Math.min(MAX_AUTO_PER_DAY_CEILING, Math.max(1, Math.round(o.perDay))) : MAX_AUTO_PER_DAY,
    source,
  }
}

/** the `board` object of `file`; a missing or broken file = the defaults */
export function readConfig(file: string): BoardConfig {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    if (j && typeof j === 'object' && j.board && typeof j.board === 'object') return parseConfig(j.board, basename(file))
  } catch { /* missing: the defaults */ }
  return { ...DEFAULTS }
}

/** set any of auto / model / effort / max / perDay in `file`, every other key kept as it stands */
export function writeConfig(file: string, patch: Partial<Pick<BoardConfig, 'auto' | 'model' | 'effort' | 'max' | 'perDay'>>): void {
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${basename(file)} is not JSON: ${(e as Error).message}`)
  }
  const board = j.board && typeof j.board === 'object' ? j.board as Record<string, unknown> : {}
  j.board = { ...board, ...patch }
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
}
