import { useEffect, useRef, type ReactNode } from 'react'
import { splitRef } from '../../../shared/bookmeta.ts'
import type { LibAgent, LibBooks, LibSearch, VetRow } from '../../../server/library/types.ts'
import { api, useApi, useStored } from '../../lib/api.ts'
import { useNav, useSel } from '../../shell/nav.tsx'
import { CardGroup, Dot, Empty, Glyph, HeatStrip, Live, Load, Seg } from '../../ui/kit.tsx'
import { CATEGORIES, categoryOf, type Category, type CategoryId } from '../../ui/categories.ts'
import { ChipSelect } from '../../ui/ChipSelect.tsx'
import { vetLabel } from './spine.ts'
import type { PaletteItem, RoomDef } from '../types.ts'
import type { AgentRow } from '../../../server/chat/types.ts'
import { AgentsView } from './Agents.tsx'
import { useOpenBook } from './Book.tsx'
import { DraftsView, useDrafts } from './Drafts.tsx'
import { LinksChip, LinksView } from './Links.tsx'
import { ReadersView } from './Readers.tsx'
import { RetireView } from './RetireView.tsx'
import { SearchView } from './Search.tsx'
import { ShelvesView } from './Shelves.tsx'
import { recallWho } from './facets.ts'
import { fmtTok, navGo, setGo, setLib, toneFor, useLib, type Kind, type Need, type Read, type View } from './state.ts'
import { decodeFacets, encodeFacets } from './url.ts'
import './library.css'

// ROOM: library - the shelves, the books, and which agent must read what at boot.

const TOPICS = ['library', 'config']

function useBooks() { return useApi<LibBooks>('/api/library/books', TOPICS) }
function useAgents() { return useApi<{ agents: LibAgent[] }>('/api/library/agents', TOPICS) }

function Explorer() {
  const books = useBooks()
  const drafts = useDrafts()
  const { view, shelf, topics } = useLib()
  const [fold, setFold] = useStored<Record<string, boolean>>('library.fold', {})
  const onWall = view === 'shelves' || view === 'readers'
  const toggleTopic = (k: string) => setLib({ topics: topics.includes(k) ? topics.filter(x => x !== k) : [...topics, k] })
  const ids = books.data?.shelves.map(s => s.id) ?? []
  const closed = fold.shelves ?? false
  const nDrafts = drafts.data?.drafts.length ?? 0
  const shelvesHead = books.error && !books.data ? <span className="nchip fail" title={books.error}>failed</span>
    : !books.data ? <span className="pill skel" />
    : <span className="nchip lbl" title={`${fmtTok(books.data.shelves.reduce((n, s) => n + s.tokens, 0))} tokens on ${books.data.shelves.length} shelves`}>{books.data.books.length} books</span>
  const draftsHead = drafts.error && !drafts.data ? <span className="nchip fail" title={drafts.error}>failed</span>
    : !drafts.data ? <span className="pill skel" />
    : <span className={`nchip lbl ${nDrafts ? 'ask' : ''}`} title={`${nDrafts} drafted books waiting for Save or Dismiss`}>{nDrafts || 'none'}</span>
  return (
    <div className="cg-list library-ex">
      <FoldCard id="shelves" cat={SHELF_CAT} neutral name="Shelves"
        tip="Every shelf: each top-level folder of app/library" closed={closed} onFold={() => setFold({ ...fold, shelves: !closed })} head={shelvesHead}>
        {books.data && (
          <>
            <button className={`row ${onWall && !shelf ? 'on' : ''}`} onClick={() => setLib({ view: onWall ? view : 'shelves', shelf: null, topics: [] })}>
              <span className="library-swatch all" /><span className="nm">All</span><span className="r">{books.data.books.length}</span>
            </button>
            {books.data.shelves.map(s => {
              const mine = books.data!.books.filter(b => b.shelf === s.id)
              const untagged = mine.filter(b => !b.topics.length).length
              return (
                <div key={s.id}>
                  <button className={`row ${onWall && shelf === s.id ? 'on' : ''}`} title={`${s.dept} - ${s.roots.join(', ')}\n${s.count} books, ${fmtTok(s.tokens)} tokens`}
                    onClick={() => setLib({ view: onWall ? view : 'shelves', shelf: s.id, topics: topics.filter(k => k.startsWith(`${s.id}/`)) })}>
                    <span className="library-swatch" style={{ background: toneFor(ids, s.id) }} />
                    <span className="nm">{s.title}</span><span className="r">{s.count}</span>
                  </button>
                  {onWall && shelf === s.id && (s.topics
                    ? <>
                        {s.topics.map(t => {
                          const k = `${s.id}/${t.id}`
                          const n = mine.filter(b => b.topics.includes(t.id)).length
                          return (
                            <button key={t.id} className={`row sub library-trow ${topics.includes(k) ? 'on' : ''} ${n ? '' : 'zero'}`} onClick={() => toggleTopic(k)} title={t.holds || t.id}>
                              <span className="library-ck" /><span className="nm">{t.id}</span><span className="r">{n}</span>
                            </button>
                          )
                        })}
                        {untagged > 0 && (
                          <button className={`row sub library-trow ${topics.includes(`${s.id}/-`) ? 'on' : ''}`} onClick={() => toggleTopic(`${s.id}/-`)} title="books on this shelf with no topics yet">
                            <Dot s="unknown" /><span className="nm">untagged</span><span className="r">{untagged}</span>
                          </button>
                        )}
                      </>
                    : <div className="row sub library-trow faint" title="its _series.md names no topics: nothing to sort by yet">no topics</div>)}
                </div>
              )
            })}
          </>
        )}
      </FoldCard>

      <FoldCard id="drafts" cat={DRAFT_CAT} neutral name="Drafts" closed
        tip="Books drafted from the owner's corrections, waiting for Save or Dismiss"
        on={view === 'drafts'} onPick={() => setLib({ view: 'drafts' })} head={draftsHead} />

      <NeedCard />
      <VetCard />
      <DeptCards />
    </div>
  )
}

