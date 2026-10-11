import { useCallback, useEffect, useRef, useState } from 'react'
import { api, relTime, useTopic } from '../../lib/api.ts'
import type { Law as LawT, LawRow } from '../../../server/chat/law.ts'

// THE LOADED-LAW CHIP: "<files> · <k> tok" in the pane head, red when any file drifted (changed
// on disk since it loaded, gone, or lost to a compaction). Click = one row per file.

const REASON: Record<string, string> = { boot: 'boot', session_start: 'start', nested_traversal: 'nested', path_glob_match: 'glob', include: 'include', compact: 'compact' }
const DRIFT: Record<string, string> = { changed: 'changed on disk since it loaded', missing: 'gone from disk', compacted: 'loaded at start, not back after the compaction' }
const SOURCE: Record<string, string> = { hook: 'recorded by the SDK hook', derived: 'derived by the cockpit (the SDK fires no hook for start loads)', launch: 'appended at launch' }
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function LawChip({ id }: { id: string }) {
  const [d, setD] = useState<LawT | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const load = useCallback(() => { api<LawT>(`/api/chats/${id}/law`).then(x => { setD(x); setErr(null) }).catch(e => setErr(String(e.message ?? e))) }, [id])
  useEffect(() => { setD(null); setErr(null); load() }, [load])
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useTopic(`chat:${id}`, () => { if (t.current) clearTimeout(t.current); t.current = setTimeout(load, 1500) })
  useEffect(() => {
    if (!pop) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null) }
    const off = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.('.chats-law-pop, .chats-law')) setPop(null) }
    window.addEventListener('keydown', esc); window.addEventListener('mousedown', off)
    return () => { window.removeEventListener('keydown', esc); window.removeEventListener('mousedown', off) }
  }, [pop])

  const toggle = () => {
    if (pop) return setPop(null)
    const r = btn.current?.getBoundingClientRect()
    if (r) setPop({ x: Math.max(8, Math.min(r.right - 520, window.innerWidth - 528)), y: r.bottom + 6 })
    load()
  }
  if (err && !d) return <span className="tag chats-law" title={`law: ${err}`}>law ?</span>
  if (!d) return <span className="tag chats-law faint" title="law: loading">law</span>
  const tone = d.drift ? 'fail' : ''
  const tip = `${d.rows.length} instruction files and boot books in context, ~${d.tokens} tokens (chars / 4)${d.drift ? `\n${d.drift} drifted` : ''}${d.compactions ? `\n${d.compactions} compaction${d.compactions === 1 ? '' : 's'}` : ''}`
  if (!d.rows.length) return <span className="tag chats-law faint" title="law: nothing recorded - this conversation has not booted since the manifest landed">law</span>
  return <>
    <button ref={btn} className={`tag chats-law ${tone}`} title={tip} onClick={toggle}>{d.rows.length} · {k(d.tokens)} tok</button>
    {pop && (
      <div className="pop chats-law-pop" style={{ left: pop.x, top: pop.y }}>
        {d.rows.map(r => <Row key={r.id} r={r} />)}
      </div>
    )}
  </>
}

function Row({ r }: { r: LawRow }) {
  const tip = [r.path, r.trigger ? `trigger ${r.trigger}` : '', r.memoryType ? `memory ${r.memoryType}` : '', r.sha ? `sha ${r.sha}` : 'no sha (missing at load)',
    r.tokens !== null ? `~${r.tokens} tok` : '', r.source ? SOURCE[r.source] : 'source unknown (recorded before it was kept)', r.read ? `pulled ${r.read}x` : '', r.drift ? DRIFT[r.drift] : ''].filter(Boolean).join('\n')
  return (
    <div className={`chats-law-r ${r.drift ? 'bad' : ''}`} title={tip}>
      {r.drift ? <span className="dot fail" /> : <span className="chats-nodot" />}
      <span className="chats-law-p">{r.path}</span>
      <span className="chats-law-s">{r.sha ? r.sha.slice(0, 7) : '-'}</span>
      <span className="chats-law-t">{relTime(r.ts)}</span>
      <span className={`tag ${r.reason === 'boot' ? 'accent' : ''} ${r.source === 'derived' ? 'none' : ''}`} data-source={r.source ?? 'unknown'}>{REASON[r.reason] ?? r.reason}</span>
    </div>
  )
}
