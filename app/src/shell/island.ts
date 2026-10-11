// The activity island's model (pure, tested in test/shell-island.test.ts).

export type AgentLoad = { id: string; working: number; waiting: number }

export type IslandState = { shown: boolean; working: number; waiting: number; agents: AgentLoad[] }

/** who to draw and the two counts; null (not loaded or unreachable) draws nothing rather than a zero */
export function islandOf(agents: AgentLoad[] | null): IslandState {
  if (!agents) return { shown: false, working: 0, waiting: 0, agents: [] }
  const busy = agents.filter(a => a.working > 0 || a.waiting > 0)
    // needs-you first: those are the avatars the owner has to act on
    .sort((a, b) => (b.waiting > 0 ? 1 : 0) - (a.waiting > 0 ? 1 : 0) || b.working + b.waiting - (a.working + a.waiting))
    .map(a => ({ id: a.id, working: a.working, waiting: a.waiting }))
  const working = busy.reduce((s, a) => s + a.working, 0)
  const waiting = busy.reduce((s, a) => s + a.waiting, 0)
  return { shown: working + waiting > 0, working, waiting, agents: busy }
}
