import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseJsonl, type Raw } from './runs.ts'
import { deskDir } from '../paths.ts'

/**
 * The trial ledger (app/loop/tools/trial.py writes it, append-only): `lab/<desk>/data/trials.jsonl`,
 * one row per configuration a sweep evaluated,
 *   {ts, run, mechanic, cell, sharpe, n_obs, skew, kurt, returns, status: kept|abandoned|rerun}
 * `sharpe` is PER OBSERVATION (not annualized) and `kurt` is NON-excess (normal = 3).
 *
 * Two numbers come out of it:
 *  - DSR, the Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014): the probability the run's
 *    selected Sharpe beats the expected MAXIMUM of N unskilled trials. N is the count of DISTINCT
 *    trials (run x cell) for that mechanic in this desk's ledger, abandoned ones included, and
 *    the spread of that maximum comes from the variance of those trials' Sharpes. N is READ,
 *    never passed in: every function here takes the ledger.
 *  - PBO, the Probability of Backtest Overfitting by CSCV (Bailey, Borwein, Lopez de Prado, Zhu):
 *    the run's trials that carry a return path, cut into S = 16 blocks; for each of the C(16,8)
 *    in-sample halves, the IS-best cell's relative OOS rank w, logit l = ln(w / (1 - w));
 *    PBO = share of splits with l <= 0.
 */

export type Trial = {
  ts: string | null; run: string; mechanic: string | null; cell: Record<string, unknown>
  sharpe: number; n_obs: number; skew: number | null; kurt: number | null
  returns: number[] | null; status: 'kept' | 'abandoned' | 'rerun' | string
}

const EULER = 0.5772156649015329
export const S_BLOCKS = 16

// ---- normal distribution ----

/** standard normal CDF, via the Numerical Recipes erfc Chebyshev fit (fractional error < 1.2e-7) */
export function phi(x: number): number {
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.5 * z)
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? 1 - r / 2 : r / 2
}

/** inverse standard normal CDF (Acklam, refined by one Halley step) */
export function phiInv(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425, hi = 1 - lo
  let x: number
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p <= hi) {
    const q = p - 0.5, r = q * q
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const e = phi(x) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2)
  return x - u / (1 + x * u / 2)
}

// ---- the paper's two formulas, pure ----

/** E[max SR] over N unskilled trials whose Sharpes have variance v (paper eq. for SR0) */
export function expectedMaxSharpe(n: number, v: number): number {
  if (n <= 1 || !(v > 0)) return 0
  return Math.sqrt(v) * ((1 - EULER) * phiInv(1 - 1 / n) + EULER * phiInv(1 - 1 / (n * Math.E)))
}

/** the Probabilistic Sharpe of `sr` against the benchmark `sr0` (all per observation) */
export function psr(sr: number, sr0: number, t: number, skew: number, kurt: number): number | null {
  const den = 1 - skew * sr + (kurt - 1) / 4 * sr * sr
  if (!(den > 0) || t < 2) return null
  return phi((sr - sr0) * Math.sqrt(t - 1) / Math.sqrt(den))
}

// ---- the ledger ----

export function toTrial(r: Raw): Trial | null {
  const sharpe = Number(r.sharpe), n = Number(r.n_obs)
  if (typeof r.run !== 'string' && typeof r.run !== 'number') return null
  if (!Number.isFinite(sharpe) || !Number.isFinite(n)) return null
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
  const rets = Array.isArray(r.returns) && r.returns.every((x: unknown) => typeof x === 'number' && Number.isFinite(x)) ? r.returns as number[] : null
  return {
    ts: typeof r.ts === 'string' ? r.ts : null, run: String(r.run), mechanic: typeof r.mechanic === 'string' ? r.mechanic : null,
    cell: r.cell && typeof r.cell === 'object' && !Array.isArray(r.cell) ? r.cell : {},
    sharpe, n_obs: n, skew: num(r.skew), kurt: num(r.kurt), returns: rets, status: String(r.status ?? 'kept'),
  }
}

export function parseTrials(text: string): Trial[] {
  return parseJsonl(text).rows.map(toTrial).filter((t): t is Trial => t !== null)
}

const canon = (v: unknown): string => v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  : JSON.stringify(v)

/** a DISTINCT trial = one (run, cell); a rerun of the same cell replaces it (latest row wins) */
export const trialKey = (t: Trial) => `${t.run}|${canon(t.cell)}`

