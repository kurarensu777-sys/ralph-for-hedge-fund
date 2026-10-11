import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { FORMATS, MARKETS, type StudiesPayload, type Study } from '../../../shared/research.ts'
import type { RoomDef } from '../types.ts'
import { Chip, Empty, FailLine, Load, Seg } from '../../ui/kit.tsx'
import { api, useApi, useStored } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { setFocus, useFocusOf } from '../../shell/focus.ts'
import { Edge } from '../../ui/edge.tsx'
import { StudyCard } from './Card.tsx'
import { Charts } from './Charts.tsx'
import { Compare } from './Compare.tsx'
import { StudyTable } from './Table.tsx'
import { SearchBox, useFilter } from './Filters.tsx'
import { COLUMNS, DEFAULT_SORT, GROUP_BY, anyOpen, foldAll, headlineOf, isArchived, isLegacy, listGroups, nextSort, resultCell, shortName, trackList, visibleColumns, type GroupBy, type Sort, type SortKey } from './list.ts'
import { usePins } from './pins.ts'
import { manifestOf, stateWord } from './format.ts'
import { FocusBtn } from './FocusBtn.tsx'
import './research.css'

// ROOM: research - every notebook in platform/research. Three columns: the studies list (here, the
// explorer: one toolbar over one grouped table, B-0284), the study's fixed summary card (read from its
// fund.study/1 manifest, the research craft book the-study-manifest.md) and the notebook itself. The
// link is #/research/<id>, #/research/table, #/research/compare or #/research/charts (the chart bank, Charts.tsx). Read-only: nothing here runs a
// notebook. Each column's right edge drags (the list's is the shell's; the summary's width is kept as
// research.cardw), and each column's focus button makes it fill the window (src/shell/focus.ts).

const Reader = lazy(() => import('./Reader.tsx'))
const useStudies = () => useApi<StudiesPayload>('/api/research/studies', ['research', 'lab'])
const VIEWS_SEL = ['table', 'compare', 'charts']
const KERNEL = 'ccvenv'
const CARD_MIN = 300
const NB_MIN = 360

/** the market squares: ONE filled 8px square for the main market (markets[0]) and an OUTLINED one for each
 *  other, in the study's order; a label off the list is a red mark */
function Squares({ s }: { s: Study }) {
  const l = s.labels
  const tip = l.markets.length ? `${l.markets.map((k, i) => MARKETS[k].label + (i ? '' : ' (main)')).join(', ')}\nfilled square: the main market; outlined: also touches` : 'no market'
  return <span className="c-market" title={[tip, ...l.faults].join('\n')}>
    {l.markets.map((k, i) => <i key={k} className={i ? 'mk-also' : 'mk-main'} style={{ '--mk': `var(--${MARKETS[k].hue})` } as React.CSSProperties} />)}
    {l.faults.length > 0 && <b className="research-fault">!</b>}
  </span>
}

/** the Style cell: the style tag (blue systematic, amber discretionary) with the pace tag (neutral, dashed: it is
 *  derived) stacked under it. A study with neither shows a faint dash, not a hole */
function Tags({ s }: { s: Study }) {
  const { style, pace, from } = s.labels
  if (!style && !pace) return <span className="c-style none" title="no style or pace tag">&ndash;</span>
  return <span className="c-style">
    {style && <span className={`research-tg2 ${style === 'systematic' ? 'sys' : 'dis'}`} title={`${style}: typed by the study, from ${from.style === 'manifest' ? "the manifest's tags.style" : 'platform/research/labels.json'}`}>{style}</span>}
    {pace && <span className="research-tg2 pace" title={`${pace}: derived by platform from the study's own numbers (tags.pace), never typed`}>{pace}</span>}
  </span>
}

const dateTip = (s: Study) => (s.commit ? `the last commit touching the file: ${s.commit.hash} ${s.commit.date}` : 'never committed')

