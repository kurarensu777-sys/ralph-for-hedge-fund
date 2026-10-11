import { useEffect } from 'react'
import { useApi } from '../../lib/api.ts'
import { HeatStrip } from '../../ui/kit.tsx'

// The probes' 24h HEAT STRIP: one cell per clock hour, the hour in progress on the right. Server:
// /api/system/health/heat (server/system/heat.ts), from health_readings. The derived states stay
// as they are (a held verdict still carries `held`); every strip DRAWS four (the .heat kit in
// styles.css): ok green, fail red, missed amber (warn or stale), no reading grey (none or unknown).

export type HeatState = 'ok' | 'warn' | 'fail' | 'unknown' | 'stale' | 'none'
export type HeatCell = { s: HeatState; at: number | null; reading: string; n: number; seen: boolean }
export type HeatRow = { id: string; cells: HeatCell[] }
type HeatResp = { now: number; from: number; hours: number; items: HeatRow[] }

export function useHeat() {
  const q = useApi<HeatResp>('/api/system/health/heat', ['system', 'health'])
  useEffect(() => { const t = setInterval(q.reload, 120_000); return () => clearInterval(t) }, [q.reload])
  return q
}

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const WORD: Record<HeatState, string> = { ok: 'ok', warn: 'warn', fail: 'fail', unknown: 'unknown', stale: 'stale', none: 'no reading' }

export function heatTitle(c: HeatCell, hourStart: number): string {
  const at = `${hhmm(hourStart)}-${hhmm(hourStart + 3_600_000)}Z`
  if (c.s === 'none') return `${at}  no reading recorded`
  const when = c.at === null ? '' : c.seen
    ? `read ${hhmm(c.at)}Z${c.n > 1 ? ` (${c.n} readings, worst shown)` : ''}`
    : c.s === 'stale' ? `last read ${new Date(c.at).toISOString().slice(5, 16).replace('T', ' ')}Z, window ran out` : `held from ${new Date(c.at).toISOString().slice(5, 16).replace('T', ' ')}Z, inside its window`
  return `${at}  ${WORD[c.s]}\n${when}${c.reading ? `\n${c.reading}` : ''}`
}

/** `named`: every cell's tooltip starts with the probe's id (the ok card's lines carry no name) */
export function Heat({ row, from, named = false }: { row: HeatRow; from: number; named?: boolean }) {
  return (
    <HeatStrip label={`${row.id}: 24h`} cells={row.cells.map((c, i) => ({ cls: `hc-${c.s}${c.seen || c.s === 'none' || c.s === 'stale' ? '' : ' held'}`, title: `${named ? `${row.id}  ` : ''}${heatTitle(c, from + i * 3_600_000)}` }))} />
  )
}
