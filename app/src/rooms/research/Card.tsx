import { useMemo, useState, type ReactNode } from 'react'
import { FORMATS, MARKETS, type LabelSource, type LoopLink, type Manifest, type Study } from '../../../shared/research.ts'
import { Empty, Pill, Tag } from '../../ui/kit.tsx'
import { useNav } from '../../shell/nav.tsx'
import {
  RESULT_KEYS, SECTION_WORDS, day, fmtMetric, formatOf, gateCounts, gateGrid, gateHover, gateTone, gateWord,
  headlineOfManifest, manifestOf, metricGroups, metricOf, stateWord, toneOf, unitText, verdictTone,
} from './format.ts'
import { Fold } from './Fold.tsx'
import { MAX_PINS } from './list.ts'
import { pin, usePins } from './pins.ts'
import { SummaryView } from './Summary.tsx'
import { Questions } from './Questions.tsx'

// THE SUMMARY CARD (the owner, 2026-09-27, B-0275): ONE fixed layout for every notebook. The same
// sections in the same order, each a fold whose caps label is the button: OVERVIEW, TRADE, RESULT,
// GATES, METRICS open; P&L, WHY, NEXT, CAVEATS, PARAMS, NOTEBOOK folded. A place never moves: an
// absent field reads `none` or `n/a` in it. Nothing is computed: every value and every label is the
// manifest's (the manifest book, "The fixed card"); counting gates is the one arithmetic. A manifest
// from before the fixed card falls back to its older fields (gate id + name, strategy.venues, no Legs).
// A manifest carrying `summary` (B-0399) draws the summary card instead (Summary.tsx). Either card ends in the Questions block (B-0524).

export function StudyCard({ s, root, jupyter, focus }: { s: Study; root: string; jupyter: string | null; focus?: ReactNode }) {
  const m = manifestOf(s)
  return <div className="research-card">
    <Top s={s} m={m} root={root} jupyter={jupyter} focus={focus} />
    {m ? <>{m.summary ? <SummaryView m={m} /> : <ManifestView s={s} m={m} />}<Questions id={s.id} m={m} /></> : <NoManifest s={s} />}
  </div>
}

// ---- the top line: file id, four actions, the title and the verdict ----

const ICO: Record<string, string> = {
  open: 'M9 3h4v4M13 3L7.5 8.5M11.5 9.5v3.5h-8.5v-8.5h3.5',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  pin: 'M8 2.5a3 3 0 0 1 3 3c0 2.4-3 5.5-3 5.5s-3-3.1-3-5.5a3 3 0 0 1 3-3zM8 11v2.5',
  compare: 'M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13',
}
const Ico = ({ d }: { d: string }) => <svg className="ico" viewBox="0 0 16 16"><path d={ICO[d]} /></svg>