export function distinct(trials: Trial[]): Trial[] {
  const m = new Map<string, Trial>()
  for (const t of trials) m.set(trialKey(t), t)
  return [...m.values()]
}

const variance = (xs: number[]) => {
  if (xs.length < 2) return 0
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1)
}

export type Dsr = { value: number | null; sr: number | null; sr0: number; n: number; v: number; t: number | null; skew: number | null; kurt: number | null; cell: Record<string, unknown> | null; why?: string }

/** DSR of one run, with N and the Sharpe variance read from the whole ledger for its mechanic */
export function dsrFor(ledger: Trial[], run: string): Dsr | null {
  const mine = distinct(ledger.filter(t => t.run === run))
  if (!mine.length) return null
  const mech = mine.find(t => t.mechanic)?.mechanic ?? null
  const pool = distinct(ledger.filter(t => (mech ? t.mechanic === mech : t.run === run)))
  const n = pool.length
  const v = variance(pool.map(t => t.sharpe))
  const sr0 = expectedMaxSharpe(n, v)
  const live = mine.filter(t => t.status !== 'abandoned')
  const base = { sr0, n, v }
  if (!live.length) return { ...base, value: null, sr: null, t: null, skew: null, kurt: null, cell: null, why: 'every trial of this run was abandoned: nothing was selected' }
  const best = live.reduce((a, b) => (b.sharpe > a.sharpe ? b : a))
  const out = { ...base, sr: best.sharpe, t: best.n_obs, skew: best.skew, kurt: best.kurt, cell: best.cell }
  if (best.skew === null || best.kurt === null) return { ...out, value: null, why: 'the selected trial carries no skew/kurtosis' }
  const value = psr(best.sharpe, sr0, best.n_obs, best.skew, best.kurt)
  return value === null ? { ...out, value: null, why: 'the non-normality term is not positive' } : { ...out, value }
}

// ---- PBO by CSCV ----

export type Pbo = {
  value: number | null; combos: number; n: number; t: number; s: number
  logits?: number[]; scatter?: { is: number; oos: number; best: boolean }[]; why?: string
}

/** every k-subset of 0..s-1 as a bitmask, in increasing order */
function subsets(s: number, k: number): number[] {
  const out: number[] = []
  for (let m = 0; m < 1 << s; m++) {
    let c = 0, x = m
    while (x) { x &= x - 1; c++ }
    if (c === k) out.push(m)
  }
  return out
}

/** ascending rank (1..N, ties averaged) of index i within xs */
function rankOf(xs: Float64Array, i: number): number {
  let below = 0, eq = 0
  for (let j = 0; j < xs.length; j++) { if (xs[j] < xs[i]) below++; else if (xs[j] === xs[i]) eq++ }
  return below + (eq + 1) / 2
}

