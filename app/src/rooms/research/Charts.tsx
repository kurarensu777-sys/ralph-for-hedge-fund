import { useRef, useState } from 'react'
import type { ChartsPayload, ChartType } from '../../../shared/research.ts'
import { Chip, Empty, FailLine, Load, Markdown, Pill } from '../../ui/kit.tsx'
import { useApi, useStored } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { NO_CHART_FILTER, chartCounts, chartGroups, chartMatches, isUndrawn, usedBy, type ChartFilter } from './chartfilter.ts'
import { figuresIn } from './figview.ts'
import { FigViewer } from './FigViewer.tsx'
import { shortName } from './list.ts'

// THE CHARTS VIEW (the owner, 2026-10-05, B-0505): one card per chart TYPE, read from the chart bank
// (app/library/research/charts.md, kept by research). The question is the title; under it the exemplar's
// figure from its study's notebook, opened in the figure viewer; the framework lines folded; a button
// copies the code that draws the type. A type no study has drawn says "not drawn yet" and shows no
// picture, never a placeholder. Read-only: the room computes and draws nothing of its own.

const useCharts = () => useApi<ChartsPayload>('/api/research/charts', ['research', 'library'])

const FRAMEWORK = [['Inputs', 'inputs'], ['How to draw', 'draw'], ['How to read it', 'read'], ['Pairs with', 'pairs']] as const
const bullets = (xs: string[]) => xs.map(x => `- ${x}`).join('\n')

export function Charts() {
  const q = useCharts()
  const [flt, setFlt] = useStored<ChartFilter>('research.charts', NO_CHART_FILTER)
  const f = { ...NO_CHART_FILTER, ...flt }
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<{ figs: Element[]; at: number } | null>(null)
  const show = (img: HTMLElement | null) => {
    const figs = root.current ? figuresIn(root.current) : []
    const at = img ? figs.indexOf(img) : -1
    if (at >= 0) setOpen({ figs, at })
  }
  return <Load q={q} skel="cards">{d => {
    if (!d.exists) return <Empty state="failed" title="NO CHART BANK">app/library/research/charts*.md is not on this machine</Empty>
    const n = chartCounts(d.types)
    const types = d.types.filter(t => chartMatches(t, f))
    const chip = (id: ChartFilter['show'], label: string, count: number, title: string) =>
      <Chip sm on={f.show === id} onClick={() => setFlt({ ...f, show: id })} title={title}>{label} <span className="research-faint">{count}</span></Chip>
    return <div className="research-table-wrap research-charts" ref={root}>
      <div className="research-frow">
        <span className="research-flbl">Charts</span>
        <input className="input sm research-q" placeholder="Search charts" value={f.q} title="every word must appear in the question or the read-when line"
          onChange={e => setFlt({ ...f, q: e.target.value })} onKeyDown={e => { if (e.key === 'Escape') setFlt({ ...f, q: '' }) }} />
        {chip('all', 'All', n.all, 'every chart type in the bank')}
        {chip('drawn', 'Drawn', n.drawn, 'types with an exemplar: a figure a study drew')}
        {chip('undrawn', 'Not drawn yet', n.undrawn, 'types no study has drawn: the chapter says `none yet`')}
        <span className="research-fsp" />
        <span className="research-faint" title="app/library/research/charts*.md: one chapter per type, never a gallery">{types.length} of {n.all} types</span>
      </div>
      {n.unreadable > 0 && <FailLine what="the chart bank" detail={`${n.unreadable} chapter${n.unreadable > 1 ? 's' : ''} with a missing or unreadable Exemplar line:\n${d.types.filter(t => t.exemplar.state === 'bad').map(t => `${t.heading}: ${t.exemplar.state === 'bad' ? t.exemplar.why : ''}`).join('\n')}`} />}
      {n.uncategorised > 0 && <FailLine what="the chart bank" detail={`${n.uncategorised} chapter${n.uncategorised > 1 ? 's' : ''} with a missing or unknown Category line:\n${d.types.filter(t => !t.category).map(t => `${t.heading}: ${t.categoryWhy ?? "fundd sent no category (an older fundd is running)"}`).join('\n')}`} />}
      {types.length
        ? chartGroups(types).map(g => <section key={g.id ?? 'none'} className="research-chart-cat" id={`chart-cat-${g.id ?? 'none'}`}>
          <h2 className="research-chart-cat-h" title={g.asks ?? 'the Category line is missing or names none of the eight'}>
            <span>{g.name}</span><span className="research-faint">{g.types.length}</span>{g.asks && <span className="research-chart-cat-asks">{g.asks}</span>}
          </h2>
          <div className="research-chart-grid">{g.types.map(t => <ChartCard key={t.id} t={t} open={show} />)}</div>
        </section>)
        : <Empty inline>{n.all ? 'no chart type matches' : 'the book holds no chart types'}</Empty>}
      {open && <FigViewer figs={open.figs} at={open.at} heads={{}} close={() => setOpen(null)} />}
    </div>
  }}</Load>
}

