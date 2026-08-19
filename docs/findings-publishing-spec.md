# Spec: promoting codemap findings to batched GitHub PR review comments

**Status:** BUILT (2026-08-19), with four deliberate deviations — see §0.
**Provenance:** written by a review agent during a live Acme.API #264 session and
copied into the repo verbatim; it was living in a scratchpad that will not survive.
**Priority:** was blocking pushing #264 back to its submitter.
**Decided since:** `review_queue` defaulting to `brief: true` (§3.4) is approved,
breaking change and all — the 100k-character failure it cites is the whole reason.

The body below is the spec **as written**, kept unedited so its witnesses stay
readable. Where the implementation differs, §0 says how and why.

---

## 0. What was built, and where it deviates

Built: `comment` (800 cap, required on findings, refused not truncated),
`disposition`, `revise_finding`, `withdrawn`, `postedRef`, brief-by-default
`review_queue` with paging and filters, the full §4 placement ladder, the §5
content contract in every tool that writes a `comment`, and a findings panel that
can triage and edit without opening the code.

**1. `publishState` is derived, not stored (§2.3).** Both transitions already
existed: `escalated` is the human-only vouch — a web action, with no MCP tool that
can set it, so "agents must not be able to set this" holds by construction — and
the push record is the receipt for what went out. A stored enum beside them would
have been a second answer to the same question, kept in step by hand. `withdrawn`
IS stored, because un-escalating cannot express it for a finding the human wrote
themselves. See `publishStateOf`.

**2. One `severity`, not `severityFiled` + `severityCurrent` (§2.2).** Once
revisions append, "as filed" is revision zero. Two fields would fork every read
site — triage, sort order, `--min-severity`, rendering — with no rule for which
one wins.

**3. `result: "refuted"` was not added to `close_finding` (§3.2).** `result` is
what the AGENT DID (fixed, answered, declined); `disposition` is what turned out to
be TRUE. A false positive is `answered` + `refuted`: the agent did answer, and the
answer was "not a defect". The spec's actual complaint — that a batch builder
cannot act on it — is answered by `disposition`, which is data. Adding it to
`result` as well would make `result` mean two things at once.

**4. File-level comments are not used (§4.2).** `subject_type: "file"` is not
reliably accepted inside a batched review create, and a 422 there fails the WHOLE
batch. So §4.2 lands on the first hunk line with the §4.4 preamble — the fallback
the spec itself names — in every case. Worth revisiting if GitHub's support firms
up; the placement ladder is one function (`placeAnnotation`).

### What §4.3 turned out to be

Not a gap but a live defect. A finding whose anchor was not in the PR's worklist hit
a bare `continue`, **uncounted**: electing one on code the branch never touched
silently never went out, and the plan printed nothing held back. Those now surface
as `blocked`, in the plan, the push panel and the CLI, with `publishPath` to place
them.

### The open questions (§8), as settled by building it

1. **Who owns "nearest file"?** The human, as the spec assumed. Nothing is guessed;
   an unset `publishPath` is reported by name.
2. **Does `severityCurrent` drive batch order?** Moot — GitHub renders review
   comments in file order regardless.
3. **Re-review of an updated PR.** Still open. `postedRef` gives the cross-reference
   the spec wanted; whether a `posted` finding should reopen when its code moves is
   not decided, and `possiblyFixed` may already be enough.
4. **Multi-repo.** Untouched — one universe, one PR.
5. **Bulk approval.** Not built. The panel groups by what will happen to each, which
   makes the batch legible, but there is no "approve all confirmed" button yet.

### Still unproven

