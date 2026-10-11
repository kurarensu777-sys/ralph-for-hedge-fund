import { useEffect, useSyncExternalStore } from 'react'

// THE COMMAND PILL'S ROOM SCOPE: a room that filters its own view by text (the Board) registers
// here while it is mounted; the pill then shows an "in <Room>" chip and its input drives that
// room's filter live. Enter still opens the command bar (seeded with the text), Esc clears the
// text and KEEPS the chip; Backspace in an empty input drops the chip, and a click on the plain
// pill while that room is mounted brings the scope back. A room with no scope keeps the plain
// pill. One scope at a time.

export type Scope = { room: string; label: string; value: string; set: (v: string) => void }

let cur: Scope | null = null
let dropped = false            // Backspace dropped the chip for this visit; a pill click or the room's next mount restores it
let focusNext = false          // a restore asks the scoped pill to take focus once it renders
const subs = new Set<() => void>()
const emit = () => subs.forEach(f => f())

/** the scope the pill shows now (null = the plain pill) */
export function useScope(): Scope | null {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => (dropped ? null : cur))
}

/** Esc in the pill: clear the room's text, keep the chip */
export function clearScope() {
  if (cur && cur.value) cur.set('')
}

/** Backspace in an empty scoped pill: clear the text and give the plain pill back */
export function dropScope() {
  if (!cur) return
  if (cur.value) cur.set('')
  dropped = true
  emit()
}

/** a click on the plain pill: a mounted room whose chip was dropped gets its scope back (true),
 *  otherwise false and the caller opens the command bar */
export function restoreScope(): boolean {
  if (!cur || !dropped) return false
  dropped = false
  focusNext = true
  emit()
  return true
}

/** the scoped pill asks once after rendering whether a restore wants it focused */
export function takeFocus(): boolean {
  const f = focusNext
  focusNext = false
  return f
}

/** a room registers its text filter while mounted; on unmount the scope goes and `onLeave` runs */
export function useRoomScope(room: string, label: string, value: string, set: (v: string) => void, onLeave?: () => void) {
  useEffect(() => {
    dropped = false
    return () => { cur = null; dropped = false; onLeave?.(); emit() }
  }, [room]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const was = cur
    cur = { room, label, value, set }
    if (!was || was.value !== value || was.room !== room || was.label !== label) emit()
  }, [room, label, value, set])
}
