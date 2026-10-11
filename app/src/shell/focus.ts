import { useSyncExternalStore } from 'react'
import type { RoomId } from './route.ts'

// FOCUS (the owner, 2026-09-28): one part of a room fills the cockpit window. The shell's seam for
// it: a room sets { room, part } and the shell folds its side list and services rail away while that
// room is on screen ('ex' = the side list itself fills the window instead). The part names are the
// room's own. Remembered per browser, so a reload keeps it; Esc (the shell's key) clears it. The
// stored side-list and rail preferences are never touched, so leaving focus restores them as they were.

export type Focus = { room: RoomId; part: string } | null

const KEY = 'fundos.focus'
const subs = new Set<() => void>()
let cur: Focus = read()

function read(): Focus {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); return v && typeof v.room === 'string' && typeof v.part === 'string' ? v : null } catch { return null }
}

export function setFocus(f: Focus): void {
  cur = f
  try { if (f) localStorage.setItem(KEY, JSON.stringify(f)); else localStorage.removeItem(KEY) } catch { /* private window */ }
  subs.forEach(s => s())
}

export function getFocus(): Focus { return cur }

export function useFocus(): Focus {
  return useSyncExternalStore(s => { subs.add(s); return () => { subs.delete(s) } }, () => cur)
}

/** the part of `room` that fills the window, or null */
export function useFocusOf(room: RoomId): string | null {
  const f = useFocus()
  return f && f.room === room ? f.part : null
}

/** focus `part` of `room`, or leave focus when it already is */
export function toggleFocus(room: RoomId, part: string): void {
  setFocus(cur && cur.room === room && cur.part === part ? null : { room, part })
}
