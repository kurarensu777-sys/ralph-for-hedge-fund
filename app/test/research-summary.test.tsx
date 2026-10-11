import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { manifestProblems, metricsOf, type CardMetric, type Manifest, type Study, type Summary } from '../shared/research.ts'
import { StudyCard } from '../src/rooms/research/Card.tsx'
import { SummaryView } from '../src/rooms/research/Summary.tsx'
import { NavProvider } from '../src/shell/nav.tsx'

// the pins store has no server snapshot; the card's top line needs only an empty list here
vi.mock('../src/rooms/research/pins.ts', () => ({ usePins: () => [], pin: () => false }))

// B-0439 (from B-0399): the fixed summary card (fund.study/1 `summary` = {question, answer, implementation,
// big, blocks, sizes, footer}, platform 0b377e4). The manifest check accepts it with the shape rules the
// card relies on, and the card draws it: question, answer, the facts, the big numbers, the blocks, the
// size table with the chosen row marked, the footer. A manifest without `summary` still draws the
// fixed card.

const met = (metric: string, value: string, bar = '', verdict: CardMetric['verdict'] = '', x: Partial<CardMetric> = {}): CardMetric => ({ metric, value, bar, verdict, ...x })

/** platform's fundplat/quant/tests/test_report.py _carry(), typed across */
function carry(): Manifest {
  const metrics: Record<string, number | null> = {
    ann_return_pct: 26.03, excess_vs_hurdle_pct: 21.92, ann_vol_pct: 14.73, sharpe: 1.75, sortino: 2.65, calmar: 5.8, psr: null, dsr: null,
    max_dd_pct: -4.49, max_dd_days: 23.9, n_periods: 76, periods_per_year: 365, funding_ann_pct: 9.01, basis_ann_pct: 17.29, price_ann_pct: null,
    fees_ann_pct: -0.28, financing_ann_pct: 0.0, mirror_ann_pct: -26.58, funding_pos_share_pct: 58.55, time_in_market_pct: 99.94,
    min_liq_distance_pct: 92.22, turnover_ann: 9.7,
  }
  const summary: Summary = {
    question: 'Does the Example perp pair pay a funding carry that survives its costs?',
    answer: 'Yes at 1x and 3x: +26.0% a year over a 4.11% hurdle, but depth caps the size at 3x.',
    implementation: [['Legs', 'Short xyz:ABC, long xyz:DEF'], ['Venue', 'Acme xyz, cross'], ['Capital', 'USD 1.0M, 0.5M a leg'],
      ['Rebalance', 'none, always held'], ['Stop', '10 pts premium'], ['Costs', '0.9 bp fee + 2 bp slip a fill']],
    big: [
      met('Net return, ann.', '+26.0%', 'hurdle 4.11%', 'PASS', { scope: '1x', key: 'ann_return_pct' }),
      met('Funding carry, ann.', '+9.0%', 'hurdle 4.11%', 'PASS', { scope: '1x', key: 'funding_ann_pct', gate: 'G1' }),
      met('Max drawdown', '-4.5%', 'limit 15%', 'PASS', { scope: '1x', key: 'max_dd_pct' }),
      met('Room at entry', '54.4 pts', 'floor 40', 'FLAG', { scope: '3x' })],
    blocks: [
      { title: 'Return', rows: [met('Funding', '+9.0%', '', '', { key: 'funding_ann_pct' }), met('Premium', '+17.3%'), met('Fees', '-0.3%'), met('Net', '+26.0%', '> 4.11%', 'PASS')] },
      { title: 'Risk', rows: [met('Volatility', '14.7%'), met('Sharpe', '1.75'), met('Max drawdown', '-4.5%', '< 15%', 'PASS')] },
      { title: 'Robustness', rows: [met('Out-of-sample', '+8.9%', '> 4.11%', 'PASS'), met('Cost stress', '+24.5%', '> 0', 'PASS'), met('Timing overlay', 'none', '', 'INFO')] }],
    sizes: { cols: ['Leverage', 'Return', 'Max DD', 'Verdict'], rows: [['1x', '+26.0%', '-4.5%', 'PASS'], ['3x', '+74.1%', '-12.4%', 'FLAG'], ['10x', 'n/r', '-', 'FAIL']], chosen: 1 },
    footer: ['Next test: 3x funding, 7d.', 'Window 07-15 to 09-28, 1 regime, verify 41/41.'],
  }
  return {
    schema: 'fund.study/1', id: '2026-09-example', kind: 'strategy', desk: 'lab/research', title: 'Example perp pair', question: 'Does the pair pay?', status: 'run',
    run: { executed: '2026-09-27T14:43Z', kernel: 'ccvenv', run_id: 'research-009' },
    window: { from: '2026-07-15T07:00Z', to: '2026-09-27T14:00Z', hours: 1808, regimes: 1 }, verify: { suite: 'verify_four', passed: 41, total: 41, books: 3 },
    headline: { metric: 'funding net', value: 2.5, unit: 'pct_ann', hurdle: 4.11, label: 'Funding ann' },
    gates: [['S3', 'Beats T-bill', 'PASS'], ['S3', 'Mirror loses', 'PASS'], ['S4', 'Out of sample', 'PASS'], ['S4', 'Not luck', 'PASS'], ['S4', 'Survives costs', 'PASS'], ['S4', 'Timing rule', 'INFO']]
      .map(([section, name, verdict], i) => ({ id: `G${i + 1}`, section, name, label: name, reading: 'x', verdict, would_change: 'y' })),
    sections: [], figures: [], verdict: { word: '3x' }, caveats: [],
    format: 'carry', metrics, na: { psr: 'not in stats', dsr: 'not in stats', price_ann_pct: 'the premium is the price P&L' },
    profile: { market: 'equities', markets: ['equities'], venues: ['acme:xyz'], instruments: ['ABC', 'DEF'], bar: '1h' },
    summary,
  }
}

