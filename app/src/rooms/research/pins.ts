import { useSyncExternalStore } from 'react'
import { togglePin } from './list.ts'

// The two pinned studies (Compare reads them): ONE store the list, the card and the head share, kept
// in localStorage beside the room's other stored choices (useStored's `fundos.` prefix).

const KEY = 'fundos.research.pins'
const subs = new Set<() => void>()
let pins: string[] = read()

function read(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [] } catch { return [] }
}

export function setPins(next: string[]) {
  pins = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private window */ }
  subs.forEach(f => f())
}

/** pin or unpin; false when it is a third pin (refused, never a silent swap) */
export function pin(id: string): boolean {
  const next = togglePin(pins, id)
  if (!next) return false
  setPins(next)
  return true
}

export function usePins(): string[] {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => pins)
}
