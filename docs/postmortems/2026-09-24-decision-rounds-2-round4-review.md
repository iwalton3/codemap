# Decision rounds: fourth-review diagnosis

## 1. Executive summary

Decision rounds should preserve people's answers and keep disputed findings out of ordinary work. From September 22 to 24, a rebuild and four review rounds revised answer precedence, holds, reader verification, and historical evidence. The fourth review produced nine distinct items across ten findings. The three Codex review lenses noticed the loop; the measurement came afterward.

The repairs made a possible conflict into a work hold without settling who decides that two answers mean different things. A separate reader brief omits parts of the question that the full answer identity includes. The owner later ruled that equivalent meaning, judged by a reader, needs no block. The mechanism is a conflation of possible and established conflict; the owner's criterion was available but reached this run late. The owner is asked to decide the authority boundary before a new implementation plan.

## 2. What doesn't add up

1. **NOTICED, both readers reached related sides.** Two answers with the same words and finding effects may mean different things, yet the finder discards the pair; two different wordings may mean the same thing, yet can create a hold before semantic judgment. Lens A discovered the first; lens B read the second from owner.md and checked code. Evidence **CONFIRMED**: docs/decision-rounds-worked-cases.md:1353; src/shared-decisions.ts:1078-1079,1329-1331. This goes away if the owner permits mechanical classification of both cases or a semantic reading governs both.
2. **NOTICED, only lens B reached it.** Two prompts can share question text and option labels while differing in descriptions and effects; the reader sees only the shared portion. Evidence **CONFIRMED**: src/shared-decisions.ts:146-149,352-368. This goes away if omitted details cannot change interpretation or the reader receives them.

Lens A found no further cardinality, discriminator-decay, or second-authority entry. Neither reader invented a new lens. The two readers did not clear each other's exact relationship; no factual reader dispute was dropped.

## 3. Decision requested

**Owner choice: when may a possible conflict hold work?**

- **Settle boundary first — recommended.** Rule on concrete cases, then commission a new plan. Costs delay and forfeits quick patches; it does not assume a repair shape.
- **Keep automatic holds.** Accept false holds until a semantic release path exists. Costs queue noise and temporarily forfeits the owner's no-block treatment of equal meaning.
- **Partially roll back d763557.** Re-derive its intent-to-hold portion after a ruling while preserving independent admission/receipt work and tests. Costs rework and temporarily loses automatic conflict surfacing.

Without a decision, candidates continue to hold work. The recommendation follows owner-late.md:3-5 and src/shared-decisions.ts:1064-1066,1329-1331.

## 4. Timeline

- Worked cases and owner marks preceded code (341b4fb through 21cb228; command: git log --oneline 161d754..d763557).
- The rebuild at 11b030d was followed by ranking and hold repairs at 270243a and e8394bb; command: git show --stat 11b030d 270243a e8394bb.
- Later reviews changed reader verification, briefs, confirmations, and validation at 7dae9b2, 1428efd, af773df, and 8673c16. Prior round accounts exist in evidence/prior.md; this is not an edit-by-edit reconstruction.
- The current Codex-round plan drove 88ff0cb, 3b1f958, f22ffed and d763557. Three review lenses at d763557 found the current nine items (sort.md, Round and route; command: git show --stat d763557). No in-flight commit exists.

## 5. Diagnosis

**Domain assumptions for the owner to mark wrong:** Independent teammates' accepted answers both remain visible after their events meet. Differently worded answers judged to mean the same finding and concrete implementation outcome need no hold. A recorded reading remains evidence of the brief its reader saw after later events arrive.

**ARGUED mechanism: concept conflation.** A possible conflict and an established action-stopping conflict answer different questions. The candidate record itself says human knowledge is not established, yet the hold path treats every candidate as undecided (src/shared-decisions.ts:1057-1065,1329-1331; command: rg -n 'intentCandidates|heldFindings' src/shared-decisions.ts). The late owner answer says equal meaning, as judged by a reader, needs no block (owner-late.md:3-5). Widening F3's predicate or narrowing F10's predicate alone cannot settle this boundary. The fork is d763557. Reader-brief completeness is a separate population underreach.