/** the non-category cards (shelves, drafts, vet) wear a neutral square (library.css .neutral), never a category colour */
const SHELF_CAT: Category = { ...CATEGORIES.fund, abbr: 'SH' }
const DRAFT_CAT: Category = { ...CATEGORIES.fund, abbr: 'DR' }

/** who must read it: boot (loaded at every start), recall (a Recall row sends an agent there at a
 *  moment), optional (neither). Derived from the boot lists and the Recall tables, never tagged. With an
 *  agent lens the counts are that agent's. A click filters the wall (again clears) */
const NEED_CAT: Category = { ...CATEGORIES.fund, abbr: 'ND' }
function NeedCard() {
  const books = useBooks()
  const { need, who, view } = useLib()
  const d = books.data
  const rows: { v: Need; label: string; tip: string; n: (b: LibBooks['books'][number], rc: string[] | null) => boolean }[] = [
    { v: 'boot', label: 'Boot', tip: 'loaded at every start', n: b => (who ? b.readers.includes(who) : b.readers.length > 0) },
    { v: 'recall', label: 'Recall', tip: 'a Recall row in a CLAUDE.md sends an agent here at a moment', n: (b, rc) => (who ? !!rc?.includes(who) : b.recall.length > 0) },
    { v: 'opt', label: 'Optional', tip: 'no boot list, no Recall row', n: (b, rc) => !(who ? b.readers.includes(who) || !!rc?.includes(who) : b.readers.length > 0 || b.recall.length > 0) },
  ]
  const head = books.error && !d ? <span className="nchip fail" title={books.error}>failed</span>
    : !d ? <span className="pill skel" />
    : who ? <span className="nchip lbl" title={`counts for ${who}`}>{who}</span> : null
  return (
    <FoldCard id="need" cat={NEED_CAT} neutral name="Need" closed={false}
      tip="Who must read a book: derived from the boot lists and the Recall tables, never tagged" head={head}>
      {d && rows.map(r => {
        const n = d.books.filter(b => r.n(b, recallWho(b, d.loads))).length
        const unknown = r.v !== 'boot' && !d.loads && !!who
        return (
          <button key={r.v} className={`row ${need === r.v ? 'on' : ''}`} title={unknown ? `unknown: ${d.loadsError ?? 'the CLAUDE.md list could not be read'}` : r.tip}
            onClick={() => setLib({ need: need === r.v ? '' : r.v, view: view === 'readers' ? 'readers' : 'shelves' })}>
            <span className={`library-tg ${r.v === 'boot' ? 'boot' : r.v === 'recall' ? 'recall' : 'none'} n`} /><span className="nm">{r.label}</span>
            <span className="r">{unknown ? '?' : n}</span>
          </button>
        )
      })}
    </FoldCard>
  )
}

