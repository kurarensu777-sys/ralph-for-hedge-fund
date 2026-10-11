// THE QUESTIONS BLOCK's text half (tested in test/research-questions.test.ts): a notebook's text/markdown output
// as blocks (a table, or a paragraph) and one cell's inline marks (**bold**, `code`). The block draws React nodes,
// never HTML, so a notebook's own markup is shown as text and never run.

export type QBlock = { kind: 'table'; head: string[]; rows: string[][] } | { kind: 'text'; text: string }
export type QSpan = { kind: 'b' | 'code' | 'text'; text: string }

const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
const isSep = (l: string | undefined) => !!l && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l)

export function blocksOf(md: string): QBlock[] {
  const out: QBlock[] = []
  const lines = md.split(/\r?\n/)
  for (let i = 0; i < lines.length;) {
    const l = lines[i]
    if (l.trimStart().startsWith('|') && isSep(lines[i + 1])) {
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && lines[j].trimStart().startsWith('|')) rows.push(cells(lines[j++]))
      out.push({ kind: 'table', head: cells(l), rows })
      i = j
    } else if (l.trim()) {
      const text: string[] = []
      while (i < lines.length && lines[i].trim() && !(lines[i].trimStart().startsWith('|') && isSep(lines[i + 1]))) text.push(lines[i++].trim())
      out.push({ kind: 'text', text: text.join(' ') })
    } else i++
  }
  return out
}

export function spansOf(s: string): QSpan[] {
  const out: QSpan[] = []
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g
  let at = 0
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push({ kind: 'text', text: s.slice(at, m.index) })
    out.push(m[1] !== undefined ? { kind: 'b', text: m[1] } : { kind: 'code', text: m[2] })
    at = m.index + m[0].length
  }
  if (at < s.length) out.push({ kind: 'text', text: s.slice(at) })
  return out
}

/** the question block's counts: every section's figures and tables */
export const countsOf = (secs: { figs: unknown[]; tables: unknown[] }[]) => ({
  questions: secs.length, figures: secs.reduce((n, s) => n + s.figs.length, 0), tables: secs.reduce((n, s) => n + s.tables.length, 0),
})
