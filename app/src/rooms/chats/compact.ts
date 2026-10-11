import type { Entry } from '../../../server/chat/types.ts'

/** a compaction divider's tooltip: the books put back, then any listed or missing (meta from the runner) */
export function compactTip(e: Entry): string | undefined {
  const m = e.meta
  if (!m?.compact) return undefined
  const out: string[] = []
  if (m.pre) out.push(`was ${Math.round(m.pre / 1000)}k tokens`)
  if (m.books?.length) out.push(...m.books)
  if (m.listed?.length) out.push('', 'listed, re-read if needed:', ...m.listed)
  if (m.missing?.length) out.push('', 'missing on disk:', ...m.missing)
  return out.length ? out.join('\n') : undefined
}
