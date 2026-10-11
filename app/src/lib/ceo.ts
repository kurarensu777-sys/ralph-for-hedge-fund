import { parseQuickAdd, type CeoListed, type ChatState } from '../../shared/ceo.ts'
import { api, useApi } from './api.ts'
import type { Nav } from '../shell/nav.tsx'

// The CEO board's reads and its one action, shared by the Board lane and the rail dock. The
// issue's chat is ONE conversation: the server starts it the first time and answers the same id
// after (server/rooms/board.ts), so Open can never make a second.

export const useCeoItems = () => useApi<{ items: CeoListed[] }>('/api/board/ceo', ['board'])

type ChatLite = { id: string; state: 'live' | 'waiting' | 'idle' | 'closed' }
/** every conversation's live state, one fetch (refreshed on the chat topic) */
export const useChatList = () => useApi<{ conversations: ChatLite[] }>('/api/chats?limit=1000', ['chat'])

/** an issue's chat state; null when it has no chat, or the list has not named it (never a guessed idle) */
export function chatStateOf(i: Pick<CeoListed, 'conversation'>, list: ChatLite[] | null | undefined): ChatState {
  if (!i.conversation || !list) return null
  const c = list.find(x => x.id === i.conversation)
  return c ? c.state : null
}

export const stateWord = (s: ChatState): string => s === 'waiting' ? 'waiting on you' : s === 'live' ? 'working' : s === 'idle' ? 'idle' : s === 'closed' ? 'closed' : 'state unknown'

/** file one issue from a quick-add line (the lane's and the dock's): the picked agent, or the one the line names
 *  with "@agent". True when it was filed; an empty line files nothing. */
export async function fileCeo(nav: Pick<Nav, 'toast'>, text: string, agents: string[], pick: string, setPick: (v: string) => void): Promise<boolean> {
  const q = parseQuickAdd(text, agents, pick)
  if (!q) return false
  try {
    await api('/api/board/ceo', { body: { title: q.title, agent: q.agent } })
    if (q.named) setPick(q.agent)
    return true
  } catch (e: any) { nav.toast(e.message, true); return false }
}

/** open the issue's chat: the first press starts it (with `agent` when the issue has none yet). A chat that no
 *  longer exists is replaced by a fresh one, the old id kept in the issue's notes. */
export async function openCeoChat(nav: Pick<Nav, 'go' | 'toast'>, id: string, agent?: string): Promise<void> {
  const call = (body: Record<string, unknown>) => api<{ conversation: string; started: boolean }>(`/api/board/ceo/${id}/chat`, { body })
  try {
    let r
    try { r = await call(agent ? { agent } : {}) } catch (e: any) {
      if (e.status !== 410) throw e
      r = await call({ fresh: true })
      nav.toast(`${id}: its old chat was gone; started a new one`)
    }
    nav.go('chats', r.conversation)
  } catch (e: any) { nav.toast(`${id}: ${e.message}`, true) }
}
