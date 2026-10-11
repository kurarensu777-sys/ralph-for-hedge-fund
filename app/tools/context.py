"""context.py - every agent's boot context, by type, against the caps.

Six types of context (app/library/law/how-we-work.md#who-writes-where): system (Claude Code's own,
not measured), base (the root CLAUDE.md), agent (the body of app/agents/<id>.md), workspace (each
CLAUDE.md from the root down to the agent's cwd, the root excluded), books (one file of `##`
chapters, each opening with `Read when:`), and records (never context, never measured). Tokens are
chars/4, the estimate app/server/chat/law.ts uses.

  .venv\\Scripts\\python.exe app\\tools\\context.py            the check: findings, then `N ok, M failed, K warn`
  .venv\\Scripts\\python.exe app\\tools\\context.py --table    every agent's boot by type

A cap breach FAILS (a workspace file over its cap only warns while WORKSPACE_FAILS is off). A dead `#chapter` ref fails; a dead plain path into the library
from a CLAUDE.md warns (its owner repoints it). Exit 1 on any fail. tests/test_context.py plants each
fault once (the check.py row tools.context); this file run bare scans the real tree (tools.context-caps).
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _root  # noqa: E402

CAPS = json.loads((Path(__file__).resolve().parent / "context-caps.json").read_text(encoding="utf-8"))
BASE_CAP = CAPS["base"]              # the root CLAUDE.md
AGENT_CAP = CAPS["agent"]            # the body of app/agents/<id>.md
BOOT_CAP = CAPS["boot"]              # every booted chapter of one agent, together
CHAPTER_CAP = CAPS["chapter"]        # one chapter; over CHAPTER_TARGET warns (near the cap: split it before it grows)
CHAPTER_TARGET = CAPS["chapterTarget"]   # the writing target is 300-600; a warn below 750 would fire on half the library and be ignored
BOOK_CAP = CAPS["book"]              # one book
WORKSPACE_CAP = CAPS["workspace"]
WORKSPACE_CAPS = CAPS["workspaceNamed"]   # a named file's own cap; a dashboard's CLAUDE.md is a screen runbook
SCREEN_CAP = CAPS["screen"]
SCREEN_RE = re.compile(r"^platform/dashboards/[^/]+/CLAUDE\.md$")
WORKSPACE_FAILS = True  # off, a workspace file over its cap warns instead of failing
SKIP_DIRS = {"node_modules", ".git", ".venv", "__pycache__", ".cache", "dist"}

FM_RE = re.compile(r"^﻿?---\n(.*?)\n---[ \t]*(?:\n|$)", re.S)
REF_RE = re.compile(r"(app/library/[A-Za-z0-9_./-]+?\.md)(#[a-z0-9-]+)?(?![A-Za-z0-9_/.-])")


def tokens(text: str) -> int:
    return round(len(text) / 4)


def slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


@dataclass
class Chapter:
    title: str
    slug: str
    text: str
    read_when: bool

    @property
    def tokens(self) -> int:
        return tokens(self.text)


def frontmatter(text: str) -> dict[str, str]:
    m = FM_RE.match(text.replace("\r\n", "\n"))
    out: dict[str, str] = {}
    if m:
        for line in m.group(1).split("\n"):
            kv = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$", line)
            if kv:
                out[kv.group(1)] = kv.group(2).strip()
    return out


def chapters(text: str) -> list[Chapter]:
    """the `## ` sections of a book, outside code fences; each runs to the next `## ` or the end"""
    text = text.replace("\r\n", "\n")
    m = FM_RE.match(text)
    body = text[m.end():] if m else text
    out: list[Chapter] = []
    cur: list[str] | None = None
    title = ""
    fence = False
    for line in body.split("\n"):
        if re.match(r"^\s*(```|~~~)", line):
            fence = not fence
        if not fence and line.startswith("## "):
            if cur is not None:
                out.append(_chapter(title, cur))
            title, cur = line[3:].strip(), [line]
            continue
        if cur is not None:
            cur.append(line)
    if cur is not None:
        out.append(_chapter(title, cur))
    return out


def _chapter(title: str, lines: list[str]) -> Chapter:
    first = next((ln.strip() for ln in lines[1:] if ln.strip()), "")
    return Chapter(title, slug(title), "\n".join(lines), first.lower().startswith("read when:"))


@dataclass
class Report:
    ok: int = 0
    failed: list[str] = field(default_factory=list)
    warned: list[str] = field(default_factory=list)

    def check(self, good: bool, what: str, *, warn: bool = False) -> None:
        if good:
            self.ok += 1
        elif warn:
            self.warned.append(what)
        else:
            self.failed.append(what)


def read(root: Path, rel: str) -> str | None:
    try:
        return (root / rel).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def workspace_chain(root: Path, cwd: str) -> list[str]:
    """every CLAUDE.md from the root's child down to the cwd (the root's own is the base, not a workspace)"""
    parts = [] if cwd in ("", ".") else cwd.replace("\\", "/").strip("/").split("/")
    out, cur = [], ""
    for p in parts:
        cur = f"{cur}/{p}" if cur else p
        if (root / cur / "CLAUDE.md").is_file():
            out.append(f"{cur}/CLAUDE.md")
    return out


def workspace_cap(rel: str) -> int:
    return SCREEN_CAP if SCREEN_RE.match(rel) else WORKSPACE_CAPS.get(rel, WORKSPACE_CAP)


def resolve_ref(root: Path, ref: str) -> tuple[str | None, int]:
    """(problem or None, tokens) for a boot entry `path` or `path#slug`"""
    path, _, sl = ref.partition("#")
    text = read(root, path)
    if text is None:
        return f"{path} is not on disk", 0
    if not sl:
        return None, tokens(text)
    ch = next((c for c in chapters(text) if c.slug == sl), None)
    if ch is None:
        return f"{path} has no chapter #{sl}", 0
    return None, ch.tokens


def books(root: Path) -> list[str]:
    """every chapter book in the library: an app/library/**/*.md whose frontmatter names a `type:`"""
    lib = root / "app" / "library"
    out = []
    for p in sorted(lib.rglob("*.md")) if lib.is_dir() else []:
        if p.name == "_series.md" or any(s in SKIP_DIRS for s in p.parts):
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        if frontmatter(text).get("type"):
            out.append(p.relative_to(root).as_posix())
    return out


def claude_files(root: Path) -> list[str]:
    out = []
    for p in root.rglob("CLAUDE.md"):
        rel = p.relative_to(root)
        if any(s in SKIP_DIRS for s in rel.parts) or rel.parts[:2] == ("app", "library"):
            continue
        out.append(rel.as_posix())
    return sorted(out)


def ref_sources(root: Path) -> dict[str, list[str]]:
    """the files whose references to app/library this check reads: 'own' = the fund agent's (a dead ref
    FAILS), 'other' = another owner's (a dead path WARNS, a dead chapter still fails)"""
    def rel(p: Path) -> str:
        return p.relative_to(root).as_posix()

    def clean(paths) -> list[str]:
        return sorted({rel(p) for p in paths if not any(sk in rel(p).split("/") for sk in SKIP_DIRS)})

    lib = root / "app" / "library"
    own = [root / "CLAUDE.md", root / "README.md"]
    own += (root / ".claude" / "skills").glob("*/SKILL.md")
    own += (root / "app" / "agents").glob("*.md")
    own += [p for p in lib.rglob("*.md") if p.relative_to(lib).parts[0] != "dashboards"] if lib.is_dir() else []
    other = [root / f for f in claude_files(root)]
    other += (root / "platform" / "lab").rglob("*.md") if (root / "platform" / "lab").is_dir() else []
    other += (root / "platform").glob("*.md")
    other += (lib / "dashboards").rglob("*.md") if (lib / "dashboards").is_dir() else []
    own_set = set(clean(p for p in own if p.is_file()))
    return {"own": sorted(own_set), "other": [f for f in clean(p for p in other if p.is_file()) if f not in own_set]}


