import { useMemo, useState } from 'react'
import { fmtTokens, type CtxAll, type CtxDetail, type CtxSaved } from '../../../shared/context.ts'
import type { LibBooks } from '../../../server/library/types.ts'
import type { PermittedRead } from '../../../shared/models.ts'
import { Btn, Empty, Glyph, Load, Meter, Seg, Tag } from '../../ui/kit.tsx'
import { api, useApi, useStored } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { lineDiff, trimDiff } from './linediff.ts'

// THE AGENT'S PANEL: the prompt exactly as launched, and the three things the owner may change in the roster
// file (the brief, the boot list, the model and effort). All edits ride one draft and one Save, so one
// commit (as the owner) carries them; the file's hash is the draft's base and a file that moved is a 409.

const TABS = [{ id: 'prompt', label: 'Prompt' }, { id: 'brief', label: 'Brief' }, { id: 'boot', label: 'Boot' }, { id: 'header', label: 'Header' }] as const
type Tab = typeof TABS[number]['id']
type Draft = { brief: string; boot: string[]; model: string; effort: string }
const tok = (s: string) => Math.round(s.length / 4)

function useDraft(d: CtxDetail) {
  const disk: Draft = { brief: d.brief.text ?? '', boot: d.boot.map(b => b.ref), model: d.header.model, effort: d.header.effort }
  const [s, setS] = useState<{ base: string; edit: Partial<Draft> }>({ base: d.hash, edit: {} })
  const touched = Object.keys(s.edit).length > 0
  const cur: Draft = { ...disk, ...s.edit }
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setS(p => {
    const edit = { ...p.edit }
    if (JSON.stringify(v) === JSON.stringify(disk[k])) delete edit[k]; else edit[k] = v
    return { base: Object.keys(p.edit).length ? p.base : d.hash, edit }
  })
  return {
    disk, cur, set,
    dirty: Object.keys(s.edit) as (keyof Draft)[],
    base: touched ? s.base : d.hash,
    conflict: touched && s.base !== d.hash,
    reset: () => setS({ base: d.hash, edit: {} }),
  }
}
type Dr = ReturnType<typeof useDraft>

export function Panel({ id, all, onClose }: { id: string; all: CtxAll; onClose: () => void }) {
  const q = useApi<CtxDetail>(`/api/context/agent?id=${encodeURIComponent(id)}`, ['context', 'config', 'library'])
  return <aside className="context-panel">
    <Load q={q}>{d => <Body key={d.id} d={d} all={all} onClose={onClose} />}</Load>
  </aside>
}

function Body({ d, all, onClose }: { d: CtxDetail; all: CtxAll; onClose: () => void }) {
  const nav = useNav()
  const [tab, setTab] = useStored<Tab>('context.tab', 'prompt')
  const dr = useDraft(d)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<CtxSaved | null>(null)
  const save = async () => {
    setBusy(true)
    try {
      const body: Record<string, unknown> = { agent: d.id, base: dr.base }
      for (const k of dr.dirty) body[k] = dr.cur[k]
      const r = await api<CtxSaved>('/api/context/save', { body })
      setSaved(r); dr.reset()
      nav.toast(r.written ? `saved ${r.sha ?? ''}: ${r.changed.join(', ')}` : 'nothing changed')
    } catch (e: any) { nav.toast(`${d.id}: ${e.message}`, true) }
    finally { setBusy(false) }
  }
  return <>
    <div className="context-phead">
      <Glyph id={d.id} tone={d.mode === 'dormant' ? 'off' : undefined} />
      <span className="context-pname" title={d.file}>{d.name}</span>
      {d.mode === 'dormant' && <Tag tone="warn">dormant</Tag>}
      <span className="faint mono" title="the whole appended prompt, chars / 4">~{fmtTokens(d.promptTokens)} tok</span>
      <button className="iconbtn context-x" title="close" onClick={onClose}>×</button>
    </div>
    <div className="context-tabs"><Seg value={tab} options={TABS.map(t => ({ id: t.id, label: t.label }))} onChange={setTab} />
      {dr.dirty.length > 0 && <span className="context-dirty" title="unsaved edits in these parts">edited: {dr.dirty.join(', ')}</span>}
    </div>
    <div className="context-pbody">
      {tab === 'prompt' && <PromptTab d={d} />}
      {tab === 'brief' && <BriefTab d={d} dr={dr} cap={all.caps?.agent ?? null} />}
      {tab === 'boot' && <BootTab d={d} dr={dr} cap={all.caps?.boot ?? null} chapterCap={all.caps?.chapter ?? null} />}
      {tab === 'header' && <HeaderTab dr={dr} />}
    </div>
    {saved && <SavedNote s={saved} onChat={id => nav.go('chats', id)} />}
    {(dr.dirty.length > 0 || dr.conflict) && <div className="context-savebar">
      {dr.conflict
        ? <><span className="t-fail" title="another hand saved this roster file while you were editing: saving would overwrite theirs">the file changed on disk</span><Btn sm onClick={dr.reset}>Discard and reload</Btn></>
        : <><span className="faint">one commit, as you: <span className="mono">{d.file}</span></span><Btn sm onClick={dr.reset} disabled={busy}>Discard</Btn><Btn sm kind="primary" onClick={save} disabled={busy}>{busy ? 'Saving' : 'Save'}</Btn></>}
    </div>}
  </>
}

