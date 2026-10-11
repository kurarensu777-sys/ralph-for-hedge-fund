import { splitRef } from '../../shared/bookmeta.ts'
import { ownerOfPath } from '../board/debt.ts'
import { git } from '../git/run.ts'
import { ownerRail } from './config.ts'
import { repoOf } from './gitops.ts'
import type { Proposal, Review } from './proposals.ts'

/**
 * THE REVIEWER. What the loop may not write by itself (the roster, a sub-repo's code, an advisory
 * finding) is not parked for the owner: in auto mode a pass SENDS it to the agent whose `writes`
 * cover its targets. That agent reads the proposal against the tree as it stands, lands the change
 * inside its own writes (the commit guard holds it there) or declines it, and reports back through
 * POST /api/loop/proposals/:id/review. The loop records the verdict and, for a landed change, opens
 * the same watch as for its own. The owner-only rails (config.ts ownerRail) are never sent: those
 * stay with the owner.
 *
 * One conversation per send, booted through the launch contract (chats' start), so every review is
 * a conversation the owner can open, read and stop.
 */

/** start a conversation with `agentId` on `prompt`; returns its id (the chats runner in fundd) */
export type StartAgent = (agentId: string, prompt: string, title: string) => Promise<string>

/** sends per pass: a cap, so one noisy pass never boots a crowd */
export const MAX_SENDS = 3
/** a send nobody reported on is re-sent after this long, once */
export const STALE_MS = 6 * 3_600_000
export const MAX_TRIES = 2

type AgentLike = { id: string; cwd: string; writes: string[]; mode?: string }

/** who checks this proposal, or why nobody can (then it waits for the owner) */
export function reviewerOf(p: Pick<Proposal, 'target'>, agents: AgentLike[]): { agent: string | null; why: string | null } {
  if (!p.target.length) return { agent: null, why: 'no targets' }
  for (const t of p.target) { const r = ownerRail(splitRef(t).path); if (r) return { agent: null, why: `${t}: ${r}` } }
  const owners = [...new Set(p.target.map(t => ownerOfPath(splitRef(t).path, agents)))]
  if (owners.length !== 1 || !owners[0]) return { agent: null, why: owners.includes(null) ? 'a target has no owner on the roster' : `targets span ${owners.join(', ')}: no one agent may land it` }
  const a = agents.find(x => x.id === owners[0])
  if (!a) return { agent: null, why: `${owners[0]} is not on the roster` }
  if (a.mode === 'dormant') return { agent: null, why: `${a.id} is dormant` }
  return { agent: a.id, why: null }
}

/** is a send out and unanswered? (stale ones count as out until re-sent) */
export const pending = (p: Pick<Proposal, 'review'>) => !!p.review && p.review.verdict === null

/** a pending send is stale (unanswered past STALE_MS) and may go out again */
export function stale(p: Pick<Proposal, 'review'>, now: number): boolean {
  const r = p.review
  if (!r || r.verdict !== null) return false
  const at = Date.parse(r.at)
  return Number.isFinite(at) && now - at >= STALE_MS && r.tries < MAX_TRIES
}

export function promptFor(p: Proposal, agent: string, ask: Review['ask'], port: number): string {
  const url = `http://127.0.0.1:${port}/api/loop/proposals/${p.id}/review`
  const report = (body: string) => `curl -s -X POST ${url} -H "Content-Type: application/json" -d '${body}'`
  const lines = [
    `The loop (the fund's self-improvement pass) sends you ${p.id}: its targets sit inside your writes, so you are the one who checks it and lands it.`,
    '',
    `Proposal: app/loop/records/proposals/${p.id}.md (read it whole: Why, Change, Gates)`,
    `Kind: ${p.kind} · ${p.title}`,
    `Targets: ${p.target.join(', ')}`,
    `Why: ${p.why}`,
    '',
  ]
  if (ask === 'apply') lines.push(
    'Decide on the files as they stand now whether the change is needed and right. The loop proposes by rule; you know the work.',
    `- Needed: make it (the targets only, inside your writes), commit with explicit paths and a \`Loop-Change: ${p.id}\` trailer, follow your sync law, then report:`,
    `  ${report(`{"agent":"${agent}","verdict":"applied","commit":"<the full sha>","note":"<one line>"}`)}`,
    `- Not needed, or wrong: change nothing and report:`,
    `  ${report(`{"agent":"${agent}","verdict":"declined","note":"<why, one line>"}`)}`,
  )
  else lines.push(
    `The change landed as ${p.commit ?? '(no commit recorded)'} and is to come back out (${p.review?.note || 'the watch read it worse, or the owner asked'}).`,
    `- Revert it with a NEW commit (never reset, never force) carrying a \`Loop-Change: ${p.id}\` trailer, follow your sync law, then report:`,
    `  ${report(`{"agent":"${agent}","verdict":"reverted","commit":"<the full sha>","note":"<one line>"}`)}`,
    `- If it cannot come out cleanly (edited since), change nothing and report verdict "declined" with why.`,
  )
  lines.push('', 'Report exactly once; the loop reads nothing else. Then stand down.')
  return lines.join('\n')
}

/** resolve what an agent reported to a full sha in the repo that holds the targets, and prove the
 *  commit touched at least one of them: a report the tree does not bear out is refused */
export async function provenCommit(fundRoot: string, p: Pick<Proposal, 'target'>, sha: unknown): Promise<string> {
  const s = String(sha ?? '').trim()
  if (!/^[0-9a-f]{7,40}$/i.test(s)) throw new Error('commit must be a hex sha')
  const { repo, prefix } = repoOf(fundRoot, splitRef(p.target[0] ?? '').path)
  const r = await git(repo, ['rev-parse', '--verify', '--end-of-options', `${s}^{commit}`])
  if (r.code !== 0) throw new Error(`no commit ${s} in ${prefix || 'the fund repo'}`)
  const full = r.stdout.trim()
  const files = await git(repo, ['show', '--no-renames', '--name-only', '--format=', '--end-of-options', full])
  const touched = new Set(files.stdout.split('\n').map(x => x.trim()).filter(Boolean))
  const mine = p.target.map(t => splitRef(t).path.replace(/\\/g, '/').slice(prefix.length))
  if (!mine.some(t => touched.has(t))) throw new Error(`${full.slice(0, 10)} touches none of the targets (${mine.join(', ')})`)
  return full
}
