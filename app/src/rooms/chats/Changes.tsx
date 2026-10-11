import { useCallback, useEffect, useRef, useState } from 'react'
import { api, relTime, stamp, useTopic } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Empty, FailLine, Pill } from '../../ui/kit.tsx'
import type { Changes, ConvCommit, RevertResult, WorkFile } from '../../../server/chat/changes.ts'
import { counts, patchRows } from './diff.ts'

// THE CHANGES PANEL of one conversation: the commits whose `Conversation:` trailer names it (every
// repo in repos.json, read from git by the server) + the uncommitted tree of the agent's repo.
// A file opens its diff in the shell drawer. Revert = one `git revert` per commit, newest first,
// behind an in-page confirm. Server: GET /api/chats/:id/changes, /diff, POST /revert.

type Resp = Changes & { plan: { repo: string; shas: string[]; skipped: number }[] }

export function ChangesPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { openDrawer, toast } = useNav()
  const [d, setD] = useState<Resp | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openSha, setOpenSha] = useState<string | null>(null)
  const [arm, setArm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RevertResult[] | null>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    const n = ++seq.current
    api<Resp>(`/api/chats/${id}/changes`).then(x => { if (n === seq.current) { setD(x); setErr(null) } })
      .catch(e => { if (n === seq.current) setErr(String(e.message ?? e)) })
  }, [id])
  useEffect(() => { setD(null); setErr(null); setArm(false); setResult(null); load() }, [load])
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soon = () => { if (t.current) clearTimeout(t.current); t.current = setTimeout(load, 400) }
  useTopic('git', () => soon())
  useTopic('chat', (x: any, topic) => { if (topic === 'chat' && x?.id === id && (x.turn === 'done' || x.reverted !== undefined)) soon() })

  const diff = (repo: string, path: string, sha?: string) =>
    openDrawer({ title: <span className="mono">{path}</span>, actions: <span className="faint mono chats-dw-a">{repo}{sha ? ` ${sha.slice(0, 7)}` : ' working'}</span>, body: <DiffView id={id} repo={repo} path={path} sha={sha} /> })

  const live = d?.plan.flatMap(p => p.shas) ?? []
  const liveRepos = d?.plan.filter(p => p.shas.length).map(p => p.repo) ?? []
  const revert = async () => {
    setBusy(true)
    try {
      const r = await api<{ results: RevertResult[] }>(`/api/chats/${id}/revert`, { body: { confirm: true, shas: live } })
      const n = r.results.reduce((s, x) => s + x.reverted.length, 0)
      const bad = r.results.filter(x => x.error)
      setResult(r.results)
      toast(bad.length ? `reverted ${n}, stopped in ${bad.map(b => b.repo).join(', ')}` : `reverted ${n}`, bad.length > 0)
    } catch (e: any) { toast(`revert: ${e.message}`, true) }
    setBusy(false); setArm(false); load()
  }

  // nothing committed, nothing failed, a clean tree: one line, not a 340px column of headers
  const nothing = d && !d.commits.length && !d.errors.length && !d.working.error && !d.working.files.length
  if (nothing) return (
    <aside className="chats-chg chats-chg-strip" title={`no commit names this conversation\n${d.working.repo ?? '?'}: clean, nothing uncommitted`}>
      <span className="mono">0</span><span className="faint">·</span><span className="dot ok" /><span className="mono faint">clean</span>
      <button className="iconbtn" title="Reload" onClick={load}>&#8635;</button>
      <button className="iconbtn" title="Close" onClick={onClose}>x</button>
    </aside>
  )
  return (
    <aside className="chats-chg">
      <div className="chats-chg-h">
        <span className="chats-sp" />
        <button className="iconbtn" title="Reload" onClick={load}>&#8635;</button>
        <button className="iconbtn" title="Close" onClick={onClose}>x</button>
      </div>
      <div className="chats-chg-b">
        {err && !d ? <Empty state="failed" sm>{err}</Empty> : !d ? <Empty state="loading" skel="lines" /> : <>
          <div className="grp"><span>Commits</span><Pill>{d.commits.length}</Pill></div>
          {d.errors.map(e => <div key={e.repo} className="chats-chg-err"><FailLine what={e.repo} detail={e.error} /></div>)}
          {d.commits.map(c => <CommitRow key={c.repo + c.sha} c={c} open={openSha === c.sha} onToggle={() => setOpenSha(openSha === c.sha ? null : c.sha)} onFile={p => diff(c.repo, p, c.sha)} />)}
          {live.length > 0 && (arm
            ? <div className="chats-chg-arm">
                <span title="One new revert commit per commit, newest first. Nothing is reset; a conflict stops that repo.">Revert {live.length} commit{live.length === 1 ? '' : 's'} in {liveRepos.join(', ')}?</span>
                <span className="chats-chg-armb">
                  <button className="btn danger sm" disabled={busy} onClick={revert}>{busy ? 'Reverting' : 'Revert'}</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => setArm(false)}>Cancel</button>
                </span>
              </div>
            : <button className="chats-tb chats-chg-rv" title="git revert every live commit of this conversation (new commits, never a reset)" onClick={() => { setResult(null); setArm(true) }}>revert conversation</button>)}
          {result?.filter(r => r.error).map(r => <div key={r.repo} className="chats-chg-err"><FailLine what={r.repo} detail={r.error!} /></div>)}

          <div className="grp"><span>Working</span><span className="chats-chg-repo">{!d.working.error && !d.working.files.length && <span className="dot ok" title="clean: nothing uncommitted" />}{d.working.repo ?? '?'}</span></div>
          {d.working.error ? <div className="chats-chg-err" title={d.working.cwd}><span className="dot warn" />{d.working.error}</div>
            : d.working.files.map(f => <FileRow key={f.path} f={f} onClick={() => diff(d.working.repo!, f.path)} />)}
        </>}
      </div>
    </aside>
  )
}

