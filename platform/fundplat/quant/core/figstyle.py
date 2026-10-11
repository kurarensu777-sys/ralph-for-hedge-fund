"""fundplat.quant.core.figstyle - the one figure palette, the line, table and bullet helpers, and the check that stops a render which breaks the figure rules.

The rules are the research book's chapter "Figures: one meaning per colour" (app/library/research/research.md). A notebook cell imports this and holds no
layout logic. Pure: matplotlib only, no data, no venue. `python -m fundplat.quant.core.figstyle --selftest` plants each fault once and must see it caught."""
import re
import sys

import matplotlib
import matplotlib.table
import matplotlib.text
from matplotlib.colors import to_hex, to_rgb, to_rgba

# ---- the palette: ONE meaning per colour ----
IDENTITY = {"LEG_A": "#eda100", "LEG_B": "#2a78d6",                   # a leg or an instrument: amber, blue. Nothing else is ever amber or blue.
            "ASSET_1": "#bf7f69", "ASSET_2": "#8518f2", "ASSET_3": "#8cbf4d", "ASSET_4": "#732e62",   # an asset: clay, violet, lime, plum
            "SOURCE_A": "#395909", "MODEL": "#f23df2", "SOURCE_B": "#35c4d0"}                # a source in a model-versus-market chart: olive, magenta, cyan
QUANTITY = {"funding": "#4a3aa7", "basis": "#e87ba4", "basis_dark": "#b23a6b", "fees": "#898781"}      # what a P&L component or a rate IS
VERDICT = {"good": "#0ca30c", "bad": "#d03b3b"}                       # sign and pass/fail ONLY: gain, above the hurdle, PASS / loss, below, under water, FAIL
NEUTRAL = {"ink": "#0b0b0b", "ink2": "#52514e", "muted": "#898781", "grid": "#e1e0d9", "axis": "#c3c2b7", "surface": "#fcfcfb"}
TABLE = {"header": "#f1f0ea", "gold": "#fbefc8", "rose": "#f7dcdc", "green": "#dcf1dc"}               # gold = the number that carries the finding, rose = worst or skewed, green = favourable
ALLOWED = {h.lower() for d in (IDENTITY, QUANTITY, VERDICT, NEUTRAL, TABLE) for h in d.values()} | {"#000000", "#ffffff"}

# the notebook's own names for the same colours (cell 8 defines them; a render script overwrites them from here so there is ONE source)
NAMES = dict(INK=NEUTRAL["ink"], INK2=NEUTRAL["ink2"], MUTED=NEUTRAL["muted"], GRID=NEUTRAL["grid"], AXIS=NEUTRAL["axis"], SURF=NEUTRAL["surface"],
             GOOD=VERDICT["good"], CRIT=VERDICT["bad"], C_A=IDENTITY["LEG_A"], C_B=IDENTITY["LEG_B"], C_NET=QUANTITY["funding"], C_PREM=QUANTITY["basis"],
             C_PREM_DK=QUANTITY["basis_dark"], C_COST=QUANTITY["fees"], S1=IDENTITY["LEG_B"], S4=IDENTITY["LEG_A"], S5=QUANTITY["basis"], S7=QUANTITY["funding"])

# ---- reference lines: the series' own colour, faint, a style per statistic ----
LS = {"mean": (0, (5, 4)), "median": (0, (1, 2.4)), "max": (0, (7, 2.5, 1.2, 2.5)), "min": (0, (2, 2, 6, 2))}
INTERROGATIVE = ("What", "Which", "How", "Is", "Are", "Did", "Does", "Do", "Where", "Why", "Can", "Was", "Were", "Should")


def stat_lines(ax, s, col, with_min=False, with_max=True):
    """Faint mean / median / max (and min) lines for one plotted series. Returns the numbers, for the legend."""
    s = s.dropna()
    v = {"mean": float(s.mean()), "median": float(s.median())}
    if with_max:
        v["max"] = float(s.max())
    if with_min:
        v["min"] = float(s.min())
    for k, y in v.items():
        ax.axhline(y, color=col, linewidth=0.95, linestyle=LS[k], alpha=0.5, zorder=2)
    return v


