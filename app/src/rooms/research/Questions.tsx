import { useRef, useState } from 'react'
import type { Manifest, QuestionSection, QuestionsPayload } from '../../../shared/research.ts'
import { Empty } from '../../ui/kit.tsx'
import { useApi, useStored } from '../../lib/api.ts'
import { getFocus, setFocus } from '../../shell/focus.ts'
import { figuresIn } from './figview.ts'
import { FigViewer } from './FigViewer.tsx'
import { blocksOf, countsOf, spansOf } from './qmd.ts'
import { Chip } from './Summary.tsx'

// THE QUESTIONS BLOCK (the owner, 2026-10-05, B-0524): under the summary card, each section's question with its
// figures and tables, lifted from the notebook so nobody scrolls it to read them. The server reads the notebook
// (server/research/questions.ts); the gate chips and readings and the figure titles are the manifest's. A notebook
// without the nine sections gives null and draws nothing. Nothing is computed and nothing is written back.

type Cols = 1 | 2
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const GATES = 'G'

export function Questions({ id, m }: { id: string; m: Manifest }) {
  const q = useApi<QuestionsPayload>(`/api/research/questions?id=${encodeURIComponent(id)}`, ['research'])
  const [cols, setCols] = useStored<Cols>('research.qcols', 2)
  const root = useRef<HTMLElement>(null)
  const [open, setOpen] = useState<{ figs: Element[]; at: number } | null>(null)
  if (q.error && !q.data) return <section className="research-qb"><div className="research-sl">Questions</div><Empty state="failed" inline>{q.error}</Empty></section>
  if (!q.data) return <section className="research-qb"><div className="research-sl">Questions</div><Empty state="loading" inline /></section>
  const { questions: qs, mtime } = q.data
  if (!qs) return null
  const n = countsOf(qs.sections)
  const titles = new Map(m.figures.map(f => [f.id, f.title]))
  const jump = (key: string) => root.current?.querySelector(`[data-q="${key}"]`)?.scrollIntoView({ block: 'start' })
  const pick = (img: HTMLElement) => {
    const figs = root.current ? figuresIn(root.current) : []
    const at = figs.indexOf(img)
    if (at >= 0) setOpen({ figs, at })
  }
  // the notebook column's cell n; when the card fills the window the column is hidden, so the columns come back first
  const toCell = (cell: number) => {
    const go = () => document.querySelectorAll('.research-nb .cell')[cell]?.scrollIntoView({ block: 'start' })
    const f = getFocus()
    if (f?.room === 'research' && f.part === 'card') { setFocus(null); setTimeout(go, 150) } else go()
  }
  return <section className="research-qb" ref={root}>
    <div className="research-qh">
      <div className="research-sl">Questions</div>
      <span className="research-faint" title="read from the notebook; nothing is recomputed">{plural(n.questions, 'question')} · {plural(n.figures, 'figure')} · {plural(n.tables, 'table')}</span>
      <span className="research-fsp" />
      <span className="research-qseg" role="group" aria-label="figure layout">
        {([2, 1] as Cols[]).map(c => <button key={c} className={cols === c ? 'on' : ''} onClick={() => setCols(c)} title={`${c} across`}>{c} across</button>)}
      </span>
    </div>
    <nav className="research-qjump">
      {qs.sections.map(s => <button key={s.id} className="chip sm" onClick={() => jump(s.id)} title={s.name}>{s.id}<i>{s.figs.length} fig</i></button>)}
      {qs.verdict && <button className="chip sm" onClick={() => jump(GATES)} title="the verdict, every gate">Gates</button>}
    </nav>
    {qs.sections.map(s => <Section key={s.id} id={id} mtime={mtime} s={s} m={m} titles={titles} cols={cols} pick={pick} toCell={toCell} />)}
    {qs.verdict && <div className="research-qs" data-q={GATES}>
      <div className="research-qsh"><span className="research-qid">S7</span><span className="research-qn">Verdict, every gate</span></div>
      <Tables list={[qs.verdict]} />
    </div>}
    {open && <FigViewer figs={open.figs} at={open.at} heads={{}} close={() => setOpen(null)} />}
  </section>
}

function Section({ id, mtime, s, m, titles, cols, pick, toCell }: {
  id: string; mtime: number; s: QuestionSection; m: Manifest; titles: Map<string, string | undefined>; cols: Cols; pick: (img: HTMLElement) => void; toCell: (cell: number) => void
}) {
  const gates = m.gates.filter(g => g.section === s.id)
  return <div className="research-qs" data-q={s.id}>
    <div className="research-qsh">
      <span className="research-qid">{s.id}</span><span className="research-qn">{s.name}</span>
      <span className="research-qg">{gates.map((g, i) => <span key={g.id ?? i} className="research-qgc" title={g.name}>{g.id && <b>{g.id}</b>}{g.label ?? g.name}<Chip v={g.verdict} /></span>)}</span>
    </div>
    {s.question && <h3 className="research-qq">{s.question}</h3>}
    {s.rule && <div className="research-qr">{s.ruleHead && <span>{s.ruleHead}</span>}{s.rule}</div>}
    {gates.some(g => g.reading) && <ul className="research-qrd">{gates.filter(g => g.reading).map((g, i) => <li key={g.id ?? i}>{g.id && <b>{g.id}</b>}{g.reading}</li>)}</ul>}
    {s.figs.length > 0 && <div className={`research-qf c${cols}`}>{s.figs.map(f => <figure key={f.fig}>
      <figcaption className="t">{titles.get(f.fig) || f.fig}</figcaption>
      <button className="research-qimg" onClick={e => pick(e.currentTarget.querySelector('img')!)} title={`${f.fig}: open in the figure viewer`}>
        <img src={`/api/research/chart-fig?id=${encodeURIComponent(id)}&v=${mtime}&fig=${encodeURIComponent(f.fig)}`} alt={titles.get(f.fig) || f.fig} loading="lazy" decoding="async" />
      </button>
      <figcaption className="b"><code>{f.fig}</code><button className="lnk" onClick={() => toCell(f.cell)} title="scroll the notebook to this figure's cell">cell {f.cell} in the notebook</button></figcaption>
    </figure>)}</div>}
    <Tables list={s.tables} />
  </div>
}

function Tables({ list }: { list: { md: string; cell: number }[] }) {
  return <>{list.map(t => <div className="research-qt" key={t.cell}>{blocksOf(t.md).map((b, i) => b.kind === 'text'
    ? <p key={i}>{b.text}</p>
    : <div className="research-ssw" key={i}><table className="research-ss">
      <thead><tr>{b.head.map((h, j) => <th key={j}>{h}</th>)}</tr></thead>
      <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inline s={c} /></td>)}</tr>)}</tbody>
    </table></div>)}</div>)}</>
}

const Inline = ({ s }: { s: string }) => <>{spansOf(s).map((p, i) => p.kind === 'text' ? p.text
  : p.kind === 'code' ? <code key={i}>{p.text}</code>
  : p.text === 'PASS' || p.text === 'FAIL' ? <Chip key={i} v={p.text} /> : <b key={i}>{p.text}</b>)}</>
