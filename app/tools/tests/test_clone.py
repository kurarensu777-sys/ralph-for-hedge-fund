#!/usr/bin/env python3
"""Tests for app/tools/clone.py - rebuilding the tree on a new machine from repos.json.

Run:  .venv/Scripts/python.exe app/tools/tests/test_clone.py
      (stdlib + git; no network: every "remote" is a scratch repo on disk)

Each test builds a scratch SOURCE fund (a fund repo plus two sub-repos, each its own
history), clones the fund repo alone into a scratch NEW MACHINE, copies the clone.py
under test into it and runs it there - so the file is exercised exactly as a fresh clone
would run it, and the real fund is never touched. The expected values are written here
by hand, never read back from clone.py.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import venv
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
sys.path.insert(0, str(TOOLS.parent / "loop" / "tools" / "tests"))   # app/tools -> app/loop/tools/tests

import fixtures  # noqa: E402  (git helpers + a Windows-safe rmtree)

REMOTE_APP = "https://example.invalid/fund-app.git"
REMOTE_PLAT = "https://example.invalid/fund-platform.git"


def repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    for rel, text in files.items():
        p = path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8", newline="\n")
    fixtures.git(path, "init", "-q", "-b", "main")
    for k, v in (("core.autocrlf", "false"), ("core.hooksPath", ".git/no-hooks"),
                 ("commit.gpgsign", "false")):
        fixtures.git(path, "config", k, v)
    fixtures.git(path, "add", "--", ".")
    fixtures.git(path, "commit", "-q", "-m", "fixture")
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="clonetest-"))
        self.src = self.tmp / "source"
        self.repos = {"repos": [
            {"id": "fund", "path": ".", "remote": "https://example.invalid/fund.git"},
            {"id": "app", "path": "app", "remote": REMOTE_APP,
             "setup": [["{python}", "-c", "open('app-setup.txt','w').write('ran')"]]},
            {"id": "platform", "path": "platform", "remote": REMOTE_PLAT,
             "setup": [["{python}", "-c", "open('one.txt','w').write('1')"],
                       ["{python}", "-c", "import sys; sys.exit(3)"],
                       ["{python}", "-c", "open('three.txt','w').write('3')"]]},
            {"id": "exe", "path": "exe", "remote": "https://example.invalid/fund-exe.git",
             "needs": ["platform"],
             "setup": [["{python}", "-c", "open('exe-setup.txt','w').write('ran')"]]},
        ]}
        repo(self.src, {"repos.json": json.dumps(self.repos, indent=2) + "\n",
                        ".gitignore": "/app/\n/platform/\n/exe/\n.venv/\n"})
        # clone.py lives in the APP repo (app/tools/clone.py) since 2026-09-25
        repo(self.src / "app", {"README.md": "app\n",
                                "tools/clone.py": (TOOLS / "clone.py").read_text(encoding="utf-8")})
        repo(self.src / "platform", {"README.md": "platform\n"})
        repo(self.src / "exe", {"README.md": "exe\n"})
        # the new machine: the fund repo cloned by hand, then the bootstrap the root's start.bat
        # does - app/ cloned from repos.json's remote for app - and only then clone.py
        self.new = self.tmp / "new"
        fixtures.git(self.tmp, "clone", "-q", str(self.src), str(self.new))
        fixtures.git(self.tmp, "clone", "-q", str(self.src / "app"), str(self.new / "app"))
        fixtures.git(self.new / "app", "remote", "set-url", "origin", REMOTE_APP)

    def tearDown(self):
        fixtures.rmtree(self.tmp)

    def clone(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(self.new / "app" / "tools" / "clone.py"), *args],
                              cwd=str(self.new), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", env=fixtures.git_env(),
                              timeout=300)

    def origin(self, rel: str) -> str:
        return fixtures.git(self.new / rel, "remote", "get-url", "origin").strip()


class TestClone(Base):
    def test_missing_sub_repos_are_cloned_and_origin_is_the_named_remote(self):
        r = self.clone("--source", str(self.src), "--no-install")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("have    app", r.stdout, "app/ is the bootstrap's, already there")
        self.assertEqual((self.new / "platform" / "README.md").read_text(encoding="utf-8"),
                         "platform\n")
        self.assertEqual((self.new / "exe" / "README.md").read_text(encoding="utf-8"), "exe\n")
        self.assertEqual(self.origin("app"), REMOTE_APP)
        self.assertEqual(self.origin("platform"), REMOTE_PLAT)
        self.assertFalse((self.new / ".venv").exists(), "--no-install creates no venv")
        # a second run is a no-op that says so
        r2 = self.clone("--source", str(self.src), "--no-install")
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
        self.assertIn("have    app", r2.stdout)
        self.assertIn("have    platform", r2.stdout)
        self.assertNotIn("[clone] run", r2.stdout)

    def test_an_existing_repo_is_never_rewritten_and_a_wrong_origin_is_reported(self):
        fixtures.git(self.tmp, "clone", "-q", str(self.src / "platform"), str(self.new / "platform"))
        marker = self.new / "platform" / "local-work.txt"
        marker.write_text("mine\n", encoding="utf-8")
        r = self.clone("--source", str(self.src), "--no-install")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("WARN", r.stdout)
        self.assertIn("left as it is", r.stdout)
        self.assertEqual(self.origin("platform"), str(self.src / "platform"), "origin untouched")
        self.assertTrue(marker.is_file(), "uncommitted work in an existing repo survives")

    def test_a_non_repo_folder_in_the_way_fails_and_is_left_alone(self):
        (self.new / "platform").mkdir()
        (self.new / "platform" / "stray.txt").write_text("x\n", encoding="utf-8")
        r = self.clone("--source", str(self.src), "--no-install")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("is not a git repo", r.stdout)
        self.assertTrue((self.new / "platform" / "stray.txt").is_file())
        self.assertTrue((self.new / "exe" / ".git").exists(), "the other repo still cloned")

    def test_dry_run_changes_nothing(self):
        r = self.clone("--source", str(self.src), "--dry-run")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("would", r.stdout)
        self.assertFalse((self.new / "exe").exists())
        self.assertFalse((self.new / "platform").exists())
        self.assertFalse((self.new / ".venv").exists())

    def test_setup_runs_in_each_repo_with_the_venv_python_and_stops_at_a_failure(self):
        # a venv without pip is enough to prove {python} is the venv's own interpreter
        venv.EnvBuilder(with_pip=False).create(self.new / ".venv")
        r = self.clone("--source", str(self.src))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("have    .venv", r.stdout)
        self.assertEqual((self.new / "app" / "app-setup.txt").read_text(encoding="utf-8"), "ran")
        self.assertTrue((self.new / "platform" / "one.txt").is_file())
        self.assertFalse((self.new / "platform" / "three.txt").exists(),
                         "a step after a failed one does not run")
        self.assertIn("platform setup 2/3: exit 3", r.stdout)
        self.assertFalse((self.new / "exe" / "exe-setup.txt").exists(),
                         "a repo that needs a failed repo is skipped")
        self.assertIn("exe: needs platform, whose setup failed", r.stdout)
        self.assertIn("FAILED", r.stdout)
        py = "Scripts" if sys.platform == "win32" else "bin"
        self.assertIn(str(self.new / ".venv" / py), r.stdout, "the venv's interpreter ran it")

    def test_a_root_too_deep_for_windows_paths_is_refused_before_pip(self):
        spec = importlib.util.spec_from_file_location("clone_under_test", TOOLS / "clone.py")
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        self.assertEqual(m.long_paths_ok(Path("C:/dev/fund"))[0], True)
        deep = Path("C:/" + "d" * 97)            # 100 characters: 100 + 162 = 262 > 259
        ok, why = m.long_paths_ok(deep)
        if sys.platform != "win32" or ok:
            self.skipTest("not Windows, or long paths are enabled on this machine")
        self.assertIn("262 characters", why)
        self.assertEqual(m.long_paths_ok(Path("C:/" + "d" * 94))[0], True, "97 + 162 = 259 fits")

    def test_a_path_that_leaves_the_root_is_refused(self):
        bad = json.loads((self.new / "repos.json").read_text(encoding="utf-8"))
        bad["repos"].append({"id": "evil", "path": "../outside", "remote": REMOTE_APP})
        (self.new / "repos.json").write_text(json.dumps(bad), encoding="utf-8")
        r = self.clone("--source", str(self.src), "--no-install")
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("leaves the fund root", r.stderr)
        self.assertFalse((self.tmp / "outside").exists())
        self.assertFalse((self.new / "platform").exists(), "nothing is cloned from a bad repos.json")

    def test_source_must_be_a_fund_tree(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        r = self.clone("--source", str(empty), "--no-install")
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("not a fund tree", r.stderr)


if __name__ == "__main__":
    shutil.which("git") or sys.exit("git is not on PATH")
    unittest.main(verbosity=1)