def tag(name, v, d=1):
    """The legend text that carries a series' numbers."""
    parts = [f"mean {v['mean']:+,.{d}f}", f"median {v['median']:+,.{d}f}"] + [f"{k} {v[k]:+,.{d}f}" for k in ("max", "min") if k in v]
    return f"{name}:  " + "  ·  ".join(parts)


LINE_IN = 0.205                                   # inches per bullet line


WRAP = 150                                        # characters per line at 9 pt across a 13 in figure


def wrap_bullets(lines):
    """Each finding becomes physical lines: a bullet on the first, a hanging indent on the rest."""
    import textwrap
    out = []
    for t in lines:
        w = textwrap.wrap(t, WRAP) or [""]
        out += ["•  " + w[0]] + ["    " + c for c in w[1:]]
    return out


def nlines(lines):
    """How many physical lines the findings take once wrapped (use it to size a figure before it is drawn)."""
    return len(wrap_bullets(lines))


def bullet_margin(fig, n, bottom_in=0.12):
    """The bottom margin (a figure fraction) that leaves room for n physical bullet lines under the chart."""
    return (bottom_in + n * LINE_IN + 0.10) / fig.get_size_inches()[1]


def bullets(fig, lines, bottom_in=0.12, size=9, x=0.07):
    """FINDINGS go below the chart, in point form, inside the same picture (the legend keeps only each line's name and its mean / median / max / min).
    Draws the block from the bottom up and returns the figure fraction it needs, so the caller can leave that margin."""
    H = fig.get_size_inches()[1]
    phys = wrap_bullets(lines)
    for i, t in enumerate(reversed(phys)):
        fig.text(x, (bottom_in + i * LINE_IN) / H, t, fontsize=size, color=NEUTRAL["ink2"], va="bottom", ha="left")
    return bullet_margin(fig, len(phys), bottom_in)


def bullets_ax(ax, lines, size=9):
    """The same point-form findings, but in a slot of the layout (an empty axes between the chart and a table). Top-down."""
    ax.axis("off")
    for i, t in enumerate(lines):
        ax.text(0.0, 1.0 - i * (LINE_IN / max(ax.get_window_extent().height / ax.figure.dpi, 0.01)), "•  " + t, transform=ax.transAxes, fontsize=size, color=NEUTRAL["ink2"], va="top", ha="left")


def style_table(tb, header_rows=1):
    """Header #f1f0ea and bold; every cell edged in the grid colour. The caller adds the highlights (TABLE gold / rose / green)."""
    tb.auto_set_font_size(False)
    for (r, c), cell in tb.get_celld().items():
        cell.set_edgecolor(NEUTRAL["grid"]); cell.set_linewidth(0.8)
        if r < header_rows:
            cell.set_facecolor(TABLE["header"]); cell.set_text_props(weight="bold", color=NEUTRAL["ink2"])
        else:
            cell.set_facecolor(NEUTRAL["surface"])


# ---- the check ----
def _hex(c):
    try:
        r, g, b, a = to_rgba(c)
    except ValueError:
        return None
    return None if a == 0 else to_hex((r, g, b)).lower()


def _colours(fig):
    """Every visible colour a figure paints: lines, patches (bars, fills, table cells), collections, texts."""
    import matplotlib.lines as ml, matplotlib.patches as mp, matplotlib.collections as mc, matplotlib.text as mt
    out = []
    for a in fig.findobj():
        if hasattr(a, "get_visible") and not a.get_visible():
            continue
        if isinstance(a, ml.Line2D):
            out += [(a, "line", a.get_color())]
            if a.get_marker() not in (None, "None", "", " "):
                out += [(a, "marker", a.get_markerfacecolor())]
        elif isinstance(a, mp.Patch):
            if a.get_fill():
                out += [(a, "fill", a.get_facecolor())]
            if a.get_linewidth() and a.get_edgecolor() is not None:
                out += [(a, "edge", a.get_edgecolor())]
        elif isinstance(a, mc.Collection):
            fc, ec = a.get_facecolor(), a.get_edgecolor()
            out += [(a, "fill", c) for c in (fc if len(fc) else [])] + [(a, "edge", c) for c in (ec if len(ec) else [])]
        elif isinstance(a, mt.Text) and a.get_text().strip():
            out += [(a, "text", a.get_color())]
    return out


