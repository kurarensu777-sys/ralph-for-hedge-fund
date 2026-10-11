import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  AGENTS_DIR, AGENTS_REL, APP_LIBRARY_REL, BOARD_REL, DASHBOARD_HOMES, FUND_ROOT, LAB_HOMES, LEGACY_CWD, LEGACY_DESK,
  LEGACY_LIBRARY_REL, LEGACY_LIBRARY_RETIRED, LOOP_RECORDS_REL, LOOP_TOOLS_REL, PYTHON, RETIRED_AGENTS,
  TOOLS_REL, canonicalDesk, deskRel, fundRel, LOOP_CONFIG_FILE, SCHEDULE_FILE,
} from '../server/paths.ts'
import { readRoster } from '../server/roster.ts'
import { shelfRoots } from '../server/shelves.ts'
import { serializeAgentFile } from '../shared/agentfile.ts'

// ONE layout, two languages: app/tools/_root.py (the loop, probes, budget and check tools) and
// server/paths.ts + shelves.ts + roster.ts (the cockpit) must carry the same legacy desk, cwd and
// agent tables, resolve a desk to the same folder, derive the same shelves from the same library
// folders and read the same roster out of the same app/agents/<id>.md files.
const ROOT_PY = join(FUND_ROOT, 'app', 'tools', '_root.py')
const py = existsSync(PYTHON) ? PYTHON : 'python'
const run = (args: string[], root = FUND_ROOT) => spawnSync(py, [ROOT_PY, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, FUND_ROOT: root } })

const TMP = mkdtempSync(join(tmpdir(), 'layout-parity-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
const touch = (root: string, rel: string, text = 'x\n') => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text) }

