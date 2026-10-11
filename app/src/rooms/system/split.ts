// Health's split (round 2 of the UI loop): failing and unknown probes LEAD as rows; every probe
// that is plainly ok (status ok, inside its window) folds into one "N ok" card. A stale ok is
// not ok: it leads. Order inside the lead: fail, warn, unknown, then by id.

const RANK: Record<string, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 }

export type Splittable = { id: string; status: string; stale: boolean }

export const isOk = (p: Splittable) => p.status === 'ok' && !p.stale

export function splitProbes<T extends Splittable>(probes: T[]): { lead: T[]; ok: T[] } {
  const sorted = [...probes].sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2) || a.id.localeCompare(b.id))
  return { lead: sorted.filter(p => !isOk(p)), ok: sorted.filter(isOk) }
}

// Round 3 (option-B card groups): one card per owner category. Each card carries its own split;
// the cards order by their worst LEADING probe (fail, then warn or stale, then unknown, then a
// card that is all ok), ties by the given category order, then by name.

const LEAD_RANK = (p: Splittable) => p.status === 'fail' ? 0 : p.status === 'warn' || p.stale ? 1 : 2

export type Card<T> = { owner: string; lead: T[]; ok: T[]; rank: number }

export function groupCards<T extends Splittable>(probes: T[], ownerOf: (p: T) => string, order: string[] = []): Card<T>[] {
  const by = new Map<string, T[]>()
  for (const p of probes) { const o = ownerOf(p); by.set(o, [...(by.get(o) ?? []), p]) }
  const pos = (o: string) => { const i = order.indexOf(o); return i < 0 ? order.length : i }
  return [...by].map(([owner, ps]) => {
    const { lead, ok } = splitProbes(ps)
    return { owner, lead, ok, rank: lead.length ? Math.min(...lead.map(LEAD_RANK)) : 3 }
  }).sort((a, b) => a.rank - b.rank || pos(a.owner) - pos(b.owner) || a.owner.localeCompare(b.owner))
}

/** a card header's live dot (option B): red when a probe fails, amber when one is stale or warns,
 *  hollow when one is unknown, none when every probe is ok */
export const cardDot = (rank: number): 'fail' | 'warn' | 'unknown' | null => rank === 0 ? 'fail' : rank === 1 ? 'warn' : rank === 2 ? 'unknown' : null
