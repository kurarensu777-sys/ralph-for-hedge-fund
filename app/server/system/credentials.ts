/**
 * THE DOORS: the fund's connectors, read from the `## The doors and their keys` chapter of
 * app/library/law/how-we-work.md (before 2026-10-03 the `## Credentials` section of the fund's CLAUDE.md,
 * which still reads the same way). The law is the one place they are written; this reads that table
 * as data and never anything a credential lives in (no .env, no key file, no environment variable is
 * opened here).
 *
 * The chapter's table: | Door | Credential, and who holds it | Reached through - health |
 * (the older one also had Scope and Agent may hold columns). Columns are found by their header words,
 * so a reordered or renamed column still reads; with no `may hold` column an agent may hold the key
 * unless its cell opens with HUMAN, and the health is what follows the last ` - ` of the last column.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chaptersOf } from '../../shared/bookmeta.ts'
import type { Shelf } from '../../shared/types.ts'
import { scanBooks } from '../library/scan.ts'

export type Door = {
  id: string                // a slug of the door's name, stable across edits of its parenthesis
  name: string              // the Door cell, plain text
  scope: string             // fund | operator
  credential: string        // the cell, plain text ("none - ...", "HUMAN - ...")
  agentMayHold: boolean     // the cell starts with "yes"
  reachedThrough: string    // the last column before its first " · "
  health: string            // the last column after its first " · " ("" when it names none)
  parked: boolean           // the door says PARKED
}
export type Doors = { found: boolean; rows: Door[] }

/** markdown decoration off a cell: bold, backticks, links */
const plain = (s: string) => s.replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
const isRule = (line: string) => /^\|?\s*:?-{2,}/.test(line.trim())
const slug = (s: string) => s.replace(/\([^)]*\)/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'door'

/** the section under a `## Credentials...` or `## The doors and their keys` heading, up to the next `## ` heading; null = no section */
function section(md: string): string | null {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const at = lines.findIndex(l => /^##\s+(credentials\b|the doors and their keys\b)/i.test(l.trim()))
  if (at < 0) return null
  const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l))
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n')
}

export function parseCredentials(md: string): Doors {
  const body = section(md)
  if (body === null) return { found: false, rows: [] }
  const lines = body.split('\n').filter(l => l.trim().startsWith('|'))
  if (lines.length < 2) return { found: true, rows: [] }
  const head = cells(lines[0]).map(h => plain(h).toLowerCase())
  const col = (re: RegExp) => head.findIndex(h => re.test(h))
  const iDoor = col(/door|connector/), iScope = col(/scope/), iCred = col(/credential/), iHold = col(/may hold/), iReach = col(/reached/)
  if (iDoor < 0) return { found: true, rows: [] }
  const rows: Door[] = []
  const seen = new Map<string, number>()
  for (const line of lines.slice(1)) {
    if (isRule(line)) continue
    const c = cells(line)
    const name = plain(c[iDoor] ?? '')
    if (!name) continue
    const reach = plain(c[iReach] ?? '')
    // the older table split health at ' · '; the chapter's cell says `through - health`
    const dot = reach.indexOf(' · ')
    const cut = dot >= 0 ? dot : reach.lastIndexOf(' - ')
    const base = slug(name)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    rows.push({
      id: n ? `${base}-${n + 1}` : base,
      name,
      scope: plain(c[iScope] ?? ''),
      credential: plain(c[iCred] ?? ''),
      agentMayHold: iHold < 0 ? !/^human\b/i.test(plain(c[iCred] ?? '')) : /^yes\b/i.test(plain(c[iHold] ?? '')),
      reachedThrough: cut < 0 ? reach : reach.slice(0, cut).trim(),
      health: cut < 0 ? '' : reach.slice(cut + 3).trim(),   // ' · ' and ' - ' are both 3 long
      parked: /\bparked\b/i.test(name),
    })
  }
  return { found: true, rows }
}

/** the chapter's address: `<law book>.md#the-doors-and-their-keys` */
export const DOORS_SLUG = 'the-doors-and-their-keys'

/**
 * The doors, found by the chapter's HEADING across the books of the `law` shelf, not by one file name: the chapter
 * moved out of the root law on 2026-10-03 and went blank on the tile, and a book split at its cap moves chapters
 * again. The first law book that holds the heading wins; `book` names it. None holds it: not found, never an empty list.
 */
export function doorsFromLaw(fundRoot: string, shelves: Shelf[]): Doors & { book: string | null } {
  const law = shelves.filter(s => s.id === 'law')
  for (const b of scanBooks(fundRoot, law)) {
    if (!b.chapters.some(c => c.slug === DOORS_SLUG)) continue
    let text: string
    try { text = readFileSync(join(fundRoot, b.path), 'utf8') } catch { continue }
    const ch = chaptersOf(text).find(c => c.slug === DOORS_SLUG)
    if (ch) return { ...parseCredentials(ch.text), book: b.path }
  }
  return { found: false, rows: [], book: null }
}
