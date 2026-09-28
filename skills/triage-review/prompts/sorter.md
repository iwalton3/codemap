# The sort

*Sort a round of review findings: deduplicate them, and put each item in one group. This file is
the whole of the sorting rules, and **both sorts use it** — the session's own
(`steps/2-sort.md`) and the blind second sort (`steps/1-blame.md`). The arbitrator is given it for
the definitions (`steps/4-route.md`). Nothing about any one run belongs here: where each sorter
writes its sort, and what it may see, is in the file that launches it.*

**Deduplicate, then group.** The same claim reported twice — by two reviewers, or twice by one —
becomes one item. Each item names the findings it covers, by number: `covers F4, F30`. A finding
may be covered by more than one item, where it makes more than one claim. Put each item in one
group.

The first four definitions are the skill developer's, verbatim. The two `pin-defs` regions below are kept
**byte-identical to `references/shared.md`**'s *The groups*.
**The point of the pin is to force the sort to use the same finding categories as the contract, and
not let the prose drift** — nothing more. The defect-pattern rule that falls between the two regions
is deliberately outside the pin: the two files state it differently, and converging them is not this
pin's job.

<!--pin-defs-->
1. **Implementation defect:** "We know what we're doing, we know where and why it's wrong, there is
   one correct, obvious, and isolated way fix it." It is for "the mechanical stuff like 'we forgot
   a tenant check on this endpoint' or 'we don't check the file exists before trying to rename
   it'". Two kinds:
   - **Isolated defect** — one site.<!--/pin-defs-->
   - **Defect pattern** — the same mechanical defect at several sites.<!--pin-defs-->
2. **Design defect:** "We designed something. It causes a problem downstream. A proposal is
   needed."
3. **Assumption:** "Past code made an assumption documented nowhere. The assumption either broke
   or doesn't hold up elsewhere. A proposal is needed."
4. **Design suggestion:** "The design is questionable and might deserve a change." Only that —
   might be worth doing.<!--/pin-defs-->
5. **Invalid**, and it names *why* it is refuted:
   - **wrong** — contradicted, with the command or line that shows it;
   - **assumed** — the finding assumed X; Y is true. This is the rot vector the whole skill
     exists for: a finding standing on the reviewer's own unstated assumption;
   - **out of scope** — true, but it does not serve what the document is for. State it as what
     *the reviewer wanted*: "wanted to turn an elicitation document into a system-state report."
     Naming their implicit goal is what shows the finding is mis-aimed rather than wrong. **Only on
     a document with a stated purpose**: never on code, and never where the purpose is `not stated`.
     Which group such a finding goes to is decided by the definitions above.

**Defect patterns.** The same mechanical defect at several sites is still a mechanical defect.
What changes is where it is decided: **it is not fixed as a courtesy, it is ruled on in the plan,
and the default decision is to fix it at every site.** Count the sites before sorting — grep the
pattern, not the site.

A pattern is *evidence* that a design rule may be missing, not proof of one: often, but not
always. So the plan's question is only *does this pattern mean a rule is missing?*, and **"no, just
fix them" is a first-class answer**, not a failure to look harder. The skill developer's own examples: "we can
keep fixing sql injection, or we can switch to prepared statements" — keep fixing is the default,
and prepared statements has to earn the switch — and "tenant isolation failing because the check
happens per-module and not in a database repository helper", which is not a wrong call repeated but
a correct check placed at the wrong level.

**In both, the higher-order fix is a change to the code's design.** That is the test for whether a
cluster is a pattern at all: where the higher-order fix would be a change to *process* rather than
to the code, the sites resemble each other without sharing a defect, and it is not one. Findings
that merely arrived the same way — the same day, the same commit, the same kind of oversight — are
a genus and not a pattern; grep the defect, not the circumstance.

**Group 1 otherwise fills with things that do not belong.** An item is *not* an implementation
defect, isolated or pattern, if any of these hold:

- **The fix needs a rule nobody wrote down**, or picks between two behaviours someone could want.
- **The only "why" is the reviewer's say-so.** It needs a requirement, the owner's words, the real
  system or a reference.
- **The fix changes behaviour something else relies on.**

On a document, the design is what it is for and how it is organised. Findings that add precision
or qualifications the reader does not need are suggestions where they are harmless, and group 5
*out of scope* where they work against a stated purpose.

**Per item, write:** the findings it covers; its group; for group 1 its kind, the sites counted
and the command; for group 5 its refutation; and what the "why" rests on.

While sorting, you will sometimes write a sentence about the work itself: a fix that was already
wrong once, a rule at more sites than named, growth against a stated limit. **Those sentences go
into the sort verbatim.** Past runs wrote exactly that warning and then carried on.
