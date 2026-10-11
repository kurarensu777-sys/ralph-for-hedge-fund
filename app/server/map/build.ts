import type { Agent, Dashboard } from '../../shared/types.ts'
import type { MapBoard, MapCheck, MapEdge, MapGraph, MapNode, MapState, MapView } from '../../shared/map.ts'

/**
 * THE MAP'S BUILDER (pure; the reader in read.ts hands it the files and git's answers). Every node
 * comes from a file that already exists: repos.json (repos, remotes, verify, guarded, needs), the
 * roster (agents and whose writes cover what), every dashboard.json, schedule.json (the jobs), the lab desks, git (branch, ahead/behind, folders, worktrees) and
 * pipeline.json (the fund agent's stage map) and data-flow.json (the data flow, top down). The one thing written here is the System view's
 * skeleton - the containers of the dependency law (CLAUDE.md "The seam to the code repos") - and
 * each container names the path that proves it; a container whose path is gone paints red, the same
 * rule pipeline.json's evidence follows. test/map.test.ts holds that every repo, agent and dashboard
 * in the tree is a node.
 */

export type RepoIn = {
  id: string
  path: string
  holds?: string
  verify?: string
  remote?: string
  guarded?: boolean
  needs?: string[]
  lands?: string
  /** git's reading of the working tree; null = could not be read (the why in `error`) */
  state: {
    branch: string | null; upstream: string | null; dirty: number; conflicts: number; midOp: string | null
    ahead: number | null; behind: number | null; head: { sha: string; subject: string; ts: number } | null; error?: string
  } | null
  fetchedAt: number | null
  /** tracked top-level folders and files at HEAD; null = could not be read */
  folders: string[] | null
  files: string[] | null
  worktrees: { path: string; branch: string | null }[]
}

export type LakeFolder = { path: string; exists: boolean }

export type JobIn ={ id: string; cwd: string; cmd: string[]; cadence: string; enabled: boolean; kind: string; agent?: string }

export type MapInput = {
  repos: RepoIn[]
  agents: Agent[]
  dashboards: Dashboard[]
  jobs: JobIn[]
  desks: string[]
  /** pipeline.json parsed, or why it could not be */
  pipeline: { doc: unknown } | { error: string }
  pipelinePath: string
  /** data-flow.json parsed, or why it could not be */
  dataFlow: { doc: unknown } | { error: string }
  dataFlowPath: string
  exists: (rel: string) => boolean
  /** the .md files directly inside a fund-relative folder, fund-relative */
  mdIn: (rel: string) => string[]
  board: (MapBoard & { owner: string })[]
  ports: { ui: number; fundd: number; pg: number | null }
  /** a `select 1` against the ops store; null = not asked */
  pg: { ok: boolean; why?: string } | null
  /** the market store at the data root, one folder per storage class (B-0322 section 1): `path` is
   *  the lake itself (market/, which holds the ARCHIVE class), `cache` and `pins` its siblings;
   *  `budget` = retention.toml's `[cache] max_bytes`, null when it is not set */
  lake: LakeFolder & { cache: LakeFolder; pins: LakeFolder; budget: number | null }
  problems: { path: string; error: string }[]
}

// ---- who writes what ----

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')

/** a roster `writes` prefix covers a fund-relative path: the path is it, or sits under it */
export function covers(write: string, rel: string): boolean {
  const w = norm(write), r = norm(rel)
  return !!w && w !== '.' && (r === w || r.startsWith(w + '/'))
}

/** the agent whose writes cover a path: the longest covering prefix wins, then roster order */
export function ownerOf(rel: string, agents: Pick<Agent, 'id' | 'writes'>[]): string | undefined {
  let best: { id: string; len: number } | undefined
  for (const a of agents) for (const w of a.writes ?? []) {
    if (!covers(w, rel)) continue
    const len = norm(w).length
    if (!best || len > best.len) best = { id: a.id, len }
  }
  return best?.id
}

