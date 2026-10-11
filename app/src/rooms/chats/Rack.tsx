import { useEffect, useMemo, useState } from 'react'
import { api, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Empty } from '../../ui/kit.tsx'
import type { Prompt } from '../../../server/chat/prompts.ts'

// THE PROMPT RACK: the owner's saved prompts. A row click puts the body into the composer at the
// cursor; nothing here ever sends. + / the pencil open the card; Esc steps back one view.

const PATH = {
  bookmark: 'M4.5 2.5h7v11L8 10.5l-3.5 3z',
  pencil: 'M10.5 3l2.5 2.5L6 12.5H3.5V10zM9 4.5l2.5 2.5',
}
export function RackIcon({ name }: { name: keyof typeof PATH }) {
  return <svg className="ico" viewBox="0 0 16 16"><path d={PATH[name]} /></svg>
}

export const firstLine = (s: string) => s.split('\n').map(l => l.trim()).find(Boolean) ?? ''
const secondLine = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)[1] ?? ''
export const promptLabel = (p: Pick<Prompt, 'title' | 'body'>) => p.title || firstLine(p.body)

/** does a prompt match the search: every word in the title, body or a tag (a '#word' names a tag only) */
export function matches(p: Pick<Prompt, 'title' | 'body' | 'tags'>, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${p.title}\n${p.body}`.toLowerCase()
  return words.every(w => (w.startsWith('#') ? p.tags.includes(w.slice(1)) : hay.includes(w) || p.tags.some(t => t.includes(w))))
}

type Card = { id?: number; title: string; body: string; tags: string }

export function Rack({ onPick, onClose }: { onPick: (text: string) => void; onClose: () => void }) {
  const { toast } = useNav()
  const q = useApi<{ prompts: Prompt[] }>('/api/chats/prompts', ['chats:prompts'])
  const [s, setS] = useState('')
  const [card, setCard] = useState<Card | null>(null)
  const [arm, setArm] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopPropagation()
      if (card) { setCard(null); setArm(false) } else onClose()
    }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [card, onClose])

  const rows = useMemo(() => (q.data?.prompts ?? []).filter(p => matches(p, s)), [q.data, s])

  const save = async () => {
    if (!card || !card.body.trim()) return
    setBusy(true)
    try {
      await api('/api/chats/prompts', { body: { ...(card.id ? { id: card.id } : {}), title: card.title, body: card.body, tags: card.tags } })
      setCard(null); setArm(false); q.reload()
    } catch (e: any) { toast(`save: ${e.message}`, true) } finally { setBusy(false) }
  }
  const del = async () => {
    if (!card?.id) return
    if (!arm) { setArm(true); return }
    setBusy(true)
    try { await api(`/api/chats/prompts/${card.id}`, { method: 'DELETE' }); setCard(null); setArm(false); q.reload() }
    catch (e: any) { toast(`delete: ${e.message}`, true) } finally { setBusy(false) }
  }

  if (card) return (
    <div className="pop chats-pop chats-rack">
      <div className="pop-h">
        <span className="cap">{card.id ? 'Prompt' : 'New'}</span>
        <span className="chats-sp" />
        <button className="iconbtn" title="Back (Esc)" onClick={() => { setCard(null); setArm(false) }}>x</button>
      </div>
      <div className="chats-hand-b">
        <input autoFocus className="input" placeholder="Title" maxLength={120} value={card.title} onChange={e => setCard({ ...card, title: e.target.value })} />
        <textarea className="input chats-rack-ta" rows={8} placeholder="Body" value={card.body} spellCheck={false} onChange={e => setCard({ ...card, body: e.target.value })} />
        <input className="input" placeholder="Tags" title="comma or space separated, up to 12" value={card.tags} onChange={e => setCard({ ...card, tags: e.target.value })} />
        <div className="chats-hand-a">
          {card.id && <button className={`btn ${arm ? 'danger' : ''}`} disabled={busy} title={arm ? 'Press again to delete' : 'Delete'} onClick={del}>{arm ? 'Sure?' : 'Delete'}</button>}
          <button className="btn primary" disabled={busy || !card.body.trim()} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="pop chats-pop chats-rack">
      <div className="pop-h">
        <input autoFocus className="input" placeholder="Search" value={s} onChange={e => setS(e.target.value)} />
        <button className="chats-tb chats-ib" title="New prompt" onClick={() => setCard({ title: '', body: '', tags: '' })}><svg className="ico" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" /></svg></button>
        <button className="iconbtn" title="Close (Esc)" onClick={onClose}>x</button>
      </div>
      <div className="chats-pop-l">
        {q.error && !q.data && <Empty inline state="failed">{q.error}</Empty>}
        {!q.data && !q.error && <Empty inline state="loading" />}
        {q.data && rows.length === 0 && <Empty inline title={s ? 'NO MATCH' : 'NONE'} />}
        {rows.map(p => {
          const rest = p.title ? firstLine(p.body) : secondLine(p.body)
          return (
            <div key={p.id} className="pop-row chats-hrow chats-rack-r" title={p.body} onClick={() => onPick(p.body)}>
              <span className="nm">{promptLabel(p)}{rest && <span className="chats-snip">{rest}</span>}</span>
              {p.tags.length > 0 && <span className="chats-rack-tags">{p.tags.map(t => <span key={t} className="tag">{t}</span>)}</span>}
              <button className="iconbtn chats-rack-ed" title="Edit" onClick={e => { e.stopPropagation(); setCard({ id: p.id, title: p.title, body: p.body, tags: p.tags.join(', ') }) }}><RackIcon name="pencil" /></button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
