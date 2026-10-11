// The dock's small pure parts (tested in test/shell-dock.test.ts).

/** the one token format on every screen: 12.7M, 840k, 312 */
export const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)

export const fmtDollars = (n: number) => `$${n.toFixed(2)}`

/** a plan window's bar colour: the state colours, by how full it is (ok under 70%, warn to 90%, fail above) */
export function barTone(u: number): 'ok' | 'warn' | 'fail' {
  return u >= 0.9 ? 'fail' : u >= 0.7 ? 'warn' : 'ok'
}

/** when a window resets: a clock time within a day ("16:20"), else weekday and time ("Mon 09:00"); `ago` words a past reset */
export function fmtResets(ms: number | null, ago = false, now: number = Date.now()): string {
  if (ms === null) return 'unknown'
  const d = new Date(ms)
  const hhmm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (ago) { const m = Math.max(1, Math.round((now - ms) / 60_000)); return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago` }
  return Math.abs(ms - now) < 20 * 3_600_000 ? hhmm : `${d.toLocaleDateString('en', { weekday: 'short' })} ${hhmm}`
}

/** the agents with the most billable tokens over the series, biggest first (an agent with none is not named) */
export function topAgents(s: { agents: string[]; cells: number[][] }, n: number): { agent: string; tokens: number }[] {
  return s.agents
    .map((agent, i) => ({ agent, tokens: s.cells.reduce((t, row) => t + (row[i] ?? 0), 0) }))
    .filter(a => a.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent))
    .slice(0, n)
}
