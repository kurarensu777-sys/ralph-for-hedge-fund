import { useEffect, useState, type ReactNode } from 'react'
import type { LibBooks, LibSearch } from '../../../server/library/types.ts'
import { api, useApi } from '../../lib/api.ts'
import { Empty } from '../../ui/kit.tsx'
import { useOpenBook } from './Book.tsx'
import { toneFor } from './state.ts'

/** full-text hits across every book body; the query is debounced, the index lives in fundd */
export function SearchView({ q }: { q: string }) {
  const [res, setRes] = useState<{ q: string; data: LibSearch | null; error: string | null }>({ q: '', data: null, error: null })
  const shelves = useApi<LibBooks>('/api/library/books', ['library'])
  const open = useOpenBook()
  const ids = shelves.data?.shelves.map(s => s.id) ?? []
  const want = q.trim()

  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      api<LibSearch>(`/api/library/search?q=${encodeURIComponent(want)}&limit=100`)
        .then(d => { if (live) setRes({ q: want, data: d, error: null }) })
        .catch((e: any) => { if (live) setRes({ q: want, data: null, error: String(e?.message ?? e) }) })
    }, 180)
    return () => { live = false; clearTimeout(t) }
  }, [want])

  if (res.error && res.q === want) return <Empty state="failed">{res.error}</Empty>
  const d = res.data
  if (!d) return <Empty state="loading" skel="table" />
  if (d.terms.length === 0) return <Empty>two letters or more</Empty>
  return (
    <div className="library-room library-hits">
      <div className="library-filterline">
        <span className="faint">text</span><b>{d.terms.join(' + ')}</b>
        <span className="faint" title={`${d.indexed} books indexed (a book written as chapters, chapter by chapter), ${d.ms} ms`}>{d.total > d.hits.length ? `${d.hits.length} of ${d.total}` : d.total}</span>
        {res.q !== want && <span className="faint">...</span>}
      </div>
      {d.hits.length === 0 && <Empty>no chapter or book holds every term</Empty>}
      {d.hits.map(h => (
        <button key={h.chapter ? `${h.path}#${h.chapter.slug}` : h.path} className="library-hit" onClick={() => open(h.chapter ? `${h.path}#${h.chapter.slug}` : h.path, h.book || h.title)} title={h.chapter ? `${h.path}#${h.chapter.slug}` : h.path}>
          <span className="library-hit-h">
            <span className="library-swatch" style={{ background: toneFor(ids, h.shelf) }} />
            <span className="t">{h.book || h.title /* an older fundd sends no `book` for a few minutes after a UI build */}</span>
            {h.chapter && <span className="library-hit-ch">{h.chapter.title}</span>}
            <span className="tag faint">{h.series}</span>
            <span className="n mono" title="term hits in the body">{h.hits}</span>
          </span>
          <span className="library-hit-s">{marked(h.snippet, h.marks)}</span>
        </button>
      ))}
    </div>
  )
}

/** the snippet with its marked ranges wrapped (the server merged them, sorted) */
function marked(text: string, marks: [number, number][]) {
  const out: ReactNode[] = []
  let at = 0
  marks.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a))
    out.push(<mark key={i}>{text.slice(a, b)}</mark>)
    at = b
  })
  if (at < text.length) out.push(text.slice(at))
  return out
}
