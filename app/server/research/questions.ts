import { readFileSync, statSync } from 'node:fs'
import { SECTION_IDS, type QuestionSection, type Questions } from '../../shared/research.ts'
import { FIG_ID } from './charts.ts'
import { resolveId } from './scan.ts'

/**
 * The Questions block's reading of a notebook (B-0524): under each `## S2`..`## S6` heading the question (the heading's own
 * `| question | gate |` table, first data row), its figures (cells tagged fig:s<n>-<name> with a PNG output) and its tables
 * (text/markdown outputs); under `## S7` the gates table. A notebook that does not head every one of S0-S7 has no
 * questions to read and gives null: a legacy study draws nothing, never a guess. Pure apart from the file read.
 */

type Nb = { cells?: any[] }

const join = (v: unknown) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '')
const HEAD = /^##\s+(S[0-7])\b(?:[ \t]+[^\w\s]+)?[ \t]*(.*)$/m
const SHOWN = ['S2', 'S3', 'S4', 'S5', 'S6']

/** the cells of the first markdown table of a text: header row and first data row; null when it has none */
export function firstRow(text: string): { head: string[]; row: string[] } | null {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex(l => l.trimStart().startsWith('|'))
  if (at < 0 || !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[at + 1] ?? '') || !(lines[at + 2] ?? '').trimStart().startsWith('|')) return null
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
  return { head: cells(lines[at]), row: cells(lines[at + 2]) }
}

export function questionsOf(nb: Nb): Questions | null {
  const sections: QuestionSection[] = []
  let cur: QuestionSection | null = null
  let verdict: Questions['verdict'] = null
  const seen = new Set<string>()
  ;(nb.cells ?? []).forEach((c, i) => {
    if (c?.cell_type === 'markdown') {
      const src = join(c.source)
      const h = HEAD.exec(src)
      if (h) {
        seen.add(h[1])
        const t = firstRow(src.slice(h.index + h[0].length))
        cur = { id: h[1], name: h[2].trim(), cell: i, question: t?.row[0] || null, ruleHead: t?.head[1] || null, rule: t?.row[1] || null, figs: [], tables: [] }
        if (SHOWN.includes(h[1])) sections.push(cur)
      } else if (/^##\s/m.test(src)) cur = null   // the Appendix or any later chapter closes the last section
      return
    }
    if (!cur) return
    const tags: unknown[] = c?.metadata?.tags ?? []
    for (const o of c?.outputs ?? []) {
      const d = o?.data ?? {}
      const fig = tags.find((t): t is string => typeof t === 'string' && FIG_ID.test(t))
      if (fig && d['image/png'] && SHOWN.includes(cur.id) && !cur.figs.some(f => f.fig === fig)) cur.figs.push({ fig, cell: i })
      else if (d['text/markdown']) {
        const md = join(d['text/markdown'])
        if (SHOWN.includes(cur.id)) cur.tables.push({ md, cell: i })
        else if (cur.id === 'S7' && !verdict && /^\s*\|\s*Gate\s*\|/.test(md)) verdict = { md, cell: i }
      }
    }
  })
  return SECTION_IDS.every(s => seen.has(s)) ? { sections, verdict } : null
}

type Cached = { mtime: number; bytes: number; questions: Questions | null }
const CACHE = new Map<string, Cached>()
const KEPT = 8

/** one notebook's questions, parsed once per (mtime, size), the last few notebooks only */
export function questionsFor(root: string, id: string): { mtime: number; questions: Questions | null } {
  const abs = resolveId(root, id)
  const st = statSync(abs)
  let hit = CACHE.get(abs)
  if (!hit || hit.mtime !== st.mtimeMs || hit.bytes !== st.size) {
    hit = { mtime: st.mtimeMs, bytes: st.size, questions: questionsOf(JSON.parse(readFileSync(abs, 'utf8'))) }
    CACHE.delete(abs)
    CACHE.set(abs, hit)
    while (CACHE.size > KEPT) CACHE.delete(CACHE.keys().next().value!)
  }
  return { mtime: hit.mtime, questions: hit.questions }
}