Smallest scenario: two independent Yes answers to differently qualified questions affect one finding. Their effects match, but a qualification can change implementation intent. Conversely, two different wordings can mean exactly the same outcome. The candidate already carries source IDs, words and effects, but no stored semantic equivalence verdict (src/shared-decisions.ts:1057-1091; command: nl -ba src/shared-decisions.ts | sed -n '1057,1093p'). Owner judgment is needed.

**Evidence access:** The owner was available but unconsulted on this boundary before d763557. The plan called the pairs candidates, warned that equal effects do not establish equal meaning, and assigned comparison to an agent (.git/triage/2026-09-24-decision-rounds-2-codex-round-review/plan.md:74-84; command: rg -n 'candidate|identical outcome' .git/triage/2026-09-24-decision-rounds-2-codex-round-review/plan.md). The owner was consulted later (owner-late.md:3-5). Historical admission was already addressed in the plan (lines 38-68) but legacy evidence remains unprobed. Sort distribution: nine items; one undisputed design item C and one undisputed assumption I, seven classification disputes, with one-site readings for A, F and H (sort.md; command: rg -n '^### [A-I] —|Group [1235]|Site count:' .git/triage/2026-09-24-decision-rounds-2-round4-review/sort.md). The pattern is broader than isolated slips.

**Kill conditions for this diagnosis:**

1. The differently qualified Yes case can always be classified by stored effects alone.
2. Recovery needs only guards at known sites and no rule separating candidates from holds.
3. The owner can close the cases without ruling on reader-visible meaning or when uncertainty pauses work.

## 6. Believed versus actual

- **CONFIRMED:** Deposition guessed a candidate was being promoted to a hold; code confirms this. It matters because the queue changes before semantic judgment. src/shared-decisions.ts:1064-1066,1329-1331; command: nl -ba src/shared-decisions.ts | sed -n '1057,1093p;1318,1332p'.
- **CONFIRMED:** A full decision hash includes payload/options, while the independent reader receives only question and labels. This matters if descriptions/effects distinguish identical labels. src/shared-decisions.ts:146-149,352-368; command: nl -ba src/shared-decisions.ts | sed -n '146,149p;352,368p'.
- **CONFIRMED:** The deposition did not know whether the plan moved. Its current text already rejects word difference as proof of conflict and equal effects as proof of agreement, making unconditional holds a plan divergence. plan.md:74-84; command: rg -n 'candidate|Different option text|identical outcome' .git/triage/2026-09-24-decision-rounds-2-codex-round-review/plan.md.
- **CONFIRMED:** The sort traces F7 to af773df and F9 to 88ff0cb. A d763557-only repair misses earlier code. sort.md, Round and route; command: git blame -L 957,964 src/shared-decisions.ts.

No fail-first test was claimed; no mutation check was needed. The tree was clean before report writing (git status --short).

## 7. Recovery envelope

Preserve accepted answers/source records and tests for historical pulls, duplicate refs and transcript correlation. Do not reset the branch to the merge base. Partial rollback of d763557's intent-to-hold path is an owner option, not a completed action. Keep its independent admission and receipt work under review; af773df and 88ff0cb are in the unreviewed ring.

Checkpoint: diagnose/20260924-185528-decision-rounds-2-round4-review; return with git switch --detach diagnose/20260924-185528-decision-rounds-2-round4-review. First settle the boundary, not another predicate patch. The frontier is the meaning of candidate, established conflict, accepted reading and work hold. Do not name a helper, population collapse, or repair shape while those terms remain unsettled.

A fresh author who wrote neither this report nor the code must test these **ARGUED, unmeasured** plan premises: (1) omitted descriptions matter—compare one ambiguous real transcript with full and reduced briefs; (2) legacy rows can be reconstructed—query old rows/logs in scratch; (3) all hold consumers agree—trace one candidate through queue, assignment and action. Before patching, derive every rule's population with static search and a runtime scenario probe, reconcile their differences, identify an independent oracle (owner case, real consumer, or earlier contract), and show a check failing at its parent. Internal coherence and fix-authored tests are not an oracle. Give the author owner.md and owner-late.md verbatim, with questions, and ask for cases the owner can mark wrong.

