import { useSyncExternalStore } from 'react'
import { MAP_VIEWS, type MapViewId } from '../../../shared/map.ts'

// The map room's own state, shared by its head (search, overlays) and its canvas: the search text,
// the overlays (remembered on this machine), and a focus request (Enter in the search). One tiny
// store, so the head and the canvas never hold two copies.

export type Overlays = { owners: boolean; running: boolean }
const KEY = 'fundos.map.overlays'
const readOverlays = (): Overlays => {
  try { return { owners: true, running: true, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return { owners: true, running: true } }
}

type State = { q: string; overlays: Overlays; focus: number }
let state: State = { q: '', overlays: readOverlays(), focus: 0 }
const subs = new Set<() => void>()
const set = (s: Partial<State>) => { state = { ...state, ...s }; subs.forEach(f => f()) }

export const useMap = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => state)
export const setQuery = (q: string) => set({ q })
export const askFocus = () => set({ focus: state.focus + 1 })
export function setOverlay(k: keyof Overlays, on: boolean) {
  const overlays = { ...state.overlays, [k]: on }
  try { localStorage.setItem(KEY, JSON.stringify(overlays)) } catch { /* private mode: this tab only */ }
  set({ overlays })
}

/** `#/map/<view>[/<node id>]` -> the view on screen and the node the link names */
export function targetOf(sel: string | null | undefined): { view: MapViewId; node: string | null; bad: boolean } {
  const [head, ...rest] = (sel ?? '').split('/')
  const known = (MAP_VIEWS as readonly string[]).includes(head)
  return { view: known ? head as MapViewId : 'system', node: known && rest.length ? rest.join('/') : null, bad: !!sel && !known }
}

/** a node matches the search when every word is in its label, full name, id, path, owner or sub lines */
export function matches(n: { id: string; label: string; title?: string; path?: string; owner?: string; sub?: string[] }, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return false
  const hay = [n.id, n.label, n.title ?? '', n.path ?? '', n.owner ?? '', ...(n.sub ?? [])].join(' ').toLowerCase()
  return words.every(w => hay.includes(w))
}
