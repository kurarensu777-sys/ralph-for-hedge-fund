import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, relTime, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Btn, Empty, Icon, Markdown } from '../../ui/kit.tsx'
import { Avatar } from './Avatar.tsx'
import { AUTO, COLUMNS, KINDS, PRIORITIES, isAuto, patchItem, startChat, useNoLive, NO_LIVE_MIN, type AgentLite, type BoardConfig, type Full } from './state.ts'
import { Lock } from './Lock.tsx'
import { DrawerHead } from '../drawers/index.tsx'
import { Choices } from './Choices.tsx'

export function OwnerSelect({ value, onChange, agents, blank = 'unassigned' }: { value: string; onChange: (v: string) => void; agents: AgentLite[]; blank?: string }) {
  const known = value === '' || value === 'you' || agents.some(a => a.id === value)
  return (
    <select className="input" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{blank}</option>
      <option value="you">you</option>
      {agents.map(a => <option key={a.id} value={a.id} title={a.id}>{a.name}{a.mode === 'dormant' ? ' (dormant)' : ''}</option>)}
      {!known && <option value={value}>{value}</option>}
    </select>
  )
}

/** src: where an adopted suggestion came from (path:line), shown dim mono after the id in the header */
export function openItem(nav: ReturnType<typeof useNav>, id: string, src?: string) {
  nav.openDrawer({ title: <span className="mono">{id}</span>, body: <ItemDrawer id={id} src={src} /> })
}

/** a textarea that grows with its text, up to its CSS max-height (two lines for the title) */
function grow(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}

