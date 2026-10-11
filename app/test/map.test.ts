import { describe, expect, it } from 'vitest'
import type { Agent } from '../shared/types.ts'
import type { MapGraph, MapNode, MapView } from '../shared/map.ts'
import { buildMap, coverage, covers, LAKE_NOT_BUILT, ownerOf, remoteName, repoOf, syncWords, writersInside, type MapInput } from '../server/map/build.ts'
import { cacheBudget, listDesks, parseWorktrees, readInput, readMap, storePaths } from '../server/map/read.ts'
import { gridCols, layoutView, sides, sizeOf, STAGE_TOP, type Laid } from '../src/rooms/map/layout.ts'
import { groupWidth, holdLines, leafWidth, stageLabelWidth, stageWidth, STAGE_COL1, textWidth, wrapLines } from '../src/rooms/map/measure.ts'
import { crossings, cuts, obstacles, port, routeEdges, type RouteIn } from '../src/rooms/map/route.ts'
import { runMark, stateMark } from '../src/rooms/map/marks.ts'
import { matches, targetOf } from '../src/rooms/map/store.ts'

// THE MAP (B-0207): generated from the files, so a repo, an agent or a dashboard that exists in
// the tree and is missing from the map is a failure, not a style choice.

const agent = (id: string, writes: string[]): Agent => ({ id, name: id, kind: 'standing', mode: 'active', dept: '', role: '', cwd: '.', writes, model: 'm', effort: 'high', boot: [] })

function input(over: Partial<MapInput> = {}): MapInput {
  const there = new Set(['app/server', 'app/loop/tools', 'platform/feeds', 'platform/signals', 'platform/research', 'platform/lab', 'database/migrations', 'vault/core', 'platform/dashboards/carry'])
  return {
    repos: [
      { id: 'fund', path: '.', remote: 'https://github.com/x/fund.git', state: { branch: 'main', upstream: 'origin/main', dirty: 0, conflicts: 0, midOp: null, ahead: 0, behind: 0, head: { sha: 'abcdef1234', subject: 's', ts: 1 } }, fetchedAt: null, folders: ['.claude'], files: ['CLAUDE.md'], worktrees: [] },
      { id: 'app', path: 'app', remote: 'https://github.com/x/fund-app.git', verify: 'npm run verify', state: { branch: 'main', upstream: 'origin/main', dirty: 2, conflicts: 0, midOp: null, ahead: 1, behind: 0, head: null }, fetchedAt: null, folders: ['server', 'src'], files: ['package.json'], worktrees: [{ path: '/w/app/c-1', branch: 'b/app/map-room' }] },
      { id: 'vault', path: 'vault', guarded: true, needs: ['app'], state: null, fetchedAt: null, folders: ['core'], files: [], worktrees: [] },
    ],
    agents: [agent('fund', ['CLAUDE.md', '.claude/', 'app/agents/']), agent('app', ['app/']), agent('vault', ['vault/']), agent('dash:carry', ['platform/dashboards/carry/'])],
    dashboards: [{ id: 'carry', name: 'Carry', market: 'crypto', agent: 'dash:carry', open: 'http://127.0.0.1:8794/', start: { cmd: 'x', cwd: 'platform/dashboards/carry', port: 8794 }, health: [{ id: 'port', check: 'port', port: 8794 }] }],
    jobs: [{ id: 'chart-check', cwd: '.', cmd: ['python', 'platform/research/check_charts.py'], cadence: 'daily 06:30', enabled: true, kind: 'script' }],
    desks: ['lab/example'],
    pipeline: { doc: { stages: [
      { id: 'market-data', name: 'Market data', status: 'live', holds: ['adapters'], evidence: ['platform/feeds'] },
      { id: 'signal', name: 'Signal', status: 'live', holds: [], evidence: ['platform/signals'] },
      { id: 'risk', name: 'Risk', status: 'missing', holds: [], evidence: [] },
    ], loop: { from: 'risk', to: 'signal', label: 'results -> retro', evidence: ['app/loop/tools'] } } },
    pipelinePath: 'app/library/law/the-atlas/pipeline.json',
    dataFlow: { doc: {
      layers: [
        { id: 'sources', name: 'Sources', nodes: [{ id: 'feeds', name: 'Feeds', kind: 'external', status: 'external', sub: ['public APIs'] }] },
        { id: 'fetch', name: 'Fetch', nodes: [{ id: 'adapters', name: 'Feed adapters', status: 'live', sub: ['fetch only'], evidence: ['platform/feeds'] }, { id: 'pacer', name: 'Shared pacer', status: 'building', evidence: ['platform/signals'] }] },
        { id: 'used', name: 'Used by', nodes: [{ id: 'notebooks', name: 'Notebooks', status: 'live', evidence: ['platform/research'] }, { id: 'loop', name: 'The loop', status: 'live', evidence: ['app/loop/tools'] }] },
      ],
      edges: [{ from: 'sources', to: 'fetch', label: 'HTTP' }, { from: 'fetch', to: 'used' }, { from: 'loop', to: 'adapters', kind: 'uses' }],
    } },
    dataFlowPath: 'app/library/law/the-atlas/data-flow.json',
    exists: rel => there.has(rel), mdIn: () => [], board: [{ id: 'B-0001', title: 't', status: 'ready', owner: 'app' }],
    ports: { ui: 4688, fundd: 4689, pg: 5432 }, pg: { ok: true },
    lake: { path: '/data/db/market', exists: true, cache: { path: '/data/db/cache', exists: true }, pins: { path: '/data/db/pins', exists: true }, budget: 2 * 2 ** 30 },
    problems: [],
    ...over,
  }
}
const view = (g: MapGraph, id: string) => g.views.find(v => v.id === id)!
const node = (g: MapGraph, id: string) => g.views.flatMap(v => v.nodes).find(n => n.id === id)