## 8. Process findings

- **CONFIRMED:** Newly written code was repeatedly repaired across two days; workload does not prove cause. Before another batch, require an owner-marked semantic case and a check failing at parent for each branch. evidence/selffix.md; command: cat .git/triage/2026-09-24-decision-rounds-2-round4-review/evidence/selffix.md.
- **CONFIRMED:** Plan candidate language diverged from queue behavior. Before merging a hold change, require a trace showing who grants and releases it. plan.md:74-84; src/shared-decisions.ts:1329-1331.
- **ARGUED:** A policy favoring targeted small fixes could amplify this; none was documented, so test for it at plan review rather than claiming it caused this run.

## 9. What this report cannot see

All instruments stop at 161d754. The first §2 discrepancy's rule and predicate both entered at d763557 on September 24 (commands: git log -S 'equal effects' -- docs/decision-rounds-worked-cases.md; git show --format='%h %ad' --date=short d763557 -- src/shared-decisions.ts). The brief/hash relation arose on September 23 and was revised; an identifier's age does not date the problem (command: git log --format='%h %ad %s' --date=short -- src/shared-decisions.ts).

Evidence pack: 57 non-merge commits; self-fix A 30/32 modifying commits, 93.8%; B 29/32 majority in-window, 90.6%; A-prime 30/57 all commits, 52.6%; 2,275 attributed lines; seven files with lines removed then put back. Twenty-five commits deleted no code line, so deletion attribution misses additive fixes and these rates are floors. Prior records were found. No criterion was named to the instrument at launch, though decision-round documents exist. Number commands are in the appendix.

**ARGUED:** No live two-clone run, semantic-reader experiment, or historical-row query was done here. Lens A found nothing further in cardinality, discriminator decay or second authority; lens B invented no new category. I ran no third blind lens and dropped neither cited entry. The three Codex review lenses noticed the loop; measurement described it afterward.

## 10. Open questions

**Owner:** May a mechanical candidate hold work before semantic reading, or does a reading grant the hold? The late answer settles equal meaning but not treatment during uncertainty. I recommend requiring semantic judgment before labeling an established conflict; downside: temporary treatment of uncertain work remains to decide.

**Owner:** In the qualified Yes case, if effects match but intent differs, should work pause even though the finder drops the pair? I recommend judging concrete intent; downside: automatic population remains incomplete.

**Owner:** Must the independent reader see descriptions and effects visible in the person's prompt, or are question and labels sufficient? Full brief costs prompt size and compatibility; reduced brief can hide different options behind identical labels.

The seven sort disagreements follow verbatim, including each command the sorter gave:

### 1. A — F1, F8: owner to settle the readings

### A — F1, F8

First sorter: **Group 2, design defect.** “A pre-migration pending verdict can be successfully held before an unknown replacement and settled after a pull. The new event omits submission context and falls back to causal knowledge at settlement, invalidating a completed reading. Plan §1 and §6 explicitly require preserving old pending rows, but reconstructing their context from a legacy row/transcript and log history requires a recovery design, not a local `?? []` guess. Sites: `src/ops/decisions.ts:526,529`, `src/shared-decisions.ts:688-690`, nullable migration in `src/db.ts`. Both reports reproduced the same claim.”

Blind sorter: **Group 1, implementation defect, isolated one site.** “Both report the same legacy held verdict losing its admission context. `heldFor` returns `knownReplacements: undefined` for a legacy row; settlement passes it into the reading event, whose fold substitutes knowledge at the later recording event. The answer already carries its admission context. Site count: **1 settlement path**; `rg -n 'knownReplacements: h\.knownReplacements' src/ops/decisions.ts` finds its two uses within that path.”

### 2. B — F6: owner to settle the readings

### B — F6

First sorter: **Group 2, design defect.** “A text-only brief had one supported D1 when issued; after a late pull brings an identical D1, `briefListing` matches both and rejects the historical prompt for lacking a warning it could not have contained. Plan §1/§2 explicitly require old immutable data and historical identity where evidence can establish it. The fold/operation need an identity reconstruction policy; current-list matching at `src/shared-decisions.ts:380-404` cannot supply one.”