function PromptTab({ d }: { d: CtxDetail }) {
  const { toast } = useNav()
  return <>
    <div className="context-note">Exactly what a boot on main appends to the system prompt: the identity, the brief, then each booted chapter. A conversation on a build branch gets one more paragraph after it.
      <button className="lnk" onClick={() => { void navigator.clipboard?.writeText(d.prompt).then(() => toast('prompt copied'), () => toast('could not copy', true)) }}>Copy</button></div>
    <pre className="context-pre">{d.prompt}</pre>
  </>
}

function BriefTab({ d, dr, cap }: { d: CtxDetail; dr: Dr; cap: number | null }) {
  const n = tok(dr.cur.brief)
  const over = cap !== null && n > cap
  const edited = dr.dirty.includes('brief')
  const rows = useMemo(() => (edited ? lineDiff(dr.disk.brief, dr.cur.brief) : []), [edited, dr.disk.brief, dr.cur.brief])
  if (d.brief.text === null) return <Empty state="failed" inline>{`no brief at ${d.brief.path}`}</Empty>
  return <>
    <div className="context-note">The agent's two-line prompt: the body of <span className="mono">{d.brief.path}</span>.{!d.brief.editable && <span className="t-warn"> {d.brief.why}</span>}</div>
    <textarea className="context-ta" value={dr.cur.brief} readOnly={!d.brief.editable} spellCheck={false} onChange={e => dr.set('brief', e.target.value)} />
    <div className="context-count" title={cap === null ? 'the caps file could not be read' : `${n} of ${cap} tokens: the agent cap (app/tools/context-caps.json). Over it is allowed here; the context check will fail.`}>
      <Meter v={cap === null ? null : Math.min(1, n / cap)} tone={over ? 'fail' : 'accent'} grow />
      <span className={`mono ${over ? 't-fail' : ''}`}>~{n}{cap !== null && ` / ${cap}`} tok</span>
    </div>
    {rows === null ? <Empty state="unknown" inline>too long to diff here</Empty>
      : rows.length > 0 && <div className="context-diff">{trimDiff(rows).map((r, i) => r.t === 'gap'
        ? <div key={i} className="context-gap">...</div>
        : <div key={i} className={`context-d ${r.t}`}><span>{r.t === 'add' ? '+' : r.t === 'del' ? '-' : ' '}</span>{r.s || ' '}</div>)}</div>}
  </>
}

