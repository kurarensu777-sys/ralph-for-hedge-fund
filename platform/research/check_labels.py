"""check_labels - every study notebook carries its two Research-room labels.

The labels: MARKETS, one or more of crypto, equities, rates, predmkts (the main one first), and FORMAT,
exactly one of carry, directional, short_vol, rel_value, evidence. A study resolves them from its own
`fund.study/1` manifest (`profile.markets`, `format`) and, where the manifest lacks one, from
`research/labels.json`; the manifest wins. Two tags ride beside them: STYLE
(systematic or discretionary, typed, so a claim) may sit in a labels.json entry until the study is re-run, and
must equal the manifest's `tags.style` once both exist; PACE is read off the metrics, not here.
The book is `app/library/research/research.md` ("Manifest and labels", "Naming"). Faults, each named:

  resolve   every studies/*.ipynb (not a leading-underscore file) resolves >= 1 market and 1 format
  markets   a non-empty list from the closed four, no repeats
  format    one string from the closed five, which must equal the cockpit's FORMATS keys (app/shared/research.ts)
  style     a labels.json style or a manifest tags.style is one of STYLES, which must equal the cockpit's STYLES
  agree     where the manifest and labels.json both carry a label (or a style), they are equal (order included)
  main      a manifest whose profile.market is one of the four has it as markets[0]
  entry     a labels.json key is studies/<file>.ipynb, exists, is not the template, holds
            {markets, format} and at most a style beside them

No `studies/` folder is the empty case: 0 studies, and labels.json may hold only its `$comment`. Reads JSON and
the cockpit's research.ts only, runs nothing. Exit 0 clean, 1 on any fault. From `platform`:

    ..\\.venv\\Scripts\\python research\\check_labels.py              every study
    ..\\.venv\\Scripts\\python research\\check_labels.py --selftest   plant every fault once
"""

from __future__ import annotations

import copy
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LABELS = ROOT / "labels.json"
MARKETS = ("crypto", "equities", "rates", "predmkts")
FORMATS = ("carry", "directional", "short_vol", "rel_value", "evidence")
STYLES = ("systematic", "discretionary")
MIME = "application/vnd.fund.study+json"
COCKPIT = ROOT.parents[1] / "app" / "shared" / "research.ts"


def cockpit_sets(path: Path = COCKPIT) -> tuple[tuple, tuple] | None:
    """(FORMATS keys, STYLES) as the cockpit's research.ts declares them, or None when the file is absent.
    A file that is present but whose two declarations cannot be read is a fault, never a skip."""
    if not path.is_file():
        return None
    ts = path.read_text(encoding="utf-8")
    m = re.search(r"^export const FORMATS = \{\n(.*?)^\}", ts, re.M | re.S)
    s = re.search(r"^export const STYLES = \[([^\]]*)\]", ts, re.M)
    if not m or not s:
        raise SystemExit(f"check_labels: cannot read FORMATS and STYLES from {path}")
    return tuple(re.findall(r"^  (\w+): \{", m.group(1), re.M)), tuple(re.findall(r"'([^']+)'", s.group(1)))


def manifest(nb: dict) -> dict | None:
    for c in nb.get("cells", []):
        for o in c.get("outputs", []) or []:
            m = (o.get("data") or {}).get(MIME)
            if isinstance(m, dict):
                return m
    return None


