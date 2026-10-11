"""check_charts - the chart bank holds one framework chapter per chart type, with code that parses.

The bank is `app/library/research/charts.md` (the guide) plus `charts-<family>.md` (describe, test, trade): one
`## <Type>` chapter per TYPE of chart, never a gallery, read as one text (guide first, then the families by name).
A manifest figure names its type in `figures[].kind` (the chapter's heading slug); an older notebook has none
until its next re-run. The guide is `charts.md` ("How the bank works"). Faults, each named:

  types      the chapter headings are exactly the closed TYPES, each once
  shape      a chapter has Question, Inputs, How to draw, How to read it, Pairs with, Exemplar and Code
  category   a chapter has one `Category:` line, one of the eight in CATEGORIES, and the guide's table row says the same
  question   the Question line is a question (figstyle.INTERROGATIVE, ends in ?)
  code       the Code block is a python fence that parses and defines a `draw_` function
  exemplar   `none yet`, or one real study stem and a figure id that its manifest lists; the study may be live
             (`studies/`) or archived (`archive/`), and a stem in neither faults
  home       no study stem is in both `studies/` and `archive/` (one would hide the other)
  repeat     no figure is the exemplar of two types
  kind       a manifest figure's `kind`, where it has one, is a chapter slug (a folded type names its survivor)
  run        each chapter's `draw_` function RUNS on a tiny synthetic input (`chart_smoke.SMOKE`, one case or more per type), returns a
             figure and passes `figstyle.check`; a type with no smoke input is a fault. `--no-run` skips this half

A tree with no study notebooks (no `studies/`, no `archive/`) is the empty case: every chapter must then say
`none yet`, and the count line says 0 studies read. Reads text and JSON, then runs the chapters' code. Exit 0 clean,
1 on any fault. From `platform`:

    ..\\.venv\\Scripts\\python research\\check_charts.py              the book and every study, live and archived
    ..\\.venv\\Scripts\\python research\\check_charts.py --selftest   plant every fault once
"""

from __future__ import annotations

import os

os.environ.setdefault("MPLBACKEND", "Agg")      # the smoke run draws figures and shows none

import ast
import copy
import json
import re
import sys
import tempfile
from pathlib import Path

from fundplat.quant.core import figstyle

ROOT = Path(__file__).resolve().parent
SHELF = ROOT.parents[1] / "app" / "library" / "research"
BOOK = SHELF / "charts.md"
TYPES = (
    "Series and distribution", "Win/loss distribution", "Equity curve", "Drawdown and tail", "Signal decay", "Calibration",
    "Out-of-sample test", "Significance test", "Cost sensitivity", "Rule comparison", "Regime and concentration",
    "Hedge and basis", "Sizing and fill", "Scenario payoff", "Sample size and power", "Capacity curve",
    "Monte Carlo and ruin", "Rolling statistics", "Parameter surface", "Fund-book correlation", "Factor regression",
    "Sample funnel and coverage", "Autocorrelation", "Signal and outcome scatter", "Clock and staleness", "Stress windows",
    "Trade anatomy", "MAE/MFE", "Profit and loss attribution", "Exit-reason breakdown", "Payoff diagram", "Live candidates",
    "Exposure over time", "Book depth over time", "Premium over realized", "Gap persistence",
    "Trading calendar", "Cash and headroom by account", "Quality by category", "Cross-venue gap",
    "Entry map", "Lead and lag", "Steadiness", "Distribution against model", "Leak probe", "Selection check", "Entry-time sensitivity",
    "Attribution over time", "Rebalance path", "Adverse selection", "Edge by slice",
)
CATEGORIES = ("The run", "The edge", "The luck", "The choice", "The trade", "Size and cost", "The book", "The data")
FOLDED = {"rolling-win-rate": "rolling-statistics", "per-trade-pnl-over-time": "equity-curve", "path-fan": "monte-carlo-and-ruin",
          "assumption-sensitivity": "parameter-surface", "trade-marks": "trade-anatomy"}      # folded types: the survivor draws them
