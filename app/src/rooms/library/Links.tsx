import type { LibLinks, LinkFault } from '../../../server/library/types.ts'
import { useApi } from '../../lib/api.ts'
import { Dot, Empty, Load } from '../../ui/kit.tsx'
import { useOpenBook } from './Book.tsx'
import { setLib, toneFor, useLib } from './state.ts'

// The link audit: one chip in the Head, one table in Main. Read-only.

const TOPICS = ['library', 'config']
export function useLinks() { return useApi<LibLinks>('/api/library/links', TOPICS) }

const WHY: Record<LinkFault, string> = {
  'unlisted': 'no row in its _series.md',
  'dead-row': 'a _series.md row names a file that does not exist',
  'dead-recall': 'a Recall row in a CLAUDE.md names a file that does not exist',
  'dead-boot': 'a boot list names something that is not a book',
  'dead-anchor': 'a boot list or Recall row names <book>#<chapter>, and the book has no such ## heading',
  'dead-import': 'an @import line loads a file that does not exist, resolved from the importing file',
  'unreached': 'no Recall row, boot list or other book cites it or its series',
  'no-index': 'a series folder with no _series.md',
  'no-topic': 'a book on a shelf that names topics, carrying none',
  'bad-topic': 'a topic off its shelf list, or more than three',
  'bad-vocab': 'the shelf topic list itself is unsound',
}

export function LinksChip() {
  const q = useLinks()
  const { view } = useLib()
  const n = q.data?.rows.length
  const s = q.error && !q.data ? 'unknown' : n === undefined ? 'unknown' : n ? 'fail' : 'ok'
  const title = q.error && !q.data ? `link audit failed: ${q.error}`
    : q.data ? `${n} link faults · ${q.data.books} books · ${q.data.series} series · ${q.data.claude} CLAUDE.md` : 'link audit loading'
  return (
    <button className={`btn library-lk-chip ${view === 'links' ? 'on' : ''}`} title={title}
      onClick={() => setLib({ view: view === 'links' ? 'shelves' : 'links', text: false })}>
      <Dot s={s} title={title} />Links {n ?? '?'}
    </button>
  )
}

export function LinksView({ ids }: { ids: string[] }) {
  const q = useLinks()
  const { q: needle } = useLib()
  const open = useOpenBook()
  return (
    <Load q={q} skel="table">
      {d => {
        const t = needle.trim().toLowerCase()
        const rows = d.rows.filter(r => !t || `${r.fault} ${r.path} ${r.target ?? ''} ${r.agent ?? ''}`.toLowerCase().includes(t))
        if (!rows.length) return <Empty title={t ? 'NO MATCH' : 'NO FAULTS'} />
        return (
          <div className="library-rt">
            <div className="lbox library-rt-list">
              <div className="library-lk-row lbox-hd cap"><span>Book</span><span>Fault</span><span>Shelf</span><span /></div>
              {rows.map((r, i) => (
                <div key={i} className="library-lk-row">
                  <span className="library-lk-p mono" title={[r.path, r.target && `${/^dead/.test(r.fault) ? 'missing: ' : ''}${r.target}`, r.agent && `agent: ${r.agent}`].filter(Boolean).join('\n')}>
                    {r.agent ? <span className="library-lk-who">{r.agent}</span> : <span className="library-lk-path">{r.path}</span>}
                    {r.target && <span className="library-lk-miss">{r.target}</span>}
                  </span>
                  <span className={`tag caps library-lk-f ${/^dead/.test(r.fault) ? 'fail' : r.fault === 'unlisted' || r.fault === 'no-index' || /topic|vocab/.test(r.fault) ? 'warn' : ''}`} title={WHY[r.fault]}>{r.fault}</span>
                  <span className="library-lk-s" title={r.shelf ?? 'no shelf'}>
                    {r.shelf ? <span className="library-swatch" style={{ background: toneFor(ids, r.shelf) }} /> : <span className="faint">-</span>}
                  </span>
                  <span className="a">
                    {r.book && <button className="btn sm" onClick={() => open(r.book!)} title={`open ${r.book}`}>Open</button>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )
      }}
    </Load>
  )
}