function ChartCard({ t, open }: { t: ChartType; open: (img: HTMLElement | null) => void }) {
  const nav = useNav()
  const [copied, setCopied] = useState(false)
  const [broken, setBroken] = useState(false)
  const e = t.exemplar
  const copy = () => { if (t.code) void navigator.clipboard?.writeText(t.code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }
  return <article className="research-chart" id={`chart-${t.id}`}>
    <div className="research-chart-top">
      <span className="research-chart-kind" title={`the kind id a manifest figure carries: figures[].kind = ${t.id}`}>{t.heading}</span>
      {isUndrawn(t) && <Pill lbl title="no study has drawn this type: the chapter's Exemplar line says none yet">not drawn yet</Pill>}
    </div>
    <h3 className="research-chart-q" title={t.question ?? t.heading}>{t.question ?? t.heading}</h3>
    {t.readWhen && <p className="research-chart-when" title={t.readWhen}>{t.readWhen}</p>}
    {t.picture && !broken && <button className="research-chart-fig" onClick={ev => open(ev.currentTarget.querySelector('img'))} title={`${t.picture.fig} from ${t.picture.study}: open in the figure viewer`}>
      <img src={t.picture.src} alt={t.question ?? t.heading} decoding="async" onError={() => setBroken(true)} />
    </button>}
    {t.picture && broken && <Empty state="failed" inline>{t.picture.study} has no PNG output tagged {t.picture.fig}</Empty>}
    {e.state === 'named' && t.fault && <Empty state="failed" inline>{t.fault}</Empty>}
    {e.state === 'bad' && <Empty state="failed" inline title="BAD EXEMPLAR">{e.why}</Empty>}
    <details className="research-fd research-chart-fw">
      <summary title="the chapter's framework lines">Framework</summary>
      <div className="b">{FRAMEWORK.map(([label, k]) => t[k].length > 0 && <div key={k} className="research-chart-ln"><div className="research-sec">{label}</div><Markdown text={bullets(t[k])} /></div>)}</div>
    </details>
    <div className="research-chart-foot">
      <button className={`btn sm ${copied ? 'primary' : ''}`} disabled={!t.code} onClick={copy} title={t.code ? 'copy the python that draws this type' : 'the chapter has no python block'}>{copied ? 'Copied' : 'Copy code'}</button>
      {t.picture && <button className="lnk" onClick={() => nav.select('research', t.picture!.study)} title={`open the study that drew it: ${t.picture.study} (${t.picture.fig})`}>{shortName(e.state === 'named' ? e.study : t.picture.study)}</button>}
      <span className="research-fsp" />
      {t.used.length > 0
        ? <UsedBy used={t.used} />
        : <span className="research-faint" title="a study names its figures' kind from its next re-run on; none does for this type yet">no study tags it yet</span>}
    </div>
  </article>
}

function UsedBy({ used }: { used: ChartType['used'] }) {
  const nav = useNav()
  const { studies, figures } = usedBy(used)
  const n = studies.length
  return <span className="research-chart-used" title={used.map(u => `${u.name} ${u.fig}`).join('\n')}>
    {figures > n ? `${figures} figures in ${n} ${n > 1 ? 'studies' : 'study'}` : `used in ${n} ${n > 1 ? 'studies' : 'study'}`}: {studies.map((u, i) => <span key={u.id}>{i > 0 && ', '}<button className="lnk" onClick={() => nav.select('research', u.id)}>{shortName(u.name)}</button></span>)}
  </span>
}