/** the vet list as ONE card: its head carries the ten slots of the cap as a heat strip, ordered
 *  so it reads as a count - filled first (a doc stands in the slot and opens as a book), then
 *  hollow (a doc stands there but is no book on a shelf), then grey free slots; hover names the
 *  doc - and n/10. Nothing records what the owner has vetted, so the strip never claims it.
 *  Unfolded, it lists the docs */
const VET_CAP = 10
const VET_CAT: Category = { ...CATEGORIES.fund, abbr: 'VL' }
function VetCard() {
  const vet = useApi<{ present: boolean; rows: VetRow[] }>('/api/library/vet', TOPICS)
  const open = useOpenBook()
  const [fold, setFold] = useStored<Record<string, boolean>>('library.fold', {})
  const closed = fold.vet ?? true
  const rows = vet.data?.rows ?? []
  const docs = [...rows.filter(r => r.book), ...rows.filter(r => !r.book)]
  const cells = Array.from({ length: Math.max(VET_CAP, rows.length) }, (_, i) => {
    const r = docs[i]
    if (!r) return { cls: 'hc-none', title: `slot ${i + 1}: free` }
    return { cls: r.book ? 'hc-ok' : 'hc-unknown', title: `${r.title}${r.book ? '' : '\nnot a book on a shelf'}` }
  })
  const head = vet.error && !vet.data ? <span className="nchip fail" title={vet.error}>failed</span>
    : !vet.data ? <span className="pill skel" />
    : !vet.data.present ? <span className="nchip faint" title="no app/library/shelf.md">none</span>
    : <><HeatStrip cells={cells} label={`${rows.length} of ${VET_CAP} vet slots used`} /><span className={`nchip ${rows.length > VET_CAP ? 'warn' : ''}`} title={`${rows.length} docs on the vet list; the cap is ${VET_CAP}`}>{rows.length}/{VET_CAP}</span></>
  return (
    <FoldCard id="vet" cat={VET_CAT} neutral name="Vet" tip="app/library/shelf.md: the owner's vet list, ten at most" closed={closed}
      onFold={() => setFold({ ...fold, vet: !closed })} head={head}>
      {rows.map((r, i) => (
        <button key={i} className={`row library-vet ${r.book ? '' : 'nobook'}`} title={`${r.title}\n${r.paths.join(', ')}\n\n${r.vet}${r.book ? '' : '\n\nno book on a shelf'}`}
          onClick={() => r.book && open(r.chapter ? `${r.book}#${r.chapter}` : r.book, r.title)}>
          <span className="library-vtag" title={r.tag || 'no tag'}>{vetCode(r.tag)}</span><span className="nm">{vetLabel(r.title)}</span>
          {!r.book && <Dot s="unknown" title="no book on a shelf" />}
        </button>
      ))}
    </FoldCard>
  )
}

/** "6 books": an agent's boot list, the ONE measure on every card and row (entries on no shelf
 *  and the token budget ride in the title; over budget turns it warn) */
