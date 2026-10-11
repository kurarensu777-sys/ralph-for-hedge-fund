import { useLayoutEffect, useRef, useState } from 'react'
import { CEO_PRIORITIES, ceoOrder, dueLabel, dueTone, type CeoFull, type CeoListed, type ChatState } from '../../../shared/ceo.ts'
import { api, relTime, useApi, useStored } from '../../lib/api.ts'
import { chatStateOf, fileCeo, openCeoChat, stateWord, useCeoItems, useChatList } from '../../lib/ceo.ts'
import { useNav } from '../../shell/nav.tsx'
import { AgentSelect, Btn, Dot, Empty, Markdown, Skeleton } from '../../ui/kit.tsx'
import { categoryOf, isKnownAgent } from '../../ui/categories.ts'
import { Avatar } from './Avatar.tsx'
import { DrawerHead } from '../drawers/index.tsx'
import { convSteps, progressOf, textMatch, useFilter, type AgentLite } from './state.ts'

// CEO LANE: the owner's own board, one lane right of Suggested. Its store is app/board/ceo/ (server/board/ceo.ts):
// auto-pickup and the agents' filters never see it. An issue has ONE chat, with the agent the owner picked when
// filing it; the strip on its card is the only place chat lives (Chat the first time, Open after).

const useAgents = () => useApi<{ agents: AgentLite[] }>('/api/board/agents', ['config'])
const patchCeo = (id: string, body: Record<string, unknown>) => api<CeoFull>(`/api/board/ceo/${id}`, { method: 'PATCH', body })

export function openCeo(nav: ReturnType<typeof useNav>, id: string) {
  nav.openDrawer({ title: <span className="mono">{id}</span>, body: <CeoDrawer id={id} /> })
}

