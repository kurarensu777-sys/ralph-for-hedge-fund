// THE STUDY MANIFEST (fund.study/1): the one object a research notebook hands downstream, emitted by
// the last cell of its S7 as a display output under STUDY_MIME. The contract is the research craft
// book app/library/research/research.md#manifest-and-labels; the builder and
// validator are platform's (board B-0240), the notebooks adopt it as they are rebuilt. This file is
// the cockpit's reading of it: the Research room reads, never computes (a number the room needs is
// a manifest field, never derived here).
//
// THE FORMATS (the owner, 2026-09-27): a study that has numbers to compare names its `format`, and
// its `metrics` block then carries EVERY key of that format, in that order, a null with its reason in
// `na`. One format per kind of investigation, so studies of one format compare column for column
// and studies of different formats are never ranked against each other. `strategy`, `rules`,
// `params` and `equity` are optional beside it. The formats are filed in the manifest book.
// ANY STUDY MAY TAKE ANY FORMAT (the owner, 2026-10-04, B-0441): the format is the author's choice, not
// fixed by the kind or the desk; both validators accept each of the five for every study, and the card
// shows every metric of the chosen format. A study that simulates P&L takes carry, directional or
// short_vol (they hold the risk-adjusted set); rel_value stays per opportunity with no P&L series.
// `mft` stopped being a format (the owner, 2026-10-05, B-0502): how often a rule trades is the pace TAG,
// read off the study's own numbers by platform (report.pace_of) and shown here, never computed here.
// The format list is held key for key against platform report.FORMATS and the manifest book by
// platform test_report.t_formats_equal_the_book_and_the_cockpit.

export const STUDY_MIME = 'application/vnd.fund.study+json'
export const STUDY_SCHEMA = 'fund.study/1'
export const KINDS = ['strategy', 'market', 'event', 'venue'] as const
export const SECTION_IDS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'] as const

/** one metric: its key, a short label, its unit, whether a higher value is better (coloured by sign
 *  only then), and what it is. Units: % pct, x a multiple, bps, pts vol points, usd, h, d, n a count,
 *  '' a ratio. */
export type Metric = { key: string; label: string; unit: '%' | 'x' | 'bps' | 'pts' | 'usd' | 'h' | 'd' | 'n' | ''; good: boolean; title: string }
const m = (key: string, label: string, unit: Metric['unit'], good: boolean, title: string): Metric => ({ key, label, unit, good, title })

/** the ratios every P&L format carries first */
const CORE: Metric[] = [
  m('ann_return_pct', 'Ann ret', '%', true, 'annualized return on equity'),
  m('excess_vs_hurdle_pct', 'vs hurdle', '%', true, 'annualized return over the hurdle (the study names it)'),
  m('ann_vol_pct', 'Vol', '%', false, 'annualized volatility of the period returns'),
  m('sharpe', 'Sharpe', '', true, 'mean / st.dev x sqrt(periods per year); no risk-free subtracted unless the study says so'),
  m('sortino', 'Sortino', '', true, 'mean / downside deviation x sqrt(periods per year)'),
  m('calmar', 'Calmar', '', true, 'annualized return / |max drawdown|'),
  m('psr', 'PSR', '', false, 'probabilistic Sharpe: the chance the true Sharpe is above 0, given n, skew and kurtosis'),
  m('dsr', 'DSR', '', false, 'deflated Sharpe: PSR after the number of trials the study tried'),
  m('max_dd_pct', 'Max DD', '%', false, 'deepest peak-to-trough fall of equity'),
  m('max_dd_days', 'DD days', 'd', false, 'longest time under a previous peak'),
  m('n_periods', 'Periods', 'n', false, 'the return periods the ratios were computed on'),
  m('periods_per_year', 'Per year', 'n', false, 'the periods per year the ratios annualize by: declared by the study, never assumed'),
]

