import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useStored } from '../lib/api.ts'
import { choiceOf, formatHash, isRoom, parseHash, routeOf, stepFor, type Entry, type RoomId } from './route.ts'

export type { RoomId } from './route.ts'

/** a detail drawer. `link` = the room selection that reopens it (a board item id, a book path):
 *  while it is open the URL carries that link, so the URL can be copied and pasted back. Left
 *  out, the drawer takes the selection its room was handed when it opened (a pasted link the
 *  room turned into this drawer); `link: null` = a drawer with no URL of its own */
type Drawer = { title: ReactNode; actions?: ReactNode; body: ReactNode; link?: string | null } | null
type OpenDrawer = NonNullable<Drawer> & { seq: number; link: string | null }
type Toast = { id: number; text: string; fail?: boolean }

export type Nav = {
  room: RoomId
  /** go to a room, optionally selecting something in it (the room reads sel[room]) */
  go: (room: RoomId, select?: string | null) => void
  sel: Partial<Record<RoomId, string | null>>
  select: (room: RoomId, id: string | null) => void
  /** rewrite a room's selection IN PLACE (history replace, never a new entry): a room that was
   *  handed a target it cannot show names what it shows instead */
  settle: (room: RoomId, id: string | null) => void
  /** a room's own view state in the URL (after `?`, parseHash): `setQuery` rewrites it IN PLACE (a filter click is never a history entry) */
  query: Partial<Record<RoomId, string | null>>
  setQuery: (room: RoomId, q: string | null) => void
  drawer: Drawer
  openDrawer: (d: Drawer) => void
  toast: (text: string, fail?: boolean) => void
  toasts: Toast[]
}

const Ctx = createContext<Nav | null>(null)
let toastSeq = 0
/** drawer numbers are unique across reloads (an entry left by a previous load never matches) */
let drawerSeq = Date.now()

type Sel = Partial<Record<RoomId, string | null>>

/** the history entry the browser is on now, as the shell wrote it */
const curEntry = (): Entry => {
  const st = history.state as { fund?: { d: number | null; over?: string } } | null
  return { url: location.hash, d: st?.fund?.d ?? null, ...(st?.fund?.over !== undefined ? { over: st.fund.over } : {}) }
}
const write = (op: 'push' | 'replace', e: Entry) => {
  const state = { fund: { d: e.d, ...(e.over !== undefined ? { over: e.over } : {}) } }
  if (op === 'push') history.pushState(state, '', e.url)
  else history.replaceState(state, '', e.url)
}

