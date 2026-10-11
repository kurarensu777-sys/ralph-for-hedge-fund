import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

// THE ENGINE SEAM. runner.ts held the Agent SDK's `Query` as "the hand", so "the chat engine" and "Claude Code"
// were one word. A hand is the five things the runner's loop and routes touch on a live conversation; the SDK's
// Query satisfies it natively, a DeepSeek hand IS a Query (the same SDK pointed at another endpoint), and a CLI
// engine (Codex, Grok) satisfies it through an adapter that translates its stream INTO SDK-shaped messages, so
// normalize.ts stays the single mapper from a message to a feed row.
export type ContextUse = { percentage: number; totalTokens: number; maxTokens: number }

export type EngineHand = AsyncIterable<SDKMessage> & {
  getContextUsage(o?: unknown): Promise<ContextUse>
  setModel(model?: string): Promise<void>
  interrupt(): Promise<unknown>
  stopTask(id: string): Promise<void>
}

/** a hand that runs one CLI process per turn (foreign.ts): what the runner also reads off it */
export type ForeignHand = EngineHand & {
  /** the CLI's own thread/session id: what resume takes; null until its first turn reports one */
  sessionId(): string | null
}