describe('who writes what', () => {
  it('a write covers itself and what is under it, never a sibling that shares a prefix', () => {
    expect(covers('app/', 'app/server')).toBe(true)
    expect(covers('app/', 'app')).toBe(true)
    expect(covers('app/', 'application')).toBe(false)
    expect(covers('.', 'app')).toBe(false)
  })
  it('the longest covering write owns a path; writers inside it are the rest', () => {
    const as = [agent('app', ['app/']), agent('fund', ['app/library/law/']), agent('dash:carry', ['platform/dashboards/carry/'])]
    expect(ownerOf('app/library/law/x.md', as)).toBe('fund')
    expect(ownerOf('app/server', as)).toBe('app')
    expect(ownerOf('platform/dashboards', as)).toBeUndefined()
    expect(writersInside('platform/dashboards', as)).toEqual(['dash:carry'])
    expect(repoOf('app/x', [{ path: '.' }, { path: 'app' }])?.path).toBe('app')
    expect(repoOf('README.md', [{ path: '.' }, { path: 'app' }])?.path).toBe('.')
  })
  it('names a remote and a sync without guessing', () => {
    expect(remoteName('https://github.com/x/fund-app.git')).toBe('fund-app')
    expect(syncWords(null)).toBeNull()
    expect(syncWords({ branch: 'main', upstream: null, dirty: 0, conflicts: 0, midOp: null, ahead: null, behind: null, head: null })).toBeNull()
    expect(syncWords({ branch: 'main', upstream: 'o/m', dirty: 0, conflicts: 0, midOp: null, ahead: 2, behind: 1, head: null })).toBe('2 ahead · 1 behind')
  })
  it('reads the build worktrees and leaves the main checkout out', () => {
    const wt = parseWorktrees('worktree C:/dev/fund/app\nHEAD 1\nbranch refs/heads/main\n\nworktree C:/w/app/c-1\nHEAD 2\nbranch refs/heads/b/app/x\n\nworktree C:/w/app/c-2\nHEAD 3\ndetached\n')
    expect(wt).toEqual([{ path: 'C:/w/app/c-1', branch: 'b/app/x' }, { path: 'C:/w/app/c-2', branch: null }])
  })
})

