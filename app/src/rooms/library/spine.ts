/**
 * The SHORT title a book shows wherever space is tight (a spine, a matrix row, a drawer head): the
 * name half of its title. A desk-law book's "CLAUDE.md - " prefix, the explainer after a " - " /
 * ": " and a trailing "(seat)" go; a ", " clause goes only when what is left still holds two content
 * words ("Empty, failed and unknown..." keeps its list). A name longer than four words keeps its
 * first three content words, never ends on a little word, and reaches one word further (to five)
 * rather than stop on a single content word. The full title is always the tooltip.
 */
const SMALL = new Set(['a', 'an', 'the', 'is', 'are', 'be', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'for', 'per', 'by', 'it', 'its', 'not', 'never', 'until', 'one', 'what', 'when', 'where', 'how', 'as', 'with', 'from', 'two', 'three', 'four', 'five', 'both'])
const small = (w: string) => SMALL.has(w.toLowerCase().replace(/[^a-z0-9'-]/g, ''))
const contentWords = (t: string) => t.split(/\s+/).filter(w => w && !small(w)).length

export function shortTitle(title: string): string {
  let t = title.trim().replace(/^CLAUDE\.md\s*[-:]\s*/i, '')
  const cut = t.search(/\s+-\s+|:\s+/)
  if (cut > 0) t = t.slice(0, cut)
  t = t.replace(/\s*\([^)]*\)\s*$/, '').trim()
  const comma = t.search(/,\s+/)
  if (comma > 0 && contentWords(t.slice(0, comma)) >= 2) t = t.slice(0, comma)
  // a list the comma could not cut keeps its items and loses its "and": "Empty, failed and unknown" -> "Empty, failed, unknown"
  else if (comma > 0) t = t.replace(/^([^,]+), (\S+) and (\S+)/, '$1, $2, $3')
  if (!t) return title.trim()
  const words = t.split(/\s+/)
  if (words.length <= 4) return t
  const w = /^(a|an|the)$/i.test(words[0]) ? words.slice(1) : words
  const out: string[] = []
  let content = 0
  let i = 0
  for (; i < w.length; i++) {
    if (out.length >= 4 || content >= 3) break
    out.push(w[i])
    if (!small(w[i])) content++
  }
  const trim = () => { while (out.length > 1 && small(out[out.length - 1])) out.pop() }
  trim()
  if (contentWords(out.join(' ')) < 2) {
    // one content word is a fragment ("Generator and the three"): reach on to the next one, up to five words
    out.splice(0, out.length, ...w.slice(0, i))
    while (i < w.length && out.length < 5 && contentWords(out.join(' ')) < 2) out.push(w[i++])
    trim()
  }
  const s = out.join(' ').replace(/[,;]$/, '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** the label a book's SPINE carries (a dozen characters vertically): its short title */
export const spineLabel = shortTitle

/**
 * Spine labels for one shelf, never ten spines in a row saying the same thing: where two or more books'
 * short titles collide ("Field read - Etape", "Field read - Heatmap"; "Carry - funding", "Carry - fees"),
 * each of those takes the short form of what follows the " - " / ": " instead. title -> label.
 */
export function distinctLabels(titles: string[]): Map<string, string> {
  const short = new Map(titles.map(t => [t, shortTitle(t)]))
  const n = new Map<string, number>()
  for (const l of short.values()) n.set(l, (n.get(l) ?? 0) + 1)
  const out = new Map<string, string>()
  for (const [t, l] of short) {
    const rest = t.replace(/^CLAUDE\.md\s*[-:]\s*/i, '')
    const cut = rest.search(/\s+-\s+|:\s+/)
    out.set(t, (n.get(l) ?? 0) > 1 && cut > 0 ? shortTitle(rest.slice(cut).replace(/^\s*[-:]\s*/, '')) : l)
  }
  return out
}

/** a vet-list title in two or three words: "The Carry Desk's Beliefs" -> "Carry Beliefs" */
export function vetLabel(title: string): string {
  const t = title.trim().replace(/^The\s+/i, '').replace(/\bDesk'?s?\b\s*/g, '').replace(/\s+/g, ' ').trim()
  return shortTitle(t || title)
}

/**
 * The words every spine on one shelf would repeat ("Carry desk engineer", "Rates desk
 * engineer" -> " desk engineer"): a trailing run of words shared by at least half the shelf's
 * books (and at least two). Dropped from the spine; the full title stays in the tooltip.
 */
export function sharedSuffix(titles: string[]): string {
  const short = titles.map(t => shortTitle(t).split(/\s+/))
  if (short.length < 2) return ''
  let best = ''
  for (const words of short) {
    for (let k = 1; k < words.length; k++) {
      const suf = ' ' + words.slice(words.length - k).join(' ')
      const n = short.filter(w => (' ' + w.join(' ')).endsWith(suf) && w.length > k).length
      if (n >= 2 && n * 2 >= short.length && suf.length > best.length) best = suf
    }
  }
  return best
}
