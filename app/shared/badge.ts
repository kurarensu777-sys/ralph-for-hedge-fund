/** Two-letter agent badges, collision-aware.
 *  Base rule: the id's last segment ("dash:trade" -> "trade"), first two letters.
 *  When two ids share a badge, ids are taken in sorted order: the first keeps its base,
 *  each later one keeps its first letter and takes the next letter of its own name
 *  (consonants first, then vowels) that makes the pair unique ("tradfi" -> "TD"). */
export const baseOf = (id: string) => (id.includes(':') ? id.split(':').pop()! : id)

const naive = (id: string) => baseOf(id).slice(0, 2).toUpperCase()

export function badgeMap(ids: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const id of [...new Set(ids)].sort()) {
    const b = naive(id)
    if (!used.has(b)) { out.set(id, b); used.add(b); continue }
    const s = baseOf(id).toUpperCase().replace(/[^A-Z0-9]/g, '')
    const rest = s.slice(1).split('')
    const order = [...rest.filter(c => !'AEIOU'.includes(c)), ...rest.filter(c => 'AEIOU'.includes(c))]
    const pick = order.map(c => s[0] + c).find(c => !used.has(c))
      ?? Array.from({ length: 10 }, (_, i) => s[0] + i).find(c => !used.has(c)) ?? b
    out.set(id, pick); used.add(pick)
  }
  return out
}

/** the ids that share a badge after the rule (empty = every badge unique) */
export function badgeCollisions(ids: string[]): string[][] {
  const by = new Map<string, string[]>()
  for (const [id, b] of badgeMap(ids)) by.set(b, [...(by.get(b) ?? []), id])
  return [...by.values()].filter(v => v.length > 1)
}

export const naiveBadge = naive