describe('the builder', () => {
  it('draws every repo, folder, remote, worktree and agent in the Repos view', () => {
    const g = buildMap(input())
    const r = view(g, 'repos')
    for (const id of ['repo/fund', 'repo/app', 'repo/vault', 'dir/app/server', 'dir/.claude', 'files/app', 'remote/app', 'wt/app/b/app/map-room', 'agent/dash:carry']) expect(r.nodes.some(n => n.id === id), id).toBe(true)
    expect(node(g, 'repo/app')!.state).toBe('warn')          // 2 dirty
    expect(node(g, 'repo/vault')!.state).toBe('guarded')
    expect(node(g, 'remote/app')!.state).toBe('warn')        // 1 ahead
    expect(node(g, 'repo/app')!.owner).toBe('app')
    // a repo no single agent covers whole has no owner, never a guessed one
    expect(node(g, 'repo/fund')!.owner).toBe('fund')
    // the agent's write reaches the repo it holds whole, else the top folder its write sits in
    expect(r.edges.some(e => e.source === 'agent/app' && e.target === 'repo/app')).toBe(true)
    expect(r.edges.some(e => e.source === 'agent/fund' && e.target === 'dir/.claude')).toBe(true)
  })
  it('names an agent write that points at nothing in the tree', () => {
    const g = buildMap(input({ agents: [agent('app', ['app/', 'gone/'])] }))
    expect(node(g, 'agent/app')!.facts!.find(f => f[0] === 'writes, not in the tree')?.[1]).toBe('gone/')
  })
  it('paints a System container red when the path that proves it is gone', () => {
    const g = buildMap(input({ exists: rel => rel !== 'platform/research' }))
    const d = node(g, 'sys/lab')!
    expect(d.state).toBe('fail')
    expect(d.why).toMatch(/gone/)
    expect(node(g, 'sys/pg')!.state).not.toBe('fail')
  })
  it('never calls the ops store up without asking it', () => {
    expect(node(buildMap(input({ pg: null })), 'sys/pg')!.state).toBe('unknown')
    expect(node(buildMap(input({ pg: { ok: false, why: 'refused' } })), 'sys/pg')!.state).toBe('fail')
  })
  it('hangs a job on the container whose module it runs', () => {
    expect(node(buildMap(input()), 'sys/lab')!.facts!.find(f => f[0] === 'jobs')?.[1]).toBe('chart-check')
  })
  it('paints a stage red when a path it names as evidence is gone, and keeps its own word otherwise', () => {
    const ok = buildMap(input())
    expect(node(ok, 'stage/market-data')!.state).toBe('live')
    expect(node(ok, 'stage/risk')!.state).toBe('missing')
    const gone = buildMap(input({ exists: rel => rel !== 'platform/feeds' }))
    expect(node(gone, 'stage/market-data')!.state).toBe('fail')
    expect(node(gone, 'stage/market-data')!.why).toContain('platform/feeds')
    const p = view(ok, 'pipeline')
    expect(p.edges.map(e => e.kind)).toEqual(['flow', 'flow', 'loop'])
  })
  it('says why the pipeline cannot be drawn, never an empty chain', () => {
    expect(view(buildMap(input({ pipeline: { error: 'missing' } })), 'pipeline').error).toMatch(/missing/)
    expect(view(buildMap(input({ pipeline: { doc: { stages: [] } } })), 'pipeline').error).toMatch(/no stages/)
    const bad = buildMap(input({ pipeline: { doc: { stages: [{ id: 'x', name: 'X', status: 'wobbly', evidence: [] }] } } }))
    expect(node(bad, 'stage/x')!.state).toBe('unknown')
    expect(bad.problems.some(p => /wobbly/.test(p.error))).toBe(true)
  })
  it('draws the data flow top down: layers as rows, boxes in them, edges between layers or boxes (B-0322)', () => {
    const d = view(buildMap(input()), 'data')
    expect(d.layout).toBe('down')
    expect(d.nodes.filter(n => n.kind === 'group').map(n => n.id)).toEqual(['group/data-sources', 'group/data-fetch', 'group/data-used'])
    expect(node(buildMap(input()), 'data/adapters')!.parent).toBe('group/data-fetch')
    expect(node(buildMap(input()), 'data/feeds')!.kind).toBe('external')
    expect(d.edges.map(e => [e.source, e.target, e.kind])).toEqual([
      ['group/data-sources', 'group/data-fetch', 'flow'], ['group/data-fetch', 'group/data-used', 'flow'], ['data/loop', 'data/adapters', 'uses'],
    ])
  })
  it('paints a data box red when a path it names is gone, and keeps its own word otherwise', () => {
    const ok = buildMap(input())
    expect(node(ok, 'data/adapters')!.state).toBe('live')
    expect(node(ok, 'data/pacer')!.state).toBe('building')
    expect(node(ok, 'data/feeds')!.state).toBe('external')
    const gone = buildMap(input({ exists: rel => rel !== 'platform/feeds' }))
    expect(node(gone, 'data/adapters')!.state).toBe('fail')
    expect(node(gone, 'data/adapters')!.why).toContain('platform/feeds')
    expect(node(gone, 'data/pacer')!.state).toBe('building')
  })
  it('says why the data flow cannot be drawn, and names what is wrong in it', () => {
    expect(view(buildMap(input({ dataFlow: { error: 'missing' } })), 'data').error).toMatch(/missing/)
    expect(view(buildMap(input({ dataFlow: { doc: { layers: [] } } })), 'data').error).toMatch(/no layers/)
    const bad = buildMap(input({ dataFlow: { doc: { layers: [{ id: 'a', name: 'A', nodes: [{ id: 'x', name: 'X', status: 'wobbly', sub: ['1', '2', '3'] }] }], edges: [{ from: 'a', to: 'nowhere' }] } } }))
    expect(node(bad, 'data/x')!.state).toBe('unknown')
    expect(node(bad, 'data/x')!.sub).toHaveLength(2)
    const said = bad.problems.map(p => p.error).join(' | ')
    expect(said).toMatch(/wobbly/)
    expect(said).toMatch(/more than two sub lines/)
    expect(said).toMatch(/nowhere/)
  })
  it('splits the lake by storage class: cache, pins and archive, each with an honest state (B-0322)', () => {
    const lake = (cache: boolean, pins: boolean, market = true, budget: number | null = 2 * 2 ** 30): MapInput['lake'] =>
      ({ path: '/d/market', exists: market, cache: { path: '/d/cache', exists: cache }, pins: { path: '/d/pins', exists: pins }, budget })
    const at = (l: MapInput['lake']) => { const g = buildMap(input({ lake: l })); return (id: string) => node(g, id)! }
    const kids = ['sys/lake/cache', 'sys/lake/pins', 'sys/lake/archive']
    // present: every class ok, each a child of the lake
    const ok = at(lake(true, true))
    expect(ok('sys/lake')).toMatchObject({ kind: 'group', state: 'ok' })
    for (const id of kids) expect(ok(id), id).toMatchObject({ parent: 'sys/lake', state: 'ok' })
    expect(ok('sys/lake/cache').facts!.find(f => f[0] === 'budget')?.[1]).toMatch(/^2 GiB/)
    // not built yet: unknown with the reason, never failed and never ok; the lake stays ok
    const absent = at(lake(false, false, true, null))
    for (const id of ['sys/lake/cache', 'sys/lake/pins']) {
      expect(absent(id).state, id).toBe('unknown')
      expect(absent(id).why, id).toBe(LAKE_NOT_BUILT)
      expect(absent(id).checks![0].state, id).toBe('unknown')
    }
    expect(absent('sys/lake/cache').facts!.find(f => f[0] === 'budget')?.[1]).toMatch(/^unknown/)
    expect(absent('sys/lake').state).toBe('ok')
    expect(absent('sys/lake/archive').state).toBe('ok')
    // the lake itself missing stays a fail, the archive with it; a class not built stays unknown
    const gone = at(lake(false, true, false))
    expect(gone('sys/lake').state).toBe('fail')
    expect(gone('sys/lake/archive').state).toBe('fail')
    expect(gone('sys/lake/archive').why).toMatch(/missing/)
    expect(gone('sys/lake/cache').state).toBe('unknown')
    expect(gone('sys/lake/pins').state).toBe('ok')
    // the reads: the classes' folders beside the lake, and the budget only when it is written
    expect(storePaths('/r')).toEqual({ archive: expect.stringMatching(/market$/), cache: expect.stringMatching(/cache$/), pins: expect.stringMatching(/pins$/) })
    const toml = (...lines: string[]) => lines.join('\n') + '\n'
    expect(cacheBudget(toml('[defaults]', 'keep_days = 0', '', '[cache]', 'max_bytes = 2_147_483_648  # the owner', '', '[datasets.x]', 'keep_days = 1'))).toBe(2147483648)
    expect(cacheBudget(toml('[defaults]', 'max_bytes = 5'))).toBeNull()
    expect(cacheBudget(toml('[cache]'))).toBeNull()
  })
  it('the coverage check names what is missing (planted: a dashboard dropped from the answer)', () => {
    const i = input()
    const g = buildMap(i)
    expect(coverage(g, i)).toEqual([])
    const planted: MapGraph = { ...g, views: g.views.map(v => ({ ...v, nodes: v.nodes.filter(n => n.id !== 'dash/carry') })) }
    expect(coverage(planted, i)).toEqual(['dash/carry'])
  })
})

