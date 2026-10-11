import { useCallback, useEffect, useRef, useState } from 'react'
import { api, relTime, useApi, useTopic } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import type { AgentRow, ChatDelta, ChatMeta, Conversation, Decision, Entry } from '../../../server/chat/types.ts'
import { ChangesPanel } from './Changes.tsx'
import { Feed } from './Feed.tsx'
import { LESSON_PROMPT, WRAP_PROMPT } from './notify.ts'
import { Rack, RackIcon } from './Rack.tsx'
import { getDraft, setDraft, useChatsApi } from './state.ts'
import { Empty, Glyph, Icon } from '../../ui/kit.tsx'
import { convLabel } from './title.ts'
import { CAPS, engineOf, type EngineId } from '../../../shared/engines.ts'
import { Pills, type ProvidersRead } from './Pills.tsx'

// ONE conversation: the feed + the composer. Only the VISIBLE pane mounts this, so only it holds a
// live subscription (useTopic on the one shared stream - never a second EventSource).

type Img = { name: string; data: string }
type Full = { conversation: Conversation; entries: Entry[]; meta: ChatMeta; truncated?: boolean; missing?: boolean }

/** the pane has no header of its own: the title (click to rename) sits in its tab, the Changes toggle at the tab strip's end */
export function ChatPane({ id, agents, onOpen, onNew, chg, setChg }: { id: string; agents: AgentRow[]; onOpen: (id: string) => void; onNew: (agent: string) => void; chg: boolean; setChg: (v: boolean) => void }) {
  const { toast } = useNav()
  const [full, setFull] = useState<Full | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [refill, setRefill] = useState<{ text: string; n: number } | null>(null)

  const load = useCallback(() => {
    api<Full>(`/api/chats/${id}`).then(d => { setFull(d); setErr(null) }).catch(e => setErr(String(e.message ?? e)))
  }, [id])
  useEffect(() => { setFull(null); setErr(null); load() }, [load])

  useTopic(`chat:${id}`, (d: ChatDelta) => {
    setFull(f => {
      if (!f) return f
      if (d.t === 'meta') return { ...f, meta: d.m }
      if (d.t === 'reset') return { ...f, entries: d.entries }
      const i = f.entries.findIndex(x => x.id === d.e.id)
      const entries = i >= 0 ? f.entries.map((x, n) => (n === i ? d.e : x)) : [...f.entries, d.e]
      return { ...f, entries }
    })
  })
  // title / model / state changes arrive on the list topic
  useTopic('chat', (d: any, topic) => { if (topic === 'chat' && d?.id === id) api<Full>(`/api/chats/${id}`).then(x => setFull(f => (f ? { ...f, conversation: x.conversation } : x))).catch(() => {}) })

  if (err && !full) return <Empty state="failed">{err}</Empty>
  if (!full) return <Empty state="loading" skel="doc" />
  const c = full.conversation
  const agent = agents.find(a => a.id === c.agent)

  const decide = (d: Decision, v: { verdict: string; answers?: Record<string, string>; note?: string }) =>
    api(`/api/chats/${id}/decide`, { body: { toolUseId: d.toolUseId, ...v } }).catch(e => toast(`answer: ${e.message}`, true))

  return (
    <div className="chats-split">
    <div className="chats-pane">
      {full.entries.length === 0 && !full.meta.busy
        ? full.missing && c.title
          ? <div className="chats-blank"><Empty state="unknown" title="NO TRANSCRIPT">its transcript file is not on disk</Empty></div>
          : <div className="chats-blank" title={agent?.name ?? c.agent}><Glyph id={c.agent} size={32} /><span className="chats-blank-t">No messages yet</span></div>
        : <Feed conv={id} entries={full.entries} busy={full.meta.busy} onDecide={decide} truncated={!!full.truncated}
        onRewind={full.meta.busy ? undefined : e => api<{ text: string }>(`/api/chats/${id}/rewind`, { body: { entry: e.id } })
          .then(r => { setRefill({ text: r.text, n: Date.now() }); toast('rewound'); load() })
          .catch(err => toast(`rewind: ${err.message}`, true))} />}
      <Composer c={c} refill={refill} meta={full.meta} agent={agent} agents={agents} onOpen={onOpen} onNew={onNew} />
    </div>
    {chg && <ChangesPanel id={id} onClose={() => setChg(false)} />}
    </div>
  )
}

