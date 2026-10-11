---
topics: [writing]
type: guide
---

# How we write

How every agent writes anything a person reads: a reply, a commit message, a board item, a book chapter. The base prompt carries the short form; this book holds the fuller lists and the rewrite procedure. The fund agent keeps it. The chapters are the fund's own wording of two public catalogues of the patterns that mark machine-written text, read 2026-10-03: the humanizer skill (`github.com/blader/humanizer`, MIT License, 2025) and Wikipedia's "Signs of AI writing" from WikiProject AI Cleanup (`en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing`, CC BY-SA 4.0). Nothing is copied beyond short word lists. A new pattern is a line in the chapter it belongs to; a new family is a new `##` chapter opening with its Read-when line.

## Lead with the answer

Read when: about to write a reply, a report or a board item.

Cut the run-up before the point: "Let's dive in", "Here's what you need to know", "Without further ado", "Honestly?", "Real talk". Write about the subject, never the document: "The table below compares", "This section is organized by" and "was added to replace" describe the text, not the thing. A heading followed by a first sentence that repeats it is the same fault: drop the sentence.

## No caption under a name

Read when: about to put a line under a heading, a group header, a column or tab label, a card title or a chapter title, in prose, a mock-up or the UI.

A name that stands alone needs no gloss. "Carry" is not helped by "a differential held", nor "Directional" by "a view on price"; the line restates the name in vaguer words and costs a row on every screen. Write the header and go straight to the content. A line under a name is kept only when it carries a fact the name cannot: a count, a date, a unit, a state ("3 studies", "as of 10-04"). A definition belongs in one place (a tooltip, the book chapter that defines the term), never repeated under every use.

Unenforced: no check reads headings. The commit guard and `check.py` do not look for it, so a reviewer (the owner, or the agent that owns the folder) catches it.

## Say it, do not stage it

Read when: a sentence sets up a contrast, a reveal or a closing line.

- "Not just X, but Y" and "it's not X, it's Y" stage a correction nobody asked for. State Y. Keep a contrast only when the reader really believes X.
- Sayings that sound deep say nothing: "at its core", "what really matters", "fundamentally", "the heart of the matter". Replace each with the specific claim.
- A one-line paragraph restating the one before ("That distinction matters.", "That is the real win.") is a closer, not content: cut it or merge it into a concrete claim.
- Arguing with no one ("To be clear", "I'm not saying", "Don't get me wrong") answers an objection nobody raised. Remove it.

## Rhythm by rule

Read when: a paragraph reads smooth but mechanical, or every list has three items.

- Forced triads: three items because three sounds finished. Check each adds a distinct idea; merge two, develop the strongest, or let the list be two or four long.
- The same subject opening sentence after sentence: merge, change the subject, or start with the action.
- Stacked qualifiers ("could potentially", "might arguably", "it's also possible that"): keep the one the evidence supports.
- A hyphenated pair after the noun ("the data is well-documented"): the hyphen belongs only before a noun.
- Passive voice that hides who acted: "the guard refused the commit", not "the commit was refused".
- Uniform medium sentences are the strongest tell of all.

## Plain words, no inflation

Read when: about to describe why something matters, or a word feels impressive.

- Words that mark machine text: additionally, align with, bolstered, crucial, deep dive, delve, enduring, enhance, garner, highlight, interplay, intricate, key (as an adjective), landscape, meticulous, pivotal, quietly, robust, showcase, tapestry, testament, underscore, valuable, vibrant. Use the plain word, or nothing.
- Write is, are and has, not serves as, stands as, functions as, represents, boasts, features or offers.
- Inflated significance ("stands as a testament", "a pivotal moment", "plays a key role", "underscores its importance"): keep the fact, drop the dressing, end on the last concrete detail.
- -ing riders tacked on to sound deep ("..., highlighting its importance", "..., ensuring reliability", "..., reflecting a commitment to"): cut the rider unless the source supports what it claims.
- Vague links ("associated with", "tied to", "linked to"): name the relationship.
- Sales language (groundbreaking, renowned, profound, rich, breathtaking, stunning, "a diverse array"): say what the thing is.

## Leftovers from chat and draft

Read when: about to send a reply or file any text.

- Knowledge-limit disclaimers and plausible guesses ("as of my last update", "while specific details are limited", "it is believed that", "likely studied"): say what the source does not show, or nothing. A guess never ships as a fact.
- Writing about the draft itself ("this was generated from", "updated to reflect") belongs in the commit message, never the text.
- A list of bold labels with colons is usually prose in disguise: write sentences. No horizontal rules between sections, no arrows in headings, no top heading that repeats the document's title.

## Rewriting a draft

Read when: about to rewrite text that reads as machine-made, yours or another agent's.

1. Read it once and mark every tell above, strongest first, paragraph-scale ones included (every paragraph the same length, every one ending on a closer).
2. Draft the rewrite. Keep every supported claim; shorten, merge, split or reorder freely. Add no fact, name, number, date, quote or citation the source lacks; if a detail is missing, ask or write a simpler sentence.
3. Read it aloud; confirm no claim was added or dropped; search for the tells that survive a first pass (not-X-but-Y, one-line closers, triads, dashes, decorative bold).
4. Write the final version around each paragraph's main idea, not as a patch per pattern.

Voice: with a sample of the writer, match its sentence length, word choice, punctuation and openings; the sample overrides these rules. Without one, a chapter or board item stays plain and neutral, a reply to the owner direct.