function bootChip(a: LibAgent) {
  const tip = `${a.boot.length} boot books${a.missing ? ` (${a.missing} not on any shelf)` : ''}, ${fmtTok(a.bootTokens)} of ${a.budget === null ? '? (the caps file could not be read)' : fmtTok(a.budget)} tokens`
  return <span className={`nchip lbl ${a.budget !== null && a.bootTokens > a.budget ? 'warn' : ''}`} title={tip}>{a.boot.length} {a.boot.length === 1 ? 'book' : 'books'}</span>
}

/** the chats card's live mark: blue when something waits on the owner, the accent while working;
 *  nothing when idle or when the chats read is not in yet */
function liveMark(rows: AgentRow[]) {
  return <Live waiting={rows.reduce((s, a) => s + a.waiting, 0)} working={rows.reduce((s, a) => s + a.working, 0)} />
}

/** the agents as option-B card groups, one per category (src/ui/categories.ts), in that order, each
 *  with its live mark. A category that is exactly one agent IS that
 *  agent: its head selects it. Only a category of 2 or more (the dashboards) folds open to rows */
function DeptCards() {
  const agents = useAgents()
  const live = useApi<{ agents: AgentRow[] }>('/api/chats/agents', ['chat', 'config'])
  const { view, agent, who } = useLib()
  const [fold, setFold] = useStored<Record<string, boolean>>('library.fold', {})
  const lensing = view !== 'agents'
  const pick = (id: string) => lensing ? setLib({ who: who === id ? null : id, view: view === 'readers' ? 'readers' : 'shelves' }) : setLib({ agent: id })
  const isOn = (id: string) => (lensing ? who === id : agent === id)
  if (agents.error && !agents.data) return <Empty inline state="failed">{`agents: ${agents.error}`}</Empty>
  if (!agents.data) return <Empty state="loading" skel="cg" />
  const liveOf = (list: LibAgent[]) => (live.data?.agents ?? []).filter(r => list.some(a => a.id === r.id))
  const groups = new Map<CategoryId, LibAgent[]>()
  for (const a of agents.data.agents) {
    const c = categoryOf(a).id
    groups.set(c, [...(groups.get(c) ?? []), a])
  }
  return (
    <>
      {(Object.keys(CATEGORIES) as CategoryId[]).filter(c => groups.has(c)).map(c => {
        const cat = CATEGORIES[c]
        const list = groups.get(c)!
        const dormant = list.every(a => a.mode === 'dormant')
        const role = dormant ? 'dormant' : undefined
        if (list.length === 1) {
          const a = list[0]
          return (
            <FoldCard key={c} id={c} cat={cat} name={cat.name} role={role} tip={`${a.role}\n${lensing ? 'click: show only what it must read or has read' : 'click: its boot list'}`} closed dormant={dormant}
              on={isOn(a.id)} onPick={() => pick(a.id)}
              head={<>{liveMark(liveOf(list))}{bootChip(a)}</>} />
          )
        }
        const closed = fold[c] ?? false
        return (
          <FoldCard key={c} id={c} cat={cat} name={cat.name} role={role} tip={`${cat.name}: ${list.length} agents`} closed={closed}
            dormant={dormant} onFold={() => setFold({ ...fold, [c]: !closed })}
            head={liveMark(liveOf(list))}>
            {list.map(a => (
              <button key={a.id} className={`row sub ${isOn(a.id) ? 'on' : ''}`} onClick={() => pick(a.id)} title={`${a.role}\n${lensing ? 'click: show only what it must read or has read' : 'click: its boot list'}`}>
                <Glyph id={a.id} tone={a.mode === 'dormant' ? 'off' : undefined} />
                <span className="nm">{a.name}</span>
                {bootChip(a)}
              </button>
            ))}
          </FoldCard>
        )
      })}
    </>
  )
}

/** the side-list card: the kit's card group. With `onPick` the head is a selectable row of its own
 *  (no chevron, no body) */