function Top({ s, m, root, jupyter, focus }: { s: Study; m: Manifest | null; root: string; jupyter: string | null; focus?: ReactNode }) {
  const nav = useNav()
  const pins = usePins()
  const [copied, setCopied] = useState(false)
  const pinned = pins.includes(s.id)
  const others = pins.filter(x => x !== s.id)
  const w = stateWord(s)
  const path = `${root}/${s.id}`
  const href = jupyter ? `${jupyter.replace(/\/+$/, '')}/tree/${s.id.split('/').map(encodeURIComponent).join('/')}` : null
  const copy = () => { void navigator.clipboard?.writeText(path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }
  const pinFull = !pinned && pins.length >= MAX_PINS
  return <>
    <div className="research-top">
      <span className="id" title={path}>{s.tag ? `[${s.tag}] ` : ''}{s.name}</span>
      <span className="research-act">
        {href ? <a className="iconbtn" href={href} target="_blank" rel="noreferrer" title={`Open in JupyterLab (${href}); start it in the Dash room if it is down`}><Ico d="open" /></a>
          : <button className="iconbtn" disabled title="JupyterLab is not registered (no dashboards/jupyter/dashboard.json)"><Ico d="open" /></button>}
        <button className={`iconbtn ${copied ? 'on' : ''}`} onClick={copy} title={copied ? 'copied' : `Copy path: ${path}`}><Ico d="copy" /></button>
        <button className={`iconbtn ${pinned ? 'on' : ''}`} disabled={pinFull} onClick={() => pin(s.id)}
          title={pinned ? 'Pinned: click to unpin' : pinFull ? `${MAX_PINS} pinned: unpin one first` : 'Pin (at most 2, for Compare)'}><Ico d="pin" /></button>
        <CompareBtn pinned={pinned} others={others} go={() => nav.select('research', 'compare')} />
        {focus}
      </span>
    </div>
    <div className="research-title">
      <div className="t" title={m?.question ?? s.id}>{m?.title ?? s.name}</div>
      <Pill tone={w.tone} title={w.why}>{w.word}</Pill>
    </div>
  </>
}

function CompareBtn({ pinned, others, go }: { pinned: boolean; others: string[]; go: () => void }) {
  const pins = usePins()
  const ok = pinned && pins.length === MAX_PINS
  return <button className="iconbtn" disabled={!ok} onClick={go}
    title={ok ? 'Compare the 2 pinned side by side' : pinned ? `pin ${MAX_PINS - pins.length} more to compare` : others.length ? 'pin this one too to compare it' : 'pin 2 of one format to compare'}><Ico d="compare" /></button>
}

/** one tile: a caps label over its value; `none` / `n/a` are drawn faint */
function Tile({ k, v, tone, wide, big, title, kTitle }: { k: string; v: ReactNode; tone?: string; wide?: boolean; big?: boolean; title?: string; kTitle?: string }) {
  const na = v === 'none' || v === 'n/a'
  return <div className={`research-tl ${wide ? 'w' : ''}`} title={title}>
    <div className="k" title={kTitle}>{k}</div>
    <div className={`v ${na ? 'na' : tone ?? ''} ${big ? 'big' : ''}`}>{v}</div>
  </div>
}

const list = (xs: string[] | undefined) => (xs?.length ? xs.join(', ') : 'none')
const lines = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : [])
/** a string with its [U] tags drawn amber (an unverified number, the manifest's own tag) */
const tagged = (t: string) => t.split(/(\[U\])/).map((x, i) => (x === '[U]' ? <i key={i} className="u">[U]</i> : x))

// ---- a manifest ----

function ManifestView({ s, m }: { s: Study; m: Manifest }) {
  return <>
    <Overview s={s} m={m} />
    <Trade m={m} />
    <Result m={m} />
    <Gates m={m} />
    <Metrics m={m} />
    <Pnl m={m} />
    <Fold id="why" label="Why" badge={lines(m.verdict.why).length || 'none'}>
      {lines(m.verdict.why).length ? lines(m.verdict.why).map((w, i) => <div key={i} className="research-ln wrap" title={w}>{w}</div>) : <div className="research-ln na">none</div>}
    </Fold>
    <Next m={m} />
    <Fold id="caveats" label="Caveats" badge={m.caveats.length || 'none'}>
      {m.caveats.length ? m.caveats.map((c, i) => <div key={i} className="research-ln dim wrap" title={c}>{c}</div>) : <div className="research-ln na">none</div>}
    </Fold>
    <Params m={m} />
    <Notebook s={s} m={m} />
  </>
}

const FROM: Record<LabelSource, string> = {
  manifest: "the manifest's profile.markets", 'labels.json': 'platform/research/labels.json', 'profile.market': "the manifest's old single market",
  name: 'the market word in the file name', 'naming book': "the naming book's row for this legacy name",
}

/** MARKET: one square and name per market (B-0284), where they were read, and any value off the list */
function marketTile(s: Study) {
  const l = s.labels
  const title = [l.markets.length ? `from ${FROM[l.from.markets!]}` : 'no profile.markets, no labels.json row, no live market word in the file name', ...l.faults].join('\n')
  return <Tile k="Market" wide={l.markets.length > 1 || l.faults.length > 0} title={title} v={l.markets.length || l.faults.length
    ? <span className="research-mks">{l.markets.map(k => <span key={k} className="research-mkn"><i style={{ background: `var(--${MARKETS[k].hue})` }} />{MARKETS[k].label}</span>)}
      {l.faults.length > 0 && <span className="research-fault" title={l.faults.join('\n')}>{l.faults.length === 1 ? 'bad label' : `${l.faults.length} bad labels`}</span>}</span>
    : 'none'} />
}

