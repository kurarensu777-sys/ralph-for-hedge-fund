import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../../paths.ts'
import type { EngineId } from '../../../shared/engines.ts'
import type { Entry } from '../types.ts'

// A FOREIGN CONVERSATION'S RECORD. A Claude conversation lives in Claude Code's transcript (~/.claude/projects/...)
// and is read back from it. Codex and Grok keep theirs in their own stores in their own shapes, so the cockpit
// keeps one file per conversation under ~/fund-data/foreign/: the session id each CLI resumes by, and the feed rows
// as the screen showed them, so a conversation opened after a restart reads what it read before. Written at the end
// of a turn and when the hand closes; never read for a Claude conversation.

const SAFE = /^[A-Za-z0-9_-]{1,64}$/
export const LEDGER_DIR = join(DATA_DIR, 'foreign')

export type Ledger = { v: 1; engine?: EngineId; sessions: Partial<Record<EngineId, string>>; entries: Entry[] }

const file = (id: string, dir = LEDGER_DIR) => (SAFE.test(id) ? join(dir, `${id}.json`) : null)

export function readLedger(id: string, dir = LEDGER_DIR): Ledger | null {
  const f = file(id, dir)
  if (!f || !existsSync(f)) return null
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    return j?.v === 1 && Array.isArray(j.entries) ? { v: 1, engine: j.engine, sessions: j.sessions ?? {}, entries: j.entries } : null
  } catch { return null }
}

export function writeLedger(id: string, l: Ledger, dir = LEDGER_DIR) {
  const f = file(id, dir)
  if (!f) throw new Error(`not a conversation id: ${id}`)
  mkdirSync(dir, { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(l))
  renameSync(tmp, f)
}

/** one engine's session id, kept without touching the others' */
export function sessionOf(id: string, engine: EngineId, dir = LEDGER_DIR): string | undefined {
  return readLedger(id, dir)?.sessions[engine]
}
