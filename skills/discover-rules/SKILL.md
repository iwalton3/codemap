---
name: discover-rules
description: Find the rules a codebase must obey that nobody on the project decided — natural laws, laws and regulations, and industry or vendor rules (solidity levels 1-3) — each with a citation that proves it, where it bites in the code or which path it forecloses, what would falsify it, and the past rulings it explains. Produces a record of the run and a document for the owner to approve, reject, and mark ratified or provisional; only approved rules are written to docs/rules/. Run before /reconsolidate, so rulings that follow from an outside rule are not mistaken for business rules or principles.
argument-hint: "<repo> [<repo>...] [--records <repo holding the planning records and docs/rules/>]"
---

A project's rulings mix three things: the outside world's rules, the business's rules, and the
owner's direction. Read cold, a ruling that follows from a regulation but never names it looks like
a business rule or a principle — the two layers only a human can write, and the most expensive to
keep. **This skill takes the outside world's share off the table first**, so what is left for
`/reconsolidate` is what actually needs the owner.

It is cheap because a level 1-3 rule needs no judgement to be true: **the citation is the proof.**
The owner's approval checks the transcription and whether the rule really reaches this system — not
whether the rule is wise.

## The levels this skill proposes

From the owner's solidity ladder (2026-09-29). Only these three:

1. **Natural law** — mathematics, physics, time. Cannot be bargained with.
2. **Law** — statutes, regulations, tax and financial-crime rules of a jurisdiction the business
   operates in, binding the business directly.
3. **Industry rule** — set by an industry body or a provider the system depends on: a standards
   body (e.g. IATA, ISO, a banking file format), a card scheme, a payment processor's policy, a
   vendor's published API contract. **A law that binds a partner, which the partner then requires
   of the business, is the partner's rule** — level 3, with the partner as its authority (the skill
   developer, on a bank's KYC: *"it is a vendor rule because the bank requires us to run their
   kyc"*).

Everything else is out of scope, and the skill drafts **no text** for it:
- **4, business rules** are human-written with their reason; they come from `/reconsolidate` or
  from the owner in conversation. A law the business follows by choice, with nobody requiring it,
  is one of these.
- **5, design rules** stay implicit.
- **6, principles** are the owner's alone, in `CLAUDE.md`.
- **7-8** are decisions and implementation, recorded in plans, commits and code.

## What makes a candidate

All of these, or it is not proposed:

