import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Empty, Glyph, Load } from '../../ui/kit.tsx'
import { stamp, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'

// THE CADENCE WALL (System > Schedule > Wall): owed vs actual per job, 7 days back + 1 ahead.
// Read-only: Run lives on the table. Data: GET /api/system/schedule/wall (server/system/wall.ts).

type Mark = { t: number; end: number | null; kind: 'run' | 'owed' | 'missed' | 'skipped'; status: string; row: number | null; manual?: boolean; detail?: string }
type Lane = { id: string; kind: 'job' | 'read'; desk: string; cadence: string; enabled: boolean; agent?: boolean; run?: string; windowS?: number; since?: number | null; marks: Mark[]; tally: Record<string, number>; error?: string }
type Wall = { now: number; from: number; to: number; days: number; since: number | null; found: boolean; errors: string[]; stopped: boolean; lanes: Lane[]; readsError: string | null }

const H = 3_600_000, DAY = 24 * H
const LABEL = 150, ROW = 18, GROUP = 20, AXIS = 22
const FILL: Record<string, string> = { ok: 'var(--ok)', fail: 'var(--fail)', unknown: 'var(--off)', running: 'var(--accent)' }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number) => String(n).padStart(2, '0')

type Tip = { x: number; y: number; lane: Lane; m: Mark }

/** the axis: day ticks when zoomed out, hour ticks when zoomed in. UTC, like every stamp in the
 *  cockpit (shared/time.ts), so the axis and the tooltip read one clock. Zoomed in with no
 *  midnight in view, the first hour tick carries its day. */
function ticks(v0: number, v1: number, w: number): { t: number; label: string; major: boolean }[] {
  const span = v1 - v0
  const out: { t: number; label: string; major: boolean }[] = []
  const day = (x: Date) => `${DOW[x.getUTCDay()]} ${x.getUTCDate()}`
  if (span > 2.5 * DAY) {
    for (let t = Math.floor(v0 / DAY) * DAY; t <= v1; t += DAY) if (t >= v0) out.push({ t, label: day(new Date(t)), major: true })
    return out
  }
  const pxPerH = w / (span / H)
  const step = [1, 2, 3, 6, 12].find(s => s * pxPerH >= 44) ?? 12
  for (let t = Math.floor(v0 / H) * H; t <= v1; t += H) {
    const x = new Date(t)
    if (t < v0 || x.getUTCHours() % step) continue
    const midnight = x.getUTCHours() === 0
    out.push({ t, label: midnight ? day(x) : `${pad(x.getUTCHours())}:00`, major: midnight })
  }
  if (out.length && !out.some(o => o.major)) {
    out[0] = { ...out[0], label: `${day(new Date(out[0].t))} ${out[0].label}` }
    if (out.length > 1 && step * pxPerH < 84) out.splice(1, 1)   // the wider first label needs the room
  }
  return out
}

export function WallView({ ownerOf, openJob }: { ownerOf: (desk: string) => string; openJob: (id: string) => void }) {
  const q = useApi<Wall>('/api/system/schedule/wall?days=7', ['system'])
  useEffect(() => { const t = setInterval(q.reload, 60_000); return () => clearInterval(t) }, [q.reload])
  return <Load q={q}>{w => {
    if (!w.found) return <Empty state="failed">{w.errors[0] ?? 'schedule.json is missing or not JSON'}</Empty>
    if (!w.lanes.some(l => l.marks.length)) return <Empty>no runs</Empty>
    return <WallBody w={w} ownerOf={ownerOf} openJob={openJob} />
  }}</Load>
}

type Row = { group: string; lanes: Lane[]; owner: string | null }