def check(fig, name="figure", window_re=r"\d[\d,]*h"):
    """Stops a render that breaks the rules. Returns nothing; raises AssertionError listing every breach."""
    import matplotlib.table as mtab
    bad = []
    seen = set()
    for art, kind, col in _colours(fig):
        h = _hex(col)
        if h is not None and h not in ALLOWED and h not in seen:
            seen.add(h); bad.append(f"colour {h} ({kind}) is not in the palette")
    title = (fig._suptitle.get_text() if fig._suptitle is not None else "") or next((ax.get_title(loc="left") or ax.get_title() for ax in fig.axes if (ax.get_title(loc="left") or ax.get_title())), "")
    t2 = re.sub(r"^Test \d\w*:\s*", "", title.strip())            # a test figure may open with its label: "Test 2: what if we exit on a rule?"
    t2 = t2[:1].upper() + t2[1:]
    if not t2.startswith(INTERROGATIVE):
        bad.append(f"the title must be a question, it reads: {title.strip()[:60]!r}")
    texts = " ".join(t.get_text() for t in fig.findobj(matplotlib.text.Text))
    if not re.search(window_re, texts):
        bad.append("no window and hour count in the figure (a subtitle such as 'Jul 15 - Oct 03 · 1,930h')")
    # a SERIES is solid; dashes, dots and dash-dot belong to reference lines (mean, median, max, min, a threshold). A threshold path (the T-bill accrual) is ink and may be dotted.
    import matplotlib.lines as ml
    for a in fig.findobj(ml.Line2D):
        ls = a.get_linestyle()
        if a.get_visible() and ls not in ("-", "solid", "None", "none", " ", "") and len(a.get_xdata()) > 3 and _hex(a.get_color()) != NEUTRAL["ink"]:
            bad.append(f"a series line ({_hex(a.get_color())}) is drawn {ls!r}: series are solid, dashes are for reference lines"); break
    n_tables = len(fig.findobj(mtab.Table))
    if n_tables > 1:
        bad.append(f"{n_tables} tables in one figure (one table, the most informative)")
    pos = [tuple(round(v, 3) for v in ax.get_position().bounds) for ax in fig.axes if ax.axison]
    if len(pos) != len(set(pos)):
        bad.append("two axes share a position: a dual axis (a second scale is a second panel)")
    assert not bad, f"{name}: figure rules broken:\n  - " + "\n  - ".join(bad)


# ---- the palette check: a new identity is distinct to a colour-blind reader and is not amber, blue, green or red ----
_CVD = {"deuteranopia": ((0.367322, 0.860646, -0.227968), (0.280085, 0.672501, 0.047413), (-0.011820, 0.042940, 0.968881)),
        "protanopia": ((0.152286, 1.052583, -0.204868), (0.114503, 0.786281, 0.099216), (-0.003882, -0.048116, 1.051998)),
        "tritanopia": ((1.255528, -0.076749, -0.178779), (-0.078411, 0.930809, 0.147602), (0.004733, 0.691367, 0.303900))}
_LEGACY = ("LEG_A", "LEG_B")                     # the first two identities predate the check (LEG_A sits 9.4 from the good green): not held to it
MIN_APART_CVD = 13.0                             # CIE76 delta-E, the smallest of normal vision and the three simulations, between a new identity and every other palette colour


def _lab(rgb, m=None):
    import numpy as np
    c = np.array(rgb, dtype=float)
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    if m is not None:
        c = np.clip(np.array(m) @ c, 0, 1)
    x = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]) @ c / np.array([0.95047, 1.0, 1.08883])
    f = np.where(x > 0.008856, np.cbrt(x), 7.787 * x + 16 / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])


def apart(a, b):
    """The smallest delta-E between two hex colours across normal vision and deuteranopia, protanopia, tritanopia."""
    import numpy as np
    return min(float(np.linalg.norm(_lab(to_rgb(a), m) - _lab(to_rgb(b), m))) for m in (None, *_CVD.values()))


def _hue(h):
    import colorsys
    return colorsys.rgb_to_hsv(*to_rgb(h))[0] * 360


