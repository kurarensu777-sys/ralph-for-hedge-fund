import { useSyncExternalStore } from 'react'
import type { RoomDef } from '../rooms/types.ts'
import { ROOM_IDS, type RoomId } from './route.ts'

// THE ROOMS, LOADED LAZILY. Each room is its own chunk (src/rooms/<id>/index.tsx, found by glob,
// so a room is still one folder and nothing else to register). The first paint waits only for the
// room on screen (main.tsx); the rest load straight after it, because the activity bar's badges
// are the rooms' own hooks. The command bar awaits them all before it lists their rows.

const loaders = import.meta.glob<{ room: RoomDef }>('../rooms/*/index.tsx')
const pathOf = (id: RoomId) => `../rooms/${id}/index.tsx`

const loaded: Partial<Record<RoomId, RoomDef>> = {}
const failed: Partial<Record<RoomId, string>> = {}
const pending = new Map<RoomId, Promise<RoomDef | null>>()
let snap: { loaded: Partial<Record<RoomId, RoomDef>>; failed: Partial<Record<RoomId, string>> } = { loaded: {}, failed: {} }
const subs = new Set<() => void>()
const emit = () => { snap = { loaded: { ...loaded }, failed: { ...failed } }; subs.forEach(f => f()) }

/** load one room's module; null when it failed (the reason stays in `failed`, shown in its place) */
export function loadRoom(id: RoomId): Promise<RoomDef | null> {
  if (loaded[id]) return Promise.resolve(loaded[id]!)
  let p = pending.get(id)
  if (p) return p
  const load = loaders[pathOf(id)]
  p = (load ? load() : Promise.reject(new Error(`no module at src/rooms/${id}/index.tsx`)))
    .then(m => { loaded[id] = m.room; delete failed[id]; emit(); return m.room })
    .catch((e: unknown) => { failed[id] = String((e as Error)?.message ?? e); pending.delete(id); emit(); return null })
  pending.set(id, p)
  return p
}

/** every room, in activity-bar order (the command bar needs all of them) */
export const loadAll = (): Promise<RoomDef[]> =>
  Promise.all(ROOM_IDS.map(loadRoom)).then(rs => rs.filter((r): r is RoomDef => !!r))

/** the rooms loaded so far and the ones that failed; re-renders as each arrives */
export function useRooms() {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => snap)
}
