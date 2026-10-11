---
topics: [engineering]
type: guide
---

# Engineering - code-level craft

Laws every engineering agent shares whatever package or venue it builds: how a text edit can silently corrupt a file, how a cross-process lock and a state-file write must behave on Windows, and what a fixture, a stored parse and a model call can hide. Kept by the `platform` agent. A law true of one venue is a chapter of that venue's own book; how one package works is a chapter of that package's book. A new learning is a new `##` chapter here, opening with its Read-when line.

## Escapes cross every interpreter

Read when: about to edit a file through a python, sed or node one-liner or a heredoc holding a backslash escape (`\b`, `\n`), to trust a green typecheck after one, or reading the guard's "control characters" refusal.

Every layer between your intent and the file may read a backslash: the tool call's string, bash (unless the heredoc tag is quoted), Python's literal (unless raw), sed's replacement. `/^output\b/i` landed as `/^output` + a raw BACKSPACE byte (0x08) + `/i`, and a sed fix made it `/^outputb/i`; the typecheck stayed green both times, since both are valid regexes.

- **A line holding a backslash escape is written with the editor (Edit or Write), never a one-liner.** If a one-liner must carry one, build the character from its code (`chr(8)`, `String.fromCharCode(8)`) or check the bytes after (`od -c`).
- **A mutation that does not apply proves nothing:** a sed pattern that did not match leaves the suite green. `grep` the mutated line before reading the run.
- **A counter hits the same trap** and reports a number, not an error: run it on a file whose answer you know first.

Mechanism: the commit guard refuses an ADDED line holding a C0 control character other than tab and form feed, or DEL (`app/scripts/hooks/guard-lib.mjs` `controlFindings`; any `snapshots/` folder is skipped, since captured PDFs carry form feeds). Tested in `app/test/git-guard.test.ts`, broken twice on purpose, both red. **Unenforced:** an escape eaten into a PRINTABLE character (`\b` becomes `b`) still commits; only the first rule and reading the diff catch it.

Measured: a Python edit turned `\\n` in a TypeScript template into real line breaks twice in one hour; `grep -c $'\r'` counted the letter r and read 700 of 700 files as CRLF, where `bytes([13])` found none.

## Windows file locks

Read when: about to write or trust ANY cross-process lock, or reading a `PermissionError` on a `.lock` file as anything but contention.

On Windows, `os.remove()` on a lock file leaves it DELETE-PENDING until every handle closes. An `O_CREAT | O_EXCL` create on that name fails with **EACCES (`PermissionError`), not EEXIST**, so a lock that catches only `FileExistsError` loses the write it guarded.

- **Prefer an OS lock on a persistent file:** `msvcrt.locking(fd, LK_NBLCK, 1)` (Windows) or `fcntl.flock(LOCK_EX | LOCK_NB)` on one byte of a file never deleted, polled until a deadline. The kernel frees it when the holder dies, so no stale-lock rule is needed. Shape: `database/py/fund_db/market/lock.py`, with a threading lock beside it (byte-range locks are per handle).
- **Use `O_CREAT | O_EXCL` only where an OS lock cannot reach** (a network share, another language), and then treat `PermissionError` as contention like `FileExistsError`, in the create and in the holder's own `os.remove()` retry. One still there at the deadline is real (an unwritable store): re-raise it as itself, not as a timeout.
- **A waiter never opens another holder's lock file** (it can refuse the holder's delete, WinError 32): judge staleness by `stat().st_mtime`.
- **Prove both halves:** a held lock times out, a killed holder frees it at once; make the lock call a no-op and the concurrent-writers test goes red.

Grep any lock for `except FileExistsError` with no `PermissionError` beside it.

Measured: a lock that caught only `FileExistsError` lost up to 52 of 300 rows a round (10 writers x 30 rows; clean in 2 of 8 rounds); fixed, 8 of 8 were clean.

## Windows atomic replace over an open file

Read when: about to write a state file that a reader or a second writer can touch at the same time, or reading `PermissionError` (WinError 5) on `os.replace` as anything but contention.

`os.replace(tmp, target)` is atomic, but on Windows it is REFUSED with `PermissionError` while any handle has the target open, and Python's `open()` takes no delete-share. A temp file named by pid and a nanosecond clock does not help: the collision is on the target, not the temp. The reader that makes it fail is another thread's plain `read_text`.

- **In one process:** one lock around the read and the write of a state key (a `_STATE_LOCK` taken by both `read_state` and `write_state`), so a reader never holds the target open during a replace.
- **Across processes:** retry the replace a few times with short sleeps (0.8 s in all) and raise the error as itself if the target is still held. A reader of another process cannot be locked out.
- **A read that swallows `OSError` and returns its default** (`fund_db.files.read_json`) turns the same collision into a silent reset of the state it read: the lock covers that too.
- **Prove it:** a test runs 4 writers and 4 readers on one key, expecting 0 lost writes, and then the same hammer with the lock and the retry removed, which must lose writes (it did).

