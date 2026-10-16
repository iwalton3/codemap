"""Owner ruling (2026-09-18): when a wording is deliberately retired, a test fails if it
comes back.

The dumbest way a prose artifact rots is literal resurrection — a rule changes at one site
and a stale copy of the old wording survives at another, or gets pasted forward from it.
The sweep reviewer agent finds these, but it costs a round trip and it only runs when
someone remembers to run it; four of the seven misses in the round that prompted this were
exact strings that had already been struck somewhere else.

This catches only that: a phrase that was removed on purpose reappearing anywhere in the
shipped artifact. It says nothing about semantic drift — a rule restated correctly in new
words passes here and is still the reviewer agent's job. Retiring a *concept* without
adding its wording here leaves this test silent, which is the expected division of labour
and not a gap to be closed by making the patterns cleverer.

**Adding to the list.** When a round retires a wording, add it with the round that did it
and one line on what replaced it. Never add a phrase that merely *should not* be written:
this list is for wordings that existed, were removed, and would be wrong to see again.
Removing an entry needs the same care as adding one — it is how a retired rule gets
un-retired by accident.

**Markdown files are matched after soft wraps are joined** (owner ruling, 2026-09-18:
"we should probably update the test to use markdown-style line normalization rules").
Before that, an entry's behaviour depended on where a line happened to break: a phrase
spanning a wrap was invisible, and — worse — an over-broad entry could sit one reflow away
from failing the suite on correct prose without anyone knowing. That was live. The entry
`"the session says so rather than"` did not match `contract.md`'s legitimate "there the
session says so rather than picking a side on the owner's behalf" **only** because the
wrap fell between "the" and "session".

Joining is per block, not per file: a run of soft-wrapped lines becomes one logical line,
but a heading, list item, table row, blockquote, fence or rule starts a new one. Without
that, two adjacent list items join and a phrase matches across a boundary that does not
exist in the rendered document. Non-Markdown files are matched as-is.
"""

import os
import re
import unittest

from _repo import SKILL_DIR

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The swept surface: the shipped skill, plus the files CLAUDE.md's sweep rule names.
# `ideas/` is the historical record and `breakfix-review/` is a different skill; a retired
# phrase is expected to survive in both, and in `.git/`'s round records.
EXTRA_FILES = ["dist/README.md", "DESIGN.md", "README.md", "CLAUDE.md", "AGENTS.md"]
# ez-plan shares the contract (references/shared.md) and is swept with triage-review.
EXTRA_DIRS = ["ez-plan"]

