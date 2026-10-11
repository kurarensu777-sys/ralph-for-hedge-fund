import type { PermittedRead } from './models.ts'

// THE ENGINES a conversation can run on. A model id keeps its engine as a prefix (`grok:grok-4.7`,
// `codex:gpt-5.5`, `deepseek:deepseek-v4-pro`); a bare id is Claude, so every id already stored
// (conversations.model, a roster file, a job) stays valid and routed without a migration. The
// prefix is parsed here and nowhere else.

export type EngineId = 'claude' | 'codex' | 'deepseek' | 'grok'
export const ENGINES: readonly EngineId[] = ['claude', 'codex', 'deepseek', 'grok']

export const ENGINE_LABEL: Record<EngineId, string> = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek', grok: 'Grok' }

export const engineOf = (modelId: string | null | undefined): EngineId => {
  const s = String(modelId ?? '')
  const cut = s.indexOf(':')
  const head = cut < 0 ? '' : s.slice(0, cut)
  return (ENGINES as readonly string[]).includes(head) && head !== 'claude' ? (head as EngineId) : 'claude'
}
/** the id the engine's own CLI or API expects: the routing prefix taken back off */
export const bareModel = (modelId: string): string => {
  const e = engineOf(modelId)
  return e === 'claude' ? modelId : modelId.slice(e.length + 1)
}
export const dialId = (engine: EngineId, bare: string): string => (engine === 'claude' ? bare : `${engine}:${bare}`)

/** What each engine can honour. Rendered, not just branched on: a control that silently drops plan mode on
 *  Codex would be a screen that lies about what the press did. */
export type EngineCaps = {
  planMode: boolean       // the plan card (ExitPlanMode) waits on the owner
  decisions: boolean      // AskUserQuestion cards park the turn on the owner
  liveSwap: boolean       // a model change lands inside the running process (otherwise: the hand reboots)
  contextGauge: boolean   // the engine reports how full the window is
  images: boolean         // a pasted picture reaches the model
  stopTasks: boolean      // one background task can be stopped on its own
  compact: boolean        // the owner can compact the context on demand (/compact)
}
export const CAPS: Record<EngineId, EngineCaps> = {
  claude: { planMode: true, decisions: true, liveSwap: true, contextGauge: true, images: true, stopTasks: true, compact: true },
  // the same hand as Claude pointed at DeepSeek's endpoint, fixed at spawn: no live swap to or from it
  deepseek: { planMode: true, decisions: true, liveSwap: false, contextGauge: true, images: true, stopTasks: true, compact: true },
  codex: { planMode: false, decisions: false, liveSwap: false, contextGauge: true, images: false, stopTasks: false, compact: false },
  grok: { planMode: false, decisions: false, liveSwap: false, contextGauge: true, images: false, stopTasks: false, compact: false },
}

/** the sentence a pill's tooltip says about what an engine cannot do (empty when it can do all) */
export function capsNote(e: EngineId): string {
  const c = CAPS[e]
  const no = [!c.planMode && 'plan mode', !c.decisions && 'decision cards', !c.images && 'pasted images', !c.stopTasks && 'stopping one background task', !c.compact && 'compact on demand', !c.liveSwap && 'a live model swap (the hand reboots)', !c.contextGauge && 'a context gauge']
    .filter((x): x is string => !!x)
  return no.length ? `${ENGINE_LABEL[e]} has no ${no.join(', ')}` : ''
}

/** a provider the chat box offers: its models as the same PermittedRead shape, plus whether it can run here */
export type ProviderState = 'ready' | 'no-key' | 'no-cli' | 'unread'
export type ProviderRead = {
  id: EngineId
  name: string
  state: ProviderState
  /** what is missing or why the list is short, in words ("DEEPSEEK_API_KEY is not set ..."); null when ready */
  note: string | null
  /** where the rows came from: 'claude-code' | 'api' | 'declared <date>' | 'host file' */
  source: string
  read: PermittedRead
}

// Every effort token any provider uses, strongest first: ordering is decided once, here.
export const EFFORT_ORDER = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'] as const
const RANK = new Map<string, number>(EFFORT_ORDER.map((e, i) => [e, i]))
export const sortEfforts = (ids: readonly string[]): string[] => [...new Set(ids)].sort((a, b) => (RANK.get(a) ?? 99) - (RANK.get(b) ?? 99))

/** the rung to land on when the chosen one is not on the model's ladder: the nearest at or below it, else the weakest.
 *  '' when the model takes no effort. */
export function nearestEffort(ladder: readonly string[], want: string): string {
  if (!ladder.length) return ''
  if (ladder.includes(want)) return want
  const w = RANK.get(want) ?? 99
  const sorted = sortEfforts(ladder)
  return sorted.find(e => (RANK.get(e) ?? 99) >= w) ?? sorted[sorted.length - 1]
}