export const FORMATS = {
  carry: {
    label: 'Carry', lead: 'funding_ann_pct',
    title: 'hold a funding, basis or rate differential: perp carry, cash-and-carry, a hedged pair. The craft is the funding term; price and basis are the lottery.',
    metrics: [...CORE,
      m('funding_ann_pct', 'Funding', '%', true, 'funding captured, annualized on equity'),
      m('basis_ann_pct', 'Basis', '%', false, 'premium or basis drift, annualized on equity'),
      m('price_ann_pct', 'Price', '%', false, 'unhedged price P&L, annualized on equity'),
      m('fees_ann_pct', 'Fees', '%', false, 'fees and slippage, annualized on equity'),
      m('financing_ann_pct', 'Financing', '%', false, 'borrow and financing, annualized on equity'),
      m('mirror_ann_pct', 'Mirror', '%', false, 'the opposite book: if it also pays, the P&L is drift, not the thesis'),
      m('funding_pos_share_pct', 'Paid share', '%', false, 'share of funding settlements that paid the book'),
      m('time_in_market_pct', 'In market', '%', false, 'share of the window the book held a position'),
      m('min_liq_distance_pct', 'Liq dist', '%', false, 'the closest the book came to liquidation, as a price move'),
      m('turnover_ann', 'Turnover', 'x', false, 'annual traded notional / equity'),
    ],
  },
  directional: {
    label: 'Directional', lead: 'sharpe',
    title: 'take a view on price from a signal: trend, momentum, mean reversion, a rule traded often. Judged per trade; the edge per trade against its cost is read when the pace tag is intraday.',
    metrics: [...CORE,
      m('total_return_pct', 'Total', '%', true, 'total return over the window'),
      m('n_trades', 'Trades', 'n', false, 'round trips over the window'),
      m('trades_per_day', 'A day', 'n', false, 'round trips per trading day'),
      m('hit_rate_pct', 'Hit rate', '%', false, 'share of trades that made money'),
      m('profit_factor', 'Profit f', '', false, 'gross profit / gross loss (above 1 makes money)'),
      m('expectancy_bps', 'Expect', 'bps', true, 'mean P&L per trade, on one leg\'s notional'),
      m('win_loss_ratio', 'Win/loss', '', false, 'mean winning trade / mean losing trade'),
      m('avg_hold_h', 'Avg hold', 'h', false, 'mean holding time per trade'),
      m('exposure_pct', 'Exposure', '%', false, 'share of the window with a position on'),
      m('turnover_ann', 'Turnover', 'x', false, 'annual traded notional / equity'),
      m('fees_pct_of_gross', 'Fees', '%', false, 'fees as a share of gross P&L'),
      m('worst_period_pct', 'Worst', '%', false, 'the worst single period'),
      m('gross_edge_bps', 'Gross edge', 'bps', true, 'mean P&L per trade before costs'),
      m('cost_bps', 'Cost', 'bps', false, 'round-trip fees plus slippage per trade'),
      m('breakeven_cost_bps', 'Break-even', 'bps', true, 'the slippage per fill at which net P&L is zero, fees as booked'),
      m('capacity_usd', 'Capacity', 'usd', false, 'the clip the visible book supports at a positive net edge'),
      m('beta_to_underlying', 'Beta', '', false, 'daily P&L on equity against the underlying leg or index; near 0 means neutral'),
    ],
  },
  short_vol: {
    label: 'Short vol', lead: 'premium_ann_pct',
    title: 'sell optionality or a tail: short options, short a digital, sell a hike tail. Paid often, hurt rarely; the tail is the result.',
    metrics: [...CORE,
      m('premium_ann_pct', 'Premium', '%', true, 'premium collected, annualized on equity'),
      m('vrp_pts', 'IV - RV', 'pts', true, 'implied minus the realized vol that followed, mean over the window'),
      m('worthless_pct', 'Worthless', '%', false, 'share of the sold options that expired worthless'),
      m('worst_loss_x_premium', 'Worst/prem', 'x', false, 'the worst single loss as a multiple of its own premium'),
      m('var95_pct', 'VaR 95', '%', false, 'historical 95% value at risk, per period'),
      m('cvar95_pct', 'CVaR 95', '%', false, 'mean of the periods at or below the VaR, per period'),
      m('skew', 'Skew', '', false, 'skew of the period returns'),
      m('kurtosis', 'Kurtosis', '', false, 'kurtosis of the period returns (a normal reads 3)'),
      m('breakeven_kappa', 'BE kappa', '', false, 'implied / realized vol at which the book breaks even'),
      m('stress_loss_pct', 'Stress', '%', false, 'loss on equity at the shock the study names'),
      m('recovery_days', 'Recovery', 'd', false, 'longest time to win back the worst loss'),
      m('avg_hold_h', 'Avg hold', 'h', false, 'mean hours from entry to expiry or resolution'),
    ],
  },
  rel_value: {
    label: 'Rel value', lead: 'net_edge_bps',
    title: 'the same thing priced twice: cross-venue, cross-market, a prediction market against its twin. Judged per opportunity, without a P&L series: a study that trades a rule on the gap and reports an equity curve takes directional.',
    metrics: [
      m('n_opportunities', 'Opps', 'n', false, 'opportunities the study scored'),
      m('median_gap_bps', 'Gap', 'bps', false, 'median gap between the two prices'),
      m('cost_bps', 'Cost', 'bps', false, 'round-trip cost to trade the gap: fees, spread, slippage'),
      m('net_edge_bps', 'Net edge', 'bps', true, 'median gap after costs'),
      m('capture_pct', 'Capture', '%', false, 'share of opportunities profitable after costs'),
      m('fill_share_pct', 'Fills', '%', false, 'share that fill at the study size in the visible book'),
      m('capacity_usd', 'Capacity', 'usd', false, 'notional that trades at a positive net edge'),
      m('half_life_h', 'Half-life', 'h', false, 'how long a gap takes to halve'),
      m('persistence_pct', 'Persists', '%', false, 'share of gaps still open after the horizon the study names'),
      m('n_venues', 'Venues', 'n', false, 'venues or markets in the comparison'),
      m('ann_return_pct', 'Ann ret', '%', true, 'annualized return on equity, when the study simulates one'),
      m('sharpe', 'Sharpe', '', true, 'Sharpe of that simulation, when there is one'),
    ],
  },
  evidence: {
    label: 'Evidence', lead: 't_stat',
    title: 'a market or event question with no book: does X move with Y, does Z happen before W. Judged by effect, significance and stability.',
    metrics: [
      m('n_obs', 'Obs', 'n', false, 'independent observations (non-overlapping blocks where the study uses them)'),
      m('effect', 'Effect', '', false, 'the effect, in the unit the headline names'),
      m('t_stat', 't (NW)', '', false, 't statistic, Newey-West'),
      m('p_value', 'p', '', false, 'p value of the effect'),
      m('ci95_low', 'CI low', '', false, 'lower bound of the 95% interval'),
      m('ci95_high', 'CI high', '', false, 'upper bound of the 95% interval'),
      m('rho', 'rho', '', false, 'correlation, where the question is one'),
      m('r2', 'R2', '', false, 'R squared, where there is a fit'),
      m('oos_effect', 'OOS', '', false, 'the same effect out of sample'),
      m('stable_share_pct', 'Stable', '%', false, 'share of sub-periods with the same sign'),
      m('half_life_h', 'Half-life', 'h', false, 'decay of the effect, where it has one'),
      m('n_regimes', 'Regimes', 'n', false, 'regimes the window spans'),
    ],
  },
} as const satisfies Record<string, { label: string; lead: string; title: string; metrics: Metric[] }>

