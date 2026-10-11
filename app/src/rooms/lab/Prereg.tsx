import { useEffect, useRef, useState } from 'react'
import { Btn, Chip, Empty, Load, Seg } from '../../ui/kit.tsx'
import { api } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { StagePill, useDesk, type DeskInfo } from './Mechanics.tsx'

// ROOM: lab - the pre-register form. app/loop/tools/preregister.py is the judge: the cockpit only
// fills its flags, and shows its REFUSED line exactly as the tool printed it.

type Out = { ok: boolean; dry: boolean; code: number | null; refused: string | null; stdout: string; stderr: string; row: any; argv: string[] }
type Pair = { k: string; v: string }

const short = (d: string) => d.replace(/^lab\//, '')
/** the newest runs offered as ancestor chips; older ones sit in one small select */
const RECENT = 6

export function Prereg({ desks, initial }: { desks: string[]; initial: string }) {
  const [desk, setDesk] = useState(initial || desks[0] || '')
  const q = useDesk(desk || null)
  return <div className="lab-form">
    <label className="field"><span className="cap">Desk</span>
      <select className="input" value={desk} onChange={e => setDesk(e.target.value)}>
        {desks.map(d => <option key={d} value={d}>{short(d)}</option>)}
      </select>
    </label>
    {!desk ? <Empty>no desk under lab/</Empty> : <Load q={q}>{d => <Form key={d.desk} d={d} />}</Load>}
  </div>
}

function Form({ d }: { d: DeskInfo }) {
  const { toast } = useNav()
  const [run, setRun] = useState(d.nextRun)
  const [mechanic, setMechanic] = useState('')
  const [kind, setKind] = useState<'exploit' | 'explore' | 'wild'>('exploit')
  const [variant, setVariant] = useState('')
  const [experiment, setExperiment] = useState('')
  const [ancestor, setAncestor] = useState(d.last?.run ?? '')
  const [vars, setVars] = useState<string[]>(['', ''])
  const [predict, setPredict] = useState<Pair[]>([{ k: '', v: '' }])
  const [judge, setJudge] = useState('')
  const [beliefs, setBeliefs] = useState<string[]>([])
  const [cmd, setCmd] = useState(d.last?.cmd ?? '')
  const [cwd, setCwd] = useState(d.last?.cwd && /^(platform|research)(\/|$)/.test(d.last.cwd) ? d.last.cwd : 'platform')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [hours, setHours] = useState('')
  const [regimes, setRegimes] = useState('')
  const [comparator, setComparator] = useState('')
  const [patterns, setPatterns] = useState<Pair[]>([{ k: '', v: '' }])
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [out, setOut] = useState<Out | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<'dry' | 'real' | null>(null)
  const verdict = useRef<HTMLDivElement>(null)
  useEffect(() => { if (out || err) verdict.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [out, err])

  // any edit invalidates the last verdict: a stale REFUSED under a changed form misleads
  useEffect(() => { setOut(null); setErr(null) }, [run, mechanic, kind, variant, experiment, ancestor, vars, predict, judge, beliefs, cmd, cwd, from, to, hours, regimes, comparator, patterns, title, note])

  const pairs = (xs: Pair[]) => xs.filter(p => p.k.trim() || p.v.trim()).map(p => `${p.k.trim()}=${p.v.trim()}`)
  const submit = async (dry: boolean) => {
    setBusy(dry ? 'dry' : 'real'); setErr(null); setOut(null)
    try {
      const o = await api<Out>('/api/lab/preregister', { body: {
        desk: d.desk, run, mechanic, kind, variant, experiment, ancestor,
        variables: vars, predict: pairs(predict), judge: judge.split(',').map(s => s.trim()).filter(Boolean), belief: beliefs,
        cmd, cwd, from, to, hours, regimes, comparator, metricPattern: pairs(patterns), title, note, dry,
      } })
      setOut(o)
      if (o.ok && !dry) toast(`pre-registered ${short(d.desk)} #${run}`)
    } catch (e: any) { setErr(e.message) } finally { setBusy(null) }
  }
  const mech = d.mechanics.find(m => m.id === mechanic)

  return <>
    <div className="lab-frow">
      <label className="field lab-f-run"><span className="cap">Run</span><input className="input mono" value={run} onChange={e => setRun(e.target.value)} /></label>
      <div className="field"><span className="cap">Kind</span><Seg value={kind} onChange={setKind} options={[{ id: 'exploit', label: 'exploit' }, { id: 'explore', label: 'explore' }, { id: 'wild', label: 'wild' }]} /></div>
    </div>
    <div className="field"><span className="cap">Mechanic</span>
      {d.mechanics.length === 0 ? <Empty inline title="NONE">no M rows in mechanics.md</Empty> :
      <div className="chips">{d.mechanics.map(m => <Chip key={m.id} sm on={mechanic === m.id} onClick={() => setMechanic(mechanic === m.id ? '' : m.id)}
        title={`${m.id} ${m.name}\n${m.stage ? `stage ${m.stage.stage}` : 'no stage'}\n${m.status}`}>{m.id}</Chip>)}</div>}
      {mech && <div className="lab-mhint"><StagePill s={mech.stage?.stage} /> <span className="faint" title={mech.status}>{mech.name}</span></div>}
    </div>
    <div className="field"><span className="cap">Ancestor</span>
      <div className="chips">
        <Chip sm on={ancestor === ''} onClick={() => setAncestor('')} title={d.runs.length ? 'no --ancestor flag' : 'none: the first run'}>-</Chip>
        <Chip sm on={ancestor === 'NONE'} onClick={() => setAncestor('NONE')} title="--ancestor NONE">NONE</Chip>
        {[...d.runs].reverse().slice(0, RECENT).map(r => <Chip key={r} sm on={ancestor === r} onClick={() => setAncestor(r)} title={`--ancestor ${r}`}>{r}</Chip>)}
        {d.runs.length > RECENT && <select className={`input mono lab-fsel ${ancestor && ancestor !== 'NONE' && ![...d.runs].reverse().slice(0, RECENT).includes(ancestor) ? 'on' : ''}`} value={[...d.runs].reverse().slice(0, RECENT).includes(ancestor) || ancestor === 'NONE' ? '' : ancestor} title="an older run" onChange={e => setAncestor(e.target.value)}>
          <option value="">older</option>
          {[...d.runs].reverse().slice(RECENT).map(r => <option key={r} value={r}>{r}</option>)}
        </select>}
      </div>
    </div>
    <label className="field"><span className="cap">Variant</span><input className="input" value={variant} onChange={e => setVariant(e.target.value)} /></label>
    {kind !== 'exploit' && <label className="field"><span className="cap">Experiment</span><input className="input" value={experiment} onChange={e => setExperiment(e.target.value)} title="the ONE test this run makes" /></label>}
    <div className="lab-frow">
      {vars.map((v, i) => <label key={i} className="field lab-f-grow"><span className="cap">{i === 0 ? 'Variables' : ' '}</span>
        <input className="input" value={v} placeholder={`change ${i + 1} vs ancestor`} onChange={e => setVars(vars.map((x, j) => j === i ? e.target.value : x))} /></label>)}
    </div>
    <div className="field"><span className="cap">Predict</span>
      {predict.map((p, i) => <div key={i} className="lab-pair">
        <input className="input mono" placeholder="metric" value={p.k} onChange={e => setPredict(predict.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
        <input className="input mono" placeholder="band: 20..30 · >= 0 · 0" value={p.v} onChange={e => setPredict(predict.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
        {predict.length > 1 && <button className="iconbtn" title="remove" onClick={() => setPredict(predict.filter((_, j) => j !== i))}>x</button>}
      </div>)}
      <button className="lnk lab-add" onClick={() => setPredict([...predict, { k: '', v: '' }])}>+ metric</button>
    </div>
    <div className="lab-frow">
      <label className="field lab-f-grow"><span className="cap">From</span><input className="input mono" placeholder="YYYY-MM-DDTHH:MMZ" value={from} onChange={e => setFrom(e.target.value)} /></label>
      <label className="field lab-f-grow"><span className="cap">To</span><input className="input mono" placeholder="YYYY-MM-DDTHH:MMZ" value={to} onChange={e => setTo(e.target.value)} /></label>
      <label className="field lab-f-num"><span className="cap">Hours</span><input className="input mono" value={hours} onChange={e => setHours(e.target.value)} /></label>
      <label className="field lab-f-num"><span className="cap">Regimes</span><input className="input mono" value={regimes} onChange={e => setRegimes(e.target.value)} /></label>
    </div>
    <label className="field"><span className="cap">Command</span><input className="input mono" value={cmd} onChange={e => setCmd(e.target.value)} placeholder="python -m research.my_backtest ..." /></label>
    <div className="field"><span className="cap">Cwd</span>
      <Seg value={cwd} onChange={setCwd} options={[...new Set(['platform', 'research', cwd])].map(c => ({ id: c, label: c }))} />
    </div>
    {/* a template row in beliefs.md ("<the claim, in one sentence>") is not a belief: none is the honest state */}
    <div className="field"><span className="cap">Beliefs</span>
      {!d.beliefs.some(b => !b.placeholder) ? <Empty inline title="NONE">beliefs.md holds no belief yet</Empty> :
      <div className="chips">{d.beliefs.filter(b => !b.placeholder).map(b => <Chip key={b.id} sm on={beliefs.includes(b.id)} title={b.claim}
        onClick={() => setBeliefs(beliefs.includes(b.id) ? beliefs.filter(x => x !== b.id) : [...beliefs, b.id])}>{b.id}</Chip>)}</div>}
    </div>
    <details className="lab-more">
      <summary>More</summary>
      <label className="field"><span className="cap">Judge</span><input className="input" value={judge} onChange={e => setJudge(e.target.value)} placeholder="axes, comma separated" /></label>
      <label className="field"><span className="cap">Comparator</span><input className="input mono" value={comparator} onChange={e => setComparator(e.target.value)} placeholder="tbill=4.11 %/yr [V]" /></label>
      <div className="field"><span className="cap">Read-back</span>
        {patterns.map((p, i) => <div key={i} className="lab-pair">
          <input className="input mono" placeholder="metric" value={p.k} onChange={e => setPatterns(patterns.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
          <input className="input mono" placeholder="regex with one group" value={p.v} onChange={e => setPatterns(patterns.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} />
          {patterns.length > 1 && <button className="iconbtn" title="remove" onClick={() => setPatterns(patterns.filter((_, j) => j !== i))}>x</button>}
        </div>)}
        <button className="lnk lab-add" onClick={() => setPatterns([...patterns, { k: '', v: '' }])}>+ pattern</button>
      </div>
      <label className="field"><span className="cap">Title</span><input className="input" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="field"><span className="cap">Note</span><input className="input" value={note} onChange={e => setNote(e.target.value)} /></label>
    </details>
    <div className="lab-factions">
      <Btn sm disabled={busy !== null} onClick={() => submit(true)} title="preregister.py --dry: validate and print, write nothing">{busy === 'dry' ? 'Checking' : 'Check'}</Btn>
      <Btn sm kind="primary" disabled={busy !== null} onClick={() => submit(false)} title="preregister.py: append the pre-flight to results-log.md and data/runs.jsonl (write-once)">{busy === 'real' ? 'Registering' : 'Register'}</Btn>
    </div>
    <div ref={verdict}>
      {err && <pre className="pre t-fail lab-refused">{err}</pre>}
      {out && <Verdict o={out} />}
    </div>
  </>
}

function Verdict({ o }: { o: Out }) {
  const argv = o.argv.join(' ')
  const cr = (s: string) => s.split(String.fromCharCode(13)).join("")
  o = { ...o, stdout: cr(o.stdout), stderr: cr(o.stderr), refused: o.refused === null ? null : cr(o.refused) }
  if (o.refused) return <><div className="cap dsec t-fail">Refused</div><pre className="pre t-fail lab-refused" title={argv}>{o.refused}</pre></>
  if (!o.ok) return <><div className="cap dsec t-fail">Failed (exit {o.code ?? '-'})</div><pre className="pre t-fail lab-refused" title={argv}>{(o.stderr || o.stdout || 'no output').trim()}</pre></>
  if (o.dry) return <><div className="cap dsec t-ok">Valid</div><pre className="pre" title={argv}>{o.stdout.trim()}</pre></>
  return <><div className="cap dsec t-ok">Registered</div><pre className="pre" title={argv}>{o.row ? JSON.stringify(o.row, null, 2) : o.stdout.trim()}</pre></>
}
