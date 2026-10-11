import type { CtxDrift } from '../../shared/context.ts'
import type { Agent } from '../../shared/types.ts'
import { law, type LawRow } from '../chat/law.ts'
import { list } from '../chat/store.ts'
import { briefOf } from '../paths.ts'

// WHICH OPEN CONVERSATIONS ARE STILL ON THE OLD PROMPT. A conversation's boot is recorded as law_loads rows
// (the brief and each boot ref, with the blob sha as loaded, chat/law.ts); the Law chip calls a row drifted
// when the file now differs. A conversation is stale when the brief or a booted chapter changed or went
// missing, or when its boot list is not the list the agent has now (a chapter added or removed leaves every
// remaining row unchanged, so the sets are compared too). One with no boot rows has nothing to compare:
// unknown, never counted as current.

/** pure: stale | current | unknown for one conversation's manifest rows against what the agent boots now */
export function judge(rows: Pick<LawRow, 'path' | 'reason' | 'drift'>[], expected: string[]): 'stale' | 'current' | 'unknown' {
  const boot = rows.filter(r => r.reason === 'boot')
  if (!boot.length) return 'unknown'
  const had = new Set(boot.map(r => r.path))
  if (expected.some(p => !had.has(p)) || [...had].some(p => !expected.includes(p))) return 'stale'
  return boot.some(r => r.drift === 'changed' || r.drift === 'missing') ? 'stale' : 'current'
}

/** the conversations with a live process: a closed one boots again from the files, so it never holds an old prompt */
export async function openConversations(agentId: string): Promise<string[]> {
  return (await list({ agent: agentId, limit: 1000 })).filter(c => c.state !== 'closed').map(c => c.id)
}

export async function driftOf(a: Agent): Promise<CtxDrift> {
  const expected = [briefOf(a), ...(a.boot ?? [])]
  const ids = await openConversations(a.id)
  const stale: string[] = []
  let unknown = 0
  for (const id of ids) {
    const v = judge((await law(id)).rows, expected)
    if (v === 'stale') stale.push(id)
    else if (v === 'unknown') unknown++
  }
  return { open: ids.length, stale: stale.length, unknown, ids: stale }
}