Measured: 8 parallel bar requests against one venue collided on its pacing state file and 2 of 8 failed; a hammer of 4 writers and 4 readers (60 writes each) reproduced it with 230 failed writes and read 0 after the fix.

## A fixture the ignore rules drop

Read when: about to commit a recorded input (a CSV, a log, a captured answer) as a test fixture, or a test passes here and fails on a fresh clone.

Ignore rules written to keep captured market data out of git (`*.csv`, `*.log`) also catch a fixture: `git add` of a folder stages everything else and silently leaves the CSV behind, and the offline tests stay green on the machine that has the file. Record such a fixture gzipped (`x.csv.gz`, the tests read `gzip.open(path, "rt")`), or un-ignore the fixtures folder by pattern, and after staging a new folder run `git status --short --ignored <folder>` or `git check-ignore -v <file>`. Found twice: four of six fixtures of one adapter were ignored, and another adapter's fixtures had never been committed, so its tests failed on every fresh clone and passed on the machine that held them.

## A module a sealed dashboard imports is stdlib

Read when: about to import numpy, scipy or pandas in a platform module that a dashboard's server loads.

A dashboard runs on its own `.venv` built from its own `requirements.txt` (the platform package editable plus its web stack), not the fund venv, and the platform package declares no numpy. A module the screen imports must therefore run on the stdlib alone, with numpy or scipy only as a test-side cross-check in the fund venv. Measured: a rates module solves its smoothing spline with a small Gauss-Jordan instead of scipy, and its test holds it to scipy's `make_smoothing_spline` to 1e-9.

## A stored parse is the parser of its day

Read when: about to fix a parser whose output is already stored, to key a cache or a change check on a fetched file's hash, or a test of a parser is green while the stored rows stay wrong.

Fixing a parser changes nothing already stored: a refresh that only parses NEW documents never revisits the old rows. Ship the fix with a re-parse over the stored text (no fetch, no model) and run it. Measured: a vote parser's fix landed and the stored rows still dropped a voter on two meetings for days, until a re-parse rewrote them (49 of 2,604 rows replaced and logged to `conflicts`). An independent audit against the live sites found the bug; the store's own `verify` could not, because it re-ran the same parser.

A raw file's hash is not a content check: one site's HTML changed bytes between two fetches of the same page (same text, same length, two hashes), while another's PDFs hashed stably. Detect a changed document on its extracted text; keep the raw sha256 only as the stored identity the cached readings are keyed on.

## Calling a model from a job

Read when: about to call a Claude model from platform code in a loop or in parallel (claude-agent-sdk), to size its worker pool, or to trust a list a model extracted.

- On Windows claude-agent-sdk (0.2.163) refuses npm's `claude.cmd` shim and the py3-none-any wheel bundles no exe, so pass a native `claude.exe` as `cli_path`. Find one in a fixed order (an environment override, PATH, then the exe npm's claude-code package ships beside the shim) and pin the order in a test.
- Each call starts a CLI that reads and writes `~/.claude.json`. With 16 at once, one call in about 500 read the file mid-write, reported it corrupted and made a backup in `~/.claude/backups`. The file itself stayed valid. Unenforced: the job defaults to 4 workers and nothing caps the total across jobs.
- A refusal or a reply with no JSON is that document's failure, not a backend failure: on data-table documents a small model answered "I cannot analyze..." and, counted as backend errors, those refusals tripped the 3-in-a-row breaker mid-run. A reply-error type of its own keeps them out of the breaker; a document that is a data table is not sent at all.
- A model's extraction is a candidate list. Model readers proposed about 280 phrases with "verbatim" quotes; 6 of one source's 58 quotes were not in their files, and after counting each phrase in the full corpus and reading its hits in context, 23 entered the lexicons. Check every quote by string match, every count against the corpus, every polarity on real hits.

## A blob fed through a text pipe gains CR

Read when: about to write a git blob from Python (`git hash-object -w --stdin`, `commit-tree` input) or to pipe file content to any tool on Windows.

`subprocess.run([...], text=True, input=s)` translates every `\n` to `\r\n` on Windows, so a blob hashed from a text pipe is CRLF and the commit rewrites every line of the file: one commit turned a whole API document into a whole-file change while adding 11 lines. Feed git bytes (`input=s.encode("utf-8")`, no `text=True`), assert `b"\r\n" not in data`, and read `git show --stat HEAD` before pushing. Unenforced: no hook refuses a CRLF blob.