export function CeoLane() {
  const q = useCeoItems()
  const chats = useChatList()
  const ag = useAgents()
  const f = useFilter()
  const nav = useNav()
  const [shut, setShut] = useStored('board.ceoShut', false)
  const [doneOpen, setDoneOpen] = useStored('board.ceoDone', false)
  const [quick, setQuick] = useState('')
  const [pick, setPick] = useStored('board.ceoAgent', '')
  const agents = ag.data?.agents ?? []
  const list = chats.data?.conversations
  const stateOf = (i: CeoListed) => chatStateOf(i, list)

  const all = (q.data?.items ?? []).filter(i => textMatch(`${i.id} ${i.title} ${i.agent} ${i.body}`, f.q))
  const open = ceoOrder(all.filter(i => i.status === 'open'), stateOf)
  const done = all.filter(i => i.status === 'done').sort((a, b) => b.updated.localeCompare(a.updated))
  const waiting = open.filter(i => stateOf(i) === 'waiting').length

  // "@research check the gate" files it with research; the picker's agent otherwise
  const add = async () => { if (await fileCeo(nav, quick, agents.map(a => a.id), pick, setPick)) setQuick('') }

  if (q.error && !q.data) return <section className="lane board-col board-ceo"><header className="lane-h cap board-col-h"><span className="t">CEO</span><Dot s="fail" title={q.error} /></header>
    <div className="lane-b"><Empty state="failed" inline>{q.error}</Empty></div></section>

  if (shut) {
    return <section className="lane board-col shut board-ceo">
      <button className="lane-h cap board-col-h board-shut" title={`CEO board: show (${open.length} open${waiting ? `, ${waiting} waiting on you` : ''})`} onClick={() => setShut(false)}>
        <span className="t">CEO</span>{waiting > 0 && <Dot s="ask" title={`${waiting} chat${waiting === 1 ? '' : 's'} waiting on you`} />}<span className="lane-n">{q.data ? open.length : '·'}</span>
      </button>
    </section>
  }

  return <section className="lane board-col board-ceo">
    <header className="lane-h cap board-col-h" title="Your own board: only you file here, and no agent sees it unless you open a chat">
      <span className="board-ceo-mk" aria-hidden>YO</span><span className="t">CEO</span>
      <span className="lane-n">{q.data ? open.length : ''}</span>
      {waiting > 0 && <span className="board-ceo-wait" title={`${waiting} chat${waiting === 1 ? '' : 's'} waiting on you`}>{waiting} waiting</span>}
      <button className="lnk dim board-link" title="Fold into the strip" onClick={() => setShut(true)}>hide</button>
    </header>
    <div className="board-ceo-add">
      <input className="input board-quick" placeholder="+ Add" value={quick} title="Enter files it. Start with @agent to choose who it is for."
        onChange={e => setQuick(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') setQuick('') }} />
      <AgentSelect cls="bare board-ceo-pick" value={pick} onChange={setPick} agents={agents} blank="agent" title="The agent a new issue is filed for (its chat is with this agent)" />
    </div>
    <div className="lane-b board-cards">
      {!q.data && <Skeleton kind="cards" n={2} />}
      {q.data && open.length === 0 && !f.q && <div className="board-ceo-empty">Nothing on your board.</div>}
      {open.map(i => <CeoCard key={i.id} i={i} state={stateOf(i)} agents={agents} />)}
      {done.length > 0 && <button className="lnk dim board-ceo-donebar" onClick={() => setDoneOpen(!doneOpen)}>Done {done.length} · {doneOpen ? 'hide' : 'show'}</button>}
      {doneOpen && done.map(i => <CeoCard key={i.id} i={i} state={null} agents={agents} />)}
    </div>
  </section>
}

function CeoCard({ i, state, agents }: { i: CeoListed; state: ChatState; agents: AgentLite[] }) {
  const nav = useNav()
  const done = i.status === 'done'
  // the agent's own step list, only while the issue is open and has its chat (as the agents' cards do)
  const conv = useApi<{ entries: { action?: { type?: string; todos?: { status: string }[] } }[] }>(i.conversation && !done ? `/api/chats/${i.conversation}` : null, ['chat'])
  const prog = progressOf(convSteps(conv.data?.entries), null)
  const color = i.agent && isKnownAgent(i.agent) ? `var(--c-${categoryOf(i.agent).id})` : 'var(--c-execution)'
  const tone = !done ? dueTone(i.due) : ''
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation()
    try { await patchCeo(i.id, { status: done ? 'open' : 'done' }) } catch (err: any) { nav.toast(`${i.id}: ${err.message}`, true) }
  }
  const setAgent = async (agent: string) => { try { await patchCeo(i.id, { agent }) } catch (err: any) { nav.toast(`${i.id}: ${err.message}`, true) } }
  return <article className={`board-card board-ceo-card pr-${i.priority} ${state === 'waiting' ? 'asks' : ''} ${done ? 'done' : ''}`} style={{ ['--c' as string]: color }}
    tabIndex={0} onClick={() => openCeo(nav, i.id)} onKeyDown={e => { if (e.key === 'Enter') openCeo(nav, i.id) }}
    title={[`${i.id} ${i.title}`, `${i.priority}${i.due ? ` · due ${i.due}` : ''} · filed by ${i.from} ${relTime(i.created)}`, i.told ? `told: ${i.told}` : ''].filter(Boolean).join('\n')}>
    <div className="board-card-top">
      <button className={`board-ceo-tick ${done ? 'on' : ''}`} aria-label={done ? 'Reopen' : 'Mark done'} title={done ? 'Reopen' : 'Mark done'} onClick={toggle} />
      {i.due && <span className={`tag sm board-ceo-due ${tone}`} title={`due ${i.due}`}>{dueLabel(i.due)}</span>}
      {i.told && <span className="tag sm board-ceo-told" title={`an agent filed this because you told it to: "${i.told}"`}>told by {i.from}</span>}
      <span className="sp" />
      {state === 'waiting' ? <Dot s="ask" title="its chat is waiting on you" /> : state === 'live' ? <Dot s="run" title="its chat is working" /> : null}
    </div>
    <div className={`board-card-t ${done ? 'board-ceo-dn' : ''}`}>{i.title}</div>
    {prog && !done && <div className="board-prog" title={`${prog.done} of ${prog.total} done in its chat's step list`}><i style={{ width: `${Math.round((prog.done / prog.total) * 100)}%` }} /></div>}
    {!done && <div className="board-ceo-strip" onClick={e => e.stopPropagation()}>
      {i.conversation
        ? <>
            <Avatar id={i.agent} size={16} />
            <span className={`board-ceo-st ${state === 'waiting' ? 'ask' : ''}`} title={`${i.agent}'s chat ${i.conversation}: ${stateWord(state)}`}>{stateWord(state)}</span>
            <span className="sp" />
            <Btn sm onClick={() => void openCeoChat(nav, i.id)} title={`Open this issue's chat with ${i.agent}`}>Open</Btn>
          </>
        : i.agent
          ? <>
              <Btn sm kind="primary" onClick={() => void openCeoChat(nav, i.id)} title={`Start this issue's chat with ${i.agent}`}>Chat with {i.agent}</Btn>
              <AgentSelect cls="bare board-ceo-who" value={i.agent} onChange={setAgent} agents={agents} blank="no agent" title="Change the agent (fixed once the chat starts)" />
            </>
          : <AgentSelect cls="input board-ceo-pickone" value="" onChange={setAgent} agents={agents} blank="pick an agent to chat with" />}
    </div>}
  </article>
}

/** a textarea that grows with its text (the title) */
function grow(el: HTMLTextAreaElement | null) { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }

function CeoDrawer({ id }: { id: string }) {
  const q = useApi<CeoFull>(`/api/board/ceo/${id}`, ['board'])
  const chats = useChatList()
  const ag = useAgents()
  const nav = useNav()
  const it = q.data
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [editBody, setEditBody] = useState<string | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => grow(titleRef.current), [title, !!it])
  useLayoutEffect(() => { if (it) setTitle(it.title) }, [it?.title]) // eslint-disable-line
  if (q.error && !it) return <Empty state="failed">{q.error}</Empty>
  if (!it) return <Empty state="loading" />
  const agents = ag.data?.agents ?? []
  const state = chatStateOf(it, chats.data?.conversations)
  const save = async (patch: Record<string, unknown>) => { try { await patchCeo(id, patch); q.reload() } catch (e: any) { nav.toast(`${id}: ${e.message}`, true) } }
  const addNote = async () => {
    if (!note.trim()) return
    try { await api(`/api/board/ceo/${id}/note`, { body: { text: note } }); setNote(''); q.reload() } catch (e: any) { nav.toast(e.message, true) }
  }
  return <div className="board-dr">
    <DrawerHead agent="you" title={<span className="mono">{id}</span>} sub={it.status === 'done' ? 'done' : 'open'}
      chips={[{ k: 'PRI', v: it.priority, title: `priority ${it.priority}` }, ...(it.due ? [{ k: 'DUE', v: dueLabel(it.due), tone: dueTone(it.due) === 'late' ? 'fail' : dueTone(it.due) === 'today' ? 'warn' : '' as '' | 'fail' | 'warn', title: `due ${it.due}` }] : [])]} />
    {it.told && <div className="board-dr-nolive" role="status">An agent ({it.from}) filed this because you told it to: "{it.told}"</div>}
    <textarea className="input board-dr-title" rows={1} value={title} ref={titleRef} onChange={e => setTitle(e.target.value)}
      onBlur={() => title.trim() && title !== it.title && save({ title: title.replace(/\s*\n\s*/g, ' ') })}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur() } }} />
    <div className="board-ceo-grid">
      <label className="field"><span className="cap">Priority</span><select className="input" value={it.priority} onChange={e => save({ priority: e.target.value })}>
        {CEO_PRIORITIES.map(p => <option key={p}>{p}</option>)}</select></label>
      <label className="field"><span className="cap">Due</span><input className="input" type="date" value={it.due} onChange={e => save({ due: e.target.value })} /></label>
      <label className="field"><span className="cap">Agent</span><AgentSelect value={it.agent} agents={agents} blank="none" disabled={!!it.conversation} onChange={v => save({ agent: v })}
        title={it.conversation ? `Fixed: this issue's chat is with ${it.agent}. Bring another agent in inside that chat.` : 'Who this issue\'s chat is with'} /></label>
    </div>
    <div className="field">
      <span className="cap">Chat</span>
      <div className="board-ceo-chatrow">
        {it.conversation
          ? <><Avatar id={it.agent} size={18} /><span className="board-ceo-st">{it.agent} · {stateWord(state)}</span><span className="sp" />
              <Btn sm kind="primary" onClick={() => { nav.openDrawer(null); void openCeoChat(nav, id) }}>Open</Btn></>
          : it.agent
            ? <><span className="faint">no chat yet</span><span className="sp" />
                <Btn sm kind="primary" onClick={() => { nav.openDrawer(null); void openCeoChat(nav, id) }}>Chat with {it.agent}</Btn></>
            : <span className="faint">pick an agent above to start this issue's chat</span>}
      </div>
      {it.conversation && <span className="faint xs">One chat per issue: it stays with {it.agent}.</span>}
    </div>
    <div className="board-dr-meta"><span className="faint mono">from {it.from} · opened {relTime(it.created)} · updated {relTime(it.updated)}</span></div>

    <div className="cap dsec board-dr-sec"><span>Body</span>
      {editBody === null
        ? <Btn sm onClick={() => setEditBody(it.text)}>Edit</Btn>
        : <span className="board-dr-eb"><Btn sm kind="ghost" onClick={() => setEditBody(null)}>Cancel</Btn>
            <Btn sm kind="primary" onClick={async () => {
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
      {it.notes.map((n, k) => <div className="board-note" key={n.ts + k}>
        <div className="board-note-h"><Avatar id={n.who} size={18} /><b>{n.who}</b><span className="faint" title={n.ts}>{relTime(n.ts)}</span></div>
        <Markdown text={n.text} />
      </div>)}
    </div>
    <div className="board-note-in">
      <textarea className="input" rows={2} value={note} placeholder="Add a note" onChange={e => setNote(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void addNote() }} />
      <Btn sm onClick={addNote} disabled={!note.trim()} title="Ctrl+Enter">Add</Btn>
    </div>
    <div className="board-dr-foot"><Btn onClick={() => save({ status: it.status === 'done' ? 'open' : 'done' })}>{it.status === 'done' ? 'Reopen' : 'Mark done'}</Btn></div>
  </div>
}