FIELDS = ("Question", "Inputs", "How to draw", "How to read it", "Pairs with", "Exemplar", "Code")
NOT_A_TYPE = ("How the bank works", "The types")
HOMES = ("studies", "archive")      # where a study's notebook may live: live, or archived
MIME = "application/vnd.fund.study+json"   # the output type a study's `fund.study/1` manifest is displayed under


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def chapters(text: str) -> tuple[dict[str, str], list[str]]:
    """{heading: body} for every `## ` chapter that is not the how-it-works one, and the headings in order (repeats kept)."""
    out, order, cur = {}, [], None
    for line in text.splitlines():
        if line.startswith("## "):
            cur = line[3:].strip()
            if cur in NOT_A_TYPE:
                cur = None
                continue
            order.append(cur)
            out[cur] = ""
        elif cur is not None:
            out[cur] += line + "\n"
    return out, order


def field(body: str, name: str) -> str | None:
    m = re.search(rf"^- \*\*{re.escape(name)}:\*\*[ \t]*(.*)$", body, re.M)
    return None if m is None else m.group(1).strip()


def code_of(body: str) -> str | None:
    m = re.search(r"```python\n(.*?)\n```", body, re.S)
    return None if m is None else m.group(1)


def faults(text: str, manifests: dict[str, dict | None], types=TYPES) -> list[str]:
    """text: the book; manifests: {study stem: its manifest or None}."""
    f = []
    chs, order = chapters(text)
    for t in types:
        if order.count(t) != 1:
            f.append(f"types: '{t}' appears {order.count(t)} times in the book (want 1)")
    for h in order:
        if h not in types:
            f.append(f"types: '{h}' is a chapter but not a chart type in TYPES")
    used: dict[tuple[str, str], str] = {}
    table = guide_categories(text)
    for h, body in chs.items():
        for name in FIELDS:
            if field(body, name) is None:
                f.append(f"shape: '{h}' has no '{name}' line")
        cats = re.findall(r"(?m)^Category: (.+)$", body.split("```")[0])
        if len(cats) != 1 or cats[0] not in CATEGORIES:
            f.append(f"category: '{h}' needs exactly one 'Category:' line naming one of the {len(CATEGORIES)} categories, it has {cats}")
        elif table is not None and table.get(h) != cats[0]:
            f.append(f"category: '{h}' is '{cats[0]}' in its chapter and '{table.get(h)}' in the guide's table")
        q = (field(body, "Question") or "").strip("`") or None
        if q is not None and not (q.endswith("?") and q.split(" ", 1)[0] in figstyle.INTERROGATIVE):
            f.append(f"question: '{h}' Question is not a question: {q!r}")
        code = code_of(body)
        if code is None:
            f.append(f"code: '{h}' has no python code block")
        else:
            try:
                tree = ast.parse(code)
            except SyntaxError as e:
                f.append(f"code: '{h}' code does not parse: {e.msg} (line {e.lineno})")
            else:
                if not any(isinstance(n, ast.FunctionDef) and n.name.startswith("draw_") for n in ast.walk(tree)):
                    f.append(f"code: '{h}' defines no draw_ function")
        ex = field(body, "Exemplar")
        if ex is None or re.fullmatch(r"`?none yet`?", ex.split("(")[0].strip()):
            continue
        m = re.match(r"`([^`]+)`\s+`(fig:s\d-[\w-]+)`", ex)
        if not m:
            f.append(f"exemplar: '{h}' Exemplar is neither `none yet` nor `study` `fig:id`: {ex!r}")
            continue
        stem, fid = m.groups()
        man = manifests.get(stem)
        if man is None:
            f.append(f"exemplar: '{h}' names study '{stem}' which has no manifest")
        elif fid not in [g.get("id") for g in man.get("figures", [])]:
            f.append(f"exemplar: '{h}' names {fid} which '{stem}' does not list")
        if (stem, fid) in used:
            f.append(f"repeat: {stem} {fid} is the exemplar of both '{used[(stem, fid)]}' and '{h}'")
        used[(stem, fid)] = h
    slugs = {slug(t) for t in types}
    for stem, man in manifests.items():
        for g in (man or {}).get("figures", []):
            if "kind" in g and g["kind"] not in slugs:
                to = FOLDED.get(g["kind"])
                f.append(f"kind: {stem} {g.get('id')} has kind '{g['kind']}', not a chapter slug" + (f" (folded into '{to}': re-tag at the study's next re-run)" if to else ""))
    return f


