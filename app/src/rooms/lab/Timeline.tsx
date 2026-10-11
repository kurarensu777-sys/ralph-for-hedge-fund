import { Empty } from '../../ui/kit.tsx'
import { day } from '../../../shared/time.ts'
import { useWidth } from './Chart.tsx'
import type { ReadIn, RunIn } from './readheat.ts'

// ROOM: lab - one desk's fixed-age reads as a dot timeline: a lane per run (newest on top), the
// run, +7d and +30d on one shared time axis, today as a line. Filled green = done, amber = due,
// red = late or missed, hollow = not yet due. Dates and states ride in each dot's tooltip.

type TRun = RunIn & { key: string; run: string }
const LANES = 10
const DAY = 86_400_000

const CLS: Record<string, string> = { done: 'ok', due: 'due', late: 'late', missed: 'missed', pending: 'ahead', void: 'off', none: 'off' }
const WORD: Record<string, string> = { done: 'done', due: 'due', late: 'late - past the 4-day tolerance', missed: 'missed', pending: 'not yet due', void: 'void', none: 'no read owed' }

/** a run draws on the timeline when it owes or holds a read, or was pre-registered (its at-run read) */
const drawn = (r: TRun) => r.preregistered || (['7d', '30d'] as const).some(a => r.reads[a].row || !['none', 'void'].includes(r.reads[a].state))

export function ReadsTimeline({ runs, now }: { runs: TRun[]; now: number }) {
  const [ref, width] = useWidth()
  const all = runs.filter(r => r.ts !== null && drawn(r)).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  const rows = all.slice(0, LANES)
  const head = <div className="lab-chart-head"><span className="cap" title="fixed-age reads per run: at run, +7d, +30d; today is the line">Reads</span>
    {all.length > LANES && <span className="nchip faint" title={`the ${LANES} newest of ${all.length} runs with reads`}>{LANES}/{all.length}</span>}
    <span className="lab-legend">
      <span title="read done"><i className="lab-tl-k ok" />done</span>
      <span title="due, inside the 4-day tolerance"><i className="lab-tl-k due" />due</span>
      <span title="late or missed"><i className="lab-tl-k late" />late</span>
      <span title="not yet due"><i className="lab-tl-k ahead" />ahead</span>
    </span>
  </div>
  return <div className="lab-tl">
    {head}
    <div ref={ref} className="lab-plot lab-tl-plot">
      {!rows.length ? <Empty sm>{runs.length ? 'imports only: no read owed' : 'no runs'}</Empty> : width > 0 && <Lanes rows={rows} now={now} width={width} />}
    </div>
  </div>
}

function Lanes({ rows, now, width }: { rows: TRun[]; now: number; width: number }) {
  const at = (r: TRun, a: '7d' | '30d'): number | null => r.reads[a].row?.ts ? Date.parse(String(r.reads[a].row!.ts)) || r.reads[a].due : r.reads[a].due
  const xs: number[] = [now]
  for (const r of rows) { xs.push(r.ts!); for (const a of ['7d', '30d'] as const) { const t = at(r, a); if (t) xs.push(t) } }
  let lo = Math.min(...xs), hi = Math.max(...xs)
  const pad = Math.max(DAY, (hi - lo) * 0.04)
  lo -= pad; hi += pad
  const W = Math.max(width, 200), laneH = 15, padL = 58, padR = 8, top = 4, H = top + rows.length * laneH + 18
  const x = (t: number) => padL + ((t - lo) / (hi - lo)) * (W - padL - padR)
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad]
  const tn = x(now)
  return <svg width={W} height={H} role="img" aria-label="fixed-age reads per run on one time axis">
        {ticks.map((t, i) => <text key={i} x={x(t)} y={H - 4} className="lab-tick" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{day(t).slice(5)}</text>)}
        <line x1={tn} x2={tn} y1={top - 2} y2={H - 14} className="lab-tl-now"><title>{`today ${day(now)}`}</title></line>
        {rows.map((r, i) => {
          const cy = top + i * laneH + laneH / 2
          const pts = (['7d', '30d'] as const).map(a => ({ a, c: r.reads[a] as ReadIn, t: at(r, a) }))
          const end = Math.max(r.ts!, ...pts.map(p => p.t ?? 0))
          const atRun = !r.preregistered ? 'off' : r.stage === 'result' ? 'ok' : 'due'
          return <g key={r.key}>
            <text x={padL - 8} y={cy + 3} className="lab-tick lab-tl-run" textAnchor="end">{r.run.length > 9 ? r.run.slice(-9) : r.run}<title>{`#${r.run}`}</title></text>
            <line x1={x(r.ts!)} x2={x(end)} y1={cy} y2={cy} className="lab-tl-lane" />
            <circle cx={x(r.ts!)} cy={cy} r={3.2} className={`lab-tl-d ${atRun}`}>
              <title>{`#${r.run} at run\n${day(r.ts)}\n${r.preregistered ? (r.stage === 'result' ? 'done' : 'pre-registered, no result yet') : 'imported'}${r.void ? `\nvoid: ${r.void}` : ''}`}</title>
            </circle>
            {pts.map(p => p.t !== null && <circle key={p.a} cx={x(p.t)} cy={cy} r={3.2} className={`lab-tl-d ${CLS[p.c.state] ?? 'off'}`}>
              <title>{`#${r.run} +${p.a}\n${p.c.row ? 'read' : 'due'} ${day(p.t)}\n${WORD[p.c.state] ?? p.c.state}${p.c.row?.metrics ? '\n' + Object.entries(p.c.row.metrics).map(([k, v]) => `${k} ${v}`).join('\n') : ''}`}</title>
            </circle>)}
          </g>
        })}
      </svg>
}
