// THE URL OF A VIEW (pure, tested in test/shell-route.test.ts). Hash routing, so the static dist
// needs no server fallback: `#/<room>` or `#/<room>/<target>`. The target is what the room would
// act on if handed it as its selection: a conversation id (chats), a board item id or `new`
// (board), a book path or `agent:<id>` (library), a tab (system), a range (loop). An open drawer
// that carries a `link` shows that link as the target, so a pasted URL reopens it through the same
// selection path. Slashes in a target stay readable (a book path is `app/library/law/x.md`, not
// `library%2Ffund%2Fx.md`); every other reserved character is escaped per segment. A room may also
// carry a QUERY after the target (`#/library?type=guide&shelf=law`): the room's own view state (the
// Library's filters), written and read by that room; the router only keeps it in the URL.

/** activity-bar order: the one list of rooms the shell knows (the rooms' own modules load lazily) */
export const ROOM_IDS = ['chats', 'board', 'dash', 'data', 'library', 'context', 'lab', 'research', 'loop', 'git', 'system', 'map'] as const
export type RoomId = typeof ROOM_IDS[number]

export const isRoom = (s: string): s is RoomId => (ROOM_IDS as readonly string[]).includes(s)

export type Route = { room: RoomId; target: string | null; query?: string }

/** '#/board/B-0049' -> { room: 'board', target: 'B-0049' }; null for anything that is not a
 *  known room (an empty hash, a stray anchor), so the caller falls back to the remembered room */
export function parseHash(hash: string): Route | null {
  const full = hash.replace(/^#\/?/, '')
  const qAt = full.indexOf('?')   // a `?` inside a target is escaped (%3F), so the first one starts the query
  const h = qAt < 0 ? full : full.slice(0, qAt)
  const query = qAt < 0 ? '' : full.slice(qAt + 1)
  if (!h) return null
  const [head, ...rest] = h.split('/')
  let room: string
  try { room = decodeURIComponent(head) } catch { return null }
  if (!isRoom(room)) return null
  let target: string | null = null
  if (rest.length && rest.some(Boolean)) {
    try { target = rest.map(decodeURIComponent).join('/') } catch { return null }
  }
  return query ? { room, target, query } : { room, target }
}

export function formatHash(r: Route): string {
  const t = r.target ? '/' + r.target.split('/').map(encodeURIComponent).join('/') : ''
  return `#/${r.room}${t}${r.query ? `?${r.query}` : ''}`
}

/** the route a view shows: a linked drawer's target wins over the room's own selection */
export function routeOf(room: RoomId, sel: string | null | undefined, drawerLink: string | null | undefined, query?: string | null): Route {
  return query ? { room, target: drawerLink ?? sel ?? null, query } : { room, target: drawerLink ?? sel ?? null }
}

/** what the history entry for a view should be, given the entry the browser is on now.
 *  `d` = the open drawer's sequence number (null = no drawer); `over` = the URL of the entry this
 *  one was pushed over when a drawer opened, so closing that drawer pops it (Back and the close
 *  button agree, and history never stacks open/close pairs) */
export type Entry = { url: string; d: number | null; over?: string }
export type HistoryStep =
  | { op: 'none' }
  | { op: 'push'; entry: Entry }
  | { op: 'replace'; entry: Entry }
  | { op: 'back' }

/** `closed` = the drawer open until now that is gone; `arrived` = the open drawer IS the URL's
 *  target (the room turned a pasted or popped link into this drawer and let go of the selection);
 *  `settled` = the change is a room rewriting a target it does not know to what it shows */
export function stepFor(cur: Entry, want: { url: string; d: number | null }, o: { closed?: number | null; arrived?: boolean; settled?: boolean } = {}): HistoryStep {
  const closed = o.closed ?? null
  if (cur.url === want.url && cur.d === want.d) return { op: 'none' }
  // the room corrected a target it cannot show (#/system/nonsense -> #/system/health): the same
  // view, renamed in place. A push would leave the bad URL under it, and Back would land on it
  // only to be corrected forward again
  if (o.settled && want.d === cur.d) return { op: 'replace', entry: cur.over === undefined ? { ...want } : { ...want, over: cur.over } }
  // the drawer this entry was pushed for (`closed`, the one open until now) closed, back onto the
  // view it opened over: pop it. An entry whose drawer did not come back (Forward onto a drawer
  // with no link) is not popped: it is rewritten below
  if (want.d === null && closed !== null && cur.d === closed && cur.over === want.url) return { op: 'back' }
  if (want.d !== null && cur.d === null) {
    // the URL already named this drawer: it is this entry's view, not a layer over it
    if (o.arrived && cur.url === want.url) return { op: 'replace', entry: { ...want } }
    // a drawer opened over this view: its own entry, so Back closes it
    return { op: 'push', entry: { ...want, over: cur.url } }
  }
  // one drawer swapped for another (a link inside a drawer, or a drawer reopened from a popped
  // link): rewrite the drawer's entry, so closing still lands on the view under it
  if (want.d !== null && cur.d !== null) return { op: 'replace', entry: cur.over === undefined ? { ...want } : { ...want, over: cur.over } }
  // a plain move (another room, another selection; a drawer closed by moving away)
  if (cur.url !== want.url) return { op: 'push', entry: { ...want } }
  // the same view, its drawer gone on an entry that was not pushed for it (a pasted link)
  return { op: 'replace', entry: { ...want } }
}

/** what a room with a fixed set of targets (tabs, ranges) shows for a selection: the selection
 *  when it is one of them, else the fallback. `settle` = the selection must be rewritten to that
 *  choice so the URL names what is on screen; an empty selection is left alone (the URL of a
 *  room's default view stays bare) */
export function choiceOf<T extends string>(sel: string | null | undefined, ids: readonly T[], fallback: T): { choice: T; settle: boolean } {
  if (sel === null || sel === undefined || sel === '') return { choice: fallback, settle: false }
  if ((ids as readonly string[]).includes(sel)) return { choice: sel as T, settle: false }
  return { choice: fallback, settle: true }
}
