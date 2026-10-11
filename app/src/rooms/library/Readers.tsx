import { useMemo } from 'react'
import type { LibBook, LibBooks } from '../../../server/library/types.ts'
import { Empty, markOf } from '../../ui/kit.tsx'
import { useOpenBook } from './Book.tsx'
import { isFiltered, matcher, nested, readerTags, recallWho, type Facets } from './facets.ts'
import { chapterNote, FilterLine } from './Shelves.tsx'
import { fmtTok, toneFor, useLib } from './state.ts'
import { TagView } from './Tags.tsx'

/** the books some agent MUST read (in a boot list, or named by a Recall row), one line each, grouped by
 *  shelf: who boots with it, who a Recall row sends there and from which CLAUDE.md. Replaces the Matrix
 *  grid (2026-09-26); boot lists are edited in the Agents view and the book drawer */
export function ReadersView({ data }: { data: LibBooks }) {
  const lib = useLib()
  const open = useOpenBook()
  const ids = data.shelves.map(s => s.id)
  const facets: Facets = { shelf: lib.shelf, topics: lib.topics, who: lib.who, need: lib.need, read: lib.read, type: lib.type, q: lib.q }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const match = useMemo(() => matcher(data, facets), [data, lib.shelf, lib.topics, lib.who, lib.need, lib.read, lib.type, lib.q])
  const must = data.books.filter(b => b.readers.length > 0 || b.recall.length > 0)
  const rows = must.filter(match)
  const rc = (b: LibBook) => recallWho(b, data.loads)
  const reach = (b: LibBook) => new Set([...b.readers, ...(rc(b) ?? [])]).size
  const byShelf = ids.map(id => ({ id, books: nested(rows.filter(b => b.shelf === id).sort((x, y) => reach(y) - reach(x) || x.title.localeCompare(y.title))) })).filter(g => g.books.length)
  return (
    <div className="library-room">
      <FilterLine data={data} shown={rows.length} total={must.length} hideToggle={false} />
      {!must.length && <Empty title="NONE">no book is in a boot list or a Recall row</Empty>}
      {must.length > 0 && !rows.length && <Empty title="NO MATCH">{isFiltered(facets) ? 'no must-read book matches the filter' : ''}</Empty>}
      {byShelf.map(g => (
        <div key={g.id} className="lbox library-rd">
          <div className="library-rd-sh cap"><span className="library-swatch" style={{ background: toneFor(ids, g.id) }} />{data.shelves.find(s => s.id === g.id)?.title ?? g.id}</div>
          {g.books.map(({ book: b, depth }) => {
            const r = rc(b)
            const tags = readerTags(b, r, data.agents, markOf)
            const boot = tags.filter(t => t.kind === 'boot'), recall = tags.filter(t => t.kind !== 'boot')
            const files = [...new Set(b.recall.map(x => x.file))].join(', ')
            const n = reach(b)
            return (
              <button key={b.path} className={`library-rd-row ${depth ? 'sub' : ''}`} onClick={() => open(b.path, b.title)} title={b.path}>
                <span className="t">{b.title}{chapterNote(b, lib.q) && <span className="library-chn">{chapterNote(b, lib.q)}</span>}</span>
                <span className="n" title={`${n} of ${data.agents.length} agents must read it · ${b.tokens.toLocaleString()} tokens`}>{n}/{data.agents.length} · {fmtTok(b.tokens)}</span>
                <span className="tags">
                  {boot.length > 0 && <><span className="k">boot</span>{boot.map((t, i) => <TagView key={i} t={t} lens={lib.who} />)}</>}
                  {recall.length > 0 && <><span className="k">recall</span>{recall.map((t, i) => <TagView key={i} t={t} lens={lib.who} />)}<span className="f" title={b.recall.map(x => `${x.file}: ${x.moment}`).join('\n')}>{files}</span></>}
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
