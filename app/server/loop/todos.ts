import { ops, type Queryable } from '../db.ts'

/**
 * THE TODO-LIST CHECK (B-0428). The law (how-we-work.md, 'A multi-step turn keeps a todo list') asks
 * an agent to write a TodoWrite list before a turn of more than a few steps. This counts, per agent,
 * the finished turns of STEPS or more top-level tool steps that never wrote one, so the rule is
 * measured and not only asked. A turn is read the way server/loop/turns.ts cuts it (the tool events
 * between one turn-kind event and the next 'turn done') and a step is what server/chat/progress.ts
 * counts: a top-level tool call. A list is the 'Todos n/m' tool row runner.ts logs for a TodoWrite
 * with at least one item (progress.ts divides by nothing otherwise). Reported once in the pass
 * summary, with the agents over the threshold; no per-turn flag.
 */

export const TODO_STEPS = 4
/** an agent with this many such turns in the window is named in the digest */
export const TODO_OVER = 3
export const TODO_DAYS = 7

const LIST = /^Todos \d+\/\d+/
const LEAD = 86_400_000   // events before the window, so a turn that opened just before it keeps its early steps

export type TodoReport = {
  days: number
  steps: number
  over: number
  /** finished turns in the window with STEPS or more tool steps */
  long: number
  /** ...of which wrote no list */
  missing: number
  /** per agent, most missing first; only agents with at least one */
  agents: { agent: string; missing: number; long: number }[]
  /** agents at or over the threshold */
  flagged: string[]
}

export async function todoReport(db: Queryable, agents: Set<string>, now: number, o: { days?: number; steps?: number; over?: number } = {}): Promise<TodoReport> {
  const days = o.days ?? TODO_DAYS, steps = o.steps ?? TODO_STEPS, over = o.over ?? TODO_OVER
  const since = now - days * 86_400_000
  const ev = await ops.eventsInWindow(since - LEAD, now + 1, { kinds: ['tool', 'turn'], agentOnly: true }, db)
  const open = new Map<string, { tools: number; list: boolean }>()
  const by = new Map<string, { missing: number; long: number }>()
  for (const e of ev) {
    const conv = e.conversation_id
    if (!conv) continue
    const cur = open.get(conv) ?? { tools: 0, list: false }
    if (e.kind === 'tool') {
      cur.tools++
      if (LIST.test(e.summary)) cur.list = true
      open.set(conv, cur)
      continue
    }
    open.delete(conv)
    if (!e.summary.startsWith('turn done') || e.ts < since || !e.agent_id || !agents.has(e.agent_id) || cur.tools < steps) continue
    const a = by.get(e.agent_id) ?? { missing: 0, long: 0 }
    a.long++
    if (!cur.list) a.missing++
    by.set(e.agent_id, a)
  }
  const list = [...by.entries()].map(([agent, v]) => ({ agent, ...v })).filter(a => a.missing > 0).sort((a, b) => b.missing - a.missing || a.agent.localeCompare(b.agent))
  return {
    days, steps, over,
    long: [...by.values()].reduce((n, a) => n + a.long, 0),
    missing: list.reduce((n, a) => n + a.missing, 0),
    agents: list,
    flagged: list.filter(a => a.missing >= over).map(a => a.agent),
  }
}

/** the digest clause, or '' when every long turn kept its list (nothing to say) */
export function todoLine(r: TodoReport): string {
  if (!r.missing) return ''
  const who = r.flagged.length ? `; ${r.over}+ each: ${r.agents.filter(a => r.flagged.includes(a.agent)).map(a => `${a.agent} ${a.missing}`).join(', ')}` : ''
  return `${r.missing} of ${r.long} turns of ${r.steps}+ steps had no todo list in ${r.days}d${who}`
}
