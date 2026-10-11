---
name: study
description: Read an outside source - a venue's API docs, a paper, another fund's write-up, a competitor terminal - and file what it is worth. Fire on "read X / what does X say / look at how Y does this / study this doc" where X is not our own code or our own record.
---

# study - the reading list

The method lives in the books; this skill only routes. Resolve the desk the source is true at,
then read, verify at the primary source, and file:

Pull a chapter with `python app\tools\context.py --show <ref>`, not the whole book.

| Read | Why |
|---|---|
| `platform/lab/<desk>/research-log.md` | where the read lands: date, source, claim, verified-at-source, what it changed |
| the primary document itself | a venue's doc or NUMBER: quote it with the date read and its tag (`[V]`, `[1]`, `[U]`, `[API]`), never from a description of it |
| `app/library/law/how-we-know.md#small-n-rules` | an outside claim moves nothing here until this desk runs it |
| `app/library/law/how-we-know.md#what-would-it-print-if-false` | before believing any figure a source reports as verified or complete |
| `app/library/research/research.md#prior-art` | what the public field already built |
| `platform/lab/<desk>/menu.md` | a genuinely new procedure enters as an `o` row, weightless |

Go to the primary source, not a description of it. Every number filed carries the date it was
read and a provenance tag. A claim that changes nothing is still worth a row saying so. This
skill files; it never moves a belief.
