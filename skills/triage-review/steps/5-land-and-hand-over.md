## Land the trivial fixes

**First, the plan's reach** (`references/contract.md` P1). Of each candidate fix, ask *"Is this fix
likely to be rewritten or invalidated by the plan?"*, against the design defects, assumptions,
defect patterns and disputed items in `sort.md`. A fix in a large file the plan barely touches is
outside it; one in calls the remaining items implicate is inside. There is no plan yet: where
unsure, it is inside.

**A fix lands now only when all of these hold** (`references/contract.md` P1): both sorters called
it valid and an isolated defect; it is not marked "don't fix early"; it is outside that reach.

Land each in the member that holds its lines, as its own commit whose message says it applies
findings from run `<RECORD's directory name>`, ending with `Review-round: <RECORD's directory name>`
in the same trailer block as any other trailer (`references/shared.md` C). For a versioned Artifact,
each lands as a new published version of the same Artifact instead — read it first, then publish to
its URL — its label saying in words that it applies findings from that run. Derive a check from the
finding's words and watch it fail first, where the project has tests. **For shared runs, verify repair adequacy independently** through
`references/codemap-workflow.md` before claiming shared closure. This is not another review round.
If shared verification becomes unavailable, retain reported/pending status and evidence.
Markdown-only runs record the ordinary repair outcome and evidence without shared verified closure;
missing codemap does not block landing or handover.

Append **what landed** to `RECORD/sort.md` — per fix one line, its commit or Artifact version, and
its check: the command that fails without the fix, what it did without the fix and what it does
with it, or `no check: <why>` (`references/shared.md` S2); and one clause on why the plan is
unlikely to rewrite it. The reproducer is what a later verifier
re-runs; a check watched and not written down is lost. Commit the record where it is in the working
tree (`references/shared.md` K2).

For shared runs, append the canonical finding/claim IDs, sort/evidence IDs and any verification
request/application IDs beside those outcomes. A native verification failure stays pending and
names its reason; committing a fix is not the application of a closure. Follow the capability mode
chosen at entry, then hand over the unresolved state as well as what actually ran.

## Hand over

Invoke `/ez-plan --round <RECORD>` in this session, with every `--spec` this run was given
(`references/contract.md` H), and stop when it returns. `ez-plan` writes the summary, decides with
the owner whether anything is left for a plan, and plans, discusses or hands off. Write no summary,
ask no planning question, and write no `plan.md` here.