function FoldCard({ id, cat, name, role, tip, closed, dormant = false, neutral = false, on = false, onFold, onPick, head, children }: {
  id: string; cat: Category; name: string; role?: string; tip: string; closed: boolean; dormant?: boolean; neutral?: boolean; on?: boolean
  onFold?: () => void; onPick?: () => void; head?: ReactNode; children?: ReactNode
}) {
  return (
    <CardGroup id={id} abbr={cat.abbr} color={cat.color} name={name} role={role} title={tip} closed={closed} dormant={dormant} neutral={neutral}
      on={on} onPick={onPick} onToggle={onPick ? undefined : onFold ?? (() => {})} right={head} className="library-card">
      {children}
    </CardGroup>
  )
}

/** a vet tag as a fixed-width code (LAW / STR / MCH / ID / PRI); the word is the tooltip */
const VET: Record<string, string> = { law: 'LAW', strategy: 'STR', machine: 'MCH', identity: 'ID', priority: 'PRI' }
function vetCode(tag: string | undefined): string {
  const t = (tag ?? '').trim().toLowerCase()
  if (!t) return '-'
  return VET[t] ?? t.slice(0, 3).toUpperCase()
}

function Head() {
  const { view, who } = useLib()
  return (
    <span className="library-seg">
      <Seg<View> value={view} onChange={v => setLib(v === 'agents' && who ? { view: v, agent: who } : { view: v })}
        options={[{ id: 'shelves', label: 'Shelves' }, { id: 'readers', label: 'Readers' }, { id: 'agents', label: 'Agents' }, { id: 'retire', label: 'Retire?' }]} />
    </span>
  )
}

const NEED_OPTS = [
  { value: '', label: 'any' },
  { value: 'boot', label: 'boot', title: 'in a boot list: loaded at every start' },
  { value: 'recall', label: 'recall', title: 'a Recall row sends an agent here at a moment' },
  { value: 'must', label: 'boot or recall', title: 'someone must read it' },
  { value: 'opt', label: 'optional', title: 'no boot list, no Recall row' },
]
const READ_OPTS = [
  { value: '', label: 'any' },
  { value: 'p30', label: 'pulled 30d', title: 'opened with the Read tool in the last 30 days' },
  { value: 'b30', label: 'booted 30d', title: 'loaded at a boot in the last 30 days' },
  { value: 'never', label: 'never read', title: 'no pull and no boot load since the ledger started' },
]

