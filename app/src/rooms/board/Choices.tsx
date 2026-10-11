import { useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from 'react'
import type { BoardItem } from '../../../shared/types.ts'
import { api, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Empty, Icon } from '../../ui/kit.tsx'
import { handWaiting, offered, type Extra, type Listed, type Option } from './state.ts'
import './board.css'

// THE OWNER'S CHOICE (the needs-you contract, app/library/the-owner-answers-with-a-click.md): a
// needs-you item's options as buttons, one click to choose, 10 s to take it back. The same block
// sits on a card, in the item drawer and in the island's queue.

type Item = BoardItem & Extra

// ---------- the undo window: one store for every place a choice can be made ----------

export type Recent = { id: string; option: Option; outcome: 'ready' | 'done' | 'hand'; until: number; ms: number }
let recent: Recent[] = []
const subs = new Set<() => void>()
const emit = () => { recent = [...recent]; subs.forEach(f => f()) }
const drop = (id: string) => { recent = recent.filter(r => r.id !== id); emit() }

export function useRecent(): Recent[] {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f) } }, () => recent)
}

async function choose(id: string, option: Option, note: string) {
  const r = await api<{ outcome: Recent['outcome']; undoMs: number }>(`/api/board/${id}/choose`, { body: { option: option.id, note } })
  const ms = r.undoMs || 10_000
  recent = [...recent.filter(x => x.id !== id), { id, option, outcome: r.outcome, until: Date.now() + ms, ms }]
  emit()
  setTimeout(() => drop(id), ms)
}

async function undo(id: string) {
  await api(`/api/board/${id}/undo`, { body: {} })
  drop(id)
}

const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation()
const WHERE: Record<Recent['outcome'], string> = { ready: 'to ready', done: 'closed', hand: 'yours to run' }

/** the options of a needs-you item (or its undo, or its by-hand step); null when there is nothing to choose */
export function Choices({ i, wide }: { i: Item; wide?: boolean }) {
  const nav = useNav()
  const rec = useRecent().find(r => r.id === i.id)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const hand = handWaiting(i)

  if (rec) return <UndoRow r={rec} onUndo={async () => {
    try { await undo(i.id); nav.toast(`${i.id}: choice undone`) } catch (e: any) { nav.toast(`${i.id}: ${e.message}`, true) }
  }} />
  if (i.status !== 'needs-you') return null

  if (hand) return (
    <div className={`board-ch ${wide ? 'wide' : ''}`} onClick={stop} onKeyDown={stop}>
      <Cmd text={hand.label} />
      <button className="board-ch-b rec" disabled={!!busy} title="Ticks the step and closes the item"
        onClick={async () => {
          setBusy('done')
          try { await api(`/api/board/${i.id}/hand-done`, { body: { note } }); nav.toast(`${i.id} done`) } catch (e: any) { nav.toast(`${i.id}: ${e.message}`, true) } finally { setBusy(null) }
        }}><Icon name="hand" />Done</button>
    </div>
  )

  const pick = async (o: Option) => {
    setBusy(o.id)
    try { await choose(i.id, o, note); setNote('') } catch (e: any) { nav.toast(`${i.id}: ${e.message}`, true) } finally { setBusy(null) }
  }
  return (
    <div className={`board-ch ${wide ? 'wide' : ''}`} onClick={stop} onKeyDown={stop} onDragStart={e => e.preventDefault()}>
      {offered(i).map(o => o.hand
        ? <div key={o.id} className={`board-ch-hand ${o.rec ? 'rec' : ''}`}>
            <Cmd text={o.label} />
            <button className={`board-ch-b ${o.rec ? 'rec' : ''}`} disabled={!!busy} onClick={() => pick(o)}
              title={`${o.rec ? 'Recommended. ' : ''}You run this yourself; choosing it leaves the item waiting on your Done`}>{busy === o.id ? '...' : 'Choose'}</button>
          </div>
        : <button key={o.id} className={`board-ch-b ${o.rec ? 'rec' : ''}`} disabled={!!busy} onClick={() => pick(o)}
            title={`${o.rec ? 'Recommended. ' : ''}${o.label}${o.done || /^(leave|noop|no-op|none|decline)$/i.test(o.id) ? ' (closes it)' : ` (to ready${o.owner ? ` for ${o.owner}` : ''})`}`}>
            <span className="board-ch-l">{busy === o.id ? '...' : o.label}</span>
          </button>)}
      {!i.options?.length && <button className="board-ch-b" disabled={!!busy || !note.trim()} title={note.trim() ? 'Add the note, keep it waiting' : 'Type a note first'}
        onClick={async () => {
          setBusy('comment')
          try { await api(`/api/board/${i.id}/note`, { body: { who: 'you', text: note } }); setNote(''); nav.toast(`${i.id}: noted`) } catch (e: any) { nav.toast(`${i.id}: ${e.message}`, true) } finally { setBusy(null) }
        }}><span className="board-ch-l">Comment</span></button>}
      <input className="board-ch-note" value={note} placeholder="note" onChange={e => setNote(e.target.value)} title="Optional: goes into the item with your choice" />
    </div>
  )
}

