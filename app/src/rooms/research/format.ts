import { FORMATS, gateVerdict, isFormat, metricsOf, type FormatId, type Gate, type GateVerdict, type Manifest, type Metric, type Study } from '../../../shared/research.ts'

/** a fixed number of decimals per unit, never by size (126.00% beside 92.22% reads as two rules), grouped from 1000 */
const fixed = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/** a metric as shown, by its unit: percents signed where higher is better or it is a loss, ratios to two
 *  decimals, counts whole, dollars grouped; null -> null (the caller says n/a and why) */
export function fmtMetric(mt: Metric, v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  const sign = v > 0 && (mt.good || mt.key.endsWith('_ann_pct')) ? '+' : ''
  switch (mt.unit) {
    case '%': return `${sign}${fixed(v, 2)}%`
    case 'n': return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(2)
    case 'usd': return `USD ${Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.round(v).toLocaleString('en-US')}`
    case 'bps': return `${sign}${fixed(v, 1)} bp`
    case 'pts': return `${sign}${v.toFixed(2)} pts`
    case 'd': case 'h': return `${fixed(v, 1)}${mt.unit}`
    case 'x': return `${v.toFixed(2)}x`
    default: return Math.abs(v) < 0.01 && v !== 0 ? v.toExponential(1) : v.toFixed(2)
  }
}

/** green or red by sign, only for a metric where higher is better */
export function toneOf(mt: Metric, v: number | null): 'ok' | 'fail' | '' {
  if (v === null || !mt.good) return ''
  return v > 0 ? 'ok' : v < 0 ? 'fail' : ''
}

/** a number as the card shows it: three decimals at most (a deflated Sharpe of 0.942 stays 0.942), whole and grouped
 *  from 1000; a string as written */
export const num = (v: number | string) => (typeof v === 'number' ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toFixed(3)))) : v)

/** a value with a ledger unit as a reader says it: 2.5 pct_ann -> 2.5% ann; an unknown unit is shown as written */
const UNITS: Record<string, [string, string]> = { pct_ann: ['%', ' ann'], pct: ['%', ''], bp: [' bp', ''], bps: [' bp', ''], pts: [' pts', ''] }
export function unitText(v: number | string, unit?: string): string {
  if (!unit) return String(v)
  const u = UNITS[unit]
  return u ? `${v}${u[0]}${u[1]}` : `${v} ${unit}`
}

/** the manifest's own headline number: its label, the value as the card says it, the hurdle, and the tone of the
 *  gate it names (`headline.gate`); a headline that names no gate, or one the manifest lacks, has no tone, never a
 *  guess from the value against the hurdle (a number can clear its hurdle and still FAIL its gate). Null when the
 *  manifest carries no headline */
export function headlineOfManifest(m: Manifest): { label: string; text: string; tone: 'ok' | 'warn' | 'fail' | 'faint'; verdict: string | null; hurdle: string | null; title: string } | null {
  const h = m.headline
  if (!h) return null
  const label = h.label ?? h.metric
  const text = unitText(num(h.value), h.unit)
  const hurdle = h.hurdle !== undefined ? unitText(num(h.hurdle), h.unit) : null
  const g = h.gate ? m.gates.find(x => x.id === h.gate) : undefined
  const verdict = g ? String(gateWord(g)) : null
  return { label, text, tone: verdict ? gateTone(verdict) : 'faint', verdict, hurdle,
    title: `${label} (${h.metric}): the one gate metric${hurdle ? `
hurdle ${hurdle}` : ''}${verdict ? `
gate ${h.gate}: ${verdict}` : ''}` }
}

export const formatOf = (m: Manifest | null): FormatId | null => (m && isFormat(m.format) && m.metrics ? m.format : null)
export const formatLabel = (f: FormatId) => FORMATS[f].label

/** a study's verdict word as the list's chips read it: SIZED names a size (a leverage like `3x`, or
 *  SIZE ...), NO SIZE and NOT SHOWN are the two refusals; any other word is only under All */
export type VerdictKind = 'sized' | 'nosize' | 'notshown' | 'other'
export function verdictKind(word: string): VerdictKind {
  const s = word.trim().toUpperCase()
  if (s.startsWith('NO SIZE')) return 'nosize'
  if (s.startsWith('NOT SHOWN')) return 'notshown'
  if (/^\d+(\.\d+)?X$/.test(s) || s.startsWith('SIZE')) return 'sized'
  return 'other'
}

/** a verdict word or a gate verdict, as a tone. A sizing word (3x, SIZE 1x, NO SIZE, NOT SHOWN) is an answer, not
 *  good or bad, so it is faint: green and red mean good and bad only (B-0514) */
