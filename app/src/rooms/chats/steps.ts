import type { Entry } from '../../../server/chat/types.ts'

// THE TURN TIMELINE (pure half, tested in test/chats-steps.test.ts). An agent's work between two
// prose messages is a run of STEPS: each tool call, a folded run of reads/searches, or a thought.
// Each step is one line - a verb, a target, a short result - behind a status ring.

export type Ring = 'done' | 'run' | 'fail' | 'denied'
export type Step = { key: string; kind: 'entry'; e: Entry } | { key: string; kind: 'fold'; items: Entry[] }
export type Row = { key: string; kind: 'entry'; e: Entry } | { key: string; kind: 'steps'; steps: Step[] }

const FOLDABLE = new Set(['read', 'search'])
const isStep = (e: Entry) => e.kind === 'tool' || e.kind === 'thinking'

/** the feed's rows: prose, bubbles, cards and decisions stay entries; every run of tools and thoughts is ONE steps row */
export function rowsOf(entries: Entry[]): Row[] {
  const out: Row[] = []
  let steps: Step[] = []
  let run: Entry[] = []
  const flushRun = () => {
    if (run.length >= 2) steps.push({ key: 'f:' + run[0].id, kind: 'fold', items: run })
    else for (const e of run) steps.push({ key: e.id, kind: 'entry', e })
    run = []
  }
  const flush = () => {
    flushRun()
    if (steps.length) out.push({ key: 's:' + steps[0].key, kind: 'steps', steps })
    steps = []
  }
  for (const e of entries) {
    if (e.nested) continue
    if (!isStep(e)) { flush(); out.push({ key: e.id, kind: 'entry', e }); continue }
    if (e.kind === 'tool' && e.action && FOLDABLE.has(e.action.type) && e.status !== 'failed') { run.push(e); continue }
    flushRun()
    steps.push({ key: e.id, kind: 'entry', e })
  }
  flush()
  return out
}

export function ringOf(e: Entry): Ring {
  if (e.kind === 'thinking') return e.streaming ? 'run' : 'done'
  return e.status === 'created' ? 'run' : e.status === 'failed' ? 'fail' : e.status === 'denied' ? 'denied' : 'done'
}

export function ringOfStep(s: Step): Ring {
  if (s.kind === 'entry') return ringOf(s.e)
  const rs = s.items.map(ringOf)
  return rs.includes('fail') ? 'fail' : rs.includes('run') ? 'run' : rs.includes('denied') ? 'denied' : 'done'
}

const lines = (s: string | undefined) => (s ?? '').split('\n').map(l => l.trim()).filter(Boolean)

/** a test or check tally in a command's output, in a few words ("pass 24/24", "1 fail · 16 pass");
 *  the LAST tally wins (a runner prints its summary at the end); null when there is none */
export function tallyOf(text: string): string | null {
  let out: string | null = null
  for (const l of lines(text)) {
    let m: RegExpExecArray | null
    // vitest / jest: "Tests  1 failed | 16 passed (17)", "Tests  633 passed (633)"
    if ((m = /\bTests?\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(l))) out = m[1] && m[1] !== '0' ? `${m[1]} fail · ${m[2]} pass` : `pass ${m[2]}`
    // pytest: "5 passed, 1 failed in 0.3s", "=== 12 passed in 1.2s ==="
    else if ((m = /\b(\d+) passed(?:, (\d+) failed)?/.exec(l))) out = m[2] && m[2] !== '0' ? `${m[2]} fail · ${m[1]} pass` : `pass ${m[1]}`
    // "16/16 ALL PASS", "86/86 checks", "verify 17/17 ok"
    else if ((m = /\b(\d+)\s*\/\s*(\d+)\b(?=.*\b(?:pass|PASS|ok|OK|checks?|green)\b)/.exec(l))) out = m[1] === m[2] ? `pass ${m[1]}/${m[2]}` : `${Number(m[2]) - Number(m[1])} fail · ${m[1]}/${m[2]}`
    // "68 ok, 0 failed"
    else if ((m = /\b(\d+) ok,\s*(\d+) failed/.exec(l))) out = m[2] === '0' ? `pass ${m[1]}` : `${m[2]} fail · ${m[1]} ok`
  }
  return out
}

/** an exit code a runner printed ("exit code 2", "exited with code 1") */
const exitOf = (text: string) => { const m = /\bexit(?:ed with)?(?: code|:)?\s+(\d+)/i.exec(text); return m ? `exit ${m[1]}` : null }
/** the exception class a traceback names (ModuleNotFoundError), the honest short name of a failure */
const errName = (text: string) => { const m = /\b([A-Z]\w*(?:Error|Exception))\b/.exec(text); return m ? m[1] : null }
const count = (n: number) => (n ? `${n} ${n === 1 ? 'line' : 'lines'}` : 'no output')

/** the short result on a step's line: what came back, in a FEW words ("pass 24/24", "406 lines",
 *  "exit 1"), never a raw fragment of the output; '' when nothing honest can be said */
export function resultOf(e: Entry): string {
  if (e.kind === 'thinking') return ''
  if (e.status === 'created') return ''
  if (e.status === 'denied') return 'denied'
  const a = e.action
  if (e.status === 'failed') {
    const all = [e.res?.stderr, e.res?.stdout, e.content].filter(Boolean).join('\n')
    const first = lines(e.res?.stderr)[0] ?? lines(e.content)[0] ?? ''
    return tallyOf(all) ?? exitOf(all) ?? errName(all) ?? (first && first.length <= 28 ? first : 'failed')
  }
  if (a?.type === 'todo' && a.todos?.length) return `${a.todos.filter(t => t.status === 'completed').length}/${a.todos.length} done`
  if (a?.type === 'edit') return ''
  if (a?.type === 'read') return e.res?.lines ? `${e.res.lines} lines` : ''
  if (a?.type === 'search') {
    const ls = lines(e.content)
    if (!ls.length || /^no (matches|files|results)/i.test(ls[0])) return 'none'
    return `${ls.length} ${ls.length === 1 ? 'hit' : 'hits'}`
  }
  if (a?.type === 'command') {
    const text = [e.res?.stdout, e.res?.stderr].filter(Boolean).join('\n') || e.content
    const push = /\b\w+ -> \w+/.test(text) && /^To /m.test(text)
    const commit = /^\[[\w./-]+ ([0-9a-f]{7,})\]/m.exec(text)
    return tallyOf(text) ?? exitOf(text) ?? (commit ? `commit ${commit[1].slice(0, 7)}` : push ? 'pushed' : count(lines(text).length))
  }
  const first = lines(e.content)[0] ?? ''
  return first.length <= 28 ? first : count(lines(e.content).length)
}

/** how many steps a steps row holds, counting a fold as its items */
export const stepCount = (steps: Step[]) => steps.reduce((n, s) => n + (s.kind === 'fold' ? s.items.length : 1), 0)