/** PBO of one run's trials that carry a return path (all paths the same length, the most common one) */
export function pboFor(ledger: Trial[], run: string, opts: { s?: number; scatterMax?: number } = {}): Pbo | null {
  const s = opts.s ?? S_BLOCKS
  const withPath = distinct(ledger.filter(t => t.run === run)).filter(t => t.returns && t.returns.length)
  if (withPath.length < 2) return withPath.length ? { value: null, combos: 0, n: withPath.length, t: withPath[0].returns!.length, s, why: 'one trial with a return path: PBO needs at least two' } : null
  const lens = new Map<number, number>()
  for (const t of withPath) lens.set(t.returns!.length, (lens.get(t.returns!.length) ?? 0) + 1)
  const T = [...lens.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
  const trials = withPath.filter(t => t.returns!.length === T)
  const N = trials.length
  if (N < 2) return { value: null, combos: 0, n: N, t: T, s, why: 'no two return paths share a length' }
  const per = Math.floor(T / s)
  if (per < 2) return { value: null, combos: 0, n: N, t: T, s, why: `${T} observations cannot fill ${s} blocks of 2` }
  const off = T - per * s // the oldest remainder is dropped; blocks stay contiguous
  const sum = new Float64Array(N * s), sq = new Float64Array(N * s)
  trials.forEach((tr, i) => {
    const r = tr.returns!
    for (let b = 0; b < s; b++) {
      let a = 0, q = 0
      for (let k = off + b * per; k < off + (b + 1) * per; k++) { a += r[k]; q += r[k] * r[k] }
      sum[i * s + b] = a; sq[i * s + b] = q
    }
  })
  const sharpeOn = (mask: number, out: Float64Array) => {
    let cnt = 0
    for (let b = 0; b < s; b++) if (mask & (1 << b)) cnt += per
    for (let i = 0; i < N; i++) {
      let a = 0, q = 0
      for (let b = 0; b < s; b++) if (mask & (1 << b)) { a += sum[i * s + b]; q += sq[i * s + b] }
      const mu = a / cnt, v = (q - cnt * mu * mu) / (cnt - 1)
      out[i] = v > 0 ? mu / Math.sqrt(v) : mu > 0 ? Infinity : mu < 0 ? -Infinity : 0
    }
  }
  const all = (1 << s) - 1
  const masks = subsets(s, s / 2)
  const isS = new Float64Array(N), oosS = new Float64Array(N)
  const logits: number[] = []
  let over = 0
  const want = Math.max(1, Math.min(24, Math.floor((opts.scatterMax ?? 480) / N)))
  const step = Math.max(1, Math.floor(masks.length / want))
  const scatter: Pbo['scatter'] = []
  masks.forEach((m, ci) => {
    sharpeOn(m, isS); sharpeOn(all & ~m, oosS)
    let best = 0
    for (let i = 1; i < N; i++) if (isS[i] > isS[best]) best = i
    const w = rankOf(oosS, best) / (N + 1)
    const l = Math.log(w / (1 - w))
    logits.push(l)
    if (l <= 0) over++
    if (ci % step === 0 && scatter.length < want * N) {
      for (let i = 0; i < N; i++) scatter.push({ is: rankOf(isS, i) / N, oos: rankOf(oosS, i) / N, best: i === best })
    }
  })
  return { value: over / masks.length, combos: masks.length, n: N, t: T, s, logits, scatter }
}

// ---- per desk, cached on the file's size + mtime ----

export type RunTrials = {
  n_trials: number | null                // N for the run's mechanic; null = this run has no ledger rows
  run_trials: number                     // distinct trials of this run
  by_status: Record<string, number>      // rows of this run, by status (reruns counted as rows)
  dsr: Dsr | null
  pbo: Pbo | null
}

const cache = new Map<string, { sig: string; ledger: Trial[]; runs: Map<string, RunTrials> }>()

export function ledgerFile(fundRoot: string, desk: string) { return join(deskDir(desk, fundRoot), 'data', 'trials.jsonl') }

function sigOf(p: string): string | null {
  try { const s = statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return null }
}

export function statsFor(ledger: Trial[], run: string): RunTrials {
  const rows = ledger.filter(t => t.run === run)
  if (!rows.length) return { n_trials: null, run_trials: 0, by_status: {}, dsr: null, pbo: null }
  const by: Record<string, number> = {}
  for (const t of rows) by[t.status] = (by[t.status] ?? 0) + 1
  const dsr = dsrFor(ledger, run)
  return { n_trials: dsr?.n ?? null, run_trials: distinct(rows).length, by_status: by, dsr, pbo: pboFor(ledger, run) }
}

/** the desk's ledger and its per-run stats; empty when the desk has no trials.jsonl */
export function deskTrials(fundRoot: string, desk: string): { exists: boolean; ledger: Trial[]; stats: (run: string) => RunTrials } {
  const p = ledgerFile(fundRoot, desk)
  const sig = sigOf(p)
  if (sig === null) { cache.delete(desk); return { exists: false, ledger: [], stats: () => statsFor([], '') } }
  let c = cache.get(desk)
  if (!c || c.sig !== sig) {
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { /* raced away */ }
    c = { sig, ledger: parseTrials(text), runs: new Map() }
    cache.set(desk, c)
  }
  const cc = c
  return {
    exists: true, ledger: cc.ledger,
    stats: run => { let r = cc.runs.get(run); if (!r) { r = statsFor(cc.ledger, run); cc.runs.set(run, r) } return r },
  }
}

/** the table's slim view: scalars only (no logits, no scatter) */
export function slim(t: RunTrials) {
  return {
    n_trials: t.n_trials,
    dsr: t.dsr?.value ?? null,
    pbo: t.pbo?.value ?? null,
  }
}
