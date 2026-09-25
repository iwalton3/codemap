# Rulings and questionnaires — current workflow

A ruling is a recorded human answer. Recording it does not close a finding or bug. Codemap keeps the answer, its exact displayed question and its later interpretation, comparison, withdrawal and execution history separately.

## Publish and answer a questionnaire

An agent publishes an organized questionnaire with `post_round`. Its stable ID, section and question IDs, answer formats, option descriptions and visible action meaning are frozen at publication. The return value includes the hash-route web link and retrieval ID. Recipients route attention; any team member may answer under their own identity.

The web page shows the whole questionnaire. A person may save a draft on this device without submitting it. Drafts are keyed to that principal and exact form version; they are not shared rulings. A person explicitly submits selected complete questions. A reviewed list submits as one unit: unmarked items are approved and each marked item needs correction text. Other questions remain pending. The receipt identifies the submitted answers, and retrying the same attempt with the same content returns that receipt. Another person can answer the same question independently; their answer is retained and may need comparison.

## Retrieve answers after sync

A requesting agent runs `codemap sync` on its checkout, then reads the returned questionnaire ID through `questionnaire_detail` / `questionnaire_status` or the JSON CLI:

```sh
codemap sync /path/to/repo
codemap questionnaires detail Q-ID --repo /path/to/repo
codemap questionnaires status Q-ID --repo /path/to/repo
```

The status response includes an opaque content cursor and the last successful sync status. `codemap questionnaires wait Q-ID --cursor CURSOR --wait-ms 30000 --repo /path/to/repo` waits only for a local projected change. It neither syncs nor wakes a stopped agent session. A later session can resume with the same ID and cursor; after a remote answer, sync again before reading. A changed answer, withdrawal or authority change moves the cursor even if the answer count does not increase. Blocked sidecar state is reported as such rather than empty completion.

## Revise or withdraw

A new question may link an older one as context; it never silently replaces it. A revision names the exact earlier answer and affected findings or canonical issue references. Unchanged scope keeps its prior authority. A person revising on the web first selects scope and reviews a frozen source presentation, then submits a new answer with that presentation receipt. A verifying agent may instead request `decision_revision_relay_brief`, show its exact single question through `AskUserQuestion`, and record the returned transcript with `record_relayed_decision_revision`. Pulling an answer later is not proof that the human saw it when replying.

A person may withdraw directly on the web. They can also record approval for one exact agent withdrawal, including decision, answer if present, reason, known answers and scope. The agent then uses `execute_approved_decision_withdrawal` with the approval event ID and identical reason. A withdrawal retires pending authority and readings for that ruling; it does not reopen a completed closure or reactivate an older answer. History remains visible, and a new instruction needs a fresh question.

## Compare intent and apply an invalidity ruling

Independent current answers with overlapping scope become comparison candidates. The requesting agent issues an exact pair request, launches a fresh reader with the full frozen question and answer context, and records the reader's own transcript-backed equivalent, incompatible or unclear judgment. Equivalent intent releases that pair's restriction. Incompatible intent requires a human choice through the web or the exact `comparison_resolution_brief` question; unclear or contradictory judgments remain pending. A later unseen answer is assessed separately. Pending comparison and arbitration pause dependent batch work in queues and at write boundaries, even when an assignment already exists.

To close a finding or bug as invalid, an agent requests an application brief containing the exact current issue claim and ruling. A displayed exact issue ID or link unambiguously covered by the answer needs one independent sound reader. An indirect application needs two independently launched sound readers; disagreement needs an arbitrator who sees both rationales. Changed issue meaning or ruling response invalidates pending evidence. `apply_ruling` checks current authority, reader receipts, issue state and comparison restrictions under the target write lock, then appends one closure and consumption event. An already closed issue spends nothing. A completed ruling–issue pair remains spent after reopening; a genuinely new human ruling can authorize a new attempt with fresh reading. Execution receipts stay visible on the issue and ruling history, including during later conflict resolution.

## Identity and storage

A display label such as D1 is never an issue identity. Findings and bugs use canonical references with universe, kind, owning scope or review, and exact ID. An ambiguous bare finding ID is refused until its review is supplied. Local-only issues must be published through their existing path before a shared ruling can close them. Shared acts are appended to the sidecar and materialized into SQLite; ordinary reads use projections. A missing, corrupt or wrong-bound sidecar keeps stored rows visible with blocked status and refuses dependent writes. No runtime dependency or background answer push is required.