export type FormatId = keyof typeof FORMATS
export const FORMAT_IDS = Object.keys(FORMATS) as FormatId[]
export const isFormat = (s: unknown): s is FormatId => typeof s === 'string' && s in FORMATS
export const metricsOf = (f: FormatId): readonly Metric[] => FORMATS[f].metrics

export type Manifest = {
  schema: typeof STUDY_SCHEMA
  id: string
  kind: typeof KINDS[number]
  desk: string
  title: string
  question: string
  status: 'draft' | 'run' | 'registered' | string
  run: { executed?: string; kernel?: string; run_id?: string }
  window: { from: string; to: string; hours?: number; regimes?: number }
  verify: { suite?: string; passed: number; total: number; books?: number }
  // `gate` is the id of the gate this number is judged by: the room reads that gate's verdict for the headline's tone, and none when it is absent
  headline?: { metric: string; value: number | string; unit?: string; hurdle?: number | string; label?: string; gate?: string } | null
  components?: { name: string; usd?: number; ann_pct?: number }[]
  gates: Gate[]
  sections: { id: string; title?: string; question?: string; status: string }[]
  figures: { id: string; section: string; title?: string; kind?: string }[]
  verdict: { word: string; why?: string | string[]; next_bet?: string; next?: { metric?: string; predict?: string; window?: string } }
  caveats: string[]
  // the study's two TAGS (the owner, 2026-10-05, B-0502): style typed by the study, pace read off its metrics
  // by platform. Optional; the room shows what is there and derives nothing
  tags?: Tags
  // the format and its metrics (optional; together)
  format?: FormatId
  strategy?: { name?: string; thesis?: string; market?: string; instruments?: string[]; venues?: string[]; style?: string }
  rules?: { entry?: string | null; exit?: string | null; sizing?: string | null; rebalance?: string | null; hedge?: string | null; hold?: string | null; stop?: string | null; cost?: string | null }
  params?: Record<string, { value: unknown; unit?: string; source?: string }>
  metrics?: Record<string, number | null>
  na?: Record<string, string>
  equity?: [string, number][]
  // THE FIXED CARD's fields (the manifest book, "The fixed card"; validator B-0274): a manifest
  // carrying `profile` is a fixed card; older ones keep strategy.market / venues / instruments
  // profile.markets (one or more of MARKETS) replaces the single profile.market (B-0284); a manifest
  // from before carries the single word, read only when it is one of the four
  profile?: { markets?: string[]; market?: string; venues?: string[]; instruments?: string[]; bar?: string }
  book?: { at?: string; legs: { side: string; instrument: string; account?: string; usd?: number; qty?: number; unit?: string }[] }
  // THE SUMMARY CARD (the owner, 2026-10-03, B-0399): what the room card and the notebook's S0 both
  // draw, validated by platform's fundplat.quant.core.report (API.md, "The summary card"). The room
  // draws it and computes nothing
  summary?: Summary
}

/** THE TAGS (the owner, 2026-10-05, B-0502), platform report.STYLES / PACES: how a study is run. Style is
 *  typed by the study (no check can tell the two apart, so it is a claim); pace is derived by platform from
 *  avg_hold_h or time_in_market_pct and checked there. The room reads `tags.pace` and never computes it */
export const STYLES = ['systematic', 'discretionary'] as const
export type Style = typeof STYLES[number]
export const PACES = ['intraday', 'swing', 'hold'] as const
export type Pace = typeof PACES[number]
export const TAG_KEYS = ['style', 'pace'] as const
export type Tags = { style?: Style; pace?: Pace }
export const isStyle = (s: unknown): s is Style => typeof s === 'string' && (STYLES as readonly string[]).includes(s)
export const isPace = (s: unknown): s is Pace => typeof s === 'string' && (PACES as readonly string[]).includes(s)

