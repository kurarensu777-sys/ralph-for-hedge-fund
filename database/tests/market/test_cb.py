"""The central bank datasets (B-0541): cb_docs, cb_meetings, cb_votes, cb_projections (revise) and
cb_llm (settled), venue fed | boj | ecb. What each test pins down: every one is ARCHIVE by the
dataset default with no declaration at all (the `classes` fixture); a re-fetched document replaces the
stored one and the old one is logged; a url re-dated into another month moves (B-0544); an LLM answer is never overwritten; the nullable columns the
seam sends are nullable; a raw file, a bad bank, a bad date or hash and an out-of-vocabulary value
are refused with nothing written."""
import hashlib
import json

import pytest

from fund_db import market
from fund_db.market import WriteError

NOW = 1_788_220_800_000          # 2026-09-01T00:00:00Z
SHA = hashlib.sha256(b"raw statement").hexdigest()
KEY = hashlib.sha256(b"prompt").hexdigest()
TEXT = "The Committee decided to maintain the target range. " * 8


def doc(**kw):
    r = {"doc_type": "statement", "url": "https://fed.example/s1.htm", "title": "FOMC statement",
         "meeting_date": "2025-12-10", "publish_date": "2025-12-10", "sha256": SHA, "bytes": 4096,
         "text": TEXT, "words": 72}
    return {**r, **kw}


def meeting(**kw):
    r = {"meeting_date": "2025-12-10", "decision": "hold", "summary": "Held at 3.50-3.75.",
         "rate_target": "3.50-3.75", "classify_version": "v3", "status": "done"}
    return {**r, **kw}


def vote(**kw):
    r = {"meeting_date": "2025-12-10", "item": "rate", "member": "Miran", "role": "governor",
         "vote": "against", "source_url": "https://fed.example/s1.htm", "dissent_text": "Preferred 50bp.",
         "proposed_alternative": "cut 50bp", "direction": "dovish", "reason": "labour", "quote": "..."}
    return {**r, **kw}


def proj(**kw):
    r = {"meeting_date": "2025-12-10", "source_url": "https://fed.example/p.htm", "stat": "median",
         "variable": "fed funds", "horizon": "2026", "bucket": "", "value": 3.4}
    return {**r, **kw}


def llm(**kw):
    r = {"key": KEY, "task": "classify", "subject": "2025-12-10", "prompt_version": "p1",
         "model": "m1", "response": json.dumps({"decision": "hold"}), "created": NOW}
    return {**r, **kw}


def put(dataset, rows, venue="fed", **kw):
    kw.setdefault("now", NOW)
    return market.write_cb(dataset, venue, rows, **kw)


FIVE = (("cb_docs", doc, market.cb_docs), ("cb_meetings", meeting, market.cb_meetings),
        ("cb_votes", vote, market.cb_votes), ("cb_projections", proj, market.cb_projections),
        ("cb_llm", llm, market.cb_llm))


@pytest.mark.parametrize("name,mk,read", FIVE)
def test_round_trip_lands_in_the_lake_with_no_declaration(classes, name, mk, read):
    """No archive declaration exists (the fed/boj/ecb venue.json lists are empty): the dataset default
    sends the rows to the lake, never the cache, and they read back column for column."""
    assert market.archive_declarations() == []
    rep = put(name, [mk()], source="seed:sentiment-2026-07-26")
    assert rep["added"] == 1 and rep["storage"] == {"archive": 1}
    got = read("fed", as_="rows")
    assert len(got) == 1
    for c, v in mk().items():
        assert got[0][c] == v, c
    assert (got[0]["venue"], got[0]["src"], got[0]["seen"]) == ("fed", "seed:sentiment-2026-07-26", NOW)
    assert list((classes["root"] / "market" / name).rglob("*.parquet"))
    assert not (classes["root"] / "cache" / name).exists()
    assert read("boj", as_="rows") == [] and read("ecb", as_="rows") == []


def test_the_cache_is_refused_for_every_one(classes):
    for name, mk, _ in FIVE:
        with pytest.raises(WriteError, match="never enters the cache"):
            put(name, [mk()], storage="cache")