Nothing has been posted to a real pull request. The publish path is tested with an
injected `gh`; no comment has landed on GitHub, so §4's placement ladder has never
met the API that constrains it.
**Author:** derived from a live PR-review session (Acme.API PR #264, 78 files, 12 agent findings + 3 human findings + 1 derived finding + 3 filed bugs)
**Audience:** the agent implementing changes to the codemap MCP server

Every constraint below is traceable to something that actually went wrong or was actually needed during that
session. Where a design choice has a concrete witness, it is cited — those double as acceptance tests.

---

## 1. The workflow this must support

1. **Inject** — the human, reading a diff, drops a question or a rough finding onto a line and assigns it to
   an agent ("check this for me"). Already supported (`annotate` + `assignment`).
2. **Pre-review** — an agent reviews the PR independently and adds its own findings and questions.
3. **Triage together** — human and agent walk the list, decide what is real, what is refuted, what needs more
   work. Either party may revise any item.
4. **Publish** — the human approves a subset in the editor; codemap posts them to GitHub as **one batched
   review**, using short submitter-facing text, with agent-authored comments marked `[Claude]`.

The central design fact: **steps 1–3 and step 4 have different audiences and want different documents.**
Steps 1–3 want full evidence — file:line, what was checked, why the obvious alternative fails, what is
still unverified. Step 4 wants "here is what is broken, here is where, here is what to do."

Today there is one prose field. It gets written for the map, and the PR-facing version has to be
hand-rewritten outside the tool. That round-trip is the thing to eliminate.

---

## 2. Data model changes

### 2.1 Split the prose into two fields

| field | audience | required | cap | content |
|---|---|---|---|---|
| `text` (existing) | the map, future agents, the human triaging | yes | none | Full evidence. Keep as-is. |
| `comment` (**new**) | the PR submitter | see below | **800 chars** | What is broken, where, what to do. |

`comment` is **required when `kind: "finding"`** on `annotate`, and required whenever `disposition` is set
to a publishable value (§2.2). Do not make it optional-with-a-nudge.

> **Witness.** In the session that motivated this spec, twelve findings were filed via `close_finding` with
> rich `detail` and no short form, because none was requested. All twelve then had to be rewritten by hand
> for GitHub. An optional field would have been skipped every time.

The 800-char cap is not cosmetic — it is the mechanism. It makes "verdict + evidence pointer + ask" the only
shape that fits, and forecloses the archaeology the submitter does not want. Reject over-length writes with
an error naming the cap; do not silently truncate.

### 2.2 `disposition` — an enum, not prose

```
"open"        // filed, not yet investigated  (default)
"confirmed"   // real, as filed
"partial"     // real in part; the comment states which part
"rerated"     // real, but severity/impact differs from as-filed
"refuted"     // not a defect — false positive
"accepted"    // real, deliberately not fixing (product/architecture decision)
```

Publishable by default: `confirmed`, `partial`, `rerated`. Excluded by default: `open`, `refuted`,
`accepted` (each overridable per-item at approval time).

> **Witness — why this must be data.** That session produced exactly these outcomes: 7 confirmed, 1 rerated
> (a "cross-tenant IDOR" that a downstream check actually blocked — real defect, wrong severity), 2 partial
> (one where the claimed retry-storm did not exist but the underlying defect did), 1 refuted (a claimed NRE
> on a null-receiver **extension method**, which cannot throw), 1 accepted. All of it lived in prose, so
> nothing could filter on it. A batch built without this field would have shipped the refuted item to the
> submitter as a comment reading "actually this is not a bug" — pure noise on the PR, and precisely what
> "one batch, not a pile" is meant to prevent.

`severity` should become `severityFiled` + `severityCurrent` (or add `severityCurrent` alongside the
existing field) so a re-rating is visible without diffing revisions.

### 2.3 Publish lifecycle

```
publishState: "local" -> "approved" -> "posted"
                      \-> "withdrawn"
```

- `local` — default; agents write here, never further.
- `approved` — human-only transition, from the editor. **Agents must not be able to set this.**
- `posted` — set by the publish tool on success. Terminal for this PR.
- `withdrawn` — human decided not to send it; stays on the map.

On success store `postedRef`:

```json
{ "pr": 264, "reviewId": 123456, "commentId": 789012,
  "url": "https://github.com/.../pull/264#discussion_r789012",
  "postedAt": "...", "path": "...", "line": 51, "placement": "inline" }
```

`posted` + `postedRef` is what makes re-review idempotent: a second pass over the same PR must not re-post
what is already on it. Also gives `possiblyFixed` a cross-reference when the anchored code later changes.

### 2.4 Attribution

Publish-time marker, derived — **not** stored in `comment` text:

- `comment` authored/last-substantially-edited by an agent → body is prefixed `[Claude] `.
- Authored or rewritten by the human → no marker.
- Expose `publishAttribution: "agent" | "human"` (default derived from the author of the current `comment`
  revision), human-overridable in the editor — because the human editing an agent's wording to be sharper
  should not have to choose between mislabelling it and losing the marker.

Keep the marker short and at the start, per the requesting maintainer: `[Claude]`, one token, not a banner
and not a generated-by footer.

### 2.5 Revision history

`close_finding` is currently **write-once**, and that is a real gap: four of the twelve reports in the
witness session became known-wrong or known-overlong after filing, and could not be amended — the
corrections survived only in the chat transcript.

Add `revise_finding` (§3.3). Revisions **append**; never destroy prior text. The history matters exactly in
the "a correction was submitted" case, which is when you most want to see what changed and who changed it.

---

## 3. Tool changes

### 3.1 `annotate` — modified

Add: `comment` (string, ≤800, required when `kind: "finding"`), `disposition` (enum, default `"open"`),
`publishPath` / `publishLine` (optional overrides, §4.3).

Extend the tool description with the content contract (§5) **and a worked example**. A bare instruction to
"write a short version" reliably yields an abstract of the finding, which is a different document from a PR
comment. The example is what makes the difference.

### 3.2 `close_finding` — modified

Add `comment` (≤800) and `disposition`. Add `"refuted"` to `result` — currently a false positive has to be
reported as `result: "answered"` with "recommend closing as invalid" buried in prose, which no batch builder
can act on and the human has to read the body to discover.

### 3.3 `revise_finding` — new

```
revise_finding(universe?, id, { text?, comment?, disposition?, severityCurrent?, publishPath?,
                                publishLine?, publishAttribution? }, by)
```

Callable by agent or human. Appends a revision. Refuses when `publishState == "posted"` unless
`allowPostEdit: true` (which should then edit the GitHub comment in place via its stored `commentId`,
rather than silently diverging from what the submitter can see).

### 3.4 `review_queue` — modified

Add `brief` (**default `true`**), `limit`, `offset`, `disposition` filter, `publishState` filter.

> **Witness.** The first `review_queue` call of the session returned **100,882 characters across 248 lines**
> and blew the token limit outright, because it inlines each anchor's full source. It had to be routed to a
> file and mined with `jq` before any work could start. `brief: true` should return
> `{id, kind, severity, disposition, publishState, file, line, symbol, comment, textPreview}` and omit
> `code` entirely.

### 3.5 `publish_findings` — new

```
publish_findings(universe?, pr, findingIds[], dryRun?: bool, reviewBody?: string)
  -> { review: {id, url}, posted: [...], skipped: [{id, reason}], placement: {...} }
```

- Refuses any id whose `publishState != "approved"`. **The gate is not advisory.**
- Refuses any id already `posted` for this `pr`.
- `dryRun: true` returns the fully-composed batch — every body, every resolved placement — without posting.
  Make this the documented default habit; placement resolution (§4) is where surprises live, and the
  editor's preview should be driven by this same call so preview and reality cannot diverge.
- Posts **one** `POST /repos/{owner}/{repo}/pulls/{pr}/reviews` with all comments in `comments[]`, event
  `COMMENT`. One review = one notification = one resolvable thread per finding.

---

## 4. Placement — the hard part

GitHub will only accept an inline review comment on a **file that is in the PR diff**, and (for line-anchored
comments) on a line within a diff hunk. Codemap anchors have neither constraint. Resolve in this order:

### 4.1 Anchor line is in a diff hunk
Inline comment at `path` + `line` + `side: "RIGHT"`. Normal case.

### 4.2 File is in the diff, line is not in a hunk
Prefer a **file-level** comment (`subject_type: "file"`), which needs no diff position and still renders as a
resolvable thread. If the API version in use does not support `subject_type`, fall back to the first line of
the first hunk in that file and apply the §4.4 location preamble.

### 4.3 File is not in the PR at all
This is common and must not be treated as an error.

> **Witness.** Of the findings worth sending in that session, several concerned code the PR never touched:
> the fail-open tenant predicate in `GetAllReleases.cs` (byte-identical on the merge base), and the
> missing `AddDataProtection()`, which is an *absence* and so has no line anywhere.

Behaviour: require an explicit `publishPath` (a file that **is** in the diff, chosen as nearest to the
problem — nearest in the maintainer's sense: same domain/folder, or the file that made the issue reachable),
comment on its **first hunk line** (or file-level per §4.2), and apply §4.4. If `publishPath` is absent,
`publish_findings` must **skip the item and say so** — never guess a file, and never silently drop it into
the review body where it stops being separately resolvable.

The editor should prompt for `publishPath` at approval time for any finding in this bucket, since the human
is better placed than the agent to pick "nearest".

### 4.4 Location preamble when position ≠ subject
Whenever the comment lands somewhere other than the code it is about, the body **must** lead with the real
location, because the reader's context is wrong by construction:

```
[Claude] **Re: Acme.API/Services/SignedUrlTokenService.cs (and the absence of AddDataProtection anywhere)**
...
```

### 4.5 Genuinely unanchorable
Only for findings about the PR as a whole (scope drift, "this should be three PRs"). These go in the review
**body**, not `comments[]`. Accept that they are not individually resolvable — that is the tradeoff, and it
is why §4.3 exists to keep almost everything out of this bucket.

### 4.6 Stale anchors
Resolve anchors to placements **eagerly at approval time**, not at post time.

> **Witness.** A human-filed finding in that session targeted anchor `a_bb458d3458518cd2`, which had gone
> dead after a reindex. `close_finding` accepted a report against it without warning, and the target had to
> be recovered by hand from the line number and the finding's text. If that had happened during publish, it
> would have been a failed or mislocated comment in the middle of a batch.

Surface unresolvable anchors in the editor as a blocking condition on approval, with a re-anchor affordance.

---

## 5. Content contract for `comment`

Put this in the `annotate` / `close_finding` / `revise_finding` tool descriptions verbatim. It is the part
that determines whether the feature works.

> **`comment` is read by the PR submitter, who wants to know what is broken and what to do about it.**
> They do not want the investigation. Three parts, in order:
> 1. **What is broken** — one sentence, stated as a defect, not as a suspicion.
> 2. **Where / the evidence** — `file:line` plus the smallest quote that proves it.
> 3. **The ask** — the change, or the decision needed.
>
> **Order by disposition** (amended 2026-08-19, after the first real batch).
> `refuted` leads with the withdrawal — that is the news. `partial` / `rerated` lead
> with **what is still broken**, putting the withdrawn half second and marked as
> such: `finding_33b5dec01919` was a real `partial` that opened with its withdrawal,
> read as a refutation on a skim, and was dropped by a reviewer filtering
> refutations out. The half that survived was its last sentence.
>
> Omit: how you found it, what you ruled out, what you checked and cleared, why it was filed, tool names,
> and any narration of your own process. Those belong in `text`.

**Good** (218 chars):

> `[Claude]` The by-id branch has no tenant predicate — `CreateTicket.cs:1006` queries
> `Aircraft` on `x.Id == request.AircraftId.Value` while the registration branch below scopes to
> `x.OperatorId == operatorId`. Add the same `.Where`. Currently an existence oracle over the aircraft
> table (`:512` blocks the actual attach, so this is not an IDOR).

**Bad** — the same finding as originally written for the map (1,400 chars): opens with "PARTLY CONFIRMED —
the missing predicate is real; the stated IMPACT is overstated", then three paragraphs of what was traced,
what the original filing got wrong, and a severity re-rating discussion. All correct, all valuable in `text`,
all noise to the person who has to fix it.

**Withdrawals are worth publishing** when the human already raised the concern on the PR — one line closing
it out ("Withdrawing this — hand-rolling is correct here because `AuthCheck` returns on the first matching
role block, so it grants the owning operator on a dual-tenant `Release`") saves the submitter defending
a non-issue. That is why `refuted` should be *excludable by default but promotable on request*, not
unpublishable.

---

## 6. Questions

`kind: "question"` needs the same publish path. Some questions are internal research prompts; others are
exactly what should go to the submitter — "confirm this is intended" on an unspecced behaviour change.

Give questions the same `comment` field and let them be approved into the batch. Suggested rendering: prefix
the body with a marker so the submitter can see it wants an answer rather than a fix, e.g.
`[Claude] **Question** — ...`. Keep the marker vocabulary to two (`Question`, and nothing for findings);
more taxonomy than that will not survive contact.

---

## 7. Back-compat and migration

- Existing findings have no `comment` and no `disposition`. Backfill `disposition: "open"`, leave `comment`
  null, and have `publish_findings` skip null-`comment` items with a clear reason rather than falling back
  to `text` — publishing a wall of text is the failure mode this whole spec exists to prevent.
- `comment` required-on-write applies to new writes only.
- `close_finding`'s existing `result` values keep working; `"refuted"` is additive.
- `review_queue` flipping to `brief: true` by default is a breaking change for any caller relying on `code`.
  Given the 100k-char failure, defaulting to brief and requiring opt-in for full source is the right way
  round, but it should be called out in the changelog.

---

## 8. Open questions for the maintainer

1. **Who owns "nearest file"?** §4.3 assumes the human picks at approval time. An agent heuristic (same
   directory → same domain folder → the diff file with the most related symbol) could pre-fill it. Worth it,
   or does a wrong guess cost more than an empty field?
2. **Should `severityCurrent` drive ordering in the batch?** Submitters read top-down; posting in severity
   order helps, but GitHub renders review comments in file order regardless. Possibly moot.
3. **Re-review of an updated PR.** When the submitter pushes and the agent re-reviews, findings whose
   anchored code changed should presumably reopen rather than stay `posted`. Does `possiblyFixed` already
   give you enough signal, or does `publishState` need a `stale` state?
4. **Multi-repo.** This session's findings spanned two universes (`api` and `react`, companion PRs). Does
   publish need to target a PR per universe, or is one-universe-one-PR a safe assumption?
5. **Bulk approval ergonomics.** With 12–16 findings, per-item approval is the slow step. Is
   "approve all `confirmed`, review the rest individually" the right default in the editor?