/** the summary card's closed set (report.py CARD_VERDICTS): a metric's verdict, or empty when it has none */
export const CARD_VERDICTS = ['PASS', 'FAIL', 'FLAG', 'INFO', ''] as const
export type CardVerdict = typeof CARD_VERDICTS[number]
/** one number on the card: its name, the value as shown, the bar it is judged against, its verdict; `scope`
 *  (the size, "1x") on a big number; `key` and `gate` name the manifest metric and gate it reads */
export type CardMetric = { metric: string; value: string; bar: string; verdict: CardVerdict; scope?: string; key?: string; gate?: string }
/** THE SUMMARY CARD (the owner, 2026-10-03, B-0399): the one fixed card the room and the notebook's S0 both
 *  draw, validated by platform's fundplat.quant.core.report (card_problems). It replaced the five-block
 *  summary of 2026-09-28. The room draws it and computes nothing */
export type Summary = {
  question: string
  answer: string
  implementation: [string, string][]
  big: CardMetric[]
  blocks: { title: string; rows: CardMetric[] }[]
  sizes: { cols: string[]; rows: string[][]; chosen: number | null }
  footer: string[]
}
export const SUMMARY_KEYS = ['question', 'answer', 'implementation', 'big', 'blocks', 'sizes', 'footer'] as const
export const MAX_BLOCKS = 8
export const MAX_FOOT_LINES = 4

export type Gate = { id?: string; section: string; name: string; reading?: string; threshold?: string; verdict: string; would_change?: string; label?: string; direction?: string }

/** THE MARKET LABEL (the owner, 2026-09-28, B-0284): one or more of four, each with its word on
 *  screen and its own hue (styles.css; markets wear their own colours, never a state's). `xasset`
 *  and `vol` are retired as labels: a cross-asset study carries two markets, the vol studies are
 *  crypto. File names keep their word (the naming book); it simply no longer maps to a label. */
export const MARKETS = {
  crypto: { label: 'Crypto', hue: 'crypto' },
  equities: { label: 'Equities', hue: 'equities' },
  rates: { label: 'Rates', hue: 'rates' },
  predmkts: { label: 'Pred markets', hue: 'predmkts' },
} as const
export type MarketId = keyof typeof MARKETS
export const MARKET_IDS = Object.keys(MARKETS) as MarketId[]
export const isMarket = (s: unknown): s is MarketId => typeof s === 'string' && s in MARKETS

/** a gate's verdict is a closed set on a fixed card; the words older manifests carry map onto it as the
 *  manifest book says ("not adopted", "NO SIZE", "rung ok, direction failed" are INFO; "ADOPTED" is PASS) */
export const GATE_VERDICTS = ['PASS', 'FAIL', 'FLAG', 'INFO', 'N/A'] as const
export type GateVerdict = typeof GATE_VERDICTS[number]
export const LEGACY_GATE_VERDICTS: Record<string, GateVerdict> = { 'not adopted': 'INFO', 'ADOPTED': 'PASS', 'NO SIZE': 'INFO', 'rung ok, direction failed': 'INFO', 'n/a': 'N/A' }
/** the closed verdict a gate reads as, or null for a word neither the set nor the book's mapping knows */
export function gateVerdict(v: string): GateVerdict | null {
  if ((GATE_VERDICTS as readonly string[]).includes(v)) return v as GateVerdict
  return LEGACY_GATE_VERDICTS[v] ?? null
}

/** THE CHART BANK's types (app/library/research/charts.md, the owner 2026-10-05, B-0505): one chapter per
 *  type, its heading slug the kind id a manifest figure may carry (`figures[].kind`). The book is the
 *  source; this list is what manifestProblems checks a kind against, and test/research-charts.test.ts
 *  fails when the book's chapters and this list differ (a new type is a chapter AND a row here). An older
 *  notebook has no kind until its next re-run: a missing kind is never a fault, a wrong one is. */
export const CHART_KINDS = [
  'series-and-distribution', 'equity-curve', 'drawdown-and-tail', 'signal-decay', 'calibration',
  'out-of-sample-test', 'significance-test', 'cost-sensitivity', 'rule-comparison', 'regime-and-concentration',
  'hedge-and-basis', 'sizing-and-fill', 'scenario-payoff', 'sample-size-and-power', 'capacity-curve',
  'monte-carlo-and-ruin', 'rolling-statistics', 'parameter-surface', 'fund-book-correlation', 'factor-regression',
  'autocorrelation', 'cash-and-headroom-by-account', 'clock-and-staleness', 'cross-venue-gap',
  'exit-reason-breakdown', 'exposure-over-time', 'gap-persistence', 'live-candidates',
  'payoff-diagram', 'premium-over-realized', 'profit-and-loss-attribution', 'quality-by-category', 'sample-funnel-and-coverage',
  'signal-and-outcome-scatter', 'stress-windows', 'trade-anatomy', 'trading-calendar',
  'win-loss-distribution', 'mae-mfe', 'book-depth-over-time',
  'entry-map', 'lead-and-lag', 'steadiness', 'distribution-against-model', 'leak-probe', 'selection-check',
  'entry-time-sensitivity', 'attribution-over-time', 'rebalance-path', 'adverse-selection', 'edge-by-slice',
] as const
/** Types cut from the bank (the owner, 2026-10-08, B-0673 / B-0674), folded into a survivor. A chapter no longer exists
 *  for them, but a notebook that ran before the cut still stamps `figures[].kind` with one, and a kind outside
 *  CHART_KINDS makes its manifest invalid. manifestProblems keeps accepting these until each notebook is re-run and
 *  re-tagged (never by hand); delete an id here when no notebook carries it. Unenforced: nothing lists the carriers. */
