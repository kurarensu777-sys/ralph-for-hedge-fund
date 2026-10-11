import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApi } from '../../lib/api.ts'
import { Empty, Meter } from '../../ui/kit.tsx'

// ROOM: lab - the trial ledger behind a run (lab/<desk>/data/trials.jsonl, app/loop/tools/trial.py):
// DSR (Deflated Sharpe, N read from the ledger) and PBO (CSCV, 16 blocks), as two chips.

type Pt = { is: number; oos: number; best: boolean }
export type TrialsBody = {
  key: string; ledger: string; exists: boolean; rows: number
  n_trials: number | null; run_trials: number; by_status: Record<string, number>
  dsr: { value: number | null; sr: number | null; sr0: number; n: number; v: number; t: number | null; skew: number | null; kurt: number | null; why?: string } | null
  pbo: { value: number | null; combos: number; n: number; t: number; s: number; scatter?: Pt[]; why?: string } | null
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const STATUS_ORDER = ['kept', 'abandoned', 'rerun']

/** the two chips; `dsr` red below 0.5, `pbo` red above 50%; no rows = the table's dim dash (unknown, said in the tooltip) */
export function TrialChips({ runKey, dsr, pbo, n }: { runKey: string; dsr: number | null; pbo: number | null; n: number | null }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  if (n === null) return <span className="nil" aria-label="no value" title="no rows in this desk's data/trials.jsonl: N unknown, so no DSR or PBO" />
  const open = () => { const r = ref.current?.getBoundingClientRect(); if (r) setAt({ x: r.left, y: r.bottom + 6 }) }
  return <span ref={ref} className="lab-tchips" onClick={e => e.stopPropagation()} onMouseEnter={open} onMouseLeave={() => setAt(null)}>
    <span className={`tag sm ${dsr !== null && dsr < 0.5 ? 'fail' : ''}`} title={`N=${n} trials`}>DSR {dsr === null ? '?' : dsr.toFixed(2)}</span>
    <span className={`tag sm ${pbo !== null && pbo > 0.5 ? 'fail' : ''}`} title={`N=${n} trials`}>PBO {pbo === null ? '?' : pct(pbo)}</span>
    {at && createPortal(<div className="pop lab-tpop" style={{ left: Math.min(at.x, window.innerWidth - 236), top: Math.min(at.y, window.innerHeight - 200) }}><PopBody runKey={runKey} /></div>, document.body)}
  </span>
}

function PopBody({ runKey }: { runKey: string }) {
  const q = useApi<TrialsBody>(`/api/lab/trials?key=${encodeURIComponent(runKey)}`)
  if (q.error) return <Empty inline state="failed">{q.error}</Empty>
  if (!q.data) return <Empty inline state="loading" />
  const d = q.data
  return <>
    <div className="lab-tpop-h"><span>N {d.n_trials ?? '?'}</span>{d.pbo && d.pbo.value !== null && <span className="faint">{d.pbo.combos.toLocaleString()} splits</span>}</div>
    {d.pbo?.scatter?.length ? <RankScatter pts={d.pbo.scatter} /> : <div className="faint lab-small lab-tpop-e">{d.pbo?.why ?? 'no return paths'}</div>}
  </>
}

/** IS rank (x) vs OOS rank (y), 0..1; each split's IS-best cell in accent. Overfit = the accent dots fall low. */
export function RankScatter({ pts, size = 200 }: { pts: Pt[]; size?: number }) {
  const pad = 16, w = size, h = size * 0.72
  const X = (v: number) => pad + v * (w - pad - 4), Y = (v: number) => h - pad - v * (h - pad - 4)
  const rest = pts.filter(p => !p.best), best = pts.filter(p => p.best)
  return <svg className="lab-scat" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="in-sample rank against out-of-sample rank">
    <line className="lab-grid" x1={X(0)} y1={Y(0.5)} x2={X(1)} y2={Y(0.5)} />
    <line className="lab-zero" x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} />
    {rest.map((p, i) => <circle key={i} className="lab-sdot" cx={X(p.is)} cy={Y(p.oos)} r={1.6} />)}
    {best.map((p, i) => <circle key={`b${i}`} className="lab-sbest" cx={X(p.is)} cy={Y(p.oos)} r={2.4}><title>{`IS-best: OOS rank ${pct(p.oos)}`}</title></circle>)}
    <text className="lab-tick" x={X(1)} y={h - 3} textAnchor="end">IS</text>
    <text className="lab-tick" x={2} y={Y(1) + 8}>OOS</text>
  </svg>
}