def palette_faults(identity=None, others=None):
    """A list of breaches: an identity hex shared with another colour, a new identity within MIN_APART_CVD of any other colour, or one in the amber, blue, green or red hue band."""
    identity = IDENTITY if identity is None else identity
    others = {k: v for d in (QUANTITY, VERDICT, NEUTRAL) for k, v in d.items()} if others is None else others
    bad = []
    allc = {**identity, **others}
    for k, h in identity.items():
        if sum(1 for v in allc.values() if v.lower() == h.lower()) > 1:
            bad.append(f"identity {k} {h} shares its hex with another palette colour")
        if k in _LEGACY:
            continue
        for j, v in allc.items():
            if j != k and apart(h, v) < MIN_APART_CVD:
                bad.append(f"identity {k} {h} is {apart(h, v):.1f} from {j} {v} for a colour-blind reader (under {MIN_APART_CVD:g})")
        hu = _hue(h)
        for band, centre, width in (("amber", 42, 16), ("blue", 212, 20), ("green", 120, 18), ("red", 0, 10)):
            if min(abs(hu - centre), 360 - abs(hu - centre)) < width:
                bad.append(f"identity {k} {h} sits in the {band} hue band, which belongs to another meaning")
    return bad


# ---- the self-test: plant each fault once, it must be caught; a clean figure must pass ----
def _selftest():
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    def clean():
        fig, ax = plt.subplots()
        ax.plot([0, 1], [0, 1], color=IDENTITY["LEG_A"]); ax.set_title("How did it move?", loc="left"); fig.text(0.1, 0.01, "Jul 15 - Oct 03 · 1,930h")
        return fig, ax
    def f_colour():
        fig, ax = clean(); ax.plot([0, 1], [1, 0], color="#ff00ff"); return fig
    def f_title():
        fig, ax = clean(); ax.set_title("Funding and basis", loc="left"); return fig
    def f_window():
        fig, ax = clean(); [t.remove() for t in list(fig.texts)]; return fig
    def f_tables():
        fig, ax = clean(); ax2 = fig.add_axes([0.1, 0.0, 0.3, 0.05]); ax2.axis("off"); ax3 = fig.add_axes([0.5, 0.0, 0.3, 0.05]); ax3.axis("off")
        ax2.table(cellText=[["a"]]); ax3.table(cellText=[["b"]]); return fig
    def f_dual():
        fig, ax = clean(); ax.twinx(); return fig
    def f_dashed():
        fig, ax = clean(); ax.plot([0, 1, 2, 3, 4], [0, 1, 0, 1, 0], color=QUANTITY["funding"], linestyle="--"); return fig
    # each case names the words its breach must carry, so a figure that is red for the wrong reason does not pass
    cases = [("an off-palette colour", f_colour, "not in the palette"), ("a title that is not a question", f_title, "must be a question"),
             ("no window in the figure", f_window, "no window"), ("two tables", f_tables, "tables in one figure"), ("a dual axis", f_dual, "dual axis"),
             ("a series drawn dashed", f_dashed, "drawn")]
    ok = True
    fig, ax = clean()
    try:
        check(fig, "clean"); print("  a clean figure                          GREEN (right)")
    except AssertionError as e:
        ok = False; print("  a clean figure                          RED (WRONG):", e)
    plt.close(fig)
    fig, ax = clean(); ax.set_title("Test 2: what if we exit on a rule?", loc="left")
    try:
        check(fig, "test-label"); print("  a 'Test n:' question title              GREEN (right)")
    except AssertionError as e:
        ok = False; print("  a 'Test n:' question title              RED (WRONG):", e)
    plt.close(fig)
    for label, make, words in cases:
        fig = make()
        try:
            check(fig, label); ok = False; print(f"  {label:<40}STAYED GREEN (WRONG)")
        except AssertionError as e:
            if words in str(e):
                print(f"  {label:<40}RED (right)")
            else:
                ok = False; print(f"  {label:<40}RED FOR THE WRONG REASON (WRONG): {e}")
        plt.close(fig)
    fig, ax = plt.subplots()
    for i, k in enumerate(IDENTITY):
        ax.plot([0, 1], [i, i + 1], color=IDENTITY[k])
    ax.set_title("Which colour is which?", loc="left"); fig.text(0.1, 0.01, "Jul 15 - Oct 03 · 1,930h")
    try:
        check(fig, "every identity"); print("  every identity colour in one figure     GREEN (right)")
    except AssertionError as e:
        ok = False; print("  every identity colour in one figure     RED (WRONG):", e)
    plt.close(fig)
    pf = palette_faults()
    if pf:
        ok = False; print("  the shipped palette                     RED (WRONG):", "; ".join(pf))
    else:
        print("  the shipped palette                     GREEN (right)")
    planted = [("an identity reusing a verdict hex", {**IDENTITY, "ASSET_2": VERDICT["good"]}, "shares its hex"),
               ("an identity a colour-blind reader merges", {**IDENTITY, "ASSET_2": "#4e3caa"}, "colour-blind"),
               ("an identity in the amber band", {**IDENTITY, "ASSET_2": "#e6a82e"}, "amber hue band"),
               ("an identity in the blue band", {**IDENTITY, "ASSET_2": "#2f6fd0"}, "blue hue band"),
               ("an identity in the red band", {**IDENTITY, "ASSET_2": "#c4281f"}, "red hue band")]
    for label, ident, words in planted:
        got = " ".join(palette_faults(ident))
        if words in got:
            print(f"  {label:<40}RED (right)")
        else:
            ok = False; print(f"  {label:<40}{'STAYED GREEN' if not got else 'RED FOR THE WRONG REASON'} (WRONG): {got}")
    return ok