export const RETIRED_CHART_KINDS = ['rolling-win-rate', 'per-trade-pnl-over-time', 'path-fan', 'assumption-sensitivity', 'trade-marks'] as const
/** THE CHART BANK's categories (the owner, 2026-10-08, B-0674): the Charts view groups the types by the question a
 *  reader arrives with, not by the three family books (a workflow split by stage of a study). Each chapter's header
 *  block carries `Category: <name>`, one of these eight, a closed list; the view groups on it. */
export const CHART_CATEGORIES = [
  { id: 'run', name: 'The run', asks: 'Did it make money, and how did it arrive' },
  { id: 'edge', name: 'The edge', asks: 'Is the signal real, and how long does it last' },
  { id: 'luck', name: 'The luck', asks: 'Could this be chance' },
  { id: 'choice', name: 'The choice', asks: 'Was the setting chosen, or found' },
  { id: 'trade', name: 'The trade', asks: 'What one position did, from signal to exit' },
  { id: 'size-and-cost', name: 'Size and cost', asks: 'Can we trade it at size, and at what cost' },
  { id: 'book', name: 'The book', asks: 'What the fund is holding' },
  { id: 'data', name: 'The data', asks: 'Is the number measuring the market' },
] as const
export type ChartCategoryId = typeof CHART_CATEGORIES[number]['id']
/** the category a `Category:` line names (its exact name), or null for anything else */
export const chartCategoryOf = (s: string): ChartCategoryId | null => CHART_CATEGORIES.find(c => c.name === s.trim())?.id ?? null

export const isChartKind = (s: unknown): s is typeof CHART_KINDS[number] => typeof s === 'string' && (CHART_KINDS as readonly string[]).includes(s)
const isManifestKind = (s: unknown) => isChartKind(s) || (typeof s === 'string' && (RETIRED_CHART_KINDS as readonly string[]).includes(s))

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
/** the verdict word of a study that sizes nothing: its size table marks no row (sizes.chosen null) */
const NO_SIZE = 'NO SIZE'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** every reason an object is not a fund.study/1 manifest the room can draw; [] = valid. The book's
 *  required fields and rules, plus a format's: its metrics block carries every key of that format. */
export function manifestProblems(m: unknown): string[] {
  if (!isObj(m)) return ['not a JSON object']
  const p: string[] = []
  if (m.schema !== STUDY_SCHEMA) p.push(`schema is ${JSON.stringify(m.schema)}, not ${STUDY_SCHEMA}`)
  for (const k of ['id', 'desk', 'title', 'question', 'status']) if (!isStr(m[k])) p.push(`no ${k}`)
  if (!(KINDS as readonly string[]).includes(m.kind)) p.push(`kind ${JSON.stringify(m.kind)} is not ${KINDS.join('|')}`)
  if (!isObj(m.run)) p.push('no run')
  if (!isObj(m.window) || !isStr(m.window.from) || !isStr(m.window.to)) p.push('window needs from and to')
  if (!isObj(m.verify) || !isNum(m.verify.passed) || !isNum(m.verify.total)) p.push('verify needs passed and total')
  else if (m.verify.passed > m.verify.total) p.push(`verify ${m.verify.passed}/${m.verify.total}: passed above total`)
  if (!Array.isArray(m.gates)) p.push('no gates')
  else m.gates.forEach((g: any, i: number) => {
    if (!isStr(g?.name) || !isStr(g?.verdict)) p.push(`gate ${i} needs name and verdict`)
    if (!(SECTION_IDS as readonly string[]).includes(g?.section)) p.push(`gate ${i} section ${JSON.stringify(g?.section)} is not S0-S7`)
  })
  if (!Array.isArray(m.sections)) p.push('no sections')
  if (!Array.isArray(m.figures)) p.push('no figures')
  else {
    const ids = m.figures.map((f: any) => f?.id)
    if (ids.some((id: unknown) => !isStr(id) || !/^fig:s\d-[\w-]+$/.test(id as string))) p.push('a figure id is not fig:s<n>-<name>')
    if (new Set(ids).size !== ids.length) p.push('figure ids repeat')
    for (const f of m.figures) if (isObj(f) && f.kind !== undefined && !isManifestKind(f.kind)) p.push(`figure ${isStr(f.id) ? f.id : '?'} kind ${JSON.stringify(f.kind)} is not a chart type (a chapter slug of charts.md)`)
  }
  if (!isObj(m.verdict) || !isStr(m.verdict.word)) p.push('verdict needs a word')
  if (!Array.isArray(m.caveats)) p.push('no caveats')
  if (m.components !== undefined && !(Array.isArray(m.components) && m.components.every((c: any) => isStr(c?.name)))) p.push('components must be [{name, usd, ann_pct}]')
  if (m.format !== undefined && !isFormat(m.format)) p.push(`format ${JSON.stringify(m.format)} is not ${FORMAT_IDS.join('|')}`)
  if (m.metrics !== undefined && m.format === undefined) p.push('metrics without a format: name the format they follow')
  if (m.format !== undefined && isFormat(m.format) && m.metrics === undefined) p.push(`format ${m.format} without its metrics block`)
  if (m.metrics !== undefined && isFormat(m.format)) {
    if (!isObj(m.metrics)) p.push('metrics is not an object')
    else for (const { key: k } of metricsOf(m.format)) {
      if (!(k in m.metrics)) p.push(`metric ${k} missing`)
      else if (m.metrics[k] === null) { if (!isStr(m.na?.[k])) p.push(`metric ${k} is null with no reason in na`) }
      else if (!isNum(m.metrics[k])) p.push(`metric ${k} is not a number`)
    }
  }
  if (m.tags !== undefined) p.push(...tagProblems(m.tags))
  if (m.profile !== undefined && !(isObj(m.profile) && (isStr(m.profile.market) || (Array.isArray(m.profile.markets) && m.profile.markets.length > 0 && m.profile.markets.every(isStr))))) p.push('profile needs markets')
  if (m.book !== undefined && !(isObj(m.book) && Array.isArray(m.book.legs) && m.book.legs.every((l: any) => isStr(l?.side) && isStr(l?.instrument)))) p.push('book needs legs [{side, instrument}]')
  if (m.equity !== undefined && !(Array.isArray(m.equity) && m.equity.length <= 500 && m.equity.every((e: any) => Array.isArray(e) && isStr(e[0]) && isNum(e[1])))) p.push('equity must be at most 500 [iso, usd] points')
  if (m.summary !== undefined) p.push(...summaryProblems(m.summary, isObj(m.verdict) ? m.verdict.word : undefined))
  return p
}

