// THE ROW MARK of a conversation in the side list and RECENT: a dot only when it means something.
// running = a process is attached (state 'live'), pulsing in the row's category colour; unread =
// it moved since the owner last had it open, a solid accent dot; anything else renders no dot (the
// slot keeps its width so titles never shift). Pure here; the seen store lives in state.ts.

export type Mark = 'running' | 'unread' | null
export type Seen = { base: number; at: Record<string, number> }

/** what a conversation row wears. `open` = it is the pane in view right now (never unread) */
export function rowMark(c: { id: string; state: string; lastAt: number }, seen: Seen, open = false): Mark {
  if (c.state === 'live') return 'running'
  if (open) return null
  return c.lastAt > Math.max(seen.base, seen.at[c.id] ?? 0) ? 'unread' : null
}

// THE TAB LIGHT of a pane in the strip: a tab the owner is not LOOKING at lights until he deals
// with it. ask = parked on the owner (goes out when answered, not when looked at); done = it moved
// since the last look and nothing is running; fail = the same, and the last turn ended on an error.
// The WATCHED tab (watchedPane below), a running conversation and one with nothing new never light;
// the pane in view of a hidden or blurred window, or of a room not on screen, is not watched and
// lights like any other (B-0253). `failed` unknown (fundd has no ring for it) lights `done`: the
// light says "new since you looked", only red is a verdict.
export type Light = 'done' | 'ask' | 'fail' | null

export function tabLight(c: { id: string; state: string; lastAt: number; failed?: boolean }, seen: Seen, watched: boolean): Light {
  if (watched) return null
  if (c.state === 'waiting') return 'ask'
  if (rowMark(c, seen) !== 'unread') return null
  return c.failed ? 'fail' : 'done'
}

/** record that the owner has seen `id` as of `lastAt`. Keeps the newest `cap` entries; a pruned
 *  entry folds into `base`, so dropping it can never turn an old conversation unread again */
export function markSeen(s: Seen, id: string, lastAt: number, cap = 400): Seen {
  if ((s.at[id] ?? 0) >= lastAt) return s
  const at = { ...s.at, [id]: lastAt }
  let base = s.base
  const keys = Object.keys(at)
  if (keys.length > cap) for (const k of keys.sort((a, b) => at[a] - at[b]).slice(0, keys.length - cap)) { base = Math.max(base, at[k]); delete at[k] }
  return { base, at }
}

// WHAT THE OWNER IS LOOKING AT. Seen = the Chats room on screen AND that pane in view AND the
// browser tab visible AND the window focused (B-0253). Anything less is not a look: a turn that
// ends then lights its tab, and the light stays until all four hold.
export type Look = { room: boolean; visible: boolean; focused: boolean }

/** the pane in view of the strip: the selection when it is open, else the newest pane */
export function paneInView(sel: string | null, panes: string[]): string | null {
  return sel && panes.includes(sel) ? sel : panes[panes.length - 1] ?? null
}

/** the pane the owner is actually looking at, or null when he is not looking at the Chats room */
export function watchedPane(inView: string | null, l: Look): string | null {
  return inView && l.room && l.visible && l.focused ? inView : null
}

/** the lit chats: every open chat pane whose tab lights, plus every conversation parked on the owner
 *  that has no pane (it waits on him wherever it sits). tone = the worst light: fail, else ask */
export function litChats(convs: { id: string; state: string; lastAt: number; failed?: boolean }[], panes: string[], seen: Seen, watched: string | null): { n: number; tone?: 'fail' | 'ask' } {
  const open = new Set(panes)
  let n = 0, fail = false, ask = false
  for (const c of convs) {
    const l = open.has(c.id) ? tabLight(c, seen, c.id === watched) : c.state === 'waiting' ? 'ask' : null
    if (!l) continue
    n++
    if (l === 'fail') fail = true
    if (l === 'ask') ask = true
  }
  return fail ? { n, tone: 'fail' } : ask ? { n, tone: 'ask' } : { n }
}

/** the browser tab title with the lit count in front: '(2) AI Native Hedge Fund'; none at zero */
export function litTitle(base: string, n: number): string {
  const bare = base.replace(/^\(\d+\+?\) /, '')
  return n > 0 ? `(${n > 99 ? '99+' : n}) ${bare}` : bare
}
