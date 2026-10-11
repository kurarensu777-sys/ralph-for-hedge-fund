import { useEffect, useRef } from 'react'

// THE TAB PICKS UP A NEW BUILD BY ITSELF (the owner, 2026-09-28: "auto"). fundd rebuilds dist/ once a
// UI commit lands (server/uibuild.ts AutoBuild); a tab that loaded an older dist/ reloads onto it
// when nobody is looking: the tab is hidden, or no key or pointer for IDLE_MS. Never mid-typing;
// unsent chat drafts live in localStorage (rooms/chats/state.ts), so a reload loses nothing.

export const IDLE_MS = 2 * 60_000

/** reload now? only onto a NEWER build than this tab loaded, and only when the owner is away */
export function shouldReload(o: { loaded: number | null; dist: number | null; hidden: boolean; idleMs: number }): boolean {
  if (o.loaded === null || o.dist === null || o.dist <= o.loaded) return false
  return o.hidden || o.idleMs >= IDLE_MS
}

/** `dist` is dist/'s build time as fundd reports it (null in dev or unread): the first reading is this tab's */
export function useUiFresh(dist: number | null | undefined): void {
  const loaded = useRef<number | null>(null)
  const latest = useRef<number | null>(null)
  const last = useRef(Date.now())
  if (dist != null) { if (loaded.current === null) loaded.current = dist; latest.current = dist }
  useEffect(() => {
    const seen = () => { last.current = Date.now() }
    const check = () => {
      if (shouldReload({ loaded: loaded.current, dist: latest.current, hidden: document.hidden, idleMs: Date.now() - last.current })) location.reload()
    }
    const evs = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const
    for (const e of evs) window.addEventListener(e, seen, { passive: true })
    document.addEventListener('visibilitychange', check)
    const t = setInterval(check, 15_000)
    return () => { for (const e of evs) window.removeEventListener(e, seen); document.removeEventListener('visibilitychange', check); clearInterval(t) }
  }, [])
}