def guide_categories(text: str) -> dict[str, str] | None:
    """{type: category} from the guide's types table (| Type | Kind id | Category | Book | Exemplar |), or None when the text has no such table."""
    m = re.search(r"(?m)^\| Type \| Kind id \| Category \|.*$", text)
    if m is None:
        return None
    out = {}
    for line in text[m.end():].splitlines()[2:]:
        if not line.startswith("|"):
            break
        c = [x.strip() for x in line.strip("|").split("|")]
        out[c[0]] = c[2]
    return out


def smoke_faults(text: str, smoke=None, types=TYPES) -> list[str]:
    """RUN each chapter's `draw_` function on its synthetic input (`chart_smoke.SMOKE`) and put the figure through `figstyle.check`.

    A parse cannot see a function that raises on a one-cell grid or unpacks the wrong shape; a run can. A type with no
    smoke input is itself a fault, so a new chapter cannot skip the run."""
    import matplotlib.pyplot as plt

    if smoke is None:
        sys.path.insert(0, str(ROOT))
        from chart_smoke import SMOKE as smoke
    from chart_smoke import style
    f = []
    chs, _ = chapters(text)
    plt.rcParams.update(style())
    for h, body in chs.items():
        code = code_of(body)
        if code is None or h not in types:
            continue                                  # `faults` already names a chapter without code
        cases = smoke.get(slug(h))
        if not cases:
            f.append(f"run: '{h}' has no smoke input in chart_smoke.SMOKE")
            continue
        ns = {"__name__": "chart_bank_chapter"}
        try:
            exec(compile(code, f"<{slug(h)}>", "exec"), ns)
        except Exception as e:                        # an import that fails is a chapter that cannot run
            f.append(f"run: '{h}' code does not load: {type(e).__name__}: {e}")
            continue
        fns = [v for k, v in ns.items() if k.startswith("draw_") and callable(v)]
        if not fns:
            continue
        for case, make in cases:
            fig = None
            try:
                fig = fns[0](**make())
                if not hasattr(fig, "savefig"):
                    f.append(f"run: '{h}' ({case}) returned {type(fig).__name__}, not a figure")
                    continue
                fig.canvas.draw()                     # layout and text errors raise on draw, not on call
                figstyle.check(fig, name=f"{h} ({case})")
            except AssertionError as e:
                f.append(f"run: '{h}' ({case}) breaks the figure rules: " + " | ".join(l.strip(" -") for l in str(e).splitlines()[1:]))
            except Exception as e:
                f.append(f"run: '{h}' ({case}) raised {type(e).__name__}: {e}")
            finally:
                plt.close("all")
    return f


def book_text(shelf: Path = SHELF) -> str:
    """The guide `charts.md` first, then every `charts-<family>.md` by name, joined into the one text `faults` takes."""
    paths = [p for p in (shelf / "charts.md",) if p.exists()]
    paths += sorted(shelf.glob("charts-*.md"), key=lambda p: p.name)
    return "\n".join(p.read_text(encoding="utf-8") for p in paths)


def manifests(root: Path = ROOT, homes=HOMES) -> tuple[dict[str, dict | None], list[str]]:
    """{study stem: its manifest or None} over every `<home>/*.ipynb` (not a leading-underscore file), and a `home`
    fault for each stem found in two homes."""
    ms: dict[str, dict | None] = {}
    where: dict[str, str] = {}
    f = []
    for home in homes:
        for p in sorted((root / home).glob("*.ipynb")):
            if p.name.startswith("_"):
                continue
            if p.stem in where:
                f.append(f"home: {p.stem} is in both {where[p.stem]}/ and {home}/")
                continue
            nb = json.loads(p.read_text(encoding="utf-8"))
            m = None
            for c in nb.get("cells", []):
                for o in c.get("outputs", []) or []:
                    d = (o.get("data") or {}).get(MIME)
                    if isinstance(d, dict):
                        m = d
            ms[p.stem], where[p.stem] = m, home
    return ms, f


def read() -> tuple[str, dict[str, dict | None], list[str]]:
    ms, f = manifests()
    return book_text(), ms, f


