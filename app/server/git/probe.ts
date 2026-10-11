/**
 * The `git` probe (app/tools/probes/git.py -> ops.health_readings system:git) is a SNAPSHOT: it reads every repo
 * when the scheduler runs it. The Git room reads the repos live. When the two disagree the probe
 * is out of date, never the other way round, so the Git room re-runs it (throttled) instead of
 * letting System > Health show a green, contradicting reading.
 *
 * Only a disagreement that changes what the owner must act on counts (B-0056): the probe's one
 * unconditional red is BEHIND > 0, so the re-run fires when the probe says in sync and the cards
 * show behind, or the reverse. Dirty and ahead churn (several hands editing) never re-runs it: that
 * re-ran the probe every 3 min all day and flooded the scheduler's run log.
 */
export type ProbeRepo = { dirty?: number; ahead?: number; behind?: number; upstream?: string }
export type LiveRepo = { id: string; dirty?: number; ahead?: number | null; behind: number | null }

/** the floor between two re-runs of the probe from the Git room */
export const REPROBE_MS = 180_000

/** the per-repo part of the git probe's reading (its `repos`), or null when the reading has none. Pure */
export function gitProbeRepos(reading: Record<string, any> | null): Record<string, ProbeRepo> | null {
  const r = reading?.repos
  return r && typeof r === 'object' && !Array.isArray(r) ? r : null
}

/** the repo ids where the probe and the live cards disagree on BEHIND > 0 (the one red rule); an
 *  unknown live behind (no upstream) or a repo the probe never read is nothing to compare. Pure */
export function probeDisagrees(probe: Record<string, ProbeRepo> | null, live: LiveRepo[]): string[] {
  if (!probe) return []
  return live.filter(l => {
    const p = probe[l.id]
    if (!p || l.behind === null) return false
    return ((p.behind ?? 0) > 0) !== (l.behind > 0)
  }).map(l => l.id)
}

/** the re-probe decision: the repos to re-run it for, or [] (inside the floor, or nothing to act on). Pure */
export function reprobeFor(probe: Record<string, ProbeRepo> | null, live: LiveRepo[], now: number, lastReprobe: number): string[] {
  if (now - lastReprobe < REPROBE_MS) return []
  return probeDisagrees(probe, live)
}