/** the conversation title; click to rename (Enter saves, Esc cancels, empty keeps the old one) */
export function Title({ c, agentName }: { c: Conversation; agentName?: string }) {
  const { toast } = useNav()
  const [edit, setEdit] = useState<string | null>(null)
  const save = () => {
    const t = (edit ?? '').trim()
    setEdit(null)
    if (!t || t === c.title) return
    api(`/api/chats/${c.id}`, { method: 'PATCH', body: { title: t } }).catch(e => toast(`rename: ${e.message}`, true))
  }
  if (edit !== null) return (
    <input autoFocus className="chats-ti" value={edit} maxLength={120} onChange={e => setEdit(e.target.value)} onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') setEdit(null) }} />
  )
  return <button className={`chats-tt ${c.title ? '' : 'faint'}`} title={`${c.title || agentName || '-'}\nclick to rename`} onClick={() => setEdit(c.title)}>{convLabel(c) || <i>new</i>}</button>
}

function Composer({ c, refill, meta, agent, agents, onOpen, onNew }: { c: Conversation; refill: { text: string; n: number } | null; meta: ChatMeta; agent?: AgentRow; agents: AgentRow[]; onOpen: (id: string) => void; onNew: (agent: string) => void }) {
  const { toast } = useNav()
  const [text, setText] = useState(() => getDraft(c.id))
  const [imgs, setImgs] = useState<Img[]>([])
  const [pop, setPop] = useState<null | 'history' | 'hand' | 'rack'>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => { setText(getDraft(c.id)) }, [c.id])
  // a rewind hands the message back to the composer
  useEffect(() => { if (refill) setText(refill.text) }, [refill])
  useEffect(() => { setDraft(c.id, text) }, [c.id, text])
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [text])

  const dormant = agent?.mode === 'dormant'
  const send = async () => {
    if (dormant || (!text.trim() && !imgs.length)) return
    const body = { text, images: imgs.map(i => ({ name: i.name, data: i.data })) }
    setText(''); setImgs([]); setDraft(c.id, '')
    try { await api(`/api/chats/${c.id}/send`, { body }) } catch (e: any) { setText(body.text); toast(`send: ${e.message}`, true) }
  }
  /** put text at the cursor (or the end), never send */
  const insert = (t: string) => {
    const el = ta.current
    const a = el ? el.selectionStart : text.length, b = el ? el.selectionEnd : text.length
    const next = text.slice(0, a) + t + text.slice(b)
    setText(next)
    setPop(null)
    requestAnimationFrame(() => { const e = ta.current; if (e) { e.focus(); e.selectionStart = e.selectionEnd = a + t.length } })
  }
  const lesson = () => api(`/api/chats/${c.id}/send`, { body: { text: LESSON_PROMPT, images: [] } }).catch(e => toast(`lesson: ${e.message}`, true))
  // THE WRAP: types the phrase and that is all; the sweep, the plan and the owner's go happen in chat
  const wrap = () => api(`/api/chats/${c.id}/send`, { body: { text: WRAP_PROMPT, images: [] } }).catch(e => toast(`wrap: ${e.message}`, true))
  const compact = () => api(`/api/chats/${c.id}/compact`, { body: {} }).then(() => toast('compacting')).catch(e => toast(`compact: ${e.message}`, true))
  const stop = (hard = false) => api(`/api/chats/${c.id}/stop`, { body: { hard } }).catch(e => toast(`stop: ${e.message}`, true))
  const addFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue
      const r = new FileReader()
      r.onload = () => setImgs(cur => [...cur, { name: f.name || 'paste.png', data: String(r.result) }])
      r.readAsDataURL(f)
    }
  }
  // the three pills: every provider's models and effort ladders (GET /api/chats/providers); the server re-lands an orphaned
  // effort on the new model's ladder and its answer is what the conversation then shows
  const pq = useApi<ProvidersRead>('/api/chats/providers', ['config'])
  const running = c.model ?? agent?.model ?? ''
  const engine: EngineId = meta.engine ?? engineOfId(running)
  const setBrain = (p: { model?: string | null; effort?: string | null }) =>
    api<{ applied: string }>(`/api/chats/${c.id}`, { method: 'PATCH', body: p }).then(r => toast(`applies ${r.applied}`)).catch(e => toast(e.message, true))

  return (
    <div className="chats-compose">
      {imgs.length > 0 && (
        <div className="chats-imgs">
          {imgs.map((m, i) => <span key={i} className="chats-img"><img src={m.data} alt="" /><button className="iconbtn" onClick={() => setImgs(imgs.filter((_, n) => n !== i))}>x</button></span>)}
        </div>
      )}
      <textarea ref={ta} className="chats-ta" rows={2} value={text} disabled={dormant}
        placeholder={dormant ? `${agent?.name} is dormant` : `Message ${agent?.name ?? c.agent}`}
        onChange={e => setText(e.target.value)}
        onPaste={e => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); addFiles(fs) } }}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
      <div className="chats-bar">
        <button className="chats-tb chats-ib" title="History: past conversations with this agent" onClick={() => setPop(pop === 'history' ? null : 'history')}><Icon name="history" /></button>
        <button className="chats-tb chats-ib" title="New conversation with this agent" disabled={dormant} onClick={() => onNew(c.agent)}><Icon name="plus" /></button>
        <button className="chats-tb chats-ib" title="Attach an image (or paste one)" onClick={() => file.current?.click()}><Icon name="image" /></button>
        <input ref={file} type="file" accept="image/*" multiple hidden onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
        <button className="chats-tb chats-ib" title="Hand to: file the draft as a board item for another agent" onClick={() => setPop(pop === 'hand' ? null : 'hand')}><Icon name="hand" /></button>
        <button className="chats-tb chats-ib" title={`Lesson: ask the agent to file what it learned ("${LESSON_PROMPT}")`} disabled={dormant || meta.busy} onClick={lesson}><Icon name="book" /></button>
        <button className="chats-tb chats-ib" title="Prompts" onClick={() => setPop(pop === 'rack' ? null : 'rack')}><RackIcon name="bookmark" /></button>
        <button className="chats-tb" title={`Wrap up: summarise this conversation and file what it changed about a strategy ("${WRAP_PROMPT}")`} disabled={dormant || meta.busy} onClick={wrap}>wrap</button>
        <span className="chats-sp" />
        {!!meta.bg?.length && <span className="chats-bgw" title={meta.bg.join('\n')}>waiting on {meta.bg.length} background {meta.bg.length === 1 ? 'task' : 'tasks'}</span>}
        <Pills providers={pq.data?.providers} loading={!pq.data && !pq.error} error={pq.error ?? null} running={running} effort={c.effort}
          agentModel={agent?.model ?? ''} agentEffort={agent?.effort ?? ''} onPick={setBrain} />
        <Gauge meta={meta} onCompact={meta.live && !meta.busy && !dormant && CAPS[engine].compact ? compact : undefined} />
        {meta.live && !meta.busy && <button className="chats-tb" title="End this conversation's process (it resumes on the next message)" onClick={() => stop(true)}>end</button>}
        {meta.busy
          ? <button className="btn danger sm" onClick={() => stop(false)} title="Interrupt the turn">Stop</button>
          : <button className="btn primary sm" onClick={send} disabled={dormant || (!text.trim() && !imgs.length)} title="Send (Enter)">Send</button>}
      </div>
      {pop === 'history' && <History agent={c.agent} current={c.id} onPick={id => { setPop(null); onOpen(id) }} onClose={() => setPop(null)} />}
      {pop === 'rack' && <Rack onPick={insert} onClose={() => setPop(null)} />}
      {pop === 'hand' && <HandTo from={c.agent} text={text} agents={agents} conv={c} onOpen={onOpen} onDone={() => setPop(null)} />}
    </div>
  )
}

