import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * fetch JSON from fundd; throws Error(message) on a non-2xx with the server's {error}. The whole
 * response body rides on the error as `.data` (a 400 may carry per-field `fields`), and the HTTP
 * status as `.status`.
 */
export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `${res.status} ${res.statusText}`), { data, status: res.status })
  return data as T
}

// ---- the ONE event stream, shared by every hook in the tab ----
type Listener = (data: any, topic: string) => void
const listeners = new Map<string, Set<Listener>>()
let source: EventSource | null = null
let connected = false
const connListeners = new Set<(c: boolean) => void>()

function ensureStream() {
  if (source) return
  source = new EventSource('/api/events')
  source.onopen = () => { connected = true; connListeners.forEach(f => f(true)) }
  source.onerror = () => { connected = false; connListeners.forEach(f => f(false)) }
  source.onmessage = ev => {
    let msg: { topic: string; data: unknown }
    try { msg = JSON.parse(ev.data) } catch { return }
    for (const key of [msg.topic, msg.topic.split(':')[0], '*']) listeners.get(key)?.forEach(f => f(msg.data, msg.topic))
  }
}

/** subscribe to a topic ("board", "chat:c_123", or a prefix like "chat") */
export function useTopic(topic: string | null, cb: Listener) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    if (!topic) return
    ensureStream()
    const f: Listener = (d, t) => ref.current(d, t)
    let set = listeners.get(topic)
    if (!set) listeners.set(topic, (set = new Set()))
    set.add(f)
    return () => { set!.delete(f) }
  }, [topic])
}

export function useConnected() {
  const [c, setC] = useState(connected)
  useEffect(() => { ensureStream(); connListeners.add(setC); return () => { connListeners.delete(setC) } }, [])
  return c
}

/** GETs of one path already on the wire, shared: several panes load the same path (/api/board,
 *  /api/board/agents) at mount and again on the same event, and each duplicate held one of
 *  Chrome's 6 connections per host. Every caller gets its own copy (a pane may sort in place).
 *  Only a request sent in the last SHARE_MS is joined: one sent before a change was announced must
 *  never answer a reload that the announcement asked for. */
const SHARE_MS = 100
const inflight = new Map<string, { at: number; p: Promise<unknown> }>()
function getShared<T>(path: string): Promise<T> {
  let hit = inflight.get(path)
  if (!hit || Date.now() - hit.at > SHARE_MS) {
    const p: Promise<unknown> = api(path).finally(() => { if (inflight.get(path)?.p === p) inflight.delete(path) })
    hit = { at: Date.now(), p }
    inflight.set(path, hit)
  }
  return hit.p.then(d => (d === null || typeof d !== 'object' ? d : structuredClone(d)) as T)
}

export type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** GET a path; refetch when any of `topics` fires or `path` changes. null path = idle.
 *  A topic matches exactly; end it with ':*' to also match its sub-topics ('chat:*'). */
export function useApi<T = any>(path: string | null, topics: string[] = []): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path })
  const seq = useRef(0)
  const load = useCallback(() => {
    if (!path) return
    const n = ++seq.current
    setState(s => ({ ...s, loading: true }))
    getShared<T>(path)
      .then(data => { if (n === seq.current) setState({ data, error: null, loading: false }) })
      .catch(e => { if (n === seq.current) setState(s => ({ data: s.data, error: String(e.message ?? e), loading: false })) })
  }, [path])
  useEffect(() => { setState({ data: null, error: null, loading: !!path }); load() }, [load])
  const key = topics.join('|')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const debounced = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(load, 150)
  }, [load])
  useTopic(key ? '*' : null, (_d, topic) => {
    if (topics.some(t => topic === t || (t.endsWith(':*') && topic.startsWith(t.slice(0, -1))))) debounced()
  })
  return { ...state, reload: load }
}

/** a value persisted in localStorage under fundos.<key> */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const raw = localStorage.getItem('fundos.' + key); return raw === null ? initial : JSON.parse(raw) } catch { return initial }
  })
  const set = useCallback((next: T) => {
    setV(next)
    try { localStorage.setItem('fundos.' + key, JSON.stringify(next)) } catch { /* private window */ }
  }, [key])
  return [v, set]
}

export function relTime(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined || ms === '') return '-'
  const t = typeof ms === 'string' ? Date.parse(ms) : ms
  if (!Number.isFinite(t)) return '-'
  const d = Date.now() - t
  const s = Math.round(Math.abs(d) / 1000)
  const unit = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
  return d >= 0 ? unit : `in ${unit}`
}
export { stamp, dur } from '../../shared/time.ts'
