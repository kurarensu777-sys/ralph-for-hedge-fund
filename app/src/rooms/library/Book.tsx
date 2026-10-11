import { useEffect, useRef, useState, type ReactNode } from 'react'
import { slugOf, splitRef } from '../../../shared/bookmeta.ts'
import type { LibBookDetail, LibBooks, SaveResult } from '../../../server/library/types.ts'
import { api, relTime, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Btn, Dot, Empty, Glyph, Load, Markdown } from '../../ui/kit.tsx'
import { fmtTok, setLib, toneFor, useBootToggle } from './state.ts'
import { shortTitle } from './spine.ts'

/** the drawer body for one book: meta, the moment it fires, who must read it, the text, history.
 *  `chapter` = a slug to scroll to and mark (a search hit, a deep link `#/library/<book>#<slug>`, a boot or Recall chip) */
export function BookView({ path, chapter }: { path: string; chapter?: string | null }) {
  const q = useApi<LibBookDetail>(`/api/library/book?path=${encodeURIComponent(path)}`, ['library', 'config'])
  const shelves = useApi<LibBooks>('/api/library/books', ['library'])
  const { go, openDrawer } = useNav()
  const ids = shelves.data?.shelves.map(s => s.id) ?? []
  const toAgent = (id: string) => { setLib({ view: 'agents', agent: id }); openDrawer(null); go('library') }
  const [editing, setEditing] = useState(false)
  const [cur, setCur] = useState<string | null>(chapter ?? null)
  useEffect(() => setCur(chapter ?? null), [chapter])
  const textRef = useRef<HTMLDivElement>(null)
  const content = q.data?.content
  useEffect(() => { if (!editing && content !== undefined) markChapter(textRef.current, cur) }, [content, cur, editing])
  return (
    <Load q={q} skel="doc">
      {d => (
        <div className="library-book">
          <div className="library-meta" title={[d.book.path, `repo: ${d.repo}`].join('\n')}>
            <span className="library-swatch" style={{ background: toneFor(ids, d.book.shelf) }} />
            <span>{shelves.data?.shelves.find(s => s.id === d.book.shelf)?.title ?? d.book.shelf}</span>
            <span className="sep">/</span><span>{d.book.series}</span>
            <span className="sep">·</span><span title="chars / 4">{fmtTok(d.book.tokens)} tok</span>
            {shelves.data?.caps && d.book.tokens > shelves.data.caps.book * BOOK_WARN && <span className={`library-over ${d.book.tokens > shelves.data.caps.book ? 'fail' : ''}`}
              title={`${d.book.tokens.toLocaleString()} of the ${shelves.data.caps.book.toLocaleString()}-token book cap (app/tools/context-caps.json): split it before the next chapter fails the check`}>over-size</span>}
            <span className="sep">·</span><span title={new Date(d.book.updated).toISOString()}>{relTime(d.book.updated)}</span>
          </div>
          <div className="library-when">
            <div className="cap library-k">When</div>
            {d.book.readWhen ? <When text={d.book.readWhen} /> : <div className="faint" title="no series row">-</div>}
          </div>
          <Facts d={d} books={shelves.data ?? undefined} toAgent={toAgent} cur={cur} onChapter={setCur} />
          <Reads d={d} toAgent={toAgent} />
          <div className="library-texthead">
            <div className="cap library-k">Text</div>
            {!editing && (d.editable
              ? <Btn sm onClick={() => setEditing(true)} title="Edit and commit to the fund repo">Edit</Btn>
              : <span className="faint mono library-ro" title={d.book.shelf === 'lab' ? 'a desk machine file; its desk and the loop tools write it' : `lives in ${d.repo}; edited from its own repo`}>read only</span>)}
          </div>
          {editing
            ? <Editor key={d.hash} d={d} onDone={() => setEditing(false)} />
            : <div className="library-text" ref={textRef}><Markdown text={dropH1(d.content)} /></div>}
          <div className="cap library-k library-k-sp">History</div>
          {d.history === null
            ? <Empty state="failed">{d.historyError ?? 'git log failed'}</Empty>
            : d.history.length === 0
              ? <Empty title="UNTRACKED">not in git yet</Empty>
              : <div className="lbox library-hist">
                  {d.history.map(h => (
                    <div key={h.sha} className="library-hist-row">
                      <span className="mono sha">{h.sha}</span>
                      <span className="subj" title={h.subject}>{h.subject}</span>
                      <span className="who mono" title={h.who === 'you' ? 'no Agent: trailer' : `Agent: ${h.who}`}>{h.who}</span>
                      <span className="faint mono" title={new Date(h.ts).toISOString()}>{relTime(h.ts)}</span>
                    </div>
                  ))}
                </div>}
        </div>
      )}
    </Load>
  )
}

