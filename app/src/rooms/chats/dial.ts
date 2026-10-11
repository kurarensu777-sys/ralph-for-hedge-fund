import { engineOf, nearestEffort, type EngineId, type ProviderRead } from '../../../shared/engines.ts'
import type { PermittedModel } from '../../../shared/models.ts'

// THE DIAL: which provider, model and effort a conversation holds, read from what the providers offer. Pure, so the
// rules the three pills follow (a provider pick lands on that provider's model; an effort off the model's ladder shows
// the rung it lands on) are tested without a browser.

export type Dial = {
  engine: EngineId
  provider: ProviderRead | undefined
  /** the row the running model id names (an alias a stored conversation still holds resolves through `aliases`) */
  model: PermittedModel | undefined
  running: string
  /** the effort ladder of the running model: null = not known (the list has not loaded), [] = it takes none */
  ladder: string[] | null
  /** the effort the conversation will run at: the override or the roster's, landed on the ladder */
  effort: string
}

export function dialOf(providers: readonly ProviderRead[] | undefined, running: string, effort: string | null | undefined, agentEffort: string | undefined): Dial {
  const engine = engineOf(running)
  const provider = providers?.find(p => p.id === engine)
  const model = provider?.read.models.find(m => m.id === running || m.aliases.includes(running))
  const ladder = model ? model.efforts : null
  const want = effort || agentEffort || ''
  return { engine, provider, model, running, ladder, effort: ladder ? nearestEffort(ladder, want) : want }
}

/** what a provider pick sends: null = the roster's own model (when that is already this provider's), else the provider's first row;
 *  undefined = the provider has no row to land on (the pill refuses) */
export function landOnProvider(providers: readonly ProviderRead[], id: EngineId, agentModel: string): string | null | undefined {
  const p = providers.find(x => x.id === id)
  if (!p) return undefined
  if (engineOf(agentModel) === id) return null
  return p.read.models[0]?.id
}

/** the model pick as sent: choosing the roster's own model clears the override */
export const landOnModel = (id: string, agentModel: string): string | null => (id === agentModel ? null : id)

/** a provider row the owner may press: one that cannot run here (no key, no CLI) is listed, with why, and refused */
export const pressable = (p: ProviderRead): boolean => p.state === 'ready' || p.state === 'unread'

/** the short words for an effort rung */
export const EFFORT_LABEL: Record<string, string> = { ultra: 'ultra', max: 'max', xhigh: 'xhigh', high: 'high', medium: 'medium', low: 'low', minimal: 'minimal', none: 'none' }
