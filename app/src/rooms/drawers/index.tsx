import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDrawerSlot } from '../../shell/drawerSlot.ts'
import { Icon, Sq, markOf } from '../../ui/kit.tsx'
import { categoryOf } from '../../ui/categories.ts'
import './drawers.css'

// DRAWERS - the one look every detail drawer shares (lab run, git commit, loop item, board
// card): a head (the owner's category square + title + 3-4 stat chips), key/value cards, a metric
// tile grid, and the fixed-age reads as a two-dot timeline. Not a room: no RoomDef, never in the
// registry. Built from the kit (squares, pills, cards, caps); its own classes are prefixed
// `drawers-` and hold layout only. A value that is not known renders as the kit's one short dim
// rule, never a zero.

/** a value nobody measured: the kit's short dim rule, the reason in the tooltip */
export function Unk({ title = 'unknown' }: { title?: string }) {
  return <span className="nil" title={title} aria-label={title} />
}

const blank = (v: unknown) => v === null || v === undefined || v === false || v === '' || v === '-' || (typeof v === 'number' && !Number.isFinite(v))

/** a value, or the dim dash when there is none */
export function Val({ v }: { v: ReactNode }) {
  return blank(v) ? <Unk /> : <>{v}</>
}

export type Chip = { k: string; v: ReactNode; tone?: 'ok' | 'warn' | 'fail' | 'ask' | ''; title?: string }

/** the owner's square: the kit's 28px square in the category colour, the agent's two letters. `you` =
 *  the owner (a person); null / an id no agent answers to = a neutral dim square, never a category */
function Square({ agent, known = true }: { agent: string | null | undefined; known?: boolean }) {
  if (agent === 'you' || agent === 'owner') return <Sq size={28} tone="you" title="owner"><Icon name="person" /></Sq>
  if (!agent || !known) return <Sq size={28} tone="unk" title={agent ? `${agent}: not an agent in the roster` : 'no owning agent'}>?</Sq>
  const c = categoryOf(agent)
  return <Sq size={28} c={c.color} title={`${agent} · ${c.name}`}>{markOf(agent)}</Sq>
}

/** the drawer head: lifts itself into the shell's fixed head bar (the shell's plain title gives
 *  way); the chips are the 3-4 numbers a reader opened the drawer for */
export function DrawerHead({ agent, known, title, sub, chips }: { agent: string | null | undefined; known?: boolean; title: ReactNode; sub?: ReactNode; chips: Chip[] }) {
  const slot = useDrawerSlot()
  const el = <div className="drawers-dh">
    <Square agent={agent} known={known} />
    <div className="drawers-dh-t"><div className="drawers-dh-title">{title}</div>{sub && <div className="drawers-dh-sub">{sub}</div>}</div>
    {chips.length > 0 && <div className="drawers-chips">{chips.map(c => <span key={c.k} className={`pill out drawers-chip ${c.tone ?? ''}`} title={c.title ?? c.k}>
      <span className="k">{c.k}</span><span className="v"><Val v={c.v} /></span></span>)}</div>}
  </div>
  return slot ? createPortal(el, slot) : el
}

export type KvRow = [string, ReactNode] | null | false | undefined
export type KvCard = { title: string; rows: KvRow[]; wide?: boolean }

/** key/value cards, two columns (one when the drawer is narrow). A card with no rows is not drawn */
export function KvCards({ cards }: { cards: KvCard[] }) {
  const shown = cards.map(c => ({ ...c, rows: c.rows.filter((r): r is [string, ReactNode] => !!r) })).filter(c => c.rows.length)
  return <div className="drawers-cards">{shown.map(c => <section key={c.title} className={`card drawers-card ${c.wide ? 'wide' : ''}`}>
    <div className="cap drawers-card-t">{c.title}</div>
    <dl className="drawers-kv">{c.rows.map(([k, v]) => <div key={k} className="drawers-kv-r"><dt title={k}>{k}</dt><dd><Val v={v} /></dd></div>)}</dl>
  </section>)}</div>
}

/** metrics as a tile grid: value 18px, key 10px faint */
export function Tiles({ items }: { items: { k: string; v: ReactNode; tone?: string; title?: string }[] }) {
  if (!items.length) return <div className="drawers-none"><Unk title="no metrics recorded" /></div>
  return <div className="drawers-tiles">{items.map(t => <div key={t.k} className="card drawers-tile" title={t.title ?? t.k}>
    <div className={`drawers-tile-v ${t.tone ? `t-${t.tone}` : ''}`}><Val v={t.v} /></div><div className="drawers-tile-k">{t.k}</div></div>)}</div>
}

export type ReadMark = { age: string; state: 'read' | 'due' | 'missed' | 'off'; label?: ReactNode; title?: string }

/** the fixed-age reads as a timeline: the run, then one dot per read. filled green = read, hollow
 *  amber = due, red = missed, dashed = nothing owed */
export function ReadDots({ reads, run }: { reads: ReadMark[]; run?: ReactNode }) {
  return <div className="drawers-tl">
    <div className="drawers-tl-n"><span className="drawers-tl-d run" /><span className="drawers-tl-a">run</span><span className="drawers-tl-l"><Val v={run} /></span></div>
    {reads.map(r => <div key={r.age} className="drawers-tl-n" title={r.title}>
      <span className={`drawers-tl-d ${r.state}`} /><span className="drawers-tl-a">+{r.age}</span><span className="drawers-tl-l"><Val v={r.label} /></span>
    </div>)}
  </div>
}

/** a section title inside a drawer body: the kit's caps label, the same everywhere */
export function Sec({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="cap dsec drawers-sec"><span className="sp">{children}</span>{right}</div>
}
