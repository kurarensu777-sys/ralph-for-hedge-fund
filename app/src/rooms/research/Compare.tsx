import type { ReactNode } from 'react'
import { FORMATS, MARKETS, metricsOf, type Manifest, type Study } from '../../../shared/research.ts'
import { Empty, Pill } from '../../ui/kit.tsx'
import { day, fmtMetric, formatOf, gateCounts, headlineOfManifest, manifestOf, toneOf, verdictTone } from './format.ts'
import { compareRefusal, shortName } from './list.ts'
import { usePins } from './pins.ts'

// COMPARE: the two pinned studies side by side, on the card's own places, the Verdict cell tinted where the
// second differs from the first (every other row differs, so a tint there says nothing). Refused across formats: a carry study and an evidence study share no
// metric (how-a-belief-moves.md: and two rows on one window are one observation, the head says so).

type Row = { k: string; a: ReactNode; b: ReactNode; ta: string; tb: string; tone?: [string, string] }

function rows(A: Study, B: Study, a: Manifest, b: Manifest): Row[] {
  const out: Row[] = []
  const add = (k: string, fa: (s: Study, m: Manifest) => string, tone?: (m: Manifest) => string) =>
    out.push({ k, a: fa(A, a), b: fa(B, b), ta: fa(A, a), tb: fa(B, b), tone: tone ? [tone(a), tone(b)] : undefined })
  const gates = (m: Manifest) => { const g = gateCounts(m.gates); return `${g.pass} pass · ${g.fail} fail · ${g.flag} flag` }
  out.push({ k: 'Verdict', a: <Pill lbl tone={verdictTone(a.verdict.word)}>{a.verdict.word}</Pill>, b: <Pill lbl tone={verdictTone(b.verdict.word)}>{b.verdict.word}</Pill>, ta: a.verdict.word, tb: b.verdict.word })
  add('Gates', (_, m) => gates(m))
  add('Market', s => s.labels.markets.map(k => MARKETS[k].label).join(', ') || 'none')
  add('Venues', (_, m) => (m.profile?.venues ?? m.strategy?.venues ?? []).join(', ') || 'none')
  add('Window', (_, m) => `${day(m.window.from)} -> ${day(m.window.to)}`)
  add('Hours', (_, m) => (m.window.hours !== undefined ? m.window.hours.toLocaleString('en-US') : 'n/a'))
  add('Regimes', (_, m) => (m.window.regimes !== undefined ? String(m.window.regimes) : 'n/a'))
  add('Verify', (_, m) => `${m.verify.passed}/${m.verify.total}`, m => (m.verify.passed === m.verify.total ? 'ok' : 'fail'))
  // the headline's name is its own row: two studies rarely judge the same number, and a label with its unit twice ("Funding ann: 9.16% ann") says it twice
  add('Headline', (_, m) => headlineOfManifest(m)?.label ?? 'none')
  add('Value', (_, m) => headlineOfManifest(m)?.text ?? 'none', m => { const h = headlineOfManifest(m); return h?.verdict ? h.tone : '' })
  add('Hurdle', (_, m) => headlineOfManifest(m)?.hurdle ?? 'none')
  const f = formatOf(a)
  if (f) for (const mt of metricsOf(f)) {
    const t = (m: Manifest) => fmtMetric(mt, m.metrics?.[mt.key] ?? null) ?? 'n/a'
    add(mt.label, (_, m) => t(m), m => toneOf(mt, m.metrics?.[mt.key] ?? null))
  }
  for (const [k, label] of [['entry', 'Entry'], ['exit', 'Exit'], ['hold', 'Hold'], ['sizing', 'Sizing'], ['hedge', 'Hedge'], ['stop', 'Stop'], ['cost', 'Costs']] as const)
    add(label, (_, m) => m.rules?.[k] ?? 'none')
  return out
}

export function Compare({ studies, pick }: { studies: Study[]; pick: (id: string) => void }) {
  const pins = usePins()
  const [A, B] = pins.map(id => studies.find(s => s.id === id) ?? null)
  const why = compareRefusal(A ?? null, B ?? null)
  if (why) return <div className="research-table-wrap"><Empty title="NOTHING TO COMPARE">{why}</Empty></div>
  const a = manifestOf(A!)!, b = manifestOf(B!)!
  const f = formatOf(a)
  const sameWindow = a.window.from === b.window.from && a.window.to === b.window.to
  const rs = rows(A!, B!, a, b)
  return <div className="research-table-wrap">
    <div className="research-table-head">
      <span className="research-sec">Compare</span>
      <span className="research-faint">pinned 2</span>
      {sameWindow ? <Pill lbl tone="warn" title="how-a-belief-moves.md: two studies on the same window are one observation of the market, not two">same window: one observation</Pill>
        : <Pill lbl tone="warn" title="how-a-belief-moves.md: each column is one window; a difference between them is not a ranking">1 window per column</Pill>}
      <Pill lbl tone="faint" title={f ? FORMATS[f].title : 'neither names a format'}>{f ? FORMATS[f].label : 'no format'}</Pill>
    </div>
    <table className="research-table research-cmp">
      <thead><tr><th />{[A!, B!].map(s => <th key={s.id} title={s.id} onClick={() => pick(s.id)}>{shortName(s.name)}</th>)}</tr></thead>
      <tbody>{rs.map(r => {
        const d = r.k === 'Verdict' && r.ta !== r.tb
        return <tr key={r.k}>
          <td className="nm">{r.k}</td>
          <td className={r.tone?.[0] ?? ''}>{r.a}</td>
          <td className={`${r.tone?.[1] ?? ''} ${d ? 'd' : ''}`} title={d ? 'differs from the first' : undefined}>{r.b}</td>
        </tr>
      })}</tbody>
    </table>
  </div>
}
