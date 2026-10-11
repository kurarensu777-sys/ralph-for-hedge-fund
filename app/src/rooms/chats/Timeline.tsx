import { useMemo, useState, type ReactNode } from 'react'
import type { Entry } from '../../../server/chat/types.ts'
import { resultOf, ringOf, ringOfStep, stepCount, type Ring, type Step } from './steps.ts'

// THE STEP TIMELINE: an agent's work between two prose messages, one line per step behind a status
// ring (done / running / failed / denied) on a guide line. Click a step for its detail: the command
// and its output, the diff, the todos, the thought. A long finished run keeps its last steps and
// folds the rest into one "N earlier steps" line.

const PENDING: Record<string, string> = { Read: 'Reading', Edit: 'Editing', Write: 'Writing', Search: 'Searching', Find: 'Finding', List: 'Listing', Fetch: 'Fetching', 'Search web': 'Searching web', Task: 'Delegating', Bash: 'Running', PowerShell: 'Running', Skill: 'Skill', Todos: 'Todos' }
const DONE: Record<string, string> = { Read: 'Read', Edit: 'Edited', Write: 'Wrote', Search: 'Searched', Find: 'Found', List: 'Listed', Fetch: 'Fetched', 'Search web': 'Searched web', Task: 'Task', Bash: 'Ran', PowerShell: 'Ran' }
const verb = (e: Entry) => {
  const v = e.action?.verb ?? 'Tool'
  return e.status === 'created' ? (PENDING[v] ?? v) : (DONE[v] ?? v)
}

function foldLabel(items: Entry[]): string {
  const live = items.some(e => e.status === 'created')
  const reads = items.filter(e => e.action?.type === 'read')
  const books = reads.filter(e => e.action?.rel).length
  const files = reads.length - books
  const searches = items.length - reads.length
  const parts = [books ? `${books} book${books > 1 ? 's' : ''}` : '', files ? `${files} file${files > 1 ? 's' : ''}` : '', searches ? `${searches} search${searches > 1 ? 'es' : ''}` : ''].filter(Boolean)
  const v = searches && !reads.length ? (live ? 'Searching' : 'Searched') : (live ? 'Reading' : 'Read')
  return `${v} ${parts.join(', ')}`
}

const RING_TIP: Record<Ring, string> = { done: 'done', run: 'running', fail: 'failed', denied: 'denied' }
const KEEP = 6

function RingMark({ r }: { r: Ring | 'more' }) {
  const g = r === 'done' ? <path d="M3.2 6.2l1.9 1.9 3.8-4" />
    : r === 'fail' ? <path d="M4 4l4 4M8 4l-4 4" />
    : r === 'denied' ? <path d="M3.5 6h5" />
    : r === 'more' ? <path d="M3 6h.01M6 6h.01M9 6h.01" />
    : <circle cx="6" cy="6" r="1.8" />
  return <span className={`chats-ring ${r}`} title={r === 'more' ? undefined : RING_TIP[r]}><svg viewBox="0 0 12 12">{g}</svg></span>
}

export function Timeline({ steps }: { steps: Step[] }) {
  const [all, setAll] = useState(false)
  const live = steps.some(s => ringOfStep(s) === 'run')
  const cut = !all && !live && steps.length > KEEP + 2 ? steps.length - KEEP : 0
  const shown = cut ? steps.slice(cut) : steps
  return (
    <div className="chats-tl">
      {cut > 0 && (
        <div className="chats-step more">
          <RingMark r="more" />
          <div className="chats-step-c"><StepLine verbText={`${stepCount(steps.slice(0, cut))} earlier steps`} title="Show every step of this turn" onToggle={() => setAll(true)} /></div>
        </div>
      )}
      {shown.map(s => s.kind === 'fold' ? <FoldStep key={s.key} items={s.items} /> : <StepRow key={s.key} e={s.e} />)}
    </div>
  )
}

/** a step's one line: verb, target, short result; a caret when there is a detail to open */
function StepLine({ ring, verbText, target, result, extra, title, open, onToggle }: {
  ring?: Ring; verbText: string; target?: string; result?: string; extra?: ReactNode; title?: string; open?: boolean; onToggle?: () => void
}) {
  return (
    <button className={`chats-step-l ${onToggle ? '' : 'flat'}`} onClick={onToggle} title={title} disabled={!onToggle}>
      <span className="chats-verb">{verbText}</span>
      {target && <span className="chats-target">{target}</span>}
      {extra}
      {result ? <span className={`chats-res ${ring ?? ''}`}>{result}</span> : <span className="chats-sp" />}
      {onToggle && <span className="chats-caret"><svg viewBox="0 0 12 12"><path d={open ? 'M3 4.5l3 3 3-3' : 'M4.5 3l3 3-3 3'} /></svg></span>}
    </button>
  )
}

