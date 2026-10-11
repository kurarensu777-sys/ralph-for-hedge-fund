import { useState } from 'react'
import { api, relTime, useApi, useStored } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { categoryOf, isKnownAgent } from '../../ui/categories.ts'
import { Dot, Icon } from '../../ui/kit.tsx'
import { Avatar } from './Avatar.tsx'
import { openItem } from './ItemDrawer.tsx'
import { sugMatches, useFilter } from './state.ts'

// SUGGESTED: the debt scanner's findings (server/board/debt.ts). They live in SQLite, not in
// app/board/, so auto-pickup never sees one. Adopt files a backlog item; x (dismiss) hides it forever.

export type Suggestion = {
  fp: string; source: 'file' | 'loop' | 'lab'; kind: string; path: string; line: number | null
  ref: string; quote: string; title: string; owner: string | null; first_seen: number
}
type Scan = { ts: number; files: number; visited: number; capped: boolean; errors: string[]; ms: number; found: number }
type Payload = { suggestions: Suggestion[]; scan: Scan | null; scanning: boolean; everyS: number }

export const useSuggested = () => useApi<Payload>('/api/board/suggested', ['board:suggested'])

const scanTitle = (d: Payload | null, err: string | null) => {
  if (err && !d) return `Suggestions failed: ${err}`
  if (!d?.scan) return 'Never scanned. Click to scan now'
  const s = d.scan
  return [
    `Scanned ${relTime(s.ts)}: ${s.files} debt files of ${s.visited} walked${s.capped ? ' (CAPPED at 2,000)' : ''}, ${s.ms} ms`,
    `Every ${Math.round(d.everyS / 60)} min. Click to scan now`,
    ...s.errors.map(e => `error: ${e}`),
  ].join('\n')
}

export function SuggestedLane() {
  const q = useSuggested()
  const nav = useNav()
  const [open, setOpen] = useStored('board.sugOpen', true)
  const [busy, setBusy] = useState<string | null>(null)
  const f = useFilter()
  const d = q.data
  const all = d?.suggestions ?? []
  // the pill's text filters this lane too (title, quote, path), so its count follows the filter
  const filtering = !!f.q.trim()
  const list = filtering ? all.filter(s => sugMatches(s, f.q)) : all
  const n = d ? list.length : null
  const ofAll = filtering && d ? `${list.length} of ${all.length} match "${f.q.trim()}"` : ''
  const scanning = !!d?.scanning || busy === 'scan'
  const failed = !!q.error && !d
  const unknown = !!d && !d.scan
  const bad = !!d?.scan?.errors.length

  const act = async (key: string, path: string, done?: (r: any) => void) => {
    setBusy(key)
    try { const r = await api(path, { body: {} }); done?.(r); q.reload() } catch (e: any) { nav.toast(e.message, true) } finally { setBusy(null) }
  }
  const scanNow = () => act('scan', '/api/board/suggested/scan')

  const mark = failed ? <Dot s="fail" title={q.error ?? 'failed'} />
    : scanning ? <Dot s="run" title="scanning" />
    : unknown ? <Dot s="unknown" title="never scanned" />
    : bad ? <Dot s="warn" title={d!.scan!.errors.join('\n')} /> : null

  // empty (or failed, or never scanned) folds to the same slim rail the empty columns use
  if (!open || !n) {
    return (
      <section className="lane board-col shut board-sug">
        <button className="lane-h cap board-col-h board-shut" title={n ? `Suggested: show${ofAll ? ` (${ofAll})` : ''}` : ofAll && all.length ? `Suggested: ${ofAll}` : scanTitle(d, q.error)}
          onClick={() => (n ? setOpen(true) : ofAll && all.length ? undefined : scanNow())}>
          <span className="t">Suggested</span>{mark}<span className="lane-n">{n ?? (failed ? '!' : '·')}</span>
        </button>
      </section>
    )
  }
  return (
    <section className="lane board-col board-sug">
      <header className="lane-h cap board-col-h" title="Debt the tree states about itself. Adopt files it in Backlog; x hides it for good">
        <span className="t">Suggested</span><span className="lane-n" title={ofAll || undefined}>{n}</span>{mark}
        <button className="ibox board-sug-ib" title={scanTitle(d, q.error)} onClick={scanNow} disabled={scanning} aria-label="scan"><Icon name="scan" /></button>
        <button className="lnk dim board-link" title="Collapse" onClick={() => setOpen(false)}>hide</button>
      </header>
      <div className="lane-b board-cards">
        {list.map(s => {
          const color = s.owner && isKnownAgent(s.owner) ? `var(--c-${categoryOf(s.owner).id})` : 'var(--c-execution)'
          const where = s.source === 'file' ? `${s.path}${s.line ? `:${s.line}` : ''}` : `${s.source}: ${s.path}`
          // the real board card, ghosted: 60% opacity, its category top edge dashed
          return (
            <article key={s.fp} className={`board-card board-sug-card ${busy === s.fp ? 'busy' : ''}`}
              style={{ ['--c' as string]: color }}
              title={`${s.title}\n\n${where}\n${s.quote}\nfirst seen ${relTime(s.first_seen)}`}>
              <div className="board-card-top">
                <span className="tag sm board-kind k-sug">{s.kind}</span>
                <span className="sp" />
                <span className="board-sug-acts">
                  <button className="board-sug-adopt" title={`Adopt: file in Backlog${s.owner ? ` for ${s.owner}` : ''}`} disabled={!!busy}
                    onClick={() => act(s.fp, `/api/board/suggested/${s.fp}/start`, r => { nav.toast(`${r.item.id} filed`); openItem(nav, r.item.id, where) })}>Adopt</button>
                  <button className="board-sug-x" title="Dismiss for good (returns only if its text changes)" aria-label="dismiss" disabled={!!busy}
                    onClick={() => act(s.fp, `/api/board/suggested/${s.fp}/dismiss`)}><Icon name="x" /></button>
                </span>
              </div>
              <div className="board-card-t">{s.title}</div>
              <div className="board-card-m">
                <Avatar id={s.owner ?? ''} size={16} />
                <span className="board-age">{relTime(s.first_seen)}</span>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