def _fixture():
    ch = []
    for i, t in enumerate(TYPES):
        ex = "`none yet`" if i else "`s1` `fig:s2-a`"
        ch.append(f"## {t}\n\nRead when: x.\n\nCategory: {CATEGORIES[i % len(CATEGORIES)]}\n\n- **Question:** How does it look?\n- **Inputs:** x\n- **How to draw:** x\n"
                  f"- **How to read it:** x\n- **Pairs with:** none\n- **Exemplar:** {ex}\n- **Code:**\n\n"
                  f"```python\ndef draw_{slug(t).replace('-', '_')}(x):\n    return x\n```\n")
    tab = "| Type | Kind id | Category | Book | Exemplar |\n|---|---|---|---|---|\n" + "".join(f"| {t} | `{slug(t)}` | {CATEGORIES[i % len(CATEGORIES)]} | `charts-x.md` | none yet |\n" for i, t in enumerate(TYPES))
    text = "# The chart bank\n\n## How the bank works\n\nx\n\n## The types\n\nx\n\n" + tab + "\n" + "\n".join(ch)
    man = {"s1": {"figures": [{"id": "fig:s2-a", "section": "S2", "kind": slug(TYPES[0])}, {"id": "fig:s2-b", "section": "S2"}]}}
    return text, man


def _plants():
    def sub(a, b):
        return lambda tx, m: (tx.replace(a, b, 1), m)

    return [
        ("types", "a chapter dropped", lambda tx, m: (tx.replace(f"## {TYPES[3]}\n", "", 1), m)),
        ("types", "an extra chapter", lambda tx, m: (tx + "\n## A gallery\n\nx\n", m)),
        ("shape", "no Inputs line", sub("- **Inputs:** x\n", "", )),
        ("question", "a title that is a statement", sub("How does it look?", "It looks fine.")),
        ("code", "code that does not parse", sub("def draw_series_and_distribution(x):", "def draw_series_and_distribution(x:")),
        ("code", "no draw_ function", sub("def draw_series_and_distribution(x):", "def plot(x):")),
        ("exemplar", "a study with no manifest", sub("`s1` `fig:s2-a`", "`nope` `fig:s2-a`")),
        ("exemplar", "a figure the study does not list", sub("`s1` `fig:s2-a`", "`s1` `fig:s9-z`")),
        ("repeat", "one figure the exemplar of two types", lambda tx, m: (tx.replace("- **Exemplar:** `none yet`", "- **Exemplar:** `s1` `fig:s2-a`", 1), m)),
        ("category", "a chapter with no Category line", sub("Category: The run\n\n", "")),
        ("category", "a category outside the eight", sub("Category: The run", "Category: The weather")),
        ("category", "a chapter and the guide's table disagree", sub("| The run | `charts-x.md`", "| The edge | `charts-x.md`")),
        ("kind", "a manifest kind that is no chapter", lambda tx, m: (tx, {"s1": {"figures": [{"id": "fig:s2-a", "kind": "luck"}]}})),
    ]


def _split_selftest(tx: str, man: dict) -> int:
    """The fixture split over a guide and three family files, read by `book_text`: whole is clean, a type missing from the families faults."""
    guide, _, rest = tx.partition("## " + TYPES[0])
    parts = [p for p in re.split(r"(?m)^(?=## )", "## " + TYPES[0] + rest) if p]
    fams = {"describe": parts[0:7], "test": parts[7:14], "trade": parts[14:]}
    bad = 0
    for what, drop in (("clean split", None), ("a type missing from the family books", TYPES[10])):
        with tempfile.TemporaryDirectory() as d:
            shelf = Path(d)
            (shelf / "charts.md").write_text(guide, encoding="utf-8")
            for fam in reversed(list(fams)):
                body = "\n".join(c for c in fams[fam] if drop is None or not c.startswith(f"## {drop}\n"))
                (shelf / f"charts-{fam}.md").write_text(f"# {fam}\n\n" + body, encoding="utf-8")
            got = faults(book_text(shelf), man)
        ok = (not got) if drop is None else any(x.startswith("types:") and drop in x for x in got)
        if not ok:
            print(f"selftest: {what} read through book_text: {got}")
            bad += 1
    return bad