# phrase -> (round that retired it, what replaced it)
RETIRED = {
    "before drafting or handing off": (
        "2026-10-02-planning-only-rule",
        "ez-plan Z9: the record is written when the skill starts, once the topic check passes (W2)",
    ),
    "one write made just before drafting": (
        "2026-10-02-planning-only-rule",
        "DESIGN.md quotes the owner's D1 ruling: once when the skill is started (W8)",
    ),
    "launch the drafter — except on a planning-only conversation": (
        "2026-10-02-planning-only-rule",
        "Z12: on a planning-only conversation, draft the full plan yourself (W7)",
    ),
    "on a planning-only conversation, everything still current": (
        "2026-10-02-planning-only-rule",
        "Z7: a later discussion appends to the start-time record (W4)",
    ),
    "neither enumerated the work items nor checked": (
        "2026-10-02-planning-only-rule",
        "ez-plan Z9 / 1-input: \"did not both list the work items and check them\" (E1)",
    ),
    "nothing before planning this work": (
        "2026-10-02-planning-only-rule",
        "Z9 only: \"solely about planning this work, with no unrelated work or code review before "
        "it\" (N1)",
    ),
    "still offers Plan Later on length": (
        "2026-10-02-planning-only-rule",
        "DESIGN.md quotes D2: Plan Later on a lot of work during planning (H2)",
    ),
    "read both entries in `sort-a.md` and `sort-b.md`": (
        "2026-10-02-release-stack-and-auth-sweep, I9",
        "ez-plan 2-opening step 1 reads both readings where `sort.md` keeps them; the raw sorts go "
        "to nothing downstream of the arbitrator",
    ),
    "both entries' evidence": (
        "2026-10-02-release-stack-and-auth-sweep, I9 sweep",
        "contract.md Z14: \"both readings' evidence\"",
    ),
    "<records repo>/.git/": (
        "2026-10-02-release-stack-and-auth-sweep, I6",
        "the run record under `$(git rev-parse --git-common-dir)`, or a CLAUDE.md destination",
    ),
    "run record in `.git/reconsolidate/`": (
        "2026-10-02-release-stack-and-auth-sweep, I6",
        "reconsolidate's *Where records live*: `reconsolidate/<date>/` under the common directory",
    ),
    "Done with this pass": (
        "2026-10-01 ez-plan page, owner: drop the button",
        "the page's Done button; it wrote passes/<round> but nothing woke the yielding session, "
        "so the owner tells the session instead",
    ),
    "press Done": (
        "2026-10-01 ez-plan page, owner: drop the button",
        "the page's lede: \"Tell the session when you're done with a pass.\"",
    ),
    "Start Planning Now": (
        "2026-09-30 ladder redesign of ez-plan",
        "the opening's planning options are Plan with Questions and Plan with Artifact (Z5); "
        "\"Start Planning Here\" and \"list form\" are not listed because DESIGN.md's history "
        "quotes them under superseded notes",
    ),
    "walk through decisions, a subagent drafts": (
        "2026-09-30 ladder redesign of ez-plan",
        "the Start Planning Here line; replaced by the two planning modes' lines (Z5)",
    ),
    "pattern fixed at every site": (
        "2026-09-30 triage-review redesign, after the page-sweep trial",
        "only isolated defects land early; a pattern is settled in the plan, through the coherence "
        "check",
    ),
    "keep fixing is the default": (
        "2026-09-30 triage-review redesign (session 3f902e76)",
        "a pattern reaching the plan is put as its level-5 fork, each fix with its cost and none "
        "the default; fixing every site is one option",
    ),
    'os.path.basename(records) == "triage"': (
        "2026-09-21-rule-sweep",
        "the declaration is the discriminator, not the directory's name: the caller passes "
        "--records-undeclared for the one case nobody named. A name could carry this only "
        "while the skill chose the name",
    ),
    "Which one depends on --records' name": (
        "2026-09-21-rule-sweep",
        "the same retirement, in the comment that documented it",
    ),
    "untracked: the findings, both sorts": (
        "2026-09-21-rule-sweep",
        "dist/README.md's record entry: a record in the working tree is committed as it is "
        "written, so 'untracked' is true only of the default location",
    ),
    "`RECORD` is in its\n  common dir and the report in its working tree, as for code": (
        "2026-09-21-rule-sweep",
        "references/artifacts.md asserted the pre-override path where it meant to defer; it "
        "now points at contract.md's The files, which carries the override",
    ),
    "`.git/` is outside that, `.git/triage/` included": (
        "2026-09-21-record-destination",
        "the lens reader's boundary is stated by what the record holds, not by where it "
        "sits: a CLAUDE.md can now put it in the working tree, where this phrasing would "
        "let the reader open the stuck session's own account",
    ),
    "where its `HEAD` is no longer the tagged sha, stop the same way": (
        "2026-09-21-record-destination",
        "the tag also stands where it is an ancestor of HEAD and every changed path is "
        "under RECORD; the bare form stops every resumed diagnosis whose record is "
        "committed in the working tree",
    ),
    "and a `HEAD` that has moved is a tree that changed under the run": (
        "2026-09-21-record-destination",
        "D6's half of the same rule -- 'Any other HEAD that has moved', after the "
        "ancestry case above",
    ),
    "`references/contract.md` P2)": (
        "2026-09-21-p2-split",
        "P2 was split into P2.1-P2.11 with an index at its head; a citation names the "
        "sub-rule it means, because a bare P2 resolves to 230 lines and 11 subjects",
    ),
    "(`P2`)": (
        "2026-09-21-p2-split",
        "the same retirement, the contract's own internal citation form",
    ),
    "both carriers": (
        "2026-09-18-conformance-implementation-review",
        "P4 names the trailer and the message; 'both' read as trailer-vs-Artifact-label "
        "and both sorters took it that way",
    ),
    "both of `P4`'s carriers": (
        "2026-09-18-conformance-implementation-review",
        "same retirement, the fully qualified spelling",
    ),
    "Two rules survive it": (
        "2026-09-18-conformance-implementation-review",
        "the breakpoint states one exclusion and an explicitly non-exhaustive reminder",
    ),
    "and no others": (
        "2026-09-18-conformance-implementation-review",
        "the survivor list is a reminder, not a closed set",
    ),
    "what survives at node 9, and nothing else": (
        "2026-09-18-conformance-implementation-review",
        "node 20's mirror of the same closed list",
    ),
    "verbatim, always": (
        "2026-09-18-conformance-implementation-review",
        "the record is triggered by a planner needing it, not by the discussion happening",
    ),
    "only the owner overrides it": (
        "2026-09-18-conformance-implementation-review",
        "'don't fix early' stops blocking inside the interrupt and becomes a disclosure "
        "trigger at the gate",
    ),
    "19 nodes": (
        "2026-09-18-conformance-implementation-review",
        "node 20 was appended",
    ),
    "Size, read bimodally": (
        "2026-09-18-conformance-implementation-review",
        "replaced by whether multiple choice would devolve into the 'Other' field",
    ),
    "exempt from `P5`": (
        "2026-09-18-post-rulings-review",
        "the opening choices come before the phase P5 governs and need no exemption",
    ),
    "write the handoff at the end of this file": (
        "2026-09-18-post-rulings-review",
        "the handoff is written in steps/plan-2-plan.md, under node 13",
    ),
    "the handoff is written at the end of this": (
        "2026-09-18-post-rulings-review",
        "the handoff is written in steps/plan-2-plan.md, under node 13",
    ),
    "runs only the tree survey": (
        "2026-09-18-post-rulings-sweep",
        "the resumed entry re-runs node 2's tree survey and node 3 with it; "
        "'the tree survey' is the contract's name for node 2 alone",
    ),
    # The option lines are the picker's own verbiage; they are not restated beside it.
    "The three lines are printed in the message": (
        "2026-09-18-post-rulings-sweep",
        "the three lines are the options' labels and descriptions in the picker",
    ),
    "Print these three lines in the message": (
        "2026-09-18-post-rulings-sweep",
        "the table is the picker's verbiage, not a table restated beside it",
    ),
    "Print both lines in the message": (
        "2026-09-18-post-rulings-sweep",
        "node 20's two lines are the picker's verbiage, not a table beside it",
    ),
    # The breakpoint's guardrails are honoured, not recited to the owner.
    "skill read as no rules left": (
        "2026-09-18-post-rulings-sweep",
        "the rules still bind; the session does not announce them at the breakpoint. "
        "Re-cut from 'say so rather than letting a', which named nothing retired",
    ),
    "leaving the owner to assume a stopped skill has no rules left": (
        "2026-09-18-post-rulings-sweep",
        "same retirement, the contract's spelling. Re-cut from 'the session says so "
        "rather than', which matched correct prose in P6 once wraps are joined",
    ),
    "the same reminder is owed": (
        "2026-09-18-post-rulings-sweep",
        "no reminder is owed; node 20 mirrors node 9 in not reciting them",
    ),
    # The breakpoint's boundary is ceremony-off/protections-on, never named as `P5` whole.
    "`P5` stops here": (
        "2026-09-18-post-rulings-sweep",
        "the breakpoint suspends the ceremony and not the protections",
    ),
    "`P5` stops at it": (
        "2026-09-18-post-rulings-sweep",
        "same retirement, node 20's spelling",
    ),
    "`P5` does not survive the breakpoint": (
        "2026-09-18-post-rulings-sweep",
        "only the four drafting checks stop; the claim check and self-containment do not",
    ),
    "does not lapse when `P5` does": (
        "2026-09-18-post-rulings-sweep",
        "same retirement, the standing duty's spelling in plan-1",
    ),
    "Inside the Discuss First interrupt, none of this applies": (
        "2026-09-18-post-rulings-sweep",
        "it reads over self-containment and the claim check, which do not stop there",
    ),
    "that is the one exclusion": (
        "2026-09-18-post-rulings-sweep",
        "there is not one exclusion; the split is ceremony against protection",
    ),
    "`P5` begins after the choice": (
        "2026-09-18-post-rulings-sweep",
        "P5's four checks begin after the choice; the rest of P5 is not phase-bounded",
    ),
    # Node 9 holds only the choice.
    "node 9, like the other rulings": (
        "2026-09-18-post-rulings-sweep",
        "node 9 is the discuss split; the choice is the only thing ruled there. Re-cut "
        "from 'like the other rulings there', which named neither node 9 nor the choice",
    ),
    # A cancelled run's owner.md is suspended, not barred.
    "rulings are not transcribed either": (
        "2026-09-18-post-rulings-sweep",
        "the requirement is suspended, and owner.md may still be updated",
    ),
    # The trailer's value is stated in P4 and in plan-1; P4 never claimed otherwise truthfully.
    "directory name \u2014 said once": (
        "2026-09-18-post-rulings-sweep",
        "P4 states the value; plan-1 states it too, so 'said once' was never true",
    ),
    # Descriptions render; previews do not.
    "only in an option's description": (
        "2026-09-18-post-rulings-sweep",
        "only previews fail to render, and only on mobile. Re-cut from 'description or "
        "preview', which missed plan-1's backticked spelling -- the site being fixed",
    ),
    "for what a description does not render": (
        "2026-09-18-post-rulings-sweep",
        "descriptions render; the opening choices no longer print separately at all",
    ),
    "`references/contract.md` P2.": (
        "2026-09-22-plan-skill-split",
        "planning moved to ez-plan; P2.1-P2.12 are ez-plan's Z rules (DESIGN.md's ID map)",
    ),
    "`references/contract.md` P3": (
        "2026-09-22-plan-skill-split",
        "the summary and planning questions are ez-plan's Z3 and Z10",
    ),
    "`references/contract.md` P4": (
        "2026-09-22-plan-skill-split",
        "the trailer rule is references/shared.md C",
    ),
    "`references/contract.md` P5": (
        "2026-09-22-plan-skill-split",
        "the drafting checks are ez-plan's Z10; the question protections are shared.md Q1-Q3",
    ),
    "`references/contract.md` P6": (
        "2026-09-22-plan-skill-split",
        "the fix-all guard is ez-plan's Z11",
    ),
    "`references/contract.md` P7": (
        "2026-09-22-plan-skill-split",
        "question altitude is shared.md Q3; supersession is K3",
    ),
    "`references/contract.md` E2": (
        "2026-09-22-plan-skill-split",
        "the tree survey is references/shared.md G1",
    ),
    "`references/contract.md` E3": (
        "2026-09-22-plan-skill-split",
        "git stops are references/shared.md G2",
    ),
    "`references/contract.md` R2": (
        "2026-09-22-plan-skill-split",
        "purpose is references/shared.md S1",
    ),
    "--resume-planning": (
        "2026-09-22-plan-skill-split",
        "resuming a plan is /ez-plan --resume <handoff.md>",
    ),
    "one line and commit": (
        "2026-09-22-decision-rounds",
        "what landed also carries each fix's check: the command, what it did without the fix "
        "and with it, or `no check: <why>` (references/shared.md S2)",
    ),
    "printed in the message one numbered item per line": (
        "2026-09-23-bulk-approval-multiselect",
        "bulk items are numbered in the question's own text, never the message above it "
        "(ez-plan references/contract.md Z10.2); since 2026-09-30 such items are decided and "
        "logged instead (Z14)",
    ),
    "`references/contract.md` D5": (
        "2026-09-25-diagnose-split",
        "D5 moved to references/diagnose.md",
    ),
    "`references/contract.md` D6": (
        "2026-09-25-diagnose-split",
        "D6 moved to references/diagnose.md",
    ),
    "`references/contract.md` D7": (
        "2026-09-25-diagnose-split",
        "D7 moved to references/diagnose.md",
    ),
    "`references/contract.md` , *Diagnosis questions*": (
        "2026-09-25-diagnose-split",
        "the diagnosis questions moved to references/diagnose.md",
    ),
    "never a spec, a plan item or something a build follows": (
        "2026-10-06-skills-spec-fit",
        "ez-plan Z6: the mock-up itself is never followed; what the owner rules from it is a plan item citing it",
    ),
    "the frame is what wants handing over, which is": (
        "2026-10-06-skills-spec-fit",
        "triager.md: /fable-bailout is deprecated pending a rewrite (owner, 2026-10-06: \"nothing should recommend it\")",
    ),
}