Blind sorter: **Group 3, assumption.** “A brief without a manifest is identified by displayed question text. `briefListing` expands one line to every currently folded match, so a later identical question creates a new ambiguity retrospectively. The code’s stated rule is to judge the brief the reader saw; the legacy text identity assumption does not preserve that.”

### 3. D — F2: owner to settle the readings

### D — F2

First sorter: **Group 2, design defect.** “A later verified resolution of the same two source answers can mark both original rulings `resolvedOutBy` and leave no standing intent. The owner authorised explicit resolution but has not chosen whether a revised choice replaces the first, or whether asking the same pair again is refused. Sites: `src/ops/decisions.ts:56-65`, `src/shared-decisions.ts:752-761`.”

Blind sorter: **Group 3, assumption.** “Posting permits another resolution of the same answer pair. The fold accumulates `resolvedOutBy` marks from both verified selections, while `standing` excludes every marked answer. It assumes resolutions of one pair will not reverse each other; deciding precedence between successive or concurrent resolutions requires a rule.”

### 4. E — F3: owner to settle the readings

### E — F3

First sorter: **Group 1, isolated implementation defect, one site.** “`intentCandidates` treats equal words and equal effect tuples as evidence that differently worded questions cannot conflict; plan §3 expressly says identical outcome effects do not prove meanings agree and different questions can conflict. The skip should not apply across distinct questions. Search: `rg -n 'words ===|mapsKey\(x\.a\.ruled' src/shared-decisions.ts` gives one combined predicate at lines 1078-1079. This is inside the human-intent rules likely to be planned, so do not fix early under P1.”

Blind sorter: **Group 2, design defect.** “`intentCandidates` suppresses a pair when answer words and computed effects match. Two “Yes” answers to differently qualified questions can pass that test even though the human instructions differ. The candidate rule needs a decision about which source context constitutes potentially different intent.”

### 5. F — F4: owner to settle the readings

### F — F4

First sorter: **Group 2, design defect.** “An intent candidate adds an exceptional hold using ordinary `holdSince ?? postedAt`; when both answers had released the finding, the new conflict hold inherits the question posting time and can hide an assignment made while work was unheld. S0.4 says a hold begins when it begins, but a cross-writer conflict's start needs a deterministic rule (which answer's time, causal union, or another witness) rather than blindly using posting time. Sites: `src/shared-decisions.ts:1325-1331`, `src/ops/annotations.ts` assignment cut.”

Blind sorter: **Group 1, implementation defect, isolated one site.** “When a candidate is held, `heldFindings` attributes it to the first decision and uses that decision’s `holdSince`, falling back to its posting time. The candidate cannot exist until the second answer, so a pre-conflict assignment is incorrectly treated as post-hold. Site count: **1 candidate-to-hold insertion** at `heldFindings`’ candidate loop; `rg -n 'intentCandidates\(|holdSince\(' src/shared-decisions.ts` locates that insertion and its time calculation.”

### 6. G — F10: owner to settle the readings

### G — F10

First sorter: **Group 3, assumption.** “The new code treats every mechanical candidate, including unread/disputed words, as an established conflict for holding work. Plan §3 calls them candidates for inspecting semantic intent and says differing words alone do not establish a conflict. No checked/dismissed state exists. The assumption that candidate equals conflict needs an explicit operational rule, not a local filter. Sites: `src/shared-decisions.ts:1066`, `:1329`, `:1264`.”

Blind sorter: **Group 2, design defect.** “`intentCandidates` includes verified words still unread or disputed; `heldFindings` then treats every candidate as an undecided hold, and `ruledNotCarriedOut` suppresses its rulings. “The plan calls these candidates for human-intent checking and says differing text alone does not establish semantic conflict.” Whether a mechanical candidate may block work needs an explicit rule.”

### 7. H — F5: owner to settle the readings

### H — F5

