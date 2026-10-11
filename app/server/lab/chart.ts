import type { Run } from './runs.ts'

/**
 * Predicted band vs measured, by run, for one desk and one metric. The band grammar is
 * _common.parse_band's: `lo..hi` · `lo to hi` · `>= n` · `<= n` · an integer COUNT. A string that
 * is not a band returns null here (the tool would have refused it at registration, so a null
 * means the row came from somewhere else and is shown as "no band", never guessed at).
 */

export type Band = { raw: string; lo: number | null; hi: number | null; kind: 'band' | 'open' | 'count' }

const NUM = '[-+]?\\d+(?:\\.\\d+)?'
const BAND = new RegExp(`^\\s*(${NUM})\\s*(?:to|\\.\\.|-{1,2}>?|–)\\s*(${NUM})\\s*$`, 'i')
const OPEN = new RegExp(`^\\s*(>=|<=|>|<)\\s*(${NUM})\\s*$`)
const POINT = new RegExp(`^\\s*(${NUM})\\s*$`)

export function parseBand(raw: unknown): Band | null {
  const s = String(raw ?? '').trim()
  let m = BAND.exec(s)
  if (m) { const a = Number(m[1]), b = Number(m[2]); return { raw: s, lo: Math.min(a, b), hi: Math.max(a, b), kind: 'band' } }
  m = OPEN.exec(s)
  if (m) { const v = Number(m[2]); return { raw: s, lo: m[1].startsWith('>') ? v : null, hi: m[1].startsWith('<') ? v : null, kind: 'open' } }
  m = POINT.exec(s)
  if (m) { const v = Number(m[1]); return Number.isInteger(v) ? { raw: s, lo: v, hi: v, kind: 'count' } : null }
  return null
}

export function inBand(b: Band, v: number): boolean {
  return !(b.lo !== null && v < b.lo - 1e-12) && !(b.hi !== null && v > b.hi + 1e-12)
}

export type ChartPoint = {
  run: string
  kind: string | null
  preregistered: boolean
  ts: number | null
  band: Band | null
  measured: number | null
  hit: boolean | null            // null = nothing to grade (no band, or no result yet)
  reads: { '7d': number | null; '30d': number | null }
  void: boolean
}

export type DeskChart = { desk: string; metrics: { id: string; predicted: number; measured: number }[]; metric: string | null; points: ChartPoint[] }

const numOf = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null

export function deskChart(desk: string, runs: Run[], want?: string | null): DeskChart {
  const tally = new Map<string, { predicted: number; measured: number }>()
  const bump = (k: string, f: 'predicted' | 'measured') => { const t = tally.get(k) ?? { predicted: 0, measured: 0 }; t[f]++; tally.set(k, t) }
  for (const r of runs) {
    for (const k of Object.keys(r.predicted ?? {})) bump(k, 'predicted')
    for (const k of Object.keys(r.metrics ?? {})) bump(k, 'measured')
  }
  const metrics = [...tally].map(([id, t]) => ({ id, ...t }))
    .sort((a, b) => b.predicted - a.predicted || b.measured - a.measured || a.id.localeCompare(b.id))
  const metric = want && tally.has(want) ? want : metrics[0]?.id ?? null
  const ordered = [...runs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.run.localeCompare(b.run))
  const points: ChartPoint[] = metric === null ? [] : ordered
    .filter(r => metric in (r.predicted ?? {}) || metric in (r.metrics ?? {}) || ['7d', '30d'].some(a => numOf(r.reads[a as '7d'].row?.metrics?.[metric]) !== null))
    .map(r => {
      const band = metric in (r.predicted ?? {}) ? parseBand(r.predicted[metric]) : null
      const measured = numOf(r.metrics?.[metric])
      return {
        run: r.run, kind: r.kind, preregistered: r.preregistered, ts: r.ts, band, measured,
        hit: band && measured !== null ? inBand(band, measured) : null,
        reads: { '7d': numOf(r.reads['7d'].row?.metrics?.[metric]), '30d': numOf(r.reads['30d'].row?.metrics?.[metric]) },
        void: !!r.void,
      }
    })
  return { desk, metrics, metric, points }
}
