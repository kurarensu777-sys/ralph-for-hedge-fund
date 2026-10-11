// The explorer's compact index: one market group's last N hours folded from its dashboards' own
// hourly cells. Pure, so the rule is tested (test/dash-index.test.ts).

type Cell = 'ok' | 'warn' | 'fail' | 'off' | 'unknown' | 'part' | null

/** worst first: a failing hour anywhere in the group is the group's hour; an unmeasured-but-held
 *  hour ('unknown') outranks ok, so a gap never reads green; stopped and no-check come last */
const RANK: Record<string, number> = { fail: 6, warn: 5, unknown: 4, ok: 3, part: 2, off: 1 }

/** the last `n` hours of a group: per hour the worst cell across the group's histories; an hour
 *  no dashboard has a cell for is null (drawn dim, never ok). Histories are aligned on their END
 *  (the hour in progress), since every strip is the same 24h window. */
export function groupHeat(hs: { cells: Cell[] }[], n = 6): Cell[] {
  const out: Cell[] = Array.from({ length: n }, () => null)
  for (const h of hs) {
    const tail = h.cells.slice(-n)
    const off = n - tail.length
    tail.forEach((c, i) => {
      if (c === null) return
      const cur = out[off + i]
      if (cur === null || (RANK[c] ?? 0) > (RANK[cur] ?? 0)) out[off + i] = c
    })
  }
  return out
}
