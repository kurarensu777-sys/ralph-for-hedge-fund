import { useEffect, useRef, useState } from 'react'
import { capsNote, ENGINE_LABEL, type EngineId, type ProviderRead } from '../../../shared/engines.ts'
import { modelTitle } from '../../../shared/models.ts'
import { dialOf, landOnModel, landOnProvider, pressable } from './dial.ts'

// THE THREE PILLS (provider, model, effort) in the chat box. One drop-up body serves all three, so they read as one
// control split in three: rows with a check on the current one, an honest empty line where a control does not apply
// (a model with no reasoning dial). They CASCADE: the provider scopes the model list, the model scopes the effort ladder,
// because the ladders genuinely differ per model and a shared list would offer rungs the engine drops in silence.
// The list reads come from GET /api/chats/providers (server/chat/engines/catalog.ts); nothing is typed here.

const PATH = {
  server: 'M2.5 3.5h11v3.5h-11zM2.5 9h11v3.5h-11zM4.5 5.25h.01M4.5 10.75h.01',
  chip: 'M5 5h6v6H5zM7 2.5v2.5M9 2.5v2.5M7 11v2.5M9 11v2.5M2.5 7h2.5M2.5 9h2.5M11 7h2.5M11 9h2.5',
  flame: 'M8 2.5c.5 2.2 3.5 3.6 3.5 6.7a3.5 3.5 0 0 1-7 0c0-1.5.8-2.5 1.5-3.2.2 1 .7 1.6 1.2 1.9C7.3 6.3 7.5 4.5 8 2.5z',
  check: 'M3.5 8.5l3 3 6-7',
  up: 'M4.5 9.5L8 6l3.5 3.5',
}
const Ico = ({ d, cls = '' }: { d: string; cls?: string }) => <svg className={`ico chats-pi ${cls}`} viewBox="0 0 16 16" aria-hidden><path d={d} /></svg>

type Row = { id: string; name: string; note?: string; warn?: boolean; off?: boolean }

function Pill({ icon, label, tip, rows, current, onPick, empty, flex }: {
  icon: keyof typeof PATH; label: string; tip: string; rows: Row[]; current: string; onPick: (id: string) => void; empty: string; flex?: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', out); window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', out); window.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <span ref={box} className="chats-pillbox">
      <button className={`chats-pill ${flex ? 'flex' : ''}`} title={tip} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Ico d={PATH[icon]} />
        <span className="chats-pill-l">{label}</span>
        <Ico d={PATH.up} cls="dim" />
      </button>
      {open && (
        <div className="pop chats-pm" role="listbox">
          {rows.length === 0
            ? <div className="chats-pm-note">{empty}</div>
            : rows.map(r => (
              <button key={r.id} role="option" aria-selected={r.id === current} disabled={r.off} className={`pop-row chats-pm-row ${r.id === current ? 'on' : ''} ${r.off ? 'off' : ''}`} title={r.note}
                onClick={() => { setOpen(false); onPick(r.id) }}>
                <span className="chats-pm-t"><span className="nm">{r.name}</span>{r.note && <span className={`chats-pm-s ${r.warn ? 'warn' : ''}`}>{r.note}</span>}</span>
                {r.id === current && <Ico d={PATH.check} />}
              </button>
            ))}
        </div>
      )}
    </span>
  )
}

export function Pills({ providers, loading, error, running, effort, agentModel, agentEffort, onPick }: {
  providers: ProviderRead[] | undefined; loading: boolean; error: string | null
  running: string; effort: string | null; agentModel: string; agentEffort: string
  onPick: (p: { model?: string | null; effort?: string | null }) => void
}) {
  if (error || !providers) {
    return <span className="chats-pills"><button className="chats-pill" disabled title={error ? `providers failed: ${error}` : 'providers loading'}><Ico d={PATH.chip} /><span className="chats-pill-l">{error ? 'models failed' : loading ? 'models' : '...'}</span></button></span>
  }
  const d = dialOf(providers, running, effort, agentEffort)
  const note = (p: ProviderRead) => (p.state === 'ready' || p.state === 'unread' ? [p.note, capsNote(p.id)].filter(Boolean).join(' · ') : p.note ?? p.state)
  const provRows: Row[] = providers.map(p => ({ id: p.id, name: p.name, note: note(p) || undefined, warn: !pressable(p), off: !pressable(p) }))
  const models = d.provider?.read.models ?? []
  const modelRows: Row[] = [
    ...(running && !d.model && d.provider?.read.models.length ? [{ id: running, name: running, note: `not on ${d.provider.name}'s list`, warn: true }] : []),
    ...models.map(m => ({ id: m.id, name: m.name, note: m.description || undefined })),
  ]
  const effortRows: Row[] = (d.ladder ?? []).map(id => ({ id, name: id }))
  const capNote = capsNote(d.engine)
  const provLabel = ENGINE_LABEL[d.engine as EngineId]
  const unread = d.provider && (!pressable(d.provider) || d.provider.read.error)
  const cannot = !!d.provider && !pressable(d.provider)
  return (
    <span className="chats-pills">
      <Pill icon="server" label={provLabel} flex={false}
        tip={`Provider: ${provLabel}${capNote ? `\n${capNote}` : ''}${unread ? `\n${d.provider!.note ?? d.provider!.read.error}` : ''}\npicking one lands on its first model and reboots the hand`}
        rows={provRows} current={d.engine} empty="no provider is available"
        onPick={id => {
          const next = landOnProvider(providers, id as EngineId, agentModel)
          if (next === undefined) return
          onPick({ model: next })
        }} />
      <Pill icon="chip" flex label={d.model?.name ?? (running ? running.replace(/^[a-z]+:/, '') : 'model')}
        tip={`Model: ${d.provider ? modelTitle(models, running) : running} (default ${agentModel})${d.provider?.read.error ? `\n${d.provider.read.error}` : ''}`}
        rows={modelRows} current={running} empty={`no ${provLabel} models: ${d.provider?.note ?? d.provider?.read.error ?? 'its list is empty'}`}
        onPick={id => onPick({ model: landOnModel(id, agentModel) })} />
      <Pill icon="flame" label={d.ladder === null ? (cannot ? 'n/a' : effort || agentEffort || 'effort') : d.ladder.length ? d.effort : 'none'}
        tip={d.ladder === null ? (cannot ? `Effort: ${provLabel} cannot run here, so its ladder is unknown` : 'Effort: the model list has not loaded') : d.ladder.length ? `Effort: ${d.effort}${effort ? '' : ` (the roster's ${agentEffort || 'default'})`}\n${d.running} takes ${d.ladder.join(', ')}` : `${d.running} takes no effort level`}
        rows={effortRows} current={d.effort} empty="this model has no reasoning dial"
        onPick={id => onPick({ effort: id })} />
    </span>
  )
}

/** GET /api/chats/providers */
export type ProvidersRead = { providers: ProviderRead[] }
