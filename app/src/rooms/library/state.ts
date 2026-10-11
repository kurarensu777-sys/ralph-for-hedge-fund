import { CATEGORIES } from '../../ui/categories.ts'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { api } from '../../lib/api.ts'
import type { RoomId } from '../../shell/nav.tsx'

/** Room-local state shared by Head, Explorer and Main (they are separate components). */
export type View = 'shelves' | 'agents' | 'readers' | 'retire' | 'drafts' | 'links'
/** need: who must read it (derived: boot lists, Recall rows); read: what the read ledger saw */
export type Need = '' | 'boot' | 'recall' | 'must' | 'opt'
export type Read = '' | 'p30' | 'b30' | 'never'
/** type: what a book is (its `type:` frontmatter): guides and strategies; '' = all */
export type Kind = '' | 'guide' | 'strategy'
/**
 * text = the filter searches book BODIES (server index). The facets: topics = `<shelf>/<topic>` keys
 * (`<shelf>/-` = untagged), OR among them; who = the agent lens (only what it boots with, is sent to by
 * a Recall row, or pulled); need, read; type; hide = books outside the filter leave the wall (default: fade).
 * agent = whose boot list the Agents view shows (a different thing from the lens).
 */
type State = {
  view: View; shelf: string | null; agent: string | null; q: string; text: boolean
  topics: string[]; who: string | null; need: Need; read: Read; type: Kind; hide: boolean
}

const KEY = 'fundos.library'
const PERSIST: (keyof State)[] = ['view', 'shelf', 'agent', 'text', 'topics', 'who', 'need', 'read', 'type', 'hide']
let state: State = (() => {
  const base: State = { view: 'shelves', shelf: null, agent: null, q: '', text: false, topics: [], who: null, need: '', read: '', type: '', hide: false }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const s: State = { ...base, ...saved, q: '' }
    if ((s.view as string) === 'matrix') s.view = 'readers'   // the Matrix grid became the Readers list (2026-09-26)
    if (saved.never) s.read = 'never'
    if (!Array.isArray(s.topics)) s.topics = []
    if (s.type !== 'guide' && s.type !== 'strategy') s.type = ''
    return s
  } catch { return base }
})()
const subs = new Set<() => void>()

export function setLib(patch: Partial<State>) {
  state = { ...state, ...patch }
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(PERSIST.map(k => [k, state[k]])))) } catch { /* private window */ }
  subs.forEach(f => f())
}

/** the facets a filter line shows and Clear resets (the search text included) */
export const clearFilters = () => setLib({ shelf: null, topics: [], who: null, need: '', read: '', type: '', q: '' })

export function useLib(): State {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => state)
}

/** the shell's go(), captured by the room's badge hook (always mounted) so palette items can navigate */
let goRef: ((room: RoomId, select?: string | null) => void) | null = null
export function setGo(go: typeof goRef) { goRef = go }
export function navGo(room: RoomId, select?: string | null) { goRef?.(room, select) }

/**
 * Boot-list toggles with optimistic state: `pending` overrides the server's answer until the
 * refetched agents list agrees with it (then `settle` drops the override).
 */
export function useBootToggle(onFail: (msg: string) => void) {
  const [pending, setPending] = useState<Record<string, boolean>>({})
  const toggle = useCallback(async (agent: string, path: string, on: boolean) => {
    const k = `${agent}|${path}`
    setPending(p => ({ ...p, [k]: on }))
    try {
      await api('/api/library/boot', { method: 'PATCH', body: { agent, path, on } })
    } catch (e: any) {
      setPending(p => { const n = { ...p }; delete n[k]; return n })
      onFail(`boot ${on ? 'add' : 'remove'} failed: ${e.message ?? e}`)
    }
  }, [onFail])
  const settle = useCallback((truth: (agent: string, path: string) => boolean) => {
    setPending(p => {
      const keys = Object.keys(p).filter(k => { const [a, ...rest] = k.split('|'); return truth(a, rest.join('|')) === p[k] })
      if (!keys.length) return p
      const n = { ...p }
      for (const k of keys) delete n[k]
      return n
    })
  }, [])
  return { pending, toggle, settle }
}

export const fmtTok = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)

/** muted spine colours, by shelf order; a shelf keeps its colour everywhere in the room */
const TONES = ['#8a6a48', '#4e6f6a', '#56638a', '#74597d', '#8b7446', '#687050', '#7d5a52', '#5f7488', '#7a6b5a']
export function toneFor(shelfIds: string[], id: string): string {
  // a shelf named after an agent category wears that category's colour (src/ui/categories.ts),
  // so fund / app / platform / dashboards read the same here as in Chats and Board
  const cat = (CATEGORIES as Record<string, { color: string }>)[id]
  if (cat) return cat.color
  const i = shelfIds.indexOf(id)
  return TONES[(i < 0 ? 0 : i) % TONES.length]
}

/** a book no agent has pulled or booted with, as far as the reads table knows */
export const neverRead = (u?: { last: number | null; lastBoot: number | null }) => !!u && u.last === null && u.lastBoot === null