# A line that starts one of these begins a new block, so it is never joined onto the
# previous line: heading, list item, numbered item, blockquote, table row, fence, rule.
BLOCK_START = re.compile(r"(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---+\s*$|===+\s*$)")


def logical_lines(text):
    """Markdown soft wraps are spaces. Yield (first source line number, joined text)."""
    out, buf, start = [], None, None
    for lineno, raw in enumerate(text.split("\n"), 1):
        line = raw.strip()
        if not line or buf is None or BLOCK_START.match(line):
            if buf is not None:
                out.append((start, " ".join(buf.split())))
            buf, start = (None, None) if not line else (line, lineno)
        else:
            buf += " " + line
    if buf is not None:
        out.append((start, " ".join(buf.split())))
    return out


def line_of(path, text, phrase):
    """The source line a retired phrase reappears on, or None. Markdown is joined first."""
    if path.endswith(".md"):
        for lineno, line in logical_lines(text):
            if phrase in line:
                return lineno
        return None
    return text[: text.index(phrase)].count("\n") + 1 if phrase in text else None


def label_for(path):
    """Repo-relative where that is shorter — SKILL_DIR_UNDER_TEST points outside the repo."""
    rel = os.path.relpath(path, ROOT)
    return path if rel.startswith(os.pardir) else rel


