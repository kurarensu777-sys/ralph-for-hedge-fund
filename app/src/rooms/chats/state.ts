import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, useTopic } from '../../lib/api.ts'
import { markSeen, type Seen } from './mark.ts'

// Client state of the chats room that BOTH the explorer and the main area read: the open panes
// and the unsent drafts. A module store (localStorage-backed) rather than useStored, because two
// useStored instances of one key do not see each other's writes.

export type Pane = { kind: 'chat'; id: string } | { kind: 'term'; id: string }
export const paneKey = (p: Pane) => (p.kind === 'term' ? `term:${p.id}` : p.id)
export const keyToPane = (k: string): Pane => (k.startsWith('term:') ? { kind: 'term', id: k.slice(5) } : { kind: 'chat', id: k })

function store<T>(key: string, initial: T) {
  let value: T = initial
  try { const raw = localStorage.getItem('fundos.' + key); if (raw !== null) value = JSON.parse(raw) } catch { /* private window */ }
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set: (next: T) => {
      value = next
      try { localStorage.setItem('fundos.' + key, JSON.stringify(next)) } catch { /* private window */ }
      subs.forEach(f => f())
    },
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f) } },
  }
}

const panes = store<string[]>('chats.panes', [])
const drafts = store<Record<string, string>>('chats.drafts', {})

export function usePanes(): [string[], { open: (k: string) => void; close: (k: string) => string | null }] {
  const v = useSyncExternalStore(panes.subscribe, panes.get)
  const open = useCallback((k: string) => { if (!panes.get().includes(k)) panes.set([...panes.get(), k]) }, [])
  const close = useCallback((k: string) => {
    const cur = panes.get()
    const i = cur.indexOf(k)
    const next = cur.filter(x => x !== k)
    panes.set(next)
    return next[Math.min(i, next.length - 1)] ?? null
  }, [])
  return [v, { open, close }]
}

// the bell (desktop notifications) - read by the room head AND the always-mounted badge hook
const bell = store<boolean>('chats.notify', false)
export function useBellPref(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(bell.subscribe, bell.get), bell.set]
}
export const bellOn = () => bell.get()

// what the owner has seen: the row marks' "unread" reads it (mark.ts). The first ever look sets
// the base to now, so nothing older than the first visit reads unread
const seenStore = store<Seen>('chats.seen', { base: 0, at: {} })
if (!seenStore.get().base) seenStore.set({ base: Date.now(), at: seenStore.get().at ?? {} })
export function useSeen(): Seen { return useSyncExternalStore(seenStore.subscribe, seenStore.get) }
export function noteSeen(id: string, lastAt: number) {
  const cur = seenStore.get()
  const next = markSeen(cur, id, lastAt)
  if (next !== cur) seenStore.set(next)
}

// is this browser tab being looked at: visible AND the window focused (B-0253). Read live from the
// document on every visibilitychange / focus / blur; the room and pane halves are mark.ts Look
function lookSub(f: () => void) {
  document.addEventListener('visibilitychange', f)
  window.addEventListener('focus', f)
  window.addEventListener('blur', f)
  return () => { document.removeEventListener('visibilitychange', f); window.removeEventListener('focus', f); window.removeEventListener('blur', f) }
}
export function useLooking(): { visible: boolean; focused: boolean } {
  const visible = useSyncExternalStore(lookSub, () => document.visibilityState === 'visible')
  const focused = useSyncExternalStore(lookSub, () => document.hasFocus())
  return { visible, focused }
}

export function useDrafts(): Record<string, string> { return useSyncExternalStore(drafts.subscribe, drafts.get) }
export function setDraft(id: string, text: string) {
  const cur = drafts.get()
  if ((cur[id] ?? '') === text) return
  const next = { ...cur }
  if (text.trim()) next[id] = text; else delete next[id]
  drafts.set(next)
}
export const getDraft = (id: string) => drafts.get()[id] ?? ''

/**
 * GET a path and refetch ONLY when the list-level topic `chat` fires. useApi(path, ['chat']) would
 * also refetch on every `chat:<id>` feed delta (prefix match), which is a refetch per streamed token.
 */
export function useChatsApi<T>(path: string | null): { data: T | null; error: string | null; reload: () => void } {
  const [s, setS] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  const seq = useRef(0)
  const load = useCallback(() => {
    if (!path) return
    const n = ++seq.current
    api<T>(path).then(data => { if (n === seq.current) setS({ data, error: null }) })
      .catch(e => { if (n === seq.current) setS(p => ({ data: p.data, error: String(e.message ?? e) })) })
  }, [path])
  useEffect(() => { setS({ data: null, error: null }); load() }, [load])
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useTopic('chat', (_d, topic) => {
    if (topic !== 'chat') return
    if (t.current) clearTimeout(t.current)
    t.current = setTimeout(load, 200)
  })
  useTopic('config', () => load())
  return { ...s, reload: load }
}