/** FORMAT: the manifest's, else labels.json's */
function formatTile(s: Study) {
  const f = s.labels.format
  return <Tile k="Format" v={f ? FORMATS[f].label : 'none'} title={f ? `${FORMATS[f].title}\nfrom ${FROM[s.labels.from.format!]}` : 'neither the manifest nor labels.json names a format'} />
}

/** STYLE: the style tag, then the pace tag when the manifest carries one (platform derives it; this reads it) */
function styleTile(s: Study) {
  const { style, pace, from } = s.labels
  const v = [style, pace].filter(Boolean).join(' · ')
  const src = from.style === 'manifest' ? "the manifest's tags.style" : 'platform/research/labels.json'
  const title = style ? `style from ${src}${pace ? '\npace: tags.pace, derived by platform from the numbers of the study' : ''}` : 'neither the manifest nor labels.json names a style'
  return <Tile k="Style" v={v || 'none'} title={title} />
}

function Overview({ s, m }: { s: Study; m: Manifest }) {
  const p = m.profile
  const regimes = m.window.regimes
  const verifyOk = m.verify.passed === m.verify.total
  return <Fold id="overview" label="Overview">
    <div className="research-tg">
      {marketTile(s)}
      {formatTile(s)}
      {styleTile(s)}
      <Tile k="Status" v={m.status} tone={m.status === 'registered' ? 'ok' : ''} title={m.status === 'registered' ? 'a results-log.md pre-registration exists for this run' : 'not a registered run: not a recorded result'} />
      <Tile wide k="Venues" v={list(p?.venues ?? m.strategy?.venues)} title={p ? 'profile.venues' : 'strategy.venues (a manifest from before the fixed card)'} />
      <Tile wide k="Instruments" v={list(p?.instruments ?? m.strategy?.instruments)} title={p ? 'profile.instruments' : 'strategy.instruments (a manifest from before the fixed card)'} />
      <Tile k="Start" v={day(m.window.from)} title={m.window.from} />
      <Tile k="End" v={day(m.window.to)} title={m.window.to} />
      <Tile k="Hours" v={m.window.hours !== undefined ? m.window.hours.toLocaleString('en-US') : 'n/a'} />
      <Tile k="Bar" v={p?.bar ?? 'n/a'} title="profile.bar: the data interval" />
      <Tile k="Regimes" v={regimes !== undefined ? String(regimes) : 'n/a'} tone={regimes === 1 ? 'warn' : ''} title="how-a-belief-moves.md: one window, one regime, is one observation: WEAK however large the number" />
      <Tile k="Verify" v={`${m.verify.passed}/${m.verify.total}`} tone={verifyOk ? 'ok' : 'fail'} title={`${m.verify.suite ?? ''}${m.verify.books ? ` · ${m.verify.books} books` : ''}`} />
      <Tile k="Kind" v={m.kind} />
      <Tile k="Ran" v={m.run.executed ? day(m.run.executed) : 'n/a'} title={m.run.executed} />
      <Tile k="Run id" v={m.run.run_id ?? 'none'} title="run.run_id: the ledger run this execution is" />
    </div>
  </Fold>
}

const RULES: [keyof NonNullable<Manifest['rules']>, string][] = [['entry', 'Entry'], ['exit', 'Exit'], ['hold', 'Hold'], ['sizing', 'Sizing'], ['hedge', 'Hedge'], ['stop', 'Stop'], ['cost', 'Costs']]
const sideTone = (side: string) => (/^(SHORT|SELL)$/i.test(side) ? 'fail' : /^(LONG|BUY)$/i.test(side) ? 'ok' : 'faint')

