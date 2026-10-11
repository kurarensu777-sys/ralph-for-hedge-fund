import { verdictOf } from './engine.ts'
import { evidence, zero, type Counts } from './metrics.ts'
import type { Proposal, Window } from './proposals.ts'

/**
 * WATCH READ - what a proposal card draws, derived from its file as the last pass wrote it:
 *   n       scored events a side (M.evidence, the watch's own sample size) against minEvents
 *   signal  'read' (both sides measured on enough events), 'thin' (measured, too few events),
 *           'unmeasured' (a side has no score), null (never watched: proposed, vetoed before apply)
 *   verdict the file's verdict when the watch closed, else the one it reads SO FAR (verdictOf, the
 *           engine's own rule); 'no-signal' whenever signal is not 'read', never a flat 'same'
 *   delta   after - before, ONLY when signal is 'read' (a thin 1.00 -> 1.00 is not a result)
 *   days    elapsed / span of the watch window (span includes any no-signal extension)
 */
export type WatchRead = {
  n: { before: number | null; after: number | null; min: number }
  signal: 'read' | 'thin' | 'unmeasured' | null
  verdict: 'better' | 'same' | 'worse' | 'no-signal' | null
  delta: number | null
  days: { elapsed: number; span: number } | null
}

const DAY = 86_400_000
const nOf = (w: Window | null) => (w ? evidence({ ...zero(), ...w.counts } as Counts) : null)

export function watchRead(p: Pick<Proposal, 'state' | 'watch'>, cfg: { minEvents: number; tolerance: number }, now: number): WatchRead {
  const w = p.watch
  const min = cfg.minEvents
  const nb = nOf(w.before), na = nOf(w.after)
  const days = w.from === null || w.until === null ? null
    : { elapsed: Math.max(0, Math.min(now, w.until) - w.from) / DAY, span: Math.max(0, w.until - w.from) / DAY }
  if (w.from === null) return { n: { before: nb, after: na, min }, signal: null, verdict: null, delta: null, days }
  const bs = w.before?.score ?? null, as = w.after?.score ?? null
  const signal = bs === null || as === null ? 'unmeasured' : (nb ?? 0) < min || (na ?? 0) < min ? 'thin' : 'read'
  const soFar = verdictOf(bs, as, cfg.tolerance, { before: nb ?? 0, after: na ?? 0, min })
  const verdict = w.verdict ?? (p.state === 'watching' || p.state === 'applied' ? soFar : null)
  return { n: { before: nb, after: na, min }, signal, verdict, delta: signal === 'read' ? (as as number) - (bs as number) : null, days }
}
