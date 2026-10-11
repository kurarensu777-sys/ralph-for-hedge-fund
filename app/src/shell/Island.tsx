import { useEffect, useRef, useState } from 'react'
import { relTime, useApi } from '../lib/api.ts'
import type { AgentRow, Conversation } from '../../server/chat/types.ts'
import { chatTitle } from '../rooms/chats/title.ts'
import { categoryOf } from '../ui/categories.ts'
import { Dot, markOf as agentMark } from '../ui/kit.tsx'
import { useNav } from './nav.tsx'
import { islandOf } from './island.ts'
import { NeedsQueue, useNeeds } from '../rooms/board/Choices.tsx'

// THE ACTIVITY ISLAND: a floating pill above the status bar, bottom centre. Coloured avatars of the
// agents that are working or waiting, "N working · M needs you", a thin bar that moves while
// anything works. Nothing working and nobody waiting -> no island at all. Click -> the live chats.
// Beside it, the board's NEEDS YOU count: the owner's open decisions; click -> the queue, each item
// with its option buttons (src/rooms/board/Choices.tsx), so the queue clears in one sitting.

export function Island({ onShown }: { onShown: (shown: boolean) => void }) {
  const ag = useApi<{ agents: AgentRow[] }>('/api/chats/agents', ['chat', 'config'])
  const [open, setOpen] = useState(false)
  const [qOpen, setQOpen] = useState(false)
  const needs = useNeeds()
  const decide = needs.waiting ?? 0
  const cv = useApi<{ conversations: Conversation[] }>(open ? '/api/chats?limit=80' : null, ['chat'])
  const { go } = useNav()
  const ref = useRef<HTMLDivElement>(null)
  const s = islandOf(ag.data?.agents ?? null)
  // the board half stays up while a choice's undo runs, even when that choice emptied the queue
  const board = decide > 0 || needs.busy || qOpen
  const shown = s.shown || board
  useEffect(() => onShown(shown), [shown, onShown])
  useEffect(() => { if (!s.shown) setOpen(false) }, [s.shown])
  useEffect(() => {
    if (!open && !qOpen) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) { setOpen(false); setQOpen(false) } }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setQOpen(false) } }
    window.addEventListener('mousedown', off); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
  }, [open, qOpen])
  if (!shown) return null

  const names = new Map((ag.data?.agents ?? []).map(a => [a.id, a.name]))
  const live = (cv.data?.conversations ?? []).filter(c => c.state === 'live' || c.state === 'waiting')
    .sort((a, b) => (a.state === b.state ? b.lastAt - a.lastAt : a.state === 'waiting' ? -1 : 1))
  return (
    <div className="island-wrap" ref={ref}>
      {open && (
        <div className="island-pop" role="menu">
          {cv.error && !cv.data && <div className="island-none fail">chats unreachable</div>}
          {!cv.data && !cv.error && <div className="island-none">loading</div>}
          {cv.data && live.length === 0 && <div className="island-none">no live chats</div>}
          {live.map(c => {
            const cat = categoryOf(c.agent)
            return (
              <button key={c.id} className="island-row" role="menuitem" onClick={() => { setOpen(false); go('chats', c.id) }} title={c.title}>
                <span className="island-av sm" style={{ background: cat.color }}>{agentMark(c.agent)}</span>
                <span className="island-lbl">{chatTitle(c.title) || `${names.get(c.agent) ?? c.agent} chat`}</span>
                <span className="island-when">{relTime(c.lastAt)}</span>
                <Dot s={c.state === 'waiting' ? 'ask' : 'run'} title={c.state === 'waiting' ? 'needs you' : 'working'} />
              </button>
            )
          })}
        </div>
      )}
      {qOpen && (
        <div className="island-pop board-q-pop" role="dialog" aria-label="Needs you">
          <NeedsQueue onOpen={id => { setQOpen(false); go('board', id) }} />
        </div>
      )}
      <div className="board-isl-row">
      {s.shown && <button className={`island ${s.waiting ? 'asks' : ''}`} aria-expanded={open} onClick={() => { setQOpen(false); setOpen(!open) }}
        title={s.agents.map(a => `${names.get(a.id) ?? a.id}: ${[a.working && `${a.working} working`, a.waiting && `${a.waiting} needs you`].filter(Boolean).join(', ')}`).join('\n')}>
        <span className="island-ava">
          {s.agents.slice(0, 4).map(a => (
            <span key={a.id} className={`island-av ${a.waiting ? 'ask' : ''}`} style={{ background: categoryOf(a.id).color }}>{agentMark(a.id)}</span>
          ))}
          {s.agents.length > 4 && <span className="island-av more">+{s.agents.length - 4}</span>}
        </span>
        <span className="island-txt">
          {s.working > 0 && <><b>{s.working}</b> working</>}
          {s.working > 0 && s.waiting > 0 && <span className="island-sep">·</span>}
          {s.waiting > 0 && <><b className="ask">{s.waiting}</b> needs you</>}
        </span>
        <span className={`island-bar ${s.working ? '' : 'still'}`}><i /></span>
      </button>}
      {board && <button className={`island board-isl ${decide ? 'asks' : ''}`} aria-expanded={qOpen} onClick={() => { setOpen(false); setQOpen(!qOpen) }}
        title={decide ? `${decide} board item${decide === 1 ? '' : 's'} waiting on your choice` : 'Nothing waiting on your choice'}>
        <svg viewBox="0 0 24 24" className="board-isl-ico"><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></svg>
        <b className={decide ? 'ask' : ''}>{decide}</b><span className="board-isl-lbl">NEEDS YOU</span>
      </button>}
      </div>
    </div>
  )
}
