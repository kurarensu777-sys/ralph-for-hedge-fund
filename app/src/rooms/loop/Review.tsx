import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api, relTime, stamp, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Empty, Glyph, Icon, Sq } from '../../ui/kit.tsx'
import { shared } from './store.ts'

// REVIEW: finished turns the checks flagged, that wrote a ledger, or fell in the 5% sample.
// One card per turn, one line, its grade buttons on the card. Keys: j / k move, g good, b bad, l label (then 1-4), u undo the last grade.
// The keys belong to the list: they fire only while it holds focus (click a card, or the Head chip),
// never from anywhere else in the room.

type Span = { check: string; start: number; end: number }
export type QItem = {
  conv: string; turn: number; ts: number; agent: string | null
  reasons: ('failed' | 'ledger' | 'sample')[]; failed: string[]
  excerpt: string; spans: Span[]; detail: Record<string, string>
  state: 'open' | 'done'; grade: { value: number; label: string | null } | null
}
export type Queue = { open: number; items: QItem[] }

export const LABELS = ['invented number', 'no window', 'off scope', 'style'] as const
const CHECK_NAME: Record<string, string> = { nodash: 'em-dash', tagged: 'untagged', windowed: 'no window' }
const CHECK_HINT: Record<string, string> = { nodash: 'an em-dash or en-dash', tagged: 'a %, $ or bp figure with no [V] / [1] / [U] / [API] near it', windowed: 'a return or ann% figure with no date or window near it' }
const REASON_HINT: Record<string, string> = { failed: 'a check failed', ledger: 'the turn wrote a desk ledger', sample: 'the deterministic 5% sample' }

export function useQueue() { return useApi<Queue>('/api/loop/queue', ['loop']) }

const cursor = shared<string>('loop.review', '')
const keyOf = (i: QItem) => `${i.conv}#${i.turn}`

/** markdown syntax is noise in a three-line excerpt: drop emphasis, code ticks and list bullets,
 *  fold blank lines. `lineStart` says the piece begins a line, so a leading bullet is one */