/** the 32px toolbar under the header: the filter, the four facets (Topic, Need, For, Read), text search, the link audit */
function Toolbar() {
  const { q, text, shelf, topics, who, need, read, type } = useLib()
  const books = useBooks()
  const shelves = books.data?.shelves ?? []
  const topicOpts = [{ value: '', label: 'any' }, ...shelves.filter(s => s.topics && (!shelf || s.id === shelf)).flatMap(s =>
    s.topics!.map(t => ({ value: `${s.id}/${t.id}`, label: shelf ? t.id : `${s.title} / ${t.id}`, title: t.holds })))]
  const topicVal = topics.length === 1 ? topics[0] : topics.length ? '*' : ''
  if (topics.length > 1) topicOpts.push({ value: '*', label: `${topics.length} topics`, title: topics.join(', ') })
  const agentOpts = [{ value: '', label: 'anyone' }, ...(books.data?.agents ?? []).map(a => ({ value: a, label: a, glyph: a }))]
  const onWall = (v: string) => ({ view: v === 'readers' ? 'readers' : 'shelves' } as const)
  const { view } = useLib()
  return (
    <div className="library-bar">
      <input className="input library-search" placeholder={text ? 'Search text' : 'Filter  (#topic)'} value={q} onChange={e => setLib({ q: e.target.value })}
        onKeyDown={e => { if (e.key === 'Escape') setLib({ q: '' }) }} title={text ? 'searches every chapter and book body' : 'titles, paths, moments and chapter titles; #fee matches a topic'} />
      <button className={`library-texttog ${text ? 'on' : ''}`} onClick={() => setLib({ text: !text })} title={text ? 'searching book bodies; click for titles' : 'search every book body instead of titles'}>Text</button>
      <span className="library-type" title="Type: what a book is. Guides explain how we work; strategies are the research families, each under its parent book">
        <Seg<Kind> value={type} onChange={v => setLib({ type: v, ...onWall(view) })} options={[{ id: '', label: 'All' }, { id: 'guide', label: 'Guides' }, { id: 'strategy', label: 'Strategies' }]} />
      </span>
      <ChipSelect label="Topic" value={topicVal} def="" onChange={v => v !== '*' && setLib({ topics: v ? [v] : [], ...onWall(view) })} options={topicOpts}
        title="Topic: what a book is about, from its shelf's list. Pick several in the side list or on a shelf (any of them)" />
      <ChipSelect label="Need" value={need} def="" onChange={v => setLib({ need: v as Need, ...onWall(view) })} options={NEED_OPTS}
        title="Need: who must read it, from the boot lists and Recall rows" />
      <ChipSelect label="For" value={who ?? ''} def="" onChange={v => setLib({ who: v || null, ...onWall(view) })} options={agentOpts}
        title="For: one agent's view - what it boots with, is sent to by a Recall row, or pulled" />
      <ChipSelect label="Read" value={read} def="" onChange={v => setLib({ read: v as Read, ...onWall(view) })} options={READ_OPTS}
        title={`Read: what the read ledger saw${books.data?.tracking?.since ? ` (${books.data.tracking.pulls} pulls since ${new Date(books.data.tracking.since).toISOString().slice(0, 10)})` : books.data && !books.data.tracking ? ' (unknown: the ledger could not be read)' : ''}`} />
      <LinksChip />
    </div>
  )
}

/** the room's filters in the URL hash (`#/library?type=guide&shelf=law`), both ways: a pasted or reloaded link sets the
 *  filters, and a filter click rewrites the hash in place. The hash wins over the remembered view when it carries one. */
