// ROOM: system - the ORPHAN line under Health (pure, tested in test/system-orphans.test.ts). An
// orphan is a stored reading outside staleness.py's expected set (the server splits them out of
// `probes`); it is one dim line, never a tile, a group, a dot or the badge.

type Orphan = { id: string; ageS: number | null }

const age = (s: number | null) => s === null ? 'no date' : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`

/** "2 orphan readings" and its tooltip (each name and age); null when there is none to say */
export function orphanLine(orphans: Orphan[] | undefined, why: string | null | undefined): { text: string; title: string } | null {
  const os = orphans ?? []
  if (!os.length) return why ? { text: 'orphans unknown', title: `every reading is judged: the expected set could not be read\n${why}` } : null
  return {
    text: `${os.length} orphan reading${os.length === 1 ? '' : 's'}`,
    title: [`readings nothing is known to write (outside app/tools/probes/staleness.py's expected set); never counted, kept in the store`,
      ...os.map(o => `${o.id}: ${age(o.ageS)} old`)].join('\n'),
  }
}
