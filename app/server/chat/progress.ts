import type { ChatMeta, Entry } from './types.ts'

// A TURN'S PROGRESS, one per conversation: what the light in its tab reads. Measured only from what
// the agent itself said in THIS turn: its latest todo list (done of total, the item in progress) and
// whether the turn is still open. No list = nothing to divide by: `total` is absent and the tab
// sweeps, never an invented percentage. Pure; the runner keeps one per hand (progressList()).

export type ProgressKind = 'work' | 'ask' | 'done' | 'open' | 'stop' | 'fail'
export type Progress = {
  kind: ProgressKind
  /** both or neither: the agent's own todo list in this turn */
  done?: number
  total?: number
  /** top-level tool calls this turn */
  steps: number
  /** the item in progress, else the newest step; '' when the turn is not running */
  now: string
  /** the message that opened the turn */
  since: number
  /** the newest entry of the turn: for an ended turn, when it ended */
  at: number
}

/** a system line that says the turn was cut short (runner.stop / close / PROCESS_CUT) */
const STOPPED = /^(Interrupted|Stopped\b|The agent process ended)/

export function progressOf(ring: Entry[], meta: Pick<ChatMeta, 'busy' | 'waiting'>): Progress | null {
  let start = -1
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].kind === 'user' && !ring[i].nested) { start = i; break }
  const open = meta.busy || meta.waiting
  if (start < 0 && !open) return null
  const turn = ring.slice(start + 1).filter(e => !e.nested)
  const since = start >= 0 ? ring[start].ts : turn[0]?.ts ?? 0
  const at = turn.length ? turn[turn.length - 1].ts : since
  const tools = turn.filter(e => e.kind === 'tool')
  let todos: NonNullable<NonNullable<Entry['action']>['todos']> | undefined
  for (let i = turn.length - 1; i >= 0; i--) { const t = turn[i].action?.type === 'todo' ? turn[i].action?.todos : undefined; if (t?.length) { todos = t; break } }
  const list = todos ? { done: todos.filter(t => t.status === 'completed').length, total: todos.length } : {}

  let kind: ProgressKind
  if (meta.waiting) kind = 'ask'
  else if (meta.busy) kind = 'work'
  else if (!turn.length) return null
  else if (turn.some(e => e.kind === 'system' && STOPPED.test(e.content))) kind = 'stop'
  else if (endedOnError(turn)) kind = 'fail'
  else kind = todos && list.done! < list.total! ? 'open' : 'done'

  let now = ''
  if (kind === 'work') {
    const cur = todos?.find(t => t.status === 'in_progress')
    const last = tools[tools.length - 1]
    now = cur ? cur.active || cur.text : last ? [last.action?.verb, last.action?.target].filter(Boolean).join(' ') : ''
  }
  return { kind, ...list, steps: tools.length, now, since, at }
}

/** the newest said-thing of the turn (assistant or error) decides, as runner.turnFailed does */
function endedOnError(turn: Entry[]): boolean {
  for (let i = turn.length - 1; i >= 0; i--) {
    const e = turn[i]
    if (e.streaming || !(e.kind === 'assistant' || e.kind === 'error')) continue
    return e.kind === 'error'
  }
  return false
}
