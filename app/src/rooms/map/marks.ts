import type { MapNode, MapState } from '../../../shared/map.ts'

// What a node's dot says (pure, tested in test/map.test.ts). The kit's dot states only: ok green,
// warn amber, fail red, off grey, unknown hollow, ask blue (the owner's). A registry or pipeline word
// that is not a health reading (planned, building, scaffold) is never painted as one: it gets the
// hollow dot and its word in the tooltip.

export type Mark = { s: 'ok' | 'warn' | 'fail' | 'off' | 'unknown' | 'run' | 'ask'; title: string }

/** the Dash room's reading of one dashboard (GET /api/dash items), the fields the map uses */
export type DashRow = { id: string; state: string; measured: boolean; port: number | null; since: number | null; health: { ok: number; total: number; failing: string[]; warning: string[] }; checks?: { id: string; status: string; reading: string }[] }

const WORD: Partial<Record<MapState, Mark['s']>> = { ok: 'ok', live: 'ok', warn: 'warn', fail: 'fail', off: 'off', archived: 'off', guarded: 'off', unknown: 'unknown', building: 'unknown', planned: 'unknown', human: 'ask' }

export function stateMark(n: Pick<MapNode, 'state' | 'why'>): Mark | null {
  if (!n.state) return null
  const s = WORD[n.state] ?? 'unknown'
  return { s, title: n.why && n.why !== n.state ? `${n.state}: ${n.why}` : n.state }
}

/** a dashboard's running mark from the Dash room's reading: unknown until it is read, and unknown
 *  (with why) when the read failed; never green by default */
export function runMark(id: string, rows: DashRow[] | null, err: string | null): Mark {
  if (!rows) return { s: 'unknown', title: err ? `running: unknown (${err})` : 'running: not read yet' }
  const d = rows.find(r => r.id === id)
  if (!d) return { s: 'unknown', title: 'running: the Dash room does not list it' }
  if (!d.measured) return { s: 'unknown', title: `${d.state}: not measured yet` }
  const fails = d.health.failing.length ? `\nfailing: ${d.health.failing.join(', ')}` : ''
  switch (d.state) {
    case 'running': case 'dev': return { s: 'ok', title: `running${d.state === 'dev' ? ' (dev)' : ''} · checks ${d.health.ok}/${d.health.total} ok` }
    case 'starting': return { s: 'run', title: 'starting' }
    case 'stale': return { s: 'warn', title: `stale · checks ${d.health.ok}/${d.health.total} ok${fails}` }
    case 'failing': return { s: 'fail', title: `failing · checks ${d.health.ok}/${d.health.total} ok${fails}` }
    case 'stopped': return { s: 'off', title: 'stopped' }
    default: return { s: 'unknown', title: d.state }
  }
}

/** the word a stage wears: the pipeline's own, upper case; a stage whose evidence is gone says so */
export const STAGE_WORD: Record<string, string> = {
  live: 'LIVE', human: 'HUMAN', scaffold: 'SCAFFOLD', missing: 'MISSING', external: 'EXTERNAL', fail: 'EVIDENCE GONE', unknown: 'UNKNOWN',
}