function useFacetUrl() {
  const { query, setQuery } = useNav()
  const lib = useLib()
  const first = useRef(true)
  const wrote = useRef<string | null>(null)   // the last query this hook wrote: a query that is not it came from outside (a link, Back)
  const q = query.library ?? ''
  const mine = encodeFacets({ view: lib.view, shelf: lib.shelf, agent: lib.agent, q: lib.q, text: lib.text, topics: lib.topics, who: lib.who, need: lib.need, read: lib.read, type: lib.type, hide: lib.hide })
  // the URL -> the room: on load and on Back / Forward, a query this hook did not write names the view
  useEffect(() => {
    if (q === wrote.current) return
    wrote.current = q
    if (first.current && !q) return   // a bare load: the remembered filters stand
    if (q !== mine) setLib(decodeFacets(q))   // an empty query decodes to the default view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])
  // the room -> the URL: a filter click rewrites the hash in place; the first run keeps a hash that came with the page
  useEffect(() => {
    const was = first.current
    first.current = false
    if (was && q) return
    if (mine === q) return
    wrote.current = mine
    setQuery('library', mine || null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine])
}

function Main() {
  useFacetUrl()
  return <div className="library-frame"><Toolbar /><div className="library-body"><MainBody /></div></div>
}

function MainBody() {
  const books = useBooks()
  const agents = useAgents()
  const { view } = useLib()
  const [sel, setSel] = useSel('library')
  const open = useOpenBook()

  // deep links: sel = a book path, a chapter ref `<book>.md#<slug>`, or 'agent:<id>'
  useEffect(() => {
    if (!sel) return
    if (sel.startsWith('agent:')) setLib({ view: 'agents', agent: sel.slice(6) })
    else if (!books.data && !books.error) return   // wait for titles, then open
    else open(sel, books.data?.books.find(b => b.path === splitRef(sel).path)?.title)   // a book path, or `<book>#<slug>` (a deep link to a chapter)
    setSel(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, books.data, books.error])

  const { text, q } = useLib()
  if (text && q.trim()) return <SearchView q={q} />
  if (view === 'links') return <LinksView ids={books.data?.shelves.map(s => s.id) ?? []} />
  if (view === 'shelves') return <Load q={books} skel="cards">{d => <ShelvesView data={d} />}</Load>
  if (view === 'readers') return <Load q={books} skel="table">{d => <ReadersView data={d} />}</Load>
  if (books.error && !books.data) return <Empty state="failed">{books.error}</Empty>
  if (agents.error && !agents.data) return <Empty state="failed">{agents.error}</Empty>
  if (!books.data || !agents.data) return <Empty state="loading" skel="table" />
  if (view === 'agents') return <AgentsView data={books.data} agents={agents.data.agents} />
  if (view === 'retire') return <RetireView data={books.data} />
  if (view === 'drafts') return <DraftsView data={books.data} />
  return <AgentsView data={books.data} agents={agents.data.agents} />
}

/** always mounted (activity bar): captures the shell's go() so palette items can navigate; the count = open drafts */
function useBadge() {
  const { go } = useNav()
  setGo(go)
  const d = useDrafts()
  const n = d.data?.drafts.length ?? 0
  return n ? { n, tone: 'ask' as const } : null
}

function focusSearch() { setTimeout(() => (document.querySelector('.library-search') as HTMLInputElement | null)?.focus(), 60) }

/** Full-text hits for the palette's query (RoomDef.search): up to 12 chapters (or books without chapters) whose text matches. */
export async function search(q: string): Promise<PaletteItem[]> {
  if (q.trim().length < 3) return []
  const r = await api<LibSearch>(`/api/library/search?q=${encodeURIComponent(q)}&limit=12`)
  return r.hits.map(h => ({ kind: 'text', label: h.title, hint: h.snippet.slice(0, 90), run: () => navGo('library', h.chapter ? `${h.path}#${h.chapter.slug}` : h.path) }))
}

async function palette(): Promise<PaletteItem[]> {
  const d = await api<LibBooks>('/api/library/books')
  const items: PaletteItem[] = [
    { kind: 'library', label: 'Library: readers', run: () => { setLib({ view: 'readers' }); navGo('library') } },
    { kind: 'library', label: 'Library: shelves', run: () => { setLib({ view: 'shelves', shelf: null }); navGo('library') } },
    { kind: 'library', label: 'Library: agents', run: () => { setLib({ view: 'agents' }); navGo('library') } },
    { kind: 'library', label: 'Library: search text', run: () => { setLib({ text: true, q: '' }); navGo('library'); focusSearch() } },
    { kind: 'library', label: 'Library: retire?', run: () => { setLib({ view: 'retire' }); navGo('library') } },
    { kind: 'library', label: 'Library: links', run: () => { setLib({ view: 'links' }); navGo('library') } },
    { kind: 'library', label: 'Library: drafts', run: () => { setLib({ view: 'drafts' }); navGo('library') } },
    { kind: 'library', label: 'Library: never read', run: () => { setLib({ view: 'shelves', read: 'never', text: false, q: '' }); navGo('library') } },
    { kind: 'library', label: 'Library: must read (boot or recall)', run: () => { setLib({ view: 'shelves', need: 'must', text: false }); navGo('library') } },
  ]
  for (const s of d.shelves) for (const t of s.topics ?? []) {
    items.push({ kind: 'library', label: `Library: topic ${s.title} / ${t.id}`, hint: t.holds, run: () => { setLib({ view: 'shelves', shelf: s.id, topics: [`${s.id}/${t.id}`] }); navGo('library') } })
  }
  for (const b of d.books) items.push({ kind: 'book', label: b.title, hint: b.shelf, run: () => navGo('library', b.path) })
  return items
}

export const room: RoomDef = {
  id: 'library' as const,
  label: 'Library',
  title: 'Library',
  icon: <><path d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.5-.8 3 15.6-3.5.8z"/></>,
  Explorer,
  Main,
  Head,
  useBadge,
  palette,
  search,
}
