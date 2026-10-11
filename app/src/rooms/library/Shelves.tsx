import { distinctLabels, sharedSuffix } from './spine.ts'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { LibBook, LibBooks } from '../../../server/library/types.ts'
import { api, relTime } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Btn, Empty, Meter } from '../../ui/kit.tsx'
import { useOpenBook } from './Book.tsx'
import { useOutcomes } from './Outcome.tsx'
import { clearFilters, fmtTok, setLib, toneFor, useLib } from './state.ts'
import { chapterHits, isFiltered, matcher, nested, recallWho, type Facets } from './facets.ts'
import { ReaderTags } from './Tags.tsx'

const H_MIN = 104, H_MAX = 180

/** taller spines on a taller pane (1080p and up), so the wall fills the room instead of its top half */
function useSpineScale() {
  const get = () => Math.max(1, Math.min(1.8, (window.innerHeight - 380) / 400))
  const [k, setK] = useState(get)
  useEffect(() => { const f = () => setK(get()); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  return k
}

/** a spine's look: its height by tokens; its title FITS - one line when it can, else two lines on a wider
 *  spine, else smaller type, never cut to "Directional engine engin..." (about 6px a character at 10.5px) */
function spineBox(b: LibBook, label: string, maxTok: number, scale: number) {
  const h = (H_MIN + (H_MAX - H_MIN) * Math.sqrt(b.tokens / maxTok)) * scale
  const room = h - 34, need = label.length * 6
  const fit = need <= room ? '' : need <= room * 2 ? 'two' : 'two tight'
  const w = Math.max(fit === 'two' ? 30 : fit ? 40 : 24, 24 + Math.min(14, Math.round(b.tokens / 700)))
  return { h, w, fit }
}

/** a real bookshelf: one case per shelf, books as spines, series split by bookends, and under every book,
 *  on its ledge, who must read it (Tags.tsx). A filter fades the books outside it, or takes them off
 *  the wall (hide) */
export function ShelvesView({ data }: { data: LibBooks }) {
  const lib = useLib()
  const { shelf: only, who, hide } = lib
  const open = useOpenBook()
  const scale = useSpineScale()
  const [tip, setTip] = useState<{ b: LibBook; x: number; y: number } | null>(null)
  const ids = data.shelves.map(s => s.id)
  const maxTok = useMemo(() => Math.max(1, ...data.books.map(b => b.tokens)), [data.books])
  const facets: Facets = { shelf: null, topics: lib.topics, who, need: lib.need, read: lib.read, type: lib.type, q: lib.q }
  const filtered = isFiltered(facets)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const match = useMemo(() => matcher(data, facets), [data, lib.topics, who, lib.need, lib.read, lib.type, lib.q])
  const rcOf = useMemo(() => new Map(data.books.map(b => [b.path, recallWho(b, data.loads)])), [data])
  const shelves = data.shelves.filter(s => !only || s.id === only)
  // the retire queue per shelf = the books flagged "due"; unknown outcomes show no chip (never a 0)
  const oc = useOutcomes()
  const due = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of oc.data?.queue ?? []) m.set(r.shelf, (m.get(r.shelf) ?? 0) + 1)
    return m
  }, [oc.data])
  useEffect(() => {
    if (!only) return
    document.getElementById(`library-case-${only}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [only])

  const cases = shelves.map(s => {
    const all = data.books.filter(b => b.shelf === s.id)
    return { s, all, shown: all.filter(match) }
  })
  const full = cases.filter(c => c.shown.length > 0)
  const bare = cases.filter(c => c.shown.length === 0)
  const nShown = cases.reduce((n, c) => n + c.shown.length, 0), nAll = cases.reduce((n, c) => n + c.all.length, 0)

  return (
    <div className="library-room">
      <FilterLine data={data} shown={nShown} total={nAll} />
      <div className="library-wall">
        {full.map(({ s, all, shown }) => {
          const tone = toneFor(ids, s.id)
          const on = new Set(shown.map(b => b.path))
          const books = filtered && hide ? shown : all
          const groups: { series: string; books: LibBook[] }[] = []
          for (const b of books) {
            const g = groups[groups.length - 1]
            if (g && g.series === b.series) g.books.push(b); else groups.push({ series: b.series, books: [b] })
          }
          // a strategy book stands under its parent (research.md), set a step lower on the shelf
          const sub = new Set<string>()
          for (const g of groups) { const n = nested(g.books); g.books = n.map(x => x.book); for (const x of n) if (x.depth) sub.add(x.book.path) }
          const nBoot = all.filter(b => (who ? b.readers.includes(who) : b.readers.length > 0)).length
          const nRecall = all.filter(b => (who ? !!rcOf.get(b.path)?.includes(who) : b.recall.length > 0)).length
          const suffix = sharedSuffix(all.map(b => b.title))
          const labels = distinctLabels(all.map(b => b.title))
          const label = (t: string) => { const l = labels.get(t) ?? t; return suffix && l.endsWith(suffix) && l.length > suffix.length ? l.slice(0, -suffix.length) : l }
          const box = new Map(books.map(b => [b.path, spineBox(b, label(b.title), maxTok, scale)]))
          const sh = Math.max(...[...box.values()].map(x => x.h)) + 8
          const dim = (b: LibBook) => (filtered && !on.has(b.path) ? 'dim' : '')
          return (
            <section key={s.id} className="library-case" id={`library-case-${s.id}`}>
              <div className="library-case-head" title={headTip(s.count, shown.length, filtered, s.tokens, nBoot, nRecall, who)}>
                <span className="library-swatch" style={{ background: tone }} />
                <span className="t">{s.title}</span>
                {s.dept.toLowerCase() !== s.title.toLowerCase() && <span className="d">{s.dept}</span>}
                <span className="n">{filtered ? `${shown.length}/${s.count}` : s.count} {s.count === 1 ? 'book' : 'books'}</span>
                <ReadBar books={all} tone={tone} tracked={!!data.tracking?.since} why={data.tracking ? 'no pull has ever been recorded' : data.trackingError} />
                {(due.get(s.id) ?? 0) > 0 && (
                  <button className="pill tint library-due" style={{ '--c': tone } as CSSProperties} onClick={() => setLib({ view: 'retire' })}
                    title={`${due.get(s.id)} queued to retire (harmful or unread); open the retire queue`}>{due.get(s.id)} due</button>
                )}
              </div>
              <TopicRow shelf={s} books={all} />
              <div className="library-back" style={{ '--sh': `${sh}px` } as CSSProperties}>
                {groups.map((g, gi) => (
                  <div key={g.series + gi} className="library-series" title={g.series}>
                    <div className="library-row">
                      {g.books.map(b => {
                        const { h, w, fit } = box.get(b.path)!
                        return (
                          <button key={b.path} className={`library-spine ${b.mark ? 'cold' : ''} ${sub.has(b.path) ? 'sub' : ''} ${dim(b)}`} style={{ '--c': tone, height: h, width: w } as CSSProperties}
                            onClick={() => open(b.path, b.title)}
                            onMouseMove={e => setTip({ b, x: e.clientX, y: e.clientY })}
                            onMouseLeave={() => setTip(null)} aria-label={b.title}>
                            <span className={`library-spine-t ${fit}`}>{label(b.title)}</span>
                          </button>
                        )
                      })}
                    </div>
                    <div className="library-ledge" />
                    <div className="library-tags">
                      {g.books.map(b => (
                        <div key={b.path} className={`library-tcell ${dim(b)}`} style={{ width: box.get(b.path)!.w }} title={filtered ? chapterNote(b, lib.q) : undefined}>
                          <ReaderTags b={b} rc={rcOf.get(b.path) ?? null} agents={data.agents} lens={who} max={3} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
      <ColdStrip books={data.books.filter(b => b.mark && match(b))} />
      {bare.length > 0 && (
        <div className="library-bares">
          {bare.map(({ s }) => (
            <span key={s.id} className="library-bare-case" id={`library-case-${s.id}`} title={s.roots.join('\n')}>
              <span className="library-swatch" style={{ background: toneFor(ids, s.id) }} />
              {s.title}<span className="faint">{s.count === 0 ? 'empty' : 'no match'}</span>
            </span>
          ))}
        </div>
      )}
      {shelves.length === 0 && <Empty>no shelves: no library folder holds a shelf</Empty>}
      {tip && <Tip b={tip.b} rc={rcOf.get(tip.b.path) ?? null} x={tip.x} y={tip.y} q={lib.q} />}
    </div>
  )
}

/** the shelf's topics as chips under its head, with counts; a click toggles one (OR among them). A shelf
 *  that names none shows nothing here (the side list says "no topics") */
function TopicRow({ shelf, books }: { shelf: LibBooks['shelves'][number]; books: LibBook[] }) {
  const { topics } = useLib()
  if (!shelf.topics) return null
  const toggle = (k: string) => setLib({ topics: topics.includes(k) ? topics.filter(x => x !== k) : [...topics, k] })
  const untagged = books.filter(b => !b.topics.length).length
  return (
    <div className="library-topics">
      {shelf.topics.map(t => {
        const k = `${shelf.id}/${t.id}`
        const n = books.filter(b => b.topics.includes(t.id)).length
        return (
          <button key={t.id} className={`library-tp ${topics.includes(k) ? 'on' : ''} ${n ? '' : 'zero'}`} onClick={() => toggle(k)}
            title={`${t.holds || t.id}\n${n} ${n === 1 ? 'book' : 'books'}`}>{t.id}<span className="c">{n}</span></button>
        )
      })}
      {untagged > 0 && <button className={`library-tp untagged ${topics.includes(`${shelf.id}/-`) ? 'on' : ''}`} onClick={() => toggle(`${shelf.id}/-`)}
        title="books on this shelf with no topics yet">untagged<span className="c">{untagged}</span></button>}
    </div>
  )
}

/** the active facets as removable chips, Clear, fade / hide, and "n of N books"; nothing when no facet is set */
export function FilterLine({ data, shown, total, hideToggle = true }: { data: LibBooks; shown: number; total: number; hideToggle?: boolean }) {
  const lib = useLib()
  const titleOf = (id: string) => data.shelves.find(s => s.id === id)?.title ?? id
  const since = data.tracking?.since ? new Date(data.tracking.since).toISOString().slice(0, 10) : null
  const chips: { k: string; label: string; tip?: string; off: () => void }[] = []
  if (lib.shelf) chips.push({ k: 'shelf', label: titleOf(lib.shelf), tip: 'shelf', off: () => setLib({ shelf: null }) })
  for (const t of lib.topics) {
    const [sh, id] = t.split('/')
    chips.push({ k: t, label: id === '-' ? 'untagged' : `#${id}`, tip: `topic on ${titleOf(sh)}`, off: () => setLib({ topics: lib.topics.filter(x => x !== t) }) })
  }
  if (lib.type) chips.push({ k: 'type', label: lib.type === 'guide' ? 'guides' : 'strategies', tip: 'type', off: () => setLib({ type: '' }) })
  if (lib.q.trim()) chips.push({ k: 'q', label: `"${lib.q.trim()}"`, off: () => setLib({ q: '' }) })
  const facet = !!(lib.topics.length || lib.who || lib.need || lib.read || lib.type || lib.q.trim())
  if (!chips.length && !facet) return null
  return (
    <div className="library-filterline">
      {chips.map(c => (
        <span key={c.k} className="library-fchip" title={c.tip}>{c.label}<button className="iconbtn" onClick={c.off} title="remove">x</button></span>
      ))}
      <button className="library-link" onClick={clearFilters} title="clear every filter">clear</button>
      {lib.read && !data.tracking && <span className="library-unknown" title={data.trackingError}>reads unknown</span>}
      {lib.read && since && <span className="library-unknown" title={`the read ledger holds ${data.tracking!.pulls} pulls since ${since}`}>reads since {since}</span>}
      <span className="library-count">
        {hideToggle && facet && <button className="library-link" onClick={() => setLib({ hide: !lib.hide })} title="books outside the filter: faded on the wall, or taken off it">{lib.hide ? 'show others' : 'hide others'}</button>}
        {shown} of {total} books
      </span>
    </div>
  )
}

function headTip(count: number, shown: number, filtered: boolean, tokens: number, boot: number, recall: number, who: string | null) {
  return [
    filtered ? `${shown} of ${count} books match` : `${count} books`,
    `${tokens.toLocaleString()} tokens (${fmtTok(tokens)})`,
    boot ? `${boot} loaded at boot by ${who ?? 'some agent'}` : '',
    recall ? `${recall} named by a Recall row${who ? ` ${who} loads` : ''}` : '',
  ].filter(Boolean).join('\n')
}

/** share of the shelf's books pulled in the last 30 days; hollow (never an empty-as-zero bar) when reads are unknown */
function ReadBar({ books, tone, tracked, why }: { books: LibBook[]; tone: string; tracked: boolean; why?: string }) {
  const known = tracked && books.every(b => !!b.use)
  if (!known || !books.length) {
    return <Meter v={null} sm title={books.length ? `no read ledger${why ? `: ${why}` : ''}` : 'no books'} />
  }
  const read = books.filter(b => (b.use?.n30 ?? 0) > 0).length
  return (
    <span className="library-readbar" style={{ '--c': tone } as CSSProperties}><Meter v={read / books.length} tone="c" sm title={`${read} of ${books.length} read in 30d`} /></span>
  )
}

/** retired books: dimmed on the wall, listed here with Unretire */
function ColdStrip({ books }: { books: LibBook[] }) {
  const { toast } = useNav()
  const [busy, setBusy] = useState<string | null>(null)
  if (!books.length) return null
  const restore = async (b: LibBook) => {
    setBusy(b.path)
    try { await api('/api/library/unretire', { body: { path: b.path } }); toast(`restored ${b.title}`) } catch (e: any) { toast(`failed: ${e.message ?? e}`, true) } finally { setBusy(null) }
  }
  return (
    <div className="library-cold">
      <span className="cap library-k">Cold</span>
      {books.map(b => (
        <span key={b.path} className="library-cold-b" title={[b.path, b.mark?.note, b.mark ? `retired ${new Date(b.mark.ts).toISOString()}` : ''].filter(Boolean).join('\n')}>
          <span className="nm">{b.title}</span><span className="faint mono">cold at n={b.mark!.n}</span>
          <Btn sm kind="ghost" disabled={busy === b.path} onClick={() => restore(b)} title="Back into the boot lists it was taken out of">Unretire</Btn>
        </span>
      ))}
    </div>
  )
}

/** "2 chapters match": under a book row when the text filter finds the query in its chapters' titles or Read when lines; '' when none do */
export function chapterNote(b: LibBook, q: string): string {
  const n = chapterHits(b, q).length
  return n ? `${n} ${n === 1 ? 'chapter matches' : 'chapters match'}` : ''
}

function Tip({ b, rc, x, y, q }: { b: LibBook; rc: string[] | null; x: number; y: number; q: string }) {
  const left = Math.min(x + 14, window.innerWidth - 340)
  const top = y + 16 + 180 > window.innerHeight ? y - 190 : y + 16
  const files = [...new Set(b.recall.map(r => r.file))].join(', ')
  return (
    <div className="pop library-tip" style={{ left, top }}>
      <div className="library-tip-t">{b.title}{b.mark && <span className="library-tip-cold mono">cold at n={b.mark.n}</span>}</div>
      <div className="library-tip-w">{b.readWhen || <span className="faint">no series row</span>}</div>
      {chapterNote(b, q) && <div className="library-tip-w acc">{chapterNote(b, q)}: {chapterHits(b, q).map(c => c.title).join(', ')}</div>}
      <div className="library-tip-m">
        <span>{b.series}</span><span>{fmtTok(b.tokens)} tok</span>
        <span>{b.topics.length ? b.topics.map(t => `#${t}`).join(' ') : 'no topics'}</span>
      </div>
      <div className="library-tip-m">
        <span className={b.readers.length ? 'acc' : ''}>{b.readers.length ? `boot: ${b.readers.join(', ')}` : 'no boot'}</span>
        {b.recall.length > 0 && <span className="acc">recall: {rc === null ? 'who is unknown' : rc.length ? `${rc.length} agents` : 'on demand'} ({files})</span>}
      </div>
      <div className="library-tip-m">
        {!b.use
          ? <span>reads unknown</span>
          : b.use.last === null
            ? <span>{b.use.lastBoot ? 'never pulled' : 'never read'}</span>
            : <><span className="acc">{b.use.n30} in 30d</span><span>last {relTime(b.use.last)}</span>{b.use.who.length > 0 && <span>{b.use.who.slice(0, 4).join(', ')}{b.use.who.length > 4 ? ` +${b.use.who.length - 4}` : ''}</span>}</>}
      </div>
    </div>
  )
}
