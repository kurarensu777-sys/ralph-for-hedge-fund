import { useMemo } from 'react'
import { useApi } from '../../lib/api.ts'
import type { Entry } from '../../../server/chat/types.ts'

// A TURN'S GRADE in the transcript: one 6px dot on the turn's last assistant message.
// green = the owner said good, red = bad, amber = a check failed and nobody graded it yet,
// no dot = ungraded and clean. The grades live in the Loop room (/api/loop/grades).

type TurnGrade = { turn: number; ts: number; owner: number | null; label: string | null; failed: string[]; checked: boolean }

/** entry id -> the grade of the turn that entry closes */
export function useTurnDots(conv: string | undefined, entries: Entry[]): Map<string, TurnGrade> {
  const q = useApi<{ turns: TurnGrade[] }>(conv ? `/api/loop/grades?conv=${encodeURIComponent(conv)}` : null, ['loop'])
  return useMemo(() => {
    const out = new Map<string, TurnGrade>()
    const says = entries.filter(e => e.kind === 'assistant' && !e.nested && !e.streaming)
    let from = 0
    for (const t of [...(q.data?.turns ?? [])].sort((a, b) => a.ts - b.ts)) {
      const mine = says.filter(e => e.ts > from && e.ts <= t.ts)
      if (mine.length) out.set(mine[mine.length - 1].id, t)
      from = t.ts
    }
    return out
  }, [q.data, entries])
}

export function TurnDot({ g }: { g?: TurnGrade }) {
  if (!g) return null
  const tone = g.owner === 1 ? 'ok' : g.owner === 0 ? 'fail' : g.failed.length ? 'warn' : null
  if (!tone) return null
  const title = g.owner === 1 ? `good${g.label ? `: ${g.label}` : ''}` : g.owner === 0 ? `bad${g.label ? `: ${g.label}` : ''}` : `check failed: ${g.failed.join(', ')}`
  return <span className={`chats-tdot ${tone}`} title={`turn ${g.turn + 1} · ${title}`} />
}
