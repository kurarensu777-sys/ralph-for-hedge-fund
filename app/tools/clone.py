#!/usr/bin/env python3
"""Rebuild the fund's tree on a new machine from repos.json.

The fund repo is cloned by hand. repos.json at its root lists every git repo the
fund is made of (the fund root itself is the row with path "."; a nested repo, if
any, is a row with its own path and remote) and what each needs on a new machine.
From the fund root:

    start.bat                                       runs this when anything is missing (Windows)
    python app/tools/clone.py                       the same, any OS
    python app/tools/clone.py --dry-run             print the plan, change nothing
    python app/tools/clone.py --no-install          clone only: no venv, no pip, no npm
    python app/tools/clone.py --source <fund dir>   clone each nested repo from a local fund tree
                                                    (offline, or a test); origin is still set to
                                                    the remote repos.json names

What it does, in order, every step skipped when it is already done:

  1. every nested repo in repos.json that is missing on disk is cloned into its
     `path` (main); one already there is left alone and its origin is checked
     against repos.json (a mismatch is reported, never rewritten);
  2. the ONE venv, `.venv/` at the fund root, is created with the interpreter
     running this script (3.12 or newer);
  3. each repo's `setup` steps run from that repo, in repos.json order (argv
     lists, `{python}` = the venv's interpreter), e.g. `pip install -e` for a
     python package and `npm install` for a node one. A repo whose `needs` names
     a repo whose setup failed is skipped, and a failed step ends that repo.

Windows: pip writes paths under .venv deeper than 260 characters (jupyterlab's
bundled assets), so on a machine without long-path support a deep fund root
fails half-way through `pip install`. The script checks first and refuses,
naming the two fixes, rather than leave a half-built venv.

What it never does: pull, reset, or touch a repo that already exists beyond
reading its origin; push anything; write a credential. The commit guard is
installed by fundd (the cockpit) on its first start, not here: start.bat once,
then commit.

Exit: 0 done (or nothing to do) · 1 a step failed · 2 usage or an unreadable repos.json.
Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MIN_PY = (3, 12)
# The deepest file pip writes under the fund root on this stack, measured by walking a full venv:
# a jupyterlab galata asset 155 characters below .venv, so 162 below the root. Windows allows 259 characters in a path when long-path support is off.
DEEPEST_UNDER_ROOT = 162
MAX_PATH_CHARS = 259


def fund_root() -> Path:
    """This tree, never $FUND_ROOT: a clone is rebuilt where the script sits
    (<fund>/app/tools/clone.py, so two folders up)."""
    return Path(__file__).resolve().parents[2]


def load_repos(root: Path) -> list[dict]:
    doc = json.loads((root / "repos.json").read_text(encoding="utf-8"))
    rows = [r for r in doc.get("repos", []) if isinstance(r, dict) and r.get("id") and r.get("path")]
    for r in rows:
        p = Path(r["path"])
        if p.is_absolute() or ".." in p.parts:
            raise ValueError(f"repos.json: {r['id']} path {r['path']!r} leaves the fund root")
    return rows


def venv_python(root: Path) -> Path:
    v = root / ".venv"
    return v / "Scripts" / "python.exe" if os.name == "nt" else v / "bin" / "python"


def long_paths_ok(root: Path) -> tuple[bool, str]:
    """(ok, why). Always ok off Windows, or with LongPathsEnabled = 1 in the registry."""
    if os.name != "nt":
        return True, ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SYSTEM\CurrentControlSet\Control\FileSystem") as k:
            if winreg.QueryValueEx(k, "LongPathsEnabled")[0] == 1:
                return True, ""
    except OSError:
        pass
    need = len(str(root)) + DEEPEST_UNDER_ROOT
    if need <= MAX_PATH_CHARS:
        return True, ""
    return False, (f"the fund root is {len(str(root))} characters deep, so pip would write paths of "
                   f"~{need} characters under .venv and Windows long-path support is off: move the "
                   f"fund to a short root (such as C:/dev/fund) or enable long paths "
                   f"(https://pip.pypa.io/warnings/enable-long-paths), then run this again")


def git(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")


class Plan:
    def __init__(self, dry: bool):
        self.dry = dry
        self.failed: list[str] = []

    def say(self, tag: str, msg: str) -> None:
        print(f"[clone] {tag:<7} {msg}", flush=True)

    def run(self, argv: list[str], cwd: Path, label: str) -> bool:
        shown = " ".join(argv)
        if self.dry:
            self.say("would", f"{label}: {shown}  (in {cwd})")
            return True
        self.say("run", f"{label}: {shown}")
        exe = shutil.which(argv[0]) if not Path(argv[0]).is_absolute() else argv[0]
        if not exe:
            self.say("FAIL", f"{label}: {argv[0]} is not on PATH")
            self.failed.append(label)
            return False
        rc = subprocess.run([exe, *argv[1:]], cwd=cwd).returncode
        if rc != 0:
            self.say("FAIL", f"{label}: exit {rc}")
            self.failed.append(label)
            return False
        return True


def clone_missing(root: Path, repos: list[dict], source: Path | None, plan: Plan) -> None:
    for r in repos:
        if r["path"] in (".", ""):
            continue
        dest = root / r["path"]
        remote = r.get("remote")
        if (dest / ".git").exists():
            got = git("remote", "get-url", "origin", cwd=dest)
            have = got.stdout.strip() if got.returncode == 0 else ""
            if remote and have != remote:
                plan.say("WARN", f"{r['id']}: origin is {have or '(none)'}, repos.json names {remote}"
                                 " - left as it is")
            else:
                plan.say("have", f"{r['id']} ({r['path']})")
            continue
        if dest.exists() and any(dest.iterdir()):
            plan.say("FAIL", f"{r['id']}: {dest} exists, is not empty and is not a git repo")
            plan.failed.append(r["id"])
            continue
        src = str(source / r["path"]) if source else remote
        if not src:
            plan.say("FAIL", f"{r['id']}: repos.json names no remote")
            plan.failed.append(r["id"])
            continue
        if not plan.run(["git", "clone", "--branch", "main", src, str(dest)], root, f"clone {r['id']}"):
            continue
        if source and remote and not plan.dry:
            # cloned from a local tree: point origin where repos.json says it lives
            git("remote", "set-url", "origin", remote, cwd=dest)
            plan.say("origin", f"{r['id']} -> {remote}")


def make_venv(root: Path, plan: Plan) -> None:
    py = venv_python(root)
    if py.exists():
        plan.say("have", f".venv ({py.relative_to(root).as_posix()})")
        return
    if sys.version_info < MIN_PY:
        plan.say("FAIL", f".venv needs Python {'.'.join(map(str, MIN_PY))}+, this is {sys.version.split()[0]}")
        plan.failed.append(".venv")
        return
    if plan.dry:
        plan.say("would", f"create .venv with {sys.executable}")
        return
    plan.say("run", f"create .venv with {sys.executable}")
    try:
        venv.EnvBuilder(with_pip=True).create(root / ".venv")
    except Exception as e:           # noqa: BLE001 - reported, never swallowed
        plan.say("FAIL", f".venv: {e}")
        plan.failed.append(".venv")


def setup(root: Path, repos: list[dict], plan: Plan) -> None:
    py = str(venv_python(root))
    failed: set[str] = set()
    for r in repos:
        steps = r.get("setup") or []
        cwd = root / r["path"]
        if steps and not cwd.is_dir() and not plan.dry:
            plan.say("skip", f"{r['id']}: not on disk")
            failed.add(r["id"])
            continue
        blocked = sorted(set(r.get("needs") or []) & failed)
        if steps and blocked:
            plan.say("skip", f"{r['id']}: needs {', '.join(blocked)}, whose setup failed")
            plan.failed.append(f"{r['id']} setup (skipped)")
            failed.add(r["id"])
            continue
        for i, step in enumerate(steps, 1):
            argv = [py if a == "{python}" else a for a in step]
            if not plan.run(argv, cwd, f"{r['id']} setup {i}/{len(steps)}"):
                failed.add(r["id"])
                break                # a later step of this repo builds on this one


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--dry-run", action="store_true", help="print the plan, change nothing")
    ap.add_argument("--no-install", action="store_true", help="clone only: no venv, pip or npm")
    ap.add_argument("--source", type=Path,
                    help="clone each sub-repo from <source>/<path> instead of its remote")
    a = ap.parse_args(argv)

    root = fund_root()
    try:
        repos = load_repos(root)
    except (OSError, ValueError) as e:
        print(f"[clone] repos.json unreadable: {e}", file=sys.stderr)
        return 2
    source = a.source.resolve() if a.source else None
    if source and not (source / "repos.json").is_file():
        print(f"[clone] --source {source} is not a fund tree (no repos.json)", file=sys.stderr)
        return 2
    if shutil.which("git") is None:
        print("[clone] git is not on PATH", file=sys.stderr)
        return 2

    plan = Plan(a.dry_run)
    plan.say("root", str(root))
    clone_missing(root, repos, source, plan)
    if not a.no_install:
        ok, why = long_paths_ok(root)
        if not ok:
            plan.say("FAIL", why)
            return 1
        make_venv(root, plan)
        if ".venv" not in plan.failed:
            setup(root, repos, plan)
    if plan.failed:
        plan.say("FAILED", ", ".join(plan.failed))
        return 1
    plan.say("done", "start.bat starts the cockpit (it installs the commit guard on first start); "
                     ".venv\\Scripts\\python app\\tools\\check.py runs every suite" if not a.dry_run else "dry run - nothing changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