def audit(root: Path) -> Report:
    r = Report()
    base = read(root, "CLAUDE.md")
    r.check(base is not None and tokens(base) <= BASE_CAP,
            f"base: CLAUDE.md is {tokens(base or '')} tokens, cap {BASE_CAP}" if base is not None else "base: no CLAUDE.md at the root")
    seen_ws: set[str] = set()
    for a in _root.agents(root):
        aid = a["id"]
        if a.get("mode") == "dormant":
            continue
        raw = read(root, f"{_root.AGENTS_DIR}/{_root.agent_file_name(aid)}") or ""
        try:
            _, body = _root.parse_agent_file(raw)
        except _root.AgentFileError as e:
            r.check(False, f"agent {aid}: roster file does not parse ({e})")
            continue
        r.check(tokens(body) <= AGENT_CAP, f"agent {aid}: prompt is {tokens(body)} tokens, cap {AGENT_CAP}")
        total = 0
        for ref in a.get("boot") or []:
            problem, t = resolve_ref(root, ref)
            r.check(problem is None, f"agent {aid}: boot {ref}: {problem}")
            if "#" in ref:
                r.check(t <= CHAPTER_CAP, f"agent {aid}: boot {ref} is {t} tokens, chapter cap {CHAPTER_CAP}")
            total += t
        r.check(total <= BOOT_CAP, f"agent {aid}: boot list is {total} tokens, cap {BOOT_CAP}")
        for ws in workspace_chain(root, a.get("cwd") or "."):
            if ws in seen_ws:
                continue
            seen_ws.add(ws)
            t, cap = tokens(read(root, ws) or ""), workspace_cap(ws)
            r.check(t <= cap, f"workspace {ws} is {t} tokens, cap {cap}", warn=not WORKSPACE_FAILS)
    for b in books(root):
        text = read(root, b) or ""
        r.check(tokens(text) <= BOOK_CAP, f"book {b} is {tokens(text)} tokens, cap {BOOK_CAP}")
        r.check(tokens(text) <= BOOK_CAP * 0.9, f"book {b} is {tokens(text)} tokens, over 90% of its {BOOK_CAP} cap: split it before the next chapter lands", warn=True)
        chs = chapters(text)
        r.check(len(chs) > 0, f"book {b} has no `## ` chapter")
        slugs: set[str] = set()
        for c in chs:
            r.check(c.slug not in slugs, f"book {b}: two chapters slug to #{c.slug}")
            slugs.add(c.slug)
            r.check(c.read_when, f"book {b}#{c.slug}: the chapter does not open with `Read when:`")
            r.check(c.tokens <= CHAPTER_CAP, f"book {b}#{c.slug} is {c.tokens} tokens, cap {CHAPTER_CAP}")
            if c.tokens <= CHAPTER_CAP:
                r.check(c.tokens <= CHAPTER_TARGET, f"book {b}#{c.slug} is {c.tokens} tokens, target {CHAPTER_TARGET}", warn=True)
    # every reference to a library file, from every file this scan covers. Two severities: the fund
    # agent's own files (the base prompt, the README, the skills, the roster, the books) FAIL on any
    # dead ref; everything else (another repo's CLAUDE.md, a lab ledger, platform's docs) fails only on
    # a dead #chapter and WARNS on a dead path, because its owner repoints it under a board item.
    sources = ref_sources(root)
    r.check(len(sources["own"]) >= 1 and len(_root.agents(root)) >= 1,
            f"scan saw {len(sources['own'])} own files and {len(_root.agents(root))} agents: a check over nothing prints the same as a pass")
    for group, strict in (("own", True), ("other", False)):
        for f in sources[group]:
            for m in REF_RE.finditer(read(root, f) or ""):
                path, sl = m.group(1), (m.group(2) or "")[1:]
                if sl:
                    problem, _ = resolve_ref(root, f"{path}#{sl}")
                    r.check(problem is None, f"{f}: cites {path}#{sl}: {problem}")   # a dead #chapter fails for every owner
                else:
                    r.check((root / path).is_file(), f"{f}: cites {path}, which is not on disk", warn=not strict)
    return r