function Trade({ m }: { m: Manifest }) {
  if (m.kind === 'market' || m.kind === 'event') return <Fold id="trade" label="Trade">
    <dl className="research-kv"><dt>Legs</dt><dd className="na">none - no position</dd></dl>
  </Fold>
  const legs = m.book?.legs
  return <Fold id="trade" label="Trade" badge={m.book?.at} title={m.book?.at ? `book.at: the size the amounts are at` : undefined}>
    <dl className="research-kv">
      {legs && <><dt>Legs</dt><dd className="legs">{legs.map((l, i) => <div key={i} className="research-leg">
        <Pill tone={sideTone(l.side)}>{l.side}</Pill>
        <span className="in" title={l.instrument}>{l.instrument}</span>
        <span className="u">{l.usd !== undefined ? `USD ${Math.round(l.usd).toLocaleString('en-US')}` : l.qty !== undefined ? `${l.qty.toLocaleString('en-US')}${l.unit ? ` ${l.unit}` : ''}` : ''}</span>
        {l.account && <span className="a">{l.account}</span>}
      </div>)}</dd></>}
      {RULES.map(([k, label]) => {
        const v = m.rules?.[k]
        return <div key={k} className="research-kvr"><dt>{label}</dt><dd className={v ? '' : 'na'} title={v ?? `rules.${k} is ${v === null ? 'none' : 'not in this manifest'}`}>{v ? tagged(v) : 'none'}</dd></div>
      })}
    </dl>
  </Fold>
}

function Result({ m }: { m: Manifest }) {
  const f = formatOf(m)
  const h = m.headline
  const hd = headlineOfManifest(m)
  const g = gateCounts(m.gates)
  const core = (key: string, label: string) => {
    const mt = f ? metricOf(f, key) : undefined
    if (!f || !mt) return <Tile key={key} k={label} v="n/a" title={f ? `the ${FORMATS[f].label} format carries no ${label}` : 'this manifest names no format'} />
    const v = m.metrics?.[key] ?? null
    const t = fmtMetric(mt, v)
    return <Tile key={key} k={label} v={t ?? 'n/a'} tone={key === 'max_dd_pct' ? (v !== null && v < 0 ? 'fail' : '') : toneOf(mt, v)} title={t === null ? `n/a: ${m.na?.[key] ?? 'no reason given'}` : mt.title} />
  }
  return <Fold id="result" label="Result">
    <div className="research-tg">
      <Tile big k="Verdict" v={m.verdict.word} tone={verdictTone(m.verdict.word) === 'faint' ? '' : verdictTone(m.verdict.word)} />
      {h ? <Tile big k={hd!.label} kTitle={h.metric} v={hd!.text} tone={hd!.verdict ? hd!.tone : undefined} title={hd!.title} /> : <Tile big k="Headline" v="none" />}
      <Tile big k="Hurdle" v={hd?.hurdle ?? 'none'} />
      {RESULT_KEYS.map(k => core(k, k === 'ann_return_pct' ? 'Ann return' : k === 'sharpe' ? 'Sharpe' : 'Max DD'))}
      <Tile k="Gates pass" v={String(g.pass)} tone={g.pass ? 'ok' : ''} />
      <Tile k="Fail" v={String(g.fail)} tone={g.fail ? 'fail' : ''} />
      <Tile k="Flag" v={String(g.flag)} tone={g.flag ? 'warn' : ''} />
    </div>
  </Fold>
}

