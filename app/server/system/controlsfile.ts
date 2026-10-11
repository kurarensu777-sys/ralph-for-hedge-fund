import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

/**
 * The Controls view's own two settings, in app/controls.json (the rest of the page edits files that
 * already had a home: board/config.json, loop/config.json, the roster, floor/STOP):
 *
 *   wakes     does a dashboard turning failing start a chat with its agent (on_fail: wake_agent)? Off holds
 *             every wake; the dashboard.json is the platform's and is never written from here.
 *   tokenCap  the daily billable-token ceiling per agent, for an agent whose roster file writes none
 *             (spend.ts ceilings() `defaults.budgetTokensPerDay`, fed by config.ts agentsDoc());
 *             null = no ceiling, never an invented limit.
 *
 * No file = wakes on, no cap (what the fund did before the page). Pure file I/O: config.ts reads it,
 * so this module imports nothing of the app.
 */
export type ControlsFile = { wakes: boolean; tokenCap: number | null; source: string | null }

export const DEFAULTS: ControlsFile = { wakes: true, tokenCap: null, source: null }

export function parseControls(raw: unknown, source: string | null): ControlsFile {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const cap = typeof o.tokenCap === 'number' && Number.isFinite(o.tokenCap) && o.tokenCap > 0 ? Math.round(o.tokenCap) : null
  return { wakes: o.wakes !== false, tokenCap: cap, source }
}

export function readControls(file: string): ControlsFile {
  try { return parseControls(JSON.parse(readFileSync(file, 'utf8')), basename(file)) } catch { return { ...DEFAULTS } }
}

/** the roster as one document, with the page's cap as `defaults.budgetTokensPerDay`: spend.ts ceilings()
 *  gives it to every agent whose own header writes none, and an agent's own ceiling still wins */
export function docWithCap(headers: Record<string, unknown>[], cap: number | null): Record<string, unknown> {
  return { agents: headers, ...(cap ? { defaults: { budgetTokensPerDay: cap } } : {}) }
}

/** set wakes and / or tokenCap in `file`, every other key (the $comment) kept as it stands */
export function writeControls(file: string, patch: Partial<Pick<ControlsFile, 'wakes' | 'tokenCap'>>): void {
  let j: Record<string, unknown> = {}
  try { j = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${basename(file)} is not JSON: ${(e as Error).message}`)
  }
  writeFileSync(file, JSON.stringify({ ...j, ...patch }, null, 2) + '\n')
}
