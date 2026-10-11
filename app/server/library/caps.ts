// THE CAPS on what an agent loads, from app/tools/context-caps.json: the one source (app/tools/context.py reads
// the same file for its check). Pure and import-light on purpose: the loop's rules run on a temp database and
// must not pull in core.ts, which opens the cockpit database at import.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOOLS_DIR } from '../paths.ts'

export type Caps = {
  base: number; agent: number; boot: number; chapter: number; chapterTarget: number; book: number; workspace: number; screen: number
  workspaceNamed: Record<string, number>
}

const KEYS = ['base', 'agent', 'boot', 'chapter', 'chapterTarget', 'book', 'workspace', 'screen'] as const

export const CAPS_FILE = join(TOOLS_DIR, 'context-caps.json')

/** pure: the caps out of the file's text; a missing or non-numeric cap throws, never defaults (a made-up cap would grade every agent) */
export function parseCaps(text: string): Caps {
  const j = JSON.parse(text)
  const out: Record<string, number> = {}
  for (const k of KEYS) {
    if (typeof j?.[k] !== 'number' || !(j[k] > 0)) throw new Error(`context-caps.json: "${k}" is not a positive number`)
    out[k] = j[k]
  }
  const named: Record<string, number> = {}
  for (const [k, v] of Object.entries(j.workspaceNamed ?? {})) if (typeof v === 'number' && v > 0) named[k] = v
  return { ...(out as Omit<Caps, 'workspaceNamed'>), workspaceNamed: named }
}

/** the caps now: the file is a few hundred bytes, read on each call, so a cap the owner moves shows without a restart */
export const caps = (file = CAPS_FILE): Caps => parseCaps(readFileSync(file, 'utf8'))

/** the per-book over-size mark threshold: a book above this share of the book cap is flagged */
export const BOOK_WARN = 0.9
