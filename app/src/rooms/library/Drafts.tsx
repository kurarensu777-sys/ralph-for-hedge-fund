import { useState } from 'react'
import type { LibBooks, LibDraft, LibDrafts } from '../../../server/library/types.ts'
import { api, relTime, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Btn, Empty, FailLine, Glyph, Load } from '../../ui/kit.tsx'
import { TextEditor } from './Book.tsx'
import { toneFor } from './state.ts'

export function useDrafts() { return useApi<LibDrafts>('/api/library/drafts', ['library']) }

/** the body under the title line, flattened, for a two-line preview */
const preview = (book: string) => book.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim()
const whenOf = (row: string) => row.replace(/^\||\|$/g, '').split('|').pop()?.trim() ?? ''

/** books drafted from the owner's own corrections: Save commits book + series row, Dismiss writes nothing */
export function DraftsView({ data }: { data: LibBooks }) {
  const q = useDrafts()
  const ids = data.shelves.map(s => s.id)
  return (
    <Load q={q} skel="cards">
      {d => (
        <div className="library-dr">
          <div className="library-rt-head mono">
            <span><b>{d.drafts.length}</b> open</span>
            <span className="ok" title="saved into the library"><b>{d.saved}</b> saved</span>
            <span title="dismissed, nothing written"><b>{d.dismissed}</b> dismissed</span>
            <span className="faint" title={d.lastScan ? `scanned ${new Date(d.lastScan.ts).toISOString()}${d.lastScan.cost >= 0 ? `, $${d.lastScan.cost.toFixed(3)}` : ''}` : 'the detector has never run'}>
              {d.lastScan ? `scan ${relTime(d.lastScan.ts)}` : 'never scanned'}
            </span>
          </div>
          {d.drafts.length === 0
            ? <Empty title={d.lastScan ? 'NO DRAFTS' : 'NOT SCANNED'} state={d.lastScan ? 'empty' : 'unknown'} />
            : <div className="library-dr-grid">{d.drafts.map(x => <Card key={x.id} d={x} tone={toneFor(ids, x.shelf)} shelf={data.shelves.find(s => s.id === x.shelf)?.title ?? x.shelf} />)}</div>}
        </div>
      )}
    </Load>
  )
}

function Card({ d, tone, shelf }: { d: LibDraft; tone: string; shelf: string }) {
  const { toast, openDrawer } = useNav()
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (action: 'save' | 'dismiss') => {
    setBusy(action)
    try {
      const r = await api<LibDraft>(`/api/library/drafts/${d.id}/${action}`, { body: {} })
      toast(action === 'save' ? `committed ${r.sha ?? ''}` : 'dismissed')
    } catch (e: any) { toast(`${action} failed: ${e.message ?? e}`, true) } finally { setBusy(null) }
  }
  const edit = () => openDrawer({ title: <span title={d.path}>{d.title || 'Draft'}</span>, body: <DraftEdit d={d} onDone={() => openDrawer(null)} /> })
  const lvl = d.level === 'agent' ? 'own shelf' : d.level === 'role' ? 'role shelf' : 'fund shelf'
  return (
    <div className="card pad library-dr-card">
      <div className="library-dr-top">
        <span className="pill out library-dr-shelf" title={`${d.path}\nfiled at the ${lvl}`}><span className="library-swatch" style={{ background: tone }} />{shelf}</span>
        <span className="library-dr-lvl mono" title={`the lesson holds at: ${d.level}`}>{d.level}</span>
        <span className="library-dr-who" title={`conversation ${d.conv}`}><Glyph id={d.agent} /></span>
        <span className="faint mono" title={new Date(d.ts).toISOString()}>{relTime(d.ts)}</span>
      </div>
      <div className="library-dr-t" title={`the owner: "${d.quote}"`}>{d.title}</div>
      <div className="library-dr-p" title={`the owner: "${d.quote}"`}>{preview(d.book)}</div>
      <div className="library-dr-when" title="the moment-line for _series.md">{whenOf(d.seriesRow)}</div>
      {d.error && <FailLine what="save" detail={d.error} />}
      <div className="library-dr-bar">
        <Btn sm kind="primary" disabled={!!busy} onClick={() => act('save')} title={`Commit ${d.path} and its _series.md row, one commit`}>{busy === 'save' ? 'Saving' : 'Save'}</Btn>
        <Btn sm disabled={!!busy} onClick={edit} title="Edit the draft before saving">Edit</Btn>
        <Btn sm kind="ghost" disabled={!!busy} onClick={() => act('dismiss')} title="Drop it. Nothing is written">Dismiss</Btn>
      </div>
    </div>
  )
}

/** the book editor, loaded with the draft; its Save updates the draft, the card's Save commits */
function DraftEdit({ d, onDone }: { d: LibDraft; onDone: () => void }) {
  const { toast } = useNav()
  const [path, setPath] = useState(d.path)
  const [row, setRow] = useState(d.seriesRow)
  return (
    <div className="library-book">
      <div className="cap library-k">Path</div>
      <input className="input mono library-dr-in" value={path} onChange={e => setPath(e.target.value)} title="A new .md under a library shelf" />
      <div className="cap library-k">Series row</div>
      <input className="input mono library-dr-in" value={row} onChange={e => setRow(e.target.value)} title="| `file.md` | read when |" />
      <div className="cap library-k">Text</div>
      <TextEditor initial={d.book} changed={path !== d.path || row !== d.seriesRow} label="Update" saveTitle="Keep these edits on the draft (Ctrl+S). Nothing is written until Save" onDone={onDone}
        save={async text => {
          await api(`/api/library/drafts/${d.id}/edit`, { body: { book: text, seriesRow: row, path } })
          toast('draft updated')
        }} />
    </div>
  )
}