The first sorter called this **Group 5, invalid (assumed)**, reasoning that Carol's matching outcome did not prove the same intent. The blind sorter called it **Group 1, implementation defect, isolated one site**, reasoning: “`intentCandidates` includes verified answers without checking `resolvedOutBy`, even though `standing` excludes those answers. A resolved loser can therefore form a fresh pair with a new answer that matches the preserved ruling. Site count: **1 candidate input**; `rg -n 'resolvedOutBy|intentCandidates\(' src/shared-decisions.ts` shows the mark, the standing filter, and the candidate constructor.”

Independent Codex arbitration at `arbitration-f5.md` ruled **valid**: Bob's losing answer is marked `resolvedOutBy` and excluded from standing, yet still makes a new candidate with Carol even where Carol agrees with preserved Alice. The existing third-answer test covers Carol disagreeing, not agreeing. **Don't fix early.** The arbitrator did not run a separate reproduction.

## Appendix

### Deposition, verbatim (inside account, not findings)

# Deposition — decision-rounds-2 round 4

The owner asked, “Let's implement the plan .git/triage/2026-09-24-decision-rounds-2-codex-round-review/plan.md,” then asked for three Codex review lenses: general application code, the fold, and assumptions. After those reviews they asked me to run triage-review with Codex agents in place of Claude agents. The written plan and the owner's rulings before it are the stated target. I chose the diagnosis route for this round because the fresh findings land on review fixes and keep exposing rules about historical evidence and human intent. That routing judgment is mine, not a new owner acceptance criterion.

The implementation is at `d763557` on `decision-rounds-2`. I understand this as a sequence of review-fix commits, including `88ff0cb`, `af773df`, `8673c16`, and `d763557`, rather than one original implementation. I do not have a reliable, complete memory of the edit-by-edit sequence across those rounds. The current review reports repairs that can change what a reader was shown, when a hold begins, and whether answers to related questions count as one human intent. My working guess is that several fixes encoded current folded state as evidence of past admission, and promoted a mechanical candidate into an operational hold before an authorized semantic decision exists. That is a guess, not a concluded root cause.

I cannot honestly name every test, fixture, expected value, or spec edited to make earlier rounds pass from memory. The decision tests in `src/shared-decisions.test.ts` and `src/decision-ops.test.ts` are the relevant suites I know about. I have not established whether any added or repaired test was observed failing before its fix. I will not claim fail-first evidence from a passing suite. I also do not know whether the plan itself changed during these rounds; the triager should compare its history instead of treating its current wording as independent evidence.

The last point I can identify as a repository comparison base is `161d754`, the merge base with local `main`; that is not a point I know was behaviorally good. `fce9a49` is the start of this review range, also not a verified good point. I do not know a last known good commit for the decision behavior.

The call I may have kept making without a rule from the owner is that a derived match or candidate has enough authority to change a person's prior reading or the working queue. “Same decision,” “same answer,” and “same intent” may mean different things in the brief, reading, and conflict code. My next move without this triage would probably have been to patch each review finding and extend the same tests, which risks another round of fixes on fixes. I have applied no fixes in this triage run. I am unsure which of these behaviors should be repaired locally and which need the owner to define the guarantee first.

### Commands behind numbers

- cat .git/triage/2026-09-24-decision-rounds-2-round4-review/evidence/summary.md
- cat .git/triage/2026-09-24-decision-rounds-2-round4-review/evidence/selffix.md
- cat .git/triage/2026-09-24-decision-rounds-2-round4-review/evidence/commits.md
- cat .git/triage/2026-09-24-decision-rounds-2-round4-review/sort.md
- git log --oneline 161d754497b7958a800afbaf1f41192727a4caab..d76355795a2e1a4f8e0640df585f4a4f611f2849

### Return to checkpoint

git switch --detach diagnose/20260924-185528-decision-rounds-2-round4-review. Only this report was edited.

## 11. Owner exchange after report

**Question:** While a reader has not yet judged whether two answers mean different things, should the possible conflict pause work on the affected finding?

**Answer (owner, verbatim):** Noninteractive or batch agents should not work on findings affected by question conflicts. Interactive agents should bring the conflict to the user and have them decide it then, via the usual question reporting tools.

**Question:** Should the independent reader receive option descriptions and stated finding effects from the person's original prompt when judging the answer?

**Selected label:** Show the full prompt and effects (Recommended)

**Option text (agent-authored, selected by owner):** Show the full prompt and effects (Recommended)