export function verdictTone(v: string): 'ok' | 'warn' | 'fail' | 'faint' {
  const s = v.toUpperCase()
  if (verdictKind(v) !== 'other') return 'faint'
  if (s.includes('KILL') || s === 'FLAG' || s.startsWith('COLD')) return 'warn'
  if (s === 'PASS') return 'ok'
  if (s.includes('FAIL')) return 'fail'
  return 'faint'
}

/** THE GATES: a section's word in the card (the nine sections' questions: S2 is the data check, S3
 *  whether it pays, S4 whether it is real, S5 the risk, S6 the size) */
export const SECTION_WORDS: Record<string, string> = { S0: 'SUMMARY', S1: 'SETUP', S2: 'DATA', S3: 'PAYS', S4: 'REAL', S5: 'RISK', S6: 'SIZE', S7: 'VERDICT' }

/** a gate's closed verdict (the manifest book maps the older words), or its own word when unknown */
export const gateWord = (g: Gate): GateVerdict | string => gateVerdict(g.verdict) ?? g.verdict
export function gateTone(v: string): 'ok' | 'warn' | 'fail' | 'faint' {
  return v === 'PASS' ? 'ok' : v === 'FAIL' ? 'fail' : v === 'FLAG' ? 'warn' : 'faint'
}
/** the row text: its label, else (a manifest from before the fixed card) its id and name */
export const gateText = (g: Gate) => g.label ?? [g.id, g.name].filter(Boolean).join(' ')
export const gateHover = (g: Gate) => [g.name, g.reading && `reading ${g.reading}`, g.threshold && `threshold ${g.threshold}`,
  g.verdict !== gateWord(g) && `verdict word: ${g.verdict}`, g.would_change && `would change it: ${g.would_change}`].filter(Boolean).join('\n')

/** counting gates is the room's only arithmetic (as for figures): pass / fail / flag of the closed verdicts */
export function gateCounts(gates: Gate[]): { pass: number; fail: number; flag: number } {
  const w = gates.map(gateWord)
  return { pass: w.filter(x => x === 'PASS').length, fail: w.filter(x => x === 'FAIL').length, flag: w.filter(x => x === 'FLAG').length }
}

/** the gates by section, in S order; with a `direction`, each row carries one verdict per direction
 *  (the BOOK / MIRROR grid), a row matched by its text inside its section */
export type GateRow = { text: string; by: Record<string, Gate> }
export function gateGrid(gates: Gate[]): { directions: string[]; sections: { id: string; rows: GateRow[] }[] } {
  const directions = [...new Set(gates.map(g => g.direction).filter((d): d is string => !!d))]
  const sections: { id: string; rows: GateRow[] }[] = []
  for (const g of gates) {
    let sec = sections.find(x => x.id === g.section)
    if (!sec) sections.push(sec = { id: g.section, rows: [] })
    // in a grid the ids differ per direction (B1 / C1): a row is its label, else its name
    const text = directions.length ? g.label ?? g.name : gateText(g), d = g.direction ?? ''
    const row = directions.length ? sec.rows.find(r => r.text === text && !(d in r.by)) : undefined
    if (row) row.by[d] = g
    else sec.rows.push({ text, by: { [d]: g } })
  }
  sections.sort((a, b) => a.id.localeCompare(b.id))
  return { directions, sections }
}

/** the three RESULT metrics every card shows beside the verdict (n/a where the format has none) */
export const RESULT_KEYS = ['ann_return_pct', 'sharpe', 'max_dd_pct'] as const

/** METRICS: each format's keys in its three small groups, without the three in RESULT. A test holds
 *  that every key of the format lands exactly once here or in RESULT */