def shipped_files():
    """Every file the sweep rule covers, as (repo-relative label, absolute path)."""
    for base, dirs, names in os.walk(SKILL_DIR):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in sorted(names):
            path = os.path.join(base, name)
            yield label_for(path), path
    for rel_dir in EXTRA_DIRS:
        for base, dirs, names in os.walk(os.path.join(ROOT, rel_dir)):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for name in sorted(names):
                path = os.path.join(base, name)
                yield label_for(path), path
    for rel in EXTRA_FILES:
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            yield rel, path


class RetiredPhrases(unittest.TestCase):
    def test_no_retired_phrase_is_back(self):
        found = []
        for label, path in shipped_files():
            try:
                with open(path, encoding="utf-8") as fh:
                    text = fh.read()
            except (UnicodeDecodeError, OSError):
                continue  # a binary or unreadable file carries no prose to check
            for phrase, (round_slug, replacement) in RETIRED.items():
                line = line_of(path, text, phrase)
                if line is not None:
                    found.append(
                        f"{label}:{line}: {phrase!r}\n"
                        f"    retired by {round_slug}\n"
                        f"    replaced by: {replacement}"
                    )
        self.assertEqual(
            found, [],
            "retired wording is back in the shipped artifact:\n\n" + "\n".join(found),
        )

    def test_the_list_itself_is_usable(self):
        """A phrase with no round or no replacement cannot be acted on when it fires."""
        for phrase, entry in RETIRED.items():
            self.assertEqual(len(entry), 2, f"{phrase!r} needs (round, replacement)")
            round_slug, replacement = entry
            self.assertTrue(round_slug.strip(), f"{phrase!r} names no round")
            self.assertTrue(replacement.strip(), f"{phrase!r} names no replacement")
            self.assertTrue(phrase.strip(), "an empty phrase matches everything")


if __name__ == "__main__":
    unittest.main()
