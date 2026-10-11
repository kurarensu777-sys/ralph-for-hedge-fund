import type { BookOutcome, LibOutcomes } from '../../../server/library/types.ts'
import { useApi } from '../../lib/api.ts'

export function useOutcomes() { return useApi<LibOutcomes>('/api/library/outcomes', ['library', 'config']) }

const pct = (x: number) => `${Math.round(x * 100)}%`

/**
 * A diverging bar: harmful sessions grow left (red), helpful right (green), from a centre line;
 * n in small faint type. Dashed when n is under the threshold (too few sessions to say anything).
 */
export function PmBar({ o, min, unknown }: { o: BookOutcome | undefined; min: number; unknown?: boolean }) {
  if (unknown) return <span className="library-pm none" title="outcomes could not be read">?</span>
  if (!o || !o.n) return <span className="library-pm none" title="no session has pulled it">-</span>
  const thin = o.n < min
  const title = [
    `${o.n} session${o.n === 1 ? '' : 's'} pulled it (${o.pulls} pull${o.pulls === 1 ? '' : 's'})`,
    `${o.helpful} helpful · ${o.harmful} harmful · ${o.n - o.helpful - o.harmful} neutral`,
    o.net === null ? '' : `net ${o.net >= 0 ? '+' : ''}${o.net.toFixed(2)}`,
    thin ? `under n=${min}: not enough to judge` : '',
  ].filter(Boolean).join('\n')
  return (
    <span className={`library-pm ${thin ? 'thin' : ''}`} title={title}>
      <span className="bar">
        <span className="l"><i style={{ width: pct(o.harmful / o.n) }} /></span>
        <span className="r"><i style={{ width: pct(o.helpful / o.n) }} /></span>
      </span>
      <span className="n">{o.n}</span>
    </span>
  )
}