def table(root: Path) -> list[str]:
    base = tokens(read(root, "CLAUDE.md") or "")
    rows = [f"{'agent':<20}{'base':>7}{'workspace':>11}{'agent':>7}{'boot':>7}{'total':>8}"]
    for a in _root.agents(root):
        if a.get("mode") == "dormant":
            continue
        raw = read(root, f"{_root.AGENTS_DIR}/{_root.agent_file_name(a['id'])}") or ""
        try:
            _, body = _root.parse_agent_file(raw)
        except _root.AgentFileError:
            body = ""
        ws = sum(tokens(read(root, w) or "") for w in workspace_chain(root, a.get("cwd") or "."))
        boot = sum(resolve_ref(root, ref)[1] for ref in a.get("boot") or [])
        ag = tokens(body)
        rows.append(f"{a['id']:<20}{base:>7}{ws:>11}{ag:>7}{boot:>7}{base + ws + ag + boot:>8}")
    return rows


def record_pull(root: Path, path: str) -> None:
    """tell fundd an agent pulled this book, exactly as scripts/hooks/read-hook.mjs does for the Read tool:
    a best-effort POST that never fails the command (no FUND_AGENT = the owner's own session = nothing to record)"""
    agent = os.environ.get("FUND_AGENT")
    if not agent:
        return
    body = json.dumps({"agent": agent, "conversation": os.environ.get("FUND_CONVERSATION") or None, "path": path}).encode("utf-8")
    req = urllib.request.Request(f"http://127.0.0.1:{os.environ.get('FUNDD_PORT') or 4689}/api/library/read", data=body,
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            resp.read()
    except Exception:       # fundd down or slow: the pull is lost from the ledger, the agent is not
        pass


def show(root: Path, refs: list[str]) -> int:
    """print ONE chapter (path#slug) or a book's table of contents (path): a pull that costs a chapter, not a whole book"""
    bad = 0
    for ref in refs:
        path, _, sl = ref.partition("#")
        text = read(root, path)
        if text is None:
            print(f"DEAD  {ref}  {path} is not on disk")
            bad += 1
            continue
        chs = chapters(text)
        if not sl:
            print(f"# {path}  ({tokens(text)} tokens, {len(chs)} chapters)")
            for c in chs:
                when = re.search(r"^Read when:\s*(.+)$", c.text, re.M)
                print(f"- {path}#{c.slug}  ({c.tokens} tokens)  {when.group(1).strip() if when else ''}")
            record_pull(root, path)
            continue
        ch = next((c for c in chs if c.slug == sl), None)
        if ch is None:
            print(f"DEAD  {ref}  {path} has no chapter #{sl}; its chapters: " + ", ".join(c.slug for c in chs))
            bad += 1
            continue
        print(f"# {ref}  ({ch.tokens} tokens)\n")
        print(ch.text.rstrip("\n"))
        record_pull(root, path)
    return 1 if bad else 0


def main(argv: list[str]) -> int:
    root = _root.fund_root()
    if "--table" in argv:
        print("\n".join(table(root)))
        return 0
    if "--show" in argv:
        refs = [a for a in argv[argv.index("--show") + 1:] if not a.startswith("--")]
        if not refs:
            print("--show needs at least one path#slug (a bare path prints the book's table of contents)")
            return 2
        return show(root, refs)
    if "--ref" in argv:
        # verify refs BEFORE writing them anywhere (a boot list, a board note, a book): `--ref path#slug ...`
        refs = [a for a in argv[argv.index("--ref") + 1:] if not a.startswith("--")]
        if not refs:
            print("--ref needs at least one path#slug")
            return 2
        bad = 0
        for ref in refs:
            problem, t = resolve_ref(root, ref)
            bad += problem is not None
            print(f"{'DEAD' if problem else 'ok  '}  {ref}  {problem or f'{t} tokens'}")
        return 1 if bad else 0
    r = audit(root)
    for f in r.failed:
        print(f"FAIL  {f}")
    for w in r.warned:
        print(f"warn  {w}")
    print(f"{r.ok} ok, {len(r.failed)} failed, {len(r.warned)} warn")
    return 1 if r.failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