def _homes_selftest(tx: str) -> int:
    """Study notebooks written to a scratch root and read by `manifests`: an exemplar naming an archived stem passes,
    a stem in neither home faults, a stem in both homes faults, and with archive/ cut from the homes the archived
    exemplar faults (so the pass above comes from reading archive/)."""
    def nb(fid):
        man = {"figures": [{"id": fid, "section": "S2"}]}
        return json.dumps({"cells": [{"cell_type": "code", "outputs": [{"output_type": "display_data", "data": {MIME: man}}]}]})

    arch = tx.replace("`s1` `fig:s2-a`", "`s2` `fig:s2-b`", 1)
    cases = [("an exemplar naming an archived study", arch, {}, HOMES, None),
             ("an exemplar naming a stem in neither folder", tx.replace("`s1` `fig:s2-a`", "`gone` `fig:s2-a`", 1), {}, HOMES, "exemplar:"),
             ("a stem in both studies/ and archive/", tx, {"archive/s1.ipynb": "fig:s2-a"}, HOMES, "home:"),
             ("archive/ not read", arch, {}, ("studies",), "exemplar:")]
    bad = 0
    for what, text, extra, homes, want in cases:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            files = {"studies/s1.ipynb": "fig:s2-a", "archive/s2.ipynb": "fig:s2-b", "studies/_template.ipynb": "fig:s9-z", **extra}
            for rel, fid in files.items():
                (root / rel).parent.mkdir(exist_ok=True)
                (root / rel).write_text(nb(fid), encoding="utf-8")
            ms, hf = manifests(root, homes)
            got = hf + faults(text, ms)
        ok = (not got) if want is None else any(x.startswith(want) for x in got)
        if not ok:
            print(f"selftest: homes, '{what}': wanted {want or 'no fault'}, got {got}")
            bad += 1
    return bad


def _smoke_selftest() -> int:
    """A one-chapter book run through `smoke_faults`: the clean one passes, each planted failure of the run is named."""
    good = ("import matplotlib.pyplot as plt\n\n\ndef draw_alpha(n=3, question='How does it look?'):\n    fig, ax = plt.subplots()\n"
            "    ax.set_title(question, loc='left'); ax.text(0.5, 0.5, '12h')\n    return fig")
    plants = [("clean", good, {"alpha": [("c", dict)]}, False),
              ("a draw_ that raises on one input", good.replace("    fig, ax", "    assert n > 5, 'one cell'\n    fig, ax"), {"alpha": [("c", dict)]}, True),
              ("an input the function does not take", good, {"alpha": [("c", lambda: dict(rows=1))]}, True),
              ("a draw_ that returns no figure", good.replace("    return fig", "    return None"), {"alpha": [("c", dict)]}, True),
              ("a figure that breaks the rules", good.replace("'How does it look?'", "'It looks fine.'"), {"alpha": [("c", dict)]}, True),
              ("a type with no smoke input", good, {}, True)]
    bad = 0
    for what, code, smoke, want in plants:
        got = smoke_faults("## Alpha\n\n```python\n" + code + "\n```\n", smoke=smoke, types=("Alpha",))
        if bool(got) != want or any(not x.startswith("run:") for x in got):
            print(f"selftest: run half, '{what}': wanted {'a fault' if want else 'none'}, got {got}")
            bad += 1
    return bad


def selftest() -> int:
    bad = 0
    tx, man = _fixture()
    base = faults(tx, man)
    if base:
        print(f"selftest: the clean fixture faults: {base}")
        bad += 1
    for rule, what, plant in _plants():
        t2, m2 = plant(*copy.deepcopy((tx, man)))
        got = faults(t2, m2)
        if not any(x.startswith(rule + ":") for x in got):
            print(f"selftest: planted '{what}' raised no {rule} fault (got {got})")
            bad += 1
    n = len(_plants()) + 1
    n, bad = n + 2, bad + _split_selftest(tx, man)
    n, bad = n + 4, bad + _homes_selftest(tx)
    n, bad = n + 6, bad + _smoke_selftest()
    print(f"check_charts selftest: {n - bad}/{n} planted faults caught" + ("" if bad else ", clean fixture clean"))
    return 1 if bad else 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--selftest" in argv:
        return selftest()
    text, ms, f = read()
    if not text:
        print(f"check_charts: no charts*.md under {SHELF}")
        return 1
    f += faults(text, ms)
    if "--no-run" not in argv:
        f += smoke_faults(text)
    for x in f:
        print(x)
    chs, _ = chapters(text)
    open_ = [h for h, b in chs.items() if (field(b, "Exemplar") or "").strip("` ").startswith("none yet")]
    print(f"check_charts: {len(chs)} chart types, {len(f)} fault(s); {len(open_)} not drawn yet; {len(ms)} studies read ({HOMES[0]}/ and {HOMES[1]}/)")
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