function Gates({ m }: { m: Manifest }) {
  const grid = useMemo(() => gateGrid(m.gates), [m.gates])
  const dirs = grid.directions
  const pick = dirs.length ? m.gates.filter(g => g.direction === dirs[0]) : m.gates
  const c = gateCounts(pick)
  const badge = `${dirs.length ? `${dirs[0]} ` : ''}${c.pass}/${c.pass + c.fail + c.flag}`
  const secTitle = (id: string) => m.sections.find(x => x.id === id)?.title ?? id
  const pill = (v: string, title: string) => <Pill tone={gateTone(v)} title={title}>{v}</Pill>
  if (!m.gates.length) return <Fold id="gates" label="Gates" badge="none"><Empty inline>no gates</Empty></Fold>
  return <Fold id="gates" label="Gates" badge={badge} title="passed / gates that pass, fail or flag (INFO and N/A are not counted)">
    {dirs.length
      ? <div className="research-g2" style={{ gridTemplateColumns: `minmax(0, 1fr) repeat(${dirs.length}, max-content)` }}>
        <span />{dirs.map(d => <span key={d} className="hd">{d.toUpperCase()}</span>)}
        {grid.sections.map(sec => <div key={sec.id} className="research-gsec-w" style={{ display: 'contents' }}>
          <div className="research-gsec" title={`${sec.id} · ${secTitle(sec.id)}`}>{SECTION_WORDS[sec.id] ?? sec.id}</div>
          {sec.rows.map((r, i) => <div key={i} style={{ display: 'contents' }}>
            <span className="nm" title={gateHover(Object.values(r.by)[0])}>{r.text}</span>
            {dirs.map(d => { const g = r.by[d]; return <span key={d} className="c">{g ? pill(gateWord(g), gateHover(g)) : <span className="research-faint">-</span>}</span> })}
          </div>)}
        </div>)}
      </div>
      : grid.sections.map(sec => <div key={sec.id}>
        <div className="research-gsec" title={`${sec.id} · ${secTitle(sec.id)}`}>{SECTION_WORDS[sec.id] ?? sec.id}</div>
        {sec.rows.map((r, i) => { const g = r.by['']; const v = gateWord(g); return <div key={i} className={`research-gr ${v === 'PASS' ? 'dim' : ''}`} title={gateHover(g)}>
          {pill(v, g.verdict)}<span className="nm">{r.text}</span>
        </div> })}
      </div>)}
  </Fold>
}

function Metrics({ m }: { m: Manifest }) {
  const f = formatOf(m)
  if (!f) return <Fold id="metrics" label="Metrics" badge="none"><Empty inline title="NO FORMAT">this manifest names no format, so it carries no metrics block</Empty></Fold>
  const nulls: { label: string; why: string }[] = []
  return <Fold id="metrics" label="Metrics" badge={FORMATS[f].label} title={FORMATS[f].title}>
    {metricGroups(f, m.tags?.pace).map(([name, keys]) => {
      const tiles = keys.map(k => {
        const mt = metricOf(f, k)!
        const v = m.metrics![k] ?? null
        const t = fmtMetric(mt, v)
        if (t === null) { nulls.push({ label: mt.label, why: `${mt.label}: ${m.na?.[k] ?? 'no reason given'}` }); return null }
        return <Tile key={k} k={mt.label} v={t} tone={toneOf(mt, v)} title={mt.title} />
      }).filter(Boolean)
      return tiles.length ? <div key={name}><div className="research-mgp">{name}</div><div className="research-tg">{tiles}</div></div> : null
    })}
    {nulls.length > 0 && <div className="research-nal">n/a <span title={nulls.map(n => n.why).join('\n')}>{nulls.map(n => n.label).join(' · ')}</span></div>}
  </Fold>
}

function Pnl({ m }: { m: Manifest }) {
  const rows = (m.components ?? []).filter(c => typeof c.ann_pct === 'number' || typeof c.usd === 'number')
  return <Fold id="pnl" label="P&L" badge={rows.length || 'none'} title="the lottery and the craft: the total is mostly beta, the components are what a result can teach">
    {!!m.equity?.length && <Equity pts={m.equity} />}
    {rows.length ? <Components rows={rows} /> : <div className="research-ln na">no components</div>}
  </Fold>
}

function Next({ m }: { m: Manifest }) {
  const n = m.verdict.next
  return <Fold id="next" label="Next" badge={n || m.verdict.next_bet ? undefined : 'none'}>
    {n ? <dl className="research-kv">
      {(['metric', 'predict', 'window'] as const).map(k => <div key={k} className="research-kvr"><dt>{k}</dt><dd className={n[k] ? '' : 'na'}>{n[k] ?? 'none'}</dd></div>)}
    </dl> : m.verdict.next_bet ? <div className="research-prose" title="verdict.next_bet (a manifest from before the fixed card: no verdict.next)">{m.verdict.next_bet}</div> : <div className="research-ln na">none</div>}
    {n && m.verdict.next_bet && <div className="research-prose dim">{m.verdict.next_bet}</div>}
  </Fold>
}

