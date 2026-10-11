// DESKTOP NOTIFICATIONS for the chats room. The server publishes on the `chat` list topic
// `{id, state: 'waiting', agent, note}` when a conversation parks on the owner and
// `{id, turn: 'done', agent, note}` when a turn ends (server/chat/runner.ts). While the tab is
// hidden and the owner has switched the bell on, each becomes one browser Notification:
// title = the agent, body = the first line. Pure decision here; the browser call in index.tsx.

export type ChatEvent = { id?: string; state?: string; turn?: string; agent?: string; note?: string; reverted?: number }
export type Note = { tag: string; title: string; body: string; conv: string }

/** what (if anything) to raise for one `chat` event */
export function noteFor(d: ChatEvent | null | undefined, o: { hidden: boolean; on: boolean; permission: string }): Note | null {
  if (!d || typeof d.id !== 'string' || !o.hidden || !o.on || o.permission !== 'granted') return null
  const kind = d.state === 'waiting' ? 'waiting' : d.turn === 'done' ? 'done' : null
  if (!kind) return null
  const body = (d.note ?? '').trim() || (kind === 'waiting' ? 'waiting on you' : 'turn finished')
  return { tag: `chat:${d.id}:${kind}`, title: d.agent || 'agent', body: body.slice(0, 160), conv: d.id }
}

/** a tag seen within `ms` is a repeat (the same event can arrive twice across a reconnect) */
export function makeDedupe(ms = 4000) {
  const seen = new Map<string, number>()
  return (tag: string, now = Date.now()): boolean => {
    const t = seen.get(tag)
    seen.set(tag, now)
    for (const [k, v] of seen) if (now - v > ms * 10) seen.delete(k)
    return t !== undefined && now - t < ms
  }
}

/** the bell's three honest looks: unsupported by this browser, blocked by the owner, or a pref */
export type Bell = 'unsupported' | 'denied' | 'on' | 'off'
export function bellState(supported: boolean, permission: string, on: boolean): Bell {
  if (!supported) return 'unsupported'
  if (permission === 'denied') return 'denied'
  return on && permission === 'granted' ? 'on' : 'off'
}

export const LESSON_PROMPT = 'Debrief: file what you learned this session as a book + its moment-line (library/...), or say there is nothing to file.'

/** what the Wrap press types: the `debrief` skill's own fire phrase (the skill and its books carry
 *  the method), plus the owner's two asks of a close - a summary, and the strategy's book brought up
 *  to date. It must stay a phrase server/library/drafts.ts WRAP reads as a wrap, or a wrapped
 *  conversation is drafted again (test/chats-notify.test.ts) */
export const WRAP_PROMPT = "That's a wrap - debrief this conversation: summarise what we did and decided, then file whatever it changed about a strategy into that strategy's book, or say there is nothing to file."
