import { api } from '../lib/api.ts'

// Reload (the activity bar and the command bar): fundd rebuilds a stale dist/ first (POST
// /api/reload, server/uibuild.ts), then the page reloads onto it. Dev builds nothing.

export const RELOAD_TIP = 'Reload the UI (agents keep running). In production a stale build is rebuilt first, from the working tree as it sits: other conversations\' uncommitted UI edits are built in too.'

type Answer = { mode: 'dist' | 'dev'; stale: string | null; built: boolean; ms: number | null }

let busy = false

/** ask fundd to rebuild when out of date, then reload; a failed build stays on this page and says why */
export async function reloadUi(toast: (text: string, fail?: boolean) => void): Promise<void> {
  if (busy) return
  busy = true
  const slow = setTimeout(() => toast('building the UI before the reload'), 600)
  try {
    const a = await api<Answer>('/api/reload', { body: {} })
    clearTimeout(slow)
    if (a.built) toast(`UI rebuilt (${a.stale}) in ${Math.round((a.ms ?? 0) / 1000)}s`)
    location.reload()
  } catch (e: any) {
    clearTimeout(slow)
    busy = false
    toast(`reload: ${e.message}`, true)
  }
}