function Params({ m }: { m: Manifest }) {
  const ps = Object.entries(m.params ?? {})
  return <Fold id="params" label="Params" badge={ps.length || 'none'}>
    {ps.length ? ps.map(([k, p]) => <div key={k} className="research-pr">
      <span>{k}</span><span>{String(p.value)}{p.unit ? ` ${p.unit}` : ''}</span>
      <span>{p.source && (p.source === '[U]' ? <i className="u">[U]</i> : <Tag tone={p.source === '[V]' ? 'ok' : 'faint'}>{p.source}</Tag>)}</span>
    </div>) : <div className="research-ln na">none</div>}
  </Fold>
}

function Notebook({ s, m }: { s: Study; m: Manifest | null }) {
  const ok = m ? m.sections.filter(x => x.status === 'ok').length : 0
  return <Fold id="notebook" label="Notebook" badge={m ? `${ok}/${m.sections.length} sections` : undefined}>
    {m && <div className="research-sections">{m.sections.map(x => {
      const na = x.status !== 'ok'
      const figs = m.figures.filter(f => f.section === x.id).length
      return <span key={x.id} className={`research-secchip ${na ? 'na' : ''}`} title={`${x.title ?? x.id}${x.question ? `: ${x.question}` : ''}\n${x.status}${figs ? `\n${figs} figure${figs === 1 ? '' : 's'}` : ''}`}>{x.id}{figs ? <i>{figs}</i> : null}</span>
    })}</div>}
    <Facts s={s} m={m} />
  </Fold>
}

function Facts({ s, m }: { s: Study; m: Manifest | null }) {
  const kernelOk = s.kernel === 'ccvenv'
  return <div className="research-nbfacts">
    {m?.run.executed && <span title="run.executed">ran {m.run.executed.replace('T', ' ')}</span>}
    <span className={kernelOk ? '' : 'warn'} title={kernelOk ? 'the fund .venv kernel' : 'research/CLAUDE.md: every notebook runs on ccvenv'}>{s.kernel ?? 'no kernel'}</span>
    <span title="code cells executed / code cells">{s.cells.executed}/{s.cells.code} cells</span>
    <span>{s.cells.images} figs</span>
    <span>{s.bytes >= 1e6 ? `${(s.bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(s.bytes / 1e3))} KB`}</span>
    <span title="the last commit touching the file">{s.commit ? `${s.commit.hash} ${s.commit.date}` : 'never committed'}</span>
  </div>
}

function Components({ rows }: { rows: NonNullable<Manifest['components']> }) {
  const val = (c: { usd?: number; ann_pct?: number }) => (typeof c.ann_pct === 'number' ? c.ann_pct : c.usd ?? 0)
  const max = Math.max(...rows.map(c => Math.abs(val(c))), 1e-9)
  return <div className="research-comps">{rows.map(c => {
    const v = val(c), w = Math.abs(v) / max * 50
    const label = typeof c.ann_pct === 'number' ? `${c.ann_pct > 0 ? '+' : ''}${c.ann_pct.toFixed(2)}%` : `USD ${Math.round(c.usd!).toLocaleString('en-US')}`
    return <div key={c.name} className="research-comp" title={typeof c.usd === 'number' ? `USD ${Math.round(c.usd).toLocaleString('en-US')}` : undefined}>
      <span className="nm" title={c.name}>{c.name}</span>
      <span className="bar"><span className={v >= 0 ? 'pos' : 'neg'} style={v >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} /></span>
      <span className={`val ${v > 0 ? 'ok' : v < 0 ? 'fail' : ''}`}>{label}</span>
    </div>
  })}</div>
}

