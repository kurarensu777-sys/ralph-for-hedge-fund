import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, Repo } from '../../shared/types.ts'
import { logEvent, ops, settled } from '../db.ts'
import { publish } from '../events.ts'
import { FUND_ROOT } from '../paths.ts'
import { config } from '../config.ts'
import { agentCwd, transcriptDir, transcriptFile } from '../chat/launch.ts'
import { WORKTREES_DIR, buildRepoOf, buildRepos, neverLands, worktreeCwd, worktreePath } from './wtpath.ts'
import { branchName, createWorktree, listWorktrees, removeWorktree, slugOf, type Worktree } from './worktree.ts'
import { LandQueue, landBranch, type LandItem } from './land.ts'

// BUILD BRANCHES: the Git room's half of a build conversation. Starting one mints the
// conversation, cuts its worktree and branch, and points the conversation at the worktree
// (the launch contract then boots it there: chat/launch.ts launchCwd). Landing one runs
// land.ts and, on red, sends the failure back to that conversation.

const repoDir = (r: Repo) => join(FUND_ROOT, r.path)
const repoOf = (id: string): Repo => {
  const r = config.repos().find(x => x.id === id)
  if (!r) throw new Error(`no repo ${id} in repos.json`)
  return r
}

const convRow = async (id: string) => { await settled(); return ops.getConversation(id, { includeForgotten: true }) }

/**
 * Point a conversation at a new cwd. Claude Code files a transcript under the slug of the cwd it
 * ran in, so an existing transcript is COPIED to the new slug first (the original stays), then
 * the row moves; a resume after the move finds its history.
 */
export async function rebindConversation(id: string, to: string) {
  const r = await convRow(id)
  if (!r) return
  if (r.cwd && r.transcript_uuid && r.cwd.toLowerCase() !== to.toLowerCase()) {
    const from = transcriptFile(r.cwd, r.transcript_uuid), dest = transcriptFile(to, r.transcript_uuid)
    try { if (existsSync(from) && !existsSync(dest)) { mkdirSync(transcriptDir(to), { recursive: true }); copyFileSync(from, dest) } } catch { /* it resumes fresh rather than not at all */ }
  }
  await ops.updateConversation(id, { cwd: to })
}

/** the agents that may start a build branch: their cwd sits in a build repo (repos.json `build`) and they are armed */
export function buildAgents(): { id: string; name: string; repo: string }[] {
  return config.agents().flatMap(a => {
    if (a.mode === 'dormant') return []
    let cwd: string
    try { cwd = agentCwd(a) } catch { return [] }
    const at = buildRepoOf(cwd)
    return at && config.repos().some(r => r.id === at.repo) ? [{ id: a.id, name: a.name, repo: at.repo }] : []
  })
}

/** start a build conversation on its own branch; the prompt (if any) is its first turn */
export async function startBuild(agentId: string, title: string, prompt?: string): Promise<{ id: string; repo: string; branch: string; worktree: string; linked: string[] }> {
  const a = config.agents().find(x => x.id === agentId)
  if (!a) throw new Error(`no agent ${agentId}`)
  if (a.mode === 'dormant') throw new Error(`${a.name} is dormant`)
  const home = agentCwd(a)
  const at = buildRepoOf(home)
  if (!at) throw new Error(`${a.name} does not work in a build repo (${buildRepos().map(r => r.id).join(', ') || 'none in repos.json'}): build branches are for those repos only`)
  const repo = repoOf(at.repo)
  const store = await import('../chat/store.ts')
  const c = await store.create(a as Agent, title.trim())
  const path = worktreePath(repo.id, c.id)
  const branch = branchName(a.id, title, c.id)
  let made
  try { made = await createWorktree(repoDir(repo), path, branch) }
  catch (e) { await store.forget(c.id); publish('chat', { id: c.id }); throw e }
  await rebindConversation(c.id, worktreeCwd(home, c.id) ?? path)
  logEvent('commit', `branch ${branch} cut for ${a.id} (${repo.id})`, { payload: { conversation: c.id, worktree: path } })
  publish('chat', { id: c.id, state: 'closed' })
  publish('git', { worktree: c.id })
  if (prompt?.trim()) {
    const runner = await import('../chat/runner.ts')
    await runner.send(c.id, prompt)
  }
  return { id: c.id, repo: repo.id, branch, worktree: path, linked: made.linked }
}

export type BranchRow = Worktree & { repo: string; agent: string | null; title: string | null; live: string | null; land: LandItem | null }

/** every build branch of every build repo, with its conversation and its latest land */
export async function branches(q: LandQueue): Promise<BranchRow[]> {
  const ids = new Set(buildRepos().map(r => r.id))
  const repos = config.repos().filter(r => ids.has(r.id))
  const lists = await Promise.all(repos.map(async r => {
    try { return (await listWorktrees(repoDir(r), join(WORKTREES_DIR, r.id))).map(w => ({ ...w, repo: r.id })) }
    catch { return [] as (Worktree & { repo: string })[] }
  }))
  let live: ((id: string) => string) | null = null
  try { live = (await import('../chat/runner.ts')).liveState } catch { /* tests: no runner */ }
  const flat = lists.flat()
  const convs = new Map((await ops.select('conversations', { where: { id: [...new Set(flat.map(w => w.conversation))] } })).map(r => [r.id, r]))
  return flat.map(w => {
    const c = convs.get(w.conversation)
    const land = [...q.items].reverse().find(x => x.repo === w.repo && x.branch === w.branch) ?? null
    return { ...w, agent: c?.agent_id ?? agentOfBranch(w.branch, config.agents()), title: c?.title || null, live: c && live ? live(c.id) : null, land }
  })
}