describe('the map of the real tree', () => {
  it('holds every repo, agent and dashboard in the files', async () => {
    const i = await readInput()
    expect(i.repos.length).toBeGreaterThan(0)
    expect(i.agents.length).toBeGreaterThan(0)
    const g = buildMap(i)
    expect(coverage(g, i)).toEqual([])
    for (const v of g.views) {
      expect(v.error, v.id).toBeUndefined()
      const ids = v.nodes.map(n => n.id)
      expect(new Set(ids).size, `${v.id}: an id twice`).toBe(ids.length)
      for (const n of v.nodes) if (n.parent) expect(ids, `${n.id}'s parent`).toContain(n.parent)
      for (const e of v.edges) { expect(ids, e.id).toContain(e.source); expect(ids, e.id).toContain(e.target) }
    }
    // every stage pipeline.json names is drawn, in its order
    const doc = 'doc' in i.pipeline ? i.pipeline.doc as { stages: { id: string }[] } : null
    expect(view(g, 'pipeline').nodes.map(n => n.id)).toEqual(doc!.stages.map(s => `stage/${s.id}`))
    // every layer and box data-flow.json names is drawn, none of them red (a path it names is gone), and every edge joins two of them
    const flow = 'doc' in i.dataFlow ? i.dataFlow.doc as { layers: { id: string; nodes: { id: string }[] }[] } : null
    const want = flow!.layers.flatMap(l => [`group/data-${l.id}`, ...l.nodes.map(n => `data/${n.id}`)])
    expect(view(g, 'data').nodes.map(n => n.id).sort()).toEqual(want.sort())
    expect(view(g, 'data').nodes.filter(n => n.state === 'fail').map(n => n.id)).toEqual([])
    expect(g.problems.filter(p => p.path === i.dataFlowPath)).toEqual([])
  })
  it('finds the lab desks', () => {
    expect(listDesks().length).toBeGreaterThan(0)
  })
  it('puts the GitHub remotes in the same left-to-right order as their repos, so no repo -> remote edge crosses', async () => {
    // a fixture with two remotes: the one public repo has none of its own to order
    const g = buildMap(input())
    const v = view(g, 'repos')
    const l = await layoutView(v, { pipe: 'right' })
    const pairs = v.edges.filter(e => e.kind === 'remote').map(e => [l.nodes.get(e.source)!, l.nodes.get(e.target)!])
    expect(pairs.length).toBeGreaterThan(1)
    const byRepo = [...pairs].sort((a, b) => a[0].ax - b[0].ax).map(([, r]) => r.id)
    const byRemote = [...pairs].sort((a, b) => a[1].ax - b[1].ax).map(([, r]) => r.id)
    expect(byRemote).toEqual(byRepo)
    // one row: every remote at the same height
    expect(new Set(pairs.map(([, r]) => r.ay)).size).toBe(1)
  })
  it('lays every view out with no box over another and every child inside its group', async () => {
    const g = await readMap()
    for (const v of g.views) for (const pipe of ['right', 'down'] as const) noOverlap(v, await layoutView(v, { pipe }), `${v.id}/${pipe}`)
  })
})

