// A book's topics, and a shelf's list of them: ONE grammar for every reader - the library scan, the
// link audit, the commit guard (scripts/hooks, plain node), the drafts and the UI. No imports.
//
// A shelf names its topics in the frontmatter of its top _series.md, an ordered map id -> what it holds:
//
//   ---
//   title: Platform - the shelf
//   topics:
//     data: data I/O, the row contract, fetchers
//     engines: the carry and directional backtest engines
//   ---
//
// A book on that shelf declares 1 to 3 of them, one line in its own frontmatter:
//
//   ---
//   topics: [engines, strategy]
//   ---
//
// A shelf whose index names no topics has none, and asks nothing of its books. Who must READ a book
// is never written here: it is derived from the boot lists and the Recall tables (server/library/need.ts).

export const TOPIC_RE = /^[a-z][a-z0-9-]*$/
/** a book carries at most this many */
export const MAX_TOPICS = 3
/** a shelf names at most this many */
export const MAX_VOCAB = 10

export type Topic = { id: string; holds: string }

const FM = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** the frontmatter block's body, or null when the file opens with none */
export function frontmatter(text: string): string | null {
  return FM.exec(text)?.[1] ?? null
}

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '').trim()

/** a book's `topics:` as written (a bad id is kept, so it can be named); null = no `topics:` key */
export function topicsOf(text: string): string[] | null {
  const fm = frontmatter(text)
  if (fm == null) return null
  const lines = fm.split(/\r?\n/)
  const i = lines.findIndex(l => /^topics:/.test(l))
  if (i < 0) return null
  const v = lines[i].slice('topics:'.length).trim()
  if (v.startsWith('[')) return v.replace(/^\[|\]\s*$/g, '').split(',').map(unquote).filter(Boolean)
  if (v) return [unquote(v)]
  const out: string[] = []
  for (const l of lines.slice(i + 1)) {
    const m = /^\s+-\s*(.+)$/.exec(l)
    if (!m) break
    out.push(unquote(m[1]))
  }
  return out
}

/** a shelf's list from its top _series.md: the indented `id: holds` lines under `topics:`; null = none named */
export function vocabOf(text: string): Topic[] | null {
  const fm = frontmatter(text)
  if (fm == null) return null
  const lines = fm.split(/\r?\n/)
  const i = lines.findIndex(l => /^topics:\s*$/.test(l))
  if (i < 0) return null
  const out: Topic[] = []
  for (const l of lines.slice(i + 1)) {
    if (!/^\s+\S/.test(l)) break
    const m = /^\s+([^:]+?):\s*(.*)$/.exec(l)
    if (m) out.push({ id: unquote(m[1]), holds: unquote(m[2]) })
  }
  return out
}

/** what is wrong with a shelf's list, one line each (empty = sound) */
export function vocabFaults(vocab: Topic[], shelf: string): string[] {
  const out: string[] = []
  if (!vocab.length) out.push('topics: names none')
  if (vocab.length > MAX_VOCAB) out.push(`${vocab.length} topics (at most ${MAX_VOCAB})`)
  const seen = new Set<string>()
  for (const t of vocab) {
    if (!TOPIC_RE.test(t.id)) out.push(`"${t.id}" is not a topic id (a-z, 0-9, -)`)
    if (t.id === shelf) out.push(`"${t.id}" repeats the shelf's own name`)
    if (seen.has(t.id)) out.push(`"${t.id}" is named twice`)
    seen.add(t.id)
  }
  return out
}

/** what is wrong with a book's topics against its shelf's list, or null when they are sound */
export function topicFault(topics: string[] | null, vocab: Topic[]): string | null {
  const ids = vocab.map(t => t.id)
  const list = ids.join(', ')
  if (!topics || !topics.length) return `no topics (this shelf's: ${list})`
  if (topics.length > MAX_TOPICS) return `${topics.length} topics (at most ${MAX_TOPICS})`
  const bad = topics.filter(t => !ids.includes(t))
  if (bad.length) return `${bad.map(t => `"${t}"`).join(', ')} not on this shelf (${list})`
  if (new Set(topics).size !== topics.length) return 'a topic is named twice'
  return null
}

// ---- chapters (B-0345): a book is ONE file of chapters, and a boot list or Recall row may name one ----
//
// A chapter is a `## Title` heading (not `###`, not inside a fence). Its next non-empty line is
// `Read when: <the moment>`. It runs to the next `## ` heading or the end of the file. It is addressed
// as `<book path>#<slug>`; the slug is the title lower-cased, every run of non-alphanumerics a single `-`,
// leading and trailing `-` trimmed: `app/library/law/how-we-work.md#who-writes-where`.