const firstWords = (s: string) => {
  const l = s.split('\n').map(x => x.trim()).find(Boolean) ?? ''
  return l.length > 64 ? l.slice(0, 63).trimEnd() + '...' : l
}

function Shell({ r, children }: { r: Ring; children: ReactNode }) {
  return <div className={`chats-step ${r}`}><RingMark r={r} /><div className="chats-step-c">{children}</div></div>
}

function StepRow({ e }: { e: Entry }) {
  const [open, setOpen] = useState(false)
  const r = ringOf(e)
  const toggle = () => setOpen(!open)
  const a = e.action
  if (a?.type === 'edit' && (e.res?.patch?.length || a.diff)) return <DiffStep e={e} />
  if (e.kind === 'thinking') {
    return <Shell r={r}>
      <StepLine ring={r} verbText={e.streaming ? 'Thinking' : 'Thought'} result={e.streaming ? '' : firstWords(e.content)} open={open} onToggle={e.content ? toggle : undefined} />
      {open && <div className="chats-think-b">{e.content}</div>}
    </Shell>
  }
  if (a?.type === 'command') {
    const out = [e.res?.stdout, e.res?.stderr].filter(Boolean).join('\n') || e.content
    const cmd = a.cmd ?? a.detail ?? ''
    return <Shell r={r}>
      <StepLine ring={r} verbText={verb(e)} target={cmd.split('\n')[0]} result={resultOf(e)} title={a.target ?? cmd} open={open} onToggle={toggle} />
      {open && <pre className="pre chats-out">{`$ ${cmd}`}{out?.trim() ? `\n\n${out}` : ''}</pre>}
    </Shell>
  }
  if (a?.type === 'todo' && a.todos?.length) {
    return <Shell r={r}>
      <StepLine ring={r} verbText={verb(e)} result={resultOf(e)} open={open} onToggle={toggle} />
      {open && <div className="chats-todos">{a.todos.map((t, i) => <div key={i} className={`chats-todo ${t.status}`}><span>{t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[>]' : '[ ]'}</span>{t.text}</div>)}</div>}
    </Shell>
  }
  const body = e.content?.trim()
  return <Shell r={r}>
    <StepLine ring={r} verbText={verb(e)} target={a?.target} result={resultOf(e)} title={a?.detail} open={open} onToggle={body ? toggle : undefined} />
    {open && body && <pre className="pre chats-out">{body}</pre>}
  </Shell>
}

function FoldStep({ items }: { items: Entry[] }) {
  const [open, setOpen] = useState(false)
  const r = ringOfStep({ key: '', kind: 'fold', items })
  return <Shell r={r}>
    <StepLine ring={r} verbText={foldLabel(items)} title={items.map(e => e.action?.detail ?? e.action?.target).join('\n')} open={open} onToggle={() => setOpen(!open)} />
    {open && <div className="chats-tl sub">{items.map(e => <StepRow key={e.id} e={e} />)}</div>}
  </Shell>
}

type DLine = { t: 'ctx' | 'add' | 'del' | 'gap'; s: string }
function diffLines(e: Entry): DLine[] {
  const p = e.res?.patch
  if (p?.length) {
    const out: DLine[] = []
    p.forEach((h, i) => {
      if (i) out.push({ t: 'gap', s: '' })
      for (const l of h.lines) {
        if (l.startsWith('\\ No newline')) continue
        out.push({ t: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx', s: /^[ +-]/.test(l) ? l.slice(1) : l })
      }
    })
    return out
  }
  const d = e.action?.diff
  if (!d) return []
  return [...(d.old ? d.old.split('\n').map(s => ({ t: 'del' as const, s })) : []), ...(d.new ? d.new.split('\n').map(s => ({ t: 'add' as const, s })) : [])]
}

function DiffStep({ e }: { e: Entry }) {
  const lines = useMemo(() => diffLines(e), [e])
  const add = lines.filter(l => l.t === 'add').length
  const del = lines.filter(l => l.t === 'del').length
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const r = ringOf(e)
  const shown = all ? lines : lines.slice(0, 40)
  return <Shell r={r}>
    <StepLine ring={r} verbText={verb(e)} target={e.action?.target} title={e.action?.detail} open={open} onToggle={() => setOpen(!open)}
      result={r === 'done' ? '' : resultOf(e)}
      extra={<span className="chats-stat"><b className="add">+{add}</b> <b className="del">-{del}</b></span>} />
    {open && (
      <div className="chats-diff chats-diff-box">
        {shown.map((l, i) => l.t === 'gap' ? <div key={i} className="gap" /> : <div key={i} className={l.t}>{l.s || ' '}</div>)}
        {!all && lines.length > 40 && <button className="chats-more" onClick={() => setAll(true)}>{lines.length - 40} more lines</button>}
      </div>
    )}
  </Shell>
}
