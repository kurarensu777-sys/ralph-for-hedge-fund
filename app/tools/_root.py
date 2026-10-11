#!/usr/bin/env python3
"""The fund's layout, once: where the root is and what the tree's fixed paths are.

app/loop/tools, app/tools/probes and app/tools/budget each used to carry a
hand-copied fund_root(), and the copies had already drifted (budget's fell back to
the cwd, the other two walked up looking for spine/ + lab/, a folder retired
2026-09-25). They now load THIS file by path (see _load_root in each), so there is
one rule.

THE LAYOUT: one repo. The fund root holds the law (CLAUDE.md, repos.json,
.claude/, start.bat). `app/` is the machine that builds
and improves the fund: the cockpit, the roster (app/agents/<id>.md, one file per
agent: a YAML header and the brief), the board (app/board), the loop's tools and
records (app/loop/tools, app/loop/records), these tools (app/tools) and the library
of how we work (app/library/<shelf>). `platform/` holds research (platform/research,
the chart checkers) and the lab (platform/lab/<desk>); a dashboard, when one is added,
lives at platform/dashboards/<id>/. THE ONE LIBRARY is app/library/<shelf>.
`database/` is the one data layer. A home that moved is resolved against what is on
disk (the new home first, the old one while it is the only one there).

A desk id stays LOGICAL: `lab/<name>`, the spelling in every ledger row, database
row and board item since the 2026-09-24 cut-over. desk_dir() resolves it to the
folder (platform/lab/<name> since 2026-09-25).

The legacy desk and cwd tables, the shelf derivation and the roster reader are here
too. The cockpit keeps the same rules in app/server/paths.ts, server/shelves.ts and
shared/agentfile.ts; app/test/layout-parity.test.ts runs this file and fails when
the two languages disagree.

Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# ---- the machine (app/) ----
APP = "app"
AGENTS_DIR = "app/agents"
BOARD = "app/board"
SCHEDULE_FILE = "app/schedule.json"
LOOP_RECORDS = "app/loop/records"
LOOP_TOOLS = "app/loop/tools"
LOOP_CONFIG = "app/loop/config.json"
TOOLS = "app/tools"
APP_LIBRARY = "app/library"
# ---- the root (the law) ----
REPOS_FILE = "repos.json"
# ---- the fund (platform/) ----
PLATFORM = "platform"
DATABASE = "database"
# Homes that moved on 2026-09-25, current first: resolved against the disk.
LAB_HOMES = ("platform/lab", "lab")
RESEARCH_HOMES = ("platform/research", "research")
DASHBOARD_HOMES = ("platform/dashboards",)
# The logical desk prefix: every desk id reads lab/<name>, wherever its folder is.
LAB = "lab"
RESEARCH = RESEARCH_HOMES[0]
# The fund root's library/, retired 2026-09-25 (fund -> app/library/law,
# craft -> app/library/craft, markets -> app/library/markets). Until the root
# lets it go, a folder of it is a shelf only when no current home holds that id and
# it is not a retired name.
LEGACY_LIBRARY = "library"
LEGACY_LIBRARY_RETIRED = ("fund", "craft")

# Where a run's `cwd` pointed before (old -> new). A row written before
# 2026-09-24 carries `crypto` (or `crypto/research/...`); one written
# 2026-09-24..25 carries `repos/platform` or `repos/research`; one written before
# the 2026-09-25 relayout carries `research` or `platform/fundplat/dashboards/...`.
# Each is READ through this map, never rewritten. The first entry that matches wins (a
# longer old path above any shorter one it starts with); the same table as
# app/server/paths.ts LEGACY_CWD.
LEGACY_CWD = (
    ("platform/fundplat/dashboards", "platform/dashboards"),
    ("crypto/research", "platform/research"),
    ("crypto", "platform"),
    ("repos/research", "platform/research"),
    ("repos/platform", "platform"),
    ("repos/app", "app"),
    ("research", "platform/research"),
)

# Desk ids before the 2026-09-24 rename, when lab/ still mirrored the CODE paths
# (lab/api/data/venues/<v>) and, before the cut-over, lived at desks/. Each is
# READ as its new name, never rewritten. Longest prefix first; an entry ending in
# "/" is a folder prefix.
LEGACY_DESK = (
    ("api/data/venues/", "venues/"),
    ("api/data/store", "platform/store"),
    ("api/data", "platform/data"),
    ("api/lib/carry", "platform/carry"),
    ("api/lib/dir", "platform/dir"),
    ("api/lib", "platform/lib"),
    ("api/execution", "execution"),
    ("app/frontend", "dashboards/frontend"),
    ("app/server", "dashboards/server"),
    ("app", "dashboards/app"),
)

# Agents retired by a relayout (old id -> the agent that took its work): the
# terminal views became one dashboard. The same table as
# app/server/paths.ts RETIRED_AGENTS.
RETIRED_AGENTS = (
    ("dash:trade", "dash:terminal"),
    ("dash:sellvol", "dash:terminal"),
    ("dash:datactl", "dash:terminal"),
)


def fund_root() -> Path:
    """$FUND_ROOT wins (the cockpit, the launchers and the tests set it); else the
    folder this file sits under: <root>/app/tools/_root.py."""
    env = os.environ.get("FUND_ROOT")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[2]


def floor_dir() -> Path:
    """The floor: machine-local runtime state (probe readings in health/, the STOP
    switch; probe readings and no-lesson stand-downs are ops-store rows since 2026-09-26). It lives OUTSIDE the repo, next to the cockpit's
    database. $FUND_FLOOR wins; else $FUND_DATA_DIR/floor; else
    <home>/fund-data/floor. app/server/paths.ts (FLOOR_DIR) is the same rule."""
    env = os.environ.get("FUND_FLOOR")
    if env:
        return Path(env).resolve()
    data = os.environ.get("FUND_DATA_DIR")
    if data:
        return Path(data).resolve() / "floor"
    return Path.home() / "fund-data" / "floor"


def snapshots_dir() -> Path:
    """The snapshot store: probe and desk readings, one <desk>.jsonl per lab desk (read and
    written only by app/loop/tools/snapshots.py). Machine-local, OUTSIDE the repo, like the
    floor. $FUND_SNAPSHOTS_DIR wins; else $FUND_DATA_DIR/snapshots; else
    <home>/fund-data/snapshots."""
    env = os.environ.get("FUND_SNAPSHOTS_DIR")
    if env:
        return Path(env).resolve()
    data = os.environ.get("FUND_DATA_DIR")
    if data:
        return Path(data).resolve() / "snapshots"
    return Path.home() / "fund-data" / "snapshots"


def home_of(homes: tuple[str, ...], root: Path | None = None) -> str:
    """The first of `homes` (fund-relative) that exists under the root, else the
    first (the current home). app/server/paths.ts homeOf() is the same rule."""
    r = root or fund_root()
    for h in homes:
        if (r / h).exists():
            return h
    return homes[0]


def lab_rel(root: Path | None = None) -> str:
    return home_of(LAB_HOMES, root)


def research_rel(root: Path | None = None) -> str:
    return home_of(RESEARCH_HOMES, root)


def dashboards_rel(root: Path | None = None) -> str:
    return home_of(DASHBOARD_HOMES, root)


def desk_name(desk: str) -> str:
    """Any desk spelling (`lab/venues/<v>`, `platform/lab/venues/<v>`,
    `desks/api/data/venues/<v>`, `venues/<v>`) -> the lab-relative name `venues/<v>`."""
    s = (desk or "").replace("\\", "/").strip("/")
    for pre in ("desks/",) + tuple(h + "/" for h in LAB_HOMES):
        if s.startswith(pre):
            s = s[len(pre):]
            break
    for old, new in LEGACY_DESK:
        if old.endswith("/"):
            if s.startswith(old):
                return new + s[len(old):]
        elif s == old or s.startswith(old + "/"):
            return new + s[len(old):]
    return s


def desk_rel(desk: str, root: Path | None = None) -> str:
    """A desk id -> its fund-relative folder (`lab/venues/<v>` ->
    `platform/lab/venues/<v>`). app/server/paths.ts deskRel() is the same rule."""
    return f"{lab_rel(root)}/{desk_name(desk)}"


def desk_dir(desk: str, root: Path | None = None) -> Path:
    r = root or fund_root()
    return r / desk_rel(desk, r)


def repo_of(root: Path, rel: str) -> Path:
    """The git repo that holds a fund-relative path: the deepest folder on its way
    carrying its own `.git`, else the fund root (app/server/loop/gitops.ts repoOf)."""
    out = root
    parts = rel.replace("\\", "/").strip("/").split("/")
    for i in range(1, len(parts) + 1):
        d = root.joinpath(*parts[:i])
        if (d / ".git").exists():
            out = d
    return out


def agents_dir(root: Path | None = None) -> Path:
    return (root or fund_root()) / AGENTS_DIR


def repos_file(root: Path | None = None) -> Path:
    return (root or fund_root()) / REPOS_FILE


def schedule_file(root: Path | None = None) -> Path:
    return (root or fund_root()) / SCHEDULE_FILE


# ---- the roster: app/agents/<id>.md, a YAML header + the brief ----
# The header grammar is shared/agentfile.ts's, deliberately small so both languages
# read it the same: `key: scalar`, `key:` then `  - item` lines, `key: []`, a
# one-line flow list `key: [a, b]`. A scalar is plain, "JSON-quoted" or
# 'single-quoted'; true/false/null and plain numbers are typed.

class AgentFileError(ValueError):
    pass


def agent_file_name(agent_id: str) -> str:
    return agent_id.replace(":", "-") + ".md"


def _scalar(raw: str):
    s = raw.strip()
    if s == "":
        return ""
    if s.startswith('"'):
        if not s.endswith('"') or len(s) < 2:
            raise AgentFileError(f"unterminated string {s}")
        try:
            return json.loads(s)
        except ValueError:
            raise AgentFileError(f"bad string {s}")
    if s.startswith("'"):
        if not s.endswith("'") or len(s) < 2:
            raise AgentFileError(f"unterminated string {s}")
        return s[1:-1].replace("''", "'")
    if s == "true":
        return True
    if s == "false":
        return False
    if s in ("null", "~"):
        return None
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return float(s) if "." in s else int(s)
    return s


def _flow_items(inner: str) -> list[str]:
    out, cur, q, i = [], "", None, 0
    while i < len(inner):
        c = inner[i]
        if q:
            cur += c
            if c == "\\" and q == '"' and i + 1 < len(inner):
                i += 1
                cur += inner[i]
            elif c == q:
                q = None
        elif c in "\"'":
            q = c
            cur += c
        elif c == ",":
            out.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    if q:
        raise AgentFileError(f"unterminated string in [{inner}]")
    if cur.strip() or out:
        out.append(cur)
    return [x.strip() for x in out if x.strip()]


def _strip_comment(v: str) -> str:
    return v if v.strip()[:1] in ("'", '"') else re.sub(r"\s+#.*$", "", v)


def _text(v) -> str:
    return "" if v is None else (json.dumps(v) if isinstance(v, bool) else str(v))


def parse_header(text: str) -> dict:
    out: dict = {}
    lst = None
    for n, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        line = raw.rstrip()
        if not line.strip() or re.match(r"^\s*#", line):
            continue
        item = re.match(r"^\s+-\s*(.*)$", line) or re.match(r"^-\s+(.*)$", line)
        if item:
            if lst is None:
                raise AgentFileError(f"line {n}: a list item outside a list")
            lst.append(_text(_scalar(_strip_comment(item.group(1)))))
            continue
        kv = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$", line)
        if not kv:
            raise AgentFileError(f'line {n}: not "key: value": {line.strip()}')
        key, rest = kv.group(1), kv.group(2) or ""
        if key in out:
            raise AgentFileError(f"line {n}: {key} given twice")
        v = _strip_comment(rest).strip()
        if v == "":
            lst = []
            out[key] = lst
            continue
        lst = None
        if v.startswith("["):
            if not v.endswith("]"):
                raise AgentFileError(f"line {n}: unterminated list")
            out[key] = [_text(_scalar(x)) for x in _flow_items(v[1:-1])]
        else:
            out[key] = _scalar(v)
    return out


def parse_agent_file(raw: str) -> tuple[dict, str]:
    """(header, body) of one roster file; AgentFileError on a bad header."""
    text = raw.lstrip("﻿").replace("\r\n", "\n")
    if not text.startswith("---\n"):
        raise AgentFileError("no header: the file must open with a --- line")
    end = text.find("\n---", 3)
    if end < 0:
        raise AgentFileError("the header has no closing --- line")
    closing = text[end + 1:].split("\n", 1)[0]
    if closing.strip() != "---":
        raise AgentFileError("the header has no closing --- line")
    header = parse_header(text[4:end])
    body = text[end + 1 + len(closing):].lstrip("\n")
    return header, body


def agents(root: Path | None = None) -> list[dict]:
    """Every agent's header, sorted by `order` then id. A file that does not parse,
    or whose header lacks an id, writes or boot list, is skipped (the cockpit's
    System room names it); app/server/roster.ts readRoster() is the same reader."""
    d = agents_dir(root)
    rows = []
    try:
        names = sorted(n for n in os.listdir(d) if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.md", n)
                       and n.lower() != "readme.md")
    except OSError:
        return []
    seen = set()
    for n in names:
        try:
            h, _ = parse_agent_file((d / n).read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, AgentFileError):
            continue
        if not isinstance(h.get("id"), str) or agent_file_name(h["id"]) != n or h["id"] in seen:
            continue
        if not isinstance(h.get("writes"), list) or not isinstance(h.get("boot"), list):
            continue
        seen.add(h["id"])
        rows.append(h)
    return sorted(rows, key=lambda h: (h["order"] if isinstance(h.get("order"), (int, float)) and not isinstance(h.get("order"), bool) else float("inf"), h["id"]))


def current_agent_id(agent_id: str) -> str:
    return dict(RETIRED_AGENTS).get(agent_id, agent_id)


# ---- the shelves: DERIVED from the library folders ----

def _folders(r: Path, rel: str) -> list[str]:
    d = r / rel
    if not d.is_dir():
        return []
    return sorted(c.name for c in d.iterdir() if c.is_dir() and not c.name.startswith((".", "_")))


def shelf_id(root_rel: str) -> str:
    p = root_rel.replace("\\", "/").rstrip("/")
    return p.split("/")[-1]


def shelves(root: Path | None = None) -> list[str]:
    """Every shelf root, fund-relative, forward slashes, in the derived order:
    app/library/<x> (the one library), then any legacy root library/<x> no current home
    holds and that is not retired. The
    cockpit derives the same set (app/server/shelves.ts shelfRoots); nothing
    configures it."""
    r = root or fund_root()
    current = [f"{APP_LIBRARY}/{x}" for x in _folders(r, APP_LIBRARY)]
    ids = {shelf_id(x) for x in current}
    legacy = [f"{LEGACY_LIBRARY}/{x}" for x in _folders(r, LEGACY_LIBRARY)
              if x not in LEGACY_LIBRARY_RETIRED and x not in ids]
    return current + legacy


def layout() -> dict:
    return {
        "app": APP, "agents_dir": AGENTS_DIR, "board": BOARD, "schedule": SCHEDULE_FILE,
        "loop_records": LOOP_RECORDS, "loop_tools": LOOP_TOOLS, "loop_config": LOOP_CONFIG,
        "tools": TOOLS, "repos": REPOS_FILE, "lab": LAB,
        "lab_homes": list(LAB_HOMES), "dashboard_homes": list(DASHBOARD_HOMES),
        "app_library": APP_LIBRARY,
        "legacy_library": LEGACY_LIBRARY, "legacy_library_retired": list(LEGACY_LIBRARY_RETIRED),
        "platform": PLATFORM, "research": RESEARCH,
        "legacy_cwd": [list(x) for x in LEGACY_CWD],
        "legacy_desk": [list(x) for x in LEGACY_DESK],
        "retired_agents": [list(x) for x in RETIRED_AGENTS],
    }


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--json" in args:
        print(json.dumps(layout()))
    elif "--floor" in args:
        print(floor_dir())
    elif "--snapshots" in args:
        print(snapshots_dir())
    elif "--shelves" in args:
        for s in shelves():
            print(s)
    elif "--agents" in args:
        print(json.dumps(agents()))
    elif "--desk" in args:
        i = args.index("--desk")
        print(desk_rel(args[i + 1]) if i + 1 < len(args) else "")
    else:
        print(fund_root())
