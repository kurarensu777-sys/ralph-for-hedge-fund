import type { HeatRow, HeatState } from './heat.tsx'

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16)
const WORD: Record<HeatState, string> = { ok: 'ok', warn: 'warn', fail: 'fail', unknown: 'unknown', stale: 'stale', none: 'no reading' }

// ---- the summary: one strip per probe OWNER, the worst probe per hour ----
// The owner's approved idea 5 (health heat strip): the top of Health answers "who is red, and
// when" before the per-probe table does. A cell is the WORST state any of that owner's probes
// had in the hour; it carries `held` (named in its tooltip) only when every probe at that state was held.
// Every row of the probe table counts toward its owner, including one with no recorded hourly
// reading (fundd, backups): it adds a grey "no reading recorded" to every hour, never a colour.

const WORST: Record<HeatState, number> = { fail: 0, stale: 1, warn: 2, unknown: 3, ok: 4, none: 5 }

export type OwnerCell = { s: HeatState; held: boolean; who: string[]; none: string[] }
/** `unrec`: the owner's probes that have no heat row at all */
export type OwnerRow = { owner: string; probes: string[]; unrec: string[]; cells: OwnerCell[] }

/** fold probe rows into one row per owner; `ownerOf` maps a probe id to its owner agent; `ids`
 *  (optional) is every row of the table, so a probe with no heat row still counts */
export function ownerRows(items: HeatRow[], ownerOf: (id: string) => string, ids: string[] = []): OwnerRow[] {
  const hours = Math.max(0, ...items.map(r => r.cells.length))
  const have = new Set(items.map(r => r.id))
  const all = [...items, ...[...new Set(ids)].filter(id => !have.has(id)).map(id => ({ id, cells: [], unrec: true }))]
  const by = new Map<string, (HeatRow & { unrec?: boolean })[]>()
  for (const r of all) { const o = ownerOf(r.id); by.set(o, [...(by.get(o) ?? []), r]) }
  const out: OwnerRow[] = []
  for (const [owner, rows] of by) {
    const cells = Array.from({ length: hours }, (_, h) => {
      const at = rows.map(r => ({ id: r.id, c: r.cells[h] })).filter(x => x.c)
      const s = at.reduce<HeatState>((w, x) => WORST[x.c.s] < WORST[w] ? x.c.s : w, 'none')
      const worst = at.filter(x => x.c.s === s)
      const held = s !== 'none' && s !== 'stale' && worst.every(x => !x.c.seen)
      const none = rows.filter(r => !r.cells[h] || r.cells[h].s === 'none').map(r => r.id).sort()
      return { s, held, who: s === 'none' ? [] : worst.map(x => x.id), none }
    })
    out.push({ owner, probes: rows.map(r => r.id).sort(), unrec: rows.filter(r => r.unrec).map(r => r.id).sort(), cells })
  }
  // the worst owner first (fail, then stale ...), then by name
  const rank = (o: OwnerRow) => Math.min(WORST.none, ...o.cells.slice(-1).map(c => WORST[c.s]))
  return out.sort((a, b) => rank(a) - rank(b) || a.owner.localeCompare(b.owner))
}

/** the owner label's tooltip: every probe it counts, the ones with no hourly record marked */
export function ownerLabelTitle(o: OwnerRow): string {
  const un = new Set(o.unrec)
  return `${o.owner}: ${o.probes.length} probe${o.probes.length === 1 ? '' : 's'}${o.unrec.length ? `, ${o.probes.length - o.unrec.length} with hourly readings` : ''}\n${o.probes.map(p => un.has(p) ? `${p} (no reading recorded)` : p).join(', ')}`
}

export function ownerCellTitle(o: OwnerRow, i: number, hourStart: number): string {
  const c = o.cells[i]
  const at = `${hhmm(hourStart)}-${hhmm(hourStart + 3_600_000)}Z`
  if (c.s === 'none') return `${o.owner} ${at}  no reading recorded`
  const head = `${o.owner} ${at}  ${WORD[c.s]}${c.held ? ' (held)' : ''}\n${c.s === 'ok' ? `${c.who.length} of ${o.probes.length} ok` : c.who.join(', ')}`
  return c.none.length ? `${head}\n${c.none.length} no reading recorded: ${c.none.join(', ')}` : head
}