# ---- helpers the study cells call (moved out of the notebook so a cell holds no layout logic) ----
def title_of(fig):
    """The figure's question: its suptitle, else the first axes title."""
    return (fig._suptitle.get_text() if fig._suptitle is not None else "") or next(
        (ax.get_title(loc="left") or ax.get_title() for ax in fig.axes if (ax.get_title(loc="left") or ax.get_title())), "")


def show(fig, tag, figures):
    """Check the figure against the rules, draw it, and list it for the manifest (`figures` is the study's FIGURES list)."""
    import matplotlib.pyplot as plt
    assert tag.startswith("fig:s") and tag[5].isdigit(), tag
    check(fig, tag)
    figures.append({"id": tag, "section": f"S{tag[5]}", "title": title_of(fig).strip()})
    plt.show()


def yfit(ax, series, pad=0.10, floor0=True):
    lo = min(float(s.min()) for s in series); hi = max(float(s.max()) for s in series)
    if floor0:
        lo, hi = min(lo, 0.0), max(hi, 0.0)
    ax.set_ylim(lo - (hi - lo) * pad, hi + (hi - lo) * pad)


def finish(fig, lines, top, **kw):
    """Findings below the chart, then leave their margin."""
    import matplotlib.pyplot as plt
    bm = bullets(fig, lines)
    plt.subplots_adjust(top=top, bottom=bm + 0.5 / fig.get_size_inches()[1], **kw)


def fig_tab(h=7.0, ratios=(3.0, 1.2), top=0.87, bottom=0.07, hspace=0.45, nb=0):
    """A chart over a table. nb = the number of point-form findings that will go under them (bullets): the figure grows to hold them."""
    import matplotlib.pyplot as plt
    H = h + (nb * 0.205 + 0.25 if nb else 0)
    fig = plt.figure(figsize=(13, H))
    if nb:
        bottom = bullet_margin(fig, nb) + 0.015
        top = 1 - (1 - top) * h / H
    gs = fig.add_gridspec(2, 1, height_ratios=list(ratios), hspace=hspace, left=0.07, right=0.97, top=top, bottom=bottom)
    ax, axt = fig.add_subplot(gs[0]), fig.add_subplot(gs[1]); axt.axis("off")
    return fig, gs, ax, axt


def put_table(axt, cells, cols, size=10, first=None):
    tb = axt.table(cellText=cells, colLabels=cols, cellLoc="center", loc="center", bbox=[0, 0, 1, 1])
    tb.set_fontsize(size)
    style_table(tb)
    n = len(cols)
    for (r_, c_), cell in tb.get_celld().items():
        if first:
            cell.set_width(first if c_ == 0 else (1 - first) / (n - 1))
        if c_ == 0 and r_ > 0:
            cell.set_text_props(weight="bold"); cell._loc = "left"
    return tb


def gold(tb, r, c):
    tb[(r, c)].set_facecolor(TABLE["gold"]); tb[(r, c)].set_text_props(weight="bold")


def tint(tb, r, c, k):
    tb[(r, c)].set_facecolor(TABLE[k])


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(0 if _selftest() else 1)
