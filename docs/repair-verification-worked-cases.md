# Repair verification: implementation cases

Current-policy cases for the approved 2026-09-25 remaining-decision-work plan.
These are expected outcomes, not claims that the repair protocol is implemented.
The existing [rulings contract](rulings-contract.md) still governs human answers
and their application. Shared records follow [sidecar architecture](sidecar-architecture.md).
Requirements follow [requirements architecture](requirements-architecture.md) and
[cross-universe scope](cross-universe-standard.md); deferrals follow
[finding backlog](finding-backlog.md).

The owner's Q4 permits explicit independent inspection when no useful executable
check exists. Q5 reserves permanent acceptance to a human and uses dated backlog
for later work. Q6 lets independently verified repairs leave working queues without
another acknowledgment, while retaining closure evidence and raising attention on
relevant drift or conflicting evidence. No case grants agents missing requirements.

## Synthetic fixture

Acme has an API universe and a UI universe. Alice and Bob are principals. Morgan
sorts, Casey fixes, and Rowan and Taylor verify in blind sessions of their own (or as
subagents Casey launched, at a weaker grade). An arbitrator receives their rationales only
after both are recorded. Session identity
and model diversity are separate facts, even when Rowan and Taylor use one model.
Every reference below includes its universe and owning review/scope, not just F1.

At commit W, `creditLine(-1)` incorrectly accepts a negative credit. Finding F1
claims that defect. F2 claims a duplicate credit is applied twice. Finding F3 has
both claims, with stable identities C-negative and C-duplicate. Pattern P1 is the
same missing negative-credit guard in API, import and batch entry points, with all
three sites enumerated. Commit X fixes only the API guard; Y fixes all three.
The default branch is T. W, X, Y and T denote resolved immutable commits, never
branch labels or caller assertions. Tests and commands run in scratch clones.

## Cases to preserve

Each row states the durable record, authority, work eligibility and visible result.
Before verification, a repair report alone leaves a finding unresolved. A receipt
applies only to its exact claims, sort, evidence, commits and ruling context.