def faults(labels: dict, studies: dict, formats=FORMATS, cockpit=None) -> list[str]:
    """labels: labels.json as read; studies: {"studies/<file>.ipynb": its manifest or None}; cockpit: cockpit_sets()."""
    f = []
    if cockpit is not None:
        if set(formats) != set(cockpit[0]):
            f.append(f"format: the closed list {sorted(formats)} is not the cockpit's FORMATS {sorted(cockpit[0])}")
        if set(STYLES) != set(cockpit[1]):
            f.append(f"style: the closed list {sorted(STYLES)} is not the cockpit's STYLES {sorted(cockpit[1])}")
    for rel, v in labels.items():
        if rel.startswith("$"):
            continue
        name = rel.rsplit("/", 1)[-1]
        if not (rel.startswith("studies/") and rel.endswith(".ipynb") and rel.count("/") == 1) or name.startswith("_"):
            f.append(f"entry: {rel!r} is not studies/<file>.ipynb of a study")
        elif rel not in studies:
            f.append(f"entry: {rel} names no notebook; take it off labels.json")
        if not (isinstance(v, dict) and {"markets", "format"} <= set(v) <= {"markets", "format", "style"}):
            f.append(f"entry: {rel} must hold {{markets, format}} and at most a style")
        elif "style" in v and v["style"] not in STYLES:
            f.append(f"style: {rel} labels.json style {v['style']!r} is not one of {'|'.join(STYLES)}")
    for rel, m in sorted(studies.items()):
        lab = labels.get(rel) if isinstance(labels.get(rel), dict) else {}
        pr = (m or {}).get("profile") if isinstance((m or {}).get("profile"), dict) else {}
        mk_m, fm_m = pr.get("markets"), (m or {}).get("format")
        mk_l, fm_l = lab.get("markets"), lab.get("format")
        mk = mk_m if mk_m is not None else mk_l
        fm = fm_m if fm_m is not None else fm_l
        if mk is None or fm is None:
            f.append(f"resolve: {rel} has no {'markets' if mk is None else 'format'} in its manifest or labels.json")
        if mk is not None:
            if not (isinstance(mk, list) and mk and all(isinstance(x, str) for x in mk)):
                f.append(f"markets: {rel} markets {mk!r} is not a non-empty list")
            else:
                bad = [x for x in mk if x not in MARKETS]
                if bad:
                    f.append(f"markets: {rel} {bad} not in {'|'.join(MARKETS)}")
                if len(set(mk)) != len(mk):
                    f.append(f"markets: {rel} repeats a market {mk}")
                if pr.get("market") in MARKETS and mk[0] != pr["market"]:
                    f.append(f"main: {rel} profile.market {pr['market']!r} is not markets[0] {mk[0]!r}")
        if fm is not None and not (isinstance(fm, str) and fm in formats):
            f.append(f"format: {rel} format {fm!r} is not one of {'|'.join(formats)}")
        tg = (m or {}).get("tags") if isinstance((m or {}).get("tags"), dict) else {}
        st_m, st_l = tg.get("style"), lab.get("style")
        if st_m is not None and st_m not in STYLES:
            f.append(f"style: {rel} manifest tags.style {st_m!r} is not one of {'|'.join(STYLES)}")
        if st_m is not None and st_l is not None and st_m != st_l:
            f.append(f"agree: {rel} manifest tags.style {st_m!r} vs labels.json {st_l!r}")
        if mk_m is not None and mk_l is not None and mk_m != mk_l:
            f.append(f"agree: {rel} manifest markets {mk_m} vs labels.json {mk_l}")
        if fm_m is not None and fm_l is not None and fm_m != fm_l:
            f.append(f"agree: {rel} manifest format {fm_m!r} vs labels.json {fm_l!r}")
    return f


def read(root: Path = ROOT) -> tuple[dict, dict]:
    labels = json.loads((root / "labels.json").read_text(encoding="utf-8"))
    studies = {}
    for p in sorted((root / "studies").glob("*.ipynb")):
        if not p.name.startswith("_"):
            studies[f"studies/{p.name}"] = manifest(json.loads(p.read_text(encoding="utf-8")))
    return labels, studies