/** the context gauge; compaction cannot be undone, so it is two presses (like rewind and revert):
 *  the first arms it for 3 s, the second fires /compact through the seat. Enter / Space press it too. */
function Gauge({ meta, onCompact }: { meta: ChatMeta; onCompact?: () => void }) {
  const [arm, setArm] = useState(false)
  useEffect(() => { if (!arm) return; const t = setTimeout(() => setArm(false), 3000); return () => clearTimeout(t) }, [arm])
  useEffect(() => { if (!onCompact) setArm(false) }, [onCompact])
  const pct = meta.contextPct
  const r = 7, circ = 2 * Math.PI * r
  const known = typeof pct === 'number'
  const tone = !known ? 'var(--faint)' : pct! >= 85 ? 'var(--fail)' : pct! >= 65 ? 'var(--warn)' : 'var(--dim)'
  const press = onCompact ? () => { if (arm) { setArm(false); onCompact() } else setArm(true) } : undefined
  const ctx = `${known ? `context ${Math.round(pct!)}%${meta.contextTokens ? ` - ${Math.round(meta.contextTokens / 1000)}k of ${Math.round((meta.maxTokens ?? 0) / 1000)}k` : ''}` : 'context: unknown until a turn ends'}`
  return (
    <span className={`chats-gauge ${onCompact ? 'act' : ''} ${arm ? 'arm' : ''}`} role={onCompact ? 'button' : undefined} tabIndex={onCompact ? 0 : undefined}
      aria-label={onCompact ? (arm ? 'press again to compact' : 'compact') : undefined}
      onClick={press} onKeyDown={press ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); press() } else if (e.key === 'Escape') setArm(false) } : undefined}
      title={`${ctx}${onCompact ? (arm ? '\npress again to compact (cannot be undone)' : '\npress twice to compact') : ''}`}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line2)" strokeWidth="2" strokeDasharray={known ? undefined : '2 2'} />
        {known && <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2" strokeDasharray={`${(circ * Math.min(100, pct!)) / 100} ${circ}`} transform="rotate(-90 9 9)" />}
      </svg>
      {arm ? <span className="chats-gauge-arm">Sure?</span> : known && <span style={{ color: tone }}>{Math.round(pct!)}</span>}
    </span>
  )
}