function noOverlap(v: MapView, l: Laid, what: string) {
  const all = [...l.nodes.values()]
  expect(all.length, what).toBe(v.nodes.length)
  const by = new Map<string | null, typeof all>()
  for (const p of all) by.set(p.parent, [...(by.get(p.parent) ?? []), p])
  for (const sibs of by.values()) for (let a = 0; a < sibs.length; a++) for (let b = a + 1; b < sibs.length; b++) {
    const x = sibs[a], y = sibs[b]
    const hit = x.ax < y.ax + y.w && y.ax < x.ax + x.w && x.ay < y.ay + y.h && y.ay < x.ay + x.h
    expect(hit, `${what}: ${x.id} over ${y.id}`).toBe(false)
  }
  for (const p of all) if (p.parent) {
    const g = l.nodes.get(p.parent)!
    expect(p.ax >= g.ax && p.ay >= g.ay && p.ax + p.w <= g.ax + g.w + 0.5 && p.ay + p.h <= g.ay + g.h + 0.5, `${what}: ${p.id} outside ${g.id}`).toBe(true)
  }
}

describe('the layout', () => {
  it('packs a grid near the shape it is asked for', () => {
    expect(gridCols(1, 100, 30, 3)).toBe(1)
    expect(gridCols(12, 142, 32, 6)).toBe(4)
    expect(gridCols(22, 130, 34, 0.9)).toBe(2)   // a tall narrow grid: two columns
  })
  it('leaves by the bottom when the target sits wholly below, else by the facing side', () => {
    const at = (ax: number, ay: number) => ({ id: '', parent: null, x: 0, y: 0, w: 100, h: 40, ax, ay })
    expect(sides(at(0, 0), at(0, 100))).toEqual({ from: 'b', to: 't' })
    expect(sides(at(0, 100), at(0, 0))).toEqual({ from: 't', to: 'b' })
    expect(sides(at(0, 0), at(300, 20))).toEqual({ from: 'r', to: 'l' })
    expect(sides(at(300, 0), at(0, 20))).toEqual({ from: 'l', to: 'r' })
  })
  it('lays a fixture out in both pipeline orientations', async () => {
    const g = buildMap(input())
    for (const v of g.views) for (const pipe of ['right', 'down'] as const) noOverlap(v, await layoutView(v, { pipe }), `${v.id}/${pipe}`)
  })
})