/** the tags' SHAPE and closed words (report._tag_problems less its one derived rule: that pace equals what the
 *  metrics earn is platform's check, which ran when the manifest was built; the room never derives a pace) */
export function tagProblems(tg: unknown): string[] {
  if (!isObj(tg) || !Object.keys(tg).length) return ['tags must be {style, pace}, not empty']
  const p: string[] = []
  const bad = Object.keys(tg).filter(k => !(TAG_KEYS as readonly string[]).includes(k)).sort()
  if (bad.length) p.push(`tags keys the book does not define: ${bad.join(', ')}`)
  if ('style' in tg && !isStyle(tg.style)) p.push(`tags.style ${JSON.stringify(tg.style)} is not ${STYLES.join('|')}`)
  if ('pace' in tg && !isPace(tg.pace)) p.push(`tags.pace ${JSON.stringify(tg.pace)} is not ${PACES.join('|')}`)
  return p
}

const inSet = (set: readonly string[], v: unknown) => typeof v === 'string' && set.includes(v)
const oneLine = (v: unknown): v is string => typeof v === 'string' && !v.includes('\n')

/** one card metric's SHAPE (report.py _metric_problems less its authoring rules: the widths, the code
 *  names and the key / gate ties to the manifest are the validator's, which ran when the card was built) */
function metricProblems(where: string, r: any, big = false): string[] {
  if (!isObj(r)) return [`${where} is not an object`]
  const p: string[] = []
  const allowed = ['metric', 'value', 'bar', 'verdict', 'key', 'gate', ...(big ? ['scope'] : [])]
  const extra = Object.keys(r).filter(k => !allowed.includes(k))
  if (extra.length) p.push(`${where} keys the book does not define: ${extra.join(', ')}`)
  if (!isStr(r.metric) || !oneLine(r.metric)) p.push(`${where}.metric must be a non-empty one-line string`)
  if (!isStr(r.value) || !oneLine(r.value)) p.push(`${where}.value must be a non-empty one-line string`)
  if (!oneLine(r.bar)) p.push(`${where}.bar must be a one-line string (empty when the number has no bar)`)
  if (!inSet(CARD_VERDICTS, r.verdict)) p.push(`${where}.verdict ${JSON.stringify(r.verdict)} is not PASS|FAIL|FLAG|INFO or empty`)
  if (big && !(isStr(r.scope) && oneLine(r.scope))) p.push(`${where}.scope must be a non-empty one-line string`)
  return p
}

/** the summary card's shape: every field present and no other, the closed verdict set, one cell per size
 *  column, a chosen row that exists (null only under the NO SIZE `word`), 1..8 blocks, 1..4 footer lines.
 *  The widths, the code names and the ties to the manifest's metrics and gates are platform's
 *  card_problems', which ran when it was built */