- **An authority outside the project** — who decided, and the document and section.
- **A source the run actually read.** A repo `path:line` (any repo on the machine, named in full), a
  URL fetched this run, or a local copy of a document, kept as text in the run record's `sources/`
  so the quote can be re-checked later. Quote PDFs and long texts from a local copy:
  a web fetch that answers through a summariser is not a quote, and is marked as such if nothing
  better exists. Where the primary text is paywalled, a public restatement counts if it names the
  rule precisely; the entry names **both** the authority and who restated it. A level-1 rule's
  source is a standard reference (a units handbook, a spec's stated range) or the arithmetic itself,
  shown. A rule known only from the model's memory goes under *Needs a source* with what would
  settle it. Never invent a section number.
- **Where it bites** — the areas and repo paths that implement or depend on it, frozen code
  included — **or the path it forecloses**: a rule that reaches no code yet but rules out a
  solution an agent would plausibly reach for (the skill developer, on card surcharging: *"what-if
  rules govern where the code should go and forclose the easy solutions"*). A rule that reaches
  nothing and forecloses nothing an agent would try is not proposed.
- **A falsifier** — what someone would have to say or do for it to stop applying to this system:
  leaving a vendor, a jurisdiction, a business fact changing. Every rule has one; a ratified rule
  can still be falsified, it is only a bigger headache when it is.
- **Stated as the authority states it**, not as the code implements it. The code is evidence the
  rule applies; it is never the authority.

**Status is the owner's call.** The skill proposes no ratified or provisional; the owner marks it.
*Ratified* means not on the roadmap to change; *provisional*, interim and expected to change (the skill
developer).

Past rulings are **evidence, never authority** (the skill developer: *"rulings are usually
interactions between different system rules"*). A ruling a candidate explains is listed under it.
A ruling is not turned into a rule by rewording it.

One entry per **rule as the owner would approve it**: usually per standard or vendor contract,
quoting only the clauses that bite; split one where its clauses bite different areas.

## Steps

**0. Scope.** The repos named are one system and are read as one; do not split the work per repo.
The records repo (`--records`, else the one holding the planning records) holds the planning
records and `docs/rules/`. If `docs/rules/` exists, read `INDEX.md`, every area doc, and every
**Rejected** list: skip anything ratified or rejected, and propose again only with a new source.
Discovery is incremental. **Where the records repo is cut over** — its rules live in codemap and
`docs/rules/` is generated — steps 0, 4 and 6 change: `references/codemap-workflow.md`.

**Where records live.** The planning records are `triage/` and `plan/` under the records repo's
`$(git rev-parse --git-common-dir)`, plus every directory a `CLAUDE.md` names for `/triage-review`
or `/ez-plan`. Never a literal `.git/`: in a linked worktree that is a file, and the records are in
the main checkout's common directory. **The run record** is `rules/<YYYY-MM-DD>-discover/` under the
common directory, unless a `CLAUDE.md` names a destination for `/discover-rules` by name, which
supersedes it. Any `CLAUDE.md` the session was given counts, the user's global one included; a
relative path is relative to the records repo's working tree root, and a run record in the working
tree is committed as it is written. Some shells wrap `grep` to skip `.git` and ignored files, which
hides these records without an error; use `command grep` or `rg --no-ignore --hidden`, and check a
search of its `triage/` returns hits before trusting an empty one. A run record never goes under
`docs/rules/` in a cut-over repo (`references/codemap-workflow.md`).

**1. Areas.** Name the system's areas the way its code and specs do (e.g. *the money plane*, *the
invoice system*); where the code names none, coin one and say so, for the owner to rename. An area
can span repos. Rules that reach every area are **system-wide**.

**2. Harvest.** Search every repo — code and its comments, specs, docs, decision tables, and the
planning records, committed and in the stores above — for outside authorities:
standards, regulations, schemes, processors, file formats, jurisdictions, and vendor contracts.
Start from names (`IATA`, `ISO`, `PCI`, `VAT`, `regulation`, a vendor's name…) and read around the
hits; a rule stated across a line break is invisible to grep. Specs and code comments usually carry
the outside reason; rulings rarely cite one, but a ruling that reads like a constraint with no
reason is worth tracing. Follow a vendor or partner to its docs wherever they sit, other repos
included.

**3. Verify.** For each candidate, find its source. Web lookups may name only the public authority
and the rule — **never the project's code, data or business details.**

**4. Sort into the record.** Write `candidates.md` in the run record, incrementally as entries are
confirmed:

- **System-wide**, then **one section per area**, each rule in the entry format below plus two
  record-only lines: `Explains:` (rulings and decisions, by reference) and `Read this run:` (every
  source consulted, and how — local copy, fetch, summariser).
- **Level unclear** — the owner places it: an outside party's design the system depends on, which
  may count as a business rule (3 or 4), or a law the business may follow by choice (2 or 4).
- **Needs a source** — believed, not found.
- **Conflicts** — code, a plan or a ruling that contradicts a candidate, with both `path:line`s, and
  whether it is a **recorded deviation** (the code or a ruling says it is deliberate) or not. An
  unrecorded one goes to the owner first: **a plan that breaks a level 1-3 rule is wrong** unless
  the owner accepts the deviation.
- **Gaps** — code that omits what a rule needs without contradicting it (a mock that always passes,
  a check never made). Listed under the rule they belong to.
- **Considered, not proposed** — one line each, with why: true but reaches nothing and forecloses
  nothing. The next run skips them unless the code has moved.
- **Counts**: candidates per level, conflicts, rulings explained.

**5. Put it to the owner.** Publish the candidates as a Claude doc (the docs connector, or an
artifact where there is none), grouped the same way, **one block per rule with its marks first** —
in a table the mark columns land off-screen. Each rule shows its falsifier and asks:
approve or reject, **ratified or provisional**, and room for a reason. Level-unclear items ask for a
level. **The doc is a reading surface, not the record.** Unrecorded conflicts are raised in the
conversation, not left in the doc.

**6. Write what was approved.** Only after the owner's marks. In a cut-over repo nothing is written
to `docs/rules/`: `references/codemap-workflow.md`, *Writing*. Read them back from the doc (the
docs connector's read, or the artifact's store): each rule's decision, status and note, the level
placed on each level-unclear item, and any note typed beside a *Needs a source* item. **A note that
changes a rule's wording or level wins**, quoted verbatim with the date; a note on a *Needs a
source* item is appended to it in the run record. Then:
- approved rules into `docs/rules/` in the records repo, entry format below — **except an item the
  owner placed at level 4**, which is not written. Its text is the agent's, and a business rule is
  written only in the owner's words (the skill developer, quoted at the head of `/reconsolidate`). It
  goes to the run record's **For `/reconsolidate`** list, with its source and the owner's note;
- rejected ones into the **Rejected** list of their area doc, with the owner's reason if given;
- `INDEX.md` created or updated: system-wide rules, then the areas, each pointing to its doc;
- the records repo's `CLAUDE.md` pointing at `docs/rules/INDEX.md` as must-read, and each other
  repo's `CLAUDE.md` pointing at the records repo's docs, if they do not.

Unmarked candidates stay in the run record and are not written.

## docs/rules/ entry format

```markdown
### <short name> — ratified | provisional
Rule: <as the authority states it, or the owner's actionable wording, marked as theirs>
Level: <1 natural law | 2 law | 3 industry rule>
Authority: <who decided>, <document, section>[; restated by <whom>]
Source: <URL, local document, or repo path:line quoting it>
Applies at: <repo/paths, or the path it forecloses>
Falsifier: <what would make it stop applying to this system>
Deviations: <optional: where the system knowingly does not follow it, why, who accepted it>
Gaps: <optional: what the code omits without contradicting the rule>
Rests on: <optional: a rule this one applies only because of>
Built on it: <optional: plans, areas or other rules that assume it>
```

More than two deviations go to a file beside the area doc, `<area>-deviations.md`, and the line
points to it. A rejected entry is one line: `- <short name>: <rule> — rejected <date>[: <reason>]`.

## Standing duties once rules exist

- A rule found wrong, refuted, or whose falsifier someone states **goes to the owner at once**,
  with everything listed under *Built on it*.
- A new outside rule met while working is offered to the owner then and there, with its source.