describe('the marks', () => {
  it('never draws a dashboard green before it was read, or when the read failed', () => {
    expect(runMark('carry', null, null).s).toBe('unknown')
    expect(runMark('carry', null, 'HTTP 500').title).toMatch(/HTTP 500/)
    const row = (state: string, measured = true) => [{ id: 'carry', state, measured, port: 8794, since: null, health: { ok: 1, total: 2, failing: ['api'], warning: [] } }]
    expect(runMark('carry', row('running', false), null).s).toBe('unknown')
    expect(runMark('carry', row('running'), null).s).toBe('ok')
    expect(runMark('carry', row('stopped'), null).s).toBe('off')
    expect(runMark('carry', row('failing'), null).title).toMatch(/api/)
    expect(runMark('vol', row('running'), null).s).toBe('unknown')
  })
  it('paints only health words as health: planned and building are hollow, the owner is blue', () => {
    expect(stateMark({})).toBeNull()
    expect(stateMark({ state: 'planned' })!.s).toBe('unknown')
    expect(stateMark({ state: 'building' })!.s).toBe('unknown')
    expect(stateMark({ state: 'human' })!.s).toBe('ask')
    expect(stateMark({ state: 'fail', why: 'x is gone' })!.title).toBe('fail: x is gone')
  })
})

describe('the link and the search', () => {
  it('reads #/map/<view>/<node>, a node id keeping its slashes', () => {
    expect(targetOf(null)).toEqual({ view: 'system', node: null, bad: false })
    expect(targetOf('pipeline')).toEqual({ view: 'pipeline', node: null, bad: false })
    expect(targetOf('repos/dir/app/server')).toEqual({ view: 'repos', node: 'dir/app/server', bad: false })
    expect(targetOf('nonsense').bad).toBe(true)
  })
  it('matches every word against the label, id, path, owner and lines', () => {
    const n = { id: 'dash/carry', label: 'Carry', path: 'platform/dashboards/carry', owner: 'dash:carry', sub: [':8794 · crypto'] }
    expect(matches(n, 'carry 8794')).toBe(true)
    expect(matches(n, 'carry acme')).toBe(false)
    expect(matches(n, '   ')).toBe(false)
  })
})

