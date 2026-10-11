import { useState } from 'react'
import type { LibBooks, RetireRow } from '../../../server/library/types.ts'
import { api, relTime } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Btn, Empty, Load } from '../../ui/kit.tsx'
import { useOpenBook } from './Book.tsx'
import { PmBar, useOutcomes } from './Outcome.tsx'
import { shortTitle } from './spine.ts'
import { toneFor, useLib } from './state.ts'

const sign = (x: number | null) => (x === null ? '-' : `${x > 0 ? '+' : ''}${x.toFixed(2)}`)

/** books the owner may choose to retire: harmful more than the base rate, or never read */
export function RetireView({ data }: { data: LibBooks }) {
  const q = useOutcomes()
  const { q: needle } = useLib()
  const ids = data.shelves.map(s => s.id)
  return (
    <Load q={q} skel="table">
      {o => {
        const t = needle.trim().toLowerCase()
        const rows = o.queue.filter(r => !t || `${r.title} ${r.path}`.toLowerCase().includes(t))
        return (
          <div className="library-rt">
            <div className="library-rt-head mono">
              <span title="conversations graded (every conversation the cockpit knows)"><b>{o.sessions}</b> sessions</span>
              <span className="ok" title="landed a commit still standing after 7 days"><b>{o.helpful}</b> helpful</span>
              <span className="fail" title="reverted, logged an error, or a commit later loop-reverted"><b>{o.harmful}</b> harmful</span>
              <span title="harmful rate across every conversation">base <b>{o.base === null ? '-' : `${Math.round(o.base * 100)}%`}</b></span>
              <span className="faint" title="n below this is dashed and never queued">n&ge;{o.min}</span>
            </div>
            {rows.length === 0
              ? <div title={o.unreadNote ?? (t ? 'no match' : 'no book is below base or unread')}><Empty title={o.unreadNote ? 'UNREAD ?' : 'NONE'} state={o.unreadNote ? 'unknown' : 'empty'} /></div>
              : (
                <div className="lbox library-rt-list">
                  <div className="library-rt-row lbox-hd cap">
                    <span>Book</span><span className="c">Pulls</span><span>+/-</span><span className="c">Net</span><span>Why</span><span />
                  </div>
                  {rows.map(r => <Row key={r.path} r={r} tone={toneFor(ids, r.shelf)} min={o.min} base={o.base} />)}
                  {o.unreadNote && <div className="library-rt-note faint mono">{o.unreadNote}</div>}
                </div>
              )}
            {o.cold.length > 0 && (
              <>
                <div className="cap library-k">Cold</div>
                <div className="lbox library-rt-list">
                  {o.cold.map(c => <Cold key={c.path} path={c.path} title={c.title} n={c.n} ts={c.ts} note={c.note} tone={toneFor(ids, data.books.find(b => b.path === c.path)?.shelf ?? '')} />)}
                </div>
              </>
            )}
          </div>
        )
      }}
    </Load>
  )
}

function Row({ r, tone, min, base }: { r: RetireRow; tone: string; min: number; base: number | null }) {
  const { toast } = useNav()
  const open = useOpenBook()
  const [arm, setArm] = useState(false)
  const [busy, setBusy] = useState(false)
  const act = async (path: string, body: object, done: string) => {
    setBusy(true)
    try { await api(path, { body }); toast(done) } catch (e: any) { toast(`failed: ${e.message ?? e}`, true) } finally { setBusy(false); setArm(false) }
  }
  const kept = () => setArm(false)
  return (
    <div className={`library-rt-row ${arm ? 'arm' : ''}`}>
      <button className="t" onClick={() => open(r.path, r.title)} title={r.path}>
        <span className="library-swatch" style={{ background: tone }} />{shortTitle(r.title)}
      </button>
      <span className="c mono">{r.pulls}</span>
      <PmBar o={r} min={min} />
      <span className={`c mono ${r.net !== null && r.net < 0 ? 't-fail' : ''}`} title={base === null ? 'no base rate' : `harmful rate ${r.n ? Math.round(r.harmful / r.n * 100) : 0}% vs base ${Math.round(base * 100)}%`}>{sign(r.net)}</span>
      <span className={`tag caps library-rt-why ${r.reason === 'harm' ? 'fail' : 'faint'}`} title={r.why}>{r.reason === 'harm' ? 'harm' : 'unread'}</span>
      <span className="a">
        {arm
          ? <>
              <Btn sm kind="danger" disabled={busy} onClick={() => act('/api/library/retire', { path: r.path, note: r.why }, `retired ${shortTitle(r.title)}`)} title="Out of every boot list. The file stays">Retire</Btn>
              <Btn sm kind="ghost" disabled={busy} onClick={kept}>Cancel</Btn>
            </>
          : <>
              <Btn sm onClick={() => setArm(true)} title="Take it out of every boot list (the file is never touched)">Retire</Btn>
              <Btn sm kind="ghost" onClick={() => toast(`kept ${shortTitle(r.title)}`)} title="Leave it as it is">Keep</Btn>
            </>}
      </span>
    </div>
  )
}

function Cold({ path, title, n, ts, note, tone }: { path: string; title: string; n: number; ts: number; note: string | null; tone: string }) {
  const { toast } = useNav()
  const open = useOpenBook()
  const [busy, setBusy] = useState(false)
  const restore = async () => {
    setBusy(true)
    try { await api('/api/library/unretire', { body: { path } }); toast(`restored ${shortTitle(title)}`) } catch (e: any) { toast(`failed: ${e.message ?? e}`, true) } finally { setBusy(false) }
  }
  return (
    <div className="library-rt-row cold">
      <button className="t" onClick={() => open(path, title)} title={[path, note].filter(Boolean).join('\n')}>
        <span className="library-swatch" style={{ background: tone }} />{shortTitle(title)}
      </button>
      <span className="mono faint library-rt-cold" title={new Date(ts).toISOString()}>cold at n={n} · {relTime(ts)}</span>
      <span className="a"><Btn sm disabled={busy} onClick={restore} title="Back into the boot lists it was taken out of">Unretire</Btn></span>
    </div>
  )
}
