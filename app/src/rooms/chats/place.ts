// WHERE AN AGENT SITS in the chats side list: the tree, derived from the roster, never configured.
// A repo's card belongs to its HOME agent (a standing agent whose cwd is the repo's own folder,
// `.` for the fund root); every other agent sits inside the repo its cwd is in, as a band: the
// dashboards share one, any other tenant (research in platform/research) is its own. A dashboard
// is known by its `dash:` id as well as its kind, so a mistyped kind cannot move it. A cwd whose
// repo has no home agent is UNPLACED: shown and named, never guessed into a repo.

export type Placeable = { id: string; kind?: string; cwd: string; mode?: string }

/** the band a non-home agent sits in: `dashboards`, or the agent's own id */
export type Place = { repo: string; band: string | null }

export const UNPLACED = '?'

const norm = (cwd: string) => cwd.replace(/\\/g, '/').replace(/^\.(\/|$)/, '').replace(/\/+$/, '')

/** a cwd's repo folder: its first segment (`.` for the root, `platform/research` -> platform) */
export const repoOfCwd = (cwd: string): string => norm(cwd).split('/')[0] || '.'

export const isDashboard = (a: Placeable) => a.kind === 'dashboard' || a.id.startsWith('dash:')

/** is this agent a repo's home (its card): not a dashboard, and its cwd IS a repo folder */
export const isHome = (a: Placeable) => !isDashboard(a) && !norm(a.cwd).includes('/')

export type Tree<A extends Placeable> = {
  repos: { home: A; own: A[]; bands: { id: string; agents: A[] }[] }[]
  unplaced: A[]
}

/** the side list's tree, in roster order: one entry per home agent, its tenants as bands (the agent
 *  bands first, in roster order, then the one dashboards band) */
export function placeAll<A extends Placeable>(agents: A[]): Tree<A> {
  const homes = agents.filter(isHome)
  const byRepo = new Map(homes.map(h => [repoOfCwd(h.cwd), h]))
  const repos = homes.map(home => ({ home, own: [home] as A[], bands: [] as { id: string; agents: A[] }[] }))
  const unplaced: A[] = []
  for (const a of agents) {
    if (homes.includes(a)) continue
    const home = byRepo.get(repoOfCwd(a.cwd))
    const r = home && repos.find(x => x.home === home)
    if (!r) { unplaced.push(a); continue }
    const id = isDashboard(a) ? 'dashboards' : a.id
    const band = r.bands.find(b => b.id === id)
    if (band) band.agents.push(a)
    else r.bands.push({ id, agents: [a] })
  }
  for (const r of repos) r.bands.sort((x, y) => Number(x.id === 'dashboards') - Number(y.id === 'dashboards'))
  return { repos, unplaced }
}

/** one agent's place (the tests' view of placeAll) */
export function placeOf(a: Placeable, agents: Placeable[]): Place {
  const t = placeAll(agents.includes(a) ? agents : [...agents, a])
  for (const r of t.repos) {
    if (r.home === a) return { repo: repoOfCwd(a.cwd), band: null }
    const b = r.bands.find(x => x.agents.includes(a))
    if (b) return { repo: repoOfCwd(r.home.cwd), band: b.id }
  }
  return { repo: UNPLACED, band: null }
}