function WallBody({ w, ownerOf, openJob }: { w: Wall; ownerOf: (d: string) => string; openJob: (id: string) => void }) {
  const { go } = useNav()
  const box = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(900)
  const [view, setView] = useState<[number, number]>([w.from, w.to])
  const [tip, setTip] = useState<Tip | null>(null)
  const drag = useRef<{ x: number; v: [number, number]; moved: boolean } | null>(null)
  const plotW = Math.max(200, width - LABEL)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el); setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // wheel = zoom about the cursor, between the whole window and two hours (native: React's is passive)
  const vRef = useRef(view); vRef.current = view
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const [a, b] = vRef.current
      const r = el.getBoundingClientRect()
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      const at = a + f * (b - a)
      const span = Math.min(w.to - w.from, Math.max(2 * H, (b - a) * Math.exp(e.deltaY * 0.0015)))
      let n0 = at - f * span
      n0 = Math.max(w.from, Math.min(w.to - span, n0))
      setView([n0, n0 + span])
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [w.from, w.to])

  const [v0, v1] = view
  const x = (t: number) => ((t - v0) / (v1 - v0)) * plotW

  const rows: Row[] = useMemo(() => {
    const byOwner = new Map<string, Lane[]>()
    for (const l of w.lanes) {
      if (l.kind !== 'job') continue
      const o = ownerOf(l.desk)
      if (!byOwner.has(o)) byOwner.set(o, [])
      byOwner.get(o)!.push(l)
    }
    const out: Row[] = [...byOwner].sort((a, b) => a[0].localeCompare(b[0])).map(([o, lanes]) => ({ group: o, owner: o, lanes }))
    const reads = w.lanes.filter(l => l.kind === 'read')
    if (reads.length) out.push({ group: 'reads', owner: null, lanes: reads })
    return out
  }, [w.lanes, ownerOf])

  const height = AXIS + rows.reduce((s, r) => s + GROUP + r.lanes.length * ROW, 0) + 4
  const tk = ticks(v0, v1, plotW)

  const open = (l: Lane) => {
    if (drag.current?.moved) return
    if (l.kind === 'job') openJob(l.id)
    else go('lab')
  }

  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, v: view, moved: false } }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    // capture only once it is a drag, so a plain click still lands on its mark
    if (!d.moved && Math.abs(dx) > 3) { d.moved = true; (e.currentTarget as Element).setPointerCapture?.(e.pointerId) }
    if (!d.moved) return
    const span = d.v[1] - d.v[0]
    let n0 = d.v[0] - (dx / plotW) * span
    n0 = Math.max(w.from, Math.min(w.to - span, n0))
    setView([n0, n0 + span]); setTip(null)
  }
  const onUp = () => { setTimeout(() => { drag.current = null }, 0) }

  const hover = (e: React.MouseEvent, lane: Lane, m: Mark) => {
    if (drag.current?.moved) return
    const r = box.current!.getBoundingClientRect()
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, lane, m })
  }

  let y = AXIS
  const body: ReactNode[] = []
  const labels: ReactNode[] = []
  for (const g of rows) {
    labels.push(<div key={`g-${g.group}`} className="system-wl-g" style={{ height: GROUP }}>
      {g.owner ? <><Glyph id={g.owner} /><span>{g.owner}</span></> : <span>{g.group}</span>}
    </div>)
    body.push(<line key={`gl-${g.group}`} className="system-wl-sep" x1={0} x2={plotW} y1={y + 0.5} y2={y + 0.5} />)
    y += GROUP
    for (const l of g.lanes) {
      const cy = y + ROW / 2
      const t = l.tally
      const title = `${l.id}\n${l.cadence}${l.enabled ? '' : ' (off)'}\n${Object.entries(t).map(([k, n]) => `${n} ${k}`).join(' · ') || 'nothing in window'}`
      labels.push(<div key={`l-${l.id}`} className={`system-wl-l ${l.enabled ? '' : 'off'}`} style={{ height: ROW }} title={title} onClick={() => open(l)}>
        <span className="mono">{l.kind === 'read' ? l.id.split('/').pop() : l.id}</span>
        {(t.missed ?? 0) + (t.late ?? 0) + (t.fail ?? 0) > 0 && <i className="system-wl-bad">{(t.missed ?? 0) + (t.late ?? 0) + (t.fail ?? 0)}</i>}
      </div>)
      body.push(<rect key={`bg-${l.id}`} className="system-wl-lane" x={0} y={y} width={plotW} height={ROW} onClick={() => open(l)} />)
      // owed marks closer than 12px merge into one hollow band ("owed, every step"): an hourly
      // cadence at week zoom is a band, not a comb
      const items: { m: Mark; n: number; last: Mark }[] = []
      for (const m of l.marks) {
        const prev = items[items.length - 1]
        if (m.kind === 'owed' && prev && prev.m.kind === 'owed' && x(m.t) - x(prev.last.t) < 12) { prev.n++; prev.last = m; continue }
        items.push({ m, n: 1, last: m })
      }
      for (const [i, it] of items.entries()) {
        const m = it.n > 1 ? { ...it.m, detail: `${it.n} owed · to ${stamp(it.last.t)}` } : it.m
        const mx = x(m.t)
        const lx = x(it.last.t)
        if (lx < -40 || mx > plotW + 40) continue
        const k = `${l.id}-${i}`
        const ev = { onMouseEnter: (e: React.MouseEvent) => hover(e, l, m), onMouseMove: (e: React.MouseEvent) => hover(e, l, m), onMouseLeave: () => setTip(null), onClick: () => open(l) }
        if (m.kind === 'run') {
          const ex = m.end !== null ? x(m.end) : mx
          body.push(<rect key={k} {...ev} className={`system-wl-run ${m.status === 'running' ? 'pulse' : ''} ${m.manual ? 'manual' : ''}`} x={mx} y={cy - 5} width={Math.max(3, ex - mx)} height={10} rx={1.5} style={{ fill: FILL[m.status] ?? 'var(--fail)' }} />)
        } else if (m.kind === 'owed') {
          const next = items[i + 1]
          const cap = next ? Math.max(4, x(next.m.t) - lx - 3) : 22
          const ex = it.last.end !== null ? x(it.last.end) : lx + 6
          const w1 = Math.max(4, Math.min(ex - lx, 22, cap))
          body.push(<rect key={k} {...ev} className={`system-wl-owed ${m.t <= w.now ? 'open' : ''}`} x={mx + 0.5} y={cy - 4.5} width={lx - mx + w1} height={9} rx={1.5} />)
        } else {
          const bad = m.kind === 'missed'
          body.push(<g key={k} {...ev}>
            <rect className="system-wl-hit" x={mx - 3} y={cy - 7} width={6} height={14} />
            <line className={bad ? 'system-wl-miss' : 'system-wl-skip'} x1={mx} x2={mx} y1={cy - (bad ? 6 : 3.5)} y2={cy + (bad ? 6 : 3.5)} />
          </g>)
        }
      }
      y += ROW
    }
  }

  const nowX = x(w.now)
  const sinceX = w.since !== null ? x(w.since) : null

  return <div className="system-wall" ref={box}>
    <div className="system-wl-labels" style={{ width: LABEL, paddingTop: AXIS }}>{labels}</div>
    <svg ref={svg} className="system-wl-svg" width={plotW} height={height}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <defs>
        <pattern id="system-wl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" className="system-wl-hatch" />
        </pattern>
      </defs>
      {tk.map(t => <g key={t.t}>
        <line className={t.major ? 'system-wl-grid major' : 'system-wl-grid'} x1={x(t.t)} x2={x(t.t)} y1={AXIS - 4} y2={height} />
        {Math.abs(x(t.t) - x(w.now)) > 34 && x(t.t) < plotW - 40 && <text className="system-tick" x={x(t.t) + 3} y={AXIS - 8}>{t.label}</text>}
      </g>)}
      {sinceX !== null && sinceX > 0 && <rect x={0} y={AXIS} width={Math.min(plotW, sinceX)} height={height - AXIS} fill="url(#system-wl-hatch)"><title>{`no run record before ${stamp(w.since!)}`}</title></rect>}
      {body}
      {nowX >= 0 && nowX <= plotW && <g className="system-wl-now">
        <line x1={nowX} x2={nowX} y1={AXIS - 14} y2={height} />
        <text x={nowX + 3} y={AXIS - 16 + 8} className="system-wl-nowt">now</text>
      </g>}
    </svg>
    {tip && <div className="system-wl-tip" style={{ left: Math.min(tip.x + 12, width - 230), top: tip.y + 14 }}>
      <div className="mono">{tip.lane.id}</div>
      <div className="system-wl-tr"><i style={tipSwatch(tip.m)} /><b>{tip.m.manual ? `${tip.m.status} · manual` : tip.m.status}</b></div>
      <div className="mono faint">{stamp(tip.m.t)}{tip.m.kind === 'run' && tip.m.end && tip.m.end - tip.m.t >= 1000 ? ` · ${Math.round((tip.m.end - tip.m.t) / 1000)}s` : ''}</div>
      {tip.m.detail && <div className="system-wl-td">{tip.m.detail}</div>}
    </div>}
  </div>
}

function tipSwatch(m: Mark) {
  if (m.kind === 'run') return { background: FILL[m.status] ?? 'var(--fail)' }
  if (m.kind === 'owed') return { border: '1.5px solid var(--dim)' }
  if (m.kind === 'missed') return { background: 'var(--fail)', width: 2 }
  return { background: 'var(--faint)', width: 2 }
}