export function summaryProblems(s: unknown, word?: unknown): string[] {
  if (!isObj(s)) return [`summary must be {${SUMMARY_KEYS.join(', ')}}`]
  const p: string[] = []
  const extra = Object.keys(s).filter(k => !(SUMMARY_KEYS as readonly string[]).includes(k))
  if (extra.length) p.push(`summary keys the book does not define: ${extra.join(', ')}`)
  const miss = SUMMARY_KEYS.filter(k => !(k in s))
  if (miss.length) p.push(`summary needs ${miss.join(', ')}`)
  if ('question' in s && !(isStr(s.question) && oneLine(s.question))) p.push('summary.question must be a non-empty one-line string')
  if ('answer' in s && !(isStr(s.answer) && oneLine(s.answer))) p.push('summary.answer must be a non-empty one-line string')
  const im = s.implementation
  if (im !== undefined) {
    if (!Array.isArray(im) || !im.length) p.push('summary.implementation must be a list of [name, fact] pairs')
    else im.forEach((f: unknown, i: number) => { if (!(Array.isArray(f) && f.length === 2 && isStr(f[0]) && isStr(f[1]))) p.push(`summary.implementation[${i}] must be [name, fact]`) })
  }
  const bg = s.big
  if (bg !== undefined) {
    if (!Array.isArray(bg) || !bg.length) p.push('summary.big must be a list of metrics')
    else bg.forEach((r: unknown, i: number) => p.push(...metricProblems(`summary.big[${i}]`, r, true)))
  }
  const bl = s.blocks
  if (bl !== undefined) {
    if (!Array.isArray(bl) || bl.length < 1 || bl.length > MAX_BLOCKS) p.push(`summary.blocks must be 1..${MAX_BLOCKS} blocks of {title, rows}`)
    else bl.forEach((b: any, i: number) => {
      const w = `summary.blocks[${i}]`
      if (!isObj(b) || !Array.isArray(b.rows) || !b.rows.length) { p.push(`${w} must be {title, rows: [metric, ...]} with at least one row`); return }
      const x = Object.keys(b).filter(k => k !== 'title' && k !== 'rows')
      if (x.length) p.push(`${w} keys the book does not define: ${x.join(', ')}`)
      if (!isStr(b.title)) p.push(`${w}.title must be a non-empty string`)
      const names: unknown[] = []
      b.rows.forEach((r: any, j: number) => {
        p.push(...metricProblems(`${w}.rows[${j}]`, r))
        if (isObj(r)) { if (names.includes(r.metric)) p.push(`${w}.rows[${j}] names ${JSON.stringify(r.metric)} twice`); names.push(r.metric) }
      })
    })
  }
  const sz = s.sizes
  if (sz !== undefined) {
    if (!isObj(sz) || !Array.isArray(sz.cols) || sz.cols.length < 2 || !sz.cols.every(isStr) || !Array.isArray(sz.rows) || !sz.rows.length) p.push('summary.sizes must be {cols, rows, chosen}: two or more columns, one or more rows')
    else {
      const x = Object.keys(sz).filter(k => !['cols', 'rows', 'chosen'].includes(k))
      if (x.length) p.push(`summary.sizes keys the book does not define: ${x.join(', ')}`)
      sz.rows.forEach((r: unknown, i: number) => {
        if (!(Array.isArray(r) && r.length === sz.cols.length && r.every(oneLine))) p.push(`summary.sizes.rows[${i}] must hold one cell per column (${sz.cols.length})`)
        else if (!inSet(CARD_VERDICTS, r[r.length - 1])) p.push(`summary.sizes.rows[${i}] ends with ${JSON.stringify(r[r.length - 1])}, not PASS|FAIL|FLAG|INFO or empty`)
      })
      if (!('chosen' in sz)) p.push(`summary.sizes needs chosen: a row index, or null when the verdict is ${NO_SIZE}`)
      else if (sz.chosen === null) { if (isStr(word) && word !== NO_SIZE) p.push(`summary.sizes.chosen is null, but only a ${NO_SIZE} verdict marks no row, the verdict is ${JSON.stringify(word)}`) }
      else if (!(Number.isInteger(sz.chosen) && sz.chosen >= 0 && sz.chosen < sz.rows.length)) p.push(`summary.sizes.chosen ${JSON.stringify(sz.chosen)} is not a row of the table`)
    }
  }
  const ft = s.footer
  if (ft !== undefined) {
    if (!Array.isArray(ft) || ft.length < 1 || ft.length > MAX_FOOT_LINES || !ft.every((x: unknown) => isStr(x) && oneLine(x))) p.push(`summary.footer must be 1..${MAX_FOOT_LINES} one-line strings`)
  }
  return p
}

/** where a notebook stands with its manifest: the book says exactly one per notebook */
export type ManifestState =
  | { state: 'ok'; manifest: Manifest; cell: number }
  | { state: 'none' }                                   // legacy: not rebuilt into the structure yet
  | { state: 'invalid'; cell: number; problems: string[] }
  | { state: 'many'; cells: number[] }                  // two manifests: broken, per the book

