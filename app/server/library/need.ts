import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { Agent } from '../../shared/types.ts'
import { splitRef } from '../../shared/bookmeta.ts'
import { citationRefs } from './links.ts'
import { repoFor, toRel } from './scan.ts'
import type { RecallRow } from './types.ts'

// WHO MUST READ A BOOK - derived, never tagged (a "mandatory" tag in the book would drift from the boot
// list the day someone edits either one). Two sources:
//   boot    the roster's boot lists (core.readersOf): loaded at every start
//   recall  a row of a `## Recall` table in a CLAUDE.md that cites the book: the agent is sent there when
//           that moment fires, and it can only fire for an agent that LOADS the CLAUDE.md at its start -
//           Claude Code loads CLAUDE.md from the cwd upward, so the file's folder is the agent's cwd or an
//           ancestor of it. A Recall row in a file no agent starts under is read on demand.
// A row that cites a series index or a folder reaches no single book and is not counted here.

const norm = (p: string) => posix.normalize(p.split('\\').join('/')).replace(/^\.\//, '')
const plain = (s: string) => s.replace(/`/g, '').replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()

/** the rows under every `## Recall` heading (to the next heading of the same or a higher level): the
 *  moment (the first cell) and the .md refs the row cites (`<book>.md` or one chapter, `<book>.md#<slug>`) */
export function recallTable(text: string): { moment: string; cites: string[] }[] {
  const out: { moment: string; cites: string[] }[] = []
  let level = 0
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      if (level && h[1].length <= level) level = 0
      if (/^recall\b/i.test(h[2].trim())) level = h[1].length
      continue
    }
    const t = line.trim()
    if (!level || !t.startsWith('|') || /^\|?\s*:?-{2,}/.test(t)) continue
    const cites = citationRefs(line).filter(c => splitRef(c).path.match(/\.md$/i))
    if (cites.length) out.push({ moment: plain(t.replace(/^\|/, '').split('|')[0]), cites })
  }
  return out
}

/** book path -> the Recall rows that cite it, over the given CLAUDE.md files (fund-relative). A citation
 *  resolves from the fund root, the CLAUDE.md's folder, then its repo's root - the link audit's order */
export function recallIndex(fundRoot: string, claudeFiles: string[], isBook: (path: string) => boolean): Map<string, RecallRow[]> {
  const out = new Map<string, RecallRow[]>()
  for (const f of claudeFiles) {
    let text = ''
    try { text = readFileSync(join(fundRoot, f), 'utf8') } catch { continue }
    const dir = posix.dirname(norm(f))
    const repo = toRel(fundRoot, repoFor(fundRoot, f))
    const bases = ['', dir === '.' ? '' : dir, repo === '.' ? '' : repo].filter((x, i, a) => a.indexOf(x) === i)
    for (const row of recallTable(text)) {
      for (const ref of row.cites) {
        const { path: c, slug } = splitRef(ref)
        const hit = bases.map(b => norm(b ? `${b}/${c}` : c)).find(p => !p.startsWith('..') && isBook(p))
        if (!hit) continue
        const rows = out.get(hit) ?? []
        // a row that cites a chapter says which; a row citing the book whole carries no chapter
        if (!rows.some(r => r.file === f && r.moment === row.moment && r.chapter === (slug ?? undefined))) rows.push({ file: f, moment: row.moment, ...(slug ? { chapter: slug } : {}) })
        out.set(hit, rows)
      }
    }
  }
  return out
}

/** the CLAUDE.md files an agent loads at its start: every one whose folder is its cwd or above it */
export function loadsOf(cwd: string, claudeFiles: string[]): string[] {
  const c = norm(cwd || '.')
  return claudeFiles.filter(f => {
    const d = posix.dirname(norm(f))
    return d === '.' || c === d || c.startsWith(`${d}/`)
  })
}

/** agent id -> the CLAUDE.md files it loads at start */
export function loadsByAgent(agents: Pick<Agent, 'id' | 'cwd'>[], claudeFiles: string[]): Record<string, string[]> {
  return Object.fromEntries(agents.map(a => [a.id, loadsOf(a.cwd, claudeFiles)]))
}
