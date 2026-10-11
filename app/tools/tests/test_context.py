"""context.py's planted faults: every cap and every ref check goes red once on purpose, on a throwaway
tree, never the real one. The real tree is the check.py row tools.context-caps."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import context  # noqa: E402

AGENT = """---
id: {id}
name: {id}
kind: standing
mode: active
dept: Build
role: a test agent
cwd: {cwd}
model: claude-sonnet-5-5
effort: high
order: 1
writes:
  - {cwd}/
boot: {boot}
---

{body}
"""

BOOK = """---
topics: [workflow]
type: guide
---

# How we work

A test book.

## Who writes where

Read when: about to write outside your folder.

The roster is the arbiter.

## Data: the four classes

Read when: about to pull or keep data.

Four classes.
"""


class ContextCaps(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="ctx-"))
        self.write("CLAUDE.md", "# base\n\nshort\n\n## Recall\n\n| a | `app/library/law/how-we-work.md#who-writes-where` |\n")
        self.write("app/library/law/how-we-work.md", BOOK)
        self.write("app/CLAUDE.md", "# app\n\nshort workspace\n")
        self.agent("app", "app", '["app/library/law/how-we-work.md#who-writes-where"]', "You build the cockpit.\n\nDone: verify green.")
        self.addCleanup(shutil.rmtree, self.root, True)

    def write(self, rel: str, text: str) -> None:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    def agent(self, aid: str, cwd: str, boot: str, body: str) -> None:
        self.write(f"app/agents/{aid}.md", AGENT.format(id=aid, cwd=cwd, boot=boot, body=body))

    def audit(self) -> context.Report:
        return context.audit(self.root)

    def has(self, items: list[str], needle: str) -> bool:
        return any(needle in x for x in items)

    def test_clean_tree_passes(self) -> None:
        r = self.audit()
        self.assertEqual(r.failed, [], r.failed)
        self.assertGreater(r.ok, 5)

    def test_slug_rule(self) -> None:
        self.assertEqual(context.slug("Data: the four classes"), "data-the-four-classes")
        self.assertEqual(context.slug("Lesson: distance to liquidation at the wick"), "lesson-distance-to-liquidation-at-the-wick")
        self.assertEqual(context.slug("Orderflow reads: FLOW, DEPTH, PROFILE"), "orderflow-reads-flow-depth-profile")

    def test_base_over_cap_fails(self) -> None:
        self.write("CLAUDE.md", "x" * (context.BASE_CAP * 4 + 400))
        self.assertTrue(self.has(self.audit().failed, "base: CLAUDE.md"))

    def test_agent_prompt_over_cap_fails(self) -> None:
        self.agent("app", "app", "[]", "y" * (context.AGENT_CAP * 4 + 400))
        self.assertTrue(self.has(self.audit().failed, "agent app: prompt"))

    def test_boot_ref_to_missing_chapter_fails(self) -> None:
        self.agent("app", "app", '["app/library/law/how-we-work.md#no-such-chapter"]', "short")
        self.assertTrue(self.has(self.audit().failed, "has no chapter #no-such-chapter"))

    def test_boot_ref_to_missing_file_fails(self) -> None:
        self.agent("app", "app", '["app/library/law/gone.md"]', "short")
        self.assertTrue(self.has(self.audit().failed, "gone.md is not on disk"))

    def test_chapter_without_read_when_fails(self) -> None:
        self.write("app/library/law/how-we-work.md", BOOK.replace("Read when: about to pull or keep data.\n\n", ""))
        self.assertTrue(self.has(self.audit().failed, "#data-the-four-classes: the chapter does not open"))

    def test_chapter_over_cap_fails_and_over_target_warns(self) -> None:
        big = BOOK.replace("Four classes.", "z" * (context.CHAPTER_CAP * 4 + 400))
        self.write("app/library/law/how-we-work.md", big)
        self.assertTrue(self.has(self.audit().failed, "#data-the-four-classes is"))
        mid = BOOK.replace("Four classes.", "z" * (context.CHAPTER_TARGET * 4 + 400))
        self.write("app/library/law/how-we-work.md", mid)
        r = self.audit()
        self.assertFalse(self.has(r.failed, "#data-the-four-classes is"))
        self.assertTrue(self.has(r.warned, "#data-the-four-classes is"))

    def test_book_over_cap_fails(self) -> None:
        n = context.BOOK_CAP * 4 // 3000 + 2           # every chapter under its cap, the book over its own
        chapters = "".join(f"\n## Chapter {i}\n\nRead when: test {i}.\n\n{'w' * 3000}\n" for i in range(n))
        self.write("app/library/law/big.md", "---\ntopics: [workflow]\ntype: guide\n---\n\n# Big\n" + chapters)
        self.assertTrue(self.has(self.audit().failed, "book app/library/law/big.md is"))

    def test_duplicate_slug_fails(self) -> None:
        self.write("app/library/law/dup.md", "---\ntype: guide\n---\n\n# Dup\n\n## Same: one\n\nRead when: a.\n\n## Same one\n\nRead when: b.\n")
        self.assertTrue(self.has(self.audit().failed, "two chapters slug to #same-one"))

    def test_workspace_over_cap_fails_since_the_flip(self) -> None:
        self.write("app/CLAUDE.md", "v" * (context.WORKSPACE_CAP * 4 + 400))
        r = self.audit()
        self.assertTrue(self.has(r.failed, "workspace app/CLAUDE.md"))
        self.assertFalse(self.has(r.warned, "workspace app/CLAUDE.md"))
        old = context.WORKSPACE_FAILS
        context.WORKSPACE_FAILS = False   # the switch still works: off, the same overrun only warns
        try:
            r = self.audit()
            self.assertFalse(self.has(r.failed, "workspace app/CLAUDE.md"))
            self.assertTrue(self.has(r.warned, "workspace app/CLAUDE.md"))
        finally:
            context.WORKSPACE_FAILS = old

    def test_screen_runbook_has_its_own_cap(self) -> None:
        self.assertEqual(context.workspace_cap("platform/dashboards/carry/CLAUDE.md"), context.SCREEN_CAP)
        self.assertEqual(context.workspace_cap("platform/CLAUDE.md"), context.WORKSPACE_CAPS["platform/CLAUDE.md"])
        self.assertEqual(context.workspace_cap("app/CLAUDE.md"), context.WORKSPACE_CAP)

    def test_dead_chapter_citation_in_base_fails(self) -> None:
        self.write("CLAUDE.md", "# base\n\n| a | `app/library/law/how-we-work.md#renamed-heading` |\n")
        self.assertTrue(self.has(self.audit().failed, "cites app/library/law/how-we-work.md#renamed-heading"))

    def test_dead_plain_citation_warns_outside_the_base(self) -> None:
        self.write("app/CLAUDE.md", "# app\n\nsee `app/library/craft/gone.md`\n")
        r = self.audit()
        self.assertTrue(self.has(r.warned, "app/CLAUDE.md: cites app/library/craft/gone.md"))
        self.assertFalse(self.has(r.failed, "app/CLAUDE.md: cites"))

    def test_a_dead_path_in_the_roster_or_a_skill_or_a_book_fails(self) -> None:
        self.write(".claude/skills/run/SKILL.md", "---\nname: run\n---\nsee `app/library/law/gone.md`\n")
        self.assertTrue(self.has(self.audit().failed, ".claude/skills/run/SKILL.md: cites app/library/law/gone.md"))
        self.write(".claude/skills/run/SKILL.md", "---\nname: run\n---\nok\n")
        self.write("app/library/law/other.md", "---\ntype: guide\n---\n\n# O\n\n## One\n\nRead when: a.\n\nsee `app/library/law/gone.md`\n")
        self.assertTrue(self.has(self.audit().failed, "app/library/law/other.md: cites app/library/law/gone.md"))

    def test_a_dead_path_in_another_owners_file_warns_but_a_dead_chapter_fails(self) -> None:
        self.write("platform/lab/x/results-log.md", "see `app/library/craft/gone.md` and `app/library/law/how-we-work.md#who-writes-where`\n")
        r = self.audit()
        self.assertTrue(self.has(r.warned, "platform/lab/x/results-log.md: cites app/library/craft/gone.md"))
        self.assertFalse(self.has(r.failed, "platform/lab/x/results-log.md"))
        self.write("platform/lab/x/results-log.md", "see `app/library/law/how-we-work.md#renamed-heading`\n")
        self.assertTrue(self.has(self.audit().failed, "platform/lab/x/results-log.md: cites app/library/law/how-we-work.md#renamed-heading"))

    def test_a_scan_over_nothing_fails(self) -> None:
        empty = Path(tempfile.mkdtemp(prefix="ctx-empty-"))
        self.addCleanup(shutil.rmtree, empty, True)
        r = context.audit(empty)
        self.assertTrue(self.has(r.failed, "a check over nothing prints the same as a pass"), r.failed)

    def test_the_caps_are_the_json_files_and_nothing_else(self) -> None:
        import json
        caps = json.loads((Path(context.__file__).resolve().parent / "context-caps.json").read_text(encoding="utf-8"))
        self.assertEqual((context.BASE_CAP, context.AGENT_CAP, context.BOOT_CAP, context.CHAPTER_CAP, context.BOOK_CAP, context.WORKSPACE_CAP, context.SCREEN_CAP),
                         (caps["base"], caps["agent"], caps["boot"], caps["chapter"], caps["book"], caps["workspace"], caps["screen"]))
        self.assertEqual(context.WORKSPACE_CAPS, caps["workspaceNamed"])
        self.assertLess(caps["chapterTarget"], caps["chapter"])

    def test_a_book_over_ninety_percent_of_its_cap_warns_and_does_not_fail(self) -> None:
        n = int(context.BOOK_CAP * 4 * 0.95) // 2930     # ~95% of the book cap, every chapter ~0.7k tokens
        body = "".join(f"\n## C{i}\n\nRead when: t{i}.\n\n{'q' * 2900}\n" for i in range(n))
        self.write("app/library/law/near.md", "---\ntype: guide\n---\n\n# Near\n" + body)
        r = self.audit()
        self.assertTrue(self.has(r.warned, "app/library/law/near.md is"), r.warned)
        self.assertFalse(self.has(r.failed, "app/library/law/near.md is"))

    def test_ref_checks_a_ref_before_it_is_written(self) -> None:
        import contextlib
        import io
        real = context._root.fund_root
        context._root.fund_root = lambda: self.root
        try:
            def run(*refs):
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    code = context.main(["--ref", *refs])
                return code, buf.getvalue()
            code, out = run("app/library/law/how-we-work.md#who-writes-where")
            self.assertEqual(code, 0, out)
            code, out = run("app/library/law/how-we-work.md#who-writes-where", "app/library/law/how-we-work.md#thin-histories")
            self.assertEqual(code, 1, out)
            self.assertIn("DEAD  app/library/law/how-we-work.md#thin-histories", out)
        finally:
            context._root.fund_root = real

    def _run(self, *argv, env=None):
        import contextlib
        import io
        real, real_env = context._root.fund_root, dict(os.environ)
        context._root.fund_root = lambda: self.root
        for k in ("FUND_AGENT", "FUND_CONVERSATION", "FUNDD_PORT"):
            os.environ.pop(k, None)
        os.environ.update(env or {})
        try:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = context.main(list(argv))
            return code, buf.getvalue()
        finally:
            context._root.fund_root = real
            os.environ.clear()
            os.environ.update(real_env)

    def test_show_prints_one_chapter_and_not_the_book(self) -> None:
        code, out = self._run("--show", "app/library/law/how-we-work.md#who-writes-where")
        self.assertEqual(code, 0, out)
        self.assertIn("The roster is the arbiter.", out)
        self.assertNotIn("Data: the four classes", out)          # the other chapter of the same book stays out

    def test_show_a_bare_book_prints_its_table_of_contents(self) -> None:
        code, out = self._run("--show", "app/library/law/how-we-work.md")
        self.assertEqual(code, 0, out)
        self.assertIn("how-we-work.md#who-writes-where", out)
        self.assertIn("about to write outside your folder", out)
        self.assertNotIn("The roster is the arbiter.", out)

    def test_show_a_dead_ref_exits_one_and_names_the_real_chapters(self) -> None:
        code, out = self._run("--show", "app/library/law/how-we-work.md#thin-histories")
        self.assertEqual(code, 1)
        self.assertIn("who-writes-where", out)

    def test_show_tells_fundd_which_book_an_agent_pulled(self) -> None:
        import http.server
        import json as _json
        import threading
        seen = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                seen.append((self.path, _json.loads(self.rfile.read(int(self.headers["content-length"])))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        code, _ = self._run("--show", "app/library/law/how-we-work.md#who-writes-where",
                            env={"FUND_AGENT": "app", "FUND_CONVERSATION": "c-1", "FUNDD_PORT": str(srv.server_address[1])})
        self.assertEqual(code, 0)
        self.assertEqual(seen, [("/api/library/read", {"agent": "app", "conversation": "c-1", "path": "app/library/law/how-we-work.md"})])
        seen.clear()
        self._run("--show", "app/library/law/how-we-work.md#who-writes-where", env={"FUNDD_PORT": str(srv.server_address[1])})
        self.assertEqual(seen, [])                                # the owner's own session records nothing

    def test_show_survives_fundd_being_down(self) -> None:
        code, out = self._run("--show", "app/library/law/how-we-work.md#who-writes-where", env={"FUND_AGENT": "app", "FUNDD_PORT": "1"})
        self.assertEqual(code, 0, out)
        self.assertIn("The roster is the arbiter.", out)

    def test_dormant_agent_is_not_measured(self) -> None:
        self.write("app/agents/execution.md", AGENT.format(id="execution", cwd="app", boot='["app/library/law/gone.md"]', body="x" * 4000).replace("mode: active", "mode: dormant"))
        self.assertFalse(self.has(self.audit().failed, "agent execution"))


if __name__ == "__main__":
    unittest.main(verbosity=1)