// ---- the three defects the review found (2026-09-27): cut labels, a name twice, lines through boxes ----

/** the text a box shows for its label: the label, or as much of it as fits before the ellipsis */
function visible(label: string, room: number, px: number, face: 'sans' | 'mono'): string {
  if (textWidth(label, px, face) <= room) return label
  let k = label.length
  while (k > 0 && textWidth(label.slice(0, k) + '...', px, face) > room) k--
  return label.slice(0, k) + '...'
}

/** where a node's name is read: a folder, the root files and a worktree inside their repo's frame,
 *  everything else by its kind across the whole view */
const whereRead = (n: MapNode) => (n.kind === 'dir' || n.kind === 'files' || n.kind === 'worktree' ? `${n.kind} in ${n.parent}` : n.kind)

/** every edge a view can draw */
function drawable(v: MapView, pipe: 'right' | 'down'): RouteIn[] {
  const loop = [pipe === 'right' ? 'b' : 'r'] as ('b' | 'r')[]
  return v.edges.map(e => ({ id: e.id, source: e.source, target: e.target, ...(e.kind === 'loop' ? { from: loop, to: loop } : {}) }))
}

describe('labels: whole and never twice', () => {
  it('the visible-label check can fail (planted: two long names sharing their first words, in a narrow box)', () => {
    const cut = (s: string) => visible(s, 100, 11.5, 'mono')
    expect(cut('Federal Reserve Board')).toBe(cut('Federal Reserve Bank of New York'))
  })
  it('every box of the real tree shows its whole label, and no two read the same', async () => {
    const g = await readMap()
    for (const v of g.views) {
      const l = await layoutView(v, { pipe: 'right' })
      const seen = new Map<string, string>()
      for (const n of v.nodes) {
        const p = l.nodes.get(n.id)!
        const mono = ['dir', 'agent', 'worktree', 'remote'].includes(n.kind)
        const px = mono ? 11.5 : 12.5, face = mono ? 'mono' : 'sans'
        // a leaf's room for its label: its width less everything else on the label's line
        const room = n.kind === 'group' || n.kind === 'repo' || n.kind === 'stage' ? Infinity : p.w - (leafWidth({ ...n, sub: [] }) - textWidth(n.label, px, face))
        const k = `${whereRead(n)}|${visible(n.label, room, px, face).toLowerCase()}`
        expect(seen.get(k), `${v.id}: ${n.id} reads the same as ${seen.get(k)}`).toBeUndefined()
        seen.set(k, n.id)
      }
    }
  })
})

describe('boxes: sized to their words', () => {
  it('no label or sub line is wider than its box, in every view and both pipeline orientations', async () => {
    const g = await readMap()
    for (const v of g.views) for (const pipe of ['right', 'down'] as const) {
      const l = await layoutView(v, { pipe })
      for (const n of v.nodes) {
        const p = l.nodes.get(n.id)!
        const need = n.kind === 'group' || n.kind === 'repo' ? groupWidth(n) : n.kind === 'stage' ? stageWidth(n, pipe) : leafWidth(n)
        expect(need, `${v.id}/${pipe}: ${n.id} needs ${need}px, has ${p.w}`).toBeLessThanOrEqual(p.w)
        if (n.kind === 'stage' && pipe === 'down') expect(stageLabelWidth(n), `${n.id} in the row's first column`).toBeLessThanOrEqual(STAGE_COL1)
        if (n.kind === 'stage' && pipe === 'right') expect(STAGE_TOP + 15 * holdLines(n, p.w), `${n.id}: what it holds, wrapped`).toBeLessThanOrEqual(p.h)
      }
    }
  })
  it('wraps a line word by word, and breaks a word longer than the room', () => {
    expect(wrapLines('no portfolio construction yet', 1000, 11.5, 'sans')).toBe(1)
    expect(wrapLines('no portfolio construction yet', 110, 11.5, 'sans')).toBe(2)
    expect(wrapLines('x'.repeat(40), 60, 11.5, 'mono')).toBeGreaterThanOrEqual(5)
  })
  it('the size check can fail (planted: a folder at the old fixed width, with seven writers)', () => {
    const dir: MapNode = { id: 'dir/platform/dashboards', kind: 'dir', label: 'dashboards', also: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }
    expect(leafWidth(dir)).toBeGreaterThan(118)
    expect(sizeOf(dir, { pipe: 'right' }).w).toBeGreaterThanOrEqual(leafWidth(dir))
  })
})