// THE ROUTER: the URL is derived from (room, that room's selection, the open drawer's link) and
// written to history after each change; Back/Forward (popstate) and a pasted URL hand the route
// back as go(room, target), the same path a click inside the cockpit takes. A drawer gets its own
// history entry, so Back closes it. Without a hash the remembered room opens (localStorage).
export function NavProvider({ children }: { children: ReactNode }) {
  const [storedRoom, setStoredRoom] = useStored<RoomId>('room', 'chats')
  const [storedSel, setStoredSel] = useStored<Sel>('sel', {})
  const [boot] = useState(() => parseHash(location.hash))
  const [room, setRoomState] = useState<RoomId>(() => boot?.room ?? (isRoom(storedRoom) ? storedRoom : 'chats'))
  const [sel, setSelState] = useState<Sel>(() => (boot ? { ...storedSel, [boot.room]: boot.target } : storedSel))
  const [query, setQueryState] = useState<Partial<Record<RoomId, string | null>>>(() => (boot?.query ? { [boot.room]: boot.query } : {}))
  const [drawer, setDrawer] = useState<OpenDrawer | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  // refs hold the latest values, so two calls in one handler (select then openDrawer) see each other
  const roomRef = useRef(room)
  const selRef = useRef(sel)
  const queryRef = useRef(query)
  const drawerRef = useRef(drawer)
  /** a history.back() is in flight: writes wait for its popstate, then the latest state is written */
  const popping = useRef(false)
  /** the next history write is a settle (a room correcting its target): replace, never push */
  const settling = useRef(false)
  const [tick, setTick] = useState(0)

  const setRoom = useCallback((r: RoomId) => { roomRef.current = r; setRoomState(r); setStoredRoom(r) }, [setStoredRoom])
  const setSel = useCallback((next: Sel) => { selRef.current = next; setSelState(next); setStoredSel(next) }, [setStoredSel])
  const setDr = useCallback((d: OpenDrawer | null) => { drawerRef.current = d; setDrawer(d) }, [])

  const setQuery = useCallback((r: RoomId, q: string | null) => {
    if ((queryRef.current[r] ?? null) === (q || null)) return
    settling.current = true
    queryRef.current = { ...queryRef.current, [r]: q || null }
    setQueryState(queryRef.current)
  }, [])
  const select = useCallback((r: RoomId, id: string | null) => setSel({ ...selRef.current, [r]: id }), [setSel])
  const settle = useCallback((r: RoomId, id: string | null) => {
    if ((selRef.current[r] ?? null) === id) return
    settling.current = true
    setSel({ ...selRef.current, [r]: id })
  }, [setSel])
  const go = useCallback((r: RoomId, s?: string | null) => {
    setRoom(r)
    if (s !== undefined) setSel({ ...selRef.current, [r]: s })
  }, [setRoom, setSel])
  const openDrawer = useCallback((d: Drawer) => {
    if (!d) { setDr(null); return }
    const link = d.link !== undefined ? d.link : selRef.current[roomRef.current] ?? null
    setDr({ ...d, link, seq: ++drawerSeq })
  }, [setDr])
  const toast = useCallback((text: string, fail?: boolean) => {
    const id = ++toastSeq
    setToasts(t => [...t, { id, text, fail }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500)
  }, [])

  // state -> history
  const shownD = useRef<number | null>(null)
  useEffect(() => {
    if (popping.current) return
    const want = { url: formatHash(routeOf(room, sel[room], drawer?.link, query[room])), d: drawer?.seq ?? null }
    const closed = shownD.current !== null && shownD.current !== want.d ? shownD.current : null
    shownD.current = want.d
    if (!location.hash) write('replace', { url: want.url, d: null })   // a bare load: name the view
    const arrived = !!drawer && drawer.link !== null && drawer.link !== (sel[room] ?? null)
    const settled = settling.current
    settling.current = false
    const step = stepFor(curEntry(), want, { closed, arrived, settled })
    if (step.op === 'back') { popping.current = true; history.back() }
    else if (step.op !== 'none') write(step.op, step.entry)
  }, [room, sel, query, drawer, tick])

  // history -> state (Back, Forward, an edited or pasted URL)
  useEffect(() => {
    const onPop = () => {
      if (popping.current) {
        // our own back() after a drawer closed: the entry under it is the view; write whatever
        // changed meanwhile (a close that also moved to another room)
        popping.current = false
        setTick(t => t + 1)
        return
      }
      const r = parseHash(location.hash)
      const st = history.state as { fund?: { d: number | null } } | null
      const open = drawerRef.current
      if (!r) { setTick(t => t + 1); return }
      // an entry with no drawer closes the open one; an entry that had one reopens it through
      // its link (the room acts on the selection); a drawer with no link cannot come back
      if (open && !(st?.fund?.d != null && open.link === r.target)) setDr(null)
      setRoom(r.room)
      if (selRef.current[r.room] !== r.target) setSel({ ...selRef.current, [r.room]: r.target })
      if ((queryRef.current[r.room] ?? null) !== (r.query ?? null)) { queryRef.current = { ...queryRef.current, [r.room]: r.query ?? null }; setQueryState(queryRef.current) }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [setDr, setRoom, setSel])

  return <Ctx.Provider value={{ room, go, sel, select, settle, query, setQuery, drawer, openDrawer, toast, toasts }}>{children}</Ctx.Provider>
}

export function useNav(): Nav {
  const n = useContext(Ctx)
  if (!n) throw new Error('useNav outside NavProvider')
  return n
}

/** the selection of one room, with its setter */
export function useSel(room: RoomId): [string | null, (id: string | null) => void] {
  const { sel, select } = useNav()
  return [sel[room] ?? null, (id: string | null) => select(room, id)]
}

/** the selection of a room whose targets are a fixed set (the system room's tabs, the loop's
 *  ranges): the valid choice, falling back when the URL named something else, and that fallback
 *  written back to the URL in place, so the address bar always names the view on screen */
export function useChoice<T extends string>(room: RoomId, ids: readonly T[], fallback: T): [T, (id: T) => void] {
  const { sel, select, settle } = useNav()
  const { choice, settle: wrong } = choiceOf(sel[room], ids, fallback)
  useEffect(() => { if (wrong) settle(room, choice) }, [wrong, room, choice, settle])
  return [choice, (id: T) => select(room, id)]
}

/** the URL of the view on screen (what "Copy link" copies) */
export const viewUrl = () => location.href