function History({ agent, current, onPick, onClose }: { agent: string; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  useEffect(() => { const t = setTimeout(() => setDq(q), 200); return () => clearTimeout(t) }, [q])
  const list = useChatsApi<{ conversations: (Conversation & { snippet?: string })[] }>(`/api/chats?agent=${encodeURIComponent(agent)}&limit=100${dq ? `&q=${encodeURIComponent(dq)}` : ''}`)
  const { toast } = useNav()
  return (
    <div className="pop chats-pop">
      <div className="pop-h"><input autoFocus className="input" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Escape' && onClose()} /><button className="iconbtn" onClick={onClose}>x</button></div>
      <div className="chats-pop-l">
        {list.error && <Empty inline state="failed">{list.error}</Empty>}
        {!list.data && !list.error && <Empty inline state="loading" />}
        {list.data?.conversations.length === 0 && <Empty inline title={dq ? 'NO MATCH' : 'NONE YET'} />}
        {list.data?.conversations.map(x => (
          <div key={x.id} className={`pop-row chats-hrow ${x.id === current ? 'hi' : ''}`} onClick={() => onPick(x.id)}>
            <span className={`dot ${stateDot(x.state)}`} />
            <span className="nm" title={x.title}>{convLabel(x) || <i className="faint chats-new" title="no message yet">new</i>}{x.snippet && <span className="chats-snip">{x.snippet}</span>}</span>
            <span className="r">{relTime(x.lastAt)}</span>
            <button className="iconbtn chats-forget" title="Forget (hides it; the transcript stays on disk)"
              onClick={e => { e.stopPropagation(); api(`/api/chats/${x.id}`, { method: 'DELETE' }).then(() => toast('forgotten')).catch(er => toast(er.message, true)) }}>x</button>
          </div>
        ))}
      </div>
    </div>
  )
}

type Draft = { goal: string; files: unknown[]; numbers: string[]; questions: string[]; issue: string | null; text: string }
const TAG_TONE: Record<string, string> = { V: 'ok', '1': 'accent', U: 'warn', API: 'ok' }

/** a draft line with its provenance tags as coloured chips */
function Tagged({ line }: { line: string }) {
  const parts = line.split(/(\[(?:V|1|U|API)\])/g)
  return <div className="chats-hand-l">{parts.map((p, n) => {
    const m = /^\[(V|1|U|API)\]$/.exec(p)
    return m ? <span key={n} className={`tag ${TAG_TONE[m[1]]}`}>{m[1]}</span> : <span key={n}>{p}</span>
  })}</div>
}

function HandTo({ from, text, agents, conv, onOpen, onDone }: { from: string; text: string; agents: AgentRow[]; conv: Conversation; onOpen: (id: string) => void; onDone: () => void }) {
  const { toast } = useNav()
  const first = text.trim().split('\n')[0] ?? ''
  const [owner, setOwner] = useState(agents.find(a => a.id !== from && a.mode === 'active')?.id ?? '')
  const [title, setTitle] = useState(first.slice(0, 100))
  const [sender, setSender] = useState<'you' | string>('you')
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'draft' | 'launch'>(null)
  const body = (draft ?? text).trim()
  const target = agents.find(a => a.id === owner)

  const makeDraft = useCallback(() => {
    setBusy('draft')
    api<Draft>(`/api/chats/${conv.id}/handoff`).then(d => {
      setDraft(d.text)
      setTitle(t => t || `handoff: ${conv.title || conv.id}`.slice(0, 100))
    }).catch(e => toast(`draft: ${e.message}`, true)).finally(() => setBusy(null))
  }, [conv.id, conv.title, toast])
  // an empty composer has nothing to hand on: draft one straight away
  useEffect(() => { if (!text.trim()) makeDraft() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const file = async () => {
    if (!owner || !title.trim() || !body) return
    try {
      await api('/api/board', { body: { title: title.trim(), kind: 'todo', owner, from: sender, body: `${body}\n\nFrom conversation ${conv.id}.` } })
      toast(`handed to ${owner}`)
      onDone()
    } catch (e: any) { toast(`hand to: ${e.message}`, true) }
  }
  const launch = async () => {
    if (!target || target.mode === 'dormant' || !body) return
    setBusy('launch')
    try {
      const r = await api<{ id: string }>('/api/chats', { body: { agent: owner, prompt: body, title: `handoff: ${conv.title || conv.id}`.slice(0, 120) } })
      onDone()
      onOpen(r.id)
    } catch (e: any) { toast(`launch: ${e.message}`, true); setBusy(null) }
  }
  const tagged = (draft ?? '').split('\n').filter(l => /\[(?:V|1|U|API)\]/.test(l))
  return (
    <div className={`pop chats-pop chats-hand ${draft !== null ? 'wide' : ''}`}>
      <div className="pop-h">
        <span className="cap">Hand to</span>
        <span className="chats-sp" />
        <button className="chats-tb chats-ib" title="Draft: goal, files, numbers, open questions, issue - numbers word for word" disabled={busy !== null} onClick={makeDraft}><Icon name="note" /></button>
        <button className="iconbtn" onClick={onDone}>x</button>
      </div>
      <div className="chats-hand-b">
        <select className="input" value={owner} onChange={e => setOwner(e.target.value)}>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.mode === 'dormant' ? ' (dormant)' : ''}</option>)}
        </select>
        {draft !== null
          ? <textarea className="input chats-hand-ta" rows={8} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false} />
          : busy === 'draft' && <Empty inline state="loading" />}
        {tagged.length > 0 && <div className="chats-hand-pv" title="tagged figures in the draft">{tagged.map((l, n) => <Tagged key={n} line={l} />)}</div>}
        <input className="input" placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} />
        <select className="input" value={sender} title="Filed by" onChange={e => setSender(e.target.value)}>
          <option value="you">from you</option>
          <option value={from}>from {from}</option>
        </select>
        <div className="chats-hand-a">
          <button className="btn" disabled={!owner || !title.trim() || !body} title="File a board item for this seat" onClick={file}>File</button>
          <button className="btn primary" disabled={!target || target.mode === 'dormant' || !body || busy === 'launch'} title={target?.mode === 'dormant' ? `${target.name} is dormant` : 'Start a new conversation with this seat, seeded with the draft'} onClick={launch}>Launch</button>
        </div>
      </div>
    </div>
  )
}

const engineOfId = (m: string): EngineId => engineOf(m)

export const stateDot = (s: string) => (s === 'live' ? 'run' : s === 'waiting' ? 'ask' : s === 'idle' ? 'ok' : 'off')
