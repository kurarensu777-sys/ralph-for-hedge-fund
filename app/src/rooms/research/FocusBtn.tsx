import { toggleFocus, useFocusOf } from '../../shell/focus.ts'

// The focus button on each column's head (the owner, 2026-09-28): that column fills the cockpit
// window, the same button (or Esc) puts it back. `part` is the room's name for it: 'ex' is the
// side list (the shell's), 'card' the summary, 'nb' the notebook.

const IN = 'M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9'
const OUT = 'M13 7H9V3M9 7l4.5-4.5M3 9h4v4M7 9l-4.5 4.5'

export function FocusBtn({ part, what }: { part: string; what: string }) {
  const on = useFocusOf('research') === part
  const tip = on ? `back to the columns (Esc)` : `focus ${what}: it fills the window (Esc to return)`
  return <button className={`iconbtn research-focus ${on ? 'on' : ''}`} onClick={() => toggleFocus('research', part)} title={tip} aria-label={tip} aria-pressed={on}>
    <svg className="ico" viewBox="0 0 16 16"><path d={on ? OUT : IN} /></svg>
  </button>
}
