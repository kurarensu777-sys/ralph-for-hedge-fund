import { useEffect } from 'react'
import { useApi } from '../../lib/api.ts'
import { HeatStrip } from '../../ui/kit.tsx'

// Health HISTORY: one cell per clock hour, the worst check pass inside it. Server: /api/dash/history
// (server/proc/history.ts). An hour with no pass is grey, never green.

export type RunState = 'ok' | 'warn' | 'fail' | 'off' | 'unknown'
/** `part` = the hour held a stop and serving runs: the whole cell a paler green */
export type CellState = RunState | 'part'
export type CellNote = { at: number; n: number; note: string }
export type DashHistory = {
  id: string; runs: number; up: number; measured: number; uptime: number | null; first: number | null
  counts: Record<RunState, number>; cells: (CellState | null)[]; notes?: (CellNote | null)[]; from: number; to: number; bucketMs: number
}
type HistoryResp = { hours: number; buckets: number; items: DashHistory[] }

export function useHistory() {
  const q = useApi<HistoryResp>('/api/dash/history', ['dash'])
  useEffect(() => { const t = setInterval(q.reload, 60_000); return () => clearInterval(t) }, [q.reload])
  return q
}

const WORD: Record<CellState, string> = { ok: 'ok', warn: 'warn', fail: 'fail', off: 'stopped', unknown: 'unknown', part: 'served part of the hour, stopped part' }
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)

export function summaryTitle(h: DashHistory, hours = 24): string {
  if (!h.runs) return `${hours}h: no check ran`
  const parts = (Object.keys(h.counts) as RunState[]).filter(k => h.counts[k]).map(k => `${WORD[k]} ${h.counts[k]}`)
  const up = h.uptime === null ? 'uptime unknown (no pass with a known state)' : `serving in ${h.up} of ${h.measured} passes since ${hhmm(h.first ?? h.from)}Z (${sampled(h)} sampled)`
  return `${hours}h: ${h.runs} check passes - ${parts.join(', ')}
${up}`
}

/** a cell's hover: the hour, its state, the run it draws and what was not ok in it */
export function cellTitle(h: DashHistory, i: number): string {
  const a = h.from + i * h.bucketMs
  const at = `${hhmm(a)}-${hhmm(a + h.bucketMs)}Z`
  const c = h.cells[i]
  const nt = h.notes?.[i]
  if (c === null) return `${at}  no check`
  const runs = nt ? ` · ${nt.n} pass${nt.n === 1 ? '' : 'es'}` : ''
  const when = nt ? `
${WORD[c]} at ${hhmm(nt.at)}Z` : ''
  return `${at}  ${WORD[c]}${runs}${when}${nt?.note ? `
${nt.note}` : ''}`
}

/** the 24h HEAT STRIP: one cell per clock hour, oldest left, the hour in progress right. Grey = no
 *  check in that hour (never green by default); a stopped hour is grey too, a shade lighter. */
export function Heat({ h, big = false }: { h: DashHistory; big?: boolean }) {
  return (
    <HeatStrip big={big} label={summaryTitle(h)} cells={h.cells.map((c, i) => ({ cls: `hc-${c ?? 'none'}`, title: cellTitle(h, i) }))} />
  )
}

/** how much of the window the passes cover: from the first pass to now (never the full 24h by default) */
export function sampled(h: DashHistory): string {
  const ms = h.to - (h.first ?? h.to)
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${Math.max(1, m)}m` : `${Math.round(m / 60)}h`
}

/** uptime from the same passes the strip draws (ok or warn = serving), read as "97% up"; unknown is a
 *  dim dash, never "0% up" */
export function Uptime({ h }: { h: DashHistory | undefined }) {
  if (!h) return <span className="nil" title="24h uptime: history not loaded" />
  if (h.uptime === null) return <span className="nil" title={`24h uptime: ${h.runs ? 'no pass with a known state' : 'no check ran in 24h'}`} />
  const pct = h.uptime * 100
  // floored, never rounded up: 99.6% is not "100%"
  const txt = pct === 100 ? '100%' : pct === 0 ? '0%' : pct >= 10 ? `${Math.floor(pct)}%` : `${(Math.floor(pct * 10) / 10).toFixed(1)}%`
  return <span className={`mono ${pct === 0 ? 'faint' : ''}`} title={`24h uptime
${summaryTitle(h)}`}>{txt}<span className="dash-upw"> up</span></span>
}
