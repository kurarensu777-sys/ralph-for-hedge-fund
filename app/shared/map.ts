// THE MAP (B-0207): the fund as a graph, generated from the files by GET /api/map. Four views on
// one canvas - Repos (every repo, its remote, its top-level folders, its build worktrees, the agents
// whose writes cover them), System (what connects to what, what runs), Pipeline (the trading
// chain, app/library/law/the-atlas/pipeline.json) and Data (how a read gets from a source to a
// notebook, an agent or a dashboard, and what is kept: app/library/law/the-atlas/data-flow.json). The server builds the nodes and edges; the UI
// lays them out (ELK) and draws them (React Flow). Overlays that move by the minute (a dashboard
// running) are read by the UI from their own rooms' routes, never baked in here.

export const MAP_VIEWS = ['repos', 'system', 'pipeline', 'data'] as const
export type MapViewId = typeof MAP_VIEWS[number]

/** how a group lays out its children: `right` / `down` = layered (ELK) along the edges between them,
 *  `grid` = packed in columns (children with no edges between them), `stack` = one column, `row` = one
 *  line in the order given (the GitHub remotes, under their repos) */
export type MapLayout = 'right' | 'down' | 'grid' | 'stack' | 'row'

/** a node's standing. ok/warn/fail/off/unknown are measured or derived states; the rest are the
 *  pipeline's and the registry's own words, drawn in their own style (never as a health colour) */
export type MapState =
  | 'ok' | 'warn' | 'fail' | 'off' | 'unknown'
  | 'live' | 'human' | 'scaffold' | 'missing' | 'external' | 'guarded' | 'building' | 'planned' | 'archived'

export type MapCommit = { sha: string; subject: string; ts: number; repo: string }
export type MapCheck = { label: string; state: 'ok' | 'fail' | 'unknown' | 'info'; detail?: string }
export type MapBoard = { id: string; title: string; status: string }

export type MapNode = {
  /** `<kind>/<name>`, readable in a deep link: repo/app, dir/app/server, dash/carry, stage/risk */
  id: string
  kind: 'group' | 'repo' | 'dir' | 'files' | 'worktree' | 'remote' | 'agent' | 'dashboard' | 'container' | 'external' | 'stage'
  /** the short name the box carries; never cut, and unique among the view's nodes of its kind */
  label: string
  /** the full name, when the label is a short form of it: the tooltip and the drawer carry it */
  title?: string
  /** up to two short lines under the label */
  sub?: string[]
  /** the group this node sits in (a `group` or `repo` node) */
  parent?: string
  /** a group's child layout */
  layout?: MapLayout
  /** the agent whose writes cover it (the category colour) */
  owner?: string
  /** other agents writing inside it */
  also?: string[]
  path?: string
  port?: number
  state?: MapState
  /** why the state is what it is (the tooltip) */
  why?: string
  /** a dashboard's registry id, so the UI can join /api/dash */
  dashboard?: string
  /** drawer rows: [key, value] */
  facts?: [string, string][]
  checks?: MapCheck[]
  /** books on a shelf (clickable into the Library) */
  books?: string[]
  /** the law files beside it (CLAUDE.md), shown as paths */
  law?: string[]
  board?: MapBoard[]
  commit?: MapCommit | null
  /** a pipeline stage: its number and the short list it holds */
  n?: number
  holds?: string[]
}

export type MapEdge = {
  id: string
  source: string
  target: string
  kind: 'writes' | 'remote' | 'uses' | 'flow' | 'loop' | 'guarded'
  label?: string
  /** drawn only when this overlay is on */
  overlay?: 'owners'
}

/** `layout` = how the view's top-level nodes lay out (the UI may turn the pipeline down on a narrow canvas) */
export type MapView = { id: MapViewId; label: string; layout: MapLayout; nodes: MapNode[]; edges: MapEdge[]; error?: string }
export type MapGraph = { at: number; views: MapView[]; problems: { path: string; error: string }[] }