function Row({ s, on, pinned, pick, cols }: { s: Study; on: boolean; pinned: boolean; pick: () => void; cols: SortKey[] }) {
  const r = resultCell(s)
  const h = headlineOf(s)
  const f = s.labels.format
  const odd = s.kernel && s.kernel !== KERNEL ? `kernel ${s.kernel}; research/CLAUDE.md says ${KERNEL}` : null
  return <button className={`research-cols research-row ${on ? 'on' : ''} ${isLegacy(s) ? 'legacy' : ''}`} onClick={pick} title={[s.id, manifestOf(s)?.title, odd].filter(Boolean).join('\n')}>
    <span className="c-name">{s.tag && <span className="research-tagmark">{s.tag}</span>}<span className="nm" title={shortName(s.name)}>{shortName(s.name)}</span>
      {pinned && <span className="research-pin" title="pinned for Compare">&#9679;</span>}
      {odd && <span className="research-kern" title={odd}>kernel</span>}</span>
    <Squares s={s} />
    <Tags s={s} />
    {cols.includes('format') && <span className="c-format" title={f ? FORMATS[f].title : 'no format named'}>{f ? FORMATS[f].label : ''}</span>}
    {cols.includes('result') && <span className={`c-result ${r.tone}`} title={r.why}>{r.word}</span>}
    {cols.includes('lead') && <span className={`c-lead ${h?.tone ?? ''}`} title={h?.title}>{h?.text ?? ''}</span>}
    <span className="c-date" title={dateTip(s)}>{s.commit?.date.slice(5) ?? 'new'}</span>
  </button>
}

function Explorer() {
  const q = useStudies()
  const nav = useNav()
  const sel = nav.sel.research ?? null
  const [flt, setFlt] = useFilter()
  const [by, setBy] = useStored<GroupBy>('research.group', 'market')
  const [legacy, setLegacy] = useStored<boolean>('research.legacy', true)
  const [archive, setArchive] = useStored<boolean>('research.archive', false)
  const [sort, setSort] = useStored<Sort>('research.sort', DEFAULT_SORT)
  const [folds, setFolds] = useStored<Record<string, boolean>>('research.folds', {})
  const pins = usePins()
  // the columns that fit: the list is a container whose width the owner drags
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el); setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [q.data])
  const cols = visibleColumns(width, by)
  return <Load q={q}>{d => {
    if (!d.exists) return <Empty state="failed" inline>platform/research is not on this machine</Empty>
    const groups = listGroups(d.studies, { q: flt.q, by, legacy, archive, sort, folds })
    const open = anyOpen(groups)
    const nLegacy = d.studies.filter(s => s.group === 'studies' && isLegacy(s)).length
    const nArchive = d.studies.filter(isArchived).length
    const foldTip = open ? 'collapse every group' : 'expand every group'
    return <div className="research-list" ref={box}>
      <div className="research-bar">
        <SearchBox f={flt} set={setFlt} sm />
        <label className="research-gsel" title={GROUP_BY.map(([, l, t]) => `${l}: ${t}`).join('\n')}><span>Group</span>
          <select value={by} onChange={e => setBy(e.target.value as GroupBy)}>{GROUP_BY.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>
        </label>
        <Chip sm on={legacy} onClick={() => setLegacy(!legacy)} title={`${legacy ? 'hide' : 'show'} the ${nLegacy} studies with no fund.study/1 manifest yet`}>Legacy</Chip>
        <Chip sm on={archive} disabled={!nArchive} onClick={() => setArchive(!archive)}
          title={nArchive ? `${archive ? 'hide' : 'show'} the ${nArchive} archived studies (superseded and draft: platform/research/archive)` : 'platform/research/archive holds no notebook'}>Archive</Chip>
        <button className="iconbtn research-foldall" onClick={() => setFolds(foldAll(groups, folds))} title={foldTip} aria-label={foldTip}>{open ? '⊟' : '⊞'}</button>
        <FocusBtn part="ex" what="the list" />
      </div>
      {d.labels.problems.length > 0 && <FailLine what="labels.json" detail={d.labels.problems.join('\n')} />}
      <div className="research-grid" style={{ '--cols': trackList(cols) } as React.CSSProperties}>
        <div className="research-cols research-hd">{COLUMNS.filter(c => cols.includes(c[0])).map(([k, label, title]) =>
          <button key={k} className={`c-${k} ${sort.key === k ? 'on' : ''}`} title={`${title}\nclick to sort, again to reverse`} onClick={() => setSort(nextSort(sort, k))}>
            {label}{sort.key === k && <i>{sort.dir < 0 ? '↓' : '↑'}</i>}</button>)}
        </div>
        {groups.length ? groups.map(g => <div key={g.key} className={`research-g ${g.folded ? 'closed' : ''}`}>
          {g.label !== null && <button className="research-grp" title={g.title} onClick={() => setFolds({ ...folds, [g.key]: !g.folded })} aria-expanded={!g.folded}>
            <span className="chev">&#9662;</span><span className="sw" style={g.hue ? { background: `var(--${g.hue})` } : undefined} /><span className="nm">{g.label}</span><span className="n">{g.count}</span>
          </button>}
          {!g.folded && g.rows.map(s => <Row key={`${g.key}:${s.id}`} s={s} on={sel === s.id} pinned={pins.includes(s.id)} pick={() => nav.select('research', s.id)} cols={cols} />)}
        </div>) : <Empty inline>{flt.q ? 'no notebook matches the search' : 'nothing to list'}</Empty>}
      </div>
    </div>
  }}</Load>
}