export const METRIC_GROUPS: Record<FormatId, [string, string[]][]> = {
  carry: [
    ['CARRY', ['funding_ann_pct', 'basis_ann_pct', 'price_ann_pct', 'fees_ann_pct', 'financing_ann_pct', 'mirror_ann_pct', 'funding_pos_share_pct']],
    ['RISK', ['ann_vol_pct', 'sortino', 'calmar', 'psr', 'dsr', 'max_dd_days', 'min_liq_distance_pct', 'excess_vs_hurdle_pct']],
    ['BOOK', ['time_in_market_pct', 'turnover_ann', 'n_periods', 'periods_per_year']],
  ],
  directional: [
    ['EDGE', ['expectancy_bps', 'gross_edge_bps', 'cost_bps', 'breakeven_cost_bps', 'fees_pct_of_gross', 'capacity_usd']],
    ['TRADES', ['total_return_pct', 'n_trades', 'trades_per_day', 'hit_rate_pct', 'profit_factor', 'win_loss_ratio', 'avg_hold_h', 'exposure_pct', 'turnover_ann']],
    ['RISK', ['ann_vol_pct', 'sortino', 'calmar', 'psr', 'dsr', 'max_dd_days', 'worst_period_pct', 'excess_vs_hurdle_pct', 'beta_to_underlying', 'n_periods', 'periods_per_year']],
  ],
  short_vol: [
    ['PREMIUM', ['premium_ann_pct', 'vrp_pts', 'worthless_pct', 'breakeven_kappa', 'worst_loss_x_premium', 'avg_hold_h', 'excess_vs_hurdle_pct']],
    ['TAIL', ['var95_pct', 'cvar95_pct', 'stress_loss_pct', 'skew', 'kurtosis', 'max_dd_days', 'recovery_days']],
    ['RISK', ['ann_vol_pct', 'sortino', 'calmar', 'psr', 'dsr', 'n_periods', 'periods_per_year']],
  ],
  rel_value: [
    ['EDGE', ['n_opportunities', 'median_gap_bps', 'cost_bps', 'net_edge_bps', 'capture_pct']],
    ['SIZE', ['fill_share_pct', 'capacity_usd', 'n_venues']],
    ['TIME', ['half_life_h', 'persistence_pct']],
  ],
  evidence: [
    ['EFFECT', ['effect', 't_stat', 'p_value', 'ci95_low', 'ci95_high', 'n_obs']],
    ['FIT', ['rho', 'r2', 'oos_effect']],
    ['STABILITY', ['stable_share_pct', 'half_life_h', 'n_regimes']],
  ],
}

/** the card's groups for a study. The EDGE block (the edge per trade against its cost) is shown when the
 *  manifest's tags.pace is intraday; for a directional study at any other pace (or none) its keys join the
 *  head of TRADES, so a metric the study measured is never hidden. The room reads the pace, never derives it */
export function metricGroups(f: FormatId, pace: string | null | undefined): [string, string[]][] {
  const g = METRIC_GROUPS[f]
  if (f !== 'directional' || pace === 'intraday') return g
  const edge = g.find(([n]) => n === 'EDGE')![1]
  return g.filter(([n]) => n !== 'EDGE').map(([n, keys]) => (n === 'TRADES' ? [n, [...edge, ...keys]] : [n, keys]))
}

/** the TABLE's default metric columns: the format's lead first, then the few a reader ranks it by
 *  (the Columns picker adds the rest) */
export const TABLE_COLS: Record<FormatId, string[]> = {
  carry: ['funding_ann_pct', 'basis_ann_pct', 'mirror_ann_pct', 'sharpe', 'max_dd_pct', 'excess_vs_hurdle_pct'],
  directional: ['sharpe', 'total_return_pct', 'hit_rate_pct', 'profit_factor', 'max_dd_pct', 'n_trades'],
  short_vol: ['premium_ann_pct', 'worst_loss_x_premium', 'cvar95_pct', 'sharpe', 'max_dd_pct', 'excess_vs_hurdle_pct'],
  rel_value: ['net_edge_bps', 'median_gap_bps', 'cost_bps', 'capture_pct', 'capacity_usd', 'n_opportunities'],
  evidence: ['t_stat', 'effect', 'p_value', 'n_obs', 'oos_effect', 'stable_share_pct'],
}

export const metricOf = (f: FormatId, key: string): Metric | undefined => metricsOf(f).find(x => x.key === key)

export const day = (iso: string | undefined | null) => (iso ?? '').slice(0, 10) || '?'

export function manifestOf(s: Study): Manifest | null {
  return s.manifest.state === 'ok' ? s.manifest.manifest : null
}

/** the one-word state of a study's manifest, and why */
export function stateWord(s: Study): { word: string; tone: 'ok' | 'warn' | 'fail' | 'faint'; why: string } {
  if (s.error) return { word: 'broken', tone: 'fail', why: s.error }
  switch (s.manifest.state) {
    case 'ok': return { word: s.manifest.manifest.verdict.word, tone: verdictTone(s.manifest.manifest.verdict.word), why: `fund.study/1 manifest in cell ${s.manifest.cell}` }
    case 'invalid': return { word: 'bad manifest', tone: 'fail', why: `cell ${s.manifest.cell}: ${s.manifest.problems.join('; ')}` }
    case 'many': return { word: 'two manifests', tone: 'fail', why: `manifests in cells ${s.manifest.cells.join(', ')}: the book allows exactly one` }
    default:
      if (s.cells.code > 0 && s.cells.executed === 0) return { word: 'not run', tone: 'warn', why: 'no cell has been executed' }
      return { word: 'legacy', tone: 'faint', why: 'no fund.study/1 manifest yet: it lands when the study is rebuilt into the nine sections and re-run' }
  }
}