function CommitRow({ c, open, onToggle, onFile }: { c: ConvCommit; open: boolean; onToggle: () => void; onFile: (path: string) => void }) {
  return (
    <div className={`chats-cm ${c.reverted ? 'rev' : ''}`}>
      <button className="chats-cm-h" onClick={onToggle} title={`${c.repo} ${c.sha}\n${c.author} ${stamp(c.ts)}${c.reverted ? '\nreverted' : ''}${c.merge ? '\nmerge (not reverted)' : ''}`}>
        <span className="chats-cm-repo">{c.repo}</span>
        <span className="chats-cm-sha">{c.sha.slice(0, 7)}</span>
        <span className="chats-cm-s">{c.subject}</span>
        <span className="chats-cm-t">{c.reverted ? 'reverted' : c.merge ? 'merge' : relTime(c.ts)}</span>
      </button>
      {open && <div className="chats-cm-f">
        {c.files.length ? c.files.map(p => <button key={p} className="chats-f" onClick={() => onFile(p)} title={p}><span className="chats-f-p">{p}</span></button>)
          : <Empty inline title="NO FILES" />}
      </div>}
    </div>
  )
}

const xyLetter = (xy: string) => (xy === '??' ? 'N' : (xy.replace(/\s/g, '')[0] ?? '?'))

function FileRow({ f, onClick }: { f: WorkFile; onClick: () => void }) {
  return (
    <button className="chats-f" onClick={onClick} title={`${f.path} (${f.xy === '??' ? 'untracked' : f.xy.trim()})`}>
      <span className="chats-f-x">{xyLetter(f.xy)}</span>
      <span className="chats-f-p">{f.path}</span>
      <span className="chats-stat">{f.add === null ? <b className="faint">bin</b> : f.xy === '??' && !f.add ? <b className="faint">empty</b> : <><b className="add">+{f.add}</b> <b className="del">-{f.del ?? 0}</b></>}</span>
    </button>
  )
}

export function DiffView({ id, repo, path, sha }: { id: string; repo: string; path: string; sha?: string }) {
  const [d, setD] = useState<{ patch: string; truncated: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const q = new URLSearchParams({ repo, path, ...(sha ? { sha } : {}) })
    api<{ patch: string; truncated: boolean }>(`/api/chats/${id}/diff?${q}`).then(setD).catch(e => setErr(String(e.message ?? e)))
  }, [id, repo, path, sha])
  if (err) return <Empty state="failed">{err}</Empty>
  if (!d) return <Empty state="loading" />
  const rows = patchRows(d.patch)
  if (!rows.length) return <Empty title="NO DIFF" />
  const n = counts(rows)
  return (
    <div className="chats-dw">
      <div className="chats-stat chats-dw-n"><b className="add">+{n.add}</b> <b className="del">-{n.del}</b>{d.truncated && <span className="faint"> truncated</span>}</div>
      <div className="chats-diff chats-dw-d">
        {rows.map((l, i) => l.t === 'gap' ? <div key={i} className="gap" title={l.s} /> : l.t === 'meta' ? <div key={i} className="meta">{l.s}</div> : <div key={i} className={l.t}>{l.s || ' '}</div>)}
      </div>
    </div>
  )
}
