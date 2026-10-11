import type { RoomDef } from '../types.ts'
import { useNav } from '../../shell/nav.tsx'
import { Group } from '../../ui/kit.tsx'
import { StoreView } from './store.tsx'
import './data.css'

// ROOM: data - the STORAGE VIEW (B-0327): the cache against its budget and evict to budget, the
// pins, the archive, the ops store and retention (./store.tsx, ./storage.tsx). Server:
// server/rooms/data.ts (/api/data/). Every reading is the data layer's (fund_db), run as a process
// or read through @fund/db; a door that is not there reads NOT AVAILABLE with its reason, never a zero.

function Explorer() {
  const nav = useNav()
  const sel = nav.sel.data ?? null
  return <Group label="Storage">
    <button className={`row ${!sel || sel === 'store' ? 'on' : ''}`} onClick={() => nav.select('data', 'store')} title="the cache against its budget, the pins, the archive, the ops store and retention (fund_db)"><span className="nm">Storage</span></button>
  </Group>
}

function Main() {
  return <StoreView />
}

export const room: RoomDef = {
  id: 'data',
  label: 'Data',
  title: 'Data',
  icon: <><ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/></>,
  Explorer,
  Main,
}
