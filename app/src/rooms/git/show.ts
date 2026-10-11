// ROOM: git - `git show --stat` text as the drawer draws it: the message soft-wrapped (an author's
// hard line breaks inside a paragraph or a list item are joined, so the drawer's width decides),
// trailers dropped (the drawer's key/value table carries them), and the diffstat as numbers.

export type StatRow = { path: string; n: number; plus: number; minus: number; bin: boolean }
export type Show = { subject: string; blocks: { kind: 'p' | 'li'; text: string }[]; stat: StatRow[]; totals: { files: number; plus: number; minus: number } | null }

const STAT = /^\s(\S.*?)\s+\|\s+(?:(\d+)\s*([+-]*)|Bin\b.*)$/
const TOTAL = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/
const TRAILER = /^[A-Z][A-Za-z-]*: \S/

/** a commit subject up to its first " - " (the whole subject is the tooltip) */
export const shortSubject = (s: string) => s.split(' - ')[0].trim() || s

export function parseShow(text: string): Show {
  const lines = text.replace(/\r/g, '').split('\n')
  const stat: StatRow[] = []
  let totals: Show['totals'] = null
  const msg: string[] = []
  for (const l of lines) {
    const s = STAT.exec(l)
    if (s) {
      const n = s[2] ? Number(s[2]) : 0
      const signs = s[3] ?? ''
      const p = (signs.match(/\+/g) ?? []).length, m = (signs.match(/-/g) ?? []).length
      const plus = p + m ? Math.round(n * p / (p + m)) : 0
      stat.push({ path: s[1].trim(), n, plus, minus: n - plus, bin: !s[2] })
      continue
    }
    const t = TOTAL.exec(l)
    if (t) { totals = { files: Number(t[1]), plus: Number(t[2] ?? 0), minus: Number(t[3] ?? 0) }; continue }
    msg.push(l)
  }
  // paragraphs: blank-line separated; the last paragraph of trailers is dropped
  const paras: string[][] = []
  let cur: string[] = []
  for (const l of msg) { if (l.trim() === '') { if (cur.length) paras.push(cur); cur = [] } else cur.push(l) }
  if (cur.length) paras.push(cur)
  const subject = paras.length ? paras.shift()!.join(' ').trim() : ''
  while (paras.length && paras[paras.length - 1].every(l => TRAILER.test(l.trim()))) paras.pop()
  const blocks: Show['blocks'] = []
  for (const p of paras) {
    let item: { kind: 'p' | 'li'; text: string } | null = null
    for (const raw of p) {
      const l = raw.trim()
      const li = /^[-*] (.*)$/.exec(l)
      if (li) { if (item) blocks.push(item); item = { kind: 'li', text: li[1] }; continue }
      if (item) item.text += ` ${l}`
      else item = { kind: 'p', text: l }
    }
    if (item) blocks.push(item)
  }
  return { subject, blocks, stat, totals }
}

/** "loop: fix the gate" -> { prefix: "loop: ", rest: "fix the gate" }; no prefix (or nothing after it)
 *  -> { prefix: "", rest: subject }. The log draws the prefix faint so the text after it reads first */
export function splitSubject(s: string): { prefix: string; rest: string } {
  const i = s.indexOf(': ')
  if (i <= 0 || !s.slice(i + 2).trim()) return { prefix: '', rest: s }
  return { prefix: s.slice(0, i + 2), rest: s.slice(i + 2) }
}