describe.skipIf(!existsSync(ROOT_PY))('layout parity: app/tools/_root.py <-> server/paths.ts', () => {
  const r = run(['--json'])
  it('python prints its layout', () => { expect(r.status, r.stderr).toBe(0) })
  const j = r.status === 0 ? JSON.parse(r.stdout) : null
  it('the legacy desk, cwd and retired-agent tables are identical, in order', () => {
    expect(j?.legacy_desk).toEqual(LEGACY_DESK)
    expect(j?.legacy_cwd).toEqual(LEGACY_CWD)
    expect(j?.retired_agents).toEqual(RETIRED_AGENTS)
  })
  it('the fixed paths agree', () => {
    expect(j?.lab).toBe('lab')
    expect(j?.agents_dir).toBe(AGENTS_REL)
    expect(j?.board).toBe(BOARD_REL)
    expect(j?.schedule).toBe(fundRel(SCHEDULE_FILE))
    expect(j?.loop_config).toBe(fundRel(LOOP_CONFIG_FILE))
    expect(j?.loop_records).toBe(LOOP_RECORDS_REL)
    expect(j?.loop_tools).toBe(LOOP_TOOLS_REL)
    expect(j?.tools).toBe(TOOLS_REL)
  })
  it('the moved homes and the shelf homes agree', () => {
    expect(j?.lab_homes).toEqual([...LAB_HOMES])
    expect(j?.dashboard_homes).toEqual([...DASHBOARD_HOMES])
    expect(j?.app_library).toBe(APP_LIBRARY_REL)
    expect(j).not.toHaveProperty('platform_library')   // retired 2026-09-26 (B-0202): a home in neither language
    expect(j?.legacy_library).toBe(LEGACY_LIBRARY_REL)
    expect(j?.legacy_library_retired).toEqual([...LEGACY_LIBRARY_RETIRED])
  })
  it('the DERIVED shelves are the same set, in the same order, on the live tree', () => {
    const s = run(['--shelves'])
    expect(s.status, s.stderr).toBe(0)
    expect(s.stdout.split(/\r?\n/).filter(Boolean)).toEqual(shelfRoots(FUND_ROOT))
  })
  it('and on a scratch tree with every home: the one library, a legacy shelf, a retired one, a hidden one, a stray retired platform/library', () => {
    const root = join(TMP, 'shelves')
    // a stray platform/dashboards/<id>/library is NOT a shelf since 2026-09-26 (the one library is app/library), and
    // nor is a platform/library/<x> left on a machine: that home was retired 2026-09-26 (B-0202)
    for (const rel of ['app/library/law/_series.md', 'app/library/craft/x.md', 'app/library/_drafts/x.md', 'app/library/shelf.md',
      'app/library/markets/tradfi/x.md', 'app/library/dashboards/vol/_series.md',
      'platform/library/markets/x.md', 'platform/dashboards/vol/library/_series.md', 'platform/dashboards/vol/dashboard.json',
      'platform/dashboards/preds/dashboard.json', 'library/fund/x.md', 'library/markets/x.md', 'library/old/x.md', 'library/.git/x']) touch(root, rel)
    const s = run(['--shelves'], root)
    expect(s.status, s.stderr).toBe(0)
    const ts = shelfRoots(root)
    expect(s.stdout.split(/\r?\n/).filter(Boolean)).toEqual(ts)
    // written by hand, not read back from either implementation
    expect(ts).toEqual(['app/library/craft', 'app/library/dashboards', 'app/library/law', 'app/library/markets', 'library/old'])
  })
  it('a desk id resolves to the same folder, with and without platform/lab', () => {
    const old = join(TMP, 'desk-old'), now = join(TMP, 'desk-new')
    touch(old, 'lab/venues/acme/cadence.md')
    touch(now, 'platform/lab/venues/acme/cadence.md')
    for (const [root, want] of [[old, 'lab/venues/acme'], [now, 'platform/lab/venues/acme']] as const) {
      for (const id of ['lab/venues/acme', 'lab/api/data/venues/acme', 'desks/api/data/venues/acme', 'platform/lab/venues/acme']) {
        const p = run(['--desk', id], root)
        expect(p.status, p.stderr).toBe(0)
        expect(p.stdout.trim(), id).toBe(want)
        expect(deskRel(id, root), id).toBe(want)
      }
    }
  })
  it('an old id reads the same in both', () => {
    const out = spawnSync(py, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import _common as C; print(C.canonical_desk("desks/api/data/venues/acme"))', join(FUND_ROOT, 'app', 'loop', 'tools')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, FUND_ROOT } })
    expect(out.status, out.stderr).toBe(0)
    expect(`lab/${out.stdout.trim()}`).toBe(canonicalDesk('desks/api/data/venues/acme'))
  })
  it('the live roster reads the same in both', () => {
    const p = run(['--agents'])
    expect(p.status, p.stderr).toBe(0)
    const ts = readRoster(AGENTS_DIR).headers
    expect(ts.length).toBeGreaterThan(0)
    expect(JSON.parse(p.stdout)).toEqual(ts)
  })
  it('a scratch roster with every scalar and list form reads the same in both; a bad file is left out of both', () => {
    const root = join(TMP, 'roster')
    const dir = join(root, 'app', 'agents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'dash-x.md'), serializeAgentFile({
      id: 'dash:x', name: 'X: the screen', kind: 'dashboard', mode: 'active', dept: 'Dashboards', dashboard: 'x',
      role: 'quotes "inside", a # hash, a: colon', cwd: 'platform/dashboards/x', model: 'sonnet', effort: 'medium', order: 3,
      budgetTokensPerDay: 250000, writes: ['platform/dashboards/x/', 'yes', '007'], boot: [],
    }, '# x\n\nthe brief\n'))
    writeFileSync(join(dir, 'b.md'), "---\nid: b # a comment\nname: 'it''s b'\nkind: standing\nmode: dormant\ndept: HQ\nrole: r\ncwd: .\nmodel: opus\neffort: high\norder: 1\nwrites: [\"a/\", 'b/', c]\nboot:\n  - x.md\n---\nbody\n")
    writeFileSync(join(dir, 'broken.md'), '---\nid: broken\nwrites: [unterminated\n---\n')
    writeFileSync(join(dir, 'wrong-name.md'), '---\nid: other\nname: o\nkind: standing\nmode: active\ndept: d\nrole: r\ncwd: .\nmodel: m\neffort: e\nwrites: []\nboot: []\n---\n')
    const p = run(['--agents'], root)
    expect(p.status, p.stderr).toBe(0)
    const ts = readRoster(dir).headers
    expect(JSON.parse(p.stdout)).toEqual(ts)
    expect(ts.map(h => h.id)).toEqual(['b', 'dash:x'])
    expect(ts[0]).toMatchObject({ name: "it's b", mode: 'dormant', writes: ['a/', 'b/', 'c'], boot: ['x.md'] })
    expect(ts[1]).toMatchObject({ role: 'quotes "inside", a # hash, a: colon', budgetTokensPerDay: 250000, writes: ['platform/dashboards/x/', 'yes', '007'] })
  })
})
