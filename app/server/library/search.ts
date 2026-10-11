// FULL-TEXT SEARCH across book bodies: an in-memory index (one lower-cased copy of every book,
// refreshed per file when its mtime moves). The library is a few hundred files; a scan per query
// is a few ms, so no full-text table is kept in step with the disk.
import { chaptersOf } from '../../shared/bookmeta.ts'
import type { SearchHit } from './types.ts'

/** one searchable unit: a book, or one chapter of a book written as chapters (`chapter` set; `path` is still the BOOK's) */
export type Doc = { path: string; title: string; shelf: string; series: string; text: string; book?: string; chapter?: { slug: string; title: string } }

/**
 * pure: the docs one book makes. A book written as chapters (every `## ` heading followed by a Read when line, as
 * app/tools/context.py counts them) is one doc per chapter, titled `Book > Chapter`, plus one for the text above its
 * first chapter when there is any; any other book (a reference note, a loose note) is one doc.
 */
export function docsOf(b: { path: string; title: string; shelf: string; series: string }, text: string): Doc[] {
  const whole: Doc = { path: b.path, title: b.title, shelf: b.shelf, series: b.series, text, book: b.title }
  const chs = chaptersOf(text)
  if (!chs.length || !chs.every(c => c.readWhen)) return [whole]
  const out: Doc[] = chs.map(c => ({ path: b.path, title: `${b.title} > ${c.title}`, shelf: b.shelf, series: b.series, text: c.text, book: b.title, chapter: { slug: c.slug, title: c.title } }))
  // the text above the first chapter, less its frontmatter and its own title line (the title is the hit's)
  const lead = text.slice(0, Math.max(0, text.indexOf(chs[0].text))).replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').replace(/^\s*#[^\n]*\n/, '').trim()
  if (lead) out.unshift({ ...whole, text: lead })
  return out
}

/** split a query into terms; "quoted phrases" stay one term. Lower case, 2+ chars, at most 8 */
export function terms(q: string): string[] {
  const out: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(q.toLowerCase()))) {
    const t = (m[1] ?? m[2]).trim()
    if (t.length >= 2 && !out.includes(t)) out.push(t)
  }
  return out.slice(0, 8)
}

function count(hay: string, needle: string, cap = 50): number {
  let n = 0, i = hay.indexOf(needle)
  while (i >= 0 && n < cap) { n++; i = hay.indexOf(needle, i + needle.length) }
  return n
}

const SNIP = 180

/** a window of the body around the first hit, whitespace collapsed, with every term marked */
export function snippet(text: string, ts: string[]): { text: string; marks: [number, number][] } {
  const lower = text.toLowerCase()
  // the title line is already shown beside the snippet: prefer a hit in the body
  const fm = /^---\r?\n[\s\S]*?\r?\n---/.exec(text)
  const bodyAt = fm ? fm[0].length : 0
  const h1 = /^\s*#[^\n]*\n/.exec(text.slice(bodyAt))
  const from = bodyAt + (h1 ? h1[0].length : 0)
  const first = (min: number) => { let at = -1; for (const t of ts) { const i = lower.indexOf(t, min); if (i >= 0 && (at < 0 || i < at)) at = i } return at }
  let at = first(from)
  if (at < 0) at = first(0)
  if (at < 0) at = from < text.length ? from : 0
  let start = Math.max(0, at - 60)
  if (start > 0) { const sp = text.lastIndexOf(' ', start); if (sp > at - 90) start = sp + 1 }
  const end = Math.min(text.length, start + SNIP)
  let raw = text.slice(start, end)
  // collapse whitespace by hand so the marks index into what is shown
  raw = raw.replace(/\s+/g, ' ')
  const shown = (start > 0 ? '... ' : '') + raw + (end < text.length ? ' ...' : '')
  const sl = shown.toLowerCase()
  const marks: [number, number][] = []
  for (const t of ts) {
    let i = sl.indexOf(t)
    while (i >= 0) { marks.push([i, i + t.length]); i = sl.indexOf(t, i + t.length) }
  }
  marks.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const m of marks) { const l = merged[merged.length - 1]; if (l && m[0] <= l[1]) l[1] = Math.max(l[1], m[1]); else merged.push([...m]) }
  return { text: shown, marks: merged }
}

/**
 * pure: every doc that holds EVERY term (in its title, path or body), ranked by title hits then
 * body hit count. `lower` is the doc text lower-cased once (the index).
 */
export function search(q: string, docs: (Doc & { lower: string })[], limit = 50): { hits: SearchHit[]; total: number; terms: string[] } {
  const ts = terms(q)
  if (!ts.length) return { hits: [], total: 0, terms: ts }
  const hits: SearchHit[] = []
  for (const d of docs) {
    const title = `${d.title} ${d.path}`.toLowerCase()
    let score = 0, body = 0, ok = true
    for (const t of ts) {
      const inTitle = title.includes(t)
      const n = count(d.lower, t)
      if (!inTitle && n === 0) { ok = false; break }
      score += (inTitle ? 100 : 0) + Math.min(n, 50)
      body += n
    }
    if (!ok) continue
    const s = snippet(d.text, ts)
    hits.push({ path: d.path, book: d.book ?? d.title, title: d.title, shelf: d.shelf, series: d.series, score, hits: body, snippet: s.text, marks: s.marks, ...(d.chapter ? { chapter: d.chapter } : {}) })
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.chapter?.slug ?? '').localeCompare(b.chapter?.slug ?? ''))
  return { hits: hits.slice(0, limit), total: hits.length, terms: ts }
}
