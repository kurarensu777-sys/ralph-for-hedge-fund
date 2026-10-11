/**
 * TURN CHECKS - pure. Run on the assistant text of one finished turn. Each check returns the spans
 * it objects to; no span = pass. The checks are the house rules an owner would otherwise catch by
 * eye, so they are deliberately narrow: a false flag costs the owner one keypress, a missed invented
 * number costs a position.
 *
 *   nodash    any em-dash or en-dash in prose (fenced and inline code are not prose, like the others)
 *   tagged    a number next to %, $ or bp needs [V] / [1] / [U] / [API] on the same line, near it
 *   windowed  a return or annualized % figure needs a date or a window on the same line, near it
 *
 * Also here: the deterministic 5% sample and the ledger-path rule that decide what else is queued.
 */

export type CheckKey = 'nodash' | 'tagged' | 'windowed'
export const CHECKS: CheckKey[] = ['nodash', 'tagged', 'windowed']
export type Span = { check: CheckKey; start: number; end: number }
export type CheckResult = Record<CheckKey, Span[]>

export const LABELS = ['invented number', 'no window', 'off scope', 'style'] as const
export type Label = typeof LABELS[number]

const NEAR = 100          // chars either side, on the same line
const TAG = /\[(?:V|1|U|API)\]/

/** the slice of the line around [start, end), at most NEAR chars either side */
function around(text: string, start: number, end: number, near = NEAR): string {
  const ls = text.lastIndexOf('\n', start - 1) + 1
  const le0 = text.indexOf('\n', end)
  const le = le0 === -1 ? text.length : le0
  return text.slice(Math.max(ls, start - near), Math.min(le, end + near))
}

/** fenced code is not prose: blank it (same length, so offsets hold) */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, m => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
}

// en-dash and em-dash, built from char codes so this file holds neither character
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`, 'g')

export function nodash(text: string): Span[] {
  const out: Span[] = []
  for (const m of prose(text).matchAll(DASHES)) out.push({ check: 'nodash', start: m.index!, end: m.index! + 1 })
  return out
}

const NUM = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`
// $12, $1.2M, -$5k | 12%, 12 %, 12.5pp is NOT % | 12bp, 12 bps
const FIG = new RegExp(String.raw`[+-]?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB]n?\b)?|${NUM}\s?%|${NUM}\s?bps?\b`, 'g')

/** every money / percent / basis-point figure in prose text */
export function figures(text: string): { start: number; end: number; s: string }[] {
  const t = prose(text)
  return [...t.matchAll(FIG)].map(m => ({ start: m.index!, end: m.index! + m[0].length, s: m[0] }))
}

export function tagged(text: string): Span[] {
  const out: Span[] = []
  for (const f of figures(text)) if (!TAG.test(around(text, f.start, f.end))) out.push({ check: 'tagged', start: f.start, end: f.end })
  return out
}

const RETURN_WORD = /\b(ann(?:ual(?:ized|ised)?)?|apr|apy|cagr|returns?|returned|p&l|pnl|yield(?:s|ed)?|carry|made|earned|lost|gain(?:ed|s)?)\b|\/\s?(?:yr|year)\b|\bper year\b|\ba year\b/i
const DATE = /\b\d{4}-\d{2}(?:-\d{2})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b(?![.,]?\d*\s?%)(?:,\s*\d{4})?|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\bq[1-4]\s*\d{4}\b/i
const WINDOW = /\b\d[\d,]*(?:\.\d+)?\s?(?:h|hr|hrs|hours?|d|days?|w|wk|weeks?|mo|months?|y|yrs?|years?)\b|\bwindow\b|\bytd\b|\bmtd\b|\bsince\b|\bover the (?:last|past)\b|\b(?:7|30|90|180|365)d\b/i

/** a % figure that reads as a return (a return word within 40 chars of it, same line) */
function isReturn(text: string, start: number, end: number): boolean {
  return RETURN_WORD.test(around(text, start, end, 40))
}

export function windowed(text: string): Span[] {
  const out: Span[] = []
  for (const f of figures(text)) {
    if (!f.s.includes('%')) continue
    if (!isReturn(text, f.start, f.end)) continue
    // the window must be something other than the figure's own "/yr"
    const ctx = around(text, f.start, f.end, 160)
    if (DATE.test(ctx) || WINDOW.test(ctx)) continue
    out.push({ check: 'windowed', start: f.start, end: f.end })
  }
  return out
}

export function runChecks(text: string): CheckResult {
  return { nodash: nodash(text), tagged: tagged(text), windowed: windowed(text) }
}

export const failedChecks = (r: CheckResult): CheckKey[] => CHECKS.filter(k => r[k].length > 0)

/** FNV-1a 32-bit: stable across processes and platforms */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h >>> 0
}

/** the deterministic sample: the same turn is always in or always out */
export const inSample = (conv: string, turnIx: number, pct = 5) => fnv1a(`${conv}#${turnIx}`) % 100 < pct

const LEDGER_MD = /(?:^|[\\/])(results-log|research-log|beliefs|mechanics|menu)\.md$/i
const LEDGER_JSONL = /(?:^|[\\/])data[\\/][^\\/]+\.jsonl$/i

/** a path a desk's ledger lives at: results-log / beliefs / mechanics / menu .md, data/*.jsonl */
export const isLedger = (p: string) => LEDGER_MD.test(p.trim()) || LEDGER_JSONL.test(p.trim())

/** a desk snapshot file, never a turn's ledger. Snapshot rows live in the lake's snapshots dataset since
 * c247093 (B-0096), so no probe writes data/snapshots.jsonl any more; a checkout from before that move can
 * still hold one, updated by nobody's turn, so it stays excluded rather than read as a ledger edit. */
const MACHINE_LEDGER = /(?:^|[\\/])data[\\/]snapshots\.jsonl$/i
export const isMachineLedger = (p: string) => MACHINE_LEDGER.test(p.trim())

export type Reason = 'failed' | 'ledger' | 'sample'

/** why a turn goes on the review queue; [] = it does not */
export function reasonsFor(conv: string, turnIx: number, r: CheckResult, touched: string[]): Reason[] {
  const out: Reason[] = []
  if (failedChecks(r).length) out.push('failed')
  if (touched.some(isLedger)) out.push('ledger')
  if (inSample(conv, turnIx)) out.push('sample')
  return out
}

/** clip text for the queue card, keeping the spans that still fall inside */
export function clip(text: string, spans: Span[], max = 4000): { excerpt: string; spans: Span[] } {
  if (text.length <= max) return { excerpt: text, spans }
  const first = spans.length ? Math.min(...spans.map(s => s.start)) : 0
  const from = Math.max(0, Math.min(first - 200, text.length - max))
  const excerpt = (from ? '...' : '') + text.slice(from, from + max)
  const shift = (from ? 3 : 0) - from
  return { excerpt, spans: spans.filter(s => s.start >= from && s.end <= from + max).map(s => ({ ...s, start: s.start + shift, end: s.end + shift })) }
}
