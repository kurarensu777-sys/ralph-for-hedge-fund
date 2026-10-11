import { useEffect, useMemo, useState } from 'react'
import { splitRef } from '../../../shared/bookmeta.ts'
import type { LibAgent, LibBooks } from '../../../server/library/types.ts'
import { relTime } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Empty, Glyph, Markdown, Meter, Tag } from '../../ui/kit.tsx'
import { useOpenBook } from './Book.tsx'
import { textOk } from './facets.ts'
import { fmtTok, setLib, toneFor, useBootToggle, useLib } from './state.ts'

export function byDept(agents: LibAgent[]): [string, LibAgent[]][] {
  const m = new Map<string, LibAgent[]>()
  for (const a of agents) { const l = m.get(a.dept) ?? []; l.push(a); m.set(a.dept, l) }
  return [...m.entries()]
}

/** left: agents by department; right: the chosen agent's boot list, its budget, and the picker */
export function AgentsView({ data, agents }: { data: LibBooks; agents: LibAgent[] }) {
  const { agent: selId } = useLib()
  const sel = agents.find(a => a.id === selId) ?? agents[0]
  return (
    <div className="library-agents">
      <div className="library-alist">
        {byDept(agents).map(([dept, list]) => (
          <div key={dept}>
            <div className="cap library-dept">{dept}</div>
            {list.map(a => (
              <button key={a.id} className={`row library-arow ${sel?.id === a.id ? 'on' : ''} ${a.mode === 'dormant' ? 'dormant' : ''}`} onClick={() => setLib({ agent: a.id })}>
                <Glyph id={a.id} tone={a.mode === 'dormant' ? 'off' : undefined} />
                <span className="nm">{a.name}</span>
                <span className={`r ${a.budget !== null && a.bootTokens > a.budget ? 't-warn' : ''}`}>{a.boot.length} · {fmtTok(a.bootTokens)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {sel ? <AgentPanel key={sel.id} a={sel} data={data} /> : <Empty>no agents in the roster (app/agents/)</Empty>}
    </div>
  )
}

function AgentPanel({ a, data }: { a: LibAgent; data: LibBooks }) {
  const { toast } = useNav()
  const open = useOpenBook()
  const { pending, toggle, settle } = useBootToggle(msg => toast(msg, true))
  useEffect(() => settle((ag, p) => ag === a.id && a.boot.some(b => b.path === p)), [a, settle])
  const ids = data.shelves.map(s => s.id)
  const byPath = useMemo(() => new Map(data.books.map(b => [b.path, b])), [data.books])
  const boot = a.boot.filter(b => pending[`${a.id}|${b.path}`] !== false)
  const added = Object.entries(pending).filter(([k, on]) => on && k.startsWith(a.id + '|')).map(([k]) => k.slice(a.id.length + 1)).filter(p => !a.boot.some(b => b.path === p))
  const rows = [...boot, ...added.map(p => { const r = refInfo(byPath, p); return { path: p, known: !!r, title: r?.title ?? p, shelf: r?.shelf ?? '', tokens: r?.tokens ?? 0 } })]
  const total = rows.reduce((n, b) => n + b.tokens, 0)
  // the boot cap is app/tools/context-caps.json "boot" (the one source); null = the file could not be read: no meter, no verdict
  const cap = a.budget
  const over = cap !== null && total > cap
  const L = a.layers
  const allIn = L && L.total !== null ? L.total - L.boot + total : null

  return (
    <div className="library-apanel">
      <div className="library-ahead">
        <Glyph id={a.id} />
        <span className="library-aname" title={a.role}>{a.name}</span>
        <Tag>{a.dept}</Tag>
        <Tag>{a.kind}</Tag>
        {a.mode === 'dormant' && <Tag tone="warn">dormant</Tag>}
      </div>

      <div className="cap library-k" title={a.brief.path}>Brief<span className="faint" title={a.brief.text === null ? undefined : `${a.brief.tokens.toLocaleString()} tokens`}> {a.brief.text === null ? 'missing' : `${fmtTok(a.brief.tokens)} tok`}</span></div>
      {a.brief.text === null
        ? <Empty inline state="failed" title="MISSING">{`no brief at ${a.brief.path}`}</Empty>
        : <Brief text={a.brief.text} />}

      <div className="library-budget" title={cap === null ? 'the caps file (app/tools/context-caps.json) could not be read' : `${total.toLocaleString()} of ${cap.toLocaleString()} tokens: the boot list's own cap, loaded at every boot`}>
        <Meter v={cap === null ? null : Math.min(1, total / cap)} tone={over ? 'warn' : 'accent'} grow />
        <span className={`mono ${over ? 't-warn' : ''}`}>{fmtTok(total)} / {cap === null ? '?' : fmtTok(cap)}</span>
      </div>
      {L && <Layers L={L} boot={total} allIn={allIn} />}

      <div className="cap library-k">Boot<span className="faint"> {rows.length}</span></div>
      <div className="lbox library-blist">
        {rows.length === 0 && <Empty inline title="NONE">boots with no books</Empty>}
        {rows.map((b, i) => (
          <div key={b.path} className={`library-brow ${b.known ? '' : 'missing'}`}>
            <span className="n mono">{i + 1}</span>
            <span className="library-swatch" style={{ background: b.known ? toneFor(ids, b.shelf) : 'var(--fail)' }} title={data.shelves.find(s => s.id === b.shelf)?.title ?? 'not on a shelf'} />
            <button className="main" onClick={() => b.known && open(b.path, b.title)} disabled={!b.known} title={[b.known ? b.title : '', b.path, b.known ? refInfo(byPath, b.path)?.readWhen : 'not a book on any shelf'].filter(Boolean).join('\n')}>
              <span className="t">{b.known ? b.title : b.path}</span>
            </button>
            <span className="k mono">{b.known ? fmtTok(b.tokens) : '?'}</span>
            <button className="iconbtn x" title="Remove from boot" onClick={() => toggle(a.id, b.path, false)}>x</button>
          </div>
        ))}
      </div>

      {a.pulled?.length !== 0 && <div className="cap library-k" title="Books this agent opened with the Read tool in the last 30 days that are not in its boot list">
        Pulled<span className="faint" title={a.pulled === undefined ? (data.trackingError ?? 'the reads table could not be read') : undefined}> {a.pulled ? a.pulled.length : '?'}</span>
      </div>}
      {a.pulled === undefined || a.pulled.length === 0
        ? null
        : <div className="lbox library-blist">
              {a.pulled.map(p => (
                <div key={p.path} className={`library-brow ${p.known ? '' : 'missing'}`}>
                  <span className="library-swatch" style={{ background: p.known ? toneFor(ids, p.shelf) : 'var(--line2)' }} />
                  <button className="main" onClick={() => p.known && open(p.path, p.title)} disabled={!p.known} title={[p.path, p.known ? byPath.get(p.path)?.readWhen : 'not on a shelf'].filter(Boolean).join('\n')}>
                    <span className="t">{p.title}</span>
                  </button>
                  <span className="k mono" title="pulls in 30 days">{p.n}x</span>
                  <span className="k mono faint" title={new Date(p.last).toISOString()}>{relTime(p.last)}</span>
                  {p.known && <button className="iconbtn x" title="Add to boot" onClick={() => toggle(a.id, p.path, true)}>+</button>}
                </div>
              ))}
            </div>}

      <Picker data={data} have={new Set(rows.map(b => b.path))} ids={ids} onPick={p => toggle(a.id, p, true)} />
    </div>
  )
}

/** a boot entry (a book path, or `<book>.md#<slug>`) against the books: its title, shelf, tokens and moment; null = it names no book or no such chapter */
function refInfo(byPath: Map<string, LibBooks['books'][number]>, ref: string) {
  const { path, slug } = splitRef(ref)
  const b = byPath.get(path)
  if (!b) return null
  const c = slug ? b.chapters.find(x => x.slug === slug) : null
  if (slug && !c) return null
  return { title: c ? `${b.title} - ${c.title}` : b.title, shelf: b.shelf, tokens: c ? c.tokens : b.tokens, readWhen: c?.readWhen || b.readWhen }
}

/** what the agent loads before its first word, layer by layer, as `python app/tools/context.py --table` counts it:
 *  base, workspace (the CLAUDE.md files from its repo down to its cwd), its own prompt, the boot list; a layer that
 *  could not be read says `?`, and "all in" is then unknown, never a sum of what was read */
function Layers({ L, boot, allIn }: { L: NonNullable<LibAgent['layers']>; boot: number; allIn: number | null }) {
  const n = (v: number | null) => (v === null ? '?' : fmtTok(v))
  const warn = (v: number | null, cap: number) => (v !== null && v > cap ? 't-warn' : '')
  return (
    <div className="library-layers mono" title={`every agent boots with the base CLAUDE.md (cap ${L.caps.base.toLocaleString()}), the CLAUDE.md files above its cwd, its own prompt (cap ${L.caps.agent.toLocaleString()}) and its boot list (cap ${L.caps.boot.toLocaleString()})`}>
      <span title="the fund's CLAUDE.md"><span className="faint">base</span> <span className={warn(L.base, L.caps.base)}>{n(L.base)}</span></span>
      <span title={L.workspaceFiles.length ? L.workspaceFiles.map(f => `${f.file} ${f.tokens.toLocaleString()}`).join('\n') : 'no CLAUDE.md between the fund root and its cwd'}><span className="faint">workspace</span> {fmtTok(L.workspace)}</span>
      <span title="the body of its roster file, app/agents/<id>.md"><span className="faint">prompt</span> <span className={warn(L.agent, L.caps.agent)}>{n(L.agent)}</span></span>
      <span><span className="faint">boot</span> {fmtTok(boot)}</span>
      <b title="the sum: what the agent has read before it says a word">all in {n(allIn)}</b>
    </div>
  )
}

/** the brief, clipped with a fade at the bottom; a click opens it full length */
function Brief({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`library-brief ${open ? 'open' : ''}`} onClick={() => !open && setOpen(true)} title={open ? undefined : 'Show all'}>
      <Markdown text={text} />
      {!open && <div className="library-brief-fade" />}
      {open && <button className="library-brief-less iconbtn" onClick={e => { e.stopPropagation(); setOpen(false) }} title="Collapse">less</button>}
    </div>
  )
}

function Picker({ data, have, ids, onPick }: { data: LibBooks; have: Set<string>; ids: string[]; onPick: (p: string) => void }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const list = data.books.filter(b => !have.has(b.path) && textOk(b, q)).slice(0, 40)
  return (
    <div className="library-pick">
      <div className="cap library-k">Add</div>
      <input className="input" placeholder="Search books" value={q} onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true) }}
        onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur() } else if (e.key === 'Enter' && list[0]) { onPick(list[0].path); setQ('') } }} />
      {open && (
        <div className="pop library-pick-list" onMouseDown={e => e.preventDefault()}>
          {list.length === 0 && <Empty inline title="NO MATCH" />}
          {list.map(b => (
            <button key={b.path} className="pop-row library-pick-row" onClick={() => { onPick(b.path); setQ('') }} title={b.path}>
              <span className="library-swatch" style={{ background: toneFor(ids, b.shelf) }} />
              <span className="t">{b.title}</span>
              <span className="tag faint">{b.series}</span>
              <span className="k mono">{fmtTok(b.tokens)}</span>
            </button>
          ))}
          <button className="library-pick-close" onClick={() => setOpen(false)}>close</button>
        </div>
      )}
    </div>
  )
}
