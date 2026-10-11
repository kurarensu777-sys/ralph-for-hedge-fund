import { useEffect, useRef, useState, type RefObject } from 'react'
import { Empty, Load } from '../../ui/kit.tsx'
import { useApi } from '../../lib/api.ts'

// ROOM: lab - predicted band vs measured, by run, for one desk and one metric (/api/lab/chart).

type Band = { raw: string; lo: number | null; hi: number | null; kind: 'band' | 'open' | 'count' }
type Point = {
  run: string; kind: string | null; preregistered: boolean; ts: number | null
  band: Band | null; measured: number | null; hit: boolean | null
  reads: { '7d': number | null; '30d': number | null }; void: boolean
}
type DeskChart = { desk: string; metrics: { id: string; predicted: number; measured: number }[]; metric: string | null; points: Point[] }

const fmt = (v: number) => Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(+v.toPrecision(4))

export function useWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function DeskChart({ desk, metric, onMetric }: { desk: string; metric: string; onMetric: (m: string) => void }) {
  const q = useApi<DeskChart>(`/api/lab/chart?desk=${encodeURIComponent(desk)}${metric ? `&metric=${encodeURIComponent(metric)}` : ''}`, ['lab'])
  return <div className="lab-chart">
    <Load q={q}>{c => <>
      <div className="lab-chart-head">
        <span className="cap">Results</span>
        {c.metrics.length > 0 && <select className="input lab-msel" value={c.metric ?? ''} onChange={e => onMetric(e.target.value)} title="metric">
          {c.metrics.map(m => <option key={m.id} value={m.id}>{m.id}{m.predicted ? ` - ${m.predicted} predicted` : ""}</option>)}
        </select>}
        <span className="lab-legend">
          <span title="the pre-registered band"><i className="lab-lg-band" />band</span>
          <span title="measured inside the band"><i className="lab-lg-dot hit" />hit</span>
          <span title="measured outside the band"><i className="lab-lg-dot miss" />miss</span>
          <span title="measured, no band to grade against"><i className="lab-lg-dot" />open</span>
          <span title="the +7d and +30d reads"><i className="lab-lg-read" />reads</span>
        </span>
      </div>
      {c.points.length === 0 ? <Empty>{c.metrics.length ? 'no run carries this metric' : 'no run of this desk has a prediction or a metric'}</Empty> : <Plot points={c.points} metric={c.metric ?? ''} />}
    </>}</Load>
  </div>
}

function Plot({ points, metric }: { points: Point[]; metric: string }) {
  const [ref, width] = useWidth()
  const H = 150, padL = 46, padR = 10, padT = 10, padB = 22
  const W = Math.max(width, 200)
  const vals: number[] = []
  for (const p of points) {
    if (p.measured !== null) vals.push(p.measured)
    for (const r of [p.reads['7d'], p.reads['30d']]) if (r !== null) vals.push(r)
    if (p.band?.lo != null) vals.push(p.band.lo)
    if (p.band?.hi != null) vals.push(p.band.hi)
  }
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (!vals.length) { lo = 0; hi = 1 }
  if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1 }
  const pad = (hi - lo) * 0.08
  lo -= pad; hi += pad
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB)
  const step = (W - padL - padR) / points.length
  const x = (i: number) => padL + step * (i + 0.5)
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad]
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor((W - padL - padR) / 34))))
  const zero = lo < 0 && hi > 0 ? y(0) : null
  const bw = Math.max(4, Math.min(14, step * 0.45))
  return <div ref={ref} className="lab-plot">
    {width > 0 && <svg width={W} height={H} role="img" aria-label={`${metric} predicted band vs measured by run`}>
      {ticks.map((t, i) => <g key={i}>
        <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="lab-grid" />
        <text x={padL - 6} y={y(t) + 3} className="lab-tick" textAnchor="end">{fmt(t)}</text>
      </g>)}
      {zero !== null && <line x1={padL} x2={W - padR} y1={zero} y2={zero} className="lab-zero" />}
      {points.map((p, i) => {
        const cx = x(i)
        const b = p.band
        const title = [
          `#${p.run}${p.kind ? ` ${p.kind}` : ''}${p.preregistered ? '' : ' (imported)'}${p.void ? ' VOID' : ''}`,
          b ? `band ${b.raw}` : 'no band',
          p.measured !== null ? `measured ${p.measured}${p.hit === null ? '' : p.hit ? ' - in band' : ' - outside band'}` : 'no result',
          p.reads['7d'] !== null ? `+7d ${p.reads['7d']}` : '',
          p.reads['30d'] !== null ? `+30d ${p.reads['30d']}` : '',
        ].filter(Boolean).join('\n')
        const top = b ? (b.hi !== null ? y(b.hi) : padT) : 0
        const bot = b ? (b.lo !== null ? y(b.lo) : H - padB) : 0
        return <g key={p.run} className={p.void ? 'lab-pvoid' : ''}>
          <title>{title}</title>
          <rect x={cx - step / 2} y={padT} width={step} height={H - padT - padB} className="lab-hit-area" />
          {b && <rect x={cx - bw / 2} y={Math.min(top, bot)} width={bw} height={Math.max(2, Math.abs(bot - top))} rx={2} className={`lab-bandr ${b.kind === 'open' ? 'open' : ''}`} />}
          {(['7d', '30d'] as const).map((a, k) => p.reads[a] !== null && <circle key={a} cx={cx + (k ? 5 : -5)} cy={y(p.reads[a]!)} r={2.6} className="lab-readm" />)}
          {p.measured !== null && <circle cx={cx} cy={y(p.measured)} r={3.6} className={`lab-meas ${p.hit === true ? 'hit' : p.hit === false ? 'miss' : ''}`} />}
          {i % labelEvery === 0 && <text x={cx} y={H - 6} className="lab-tick" textAnchor="middle">{p.run}</text>}
        </g>
      })}
    </svg>}
  </div>
}