function BootTab({ d, dr, cap, chapterCap }: { d: CtxDetail; dr: Dr; cap: number | null; chapterCap: number | null }) {
  const lib = useApi<LibBooks>('/api/library/books', ['library'])
  const [find, setFind] = useState('')
  const known = useMemo(() => new Map(d.boot.map(b => [b.ref, b])), [d.boot])
  const pool = useMemo(() => {
    const m = new Map<string, { title: string; tokens: number }>()
    for (const b of lib.data?.books ?? []) {
      if (!b.chapters.length) m.set(b.path, { title: b.title, tokens: b.tokens })
      for (const c of b.chapters) m.set(`${b.path}#${c.slug}`, { title: `${b.title} - ${c.title}`, tokens: c.tokens })
    }
    return m
  }, [lib.data])
  const rows = dr.cur.boot.map(ref => {
    const k = known.get(ref), p = pool.get(ref)
    return { ref, title: k?.title ?? p?.title ?? ref, tokens: k?.tokens ?? p?.tokens ?? null, state: k?.state ?? (p ? 'ok' : 'unknown'), added: !dr.disk.boot.includes(ref) }
  })
  const total = rows.reduce((n, r) => n + (r.tokens ?? 0), 0)
  const unknownN = rows.filter(r => r.tokens === null).length
  const over = cap !== null && total > cap
  const words = find.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = [...pool.entries()].filter(([ref, p]) => !dr.cur.boot.includes(ref) && words.every(w => ref.toLowerCase().includes(w) || p.title.toLowerCase().includes(w))).slice(0, 40)
  return <>
    <div className="context-count" title={cap === null ? 'the caps file could not be read' : `${total} of ${cap} tokens: the boot cap, every chapter together`}>
      <Meter v={cap === null ? null : Math.min(1, total / cap)} tone={over ? 'fail' : 'accent'} grow />
      <span className={`mono ${over ? 't-fail' : ''}`}>~{total}{cap !== null && ` / ${cap}`} tok{unknownN > 0 && ` (+${unknownN} unread)`}</span>
    </div>
    {rows.length === 0 && <Empty inline sm>nothing booted</Empty>}
    <div className="context-list">{rows.map(r => <div key={r.ref} className={`context-brow ${r.added ? 'added' : ''}`} title={r.ref}>
      <span className={`dot ${r.state === 'ok' ? 'ok' : r.state === 'missing' ? 'fail' : 'unknown'}`} />
      <span className="nm">{r.title}</span>
      <span className={`mono ${chapterCap !== null && (r.tokens ?? 0) > chapterCap ? 't-fail' : 'faint'}`}>{r.tokens === null ? '?' : r.tokens}</span>
      <button className="iconbtn" title="remove from the boot list" onClick={() => dr.set('boot', dr.cur.boot.filter(x => x !== r.ref))}>×</button>
    </div>)}</div>
    <div className="cap context-k">Add a chapter</div>
    <input className="input sm context-find" placeholder="find a book or chapter" value={find} onChange={e => setFind(e.target.value)} />
    {lib.error && !lib.data ? <Empty state="failed" inline>{lib.error}</Empty>
      : !lib.data ? <Empty state="loading" inline />
      : <div className="context-list">{hits.map(([ref, p]) => <button key={ref} className="context-brow add" title={ref} onClick={() => dr.set('boot', [...dr.cur.boot, ref])}>
        <span className="nm">{p.title}</span><span className="mono faint">{p.tokens}</span><span className="context-plus">+</span>
      </button>)}{!hits.length && <Empty inline sm>{words.length ? 'no match' : 'type to search the library'}</Empty>}</div>}
  </>
}

function HeaderTab({ dr }: { dr: Dr }) {
  const pm = useApi<PermittedRead>('/api/chats/models')
  const m = pm.data?.models.find(x => x.id === dr.cur.model)
  const efforts = m ? m.efforts : null
  const setModel = (id: string) => {
    dr.set('model', id)
    const next = pm.data?.models.find(x => x.id === id)
    if (next?.efforts.length && !next.efforts.includes(dr.cur.effort)) dr.set('effort', next.efforts.includes('medium') ? 'medium' : next.efforts[0])
  }
  return <>
    <div className="context-note">The model and effort in the roster file. A conversation already open keeps the ones it booted with.</div>
    <label className="context-f"><span className="cap">Model</span>
      {pm.data?.models.length
        ? <select className="input sm" value={dr.cur.model} onChange={e => setModel(e.target.value)}>
          {!m && <option value={dr.cur.model}>{dr.cur.model} (not on the permitted list)</option>}
          {pm.data.models.map(x => <option key={x.id} value={x.id}>{x.name} ({x.id})</option>)}
        </select>
        : <><span className="mono">{dr.cur.model}</span><Empty state={pm.error || pm.data?.error ? 'failed' : 'loading'} inline>{pm.error ?? pm.data?.error ?? undefined}</Empty></>}
    </label>
    <label className="context-f"><span className="cap">Effort</span>
      {efforts && !efforts.length ? <span className="faint">this model takes no effort level</span>
        : <select className="input sm" value={dr.cur.effort} onChange={e => dr.set('effort', e.target.value)}>
          {(efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']).map(x => <option key={x} value={x}>{x}</option>)}
          {efforts && !efforts.includes(dr.cur.effort) && <option value={dr.cur.effort}>{dr.cur.effort} (not taken)</option>}
        </select>}
    </label>
  </>
}

/** the count after a save: the open conversations whose process is still on the prompt it booted with */
function SavedNote({ s, onChat }: { s: CtxSaved; onChat: (id: string) => void }) {
  const dr = s.drift
  return <div className="context-saved">
    <span className="mono">{s.committed ? `committed ${s.sha ?? ''}` : s.written ? 'written, not committed' : 'no change'}</span>
    {s.written && (dr
      ? <span title="a closed conversation boots from the new files, so only an open one can be behind">
        {dr.open === 0 ? ' · no conversation is open' : ` · ${dr.stale} of ${dr.open} open conversation${dr.open === 1 ? '' : 's'} still on the old prompt`}
        {dr.unknown > 0 && ` (${dr.unknown} with no record to compare)`}
        {dr.ids.slice(0, 6).map(c => <button key={c} className="lnk" onClick={() => onChat(c)}>{c}</button>)}
      </span>
      : <span className="t-warn"> · open conversations not counted{s.driftError ? `: ${s.driftError}` : ''}</span>)}
  </div>
}