/** the loop record a study's notebook ran under (app/loop/tools: runs.jsonl), when one names it */
export type LoopLink = {
  key: string
  desk: string
  run: string
  kind: string | null
  stage: 'preflight' | 'result'
  ts: string | null
  headline: string
  window: { from?: string; to?: string; hours?: number; regimes?: number } | null
  verify: { suite?: string; passed?: number | null; total?: number | null } | null
  graded: Record<string, { actual: number; band: string; verdict: string }>
  comparator: { name?: string; value?: number; unit?: string; provenance?: string } | null
}

export type Study = {
  id: string                 // path inside platform/research, e.g. "studies/2026-09-sofr-tail-thesis.ipynb"
  name: string               // the stem without a leading "[tag] "
  tag: string | null         // "latest" for "[latest] ..."
  group: string               // the folder under platform/research ("studies")
  bytes: number
  mtime: number
  cells: { markdown: number; code: number; executed: number; images: number }
  kernel: string | null
  error: string | null       // the notebook did not parse
  manifest: ManifestState
  loop: LoopLink[]
  commit: { hash: string; date: string } | null  // the last commit touching the file; null = never committed
  labels: Labels
}

/** where a label was read (B-0284), in precedence order: the manifest (profile.markets, format, tags.style),
 *  platform/research/labels.json, then for the market only the manifest's old single profile.market,
 *  the file name's market word, or the naming book's row for a legacy name */
export type LabelSource = 'manifest' | 'labels.json' | 'profile.market' | 'name' | 'naming book'
/** a study's labels. markets [] = No market, and markets[0] is the MAIN one (B-0502); format null = none named;
 *  style and pace null = none. Style is the manifest's tags.style, else labels.json's; pace is the manifest's
 *  tags.pace only: the room never computes it. `faults` names every value off the closed lists: shown, never
 *  silently dropped. A notebook outside studies/ carries none */
export type Labels = { markets: MarketId[]; format: FormatId | null; style: Style | null; pace: Pace | null
  from: { markets: LabelSource | null; format: LabelSource | null; style: LabelSource | null }; faults: string[] }
/** platform/research/labels.json: notebook path inside platform/research -> its labels */
export type LabelsFile = Record<string, { markets?: unknown; format?: unknown; style?: unknown }>
export const LABELS_REL = 'platform/research/labels.json'

/** jupyter = the JupyterLab dashboard's own `open` url (its dashboard.json), null when it is not registered */
export type StudiesPayload = { root: string; exists: boolean; studies: Study[]; at: number; jupyter: string | null
  /** labels.json as read: absent (the manifests and names label alone), ok, or failed; problems names a
   *  row for no notebook, or why the file would not parse */
  labels: { state: 'absent' | 'ok' | 'failed'; problems: string[] } }

// ---- THE CHARTS VIEW (B-0505): the chart bank's chapters, read at scan time ----

/** what a chapter's `Exemplar:` line says: `none yet` (no study has drawn the type), a study stem and a figure id, or a line
 *  that is neither (a fault: shown, never read as "not drawn yet") */
export type ChartExemplar =
  | { state: 'none' }
  | { state: 'named'; study: string; fig: string; note: string | null }
  | { state: 'bad'; line: string; why: string }

/** one chart type: the chapter's lines as the book holds them, and where its exemplar's picture is */
export type ChartType = {
  id: string                    // the heading slug: the kind id a manifest figure carries
  heading: string
  readWhen: string | null
  /** the chapter's `Category:` line as one of the eight; null when the line is missing or names something else (see categoryWhy) */
  category: ChartCategoryId | null
  /** why `category` is null: no Category line, or a name outside the closed list; null when the category reads */
  categoryWhy: string | null
  question: string | null
  inputs: string[]
  draw: string[]
  read: string[]
  pairs: string[]
  code: string | null           // the python block under Code
  exemplar: ChartExemplar
  /** the exemplar's figure, when the book names one and the study lists it: the notebook (a studies id) and the PNG's URL */
  picture: { study: string; fig: string; src: string } | null
  /** why a named exemplar has no picture: no such notebook, or its manifest does not list the figure; null when none is wrong */
  fault: string | null
  /** the studies whose manifest tags a figure with this kind (older notebooks have none until their next re-run) */
  used: { id: string; name: string; fig: string; title: string | null }[]
}

export type ChartsPayload = { exists: boolean; types: ChartType[]; at: number }

/** the chart bank's closed filter: every type, the ones with an exemplar, the ones with `none yet` */
export type ChartShow = 'all' | 'drawn' | 'undrawn'

/** the Questions block (B-0524): what a nine-section notebook holds under each of S2-S6, read from the notebook file,
 *  never computed. `figs` are the cells tagged fig:s<n>-<name> with a PNG output (the image is /api/research/chart-fig);
 *  `tables` the text/markdown outputs of the section. `question` / `rule` are the heading's own table, first data row. */
export type QuestionSection = {
  id: string
  name: string
  cell: number
  question: string | null
  ruleHead: string | null
  rule: string | null
  figs: { fig: string; cell: number }[]
  tables: { md: string; cell: number }[]
}
export type Questions = { sections: QuestionSection[]; verdict: { md: string; cell: number } | null }
export type QuestionsPayload = { id: string; mtime: number; questions: Questions | null }