const BULLET = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/
const plain = (t: string, lineStart = false) => {
  const s = t.replace(/\*\*|__|`/g, '').replace(/\n\s*\n+/g, '\n').replace(/\n[ \t]*(?:[-*+]|\d+[.)])[ \t]+/g, '\n')
  return lineStart ? s.replace(BULLET, '') : s
}

/** the excerpt around the first flagged span, spans marked */
function Excerpt({ it }: { it: QItem }) {
  const text = it.excerpt
  if (!text.trim()) return <div className="loop-rv-x"><span className="nil" title="no assistant text was indexed for this turn" /></div>
  const first = it.spans.length ? Math.min(...it.spans.map(s => s.start)) : 0
  // start at a line (or at least a word) boundary before the first flag, never mid-word; a
  // server-clipped excerpt carries its own leading '...', so it gets one ellipsis, never two
  let from = Math.max(0, first - 60)
  if (from > 0) {
    const nl = text.lastIndexOf('\n', first - 1)
    const sp = text.indexOf(' ', from)
    from = nl >= 0 && nl >= from - 20 ? nl + 1 : sp >= 0 && sp < first ? sp + 1 : from
  }
  const lead = from > 0 || text.startsWith('...')
  if (from === 0 && text.startsWith('...')) from = 3
  const to = Math.min(text.length, from + 420)
  const spans = it.spans.filter(s => s.end > from && s.start < to).sort((a, b) => a.start - b.start)
  const out: ReactNode[] = []
  let at = from
  for (const s of spans) {
    const a = Math.max(at, s.start), b = Math.min(to, s.end)
    if (b <= a) continue
    if (a > at) out.push(plain(text.slice(at, a), at === from || text[at - 1] === '\n'))
    out.push(<mark key={`${s.check}${a}`} className={`loop-hl h-${s.check}`} title={CHECK_HINT[s.check]}>{text.slice(a, b)}</mark>)
    at = b
  }
  if (at < to) out.push(plain(text.slice(at, to), at === from || text[at - 1] === '\n'))
  if (typeof out[0] === 'string') out[0] = plain(out[0].trimStart(), true)
  return <div className="loop-rv-x">{lead && '... '}{out}{to < text.length && ' ...'}</div>
}

/** the card's title: the excerpt's first sentence, whole, no clip marks, no markdown (the tooltip's text) */
export function titleFull(excerpt: string): string {
  const t = plain(excerpt.replace(/^\s*\.\.\.\s*/, ''), true).replace(/\s+/g, ' ').trim()
  if (!t) return '-'
  const m = /^(.{12,}?[.!?:])(\s|$)/.exec(t)
  return m ? m[1] : t
}
/** the title as drawn: at most two lines (the card clamps it), so a runaway sentence is cut here too */
export function titleLine(excerpt: string): string {
  const one = titleFull(excerpt)
  return one.length > 160 ? `${one.slice(0, 159).trimEnd()}…` : one
}

/** a review card's state word: omitted while it is the lane's usual 'open' (every card shares it),
 *  drawn only on a card whose state differs (closed, blocked...), and drawn when the state is unknown */
export function stateWord(state: string | null | undefined): string | null {
  if (state === 'open') return null
  return state ? state : 'unknown'
}
const STATE_CLS: Record<string, string> = { closed: 'ok', done: 'ok', blocked: 'fail', unknown: '' }
const TICK = 'M3.5 8.5l3 3 6-7'
const LABEL = 'M2.5 2.5h5.5l5.5 5.5-5.5 5.5-5.5-5.5zM5.5 5.5h.01'

/** an agent as its category glyph, the name in the tooltip; a turn with no agent is the one neutral "?" */
export function AgentMark({ id }: { id: string | null }) {
  if (!id) return <span className="loop-am" title="unattributed"><Sq tone="unk">?</Sq></span>
  return <span className="loop-am" title={id}><Glyph id={id} /></span>
}

/** letters and digits only, lower case: "Done: 3 files." and "done 3 files" read as one line */
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '')
/** the body adds nothing when the whole excerpt is the title line (a one-sentence turn) */
export function bodyIsTitle(excerpt: string): boolean {
  const title = titleLine(excerpt)
  if (title === '-' || title.endsWith('…')) return false
  const body = plain(excerpt.replace(/^\s*\.\.\.\s*/, ''), true)
  return norm(body) === norm(title)
}

function GradeDot({ g }: { g: QItem['grade'] }) {
  if (!g) return null
  return <span className={`loop-rv-g ${g.value >= 0.5 ? 'ok' : 'fail'}`} title={`${g.value >= 0.5 ? 'good' : 'bad'}${g.label ? `: ${g.label}` : ''}`} />
}

export function ReviewCards({ q }: { q: Queue }) {
  const { toast, go } = useNav()
  const [cur, setCur] = cursor.use()
  const [pick, setPick] = useState(false)
  const [more, setMore] = useState(false)
  /** the list holds focus (a click on a card, or Tab onto the list): the keys and the cursor ring follow it */
  const [focus, setFocus] = useState(false)
  const undo = useRef<{ conv: string; turn: number }[]>([])
  const open = q.items.filter(i => i.state === 'open')
  const done = q.items.filter(i => i.state === 'done').slice(0, 5)
  const idx = Math.max(0, open.findIndex(i => keyOf(i) === cur))
  const sel = open[idx] ?? null
  const box = useRef<HTMLDivElement>(null)

  const post = async (it: QItem, value: 'good' | 'bad' | null, label?: string) => {
    try {
      await api('/api/loop/grade', { body: { conv: it.conv, turn: it.turn, value, ...(label ? { label } : {}) } })
      if (value === null) toast('undone')
      else {
        undo.current.push({ conv: it.conv, turn: it.turn })
        const next = open[idx + 1] ?? open[idx - 1]
        setCur(next ? keyOf(next) : '')
      }
      // the graded card (and the button that was clicked) unmounts: keep the keys live on the list
      if (!box.current?.contains(document.activeElement) || document.activeElement?.tagName === 'BUTTON') box.current?.focus({ preventScroll: true })
    } catch (e) { toast(`grade: ${(e as Error).message}`, true) }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (pick) {
      const n = Number(e.key)
      if (n >= 1 && n <= LABELS.length && sel) { e.preventDefault(); setPick(false); void post(sel, 'bad', LABELS[n - 1]) }
      else if (e.key === 'Escape' || e.key === 'l') { e.preventDefault(); setPick(false) }
      return
    }
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault()
      const n = open[Math.min(open.length - 1, Math.max(0, idx + (e.key === 'j' ? 1 : -1)))]
      if (n) setCur(keyOf(n))
    } else if (e.key === 'g' && sel) { e.preventDefault(); void post(sel, 'good') }
    else if (e.key === 'b' && sel) { e.preventDefault(); void post(sel, 'bad') }
    else if (e.key === 'l' && sel) { e.preventDefault(); setPick(true) }
    else if (e.key === 'u') {
      e.preventDefault()
      const last = undo.current.pop()
      if (!last) { toast('nothing to undo'); return }
      const it = q.items.find(i => i.conv === last.conv && i.turn === last.turn) ?? { ...last } as QItem
      void post(it, null).then(() => setCur(`${last.conv}#${last.turn}`))
    }
  }

  useEffect(() => { setMore(false); box.current?.querySelector('.loop-rv.on')?.scrollIntoView({ block: 'nearest' }) }, [cur])

  return <div ref={box} className={`loop-rv-list ${focus ? 'focus' : ''}`} tabIndex={0} onKeyDown={onKey}
    onFocus={() => setFocus(true)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { setFocus(false); setPick(false) } }}>
    {open.length === 0 && <Empty inline center title="NONE" />}
    {open.map((it, i) => <div key={keyOf(it)} className={`card loop-rv ${i === idx ? 'on' : ''}`}
      // select on mousedown, BEFORE the list takes focus: the cursor lands in one render
      onMouseDown={e => { if (e.button !== 0) return; setCur(keyOf(it)); setFocus(true) }}
      onClick={() => { setCur(keyOf(it)); box.current?.focus({ preventScroll: true }) }}>
      {/* one line: whose, what (the whole first sentence in the tooltip), when */}
      <div className="loop-rv-l1">
        <AgentMark id={it.agent} />
        <span className="loop-rv-t" title={titleFull(it.excerpt)}>{titleLine(it.excerpt)}</span>
        {stateWord(it.state) && <span className={`loop-rv-st ${STATE_CLS[stateWord(it.state) as string] ?? ''}`} title={`state ${stateWord(it.state)}`}>{stateWord(it.state)}</span>}
        <span className="faint mono loop-small" title={`${stamp(it.ts)} · turn ${it.turn + 1}`}>{relTime(it.ts)}</span>
      </div>
      {/* why it is here as chips; the grade as one click, on every card */}
      <div className="loop-rv-l2">
        {it.failed.map(c => <span key={c} className="pill lbl warn" title={CHECK_HINT[c]}>{CHECK_NAME[c] ?? c}</span>)}
        {it.reasons.includes('ledger') && <span className="pill lbl ask" title={`${REASON_HINT.ledger}: ${it.detail.ledger ?? ''}`}>ledger</span>}
        {it.reasons.includes('sample') && <span className="pill lbl" title={REASON_HINT.sample}>sample</span>}
        <span className="loop-rv-btns" role="group" aria-label="grade this turn">
          <button className="loop-gb ok" title="good (key g)" aria-label="grade good" onClick={e => { e.stopPropagation(); void post(it, 'good') }}><svg className="ico" viewBox="0 0 16 16"><path d={TICK} /></svg></button>
          <button className="loop-gb fail" title="bad (key b)" aria-label="grade bad" onClick={e => { e.stopPropagation(); void post(it, 'bad') }}><Icon name="x" /></button>
          <button className={`loop-gb ${pick && i === idx ? 'on' : ''}`} aria-expanded={pick && i === idx} title="bad, with a label (key l, then 1-4)" aria-label="grade bad with a label"
            onClick={e => { e.stopPropagation(); setCur(keyOf(it)); setPick(!(pick && i === idx)) }}><svg className="ico" viewBox="0 0 16 16"><path d={LABEL} /></svg></button>
          {/* an icon, never the word 'open': on a card that word reads as the card's state */}
          <button className="loop-gb" title="open the conversation" aria-label="open the conversation" onClick={e => { e.stopPropagation(); go('chats', it.conv) }}><Icon name="hand" /></button>
          {pick && i === idx && <div className="pop loop-rv-pick">{LABELS.map((l, n) => <button key={l} onClick={e => { e.stopPropagation(); setPick(false); void post(it, 'bad', l) }}><b>{n + 1}</b>{l}</button>)}</div>}
        </span>
      </div>
      {/* the cursor card opens two lines of the body; a click on it opens the rest */}
      {i === idx && !bodyIsTitle(it.excerpt) && <div className={`loop-rv-xw ${more ? 'open' : ''}`} title={more ? 'show less' : 'show the whole excerpt'} onClick={e => { e.stopPropagation(); setMore(!more) }}><Excerpt it={it} /></div>}
    </div>)}
    {done.length > 0 && <div className="loop-rv-done" title="graded; u undoes the last one">
      {done.map(it => <div key={keyOf(it)} className="loop-rv-d"><GradeDot g={it.grade} /><AgentMark id={it.agent} /><span className="loop-subj1 faint">{titleLine(it.excerpt)}</span><span className="faint loop-small">{it.grade?.label ?? ''}</span><span className="faint mono loop-small">{relTime(it.ts)}</span></div>)}
    </div>}
  </div>
}