function Main() {
  const q = useStudies()
  const nav = useNav()
  const [code] = useStored<boolean>('research.code', false)
  // the summary's width, dragged by its edge (unset = the stylesheet's); a focused column fills the window
  const [cardW, setCardW] = useStored<number | null>('research.cardw', null)
  const focus = useFocusOf('research')
  const split = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const sel = nav.sel.research ?? null
  const list = q.data?.studies ?? []
  const study = list.find(s => s.id === sel) ?? null
  // no selection, or one that is gone: the newest study with a manifest, else with a loop run, else any
  useEffect(() => {
    if (!q.data || VIEWS_SEL.includes(sel ?? '') || study) return
    const newest = (xs: Study[]) => [...xs].sort((a, b) => (b.commit?.date ?? '').localeCompare(a.commit?.date ?? ''))[0]
    const st = list.filter(s => s.group === 'studies')
    const first = newest(st.filter(s => manifestOf(s))) ?? newest(st.filter(s => s.loop.length)) ?? newest(st) ?? list[0]
    if (first) nav.settle('research', first.id)
  }, [q.data, sel, study]) // eslint-disable-line react-hooks/exhaustive-deps
  if (sel === 'charts') return <Charts />
  return <Load q={q} skel="doc">{d => {
    if (!d.studies.length) return <Empty title="NO NOTEBOOKS">No .ipynb under {d.root}.</Empty>
    if (sel === 'table') return <StudyTable studies={d.studies} pick={id => nav.select('research', id)} />
    if (sel === 'compare') return <Compare studies={d.studies} pick={id => nav.select('research', id)} />
    if (!study) return <Empty state="loading" skel="doc" />
    return <div ref={split} className={`research-split ${focus ? `focus-${focus}` : ''}`} style={cardW && !focus ? { gridTemplateColumns: `minmax(${CARD_MIN}px, ${cardW}px) minmax(${NB_MIN}px, 1fr)` } : undefined}>
      <div className="research-col-c" ref={card}>
        <div className="research-col-card"><StudyCard s={study} root={d.root} jupyter={d.jupyter} focus={<FocusBtn part="card" what="the summary" />} /></div>
        {!focus && <Edge className="research-edge" title="the summary's width" min={CARD_MIN}
          start={() => card.current?.getBoundingClientRect().width ?? CARD_MIN}
          max={() => (split.current?.getBoundingClientRect().width ?? 0) - NB_MIN}
          set={setCardW} reset={() => setCardW(null)} />}
      </div>
      <div className="research-col-nb">
        <Suspense fallback={<Empty state="loading" skel="doc" />}><Reader key={study.id} id={study.id} code={code} focus={<FocusBtn part="nb" what="the notebook" />} /></Suspense>
      </div>
    </div>
  }}</Load>
}

function Head() {
  const nav = useNav()
  const pins = usePins()
  const [code, setCode] = useStored<boolean>('research.code', false)
  const focus = useFocusOf('research')
  const s = nav.sel.research
  const view = s === 'table' ? 'table' : s === 'compare' ? 'compare' : s === 'charts' ? 'charts' : 'study'
  const [last, setLast] = useStored<string | null>('research.last', null)
  useEffect(() => { if (s && !VIEWS_SEL.includes(s)) setLast(s) }, [s]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="research-head">
    <Seg value={view} options={[{ id: 'study', label: 'Study' }, { id: 'table', label: 'Table' }, { id: 'compare', label: `Compare ${pins.length}` }, { id: 'charts', label: 'Charts' }]}
      onChange={v => nav.select('research', v === 'study' ? last : v)} />
    {view === 'study' && <Chip sm on={code} onClick={() => setCode(!code)} title="show the code cells (folded away by default)">Code</Chip>}
    {focus && focus !== 'ex' && <Chip sm on onClick={() => setFocus(null)} title="one column fills the window: click (or Esc) for the columns">Focus</Chip>}
  </div>
}

export const room: RoomDef = {
  id: 'research',
  label: 'Research',
  title: 'Research',
  icon: <><path d="M4 19V5M4 19h16" /><path d="M7 15l4-4 3 3 5-6" /></>,
  // the list is a seven-column table (B-0284, B-0502; Result, Format and Headline give way when it is narrow): wider than the shell's side list
  explorerWidth: 'clamp(460px, 38vw, 720px)',
  explorerMin: 280,
  Explorer,
  Main,
  Head,
  palette: async nav => {
    const d = await api<StudiesPayload>('/api/research/studies')
    return [
      { kind: 'research', label: 'Compare studies', run: () => nav.go('research', 'table') },
      { kind: 'research', label: 'Compare the 2 pinned', run: () => nav.go('research', 'compare') },
      { kind: 'research', label: 'Chart bank', run: () => nav.go('research', 'charts') },
      ...d.studies.map(s => ({
        kind: 'study', label: s.name, run: () => nav.go('research', s.id),
        hint: [isArchived(s) ? 'archive' : null, s.labels.markets.map(k => MARKETS[k].label).join(' + '), isLegacy(s) ? 'legacy' : stateWord(s).word].filter(Boolean).join(' · '),
      })),
    ]
  },
}
