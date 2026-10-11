import { marked } from 'marked'
import { useEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { Status } from '../../shared/types.ts'
import { badgeMap, naiveBadge } from '../../shared/badge.ts'
import { catVar, categoryOf } from './categories.ts'

/** status dot. `run` = working, `ask` = waiting on you */
export function Dot({ s, title }: { s: Status | 'run' | 'ask' | string; title?: string }) {
  return <span className={`dot ${s}`} title={title ?? s} />
}

export function Btn(props: { children: ReactNode; onClick?: () => void; kind?: 'primary' | 'danger' | 'ghost'; sm?: boolean; disabled?: boolean; title?: string; type?: 'button' | 'submit' }) {
  const cls = ['btn', props.kind, props.sm && 'sm'].filter(Boolean).join(' ')
  return <button type={props.type ?? 'button'} className={cls} onClick={props.onClick} disabled={props.disabled} title={props.title}>{props.children}</button>
}

/** the roster as a picker, a dormant agent marked; `blank` is the unpicked label */
export function AgentSelect({ value, onChange, agents, blank, cls = 'input', disabled, title }: { value: string; onChange: (v: string) => void; agents: { id: string; name: string; mode?: string }[]; blank: string; cls?: string; disabled?: boolean; title?: string }) {
  const known = !value || agents.some(a => a.id === value)
  return <select className={cls} value={value} disabled={disabled} title={title} aria-label="agent" onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.value)}>
    <option value="">{blank}</option>
    {agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.mode === 'dormant' ? ' (dormant)' : ''}</option>)}
    {!known && <option value={value}>{value}</option>}
  </select>
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="seg">{options.map(o => <button key={o.id} className={o.id === value ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>
}

export function Tag({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone ?? ''}`}>{children}</span>
}

/** the shape of what is loading: a skeleton of it, never a word on a blank panel */
export type SkelKind = 'rows' | 'table' | 'cards' | 'cg' | 'lines' | 'doc'

/** SKELETON: soft bars in the shape of the thing that is coming (one slow shimmer) */
export function Skeleton({ kind = 'rows', n, pad = false }: { kind?: SkelKind; n?: number; pad?: boolean }) {
  const count = n ?? { rows: 6, table: 9, cards: 6, cg: 4, lines: 3, doc: 8 }[kind]
  const cls = { rows: 'row', table: 'row', cards: 'card', cg: 'cg', lines: 'line', doc: 'line' }[kind]
  // lines taper so a block of them reads as text, not as a table
  const w = (i: number) => kind === 'lines' || kind === 'doc' ? `${[92, 78, 85, 64, 88, 71, 80, 55][i % 8]}%` : undefined
  return (
    <div className={`skel ${kind === 'cards' ? 'cards' : ''} ${pad ? 'pad' : ''}`} role="status" aria-label="loading" aria-busy="true">
      {(kind === 'table' || kind === 'rows') && <i className="head" />}
      {kind === 'doc' && <i className="row" style={{ width: '46%' }} />}
      {Array.from({ length: count }, (_, i) => <i key={i} className={cls} style={w(i) ? { width: w(i) } : undefined} />)}
    </div>
  )
}

/** empty (nothing there, fine) / failed (something broke) / unknown (cannot tell) / loading (a
 *  skeleton). `inline` is the one-line form for inside a card, a lane or a drawer section: a dot,
 *  the word, the reason (its full text in the tooltip) */
export function Empty({ state = 'empty', title, children, inline = false, sm = false, skel, center = false }: {
  state?: 'empty' | 'failed' | 'unknown' | 'loading'; title?: string; children?: ReactNode; inline?: boolean; sm?: boolean; skel?: SkelKind; center?: boolean
}) {
  if (state === 'loading') return <Skeleton kind={skel ?? (inline ? 'lines' : 'rows')} n={inline ? 2 : undefined} />
  const big = title ?? { empty: 'NOTHING HERE', failed: 'FAILED', unknown: 'UNKNOWN' }[state]
  if (inline) {
    const why = typeof children === 'string' ? children : undefined
    return (
      <div className={`empty inline ${state} ${center ? 'center' : ''}`} title={why}>
        {state !== 'empty' && <span className={`dot ${state === 'failed' ? 'fail' : 'unknown'}`} />}
        <span className="big">{big}</span>{children && <span className="why">{children}</span>}
      </div>
    )
  }
  return <div className={`empty ${state} ${sm ? 'sm' : ''}`}><div><div className="big">{big}</div>{children && <div>{children}</div>}</div></div>
}

/** render a Loaded<T>: a skeleton while loading, failed, empty, or the content */
export function Load<T>({ q, children, empty, skel, inline = false }: {
  q: { data: T | null; error: string | null; loading: boolean }; children: (d: T) => ReactNode; empty?: (d: T) => boolean; skel?: SkelKind; inline?: boolean
}) {
  if (q.error && !q.data) return <Empty state="failed" inline={inline}>{q.error}</Empty>
  if (!q.data) return <Empty state="loading" skel={skel} inline={inline} />
  if (empty?.(q.data)) return <Empty inline={inline} />
  return <>{children(q.data)}</>
}

/** a colour square: WHOSE it is. `c` is any CSS colour (a category's, a market's); the letters are
 *  dark on it. One size ladder (12 to 32); `round` is the same mark in a person-shaped slot */
export function Sq({ c, size = 18, round = false, tone, title, children }: {
  c?: string; size?: 12 | 14 | 16 | 18 | 20 | 24 | 28 | 32; round?: boolean; tone?: 'unk' | 'neutral' | 'you' | 'none' | 'soft' | 'off'; title?: string; children?: ReactNode
}) {
  return <span className={['sq', `s${size}`, round && 'round', tone].filter(Boolean).join(' ')} style={c ? { '--c': c } as CSSProperties : undefined} title={title}>{children}</span>
}

/** a round filled count or short word; `out` is the larger outlined state chip */
export function Pill({ tone, out = false, lbl = false, title, children, onClick }: {
  tone?: 'ok' | 'warn' | 'fail' | 'ask' | 'accent' | 'faint' | 'clear'; out?: boolean; lbl?: boolean; title?: string; children: ReactNode; onClick?: () => void
}) {
  const cls = ['pill', out && 'out', lbl && 'lbl', tone].filter(Boolean).join(' ')
  return onClick ? <button type="button" className={cls} title={title} onClick={onClick}>{children}</button> : <span className={cls} title={title}>{children}</span>
}

/** a round toggle / filter chip */
export function Chip({ on = false, onClick, title, children, sans = false, sm = false, disabled }: {
  on?: boolean; onClick?: () => void; title?: string; children: ReactNode; sans?: boolean; sm?: boolean; disabled?: boolean
}) {
  return <button type="button" className={['chip', on && 'on', sans && 'sans', sm && 'sm'].filter(Boolean).join(' ')} onClick={onClick} title={title} disabled={disabled} aria-pressed={onClick ? on : undefined}>{children}</button>
}

/** a card head's live mark: blue when something waits on the owner, the accent pulse while working;
 *  nothing when idle */
export function Live({ waiting, working }: { waiting: number; working: number }) {
  if (!waiting && !working) return null
  return <Pill title={[waiting && `${waiting} waiting on you`, working && `${working} working`].filter(Boolean).join(', ')}>
    <span className={`dot ${waiting ? 'ask' : 'run'}`} />{waiting + working}
  </Pill>
}

/** a track and its fill; `v` 0..1, or null for an empty hollow track (not measured) */
export function Meter({ v, tone, sm = false, grow = false, title }: { v: number | null; tone?: 'ok' | 'warn' | 'fail' | 'accent' | 'c'; sm?: boolean; grow?: boolean; title?: string }) {
  const cls = ['meter', tone, sm && 'sm', grow && 'grow', v === null && 'hollow'].filter(Boolean).join(' ')
  return <span className={cls} title={title}><i style={{ '--v': `${Math.max(0, Math.min(1, v ?? 0)) * 100}%` } as CSSProperties} /></span>
}

export function Group({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  return <><div className="grp"><span>{label}</span>{right}</div>{children}</>
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text.replace(/^---\n[\s\S]*?\n---\n/, ''), { async: false }) as string, [text])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) void renderMermaid(ref.current) }, [html])
  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * ```mermaid fences become diagrams. mermaid is loaded only when a page has one (its own chunk),
 * in strict mode (no HTML labels, no script); a diagram that does not parse stays as its source,
 * in the same scrolling block every other code fence gets.
 */
let mermaidReady: Promise<typeof import('mermaid').default> | null = null
let mermaidSeq = 0
async function renderMermaid(root: HTMLElement) {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')] as HTMLElement[]
  if (!blocks.length) return
  mermaidReady ??= import('mermaid').then(m => {
    m.default.initialize({
      startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: 'inherit',
      // the cockpit palette (styles.css :root), so a diagram reads as part of the page
      themeVariables: {
        darkMode: true, background: '#0e1013', fontSize: '12px',
        primaryColor: '#16191d', primaryTextColor: '#e6e8eb', primaryBorderColor: '#30363e',
        lineColor: '#6c737d', textColor: '#a0a7b1', clusterBkg: '#111316', clusterBorder: '#30363e',
        edgeLabelBackground: '#0e1013', titleColor: '#d9b35b',
      },
    })
    return m.default
  })
  let mermaid: typeof import('mermaid').default
  try { mermaid = await mermaidReady } catch { return }
  for (const code of blocks) {
    const pre = code.parentElement
    if (!pre || !pre.isConnected) continue
    try {
      const { svg } = await mermaid.render(`md-mermaid-${++mermaidSeq}`, code.textContent ?? '')
      if (!pre.isConnected) continue
      const fig = document.createElement('div')
      fig.className = 'md-mermaid'
      fig.innerHTML = svg
      // natural size, never shrunk to the column (labels would go unreadable): the block scrolls
      const el = fig.querySelector('svg')
      const w = el?.viewBox?.baseVal?.width
      if (el && w) { el.removeAttribute('width'); el.style.width = `${Math.ceil(w)}px`; el.style.maxWidth = 'none' }
      pre.replaceWith(fig)
    } catch { pre.title = 'mermaid source (did not parse)' }
  }
}

export function MarketTag({ m }: { m: string }) {
  const label = m === 'predmkts' ? 'prediction' : m
  return <Tag tone={m}>{label}</Tag>
}

/** the roster's agent ids, set once by the shell, so every glyph uses the collision-aware rule */
let BADGES = new Map<string, string>()
const badgeSubs = new Set<() => void>()
export function setBadgeIds(ids: string[]) {
  BADGES = badgeMap(ids)
  badgeSubs.forEach(f => f())
}
const subBadges = (f: () => void) => { badgeSubs.add(f); return () => { badgeSubs.delete(f) } }
export const badgeOf = (id: string) => BADGES.get(id) ?? naiveBadge(id)

/** an agent's two letters, ONE rule everywhere (card groups, command bar, island, board, glyphs):
 *  a standing agent wears its category card's letters (FU, AP, PL, RS), every other agent its
 *  collision-aware badge (dash:trade TR, dash:tradfi TD) */
export const markOf = (id: string) => {
  const c = categoryOf(id)
  return c.id === id ? c.abbr : badgeOf(id)
}

/** a 16px glyph from a short id: "dash:trade" -> "TR", "dash:tradfi" -> "TD"; the owner ("you") is a person, never "YO" */
export function Glyph({ id, tone, neutral = false, size }: { id: string; tone?: string; neutral?: boolean; size?: 15 | 16 | 32 }) {
  const map = useSyncExternalStore(subBadges, () => BADGES)
  const sz = size ? ` s${size}` : ''
  if (id === 'you' || id === 'owner') return <span className={`glyph glyph-you${sz}`} data-tone={tone} title="owner"><Icon name="person" /></span>
  // the category colour paints the square (src/ui/categories.ts); tone only dims it (off). neutral =
  // an id no agent row answers to: ONE neutral mark (a filled grey "?" square, the id in the
  // tooltip), never a category's colour and never letters that pose as an agent's
  if (neutral) return <span className={`glyph glyph-unk${sz}`} data-tone={tone} title={`${id}: not an agent in the roster`}>?</span>
  const c = categoryOf(id)
  return <span className={`glyph${sz}`} data-tone={tone} style={catVar(c)}>{c.id === id ? c.abbr : map.get(id) ?? naiveBadge(id)}</span>
}

/** a 14px stroke icon; the word it replaces rides in `title` */
const ICONS: Record<string, string> = {
  play: 'M5 3.5v9l7.5-4.5z',
  lock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3l2 1.5',
  plus: 'M8 3v10M3 8h10',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.5h.01',
  hand: 'M3 8h7M7.5 5l3 3-3 3M13 3v10',
  book: 'M3 3h4a2 2 0 0 1 2 2v8a1.5 1.5 0 0 0-1.5-1.5H3zM13 3H9.5M13 3v8.5h-4',
  quiet: 'M2.5 8h11M5 5.5h6M5 10.5h6',
  bot: 'M3.5 6h9v6.5h-9zM8 6V3.5M8 3.5h.01M6 9h.01M10 9h.01',
  x: 'M4 4l8 8M12 4l-8 8',
  person: 'M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.6-2.4 2.6-3.5 5-3.5s4.4 1.1 5 3.5',
  note: 'M3.5 3.5h9v6.5l-3 3h-6zM9.5 13v-3h3',
  clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5',
  eyeoff: 'M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM8 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM3 13L13 3',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  row: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11',
  bulb: 'M6 12.5h4M6.5 14h3M8 2a4 4 0 0 0-2.5 7.1c.5.4.8 1 .8 1.6v.3h3.4v-.3c0-.6.3-1.2.8-1.6A4 4 0 0 0 8 2z',
  scan: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M5 8h6',
  logs: 'M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5',
  term: 'M3 4.5l3.5 3.5L3 11.5M8 12h5',
}
export function Icon({ name, title, tone }: { name: keyof typeof ICONS | string; title?: string; tone?: string }) {
  return <svg className={`ico ${tone ?? ''}`} viewBox="0 0 16 16" aria-label={title} role={title ? 'img' : undefined}>{title && <title>{title}</title>}<path d={ICONS[name] ?? ''} /></svg>
}

/** THE 24h HEAT STRIP, one component for every room: 24 equal rounded cells, oldest left, the hour in
 *  progress on the right. A cell's class is `hc-<state>`; it draws four states (ok green, fail red,
 *  missed amber, no reading grey, never green by default) plus `hc-part` (served part of the hour). Width comes from the container. */
export function HeatStrip({ cells, label, big = false }: { cells: { cls: string; title: string }[]; label: string; big?: boolean }) {
  return (
    <span className={`heat ${big ? 'big' : ''}`} role="img" aria-label={label}>
      {cells.map((c, i) => <i key={i} className={c.cls} title={c.title} />)}
    </span>
  )
}

/** a strip with nothing to draw (no record, or the thing is off): 24 grey cells that say why */
export function HeatBlank({ state = 'none', why, big = false }: { state?: 'none' | 'unknown'; why: string; big?: boolean }) {
  return <HeatStrip label={why} big={big} cells={Array.from({ length: 24 }, () => ({ cls: `hc-${state}`, title: why }))} />
}

/** the short name of a failure: the exception class when there is one, else the first words */
export function failShort(detail: string): string {
  const m = /\b([A-Z]\w*(?:Error|Exception))\b/.exec(detail)
  if (m) return m[1]
  const first = detail.split('\n')[0].trim()
  return first.length > 40 ? `${first.slice(0, 39)}…` : first
}

/** ONE short FAILED line for something that broke: what, and the error's short name; the whole
 *  detail (a traceback, a reason) rides in the tooltip, never on the page */
export function FailLine({ what, detail }: { what: string; detail: string }) {
  return <div className="failline" title={detail}><span className="dot fail" /><b>{what} failed</b><span className="failline-why">{failShort(detail)}</span></div>
}

/** THE CARD GROUP (the owner's option B side list): a rounded card per group - a coloured square,
 *  the name, an optional state line under it (`role`: "dormant", "n/m up"; never a description),
 *  what is live on the right, a fold chevron - and its rows inside.
 *  `color` is any CSS colour (a category's, or a market's). Rows use `.cg-it`.
 *  The head does ONE thing: with `onPick` it selects (and a separate chevron button folds, when
 *  `onToggle` is given too); with only `onToggle` it folds. `hover` actions stand in for `live`
 *  while the pointer is on the head. `index` is a one-row card with no body. */
export function CardGroup({ abbr, color, name, role, right, live, hover, closed = false, onToggle, onPick, on = false, dim = false,
  dormant = false, neutral = false, index = false, title, id, className, children }: {
  abbr: ReactNode; color: string; name: ReactNode; role?: ReactNode; right?: ReactNode; live?: ReactNode; hover?: ReactNode
  closed?: boolean; onToggle?: () => void; onPick?: () => void; on?: boolean; dim?: boolean; dormant?: boolean; neutral?: boolean
  index?: boolean; title?: string; id?: string; className?: string; children?: ReactNode
}) {
  const act = onPick ?? onToggle
  const key = (e: KeyboardEvent<HTMLElement>) => { if (act && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act() } }
  const chev = <svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg>
  const split = !!(onPick && onToggle)
  const cls = ['cg', closed && 'closed', dim && 'dim', dormant && 'dormant', neutral && 'neutral', index && 'index', className].filter(Boolean).join(' ')
  const mark = <Sq c={neutral ? undefined : color} size={24} tone={neutral ? 'neutral' : undefined}>{abbr}</Sq>
  const text = <span className="cg-t"><span className={`cg-nm ${onPick ? 'pickc' : ''}`}>{name}</span>{role !== undefined && role !== '' && <span className="cg-role">{role}</span>}</span>
  const marks = <>{hover && <span className="cg-hov" onClick={e => e.stopPropagation()}>{hover}</span>}{live && <span className="cg-live">{live}</span>}{right}</>
  return (
    <div className={cls} style={{ '--c': color } as CSSProperties} data-card={id}>
      {split
        ? <div className={`cg-h ${on ? 'on' : ''}`} title={title}>
            <button type="button" className="cg-main" onClick={onPick} aria-pressed={on}>{mark}{text}</button>
            <span className="cg-r">{marks}
              <button type="button" className="cg-chev" aria-label={closed ? 'unfold' : 'fold'} aria-expanded={!closed} title={closed ? 'Unfold' : 'Fold'} onClick={onToggle}>{chev}</button></span>
          </div>
        : <div className={`cg-h ${on ? 'on' : ''}`} role="button" tabIndex={0} title={title} onClick={act} onKeyDown={key}
            aria-expanded={onPick || index ? undefined : !closed} aria-pressed={onPick ? on : undefined}>
            {mark}{text}
            <span className="cg-r">{marks}{!onPick && !index && <span className="cg-chev">{chev}</span>}</span>
          </div>}
      {!closed && !index && children && <div className="cg-k">{children}</div>}
    </div>
  )
}
