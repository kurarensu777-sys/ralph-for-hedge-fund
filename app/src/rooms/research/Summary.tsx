import type { CardMetric, Manifest, Summary } from '../../../shared/research.ts'

// THE RESEARCH SUMMARY CARD (the owner, 2026-10-03, B-0399): a manifest carrying `summary` draws the one
// fixed card, top to bottom: the question and its one-line answer, the implementation facts, the big
// numbers, the metric blocks in two columns, the size table with the chosen row marked, the footer. The
// look follows platform's fundplat/quant/core/summary_card.py, in the cockpit's colours (PASS ok, FAIL
// fail, FLAG warn). Nothing is computed: every cell is the manifest's, validated by platform's
// report.card_problems when it was built.

const TONE: Record<string, string> = { PASS: 'ok', FAIL: 'fail', FLAG: 'warn', INFO: 'faint' }
const VERDICT_TITLE: Record<string, string> = {
  PASS: 'the number clears its bar', FAIL: 'the number misses its bar', FLAG: 'the number holds but needs a look', INFO: 'shown for the record, not a test',
}

export const Chip = ({ v }: { v: string }) => (v ? <span className={`research-st ${TONE[v] ?? ''}`} title={VERDICT_TITLE[v]}>{v}</span> : null)
const hover = (r: CardMetric) => [r.key && `metric ${r.key}`, r.gate && `gate ${r.gate}`].filter(Boolean).join(' · ') || undefined

export function SummaryView({ m }: { m: Manifest }) {
  const s = m.summary!
  return <div className="research-sum" key={m.id}>
    <div className="research-sq" title="the research question">{s.question}</div>
    <div className="research-sa" title="the answer">{s.answer}</div>
    <Label>Implementation</Label>
    <dl className="research-sf">{s.implementation.map(([k, v], i) => <div key={i}><dt title={k}>{k}</dt><dd title={v}>{v}</dd></div>)}</dl>
    <Label>The numbers that matter</Label>
    <div className="research-sb">{s.big.map((b, i) => <div key={i} className={`bt ${TONE[b.verdict] ?? 'none'}`} title={hover(b)}>
      <span className="g">at {b.scope}</span>
      <span className="mn" title={b.metric}>{b.metric}</span>
      <span className="n" title={b.value}>{b.value}</span>
      <span className="f"><Chip v={b.verdict} />{b.bar && <span title={b.bar}>{b.bar}</span>}</span>
    </div>)}</div>
    <Label>Metrics</Label>
    <div className="research-sc">{s.blocks.map((b, i) => <div key={i} className="blk">
      <h4 title={b.title}>{b.title}</h4>
      {b.rows.map((r, j) => <div key={j} className="met" title={hover(r)}>
        <span className="mn" title={r.metric}>{r.metric}</span><span className="v" title={r.value}>{r.value}</span>
        <span className="bar" title={r.bar}>{r.bar}</span><Chip v={r.verdict} />
      </div>)}
    </div>)}</div>
    <Label>Size</Label>
    <Sizes s={s} />
    <div className="research-sfoot">{s.footer.map((x, i) => <div key={i} title={x}>{x}</div>)}</div>
  </div>
}

const Label = ({ children }: { children: string }) => <div className="research-sl">{children}</div>

function Sizes({ s }: { s: Summary }) {
  const { cols, rows, chosen } = s.sizes
  const last = cols.length - 1
  return <div className="research-ssw"><table className="research-ss">
    <thead><tr>{cols.map((c, i) => <th key={i} className={i === last ? 'v' : i > 0 ? 'r' : ''} title={c}>{c}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i} className={i === chosen ? 'pick' : ''} title={i === chosen ? 'the size the verdict names' : undefined}>
      <td className="k">{r[0]}</td>
      {r.slice(1, -1).map((c, j) => <td key={j} className="r">{c}</td>)}
      <td className="v"><Chip v={r[last]} /></td>
    </tr>)}</tbody>
  </table></div>
}
