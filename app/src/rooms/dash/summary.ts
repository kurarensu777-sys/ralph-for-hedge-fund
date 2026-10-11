import type { DashSummaryView, SummaryEntry } from '../../../shared/types.ts'

// THE LIVE SUMMARY CARD, what one card says: pure, so the rule is testable without a page.
// Server: server/rooms/dash.ts summaryView() (the reading) + server/proc/summary.ts (the contract).

export type Tile = { label: string; value: string; tag: string | null; hint: string }
export type CardModel = {
  /** the dot: the dashboard's own health word while the card is current, unknown when it could not be
   *  read, off (grey) when it publishes none or is stopped */
  dot: 'ok' | 'warn' | 'fail' | 'unknown' | 'off'
  /** the one line under the name: the as-of, or why there is nothing current to show */
  line: string
  /** the ISO as-of (tooltip), null when nothing current */
  asOf: number | null
  tiles: Tile[]
  /** tiles are what the card LAST said (port closed or a bad poll), shown faint and marked */
  stale: boolean
}

/** a value as served: a string verbatim, a number in full (never rounded here) */
export const showValue = (v: SummaryEntry['value']) => (typeof v === 'number' ? String(v) : v)

const tilesOf = (hl: SummaryEntry[]): Tile[] => hl.map(e => ({ label: e.label, value: showValue(e.value), tag: e.tag ?? null, hint: e.hint ?? '' }))

/** `ago(ms)`: "12s ago" / "4m ago" (the room builds it from relTime) */
export function cardModel(s: DashSummaryView, ago: (ms: number) => string): CardModel {
  if (s.state === 'none') return { dot: 'off', line: 'no summary published', asOf: null, tiles: [], stale: false }
  if (s.state === 'ok' && s.body) {
    return { dot: s.body.health, line: `as of ${ago(s.body.as_of_ms)}`, asOf: s.body.as_of_ms, tiles: tilesOf(s.body.headline), stale: false }
  }
  if (s.state === 'stopped') {
    // the port was measured closed: a known state (grey dot, no warning), not an unknown one
    if (s.last) return { dot: 'off', line: `stopped - last seen ${ago(s.last.readAt)}`, asOf: null, tiles: tilesOf(s.last.body.headline), stale: true }
    return { dot: 'off', line: 'stopped', asOf: null, tiles: [], stale: false }
  }
  const why = `unknown: ${s.reason ?? 'not read'}`
  if (s.last) return { dot: 'unknown', line: `${why} - last seen ${ago(s.last.readAt)}`, asOf: null, tiles: tilesOf(s.last.body.headline), stale: true }
  return { dot: 'unknown', line: why, asOf: null, tiles: [], stale: false }
}
