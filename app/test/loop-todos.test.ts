import { beforeEach, describe, expect, it } from 'vitest'
import { db, ops } from '../server/db.ts'
import { todoLine, todoReport } from '../server/loop/todos.ts'
import { resetStore } from './pg/reset.ts'

// B-0428: turns of four or more tool steps that never wrote a TodoWrite list, counted per agent.

const DAY = 86_400_000
const NOW = Date.parse('2026-10-04T12:00:00Z')
const AGENTS = new Set(['a', 'b'])
let seq = 0

/** one finished turn of `tools` top-level steps in a fresh conversation; `list` = it wrote a TodoWrite list first */
async function turn(agent: string, at: number, tools: number, list: boolean, conv = `c${++seq}`) {
  let t = at
  if (list) await ops.logEvent('tool', 'Todos 0/3', { agent, conversation: conv, ts: t++ })
  for (let i = list ? 1 : 0; i < tools; i++) await ops.logEvent('tool', `Read file${i}`, { agent, conversation: conv, ts: t++ })
  await ops.logEvent('turn', 'turn done - 10 in / 1 out', { agent, conversation: conv, ts: t })
}

beforeEach(async () => { await resetStore() })

describe('the todo-list check', () => {
  it('counts a long turn with no list, per agent, and flags the agents at the threshold', async () => {
    for (let i = 0; i < 3; i++) await turn('a', NOW - DAY + i * 100, 5, false)
    await turn('a', NOW - DAY + 500, 5, true)       // kept its list
    await turn('b', NOW - DAY, 4, false)             // exactly four steps counts
    await turn('b', NOW - DAY + 50, 3, false)        // three steps does not
    const r = await todoReport(db, AGENTS, NOW)
    expect(r.agents).toEqual([{ agent: 'a', missing: 3, long: 4 }, { agent: 'b', missing: 1, long: 1 }])
    expect(r.missing).toBe(4)
    expect(r.long).toBe(5)
    expect(r.flagged).toEqual(['a'])
    expect(todoLine(r)).toBe('4 of 5 turns of 4+ steps had no todo list in 7d; 3+ each: a 3')
  })

  it('reads the steps of the turn that ended, not the conversation: a list in an earlier turn does not cover a later one', async () => {
    await turn('a', NOW - DAY, 5, true, 'one')
    await turn('a', NOW - DAY + 1000, 5, false, 'one')
    const r = await todoReport(db, AGENTS, NOW)
    expect(r.agents).toEqual([{ agent: 'a', missing: 1, long: 2 }])
  })

  it('ignores a turn older than the window, an unknown agent and a cut-off turn; says nothing when every list was kept', async () => {
    await turn('a', NOW - 8 * DAY, 6, false)
    await turn('ghost', NOW - DAY, 6, false)
    await ops.logEvent('tool', 'Read x', { agent: 'b', conversation: 'cut', ts: NOW - DAY })
    await ops.logEvent('tool', 'Read y', { agent: 'b', conversation: 'cut', ts: NOW - DAY + 1 })
    await ops.logEvent('tool', 'Read z', { agent: 'b', conversation: 'cut', ts: NOW - DAY + 2 })
    await ops.logEvent('tool', 'Read w', { agent: 'b', conversation: 'cut', ts: NOW - DAY + 3 })
    await ops.logEvent('turn', 'cut off: the agent process ended mid-turn', { agent: 'b', conversation: 'cut', ts: NOW - DAY + 4 })
    await turn('b', NOW - DAY + 10, 6, true)
    const r = await todoReport(db, AGENTS, NOW)
    expect(r.missing).toBe(0)
    expect(r.long).toBe(1)
    expect(todoLine(r)).toBe('')
  })
})
