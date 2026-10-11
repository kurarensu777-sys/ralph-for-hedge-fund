#!/usr/bin/env python3
"""PROBE `git` - every repo in repos.json (the fund root): dirty, ahead, behind.

Uncommitted work is work that exists on exactly one machine. Unpushed commits
are the same fact one step later. Neither is an emergency, so only ONE
condition is unconditionally red: BEHIND > 0, which means someone else's work
is not here and the next commit will be a merge you did not plan. The dirty
and ahead limits are POLICY KNOBS, not measurements - they are set wide
(`--dirty-max 120`, `--ahead-max 20`) on purpose, because a probe that goes
red at a normal day's in-flight work gets ignored, and an ignored probe is
worse than no probe.

It NEVER pushes, fetches or writes. `git status` and `rev-list` only, so it
cannot itself change what it measures - and note that `behind` is therefore
the count as of the last fetch SOMEBODY ELSE did, which the detail line says.

The repo set is `repos.json` at the fund root (the fund root plus any nested repo it lists);
when that file is unreadable the fallback is the fund root alone, and the detail says so.

  python app/tools/probes/git.py [--dry] [--json] [--dirty-max 120] [--ahead-max 20]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _probe as P  # noqa: E402


def repo_state(path: Path, timeout: float) -> dict:
    d = {"path": str(path), "ok": False, "dirty": 0, "ahead": 0, "behind": 0,
         "branch": "", "upstream": "", "note": ""}
    if not (path / ".git").exists():
        d["note"] = "not a git repo"
        return d
    rc, out, err = P.run(["git", "status", "--porcelain"], timeout, path)
    if rc != 0:
        d["note"] = (err or "git status failed")[:150]
        return d
    d["dirty"] = len([ln for ln in out.splitlines() if ln.strip()])
    rc, out, _ = P.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], timeout, path)
    d["branch"] = out.strip() if rc == 0 else "?"
    if P.run(["git", "rev-parse", "--verify", "HEAD"], timeout, path)[0] != 0:
        rc2, out2, _ = P.run(["git", "symbolic-ref", "--short", "HEAD"], timeout, path)
        d["branch"] = out2.strip() if rc2 == 0 else "?"
        d["note"] = "no commits yet - nothing to be ahead or behind of"
        d["ok"] = True
        return d
    rc, out, _ = P.run(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], timeout, path)
    if rc == 0 and out.strip():
        d["upstream"] = out.strip()
        rc, out, _ = P.run(["git", "rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
                           timeout, path)
        if rc == 0 and out.split():
            parts = out.split()
            d["behind"], d["ahead"] = int(parts[0]), int(parts[1])
    else:
        d["note"] = "no upstream - nothing to be ahead OF"
    d["ok"] = True
    return d


FALLBACK = (("fund", "."),)


def repo_set(root: Path) -> tuple[dict[str, Path], str]:
    """{name: path} from repos.json at the fund root, plus a note when it fell back."""
    try:
        doc = json.loads((root / "repos.json").read_text(encoding="utf-8"))
        rows = [r for r in doc.get("repos", []) if r.get("id") and r.get("path")]
        if rows:
            return {r["id"]: (root / r["path"]).resolve() for r in rows}, ""
    except (OSError, ValueError, AttributeError):
        pass
    return ({n: (root / p).resolve() for n, p in FALLBACK},
            "repos.json unreadable - checked the fallback set")


def words(s: dict) -> str:
    """one repo in the Git room's own wording: '1 dirty, 4 ahead' / 'clean'"""
    parts = [f"{s[k]} {k}" for k in ("dirty", "ahead", "behind") if s.get(k)]
    return ", ".join(parts) or "clean"


def body(ctx: P.Ctx) -> P.Result:
    dirty_max = int(getattr(ctx.args, "dirty_max", 120))
    ahead_max = int(getattr(ctx.args, "ahead_max", 20))
    repos, note = repo_set(ctx.root)
    states, lines, bad = {}, [], []
    if note:
        lines.append(note)
    for name, path in repos.items():
        s = repo_state(path, min(30, ctx.left))
        states[name] = s
        if not s["ok"]:
            lines.append(f"{name:9} -  {s['note']}")
            bad.append(f"{name}: {s['note']}")
            continue
        lines.append(f"{name:9} {s['branch']:<12} dirty {s['dirty']:<4} "
                     f"ahead {s['ahead']:<4} behind {s['behind']:<4}"
                     + (f"  ({s['note']})" if s["note"] else ""))
        if s["behind"]:
            bad.append(f"{name} is {s['behind']} behind {s['upstream']}")
        if s["dirty"] > dirty_max:
            bad.append(f"{name} has {s['dirty']} uncommitted files (> {dirty_max})")
        if s["ahead"] > ahead_max:
            bad.append(f"{name} is {s['ahead']} commits unpushed (> {ahead_max})")

    reading = " · ".join(
        f"{n} {words(s)}" if s["ok"] else f"{n}: {s['note']}"
        for n, s in states.items())
    if bad:
        reading = "; ".join(bad[:3])
    lines.append("behind is as of the last fetch SOMEBODY did - this probe never fetches")

    res = P.Result("fail" if bad else "ok", reading, "\n".join(lines), extra={"repos": states})
    return res


def parser():
    ap = P.base_parser(P.REGISTRY["git"])
    ap.add_argument("--dirty-max", type=int, default=120)
    ap.add_argument("--ahead-max", type=int, default=20)
    return ap


if __name__ == "__main__":
    sys.exit(P.main("git", body, parser=parser()))