def test_the_seam_nullables_are_nullable(classes):
    put("cb_docs", [doc(bytes=None, publish_date=None)], source="seed:x")
    put("cb_meetings", [meeting(decision=None, summary=None, rate_target=None, classify_version=None,
                                status="pending")], source="seed:x")
    put("cb_votes", [vote(role=None, source_url=None, dissent_text=None, proposed_alternative=None,
                          direction=None, reason=None, quote=None, vote="for")], source="seed:x")
    d = market.cb_docs("fed", as_="rows")[0]
    assert (d["bytes"], d["publish_date"]) == (None, None)
    m = market.cb_meetings("fed", as_="rows")[0]
    assert (m["decision"], m["summary"], m["rate_target"], m["status"]) == (None, None, None, "pending")
    v = market.cb_votes("fed", as_="rows")[0]
    assert (v["dissent_text"], v["proposed_alternative"], v["direction"], v["reason"], v["quote"]) == (None,) * 5


def test_an_attendance_row_and_a_medians_empty_bucket(classes):
    put("cb_votes", [vote(item="attendance", member="Powell", vote="present", dissent_text=None),
                     vote(item="rate", member="Powell", vote="for", dissent_text=None)])
    assert {(r["item"], r["vote"]) for r in market.cb_votes("fed", member="Powell", as_="rows")} == \
        {("attendance", "present"), ("rate", "for")}
    assert [r["item"] for r in market.cb_votes("fed", item="attendance", as_="rows")] == ["attendance"]
    put("cb_projections", [proj(), proj(stat="dot", bucket="3.25-3.50", value=7.0),
                           proj(stat="dot", bucket="3.50-3.75", value=3.0)])
    assert len(market.cb_projections("fed", variable="fed funds", as_="rows")) == 3
    assert [r["bucket"] for r in market.cb_projections("fed", stat="median", as_="rows")] == [""]
    assert put("cb_projections", [proj()])["unchanged"] == 1


def test_a_range_bound_is_a_cell_beside_the_median(classes):
    """BOJ Outlook: the majority's median and the low and high of its range, one cell each."""
    put("cb_projections", [proj(meeting_date="2025-10-30", variable="core CPI", horizon="FY2026", value=1.8),
                           proj(meeting_date="2025-10-30", variable="core CPI", horizon="FY2026",
                                stat="range_lo", value=1.7),
                           proj(meeting_date="2025-10-30", variable="core CPI", horizon="FY2026",
                                stat="range_hi", value=1.9),
                           proj(meeting_date="2025-10-30", variable="core CPI", horizon="FY2024",
                                stat="actual", value=2.7)], venue="boj")
    got = {r["stat"]: (r["bucket"], r["value"]) for r in market.cb_projections("boj", as_="rows")}
    assert got == {"median": ("", 1.8), "range_lo": ("", 1.7), "range_hi": ("", 1.9)} | {"actual": ("", 2.7)}
    assert [r["value"] for r in market.cb_projections("boj", stat="range_hi", as_="rows")] == [1.9]


def test_a_refetched_document_replaces_the_stored_one_and_logs_it(classes):
    put("cb_docs", [doc()])
    assert put("cb_docs", [doc()])["unchanged"] == 1
    sha2 = hashlib.sha256(b"edited").hexdigest()
    rep = put("cb_docs", [doc(sha256=sha2, text=TEXT + " Amended.", words=73)])
    assert rep["revised"] == 1 and len(rep["conflicts"]) == 1
    [row] = market.cb_docs("fed", as_="rows")
    assert row["sha256"] == sha2 and row["text"].endswith("Amended.")
    [c] = market.conflicts("cb_docs", as_="rows")
    assert c["kind"] == "revised" and json.loads(c["stored"])["sha256"] == SHA
    assert json.loads(c["incoming"])["sha256"] == sha2


BOJ_URL = "https://www.boj.or.jp/en/mopo/outlook/gor2504a.pdf"


def _months(classes, name="cb_docs"):
    return sorted(p.name for p in (classes["root"] / "market" / name).rglob("month=*"))


