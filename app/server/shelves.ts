import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vocabOf, type Topic } from '../shared/bookmeta.ts'
import type { Agent, Shelf } from '../shared/types.ts'
import { APP_LIBRARY_REL, LEGACY_LIBRARY_REL, LEGACY_LIBRARY_RETIRED } from './paths.ts'

/**
 * THE SHELVES ARE DERIVED, NOT CONFIGURED (2026-09-25; spine/shelves.json is gone). A shelf is a
 * library folder, and nothing else decides it. The homes, in this order:
 *
 *   app/library/<x>/                 THE ONE LIBRARY (2026-09-26): law, craft, app (how we work),
 *                                    markets, platform (what the fund knows), dashboards (<id>/ each)
 *   library/<x>/                     the fund root's library, RETIRED 2026-09-25: a folder of it counts
 *                                    only while no home above holds that id and it is not a retired
 *                                    name (fund -> app/library/law, craft -> app/library/craft), so a
 *                                    shelf the platform has not moved yet still shows, once
 *
 * Folders alphabetically inside each home. The same set, in the same order, as `python
 * app/tools/_root.py --shelves` (test/layout-parity.test.ts holds the two together). A hidden (`.x`)
 * or underscore (`_x`) folder is not a shelf, nor is a loose file (app/library/shelf.md). id = the
 * folder name (`dashboards` for a dashboard's own); two roots with one id are ONE shelf with two
 * roots, the earlier home's first - the case while a shelf is being moved between homes.
 *
 * title and dept: the shelf's own top `_series.md` names them in its frontmatter (`title:`, with
 * any " - the shelf" tail dropped; `dept:`). Where it does not: title = the id capitalised, dept =
 * the department of the agent whose id is the shelf's (platform -> Build, app -> Build), else the
 * department whose name IS the shelf's (dashboards -> Dashboards), else the title.
 *
 * topics: the same index's `topics:` map (shared/bookmeta.ts), the shelf's closed list. None named =
 * no list.
 */

const folders = (fundRoot: string, rel: string): string[] => {
  try {
    return readdirSync(join(fundRoot, rel), { withFileTypes: true })
      .filter(e => e.isDirectory() && !/^[._]/.test(e.name))
      .map(e => e.name)
      .sort()
  } catch { return [] }
}

export const titleOf = (id: string) => id.charAt(0).toUpperCase() + id.slice(1)

export function deptOf(id: string, agents: Pick<Agent, 'id' | 'dept'>[]): string {
  const own = agents.find(a => a.id === id)?.dept
  if (own) return own
  const named = agents.find(a => (a.dept ?? '').toLowerCase() === id.toLowerCase())?.dept
  return named ?? titleOf(id)
}

/** `title` and `dept` from a series index's frontmatter ("Craft - the shelf" -> "Craft") */
export function shelfMeta(text: string): { title?: string; dept?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
  if (!fm) return {}
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+?)\\s*$`, 'm').exec(fm)?.[1]?.replace(/^['"]|['"]$/g, '').trim() || undefined
  const title = get('title')?.replace(/\s+-\s+the shelf$/i, '').trim() || undefined
  return { title, dept: get('dept') }
}

type Meta = { title?: string; dept?: string; topics?: Topic[] }

function metaOf(fundRoot: string, roots: string[]): Meta {
  const out: Meta = {}
  for (const r of roots) {
    const f = join(fundRoot, r, '_series.md')
    if (!existsSync(f)) continue
    let m: Meta = {}
    try { const text = readFileSync(f, 'utf8'); m = { ...shelfMeta(text), topics: vocabOf(text) ?? undefined } } catch { /* unreadable: the fallback names it */ }
    out.title ??= m.title
    out.dept ??= m.dept
    out.topics ??= m.topics
  }
  return out
}

/** every shelf root, fund-relative, in the derived order (what `app/tools/_root.py --shelves` prints) */
export function shelfRoots(fundRoot: string): string[] {
  const current = folders(fundRoot, APP_LIBRARY_REL).map(x => `${APP_LIBRARY_REL}/${x}`)
  const ids = new Set(current.map(shelfIdOf))
  const legacy = folders(fundRoot, LEGACY_LIBRARY_REL).filter(x => !LEGACY_LIBRARY_RETIRED.includes(x) && !ids.has(x)).map(x => `${LEGACY_LIBRARY_REL}/${x}`)
  return [...current, ...legacy]
}

/** the shelf id a root stands for: its folder name (app/library/dashboards -> `dashboards`) */
export const shelfIdOf = (root: string) => {
  const p = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = p.split('/')
  return parts[parts.length - 1]
}

export function deriveShelves(fundRoot: string, agents: Pick<Agent, 'id' | 'dept'>[]): Shelf[] {
  const roots = new Map<string, string[]>()
  for (const r of shelfRoots(fundRoot)) {
    const id = shelfIdOf(r)
    roots.set(id, [...(roots.get(id) ?? []), r])
  }
  return [...roots].map(([id, rs]) => {
    const m: Meta = metaOf(fundRoot, rs)
    return { id, title: m.title ?? titleOf(id), dept: m.dept ?? deptOf(id, agents), roots: rs, ...(m.topics ? { topics: m.topics } : {}) }
  })
}