/** topics, and who must read it: the boot list (with + boot) and every Recall row that names it */
function Facts({ d, books, toAgent, cur, onChapter }: { d: LibBookDetail; books: LibBooks | undefined; toAgent: (id: string) => void; cur: string | null; onChapter: (slug: string) => void }) {
  const { toast } = useNav()
  const { toggle } = useBootToggle(msg => toast(msg, true))
  const b = d.book
  const shelf = books?.shelves.find(s => s.id === b.shelf)
  const agents = books?.agents ?? []
  const loaders = (file: string) => (books?.loads ? Object.keys(books.loads).filter(a => books.loads![a].includes(file)) : null)
  const addable = agents.filter(a => !b.readers.includes(a))
  return (
    <div className="library-facts">
      {b.shelf !== 'lab' && <>
        <span className="k cap">Topics</span>
        <span className="v chips">
          {b.topics.length
            ? b.topics.map(t => (
                <button key={t} className={`library-tp ${shelf?.topics && !shelf.topics.some(x => x.id === t) ? 'bad' : ''}`}
                  title={shelf?.topics?.find(x => x.id === t)?.holds ?? (shelf?.topics ? 'not on this shelf\'s list' : t)}
                  onClick={() => setLib({ view: 'shelves', shelf: b.shelf, topics: [`${b.shelf}/${t}`] })}>{t}</button>
              ))
            : <span className="faint" title={shelf?.topics ? `this shelf's: ${shelf.topics.map(x => x.id).join(', ')}` : 'its shelf names no topics'}>none</span>}
        </span>
      </>}
      <span className="k cap">Boot</span>
      <span className="v chips">
        {b.readers.map(a => <button key={a} className="library-badge" onClick={() => toAgent(a)} title={`${a} loads this at every start; click: its boot list`}><Glyph id={a} /></button>)}
        {!b.readers.length && <span className="faint">no boot list</span>}
        {b.shelf !== 'lab' && addable.length > 0 && (
          <select className="library-addboot" value="" onChange={e => e.target.value && toggle(e.target.value, b.path, true)} title="Add this book to an agent's boot list">
            <option value="">+ boot</option>
            {addable.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </span>
      {/* only a book written as chapters (a Read when line, a boot or a Recall naming one): every ## of an old book is addressable but is not listed as a chapter */}
      {b.chapters.some(c => c.readWhen || c.readers.length || b.recall.some(r => r.chapter === c.slug)) && <>
        <span className="k cap" title="its ## chapters; a boot list or Recall row may name one as book.md#slug">Chapters</span>
        <span className="v">
          {b.chapters.map(c => (
            <div key={c.slug} className={`library-rc ${cur === c.slug ? 'cur' : ''}`} title={`${b.path}#${c.slug}`}>
              <div className="f mono">
                <button className="library-ch" onClick={() => onChapter(c.slug)} title="show it in the text below">#{c.slug}</button> <span className="faint">{fmtTok(c.tokens)} tok</span>
                {books?.caps && c.tokens > books.caps.chapterTarget && <span className={`library-over ${c.tokens > books.caps.chapter ? 'fail' : ''}`}
                  title={`${c.tokens.toLocaleString()} tokens: the writing target is ${books.caps.chapterTarget.toLocaleString()}, the check fails above ${books.caps.chapter.toLocaleString()}`}>over-size</span>}
                <button className="library-link library-copy" onClick={() => copyRef(`${b.path}#${c.slug}`, toast)} title={`copy ${b.path}#${c.slug}: what a boot list and a Recall row take`}>copy ref</button>
              </div>
              <div className="m">{c.readWhen || <span className="faint">no Read when line</span>}</div>
              {c.readers.length > 0 && <div className="w faint" title="agents whose boot list names this chapter">{c.readers.join(', ')}</div>}
            </div>
          ))}
        </span>
      </>}
      <span className="k cap">Recall</span>
      <span className="v">
        {!b.recall.length
          ? <span className="faint">{books && !books.loads ? `unknown: ${books.loadsError ?? 'the CLAUDE.md list could not be read'}` : 'no Recall row names it'}</span>
          : b.recall.map((r, i) => {
              const who = loaders(r.file)
              return (
                <div key={i} className="library-rc">
                  <div className="f mono">{r.file}{r.chapter && <button className="library-ch faint" onClick={() => onChapter(r.chapter!)} title="the row names this chapter only; click: show it in the text below"> #{r.chapter}</button>}</div>
                  <div className="m">{r.moment || <span className="faint">no moment text</span>}</div>
                  <div className="w faint">{who === null ? 'who loads it: unknown' : !who.length ? 'no agent loads it at start: read on demand' : who.length === agents.length ? `every agent (${who.length})` : who.join(', ')}</div>
                </div>
              )
            })}
      </span>
    </div>
  )
}

/** the book-size share above which the over-size mark shows (the book cap is 8,000 tokens; the check warns at 90%) */
const BOOK_WARN = 0.9

/** copy a chapter ref (`app/library/<shelf>/<book>.md#<slug>`) to the clipboard; a refusal says so, never a silent no-op */
function copyRef(ref: string, toast: (t: string, fail?: boolean) => void) {
  navigator.clipboard.writeText(ref).then(() => toast(`copied ${ref}`), () => toast('the clipboard refused the copy', true))
}

/** mark one chapter in the rendered text: its heading and the blocks under it, to the next `##`, and scroll the heading in view */
function markChapter(root: HTMLElement | null, slug: string | null) {
  if (!root) return
  root.querySelectorAll('.library-chmark').forEach(e => e.classList.remove('library-chmark'))
  if (!slug) return
  const head = [...root.querySelectorAll('h2')].find(h => slugOf(h.textContent ?? '') === slug)
  if (!head) return
  head.classList.add('library-chmark')
  for (let e = head.nextElementSibling; e && e.tagName !== 'H2'; e = e.nextElementSibling) e.classList.add('library-chmark')
  head.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/** the book's own leading "# Title" line: the drawer head already carries it */
const dropH1 = (s: string) => s.replace(/^(---\n[\s\S]*?\n---\n)?\s*# [^\n]*\n/, '$1')

/** the moment a book fires, clamped to two lines; a click shows the rest */
function When({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return <div className={`library-when-t ${open ? 'open' : 'clamp'}`} onClick={() => setOpen(!open)} title={open ? 'show less' : text}>{text}</div>
}

/** pulls (Read tool, mid-work) and boots (launch contract), kept apart; unknown when the table could not be read */
function Reads({ d, toAgent }: { d: LibBookDetail; toAgent: (id: string) => void }) {
  const u = d.book.use
  if (!u || d.reads === null) return (
    <div className="library-when"><div className="cap library-k">Reads</div><Empty inline state="unknown">the reads table could not be read</Empty></div>
  )
  return (
    <div className="library-when">
      <div className="cap library-k">Reads</div>
      <div className="library-use mono" title={[
        `${u.n30} Read-tool pulls in the last 30 days`,
        u.last ? `last pull ${new Date(u.last).toISOString()}` : 'never pulled',
        `${u.boots30} boot loads in 30 days${u.lastBoot ? `, last ${new Date(u.lastBoot).toISOString()}` : ''}`,
      ].join('\n')}>
        <b>{u.n30}</b><span className="sep">·</span><span className="faint">30d</span>
        {u.last ? <span className="faint">{relTime(u.last)}</span> : <span className="library-never"><Dot s="off" /> never</span>}
        {u.boots30 > 0 && <span className="faint">{u.boots30} boot{u.boots30 === 1 ? '' : 's'}</span>}
      </div>
      {u.who.length > 0 && (
        <div className="chips library-who">
          {u.who.map(a => <button key={a} className="chip" onClick={() => toAgent(a)} title={`${a} pulled this in the last 30 days`}>{a}</button>)}
        </div>
      )}
      {d.reads.length > 0 && (
        <div className="lbox library-reads">
          {d.reads.map((r, i) => (
            <div key={i} className="library-read-row mono">
              <span className="a">{r.agent}</span>
              <span className="c faint" title={r.conversation ?? 'no conversation id'}>{r.conversation ? r.conversation.slice(0, 14) : '-'}</span>
              <span className="faint" title={new Date(r.ts).toISOString()}>{relTime(r.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** textarea + save: writes the file and commits exactly that path to the fund repo (Agent: you) */
function Editor({ d, onDone }: { d: LibBookDetail; onDone: () => void }) {
  const { toast } = useNav()
  return (
    <TextEditor initial={d.content} subject placeholder={`library: edit ${d.book.path.split('/').pop()}`} onDone={onDone}
      save={async (content, subject) => {
        const r = await api<SaveResult>('/api/library/save', { body: { path: d.book.path, content, base: d.hash, subject: subject || undefined } })
        if (r.error) throw new Error(`written, not committed: ${r.error}`)
        toast(r.committed ? `committed ${r.sha ?? ''}` : (r.note ?? 'saved'))
      }} />
  )
}

/**
 * The book editor: a textarea, Ctrl+S, Save / Cancel. `save` throws to show an error under it.
 * Shared by the book drawer (commit) and a draft (update the draft; nothing is written to the tree).
 */
export function TextEditor({ initial, save, onDone, subject: withSubject, placeholder, label = 'Save', saveTitle = 'Write and commit (Ctrl+S)', changed = false, children }: {
  initial: string; changed?: boolean; save: (text: string, subject: string) => Promise<void>; onDone: () => void
  subject?: boolean; placeholder?: string; label?: string; saveTitle?: string; children?: ReactNode
}) {
  const [text, setText] = useState(initial)
  const [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const lf = (s: string) => s.replace(/\r\n/g, '\n')
  const dirty = changed || lf(text) !== lf(initial)
  const go = async () => {
    setBusy(true); setErr(null)
    try { await save(text, subject.trim()); onDone() } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }
  return (
    <div className="library-edit">
      {children}
      <textarea className="library-edit-t mono" value={text} spellCheck={false} onChange={e => setText(e.target.value)}
        onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty && !busy) go() } }} />
      <div className="library-edit-bar">
        {withSubject && <input className="input" placeholder={placeholder} value={subject} maxLength={120}
          onChange={e => setSubject(e.target.value)} title="Commit subject" />}
        <Btn kind="primary" sm onClick={go} disabled={!dirty || busy} title={saveTitle}>{busy ? 'Saving' : label}</Btn>
        <Btn kind="ghost" sm onClick={onDone} disabled={busy}>Cancel</Btn>
      </div>
      {err && <div className="t-fail mono library-edit-err">{err}</div>}
    </div>
  )
}

/** open a book in the shell drawer. `ref` is a book path or a chapter ref `<book>.md#<slug>` (a boot entry, a
 *  Recall chip, a vet row, a search hit): the drawer opens the book at that chapter and the URL carries the ref,
 *  `#/library/<book path>#<slug>`, so the view can be pasted back */
export function useOpenBook() {
  const { openDrawer } = useNav()
  return (ref: string, title?: string) => {
    const { path, slug } = splitRef(ref)
    openDrawer({
      title: title ? <span title={title}>{shortTitle(title)}</span> : path.split('/').pop()?.replace(/\.md$/, '') ?? path,
      body: <BookView key={ref} path={path} chapter={slug} />,
      link: ref,
    })
  }
}