def test_a_url_redated_into_another_month_moves_and_logs_the_old_row(classes):
    """B-0544, the real case: stored under meeting_date 2025-04-01, the listing says 2025-05-01."""
    put("cb_docs", [doc(url=BOJ_URL, meeting_date="2025-04-01"),
                    doc(url="https://boj.example/other.pdf", meeting_date="2025-04-01", sha256=KEY)],
        venue="boj", source="seed:sentiment-2026-07-26")
    sha2 = hashlib.sha256(b"listing").hexdigest()
    rep = put("cb_docs", [doc(url=BOJ_URL, meeting_date="2025-05-01", sha256=sha2)], venue="boj")
    assert (rep["moved"], rep["revised"], rep["added"], rep["unchanged"]) == (1, 1, 0, 0)
    [row] = market.cb_docs("boj", url=BOJ_URL, as_="rows")
    assert (row["meeting_date"], row["sha256"], row["src"]) == ("2025-05-01", sha2, "venue")
    assert [r["url"] for r in market.cb_docs("boj", as_="rows", where="meeting_date < '2025-05-01'")] ==         ["https://boj.example/other.pdf"]                    # its neighbour in the old month stays
    assert _months(classes) == ["month=2025-04", "month=2025-05"]
    [c] = market.conflicts("cb_docs", as_="rows")
    assert c["kind"] == "revised"
    assert json.loads(c["stored"])["meeting_date"] == "2025-04-01" and json.loads(c["stored"])["sha256"] == SHA
    assert json.loads(c["incoming"])["meeting_date"] == "2025-05-01"
    assert json.loads(c["key"]) == {"url": BOJ_URL}


def test_the_last_row_of_a_month_moving_out_empties_it(classes):
    put("cb_docs", [doc(meeting_date="2025-04-01")])
    put("cb_docs", [doc(meeting_date="2025-05-01")])
    assert [r["meeting_date"] for r in market.cb_docs("fed", as_="rows")] == ["2025-05-01"]
    assert not list((classes["root"] / "market" / "cb_docs").rglob("month=2025-04/*.parquet"))
    assert market.coverage("cb_docs", "fed")[0]["rows"] == 1
    assert put("cb_docs", [doc(meeting_date="2025-05-01")])["unchanged"] == 1


def test_a_seed_in_another_month_moves_nothing_and_another_bank_is_its_own(classes):
    put("cb_docs", [doc(meeting_date="2025-04-01")])
    rep = put("cb_docs", [doc(meeting_date="2025-05-01")], source="seed:x")
    assert (rep["skipped"], rep["moved"], rep["added"]) == (1, 0, 0)
    assert [r["meeting_date"] for r in market.cb_docs("fed", as_="rows")] == ["2025-04-01"]
    [c] = market.conflicts("cb_docs", as_="rows")
    assert c["kind"] == "seed_vs_stored"
    assert put("cb_docs", [doc(meeting_date="2025-05-01")], venue="ecb")["added"] == 1
    assert [r["meeting_date"] for r in market.cb_docs("fed", as_="rows")] == ["2025-04-01"]


def test_a_batch_with_one_url_under_two_months_is_refused(classes):
    with pytest.raises(WriteError, match="two meeting_date months"):
        put("cb_docs", [doc(meeting_date="2025-04-01"), doc(meeting_date="2025-05-01")])
    assert market.cb_docs("fed", as_="rows") == []


def test_a_move_that_died_before_the_removal_is_finished_by_the_same_write(classes, monkeypatch):
    """New row first, old one gone last: a crash between leaves the url twice, never none."""
    from fund_db.market import writer
    put("cb_docs", [doc(meeting_date="2025-04-01")])
    real = writer._remove_moved
    monkeypatch.setattr(writer, "_remove_moved", lambda *a, **k: (_ for _ in ()).throw(OSError("died")))
    with pytest.raises(OSError):
        put("cb_docs", [doc(meeting_date="2025-05-01")])
    assert sorted(r["meeting_date"] for r in market.cb_docs("fed", as_="rows")) == ["2025-04-01", "2025-05-01"]
    assert len(market.conflicts("cb_docs", as_="rows")) == 1
    monkeypatch.setattr(writer, "_remove_moved", real)       # not undo(): that drops FUND_DB_DIR too
    rep = put("cb_docs", [doc(meeting_date="2025-05-01")])
    assert rep["unchanged"] == 1 and rep["moved"] == 1 and rep["added"] == 0
    assert [r["meeting_date"] for r in market.cb_docs("fed", as_="rows")] == ["2025-05-01"]


