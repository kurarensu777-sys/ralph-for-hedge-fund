import { useSyncExternalStore } from 'react'

/** a tiny shared value (Head, Explorer and Main read the same one), persisted per tab in localStorage */
export function shared<T>(key: string, initial: T) {
  let value: T = initial
  try { const raw = localStorage.getItem('fundos.' + key); if (raw !== null) value = JSON.parse(raw) } catch { /* private window */ }
  const subs = new Set<() => void>()
  const set = (v: T) => {
    value = v
    try { localStorage.setItem('fundos.' + key, JSON.stringify(v)) } catch { /* private window */ }
    subs.forEach(f => f())
  }
  const use = (): [T, (v: T) => void] => [useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => value), set]
  return { use, set, get: () => value }
}