def _plants():
    """(rule, how it is broken) - each applied to a clean fixture must raise a fault naming its rule."""
    def set_(rel, k, v):
        def g(lab, st):
            lab[rel][k] = v
        return g

    def man(rel, **kv):
        def g(lab, st):
            m = st[rel]
            for k, v in kv.items():
                if k == "markets":
                    m["profile"]["markets"] = v
                elif k == "market":
                    m["profile"]["market"] = v
                else:
                    m[k] = v
        return g

    def drop(rel):
        return lambda lab, st: lab.pop(rel)

    def stale(lab, st):
        lab["studies/gone.ipynb"] = {"markets": ["crypto"], "format": "carry"}

    def template(lab, st):
        lab["studies/_template-study.ipynb"] = {"markets": ["crypto"], "format": "carry"}

    def extra_key(lab, st):
        lab["studies/b.ipynb"]["market"] = "crypto"

    def tag(rel, **kv):
        def g(lab, st):
            st[rel]["tags"] = kv
        return g

    return [
        ("resolve", "a study with no labels.json entry and no manifest", drop("studies/b.ipynb")),
        ("resolve", "a manifest with markets but no format, no entry", lambda lab, st: (lab.pop("studies/a.ipynb"), st["studies/a.ipynb"].pop("format"))),
        ("markets", "an empty market list", set_("studies/b.ipynb", "markets", [])),
        ("markets", "a retired label (xasset)", set_("studies/b.ipynb", "markets", ["xasset"])),
        ("markets", "a retired label (vol)", set_("studies/b.ipynb", "markets", ["crypto", "vol"])),
        ("markets", "a repeated market", set_("studies/b.ipynb", "markets", ["rates", "rates"])),
        ("markets", "markets a string", set_("studies/b.ipynb", "markets", "crypto")),
        ("format", "two formats", set_("studies/b.ipynb", "format", ["carry", "evidence"])),
        ("format", "a format off the list", set_("studies/b.ipynb", "format", "arb")),
        ("format", "the retired mft format", set_("studies/b.ipynb", "format", "mft")),
        ("style", "a labels.json style off the list", set_("studies/b.ipynb", "style", "manual")),
        ("style", "a manifest tags.style off the list", tag("studies/c.ipynb", style="manual", pace="hold")),
        ("agree", "manifest tags.style vs labels.json style", tag("studies/a.ipynb", style="discretionary")),
        ("agree", "manifest markets vs labels.json", man("studies/a.ipynb", markets=["equities", "crypto"])),
        ("agree", "manifest format vs labels.json", man("studies/a.ipynb", format="evidence")),
        ("main", "profile.market not markets[0]", man("studies/a.ipynb", market="crypto")),
        ("entry", "an entry naming no notebook", stale),
        ("entry", "an entry for the template", template),
        ("entry", "an entry with a third key", extra_key),
    ]


def _fixture():
    labels = {"$comment": "x",
              "studies/a.ipynb": {"markets": ["equities"], "format": "carry", "style": "systematic"},
              "studies/b.ipynb": {"markets": ["predmkts", "rates"], "format": "evidence"}}
    studies = {"studies/a.ipynb": {"format": "carry", "tags": {"style": "systematic"}, "profile": {"market": "equities", "markets": ["equities"]}},
               "studies/b.ipynb": None,
               "studies/c.ipynb": {"format": "short_vol", "profile": {"market": "xasset", "markets": ["rates"]}}}
    return labels, studies


def selftest() -> int:
    bad = 0
    lab, st = _fixture()
    base = faults(lab, st)
    if base:
        print(f"selftest: the clean fixture faults: {base}")
        bad += 1
    if not faults(lab, st, formats=FORMATS[:-1], cockpit=(FORMATS, STYLES)):
        print("selftest: a closed format list off the cockpit's FORMATS did not fault")
        bad += 1
    if faults(lab, st, cockpit=(FORMATS, STYLES)):
        print("selftest: the clean fixture faults against matching cockpit sets")
        bad += 1
    for rule, what, plant in _plants():
        lab, st = copy.deepcopy(_fixture())
        plant(lab, st)
        got = faults(lab, st)
        if not any(x.startswith(rule + ":") for x in got):
            print(f"selftest: planted '{what}' raised no {rule} fault (got {got})")
            bad += 1
    n = len(_plants()) + 3
    print(f"check_labels selftest: {n - bad}/{n} planted faults caught" + ("" if bad else ", clean fixture clean"))
    return 1 if bad else 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--selftest"]:
        return selftest()
    labels, studies = read()
    cockpit = cockpit_sets()
    f = faults(labels, studies, cockpit=cockpit)
    for x in f:
        print(x)
    from_m = sum(1 for m in studies.values() if isinstance((m or {}).get("profile"), dict) and "markets" in m["profile"])
    print(f"check_labels: {len(studies)} studies, {len(f)} fault(s); markets from a manifest in {from_m}, "
          f"from labels.json in {len(studies) - from_m}"
          + ("" if cockpit else "; app/shared/research.ts absent, closed sets not cross-checked"))
    return 1 if f else 0


if __name__ == "__main__":
    sys.exit(main())