/** the drawer section: chips, the count by status, the scatter */
export function TrialsSection({ runKey }: { runKey: string }) {
  const q = useApi<TrialsBody>(`/api/lab/trials?key=${encodeURIComponent(runKey)}`, ['lab'])
  if (q.error) return <Empty inline state="failed">{q.error}</Empty>
  if (!q.data) return <Empty inline state="loading" />
  const d = q.data
  if (!d.rows) return <div className="lab-trow"><span className="tag sm none" title={d.exists ? `no rows for this run in ${d.ledger}` : `no ${d.ledger}`}>N ?</span></div>
  const statuses = [...STATUS_ORDER.filter(s => d.by_status[s]), ...Object.keys(d.by_status).filter(s => !STATUS_ORDER.includes(s))]
  const dsrT = d.dsr ? [`N=${d.dsr.n} trials`, `SR ${d.dsr.sr?.toFixed(4) ?? '?'} /obs vs E[max] ${d.dsr.sr0.toFixed(4)}`, `T ${d.dsr.t ?? '?'} · skew ${d.dsr.skew ?? '?'} · kurt ${d.dsr.kurt ?? '?'}`, d.dsr.why ?? ''].filter(Boolean).join('\n') : 'no DSR'
  const pboT = d.pbo ? (d.pbo.why ?? `CSCV S=${d.pbo.s} · ${d.pbo.combos.toLocaleString()} splits · ${d.pbo.n} paths x ${d.pbo.t} obs`) : 'no trial of this run carries a return path'
  const dv = d.dsr?.value ?? null, pv = d.pbo?.value ?? null
  const total = statuses.reduce((n, s) => n + d.by_status[s], 0)
  return <div className="lab-tsec">
    <div className="lab-tgrid">
      <div className="card lab-tcell2" title={`Deflated Sharpe: the chance the best trial's Sharpe beats what N trials would find by luck; red below 0.5\n${dsrT}`}>
        <span className={`lab-tv ${dv === null ? 'faint' : dv < 0.5 ? 't-fail' : 't-ok'}`}>{dv === null ? '?' : dv.toFixed(2)}</span><span className="lab-tk">DSR</span>
        <Meter v={dv} tone={dv === null ? undefined : dv < 0.5 ? 'fail' : 'ok'} sm grow />
      </div>
      <div className="card lab-tcell2" title={`Probability of backtest overfitting (CSCV); red above 50%\n${pboT}`}>
        <span className={`lab-tv ${pv === null ? 'faint' : pv > 0.5 ? 't-fail' : 't-ok'}`}>{pv === null ? '?' : pct(pv)}</span><span className="lab-tk">PBO</span>
        <Meter v={pv} tone={pv === null ? undefined : pv > 0.5 ? 'fail' : 'ok'} sm grow />
      </div>
      <div className="card lab-tcell2" title={`distinct trials for the mechanic in ${d.ledger}\n${statuses.map(s => `${d.by_status[s]} ${s}`).join('\n')}`}>
        <span className="lab-tv">{d.n_trials ?? '?'}</span><span className="lab-tk">Trials</span>
        {total > 0 && <span className="lab-tstack" aria-hidden>{statuses.map(s => <i key={s} className={`st-${s}`} style={{ flexGrow: d.by_status[s] }} />)}</span>}
      </div>
    </div>
    {d.pbo?.scatter?.length ? <RankScatter pts={d.pbo.scatter} size={260} /> : null}
  </div>
}
