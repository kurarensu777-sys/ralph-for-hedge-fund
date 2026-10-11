// THE PERMITTED MODELS: what Claude Code itself says this account may run, read live from the Agent
// SDK (`Query.supportedModels()`, server/chat/models.ts) - never a list typed here. Each row is keyed
// by its EXACT id (the SDK's `resolvedModel`, e.g. `claude-opus-5-5[1m]`), never by the alias the SDK
// offers it under (`opus[1m]`, `default`), because an alias moves under you when a new model ships.
// The `[1m]` suffix is part of the id: in Claude Code it selects the 1M-context window.

export type PermittedModel = {
  id: string            // the exact id to boot and to store: resolvedModel, else value
  aliases: string[]     // every SDK `value` that resolves to it ('default', 'opus[1m]', ...)
  name: string          // the SDK's own words: "Opus 5.5 with 1M context"
  description: string
  efforts: string[]     // the effort levels this model takes; [] = it takes none (Haiku 4.5)
}

export type PermittedRead = {
  models: PermittedModel[]
  at: number | null     // when Claude Code was last asked; null = never answered
  error: string | null  // why the last read failed (the list may then be an older good read, or empty)
}

/** an exact model id: claude-<family>-<version>[-<date>], optionally [1m]; never an alias */
export const EXACT_ID = /^claude-[a-z]+(-[0-9]+)+(\[1m\])?$/

/** "claude-opus-5-5[1m]: Opus 5.5 with 1M context" for a title; an id not on the list says so */
export function modelTitle(models: readonly PermittedModel[] | undefined, id: string): string {
  const m = models?.find(x => x.id === id)
  return m ? `${m.id}: ${m.name}` : models?.length ? `${id} (not on Claude Code's permitted list)` : id
}