/** a book's `type:` values */
export const BOOK_TYPES = ['guide', 'strategy'] as const

/** a chapter title as its address: lower-cased, runs of non-alphanumerics -> `-`, trimmed */
export function slugOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** `<book>.md#<slug>` -> {path, slug}; anything else (no `#`, an empty slug, a `#` in a folder name) -> the
 *  whole ref as the path and slug null */
export function splitRef(ref: string): { path: string; slug: string | null } {
  const m = /^(.*\.md)#([^#]*)$/i.exec(ref)
  if (!m) return { path: ref, slug: null }
  const slug = m[2].trim()
  return { path: m[1], slug: slug || null }
}

export type Chapter = { slug: string; title: string; readWhen: string; text: string }

const plainTitle = (s: string) => s.replace(/`/g, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()

/** every chapter of a book, in order: the slice from its heading line to the next `## ` or the end. A
 *  repeated slug is kept (the first one is the one a ref reaches). Frontmatter and fences are skipped. */
export function chaptersOf(text: string): Chapter[] {
  const body = FM.exec(text)
  const start = body ? body[0].length : 0
  const lines = text.slice(start).split(/(?<=\n)/)
  const heads: { at: number; title: string }[] = []
  let fence = false, at = 0
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence
    else if (!fence) {
      const m = /^##[ \t]+(.+?)[ \t]*#*[ \t]*\r?\n?$/.exec(raw)
      if (m && !raw.startsWith('###')) heads.push({ at, title: plainTitle(m[1]) })
    }
    at += raw.length
  }
  const rest = text.slice(start)
  return heads.map((h, i) => {
    const slice = rest.slice(h.at, i + 1 < heads.length ? heads[i + 1].at : rest.length)
    const after = slice.split(/\r?\n/).slice(1).find(l => l.trim())
    const rw = after ? /^Read when:[ \t]*(.*)$/i.exec(after.trim()) : null
    return { slug: slugOf(h.title), title: h.title, readWhen: rw ? plainTitle(rw[1]) : '', text: slice }
  })
}

/** the chapter a slug names (the first, when a slug repeats), or null when no heading has it */
export function chapterOf(text: string, slug: string): { title: string; readWhen: string; text: string } | null {
  const c = chaptersOf(text).find(x => x.slug === slug)
  return c ? { title: c.title, readWhen: c.readWhen, text: c.text } : null
}

function fmScalar(text: string, key: string): string | null {
  const fm = frontmatter(text)
  if (fm == null) return null
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm)
  if (!m) return null
  const v = unquote(m[1].replace(/\s+#.*$/, ''))
  return v || null
}

/** a book's frontmatter `type:` as written (guide | strategy when sound), null = none */
export const typeOf = (text: string): string | null => fmScalar(text, 'type')
/** a strategy book's frontmatter `parent:` (the strategy family it belongs to, e.g. research), null = none */
export const parentOf = (text: string): string | null => fmScalar(text, 'parent')

/** what is wrong with a book's `type:`, or null when it is absent or sound */
export function typeFault(text: string): string | null {
  const t = typeOf(text)
  if (t == null || (BOOK_TYPES as readonly string[]).includes(t)) return null
  return `type "${t}" is not one of ${BOOK_TYPES.join(', ')}`
}

/**
 * `text` with its topics set to `topics` (the line written in place, or added; a file with no
 * frontmatter gets one) and any free `tags:` line removed - tags retired 2026-09-26, topics replace them.
 * Everything else is kept byte for byte, line endings included.
 */
export function setTopics(text: string, topics: string[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const line = `topics: [${topics.join(', ')}]`
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?=[ \t]*(?:\r?\n|$))/.exec(text)
  if (!m) return `---${eol}${line}${eol}---${eol}${eol}${text.replace(/^﻿/, '')}`
  const lines = m[1].split(/\r?\n/)
  const kept: string[] = []
  let placed = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^(topics|tags):/.test(l)) {
      // a block list under the key goes with it
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) i++
      if (/^topics:/.test(l) && !placed) { kept.push(line); placed = true }
      continue
    }
    kept.push(l)
  }
  if (!placed) kept.push(line)
  const bom = text.startsWith('﻿') ? '﻿' : ''
  return `${bom}---${eol}${kept.join(eol)}${eol}---${text.slice(m[0].length)}`
}