/** the agents writing somewhere strictly inside a path (a part of it, not all of it) */
export function writersInside(rel: string, agents: Pick<Agent, 'id' | 'writes'>[]): string[] {
  const r = norm(rel)
  const inside = (w: string) => { const x = norm(w); return r === '.' || r === '' ? !!x : x.startsWith(r + '/') }
  return agents.filter(a => (a.writes ?? []).some(inside)).map(a => a.id)
}

const join = (base: string, name: string) => (base === '.' || base === '' ? name : `${base}/${name}`)

/** the repo whose working tree holds a fund-relative path (the deepest; the fund root last) */
export function repoOf<T extends { path: string }>(rel: string, repos: T[]): T | undefined {
  const r = norm(rel)
  return [...repos].sort((a, b) => norm(b.path).length - norm(a.path).length)
    .find(x => { const p = norm(x.path); return p === '.' || p === '' || r === p || r.startsWith(p + '/') })
}

/** `https://github.com/<acct>/<name>.git` -> `<name>` */
export const remoteName = (url: string) => (url.replace(/\.git$/, '').split(/[/:]/).pop() || url)
const remoteHost = (url: string) => { try { return new URL(url).host } catch { return url.split(':')[0].replace(/^.*@/, '') } }

/** ahead / behind as words: `in sync`, `2 ahead`, `1 behind`; null when it cannot be told */
export function syncWords(s: RepoIn['state']): string | null {
  if (!s || s.error || !s.upstream || s.ahead === null || s.behind === null) return null
  const parts = [s.ahead ? `${s.ahead} ahead` : '', s.behind ? `${s.behind} behind` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'in sync'
}

/** a repo's tone, the Git room's rule (server/git/repo.ts repoTone) */
function repoState(s: RepoIn['state']): { state: MapState; why: string } {
  if (!s) return { state: 'unknown', why: 'not read' }
  if (s.error) return { state: 'unknown', why: s.error }
  if (s.conflicts > 0 || s.midOp) return { state: 'fail', why: s.midOp ? `${s.midOp} stopped` : `${s.conflicts} conflict` }
  if (s.dirty > 0 || (s.behind ?? 0) > 0) return { state: 'warn', why: [s.dirty ? `${s.dirty} dirty` : '', s.behind ? `${s.behind} behind` : ''].filter(Boolean).join(' · ') }
  return { state: 'ok', why: s.upstream ? 'clean' : 'clean, tracks no remote' }
}

const openBoard = (board: MapInput['board'], owner?: string) =>
  owner ? board.filter(b => b.owner === owner && b.status !== 'done').slice(0, 8).map(({ id, title, status }) => ({ id, title, status })) : undefined

const lawAt = (i: MapInput, rel: string) => { const f = join(rel, 'CLAUDE.md'); return i.exists(f) ? [f] : [] }

/** the dotted module a platform path is (`platform/fundplat/data` -> `fundplat.data`) */
const moduleOf = (rel: string) => norm(rel).split('/').slice(1).join('.')
function jobsFor(i: MapInput, rel: string): JobIn[] {
  const mod = moduleOf(rel)
  return i.jobs.filter(j => j.cmd.some(a => (mod && (a === mod || a.startsWith(mod + '.'))) || a.replace(/\\/g, '/').includes(norm(rel))))
}

// ---- the views ----

function reposView(i: MapInput): MapView {
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const has = new Set<string>()
  const add = (n: MapNode) => { nodes.push(n); has.add(n.id) }

  add({ id: 'group/agents', kind: 'group', label: 'Agents', layout: 'grid', sub: [`${i.agents.length} on the roster`] })
  for (const a of i.agents) add({
    id: `agent/${a.id}`, kind: 'agent', parent: 'group/agents', label: a.id, owner: a.id,
    sub: [a.mode === 'dormant' ? 'dormant' : a.kind === 'dashboard' ? 'dashboard' : 'standing'],
    state: a.mode === 'dormant' ? 'off' : undefined,
    path: `app/agents/${a.id.replace(/:/g, '-')}.md`,
    facts: [['role', a.role || '-'], ['cwd', a.cwd || '.'], ['writes', (a.writes ?? []).join('  ') || 'nothing'], ['model', `${a.model} · ${a.effort}`]],
    books: a.boot ?? [],
    board: openBoard(i.board, a.id),
  })


  for (const r of i.repos) {
    const rid = `repo/${r.id}`
    const s = r.state
    const tone = repoState(s)
    const top = [...(r.folders ?? []), ...(r.files ?? [])].map(n => join(r.path, n))
    const whole = top.length ? top.map(t => ownerOf(t, i.agents)) : []
    const owner = ownerOf(r.path, i.agents) ?? (whole.length && whole.every(o => o && o === whole[0]) ? whole[0] : undefined)
    const sync = syncWords(s)
    add({
      id: rid, kind: 'repo', label: r.id, layout: 'stack', owner, path: r.path,
      also: writersInside(r.path, i.agents).filter(x => x !== owner),
      sub: [[s?.branch ?? '?', sync ?? (s?.upstream === null ? 'local' : 'unknown')].join(' · ')],
      state: r.guarded ? 'guarded' : tone.state, why: tone.why,
      facts: [
        ['holds', r.holds ?? '-'],
        ['branch', s?.branch ?? 'unknown'],
        ['upstream', s?.upstream ?? (s ? 'none' : 'unknown')],
        ['sync', sync ?? 'unknown'],
        ['as of fetch', r.fetchedAt ? new Date(r.fetchedAt).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : 'not fetched by this fundd'],
        ['working tree', tone.why],
        ['verify', r.verify ?? 'none'],
        ...(r.remote ? [['remote', r.remote] as [string, string]] : []),
        ...(r.needs?.length ? [['needs', r.needs.join(', ')] as [string, string]] : []),
        ...(r.lands ? [['lands', r.lands] as [string, string]] : []),
        ['worktrees', r.worktrees.length ? r.worktrees.map(w => w.branch ?? w.path).join(', ') : 'none'],
      ],
      checks: r.verify ? [{ label: 'verify', state: 'info', detail: r.verify }] : undefined,
      law: lawAt(i, r.path),
      board: openBoard(i.board, owner),
      commit: s?.head ? { ...s.head, sha: s.head.sha.slice(0, 7), repo: r.id } : null,
    })
    if (r.folders === null) i.problems.push({ path: r.path, error: 'git ls-tree could not read its folders' })
    for (const f of r.folders ?? []) {
      const rel = join(r.path, f)
      const o = ownerOf(rel, i.agents)
      add({
        id: `dir/${rel}`, kind: 'dir', parent: rid, label: f, path: rel, owner: o,
        also: writersInside(rel, i.agents).filter(x => x !== o),
        law: lawAt(i, rel), board: openBoard(i.board, o),
      })
    }
    if (r.files?.length) {
      const o = ownerOf(join(r.path, r.files[0]), i.agents)
      add({
        id: `files/${r.id}`, kind: 'files', parent: rid, label: 'root files', sub: [`${r.files.length} files`], path: r.path, owner: o,
        also: [...new Set(r.files.map(f => ownerOf(join(r.path, f), i.agents)).filter((x): x is string => !!x && x !== o))],
        facts: [['files', r.files.join('  ')]],
      })
    }
    for (const w of r.worktrees) {
      const name = w.branch ?? w.path.split(/[\\/]/).pop() ?? w.path
      const [, agent, slug] = /^b\/([^/]+)\/(.+)$/.exec(name) ?? [null, null, name]
      add({ id: `wt/${r.id}/${name}`, kind: 'worktree', parent: rid, label: slug, sub: [agent ? `worktree · ${agent}` : 'worktree'], owner: agent ?? undefined, path: w.path, facts: [['branch', w.branch ?? 'detached'], ['worktree', w.path]] })
    }
    if (r.remote) {
      const tipSync = sync ?? 'unknown'
      add({
        id: `remote/${r.id}`, kind: 'remote', parent: 'group/github', label: remoteName(r.remote), sub: [remoteHost(r.remote)],
        state: sync === null ? 'unknown' : sync === 'in sync' ? 'ok' : 'warn', why: tipSync,
        facts: [['url', r.remote], ['repo', r.id], ['branch', s?.upstream ?? 'unknown'], ['sync', tipSync]],
      })
      edges.push({ id: `e/${rid}/remote`, source: rid, target: `remote/${r.id}`, kind: 'remote', label: sync === 'in sync' ? undefined : sync ?? 'unknown' })
    }
  }

  // GitHub after the repos: the order the layout reads left to right and top to bottom
  const remotes = i.repos.filter(r => r.remote)
  if (remotes.length) add({ id: 'group/github', kind: 'group', label: 'GitHub', layout: 'row', sub: [`${remotes.length} remotes`] })

  // who writes where: an edge from the agent to the repo it holds whole, else to the top-level
  // folder (or the root files) its write sits in; a write naming nothing that exists is named in its drawer
  for (const a of i.agents) {
    const seen = new Set<string>()
    const lost: string[] = []
    for (const w of a.writes ?? []) {
      const wr = norm(w)
      const whole = i.repos.find(r => r.path !== '.' && covers(wr, r.path))
      let target: string | undefined
      if (whole) target = `repo/${whole.id}`
      else {
        const repo = repoOf(wr, i.repos)
        if (repo) {
          const inner = repo.path === '.' ? wr : wr.slice(norm(repo.path).length + 1)
          const head = inner.split('/')[0]
          if (repo.folders?.includes(head)) target = `dir/${join(repo.path, head)}`
          else if (repo.files?.includes(head)) target = `files/${repo.id}`
        }
      }
      if (!target || !has.has(target)) { lost.push(w); continue }
      if (seen.has(target)) continue
      seen.add(target)
      edges.push({ id: `e/agent/${a.id}/${target}`, source: `agent/${a.id}`, target, kind: 'writes', overlay: 'owners' })
    }
    if (lost.length) nodes.find(n => n.id === `agent/${a.id}`)!.facts!.push(['writes, not in the tree', lost.join('  ')])
  }
  return { id: 'repos', label: 'Repos', layout: 'down', nodes, edges }
}

/** a container of the System view: the path that proves it, checked */
function container(i: MapInput, n: Omit<MapNode, 'kind'> & { path: string; kind?: MapNode['kind'] }): MapNode {
  const there = i.exists(n.path)
  const jobs = jobsFor(i, n.path)
  const owner = n.owner ?? ownerOf(n.path, i.agents)
  return {
    kind: 'container', ...n, owner,
    state: there ? n.state : 'fail', why: there ? n.why : `${n.path} is gone`,
    checks: [{ label: n.path, state: there ? 'ok' : 'fail', detail: there ? 'exists' : 'gone' }, ...(n.checks ?? [])],
    facts: [...(n.facts ?? []), ...(jobs.length ? [['jobs', jobs.map(j => j.id).join(', ')] as [string, string]] : [])],
    law: n.law ?? lawAt(i, n.path),
    board: openBoard(i.board, owner),
  }
}

/** a byte count as the owner reads it (2147483648 -> `2 GiB`) */
const gib = (b: number) => `${+(b / 2 ** 30).toFixed(2)} GiB`

/** the reason a storage class's folder that is not there yet reads unknown, never failed */
export const LAKE_NOT_BUILT = 'not built yet (B-0324)'

/**
 * The market store split by storage class (B-0322 section 1): one group, the lake, holding the
 * CACHE (the default for every read, rebuildable, evicted to a budget), the PINS (the rows a recorded
 * result used, content-hashed, immutable) and the ARCHIVE (forever: the lake's market/ folder). NONE
 * (live frames) is stored nowhere and so has no box, only a line. The lake itself missing is a fail,
 * as before the split; a class folder the database has not built yet is unknown, with the reason.
 */
function lakeNodes(i: MapInput): MapNode[] {
  const owner = ownerOf('database', i.agents)
  const L = i.lake
  const lakeTone = L.exists ? { state: 'ok' as MapState, why: 'the folder is there' } : { state: 'fail' as MapState, why: `${L.path} is missing` }
  const cls = (id: string, label: string, sub: string, f: LakeFolder, missing: 'fail' | 'unknown', facts: [string, string][]): MapNode => {
    const state: MapState = f.exists ? 'ok' : missing
    const why = f.exists ? 'the folder is there' : missing === 'fail' ? `${f.path} is missing` : LAKE_NOT_BUILT
    return {
      id: `sys/lake/${id}`, kind: 'container', parent: 'sys/lake', label, sub: [sub], owner, state, why,
      facts: [['folder', f.path], ...facts],
      checks: [{ label: f.path, state: f.exists ? 'ok' : missing, detail: f.exists ? 'exists' : missing === 'fail' ? 'missing' : LAKE_NOT_BUILT }],
      board: openBoard(i.board, owner),
    }
  }
  return [
    {
      id: 'sys/lake', kind: 'group', parent: 'group/machine', label: 'Parquet lake', layout: 'row', sub: ['cache · pins · archive'], path: 'database/py/fund_db',
      owner, ...lakeTone,
      facts: [['folder', L.path], ['read by', 'DuckDB through fund_db.market'], ['live', 'NONE: stored nowhere'], ['classes', 'B-0322 section 1']],
      checks: [{ label: L.path, state: L.exists ? 'ok' : 'fail', detail: L.exists ? 'exists' : 'missing' }],
      law: lawAt(i, 'database'), board: openBoard(i.board, owner),
    },
    cls('cache', 'Cache', 'every read · rebuildable', L.cache, 'unknown', [
      ['class', 'CACHE: the default for every read; evicted least-recently-read'],
      ['budget', L.budget === null ? `unknown: retention.toml [cache] max_bytes is ${LAKE_NOT_BUILT}` : `${gib(L.budget)} (retention.toml [cache] max_bytes)`],
    ]),
    cls('pins', 'Pins', 'results · immutable', L.pins, 'unknown', [
      ['class', 'PIN: the exact rows a recorded result used, content-hashed, never evicted'],
    ]),
    cls('archive', 'Archive', 'forever', { path: L.path, exists: L.exists }, 'fail', [
      ['class', 'ARCHIVE: kept forever'],
      ['holds', 'what a backtest needs and the source will not serve again'],
    ]),
  ]
}

function systemView(i: MapInput): MapView {
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  const e = (source: string, target: string, label?: string, kind: MapEdge['kind'] = 'uses') => edges.push({ id: `e/${source}/${target}`, source, target, kind, label })

  // outside this machine
  nodes.push({ id: 'group/outside', kind: 'group', label: 'Outside', layout: 'stack' })
  nodes.push({ id: 'ext/owner', kind: 'external', parent: 'group/outside', label: 'The owner', sub: ['the one human'], state: 'human', board: i.board.filter(b => b.owner === 'you' && b.status !== 'done').slice(0, 8).map(({ id, title, status }) => ({ id, title, status })) })
  const remotes = i.repos.filter(r => r.remote)
  nodes.push({ id: 'ext/github', kind: 'external', parent: 'group/outside', label: 'GitHub', sub: [`${remotes.length} remotes`], facts: remotes.map(r => [r.id, r.remote!] as [string, string]) })

  // this machine
  nodes.push({ id: 'group/machine', kind: 'group', label: 'This machine', layout: 'down' })
  const jobsOn = i.jobs.filter(j => j.enabled)
  nodes.push(container(i, {
    id: 'sys/cockpit', parent: 'group/machine', label: 'Cockpit', path: 'app/server', port: i.ports.ui,
    sub: [`app · :${i.ports.ui}`, `${jobsOn.length} jobs on`], state: 'ok', why: 'this answer came from it',
    facts: [['UI', `:${i.ports.ui}`], ['fundd', `:${i.ports.fundd}`], ['jobs', `${jobsOn.length} on of ${i.jobs.length}`], ...i.jobs.map(j => [j.id, `${j.enabled ? '' : 'off · '}${j.cadence}`] as [string, string])],
    law: lawAt(i, 'app'),
  }))
  nodes.push({ id: 'group/dashboards', kind: 'group', parent: 'group/machine', label: 'Dashboards', layout: 'grid', path: 'platform/dashboards', sub: [`${i.dashboards.length} · sealed`] })
  for (const d of i.dashboards) {
    const rel = `platform/dashboards/${d.id}`
    // its runbook is its CLAUDE.md (the `law` below); a folder of old books is listed only while an agent has not folded it in (B-0346)
    const lib = `app/library/dashboards/${d.id}`
    const port = d.start?.port
    nodes.push({
      id: `dash/${d.id}`, kind: 'dashboard', parent: 'group/dashboards', label: d.name, dashboard: d.id,
      sub: [[port ? `:${port}` : 'no port', d.kind === 'tool' ? 'tool' : d.market].join(' · ')],
      path: rel, port, owner: d.agent,
      facts: [['agent', d.agent], ['market', d.market], ['open', d.open], ...(d.start ? [['start', d.start.cmd] as [string, string]] : []), ...(d.every ? [['checked', `every ${d.every}`] as [string, string]] : [])],
      checks: d.health.map(h => ({ label: h.id, state: 'info' as const, detail: h.check === 'port' ? `port ${h.port}` : h.check === 'http' ? h.url : h.check === 'file_age' ? `${h.path} < ${h.max_h}h` : h.path })),
      books: i.mdIn(lib), law: lawAt(i, rel), board: openBoard(i.board, d.agent),
    })
  }
  nodes.push(container(i, {
    id: 'sys/lab', parent: 'group/machine', label: 'Research + Lab', sub: [`${i.desks.length} desks`, 'notebooks, ledgers'], path: 'platform/research',
    facts: [['lab', 'platform/lab'], ['desks', i.desks.join(', ') || 'none']],
    checks: [{ label: 'platform/lab', state: i.exists('platform/lab') ? 'ok' : 'fail', detail: i.exists('platform/lab') ? 'exists' : 'gone' }],
  }))
  const pgState: MapState = i.pg === null ? 'unknown' : i.pg.ok ? 'ok' : 'fail'
  nodes.push(container(i, {
    id: 'sys/pg', parent: 'group/machine', label: 'Postgres', sub: [`ops store · :${i.ports.pg ?? '?'}`, 'database · fund_db'], path: 'database/migrations', port: i.ports.pg ?? undefined,
    state: pgState, why: i.pg === null ? 'not asked' : i.pg.ok ? 'select 1 answered' : i.pg.why,
    facts: [['listens', `127.0.0.1:${i.ports.pg ?? 'unknown'}`], ['reached by', 'fund_db · @fund/db only']],
    checks: [{ label: 'select 1', state: i.pg === null ? 'unknown' : i.pg.ok ? 'ok' : 'fail', detail: i.pg?.why }],
    law: lawAt(i, 'database'),
  }))
  nodes.push(...lakeNodes(i))

  e('ext/owner', 'sys/cockpit', 'runs')
  e('sys/cockpit', 'group/dashboards', 'launches')
  e('sys/cockpit', 'sys/pg', '@fund/db')
  e('sys/cockpit', 'ext/github', 'git')
  e('sys/cockpit', 'sys/lake', 'fund_db')
  e('sys/lab', 'sys/lake', 'fund_db')
  return { id: 'system', label: 'System', layout: 'right', nodes, edges }
}

const STAGE_STATES = ['live', 'human', 'scaffold', 'missing', 'external'] as const

function pipelineView(i: MapInput): MapView {
  const view: MapView = { id: 'pipeline', label: 'Pipeline', layout: 'right', nodes: [], edges: [] }
  if ('error' in i.pipeline) return { ...view, error: `${i.pipelinePath}: ${i.pipeline.error}` }
  const doc = i.pipeline.doc as { stages?: unknown; loop?: unknown } | null
  const stages = Array.isArray(doc?.stages) ? doc!.stages as Record<string, unknown>[] : null
  if (!stages?.length) return { ...view, error: `${i.pipelinePath}: no stages` }
  const bad: string[] = []
  stages.forEach((s, k) => {
    const id = typeof s.id === 'string' ? s.id : ''
    const status = typeof s.status === 'string' ? s.status : ''
    if (!id) { bad.push(`stage ${k + 1} has no id`); return }
    const evidence = Array.isArray(s.evidence) ? (s.evidence as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const gone = evidence.filter(p => !i.exists(p))
    const known = (STAGE_STATES as readonly string[]).includes(status)
    if (!known) bad.push(`${id}: status "${status}" is not one of ${STAGE_STATES.join(', ')}`)
    const owners = [...new Set(evidence.map(p => ownerOf(p, i.agents)).filter((x): x is string => !!x))]
    view.nodes.push({
      id: `stage/${id}`, kind: 'stage', n: k + 1, label: typeof s.name === 'string' ? s.name : id,
      holds: Array.isArray(s.holds) ? (s.holds as unknown[]).map(String) : [],
      state: gone.length ? 'fail' : known ? status as MapState : 'unknown',
      why: gone.length ? `evidence gone: ${gone.join(', ')}` : known ? status : `unknown status "${status}"`,
      owner: owners[0], also: owners.slice(1), path: evidence[0],
      facts: [['status', status || 'none'], ['evidence', evidence.join('  ') || 'none named']],
      checks: evidence.map(p => ({ label: p, state: gone.includes(p) ? 'fail' : 'ok', detail: gone.includes(p) ? 'gone' : 'exists' } as MapCheck)),
      board: openBoard(i.board, owners[0]),
    })
    if (k > 0 && typeof stages[k - 1].id === 'string') view.edges.push({ id: `e/stage/${k}`, source: `stage/${stages[k - 1].id}`, target: `stage/${id}`, kind: 'flow' })
  })
  const loop = doc?.loop as { from?: string; to?: string; label?: string; evidence?: unknown } | undefined
  if (loop?.from && loop?.to) {
    const ev = Array.isArray(loop.evidence) ? (loop.evidence as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const gone = ev.filter(p => !i.exists(p))
    const to = view.nodes.find(n => n.id === `stage/${loop.to}`)
    if (!to || !view.nodes.some(n => n.id === `stage/${loop.from}`)) bad.push(`loop: ${loop.from} -> ${loop.to} names a stage that is not listed`)
    else {
      view.edges.push({ id: 'e/loop', source: `stage/${loop.from}`, target: `stage/${loop.to}`, kind: 'loop', label: `the loop: ${gone.length ? 'evidence gone' : loop.label ?? ''}` })
      to.facts = [...(to.facts ?? []), ['the loop', `${loop.from} -> ${loop.to}: ${loop.label ?? ''}`]]
      to.checks = [...(to.checks ?? []), ...ev.map(p => ({ label: `loop: ${p}`, state: gone.includes(p) ? 'fail' : 'ok', detail: gone.includes(p) ? 'gone' : 'exists' } as MapCheck))]
    }
  }
  for (const b of bad) i.problems.push({ path: i.pipelinePath, error: b })
  return view
}

const DATA_STATES = ['live', 'building', 'planned', 'external', 'off'] as const
const DATA_LAYOUTS = ['row', 'grid', 'stack'] as const

/** THE DATA VIEW: data-flow.json is a list of layers (a row of boxes each) top to bottom, and the
 *  edges between layers or boxes. Same rule as the pipeline: a box names the paths that prove it and
 *  paints red when one is gone; a status word it does not know is said, never guessed. */
function dataView(i: MapInput): MapView {
  const view: MapView = { id: 'data', label: 'Data', layout: 'down', nodes: [], edges: [] }
  if ('error' in i.dataFlow) return { ...view, error: `${i.dataFlowPath}: ${i.dataFlow.error}` }
  const doc = i.dataFlow.doc as { layers?: unknown; edges?: unknown } | null
  const layers = Array.isArray(doc?.layers) ? doc!.layers as Record<string, unknown>[] : null
  if (!layers?.length) return { ...view, error: `${i.dataFlowPath}: no layers` }
  const bad: string[] = []
  const ends = new Map<string, string>()   // a layer id or a box id -> the node id it draws as
  const seen = new Set<string>()
  const strs = (x: unknown) => (Array.isArray(x) ? (x as unknown[]).filter((v): v is string => typeof v === 'string') : [])
  layers.forEach((l, k) => {
    const lid = typeof l.id === 'string' ? l.id : ''
    if (!lid) { bad.push(`layer ${k + 1} has no id`); return }
    if (seen.has(lid)) { bad.push(`${lid}: listed twice`); return }
    seen.add(lid)
    const gid = `group/data-${lid}`
    ends.set(lid, gid)
    const layout = (DATA_LAYOUTS as readonly string[]).includes(String(l.layout)) ? l.layout as MapView['layout'] : 'row'
    view.nodes.push({ id: gid, kind: 'group', label: typeof l.name === 'string' ? l.name : lid, layout })
    const boxes = Array.isArray(l.nodes) ? l.nodes as Record<string, unknown>[] : []
    if (!boxes.length) bad.push(`${lid}: no boxes`)
    for (const b of boxes) {
      const id = typeof b.id === 'string' ? b.id : ''
      if (!id) { bad.push(`${lid}: a box has no id`); continue }
      if (seen.has(id)) { bad.push(`${id}: listed twice`); continue }
      seen.add(id)
      const status = typeof b.status === 'string' ? b.status : ''
      const known = (DATA_STATES as readonly string[]).includes(status)
      if (!known) bad.push(`${id}: status "${status}" is not one of ${DATA_STATES.join(', ')}`)
      const evidence = strs(b.evidence)
      const gone = evidence.filter(p => !i.exists(p))
      const owners = [...new Set(evidence.map(p => ownerOf(p, i.agents)).filter((x): x is string => !!x))]
      const sub = strs(b.sub).slice(0, 2)
      if (strs(b.sub).length > 2) bad.push(`${id}: more than two sub lines`)
      ends.set(id, `data/${id}`)
      view.nodes.push({
        id: `data/${id}`, kind: b.kind === 'external' ? 'external' : 'container', parent: gid,
        label: typeof b.name === 'string' ? b.name : id, sub,
        state: gone.length ? 'fail' : known ? status as MapState : 'unknown',
        why: gone.length ? `evidence gone: ${gone.join(', ')}` : known ? status : `unknown status "${status}"`,
        owner: owners[0], also: owners.slice(1), path: evidence[0],
        facts: [['status', status || 'none'], ['evidence', evidence.join('  ') || 'none named'], ...(typeof b.note === 'string' ? [['note', b.note] as [string, string]] : [])],
        checks: evidence.map(p => ({ label: p, state: gone.includes(p) ? 'fail' : 'ok', detail: gone.includes(p) ? 'gone' : 'exists' } as MapCheck)),
        board: openBoard(i.board, owners[0]),
      })
    }
  })
  const edges = Array.isArray(doc?.edges) ? doc!.edges as Record<string, unknown>[] : []
  edges.forEach((e, k) => {
    const from = ends.get(String(e.from)), to = ends.get(String(e.to))
    if (!from || !to) { bad.push(`edge ${k + 1}: ${String(e.from)} -> ${String(e.to)} names something that is not listed`); return }
    view.edges.push({ id: `e/data/${k + 1}`, source: from, target: to, kind: e.kind === 'uses' ? 'uses' : 'flow', label: typeof e.label === 'string' ? e.label : undefined })
  })
  for (const b of bad) i.problems.push({ path: i.dataFlowPath, error: b })
  return view
}

export function buildMap(input: MapInput, at = Date.now()): MapGraph {
  const i = { ...input, problems: [...input.problems] }
  const views = [reposView(i), systemView(i), pipelineView(i), dataView(i)]
  return { at, views, problems: i.problems }
}

/** what the map is missing: every repo, agent and dashboard in the files must be a node
 *  somewhere (test/map.test.ts holds it on the real tree, and plants a drop to prove it can fail) */
export function coverage(g: MapGraph, i: Pick<MapInput, 'repos' | 'agents' | 'dashboards'>): string[] {
  const ids = new Set(g.views.flatMap(v => v.nodes.map(n => n.id)))
  const want = [
    ...i.repos.map(r => `repo/${r.id}`), ...i.agents.map(a => `agent/${a.id}`),
    ...i.dashboards.map(d => `dash/${d.id}`),
  ]
  return want.filter(id => !ids.has(id))
}