const html = (el: JSX.Element) => renderToStaticMarkup(el)
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
/** each <details> of a markup, in order: whether it is open and its summary's text */
const details = (h: string) => [...h.matchAll(/<details([^>]*)><summary[^>]*>(.*?)<\/summary>/g)].map(x => ({ open: /\bopen=""/.test(x[1]), cls: /class="([^"]*)"/.exec(x[1])?.[1] ?? '', head: text(x[2]).trim() }))

describe('manifestProblems accepts the summary card (B-0439)', () => {
  it('the carry fixture with its summary card is a valid manifest', () => {
    expect(carry().metrics && Object.keys(carry().metrics!).sort()).toEqual(metricsOf('carry').map(x => x.key).sort())
    expect(manifestProblems(carry())).toEqual([])
  })
  const broken: [string, (m: any) => void, string][] = [
    ['not an object', m => { m.summary = [] }, 'summary must be {question'],
    ['the old five-block summary', m => { m.summary = { strategy: {}, stats: {}, base: {}, findings: [], verdict: [] } }, 'summary needs question, answer'],
    ['a field missing', m => { delete m.summary.footer }, 'summary needs footer'],
    ['a key the book does not define', m => { m.summary.notes = [] }, 'keys the book does not define: notes'],
    ['a multi-line question', m => { m.summary.question = 'a\nb' }, 'summary.question must be a non-empty one-line'],
    ['no answer', m => { m.summary.answer = '' }, 'summary.answer must be'],
    ['a fact that is not a pair', m => { m.summary.implementation[2] = ['Capital'] }, 'implementation[2] must be [name, fact]'],
    ['no big numbers', m => { m.summary.big = [] }, 'summary.big must be a list'],
    ['a big number with no scope', m => { delete m.summary.big[0].scope }, 'big[0].scope must be'],
    ['a big number lacking a bar', m => { delete m.summary.big[1].bar }, 'big[1].bar must be a one-line string'],
    ['a verdict off the set', m => { m.summary.blocks[0].rows[3].verdict = 'OK' }, 'blocks[0].rows[3].verdict "OK" is not PASS|FAIL|FLAG|INFO or empty'],
    ['a metric key the book does not define', m => { m.summary.blocks[1].rows[0].tag = '[V]' }, 'blocks[1].rows[0] keys the book does not define: tag'],
    ['a metric named twice in a block', m => { m.summary.blocks[1].rows[1].metric = 'Volatility' }, 'names "Volatility" twice'],
    ['a block with no rows', m => { m.summary.blocks[2].rows = [] }, 'blocks[2] must be {title, rows'],
    ['no blocks', m => { m.summary.blocks = [] }, 'summary.blocks must be 1..8'],
    ['nine blocks', m => { m.summary.blocks = Array.from({ length: 9 }, () => m.summary.blocks[0]) }, 'summary.blocks must be 1..8'],
    ['one size column', m => { m.summary.sizes.cols = ['Leverage'] }, 'summary.sizes must be'],
    ['a size row of the wrong width', m => { m.summary.sizes.rows[1].pop() }, 'sizes.rows[1] must hold one cell per column (4)'],
    ['a size row ending off the verdict set', m => { m.summary.sizes.rows[0][3] = 'OK' }, 'sizes.rows[0] ends with "OK"'],
    ['a chosen row that does not exist', m => { m.summary.sizes.chosen = 3 }, 'sizes.chosen 3 is not a row'],
    ['a null chosen under a sizing verdict', m => { m.summary.sizes.chosen = null }, 'sizes.chosen is null, but only a NO SIZE verdict marks no row, the verdict is "3x"'],
    ['a missing chosen key, even under NO SIZE', m => { m.verdict.word = 'NO SIZE'; delete m.summary.sizes.chosen }, 'sizes needs chosen'],
    ['no footer', m => { m.summary.footer = [] }, 'summary.footer must be 1..4'],
    ['five footer lines', m => { m.summary.footer = ['a', 'b', 'c', 'd', 'e'] }, 'summary.footer must be 1..4'],
  ]
  it.each(broken)('refuses: %s', (_label, mut, words) => {
    const m = carry()
    mut(m)
    const p = manifestProblems(m)
    expect(p.some(x => x.includes(words)), p.join('\n')).toBe(true)
  })
  it('accepts the shapes the card allows: an empty verdict, a key and a gate on a metric, 8 blocks, 4 footer lines', () => {
    const m = carry()
    m.summary!.blocks = Array.from({ length: 8 }, (_, i) => ({ title: `Block ${i}`, rows: [met('Funding', '+9.0%', '', '', { key: 'funding_ann_pct', gate: 'G1' })] }))
    m.summary!.footer = ['a', 'b', 'c', 'd']
    expect(manifestProblems(m)).toEqual([])
  })
  it('a NO SIZE study sizes nothing: chosen null is legal and the table draws no pick row', () => {
    const m = carry()
    m.verdict = { word: 'NO SIZE' }
    m.summary!.sizes.chosen = null
    expect(manifestProblems(m)).toEqual([])
    const hn = html(<SummaryView m={m} />)
    expect([...hn.matchAll(/<tr class="([^"]*)"[^>]*><td class="k">([^<]*)/g)].map(x => x[1])).toEqual(['', '', ''])
    expect(hn).not.toContain('pick')
  })
})

describe('the summary card (B-0439)', () => {
  const m = carry()
  const s = m.summary!
  const h = html(<SummaryView m={m} />)
  const t = text(h)

  it('draws the question and the answer, then the six facts', () => {
    expect(h.indexOf('research-sq')).toBeLessThan(h.indexOf('research-sa'))
    expect(t).toContain(s.question)
    expect(t).toContain(s.answer)
    expect(h.match(/<dt /g)).toHaveLength(6)
    expect(t).toContain('Legs Short xyz:ABC, long xyz:DEF')
  })
  it('the four big numbers carry their scope, value, bar and verdict; the tile border follows the verdict', () => {
    const tiles = [...h.matchAll(/<div class="bt ([^"]*)"/g)].map(x => x[1])
    expect(tiles).toEqual(['ok', 'ok', 'ok', 'warn'])
    expect(t).toContain('at 1x Net return, ann. +26.0% PASS hurdle 4.11%')
    expect(t).toContain('at 3x Room at entry 54.4 pts FLAG floor 40')
    expect(h).toContain('title="metric ann_return_pct"')
    expect(h).toContain('title="metric funding_ann_pct · gate G1"')
  })
  it('a big number with no verdict draws no chip and a neutral border', () => {
    const n = carry()
    n.summary!.big[0] = met('Net return, ann.', '+26.0%', '', '', { scope: '1x' })
    const hn = html(<SummaryView m={n} />)
    expect(hn).toContain('class="bt none"')
    expect(text(hn)).toContain('at 1x Net return, ann. +26.0%')
  })
  it('the blocks draw in order, a metric a row of name, value, bar and a verdict chip', () => {
    expect([...h.matchAll(/<h4[^>]*>([^<]*)<\/h4>/g)].map(x => x[1])).toEqual(['Return', 'Risk', 'Robustness'])
    expect([...h.matchAll(/class="met"/g)]).toHaveLength(10)
    expect(t).toContain('Net +26.0% > 4.11% PASS')
    expect(t).toContain('Timing overlay none INFO')
    expect(h).toMatch(/research-st faint[^>]*>INFO/)
    expect(h).toMatch(/research-st fail[^>]*>FAIL/)
    expect(h).toMatch(/research-st warn[^>]*>FLAG/)
  })
  it('the size table marks the chosen row, and only that one', () => {
    const rows = [...h.matchAll(/<tr class="([^"]*)"[^>]*><td class="k">([^<]*)/g)].map(x => [x[2], x[1]])
    expect(rows).toEqual([['1x', ''], ['3x', 'pick'], ['10x', '']])
    expect([...h.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(x => x[1])).toEqual(s.sizes.cols)
    expect(t).toContain('3x +74.1% -12.4% FLAG')
  })
  it('the footer draws every line', () => {
    expect([...h.matchAll(/<div title="([^"]*)">[^<]*<\/div>/g)].map(x => x[1]).slice(-2)).toEqual(s.footer)
  })
  it('text from the manifest is escaped, never read as markup', () => {
    const x = carry()
    x.summary!.answer = '<b>bold</b> & more'
    const hx = html(<SummaryView m={x} />)
    expect(hx).not.toContain('<b>bold</b>')
    expect(hx).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more')
  })
})

describe('the card chooses by the manifest (B-0296)', () => {
  const study = (m: Manifest): Study => ({
    id: 'studies/x.ipynb', name: 'x', tag: null, group: 'studies', bytes: 1, mtime: 0, cells: { markdown: 0, code: 1, executed: 1, images: 0 },
    kernel: 'ccvenv', error: null, manifest: { state: 'ok', cell: 1, manifest: m }, loop: [], commit: null,
    labels: { markets: [], format: null, style: null, pace: null, from: { markets: null, format: null, style: null }, faults: [] },
  })
  vi.stubGlobal('location', { hash: '', href: 'http://127.0.0.1:4688/' })   // NavProvider reads the hash at boot
  const card = (m: Manifest) => html(<NavProvider><StudyCard s={study(m)} root="r" jupyter={null} /></NavProvider>)
  it('with summary: the summary card and none of the fixed card, the top line unchanged', () => {
    const h = card(carry())
    expect(h).toContain('research-sum')
    expect(details(h).filter(d => d.cls === 'research-fd')).toEqual([])
    expect(text(h)).toContain('Example perp pair')
  })
  it('without summary: the fixed card (Overview first), unchanged', () => {
    const m = carry()
    delete m.summary
    const heads = details(card(m)).filter(d => d.cls === 'research-fd').map(d => d.head.split(' ')[0])
    expect(heads.slice(0, 5)).toEqual(['Overview', 'Trade', 'Result', 'Gates', 'Metrics'])
    expect(card(m)).not.toContain('research-sum')
  })
})