/** the agent a build branch was cut for, read off its name (b/<agent slug>/...) when the conversation
 *  row is gone; null when no roster agent's slug matches (never a guess) */
export function agentOfBranch(branch: string | null, agents: Pick<Agent, 'id'>[]): string | null {
  const m = /^b\/([^/]+)\//.exec(branch ?? '')
  if (!m) return null
  return agents.find(a => (slugOf(a.id, 24) || 'agent') === m[1])?.id ?? null
}

/** the land queue as the Git room reads it: newest first, each item marked `gone` when its branch has
 *  no worktree any more (a red or blocked land whose branch was dropped cannot be landed again) */
export function queueView(items: LandItem[], rows: Pick<BranchRow, 'repo' | 'branch'>[], limit: number): (LandItem & { gone: boolean })[] {
  const live = new Set(rows.map(r => `${r.repo}|${r.branch}`))
  return items.slice(-Math.max(1, limit)).reverse().map(it => ({ ...it, gone: !live.has(`${it.repo}|${it.branch}`) }))
}

/** the text a red land sends back to its conversation */
export function redMessage(it: LandItem): string {
  const bad = it.steps.filter(s => !s.ok)
  return [
    `LAND QUEUE: branch ${it.branch} did not land (${it.state}).`,
    it.note,
    ...bad.map(s => `${s.name}: ${s.detail}`),
    `Fix it here in this worktree, commit on ${it.branch}, and ask the owner to land it again (Git room, Branches).`,
  ].filter(Boolean).join('\n\n')
}

async function tell(it: LandItem): Promise<LandItem['told']> {
  if (!it.conversation || !(await convRow(it.conversation))) return 'no conversation'
  try { await (await import('../chat/runner.ts')).send(it.conversation, redMessage(it)); return 'sent' }
  catch (e) { logEvent('system', `land: could not tell ${it.conversation}: ${(e as Error).message}`); return 'failed' }
}

/** the queue's worker: one land, then cleanup on green, the failure back to the agent on red */
export async function landWork(it: LandItem) {
  if (neverLands().includes(it.repo)) { it.state = 'blocked'; it.note = `${it.repo} never lands from the cockpit: the owner merges its pull requests`; return }
  const repo = repoOf(it.repo)
  const home = repoDir(repo)
  const r = await landBranch({ mainDir: home, wtDir: it.worktree, branch: it.branch, verify: repo.verify ?? null, verifyHome: home })
  it.steps = r.steps; it.note = r.note; it.sha = r.sha; it.commits = r.commits; it.state = r.state
  if (r.state === 'landed') {
    // the conversation goes home first (its transcript copied), then the worktree and branch go
    const conv = it.conversation ? await convRow(it.conversation) : null
    if (it.conversation && conv) {
      const a = config.agents().find(x => x.id === (it.agent ?? conv.agent_id))
      if (a) { try { await rebindConversation(it.conversation, agentCwd(a)) } catch { /* */ } }
    }
    const t = Date.now()
    const rm = await removeWorktree(home, it.worktree, it.branch, 'merged')
    it.steps.push({ name: 'cleanup', ok: rm.removed && rm.branch === 'deleted', detail: rm.note || 'worktree and branch removed', ms: Date.now() - t })
    logEvent('commit', `landed ${it.branch} on ${repo.id} main (${it.commits} commit${it.commits === 1 ? '' : 's'}, ${it.sha?.slice(0, 7)})`, { payload: { item: it.id, conversation: it.conversation } })
    publish('services')
  } else {
    if (r.state === 'red') it.told = await tell(it)
    logEvent('commit', `land ${r.state}: ${it.branch} on ${repo.id}: ${r.note}`, { payload: { item: it.id, steps: r.steps } })
  }
}

/** owner's discard of an unlanded branch: refused when the worktree holds uncommitted work */
export async function dropBranch(repoId: string, conversation: string) {
  if (!buildRepos().some(r => r.id === repoId)) throw new Error(`${repoId} has no build branches`)
  const repo = repoOf(repoId)
  const path = worktreePath(repoId, conversation)
  const w = (await listWorktrees(repoDir(repo), join(WORKTREES_DIR, repoId))).find(x => x.conversation === conversation)
  if (!w) throw new Error('no such build branch')
  if ((w.dirty ?? 1) > 0) throw new Error('the worktree holds uncommitted work: commit or remove it first')
  const c = await convRow(conversation)
  if (c) { const a = config.agents().find(x => x.id === c.agent_id); if (a) try { await rebindConversation(conversation, agentCwd(a)) } catch { /* */ } }
  const rm = await removeWorktree(repoDir(repo), path, w.branch, 'force-unmerged')
  logEvent('commit', `branch ${w.branch} dropped unlanded (${repoId})`, { payload: { conversation, ahead: w.ahead, ...rm } })
  if (!rm.removed) throw new Error(rm.note || 'the worktree was not removed')
  return rm
}

export const LAND_FILE = join(WORKTREES_DIR, 'land.json')