function Equity({ pts }: { pts: [string, number][] }) {
  const d = useMemo(() => {
    const ys = pts.map(p => p[1])
    const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1
    return pts.map((p, i) => `${(i / Math.max(pts.length - 1, 1) * 100).toFixed(2)},${(38 - (p[1] - lo) / span * 36).toFixed(2)}`).join(' ')
  }, [pts])
  const first = pts[0], last = pts[pts.length - 1]
  const usd = (v: number) => `USD ${Math.round(v).toLocaleString('en-US')}`
  return <div className="research-eq" title={`equity, ${pts.length} points`}>
    <svg viewBox="0 0 100 40" preserveAspectRatio="none"><polyline points={d} className={last[1] >= first[1] ? 'up' : 'down'} vectorEffect="non-scaling-stroke" /></svg>
    <div className="research-eq-l"><span>{day(first[0])} {usd(first[1])}</span><span>{day(last[0])} {usd(last[1])}</span></div>
  </div>
}

// ---- no manifest: the honest state, what the loop recorded, the notebook's facts ----

function NoManifest({ s }: { s: Study }) {
  const w = stateWord(s)
  return <>
    <div className="research-stateline">{w.why}</div>
    {s.manifest.state === 'invalid' && <ul className="research-probs">{s.manifest.problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
    <Fold id="overview" label="Overview">
      <div className="research-tg">
        {s.group === 'studies' ? marketTile(s) : <Tile k="Folder" v={s.group} />}
        {s.group === 'studies' ? formatTile(s) : <Tile k="Format" v="n/a" title="only a study carries a format" />}
        <Tile k="Status" v={w.word} tone={w.tone === 'faint' ? '' : w.tone} title={w.why} />
        <Tile k="Run id" v={s.loop[0]?.run ?? 'none'} title={s.loop[0] ? `the newest loop record naming this notebook (${s.loop[0].desk})` : 'no loop run names this notebook'} />
        <Tile k="Last commit" v={s.commit?.date ?? 'none'} title={s.commit ? s.commit.hash : 'never committed'} />
      </div>
    </Fold>
    {s.loop.map(l => <Loop key={l.key} l={l} />)}
    <Notebook s={s} m={null} />
  </>
}

function Loop({ l }: { l: LoopLink }) {
  const g = Object.entries(l.graded)
  const hits = g.filter(([, v]) => v.verdict === 'hit').length
  return <Fold id="loop" label="Loop result" badge={l.run} title={`app/loop/tools recorded this run (${l.desk}); its numbers are what record.py stored, not a manifest`}>
    {l.headline ? <div className="research-prose">{l.headline}</div> : <div className="research-ln na">no headline</div>}
    <div className="research-tg research-gap">
      <Tile k="Window" wide v={l.window ? `${day(l.window.from)} -> ${day(l.window.to)}` : 'n/a'} title={l.window ? `${l.window.hours ? `${l.window.hours.toLocaleString('en-US')} h` : 'hours not recorded'} · ${l.window.regimes ?? '?'} regimes` : 'the run row carries no window'} />
      <Tile k="Verify" v={l.verify ? `${l.verify.passed ?? '?'}/${l.verify.total ?? '?'}` : 'n/a'} tone={l.verify && l.verify.passed === l.verify.total ? 'ok' : ''} title={l.verify?.suite} />
      <Tile k="Stage" v={l.stage === 'preflight' ? 'preflight' : 'result'} tone={l.stage === 'preflight' ? 'warn' : ''} />
      <Tile k="Hurdle" v={l.comparator ? unitText(l.comparator.value ?? '?', l.comparator.unit) : 'none'} title={l.comparator ? `${l.comparator.name ?? ''} ${l.comparator.provenance ?? ''}` : undefined} />
    </div>
    {g.length > 0 && <>
      <div className="research-mgp">PREDICTED VS ACTUAL <span className="research-faint">{hits}/{g.length} in band</span></div>
      <div className="research-bands">{g.map(([k, v]) => <div key={k} className={`research-band ${v.verdict === 'hit' ? 'ok' : 'warn'}`} title={`pre-registered ${v.band}, actual ${v.actual}: ${v.verdict}`}>
        <div className="k">{k}</div><div className="v">{v.actual}</div><div className="b">{v.band} · {v.verdict}</div>
      </div>)}</div>
    </>}
  </Fold>
}