| ID / situation | Record before and after | Authority and eligible work | Visibility after |
|---|---|---|---|
| C01 Ordinary mechanical repair | F1 as filed; accepted mechanical sort; W/X evidence; two recorded fixed runs; separate application | Existing requirement permits the guard. Both verifiers run the reproducer themselves: it fails at W and passes at X. Application rechecks all inputs and closes F1. | F1 leaves active queues; search and history retain claim, X, commands, actual results and verifier identities. |
| C02 Multi-site pattern | P1 retains predicate and all three sites; X evidence names only API; Y evidence later covers all three | X cannot resolve P1. Enumerating only the surviving sites cannot redefine its scope. Y needs independently checked complete coverage before application. | Missing import/batch sites remain actionable; prior partial proof remains visible after eventual closure. |
| C03 Missing design ruling | F1 sort rests on an unanswered business question about negative credits | Agents may investigate and post the question. They cannot implement a policy or close F1 by choosing an answer. | Decision-needed, linked question, original claim and unanswered scope. |
| C04 Missing assumption ruling | A finding asserts credits must expire after thirty days; no rule supplies that deadline | Code can establish current behavior, not the missing obligation. Independent sorting keeps the requirement question open. | Decision-needed; no manufactured requirement, repair or refutation. |
| C05 Factual refutation | F4 says `creditLine` is absent at W; exact W source shows the method; two fresh verifiers document the contradiction | Independent factual verification can refute this exact claim without inventing a requirement. Separate application rechecks inputs. | Factually refuted; original text, source and rationales remain discoverable. |
| C06 Mistaken scope refutation | F4 instead says the business needs a credit method; source contains a differently scoped helper | Method existence does not settle whether the needed behavior is required. No factual refutation may remove that unresolved scope. | Decision-needed or unknown with reason; original claim stays open. |
| C07 No useful executable check | Repair concerns explanatory text; evidence records why no useful executable reproducer/falsifier exists, and exact inspected sources | Rowan and Taylor each provide explicit independent inspection and semantic reasons under Q4. Missing executable evidence is never represented as rerun success. | Closure may qualify with visibly weaker inspection grade, sources, reasons and both identities. |
| C08 Partial finding | F3 retains both as-filed claims; X fixes C-negative only | Coverage resolves only C-negative. Casey cannot delete C-duplicate or split it away to meet completeness. | Partly repaired, F3 still in work; resolved and unresolved portions visible. |
| C09 Shared command, separate findings | One pinned run covers F1 and F2; evidence actually proves only F1 | Each finding has its own completeness result. A shared run or round label grants no sibling closure. | F1 may close; F2 remains open with its missing proof. |
| C10 Verified but unmerged | Adequate X receipts applied to F1; X's relevant code is absent from T | Q6 removes verified F1 from repair work without a human acknowledgment. Branch adequacy does not establish default-branch adequacy or close a linked bug. | Verified at X, unmerged; exact checked code, grade and landing evidence shown. |
| C11 Repair landed | X is checked; its relevant code reaches T by ancestry, cherry-pick or squash | Derive landing using code first, then ancestry, then the existing negative-only fallback. MERGED into another feature branch is insufficient. | Verified repair landed only with demonstrated landing; unavailable commit stays unknown. |
| C12 Relevant code changes | X closure remains recorded; relevant source later changes at Z | X does not become proof at Z. Raise attention without minting a new verdict or erasing historical success. An unrelated commit also does not inherit new verification. | Stale current verification, original successful act and reason for attention. |
| C13 Reopen | F1 closed from X is explicitly reopened | Keep closure and verification history. A new attempt needs current evidence. A human-invalidity ruling already spent on F1 cannot close it again. | Reopened work with prior execution and unspent/ spent authority distinguished. |
| C14 Cancelled ruling reading | A human answer is revised after reading but before application | Cancel pending reading authority; changed answer requires a new reading. Existing executed closure, if any, is retained separately. | Cancelled reading in history; pending action refuses with the changed input identified. |
| C15 Current conflict hold | Alice and Bob give independent incompatible answers; dependent repair has receipts | Comparison/arbitration hold still blocks authority-dependent work and application. A vote, assignment or old receipt cannot bypass it. | Both answers, pending comparison or conflict, held work and prior executions visible. |
| C16 Same-model independence | Rowan and Taylor use the same model in proven distinct fresh sessions | Keep two opinions and session provenance. A session's revision replaces only itself. Never label this model diversity. Legacy actors gain no invented session. | Both identities, same-model limitation and revised opinion history. |
| C17 Contaminated verifier | Casey tries to verify; or Rowan inherits history, receives Casey's conclusion, sees Taylor's answer, or claims role after a domain read | Casey's own connection is refused; a subagent Casey launched counts at a weaker grade. A verifier connection claims its role before any other call, and a subagent's submission counts only from its own transcript with the exact issued launch prompt. | Exact refusal/unsupported reason; no closure and no silently downgraded identity. |
| C18 Exact operation sign-off | Alice sees full operation O text/context and elects promotion; verified answer and independent validation bind O's witness; Bob's agent applies | Pull/recheck O immediately before applying the narrow receipt. Credit Alice, record Bob's executor, sign O alone. Drafting or a plan-only answer signs nothing. | O sign-off, exact shown text, human authority and executor; framing/other operations unsigned, ratification still separate. |
| C19 Changed operation | O's text or context changes after the answer or during pull; a label still matches | Refuse application with witness mismatch. Withdrawn, conflicting or unverified answers and forged agent stamps also cannot sign. | Original receipt and current mismatch; no sign-off or implicit ratification. |
| C21 Markdown-only skills | No accessible database, tools or resolvable sidecar; questions and exact responses retained in run record | Honest markdown-only work continues within known authority. No guessed sidecar, synthetic transcript or trusted markdown import. Previously shared IDs remain pending on outage. | Non-verified status, resolved absolute record and repository identity, durable IDs for resume. |
| C22 Human acceptance and later work | Alice explicitly accepts a real defect, or postpones it with a deadline | Permanent acceptance is attributed to verified human authority, never chosen by verifiers. Later work uses existing principal-granted backlog and witness/expiry rules. | Accepted distinct from fixed/refuted; backlog carries deadline and wakes on drift/expiry. |
| C23 Suggestion | Alice adopts, declines or postpones an improvement | Adoption authorizes work and does not prove completion. Decline records human disposition; postponement uses dated backlog. | Authorized unfinished work, human decline or dated backlog; no verifier dismissal. |
| C24 Unknown execution | Exact commit/environment/dependency is unavailable or command errors | Unknown is neither a negative verdict nor automatic reopen. Explicit independent inspection, when applicable under Q4, is a separate evidence path. | Actual error/missing prerequisite and unknown result; no invented pass/fail. |
| C25 Correction of sort | Casey proposes changing P1 from pattern to isolated; independent sort correction names predecessor and addresses disagreement | Preserve both versions and reason. Casey cannot upgrade its own eligibility; unanswered requirements still block mechanical work. | Original/current classifications, both receipts, disagreements and substantive arbitration. |
| C26 Unattributed changes | X contains the guard and unrelated hunks; verifier notices another defect | Show unattributed hunks. New defects become separate work through a normal actor, outside the constrained verifier path. Neither proves nor defeats F1 completeness by association. | F1's bounded result and unattributed changes; separately filed issue when appropriate. |

## Executable evidence negative controls

For C01/C02, pin command definitions and code before verification. The reproducer
must fail at W and pass at X (or Y for full pattern coverage), observed by each
verifier itself (owner, 2026-09-28: no mutation or reversal requirement).
Actual environment, exit status and output are evidence; suite counts alone are
regression information. Stored commands remain data until assessed for execution
in an isolated clone.

| Control | Expected refusal or incomplete state |
|---|---|
| Suite passes while negative credits remain accepted | No adequate closure; suite success cannot replace the finding reproducer. |
| Pattern enumeration omits import | P1 remains incomplete against its original site set. |
| X replaced by Z after the runs are recorded | Application refuses stale evidence; no receipt reuse. |
| One verifier missing, or fixer submits both verdicts | No independent authority, regardless of vote labels. |
| Arbitrator agrees without addressing the recorded disagreement | No resolved verification conflict. |
| Original C-duplicate erased by a correction/split | No complete F3 closure; as-filed scope is retained. |
| Receipt replayed or application retried in a second clone | Deterministic result; no extra authority or duplicate execution. |
| Broken, missing or differently bound sidecar | Stored history visible but non-authoritative; no new closure. |

## Baseline and implementation tracking

The P0 execution record is [remaining-decision-work execution](remaining-decision-work-execution.md).
It distinguishes existing tested behavior from new capabilities not yet present.
Future slices must attach executable checks to these cases through operations,
folds, two-clone sync and visible consumers. This document itself is not an
executable verifier or a substitute for those checks.