describe('edges: routed around the boxes', () => {
  it('a segment cuts a box through its inside, never along its side', () => {
    const r = { x0: 0, y0: 0, x1: 10, y1: 10 }
    expect(cuts({ x: -5, y: 5 }, { x: 15, y: 5 }, r)).toBe(true)
    expect(cuts({ x: -5, y: -5 }, { x: 15, y: 15 }, r)).toBe(true)
    expect(cuts({ x: -5, y: 0 }, { x: 15, y: 0 }, r)).toBe(false)
    expect(cuts({ x: 10, y: -5 }, { x: 10, y: 15 }, r)).toBe(false)
    expect(cuts({ x: -5, y: 20 }, { x: 15, y: 20 }, r)).toBe(false)
  })
  it('the crossing check can fail (planted: the straight line between two real boxes, through a third laid out between them)', async () => {
    // derived from the laid-out boxes, never a fixed pair or coordinate (B-0321: a fixed pair
    // stopped crossing anything when the boxes around it grew): search the System
    // view for two leaf boxes whose straight line, port to facing port (the old drawing), cuts a
    // THIRD leaf box; the check must name it (red), and the router must take the same edge round it (green)
    const g = await readMap()
    const v = view(g, 'system')
    const l = await layoutView(v, { pipe: 'right' })
    const rects = obstacles(v.nodes, l)
    const leaves = v.nodes.filter(n => n.kind !== 'group' && n.kind !== 'repo').map(n => l.nodes.get(n.id)!)
    const leafIds = new Set(leaves.map(p => p.id))
    let planted: { e: RouteIn; hit: string[] } | null = null
    search: for (const a of leaves) for (const b of leaves) {
      if (a === b) continue
      const sd = sides(a, b)
      const e: RouteIn = { id: 'e/planted', source: a.id, target: b.id }
      const hit = crossings([port(a, sd.from), port(b, sd.to)], e, rects, l).filter(id => leafIds.has(id) && id !== a.id && id !== b.id)
      if (!hit.length) continue
      const r = routeEdges(v.nodes, l, [e]).get(e.id)
      if (r && crossings(r.points, e, rects, l).length === 0) { planted = { e, hit }; break search }
    }
    expect(planted, 'no two boxes of the real layout have a third between them').not.toBeNull()
    expect(planted!.hit.length).toBeGreaterThan(0)
  })
  it('no edge of the real tree passes through a box but its own ends and the groups holding them', async () => {
    const g = await readMap()
    for (const v of g.views) for (const pipe of ['right', 'down'] as const) {
      const l = await layoutView(v, { pipe })
      const ins = drawable(v, pipe)
      const routes = routeEdges(v.nodes, l, ins)
      const rects = obstacles(v.nodes, l)
      for (const e of ins) {
        const r = routes.get(e.id)
        expect(r, `${v.id}/${pipe}: ${e.id} has no route`).toBeDefined()
        expect(crossings(r!.points, e, rects, l), `${v.id}/${pipe}: ${e.id}`).toEqual([])
        // square: every run level or plumb
        for (let k = 1; k < r!.points.length; k++) expect(r!.points[k].x === r!.points[k - 1].x || r!.points[k].y === r!.points[k - 1].y, e.id).toBe(true)
      }
    }
  })
  it('routes a fixture and keeps the loop on the side it is asked for', async () => {
    const g = buildMap(input())
    for (const v of g.views) {
      const l = await layoutView(v, { pipe: 'right' })
      const ins = drawable(v, 'right')
      const routes = routeEdges(v.nodes, l, ins)
      for (const e of ins) expect(crossings(routes.get(e.id)!.points, e, obstacles(v.nodes, l), l), e.id).toEqual([])
      const loop = routes.get('e/loop')
      if (v.id === 'pipeline') expect(loop && [loop.from, loop.to]).toEqual(['b', 'b'])
    }
  })
})