function ItemDrawer({ id, src }: { id: string; src?: string }) {
  const q = useApi<Full>(`/api/board/${id}`, ['board'])
  const ag = useApi<{ agents: AgentLite[] }>('/api/board/agents', ['config'])
  const nav = useNav()
  const agents = ag.data?.agents ?? []
  const it = q.data
  const [title, setTitle] = useState('')
  const [label, setLabel] = useState('')
  const [blockers, setBlockers] = useState('')
  const [note, setNote] = useState('')
  const [editBody, setEditBody] = useState<string | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => grow(titleRef.current), [title, !!it])
  const [busy, setBusy] = useState(false)
  const cfg = useApi<BoardConfig>('/api/board/config', ['board', 'config']).data
  const noLive = useNoLive()
  useEffect(() => { if (it) setTitle(it.title) }, [it?.title]) // eslint-disable-line
  useEffect(() => { if (it) setBlockers((it.blocked_by ?? []).join(', ')) }, [(it?.blocked_by ?? []).join(',')]) // eslint-disable-line

  if (q.error && !it) return <Empty state="failed">{q.error}</Empty>
  if (!it) return <Empty state="loading" />

  const save = async (patch: Record<string, unknown>) => {
    try { await patchItem(id, patch); q.reload() } catch (e: any) { nav.toast(`${id}: ${e.message}`, true) }
  }
  const addNote = async () => {
    if (!note.trim()) return
    try { await api(`/api/board/${id}/note`, { body: { who: 'you', text: note } }); setNote(''); q.reload() } catch (e: any) { nav.toast(e.message, true) }
  }
  // assigning is the owner field; the thread records who moved it
  const assign = async (assignTo: string) => {
    if (assignTo === it.owner) return
    try {
      await patchItem(id, { owner: assignTo })
      await api(`/api/board/${id}/note`, { body: { who: 'you', text: assignTo ? `assigned to ${assignTo}` : 'unassigned' } })
      q.reload()
      nav.toast(`${id} ${assignTo ? `to ${assignTo}` : 'unassigned'}`)
    } catch (e: any) { nav.toast(e.message, true) }
  }
  const start = async () => {
    setBusy(true)
    try {
      const chat = await startChat(it, cfg)
      nav.openDrawer(null)
      nav.go('chats', chat)
    } catch (e: any) { nav.toast(`start: ${e.message}`, true) } finally { setBusy(false) }
  }
  const canStart = !!it.owner && it.owner !== 'you' && agents.some(a => a.id === it.owner)
  const auto = isAuto(it)
  const setAuto = (on: boolean) => save({ labels: on ? [...it.labels, AUTO] : it.labels.filter(l => l !== AUTO) })
  const ownerAgent = agents.find(a => a.id === it.owner)
  const autoWhy = cfg && !cfg.auto ? 'The board is on Manual: nothing is picked up until it is back on Auto'
    : !it.owner || it.owner === 'you' ? 'Assign an agent: only agents are picked up'
    : ownerAgent?.mode === 'dormant' ? `${it.owner} is dormant: it will not be picked up`
    : (it.blocked ?? []).length ? `Blocked by ${(it.blocked ?? []).join(', ')}: picked up once those are done`
    : it.status !== 'ready' ? 'Picked up when the status is Ready'
    : `fundd starts a conversation with the owner (at most ${cfg?.max ?? 2} at once, never while floor/STOP exists)`
  const saveBlockers = () => {
    const next = blockers.split(/[,\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean)
    if (next.join(',') !== (it.blocked_by ?? []).join(',')) save({ blocked_by: next })
  }

  return (
    <div className="board-dr">
      <DrawerHead agent={it.owner || null} known={!it.owner || it.owner === 'you' || agents.some(a => a.id === it.owner) || !ag.data}
        title={<><span className="mono">{id}</span>{src && <span className="board-dr-src" title={src}>{src}</span>}</>} sub={it.owner || 'unassigned'}
        chips={[
          { k: 'STATUS', v: COLUMNS.find(c => c.id === it.status)?.label ?? it.status, tone: it.status === 'done' ? 'ok' : '', title: `status ${it.status}` },
          { k: 'PRI', v: it.priority, title: `priority ${it.priority}` },
          { k: 'KIND', v: it.kind, title: `kind ${it.kind}` },
          ...((it.blocked ?? []).length ? [{ k: 'BLOCKED', v: (it.blocked ?? []).length, tone: 'warn' as const, title: `waits on ${(it.blocked ?? []).join(', ')}` }] : []),
        ]} />
      {noLive(it) === true && <div className="board-dr-nolive" role="status">No live conversation: this item is in doing, but {it.conversation ? `its conversation ${it.conversation} is not working or waiting` : `${it.owner} has no conversation working or waiting`} and it has not moved for over {NO_LIVE_MIN} minutes. Start it again, or move it on.</div>}
      <Choices i={it} wide />
      <textarea className="input board-dr-title" rows={1} value={title} ref={titleRef} onChange={e => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== it.title && save({ title: title.replace(/\s*\n\s*/g, ' ') })}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }} />
      <div className="board-dr-grid">
        <label className="field"><span className="cap">Status</span><select className="input" value={it.status} onChange={e => save({ status: e.target.value })}>
          {COLUMNS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label className="field"><span className="cap">Kind</span><select className="input" value={it.kind} onChange={e => save({ kind: e.target.value })}>
          {KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
        <label className="field"><span className="cap">Owner</span><OwnerSelect value={it.owner} agents={agents} onChange={assign} /></label>
        <label className="field"><span className="cap">Priority</span><select className="input" value={it.priority} onChange={e => save({ priority: e.target.value })}>
          {PRIORITIES.map(p => <option key={p}>{p}</option>)}</select></label>
        <div className="board-dr-acts">
          {it.conversation && <Btn sm onClick={() => { nav.openDrawer(null); nav.go('chats', it.conversation!) }}
            title={`Open conversation ${it.conversation}`}>Chat</Btn>}
          <button className={`chip ${auto ? 'on' : ''}`} onClick={() => setAuto(!auto)} title={`Auto ${auto ? 'on' : 'off'}: ${autoWhy}`} aria-pressed={auto}>auto</button>
          <Btn sm kind="primary" onClick={start} disabled={!canStart || busy}
            title={canStart ? `Start a conversation with ${it.owner} about ${id}${cfg?.model ? ` on ${cfg.model}` : ''}` : 'Assign an agent first'}>Start</Btn>
        </div>
        <label className="field wide board-dr-blk" title="Board ids this waits on; it is locked until each is done"><span className="cap">Blocked by</span>
          <span className="board-dr-blkin">{(it.blocked ?? []).length > 0 && <Lock ids={it.blocked ?? []} />}
            <input className="input" value={blockers} placeholder="B-NNNN" onChange={e => setBlockers(e.target.value)}
              onBlur={saveBlockers} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} /></span></label>
        <div className="chips field wide board-dr-labels" title="Labels">
          {it.labels.filter(l => l !== AUTO).map(l => (
            <span key={l} className="chip lab">{l}<button className="chip-x" title={`Remove ${l}`} aria-label={`remove ${l}`}
              onClick={() => save({ labels: it.labels.filter(x => x !== l) })}><Icon name="x" /></button></span>
          ))}
          <input className="board-chip-in" value={label} placeholder="+ label" onChange={e => setLabel(e.target.value)}
            onKeyDown={e => {
              if ((e.key === 'Enter' || e.key === ',') && label.trim()) {
                e.preventDefault()
                const add = label.trim().replace(/,$/, '')
                if (!it.labels.includes(add)) save({ labels: [...it.labels, add] })
                setLabel('')
              } else if (e.key === 'Escape') setLabel('')
            }} />
        </div>
      </div>
      <div className="board-dr-meta">
        <span className="faint mono">from {it.from || '-'} · opened {relTime(it.created)} · updated {relTime(it.updated)}</span>
      </div>

      <div className="cap dsec board-dr-sec"><span>Body</span>
        {editBody === null
          ? <Btn sm onClick={() => setEditBody(it.text)} title="Edit the body (the notes thread is kept)">Edit</Btn>
          : <span className="board-dr-eb"><Btn sm kind="ghost" onClick={() => setEditBody(null)}>Cancel</Btn>
              <Btn sm kind="primary" onClick={async () => {
                // the notes thread is kept verbatim; only the thinking above it is replaced
                const m = /^### \d{4}-\d\d-\d\dT\S+ - .+$/m.exec(it.body)
                await save({ body: m ? `${editBody.trim()}\n\n${it.body.slice(m.index)}` : editBody })
                setEditBody(null)
              }}>Save</Btn></span>}
      </div>
      {editBody !== null
        ? <textarea className="input board-dr-body" value={editBody} onChange={e => setEditBody(e.target.value)} />
        : it.text ? <Markdown text={it.text} /> : <Empty inline title="NONE" />}

      <div className="cap dsec board-dr-sec"><span>Notes</span><span className="faint">{it.notes.length || ''}</span></div>
      <div className="board-notes">
        {it.notes.map((n, i) => (
          <div className="board-note" key={n.ts + i}>
            <div className="board-note-h"><Avatar id={n.who} size={18} /><b>{n.who}</b><span className="faint" title={n.ts}>{relTime(n.ts)}</span></div>
            <Markdown text={n.text} />
          </div>
        ))}
      </div>
      <div className="board-note-in">
        <textarea className="input" rows={2} value={note} placeholder="Add a note" onChange={e => setNote(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addNote() }} />
        <Btn sm onClick={addNote} disabled={!note.trim()} title="Ctrl+Enter">Add</Btn>
      </div>
    </div>
  )
}

