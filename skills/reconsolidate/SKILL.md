---
name: reconsolidate
description: Consolidate the owner's past decisions into the durable layer, days after the work. Reads the project's rules (docs/rules/) and principles (CLAUDE.md PRINCIPLES), finds the owner's answers those do not explain — the residuals — clusters them by what the owner did, and puts the clusters to the owner sorted into probable business rules, probable principles, and uncertain. The owner names each in their own words or calls it a one-off; the skill never drafts a rule or principle. Named principles go into CLAUDE.md's PRINCIPLES section, named business rules into docs/rules/ — or, where the repo's rules live in codemap and docs/rules/ is generated, into a codemap draft spec for the owner to ratify. Run after /discover-rules.
argument-hint: "[<repo> ...] [--since <date or record>] [--records <repo holding the planning records>]"
---

An agent carries nothing between sessions except what is written down, and a planning record is an
episode: what was asked, what the owner said. Kept whole and all binding, episodes pile up, and
the agent overfits to them. **This skill is consolidation: it keeps what the episodes taught and
lets the rest go.** It runs a few days after the work, because in a round the owner is answering at
the altitude of the case, and days later the pattern is what is left.

It never authors the durable layer. **The owner names what they did; the skill finds the cases and
puts them side by side.** An agent's draft of a principle, ratified by the owner, is the code
defining the rule that judges it, and it is the pile this skill exists to stop (the skill developer:
*"I didn't want to escalate arbitrary agent text as a ruling only as a decision that was
approved"*).

## Before it starts

**`docs/rules/` must exist.** Run `/discover-rules` first. Otherwise every answer that follows from
an outside rule without naming it looks like a business rule or a principle, the two expensive
layers (the skill developer: *"We need to discover the system rules levels 1-3 before we can discover
#4 (business rules) and #6 (principles)"*). If it is missing, say so and stop — **unless the
records repo is cut over** (its rules live in codemap and `docs/rules/` is generated from them):
then `references/codemap-workflow.md` says where the rules are read and written.

**Where records live.** Records are under the records repo's `$(git rev-parse --git-common-dir)`,
never a literal `.git/`: in a linked worktree that is a file, and the records are in the main
checkout's common directory. **The run record** is `reconsolidate/<YYYY-MM-DD>/` under the common
directory, unless a `CLAUDE.md` names a destination for `/reconsolidate` by name, which supersedes
it; the planning records are `triage/`, `plan/` and `diagnose/` there, plus every directory a
`CLAUDE.md` names for `/triage-review` or `/ez-plan`; `/discover-rules` run records are `rules/`
there, or where a `CLAUDE.md` names a destination for `/discover-rules`. Any `CLAUDE.md` the session
was given counts, the user's global one included; a relative path is relative to the records repo's
working tree root, and a run record in the working tree is committed as it is written.

Read, in the records repo:
- `docs/rules/INDEX.md` and every area doc: the rules, levels 1-4, rejected lists included;
- `CLAUDE.md`'s `## PRINCIPLES` section, if there is one;
- the last run record, for where the last run stopped and for the clusters it **tabled**, which come
  back on this run's page (new cases added) until someone names them;
- the **For `/reconsolidate`** list in each `/discover-rules` run record since the last run: items
  the owner placed at level 4 there, which `/discover-rules` does not write. Each goes on this run's
  page as a *probable business rule*, its source and the owner's note as its cases, and is written
  like any other only in the owner's words.

**Scope** is everywhere a human's words were recorded since the last run (`--since` overrides):
`owner.md` files, plans, handoffs, triage and diagnosis records (`sort.md`, work-item and open-item
lists), postmortems and verbatim records, in the planning records above and committed. **Count
each answer once**: a committed copy of a record under the common directory, or the same answer
quoted in a later record, is the same answer. Some shells wrap `grep` to skip `.git`; use
`command grep` or `rg --no-ignore --hidden`, and make sure a search of the common directory's
`triage/` finds something before trusting an empty result.

**Who is speaking.** A project may have several people acting for it in a chain (for example: the
business, then a lead, then the engineers). Tag every case with who said it, and
mark a tag you inferred rather than read as inferred. Someone lower in the chain may not be able to
turn a cluster into a rule or principle; that cluster is **tabled** for whoever holds it (step 3).

## 1. Find the residuals

Take **only the humans' words**: answers, redirects, notes typed past the options, and input nobody
asked for. Session text, option labels and plans are not theirs, even when they picked them.
**One answer is one question answered**: a reply to several numbered points is one answer per
point, and a bulk approval of N items is N answers matching the recommendation, less any item the
reply changed. For each answer, ask whether it was **explained**:

- **By a rule**: a rule in `docs/rules/` predicts it. Cite the rule; it is not a residual.
- **By a principle**: a principle in `PRINCIPLES` predicts it. Cite it; not a residual.
- **By the recommendation**: the owner picked the option the session recommended, or agreed with no
  addition. The prediction held; not a residual (the skill developer: *"Did the user pick
  (Recommended) is a test"*). **Where the record doesn't say which option was recommended**, the
  pick is *unknown*: count it apart, and report the rate both with it as explained and without it.

**Measure against what is written today.** On a first run every rule postdates the answers, so
"explained" and "contradicted" mean by the rules and principles as they now stand, and the page
says so.

Everything else is a **residual**:
- picked something other than the recommendation;
- typed past the options: added, widened the frame, or answered the question behind the question;
- redirected the session;
- answered with a principle;
- contradicted an earlier decision later on (a delayed miss);
- **disagrees with a rule or principle as written today.** This is a residual of its own kind. It
  goes to the owner as one question, *"what distinguishes these?"*, never as a new principle.

Rulings are usually **interactions between rules** (the skill developer). Before calling one a
residual, check whether two rules together explain it.

## 2. Cluster by what the owner did

Group residuals by **the move the owner made**, not by the subject of the question. For example,
*"answered the purpose behind a concrete proposal"* is one cluster, whatever the proposals were
about. A cluster needs two or more cases. A single case goes in *Singletons*.

Sort each cluster into one of four sets. **This is the skill's guess; the owner decides.**
- **Probable business rule** (level 4): the owner states something the business requires or will
  not do, with a reason from outside the code (the business, a customer, a partner).
- **Probable principle** (level 6): a direction the owner applies across cases that differ.
- **Probable doc material**: a fact, a definition, the state of the system. **Neither a wall that
  constrains an agent nor a pointer that guides one, so it belongs in a doc, not in rules or
  principles** (the skill developer: *"If it isn't a wall that constrains an agent and isn't a pointer
  that guides the agent, it should go in a doc not rules/principles."*).
- **Uncertain**: more than one could fit, or none.

**For each cluster, say whether it would be useful.** Give how many cases it covers, whether they
span rounds or areas, and whether the same kind of question is still being asked. A principle is
worth writing down for the future decisions it would settle (§6.7 in
`~/Desktop/temperature-and-geometry.md`). A cluster whose cases all come from one closed piece of
work may be only history, and the page says so.

With more than about eight clusters, group them under **overarching topics** as well.

## 3. Put it to the owner

Write the run record first:
- `clusters.md`: every cluster with its cases, each
  case with `path:line`;
- the explained answers, as counts per rule and principle, and the unknown picks;
- the residual count, and the residual rate: residuals out of all answers in scope, both ways where
  there are unknown picks, and per speaker;
- the tabled clusters carried in from the last run.

**The residual rate is the number that should fall** as the durable layer improves. Report it next
to the last run's.

Then publish an **editable Artifact** whose marks save to its own store. **`page.html` beside this
file is that page**: copy it, write the clusters as `clusters.json` in the shape it reads (a first
run's file is the example, in an earlier run record), and publish the page with the JSON as a
supporting file and `capabilities: {db: {}}`. Marks land in its `marks/<cluster id>` documents.
Change the page only where a run shows it wrong. It is laid out as follows:
- Clusters grouped by topic where there are topics, then by set.
- **One card per cluster, with its marks at the top.** In a table the mark columns land off-screen.
- The cases side by side on each card: **the situation, what the session expected, and what the
  owner said**, quoted with `path:line`.
- The skill's reason for the set, and its usefulness note.
- **Marks:** *Principle*, *Business rule*, *Goes in a doc* (with a box for which doc), *Table for
  later* (with a box for who holds it), *One-off*, *Not a surprise* (the clustering is wrong),
  *Discuss*.
- **An empty "In your words" box. The skill never fills it.**
- For a principle or business rule, a **"Same as"** box: other clusters, or an entry already
  written, that the owner's words cover too.
- For a business rule, a reason box (level 4 needs one), *ratified* or *provisional*, and a
  falsifier box: every rule has one, a ratified rule included.
- **Contradictions** (a residual against something already written) at the top, each with its
  *"what distinguishes these?"* box.

**Setting aside.** When the owner allows it, the skill sets aside clusters that don't need them:
process gaps (how the work is run, not the project; these feed the planning skills instead),
clusters an entry already written covers, one-offs, and open questions that are not decisions.
Each gets an `aside` reason in `clusters.json`, the page shows them collapsed at the bottom and
still markable, and the run record lists them. Nothing is deleted.

The page is a reading surface; the repo is the record. Republish it to the same path as the run
changes it (sets re-sorted, clusters set aside); the marks persist across versions.

## While the owner marks

**The skill yields while the page is open**, so the owner can mark in stages and talk about it.
When asked, read the marks so far and give a reading of them, **never wording**:
- clusters that could join, and principles already written that a new one would absorb;
- tensions with what is written, and the variable that separates them (the first run's case: two
  deferral principles pulled apart on how often the case occurs, then on the harm it could do);
- a rule sitting inside the owner's own remark, pointed at where it would explain a cluster (the
  first run's: "nothing in it actually moves money without a person", beside cluster C2);
- clusters that are really process — how the work is run, not the project;
- a field the write-back will need that is still empty.
In the first run this conversation did more than the page did: the owner's words got sharper
between marks, and the principles written were the ones the discussion shaped.

## 4. Write what was named

Read the marks back from the Artifact's store. **A cluster with no words from the owner is not
written, whatever its mark**, and **one missing a field the entry needs** (a business rule's status
or falsifier) is asked about, not guessed. Then:

- **A principle** goes into `CLAUDE.md`'s `## PRINCIPLES` section, **verbatim**, with the date, and
  the run and cases it came from in one line. New principles go at the end unless the owner gave a
  place; **the order is the priority** when principles pull against each other. **A principle that
  holds beyond this project** belongs to the owner's global `~/.claude/CLAUDE.md` and the copies of
  it they ship, which **the owner manages: the skill says which principle looks cross-project and
  writes there only when asked** (the skill developer: *"For global claude.md, that's territory where
  it only goes in there if the user asks"*). Its provenance line names repos, not absolute paths.
- **A business rule** (in a cut-over repo: `references/codemap-workflow.md`) goes into `docs/rules/`
  in the format `/discover-rules` defines: level 4, the
  owner's words as the Rule, the owner's reason as the Authority, and a falsifier. It goes into the
  area doc it governs, or into `INDEX.md` if it is system-wide.
- **Doc material** goes, in the owner's words, into the doc they named; with no doc named it is
  listed in the run record for a later docs pass.
- **A tabled cluster** is recorded in the run record with who holds it, and comes back on the next
  run's page until it is named or dismissed.
- **A one-off** is recorded in the run record only.
- **Not a surprise** is recorded in the run record with the owner's note, so the next run does not
  cluster those cases the same way.
- **Joined clusters** (the "Same as" box) are written once, in the words given on any of them,
  with every cluster's cases as provenance. Joining an entry already written **replaces** it with
  the new words; the old wording is kept in the run record, not in the file. A cluster marked the
  same as another but with no words of its own is covered by that one, not dropped.
- **A contradiction answered**: the distinguishing variable goes into whichever entry it refines,
  in the owner's words. The superseded wording is kept in the run record, not in the file. One
  marked *not a surprise* with a note (a known conflict left open on purpose) goes on the rule's
  `Deviations` line as known and unreconciled, with the note and what it waits on.
- **Discuss**: the owner's note is recorded verbatim in the run record, with whatever the
  conversation settled. Notes that name a process gap go under **For the planning skills**, where
  their redesign reads them.

A project's `## PRINCIPLES` section opens with this line and nothing else writes there:

> Written only by `/reconsolidate`, in the owner's words, in priority order. To change one, run it.

**Keep it small enough to read.** A principle helps only while every session reads all of them, and
a list nobody finishes delegates nothing (§6.9's first property). When a run would take the section
past about fifteen principles, or past a screen, the page gains a **Consolidate** set: principles
that could merge, principles no case has cited since they were written, and principles that pull
against each other with no order between them. The owner merges, retires or reorders them in their
own words. **Forgetting on purpose is part of consolidation.**

Close the run record with `writeback.md`: what was written where, what was tabled and for whom,
the discussed notes, and **how the set guesses held** — for each set, how many clusters the owner
marked as guessed. The skill's sorting improves only if that is counted.

Commit the edits to `CLAUDE.md` and `docs/rules/`, naming the run. In a cut-over repo only `CLAUDE.md`
is committed: the rules went to a draft spec.