/** a command the owner runs himself: mono, with a copy button */
function Cmd({ text }: { text: string }) {
  const nav = useNav()
  return (
    <span className="board-ch-cmd" title={`You run this yourself:\n${text}`}>
      <Icon name="term" />
      <code>{text}</code>
      <button className="board-ch-cp" aria-label="copy" title="Copy"
        onClick={e => { e.stopPropagation(); void navigator.clipboard?.writeText(text).then(() => nav.toast('copied'), () => nav.toast('copy refused', true)) }}><Icon name="copy" /></button>
    </span>
  )
}

function UndoRow({ r, onUndo }: { r: Recent; onUndo: () => void }) {
  const [left] = useState(() => Math.max(0, r.until - Date.now()))
  return (
    <div className="board-ch undo" onClick={stop} onKeyDown={stop}>
      <span className="board-ch-did" title={r.option.label}><Icon name="hand" /><span>{r.option.label}</span></span>
      <span className="board-ch-where">{WHERE[r.outcome]}</span>
      <button className="board-ch-b" onClick={onUndo}>Undo</button>
      <i className="board-ch-t" style={{ animationDuration: `${left}ms` }} />
    </div>
  )
}

// ---------- the queue: every needs-you item with its buttons (the island opens it) ----------

/** the whole board, read once for the island: the needs-you count and the queue share it */
export function useNeeds() {
  const q = useApi<{ items: Listed[] }>('/api/board', ['board'])
  const rec = useRecent()
  const items = q.data ? q.data.items.filter(i => i.status === 'needs-you' || rec.some(r => r.id === i.id)) : null
  const waiting = q.data ? q.data.items.filter(i => i.status === 'needs-you' && !rec.some(r => r.id === i.id)).length : null
  return { items, waiting, error: q.error, busy: rec.length > 0 }
}

export function NeedsQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const n = useNeeds()
  if (n.error && !n.items) return <Empty state="failed">{n.error}</Empty>
  if (!n.items) return <Empty state="loading" />
  if (!n.items.length) return <div className="island-none">nothing needs you</div>
  const order = [...n.items].sort((a, b) => a.priority.localeCompare(b.priority) || a.created.localeCompare(b.created))
  return (
    <div className="board-q">
      {order.map(i => (
        <div key={i.id} className={`board-q-it pr-${i.priority}`}>
          <button className="board-q-h" onClick={() => onOpen(i.id)} title={`${i.id} ${i.title}\nfiled by ${i.from || 'you'} · open it`}>
            <span className="board-q-id">{i.id}</span><span className="board-q-t">{i.title}</span>
          </button>
          <Choices i={i} wide />
        </div>
      ))}
    </div>
  )
}