def test_a_seed_never_replaces_and_a_venue_fetch_fills_the_seeds_nulls(classes):
    put("cb_docs", [doc()])
    seed = put("cb_docs", [doc(text="a different seeded text " * 20)], source="seed:sentiment-2026-07-26")
    assert seed["skipped"] == 1 and market.cb_docs("fed", as_="rows")[0]["text"] == TEXT
    put("cb_docs", [doc(url="https://fed.example/s2.htm", bytes=None, publish_date=None)],
        source="seed:sentiment-2026-07-26")
    rep = put("cb_docs", [doc(url="https://fed.example/s2.htm")])
    assert rep["revised"] == 1
    got = market.cb_docs("fed", url="https://fed.example/s2.htm", as_="rows")[0]
    assert (got["bytes"], got["publish_date"], got["src"]) == (4096, "2025-12-10", "venue")


def test_a_reclassified_meeting_and_vote_revise_and_keep_the_old_reading(classes):
    put("cb_meetings", [meeting(status="pending", decision=None, summary=None, rate_target=None)],
        source="derived:classify")
    rep = put("cb_meetings", [meeting()], source="derived:classify")
    assert rep["revised"] == 1
    assert market.cb_meetings("fed", status="done", as_="rows")[0]["decision"] == "hold"
    assert market.cb_meetings("fed", status="pending", as_="rows") == []
    put("cb_votes", [vote()])
    assert put("cb_votes", [vote(direction="hawkish")])["revised"] == 1
    kinds = [(c["dataset"], c["kind"]) for c in market.conflicts(as_="rows")]
    assert sorted(kinds) == [("cb_meetings", "revised"), ("cb_votes", "revised")]


def test_an_llm_answer_is_settled_never_overwritten(classes):
    put("cb_llm", [llm()], source="derived:llm")
    assert put("cb_llm", [llm()], source="derived:llm")["unchanged"] == 1
    other = json.dumps({"decision": "cut"})
    rep = put("cb_llm", [llm(response=other, created=NOW + 5)], source="derived:llm")
    assert rep["conflict"] == 1 and rep["added"] == 0
    [row] = market.cb_llm("fed", key=KEY, as_="rows")
    assert json.loads(row["response"]) == {"decision": "hold"} and row["created"] == NOW
    [c] = market.conflicts("cb_llm", as_="rows")
    assert c["kind"] == "settled_row_changed" and json.loads(json.loads(c["incoming"])["response"]) == {"decision": "cut"}


def test_the_same_llm_key_in_a_later_month_is_a_second_row(classes):
    """The documented limit: `created` picks the month, identity is per partition, so a caller reads
    the key before it asks again (platform's LLMCache does)."""
    put("cb_llm", [llm()])
    put("cb_llm", [llm(created=NOW + 40 * 86_400_000)])
    assert len(market.cb_llm("fed", key=KEY, as_="rows")) == 2