export function NewItemForm({ onDone }: { onDone: (id: string) => void }) {
  const ag = useApi<{ agents: AgentLite[] }>('/api/board/agents', ['config'])
  const nav = useNav()
  const [f, setF] = useState({ title: '', kind: 'todo', owner: '', priority: 'p2', status: 'backlog', body: '' })
  const create = async () => {
    if (!f.title.trim()) return
    try { const it = await api<Full>('/api/board', { body: { ...f, from: 'you' } }); onDone(it.id) } catch (e: any) { nav.toast(e.message, true) }
  }
  return (
    <form className="board-dr" onSubmit={e => { e.preventDefault(); create() }}>
      <input autoFocus className="input board-dr-title" placeholder="Title" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} />
      <div className="board-dr-grid">
        <label className="field"><span className="cap">Status</span><select className="input" value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>
          {COLUMNS.filter(c => c.id !== 'done').map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label className="field"><span className="cap">Kind</span><select className="input" value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })}>
          {KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
        <label className="field"><span className="cap">Owner</span><OwnerSelect value={f.owner} agents={ag.data?.agents ?? []} onChange={v => setF({ ...f, owner: v })} /></label>
        <label className="field"><span className="cap">Priority</span><select className="input" value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })}>
          {PRIORITIES.map(p => <option key={p}>{p}</option>)}</select></label>
      </div>
      <textarea className="input board-dr-body" placeholder="Body (markdown)" value={f.body} onChange={e => setF({ ...f, body: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) create() }} />
      <div className="board-dr-foot"><Btn kind="primary" type="submit" disabled={!f.title.trim()} title="Ctrl+Enter">Create</Btn></div>
    </form>
  )
}
