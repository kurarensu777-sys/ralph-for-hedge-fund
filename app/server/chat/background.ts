// BACKGROUND WORK a conversation's process holds between turns (B-0254). A chat that has finished its
// turn can still be waiting on something its OWN process owns: a background command or subagent, a
// watcher, a scheduled wake-up or cron. None of it survives the process, so a fundd restart that sees
// only "no turn running" kills it and the agent never hears back. Two signals from the CLI:
//   background_tasks_changed  a LEVEL message, the full set of live background tasks (replace, never
//                             pair edges; `ambient` = a watcher, not activity) - runner.ts feeds it
//   the Stop hook's session_crons   the wake-ups and crons that will wake this session later, read at
//                             each turn's end (launch.ts seatHooks) - nothing else reports them
// Both are per PROCESS: a new process starts empty (clear()).

export type BgTask = { id: string; type: string; description: string; ambient: boolean }
export type BgCron = { id: string; schedule: string; recurring: boolean; prompt: string }

const BG = new Map<string, { tasks: BgTask[]; crons: BgCron[] }>()
const listeners: ((id: string) => void)[] = []
const clip = (t: unknown, n = 70) => { const s = String(t ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''; return s.length > n ? `${s.slice(0, n - 3)}...` : s }

function entry(id: string) {
  let e = BG.get(id)
  if (!e) BG.set(id, e = { tasks: [], crons: [] })
  return e
}
function changed(id: string) { for (const f of listeners) { try { f(id) } catch { /* a listener never breaks the runner */ } } }

/** call fn(conversation id) whenever a conversation's background work changes */
export function onBgChange(fn: (id: string) => void) { listeners.push(fn) }

/** a background_tasks_changed payload: REPLACES the conversation's tasks */
export function setTasks(id: string, raw: unknown) {
  const tasks = (Array.isArray(raw) ? raw : []).filter(t => t && typeof t === 'object').map((t: any) => ({
    id: String(t.task_id ?? t.id ?? ''), type: String(t.task_type ?? t.type ?? 'task'), description: String(t.description ?? ''), ambient: t.ambient === true,
  }))
  entry(id).tasks = tasks
  changed(id)
}

/** the Stop hook's session_crons: REPLACES the conversation's wake-ups and crons */
export function setCrons(id: string, raw: unknown) {
  const crons = (Array.isArray(raw) ? raw : []).filter(c => c && typeof c === 'object').map((c: any) => ({
    id: String(c.id ?? ''), schedule: String(c.schedule ?? ''), recurring: c.recurring === true, prompt: String(c.prompt ?? ''),
  }))
  entry(id).crons = crons
  changed(id)
}

/** does this conversation's process hold a live background task with this id? */
export const holds = (id: string, taskId: string) => !!BG.get(id)?.tasks.some(t => t.id === taskId)

/** a new process for this conversation: nothing it holds yet */
export function clear(id: string) {
  if (!BG.has(id)) return
  BG.delete(id)
  changed(id)
}

/**
 * the conversation's background work as labels: `tasks` holds a restart (a command or a subagent is
 * working and will report back), `later` does not (a watcher, a wake-up, a cron: waiting, possibly for ever)
 */
export function bgOf(id: string): { tasks: string[]; later: string[] } {
  const e = BG.get(id)
  if (!e) return { tasks: [], later: [] }
  const label = (t: BgTask) => `${t.type}${t.description ? ` "${clip(t.description)}"` : ''}`
  return {
    tasks: e.tasks.filter(t => !t.ambient).map(label),
    later: [
      ...e.tasks.filter(t => t.ambient).map(label),
      ...e.crons.map(c => `${c.recurring ? 'cron' : 'wake-up'} ${c.schedule}${c.prompt ? ` "${clip(c.prompt)}"` : ''}`),
    ],
  }
}