BAD = [
    ("cb_docs", dict(sha256="ABC"), "sha256"),
    ("cb_docs", dict(sha256=SHA.upper()), "sha256"),
    ("cb_docs", dict(text="%PDF-1.7 raw bytes"), "raw file"),
    ("cb_docs", dict(text="a\x00b"), "raw file"),
    ("cb_docs", dict(text="x" * 2_000_001), "raw file"),
    ("cb_docs", dict(text="   "), "text"),
    ("cb_docs", dict(url=" "), "url"),
    ("cb_docs", dict(meeting_date="2025-12-10T00:00:00Z"), "meeting_date"),
    ("cb_docs", dict(meeting_date="2025-02-30"), "calendar date"),
    ("cb_docs", dict(publish_date="Dec 10"), "publish_date"),
    ("cb_docs", dict(bytes=-1), "bytes"),
    ("cb_docs", dict(words=1.5), "words"),
    ("cb_meetings", dict(status="finished"), "status"),
    ("cb_meetings", dict(status=None), "status"),
    ("cb_votes", dict(vote="abstain"), "vote"),
    ("cb_votes", dict(item="attendance", vote="for"), "attendance"),
    ("cb_votes", dict(member=""), "member"),
    ("cb_projections", dict(stat="mean"), "stat"),
    ("cb_projections", dict(stat="dot", bucket=""), "bucket"),
    ("cb_projections", dict(stat="median", bucket="3.25-3.50"), "median"),
    ("cb_projections", dict(stat="range_lo", bucket="3.25-3.50"), "range_lo has no bucket"),
    ("cb_projections", dict(stat="range_hi", bucket="x"), "range_hi has no bucket"),
    ("cb_projections", dict(stat="actual", bucket="3.25-3.50"), "actual has no bucket"),
    ("cb_projections", dict(stat="range_mid"), "stat"),
    ("cb_projections", dict(bucket=None), "bucket"),
    ("cb_projections", dict(value=float("nan")), "finite"),
    ("cb_projections", dict(value=float("inf")), "finite"),
    ("cb_projections", dict(value=None), "required column"),
    ("cb_llm", dict(key="not-a-hash"), "sha256"),
    ("cb_llm", dict(task="chat"), "task"),
    ("cb_llm", dict(response="not json {"), "JSON"),
    ("cb_llm", dict(created=0), "created"),
    ("cb_llm", dict(model=None), "required"),
]
MAKE = {n: mk for n, mk, _ in FIVE}


@pytest.mark.parametrize("name,patch,why", BAD)
def test_a_row_that_breaks_the_contract_is_refused_and_nothing_lands(classes, name, patch, why):
    good = MAKE[name]()
    with pytest.raises(WriteError, match=why):
        put(name, [good, MAKE[name](**patch)])
    assert market.read(name, as_="rows") == []


def test_only_the_three_banks_and_only_the_five_datasets(classes):
    with pytest.raises(WriteError, match="not a central bank we hold"):
        put("cb_docs", [doc()], venue="boe")
    with pytest.raises(WriteError, match="not a central bank dataset"):
        market.write_cb("candles", "fed", [])
    assert market.CB_VENUES == ("fed", "boj", "ecb")
    for v in ("boj", "ecb", "FED"):
        assert put("cb_meetings", [meeting()], venue=v)["added"] == 1
    assert {r["venue"] for r in market.cb_meetings(as_="rows")} == {"fed", "boj", "ecb"}


def test_a_filter_and_a_date_window_narrow_the_read(classes):
    put("cb_docs", [doc(), doc(url="u2", meeting_date="2026-01-28", doc_type="minutes"),
                    doc(url="u3", meeting_date="2026-03-18", doc_type="statement")])
    assert [r["url"] for r in market.cb_docs("fed", doc_type="statement", as_="rows",
                                             cols=["url", "meeting_date"])] == ["https://fed.example/s1.htm", "u3"]
    assert [r["url"] for r in market.cb_docs("fed", start="2026-01-01", end="2026-02-28", as_="rows")] == ["u2"]
    assert [r["url"] for r in market.cb_docs("fed", where="words > ?", params=[70], doc_type="minutes",
                                             as_="rows")] == ["u2"]


def test_the_catalog_counts_each_bank_and_nothing_prunes_or_tiers_them(classes):
    put("cb_votes", [vote(), vote(member="Powell", vote="for")])
    [row] = market.coverage("cb_votes", "fed")
    assert (row["rows"], row["symbol"]) == (2, "") and row["by_src"] == {"venue": 2}
    late = NOW + 20 * 365 * 86_400_000
    for name, mk, _ in FIVE:
        assert market.DATASETS[name].archive and market.DATASETS[name].storage == "archive"
        put(name, [mk()])
        assert market.prune(name, apply=True, now_ms=late) == []
        assert market.tier(name, apply=True, now_ms=late) == []
        assert len(market.read(name, as_="rows")) >= 1
