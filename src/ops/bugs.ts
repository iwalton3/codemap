/**
 * Bugs — filing, reading and triaging them, local or team-wide.
 *
 * ONE list. A bug this machine filed before a sidecar existed and a bug a colleague
 * filed this morning are both `SharedBug` rows in the `bugs` table, and every read here
 * treats them the same. What differs is where a WRITE goes: with a sidecar configured
 * it is an event, because an act that never entered the log cannot be given a causal
 * position afterwards; with none it is a local row, which is what codemap has always
 * been.
 *
 * The verdict that never travels is `possiblyFixed`. Whether a bug's code moved is a
 * join against THIS machine's index, so it is computed here every time and is never in
 * the log — and a bug whose anchors vanished is queued, never closed. Only a person can
 * tell a fix from a rename from a deletion that ignored the defect.
 */

import { parseAsOf, type BugSeverity, type BugWitness } from "../schema.js";
import { headCommit } from "../git.js";
import { readAnchorStore, readBugs, readBug, writeLocalBug, findAnchorsOutsideWork, readOrphans } from "../store.js";
import { witnessDrift, realDrift } from "../reviews.js";
import { requireActor, isAgentActor } from "../identity.js";
import {
  bugLog, materializeBugs, onBugLog, publishBug, type BugLog,
} from "../bugs-publish.js";
import {
  anchorBug, backlogBugEvent, bugIdFor, citedAnchors, commentOnBug, corroborateBug, fileBug, isClosed,
  releaseBugBacklogEvent,
  isTracked, needsHumanAck, promoteBug, requestOnBug, resolveBugContest, reviseBug,
  setBugState, trackBug, unanchorBug, witnessesOf,
  type Ask, type BugState, type SharedBug, type Verdict,
} from "../shared-bugs.js";
import { genId, liveIndex, liveAnchors, resolveRefs, rejected } from "./shared.js";

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

/**
 * Resolve refs to anchor ids and witness each one against the working tree.
 *
 * `scopeRef` and `includeOrphans` are FORWARDED, and their absence was the whole of a
 * defect that read like a design limit: a finding about code the pull request INTRODUCES
 * resolves to no `@work` anchor, so deferring one to a bug answered "resolves to no
 * anchor in this checkout — index the branch it is on first" over a snapshot the store
 * already had. `codemap pr <N>` writes that snapshot (`pr.ts`, `indexCommit`), and
 * `resolveRefs` has carried both arguments, with comments describing this exact case,
 * the whole time. One call site did not pass them.
 *
 * The file lookup goes through the RESOLVED anchors rather than `@work` for the same
 * reason: a snapshot or orphan id is not in the anchor store, and `find(...)!` on it
 * would have thrown the moment the ref above started resolving.
 */
async function witnessRefs(
  root: string, refs: string[], scopeRef?: string, opts: { includeOrphans?: boolean } = {},
): Promise<{ ids: string[]; witnesses: BugWitness[]; errors: string[] }> {
  const r = await resolveRefs(root, refs, scopeRef, opts);
  if (!r.ids.length) return { ids: [], witnesses: [], errors: r.errors };
  const store = await readAnchorStore(root);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const elsewhere = findAnchorsOutsideWork(root, r.ids.filter((id) => !byId.has(id)));
  const orphans = readOrphans(root, r.ids.filter((id) => !byId.has(id)));
  const fileOf = (id: string) => byId.get(id)?.file ?? elsewhere.get(id)?.anchor.file ?? orphans.get(id)?.file;
  const files = r.ids.map(fileOf).filter((f): f is string => !!f);
  const live = await liveAnchors(root, files);
  // `sha256:absent` is a witness, not a missing one: it records that the filer looked
  // and the symbol was not in their index, which a later reader can act on.
  return {
    ids: r.ids,
    witnesses: r.ids.map((id) => ({ anchorId: id, bodyHash: live.get(id)?.bodyHash ?? "sha256:absent" })),
    errors: r.errors,
  };
}

export async function reportBug(
  root: string,
  input: { title: string; description: string; anchors: string[]; severity?: BugSeverity; category?: string },
) {
  // Orphans included, the rule `annotate` and `report_defect` already follow: filing a
  // drive-by against branch code has the identical shape as filing a finding on it.
  const { ids, witnesses, errors } = await witnessRefs(root, input.anchors, undefined, { includeOrphans: true });
  // Partial acceptance (see resolveRefs) — a bug still needs somewhere to point.
  if (!ids.length) return { error: errors.join("; ") || "no anchors given" };

  const log = bugLog(root);
  if (log && "error" in log) return log;

  if (log) {
    const id = await onBugLog(log, root, (logRoot, universe, actor) => fileBug(logRoot, universe, actor, {
      title: input.title, text: input.description, severity: input.severity,
      category: input.category, anchors: witnesses, createdCommit: headCommit(root) ?? undefined,
    }));
    return { ok: true, id, shared: true, note: "filed for the team — run `codemap sync` to send it", ...rejected(errors) };
  }

  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const at = new Date().toISOString();
  const bug: SharedBug = {
    id: genId("bug"),
    title: input.title,
    text: input.description,
    severity: input.severity ?? "medium",
    category: input.category,
    anchors: witnesses.map((w) => ({ ...w, by: actor, at })),
    createdCommit: headCommit(root) ?? undefined,
    author: actor,
    createdAt: at,
    // Same rule the fold applies: an agent PROPOSES a bug, a person stands behind one.
    state: actor.via ? "issued" : "created",
    corroboration: [],
    thread: [],
    tracking: [],
    revisions: [],
  };
  await writeLocalBug(root, bug);
  return { ok: true, id: bug.id, shared: false, ...rejected(errors) };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Everything a read wants to know about one bug's code, computed HERE and never stored. */
async function drift(root: string, bugs: SharedBug[]) {
  const store = await readAnchorStore(root);
  const files = new Set<string>();
  for (const b of bugs) for (const a of b.anchors) {
    const anchor = store.anchors.find((x) => x.id === a.anchorId);
    if (anchor) files.add(anchor.file);
  }
  const live = await liveAnchors(root, files);
  return { store, live, idx: liveIndex(root, live) };
}

const publicView = (b: SharedBug, changed: string[]) => ({
  id: b.id,
  title: b.title,
  state: b.state,
  severity: b.severity,
  category: b.category,
  anchors: citedAnchors(b),
  author: b.author.principal,
  createdAt: b.createdAt,
  filedAt: b.filedAt,
  // Where this machine's copy came from: absent means nobody else has it yet.
  shared: !!b.origin,
  comments: b.thread.length,
  tracked: isTracked(b),
  tracking: b.tracking.map((t) => ({ system: t.system, key: t.key, url: t.url })),
  from: b.from,
  waitingOnYou: !isClosed(b.state) && (needsHumanAck(b) || !!b.pending || !!b.contested?.length),
  /**
   * The outstanding ASK, in the list and not only in the detail.
   *
   * An agent may not bury a finding somebody stood behind, so `setState` turns the
   * attempt into a pending ask rather than refusing it. The list folded that into
   * `waitingOnYou` alongside four other reasons — so "an agent believes this is fixed
   * and is asking you to close it" was indistinguishable from "somebody contested the
   * severity", and the one queue a person most wants was unreadable.
   */
  pending: b.pending ? { ask: b.pending.ask, by: b.pending.by.principal, at: b.pending.at, rationale: b.pending.rationale } : undefined,
  /** The latest report — `fixed` is the one a reader is scanning for. `outcomes` is the record. */
  reported: b.outcome ? { result: b.outcome.result, by: b.outcome.by.principal, at: b.outcome.at } : undefined,
  contested: b.contested?.map((c) => c.field) ?? [],
  // Judged against LIVE hashes, never the stored ones — an open bug whose code moved
  // may have been fixed by that change, and is the one to re-validate.
  possiblyFixed: !isClosed(b.state) && changed.length > 0,
  // Code moved under the bug regardless of state (a closed bug whose code changed may
  // warrant a fresh look); `possiblyFixed` narrows this to the ones still open.
  codeChanged: changed.length > 0,
  changedAnchors: changed,
});

/**
 * Which of the three a backlogged bug is in — derived, never stored, so no fold can
 * disagree with it.
 *
 * The same shape the finding backlog's buckets have and for the same reason: the date is
 * the guaranteed release condition, and drift against the witnesses TAKEN AT GRANT TIME
 * is the early wake, meaning somebody is editing the exact code the decision was about.
 *
 * At module scope so the list and the detail cannot answer differently about one bug.
 */
export function bugBacklogState(
  b: SharedBug, idx: ReturnType<typeof liveIndex>, asOf: string,
): "sleeping" | "due" | "woken" | undefined {
  if (!b.backlogged) return undefined;
  if (b.backlogged.until <= asOf) return "due";
  const w = b.backlogged.witnesses ?? [];
  return w.length && realDrift(witnessDrift(w, idx)).length ? "woken" : "sleeping";
}

/**
 * The backlog marker as a row carries it: the record plus its derived state.
 *
 * On EVERY row that lists the bug, never only on the backlog view. The hard constraint
 * is that a deferred bug is out of the working queue and out of nothing else — and
 * without the marker travelling with it, it reads as an ordinary open bug nobody is
 * doing, which is the exact appearance the backlog exists to replace.
 *
 * Not in `publicView`, because the derived state needs today's index and `publicView`
 * is a pure projection of the record.
 */
const backloggedRow = (b: SharedBug, state: "sleeping" | "due" | "woken" | undefined) =>
  b.backlogged && state
    ? { until: b.backlogged.until, reason: b.backlogged.reason, by: b.backlogged.by.principal, at: b.backlogged.at, state }
    : undefined;

/**
 * Through `parseAsOf` like every other `asOf` in the tree, because the comparison is
 * LEXICOGRAPHIC: a caller-supplied `"today"` — which is what an agent reaches for — would
 * make every deadline read as passed and empty the sleeping list into the working one.
 * Throws on a value it cannot round-trip, exactly as every other consumer does.
 */
const dayOf = (asOf?: string) => (asOf ? parseAsOf(asOf).at.slice(0, 10) : new Date().toISOString().slice(0, 10));

export const BUG_SORTS = ["severity", "newest", "oldest", "title"] as const;
export type BugSort = (typeof BUG_SORTS)[number];

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
/** `filedAt` is when the team saw it; `createdAt` is when this machine minted it. */
const when_ = (b: { filedAt?: string; createdAt?: string }) => b.filedAt ?? b.createdAt ?? "";

/**
 * List bugs, flagging those whose anchored code changed since filing ("possibly fixed").
 *
 * `sort` defaults to `severity`, because the list had no order at all — it came back in
 * whatever order the store held, which for a triage surface means the first thing you read
 * is an accident. Severity descending, then newest, so the tie-break is also not one.
 */
export async function listBugs(
  root: string,
  opts: { state?: BugState; open?: boolean; queue?: boolean; asked?: boolean; backlog?: boolean; sort?: BugSort; asOf?: string } = {},
) {
  await refreshBugRows(root);
  const all = (await readBugs(root)).bugs;
  const { idx } = await drift(root, all);
  const changedFor = (b: SharedBug) => realDrift(witnessDrift(witnessesOf(b), idx)).map((c) => c.anchorId);
  const asOf = dayOf(opts.asOf);
  const backlogState = (b: SharedBug) => bugBacklogState(b, idx, asOf);
  /**
   * Asleep, and therefore out of the WORKING list — the only thing backlogging does.
   *
   * A `due` or `woken` bug comes back on its own: the release condition has fired, and
   * needing somebody to visit a separate page for that would make the deadline a note
   * rather than a mechanism. It is filtered from this list and from nothing else — see
   * `SharedBug.backlogged` for why a bug's backlog cannot be quiet the way a finding's
   * `sleeping` can.
   */
  const asleep = (b: SharedBug) => backlogState(b) === "sleeping";

  let bugs = all;
  if (opts.state) bugs = bugs.filter((b) => b.state === opts.state);
  if (opts.open) bugs = bugs.filter((b) => !isClosed(b.state));
  // The deferral register — its own list, not a bucket, because bugs already have a
  // queue people read and the point is that the main one means "what we are doing".
  //
  // **Only the WORKING views drop a sleeping bug, and `all` is not one of them.** The
  // first version dropped it from every view that was not the register, which quietly
  // broke the one hard constraint here — out of the working queue and out of NOTHING
  // else. It was reachable from the product: a search hit for a backlogged bug links to
  // `state=all`, so clicking it opened a list that did not contain the bug you clicked.
  // An explicit `state=` filter is a question about state, not a queue, so it answers
  // with everything in that state too.
  // The WORKING views name themselves — `open` is what the default page sends, and
  // `queue`/`asked` are the two narrower ones. Everything else (an explicit `state=`, the
  // "all" view, and a bare `list_bugs`) is a question rather than a queue, and answers
  // with the deferred ones in it.
  const workingView = !!opts.open || !!opts.queue || !!opts.asked;
  if (opts.backlog) bugs = bugs.filter((b) => !!b.backlogged);
  else if (workingView) bugs = bugs.filter((b) => !asleep(b));

  let rows = bugs.map((b) => ({ ...publicView(b, changedFor(b)), backlogged: backloggedRow(b, backlogState(b)) }));
  // The queue is the whole point of sharing them: what needs a PERSON here. Drift is in
  // it and is not in the log's own `bugAckQueue`, which cannot see this machine's index.
  // Narrower than the queue, and the difference is the point: "somebody is asking you to
  // close this" is a different job from "somebody contested the severity".
  //
  // NOT CLOSED, and that is not a detail. `bug.stateChanged` clears `pending` but keeps the
  // outcome as history, so a bug reported fixed and then resolved by a person carried
  // `reported.result === "fixed"` for ever — and sat in the "asked to close" queue for
  // ever with it, asking for a decision that had already been made.
  const isAsk = (r: typeof rows[number]) =>
    !isClosed(r.state) && (!!r.pending || r.reported?.result === "fixed");
  // Over every bug the WORKING lists can show, not over `rows`. These were derived from
  // a list already narrowed by `state`/`open` — so the chip said N while the view it
  // opens (which sends its own filter) showed something else. A count that disagrees
  // with the thing it links to is worse than no count.
  //
  // Which is also why the deferred ones are out of it: they are out of every list these
  // chips open, and counting a live deferral as work makes deferring honestly look
  // identical to ignoring the thing — the reason `sleeping` is excluded from the
  // finding backlog's `attention`. `backlogged` and `sleeping` below are the other half,
  // so nothing is uncounted.
  const awake = all.filter((b) => !asleep(b));
  const everyRow = awake.map((b) => ({ ...publicView(b, changedFor(b)), backlogged: backloggedRow(b, backlogState(b)) }));
  const queueAll = everyRow.filter((r) => r.waitingOnYou || r.possiblyFixed);
  const askedAll = everyRow.filter(isAsk);
  if (opts.queue) rows = rows.filter((r) => r.waitingOnYou || r.possiblyFixed);
  else if (opts.asked) rows = rows.filter(isAsk);

  const sort: BugSort = BUG_SORTS.includes(opts.sort as BugSort) ? opts.sort as BugSort : "severity";
  const cmp: Record<BugSort, (a: typeof rows[number], b: typeof rows[number]) => number> = {
    severity: (a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) || when_(b).localeCompare(when_(a)),
    newest: (a, b) => when_(b).localeCompare(when_(a)),
    oldest: (a, b) => when_(a).localeCompare(when_(b)),
    title: (a, b) => (a.title ?? "").localeCompare(b.title ?? ""),
  };
  rows = [...rows].sort(cmp[sort]);

  return {
    // Per-STATE counts are over everything, because the per-state lists are. Only the
    // queue counts below narrow, and they narrow to exactly what their own list shows.
    counts: all.reduce((m, b) => ((m[b.state] = (m[b.state] ?? 0) + 1), m), {} as Record<string, number>),
    open: awake.filter((b) => !isClosed(b.state)).length,
    shared: all.filter((b) => b.origin).length,
    waitingOnYou: queueAll.length,
    /** How many are somebody asking you to close, or reported fixed. Of ALL of them. */
    asked: askedAll.length,
    /**
     * The deferral register's size, and how much of it is actually asleep.
     *
     * Of ALL of them, like the counts above: a chip that disagrees with the list it
     * links to is worse than no chip. `sleeping` is what the working list is missing;
     * `backlogged - sleeping` has already woken and is in it.
     */
    backlogged: all.filter((b) => !!b.backlogged).length,
    sleeping: all.filter(asleep).length,
    sort,
    bugs: rows,
  };
}

/**
 * Full detail for one bug: prose, thread, and each cited anchor resolved to its live
 * symbol/file/lines with a `stale` flag (the anchor's code changed since the witness was
 * taken — the same mechanism as doc and review staleness).
 */
export async function bugDetail(root: string, id: string) {
  await refreshBugRows(root);
  const bug = await readBug(root, id);
  if (!bug) return { error: `no bug "${id}"` };
  const { store, live, idx } = await drift(root, [bug]);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));

  const anchors = bug.anchors.map((cite) => {
    const a = byId.get(cite.anchorId);
    const liveA = live.get(cite.anchorId);
    const loc = liveA?.loc ?? a?.loc;
    const w = [{ anchorId: cite.anchorId, bodyHash: cite.bodyHash }];
    return {
      id: cite.anchorId,
      symbol: a ? a.symbolPath.join(" › ") : cite.anchorId.slice(0, 12),
      file: a?.file ?? null,
      lines: loc ? `${loc.startLine}-${loc.endLine}` : null,
      present: !!liveA,
      citedBy: cite.by.principal,
      removed: cite.removed ? { by: cite.removed.by.principal, at: cite.removed.at, reason: cite.removed.reason } : undefined,
      // Stale when the live code no longer matches the witness — but an id this build
      // could not have minted is not a body that moved, and saying so needs the
      // resolution rather than a bare hash comparison.
      stale: !cite.removed && realDrift(witnessDrift(w, idx)).length > 0,
      // And `present: false` alone would move the confident claim rather than remove it:
      // absent + not-stale reads as "renamed or removed, and the bug is unaffected".
      // This says which of the two absences it is.
      unverifiable: !liveA && witnessDrift(w, idx).some((c) => c.unverifiable),
    };
  });
  const changed = anchors.filter((a) => a.stale).map((a) => a.id);

  return {
    ...publicView(bug, changed),
    backlogged: backloggedRow(bug, bugBacklogState(bug, idx, dayOf())),
    text: bug.text,
    createdCommit: bug.createdCommit,
    anchors,
    staleAnchors: changed.length,
    thread: bug.thread.map((c) => ({ id: c.id, by: c.actor.principal, via: c.actor.via, at: c.at, body: c.body, inReplyTo: c.inReplyTo })),
    corroboration: bug.corroboration.map((c) => ({ by: c.actor.principal, via: c.actor.via, verdict: c.verdict, rationale: c.rationale, at: c.at, independent: c.independent })),
    contestedFields: bug.contested ?? [],
    promotion: bug.promotion ? { by: bug.promotion.by.principal, at: bug.promotion.at } : undefined,
    assignment: bug.assignment ? { ...bug.assignment, by: bug.assignment.by.principal } : undefined,
    outcome: bug.outcome ? { ...bug.outcome, by: bug.outcome.by.principal } : undefined,
    pending: bug.pending ? { ...bug.pending, by: bug.pending.by.principal } : undefined,
    closed: bug.closed ? { ...bug.closed, by: bug.closed.by.principal } : undefined,
    revisions: bug.revisions.map((r) => ({ at: r.at, by: r.by.principal, was: r.was })),
  };
}

/**
 * Fold the bugs scope into rows before a read.
 *
 * Fail-closed, never fail-crashed: an unreadable sidecar must not break a local bug
 * list. The rows this machine already has are still there, and the next sync retries.
 */
export async function refreshBugRows(root: string): Promise<void> {
  const log = bugLog(root);
  if (!log || "error" in log) return;
  await materializeBugs(root, log.cfg).catch(() => false);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Where a write to bug `id` goes.
 *
 * A bug the fold owns may only be changed by an event — the ownership rule, and the
 * failure it prevents is quiet: nothing about a local mutation moves the scope
 * fingerprint, so the cache serves the corrupted row until something forces a re-fold
 * and the change then vanishes.
 */
async function routeWrite(root: string, id: string): Promise<
  { log: BugLog; bug: SharedBug } | { local: SharedBug } | { error: string }
> {
  // Fold first. A bug a teammate filed is in the log the moment their push lands, and a
  // machine that has pulled but not read would otherwise answer "no bug" for one it
  // holds. Cheap — an unchanged scope costs a fingerprint of its shard directory.
  await refreshBugRows(root);
  const bug = await readBug(root, id);
  if (!bug) return { error: `no bug "${id}"` };
  const log = bugLog(root);
  if (log && "error" in log) return log;
  if (log) return { log, bug };
  if (bug.origin) {
    return { error: `${id} came from the sidecar (${bug.origin.scope}) and there is no sidecar configured now — nothing here may write to it` };
  }
  return { local: bug };
}

/**
 * Change a bug: state, severity, prose, citations.
 *
 * With a sidecar, each of those is a separate event, because they are separate acts with
 * separate merge rules — a state change is ratcheted, a citation is grow-only, and prose
 * can be contested. Bundling them into one event would force one rule onto all three.
 */
export async function updateBug(
  root: string,
  input: {
    id: string; state?: BugState; reason?: string; note?: string; addAnchors?: string[];
    refreshWitnesses?: boolean; title?: string; description?: string; severity?: BugSeverity; category?: string;
  },
) {
  const r = await routeWrite(root, input.id);
  if ("error" in r) return r;
  const rejects: string[] = [];
  const done: string[] = [];

  // Resolve citations first: it is the one part that can fail on its own, and a
  // partial acceptance should still report what it took.
  let added: BugWitness[] = [];
  if (input.addAnchors?.length) {
    const w = await witnessRefs(root, input.addAnchors);
    rejects.push(...w.errors);
    added = w.witnesses;
  }
  // Deliberately NOT also on `state: "resolved"`, which is what the local-only version
  // did. Refreshing erases the evidence that the code moved, and the reason it was there
  // — stopping a closed bug being flagged — is already handled: `possiblyFixed` is
  // false for anything closed, whatever its witnesses say.
  if (input.refreshWitnesses) {
    const existing = "bug" in r ? r.bug : r.local;
    const w = await witnessRefs(root, citedAnchors(existing));
    rejects.push(...w.errors);
    added = [...added, ...w.witnesses];
  }

  if ("local" in r) {
    const bug = r.local;
    const actor = requireActor(root);
    if ("error" in actor) return actor;
    const at = new Date().toISOString();
    if (input.title) bug.title = input.title;
    if (input.description) bug.text = input.description;
    if (input.severity) bug.severity = input.severity;
    if (input.category) bug.category = input.category;
    for (const w of added) {
      const hit = bug.anchors.find((a) => a.anchorId === w.anchorId);
      if (!hit) bug.anchors.push({ ...w, by: actor, at });
      else if (!hit.removed) { hit.bodyHash = w.bodyHash; hit.by = actor; hit.at = at; }
    }
    if (input.note) bug.thread.push({ id: genId("c"), actor, at, body: input.note });
    if (input.state && input.state !== bug.state) {
      bug.state = input.state;
      bug.closed = isClosed(input.state) ? { at, by: actor, reason: input.reason ?? input.state } : undefined;
    }
    await writeLocalBug(root, bug);
    return { ok: true, id: bug.id, state: bug.state, shared: false, ...rejected(rejects) };
  }

  const { log, bug } = r;
  let state = bug.state;
  const out = await onBugLog(log, root, async (logRoot, universe, actor) => {
    const revised: Record<string, unknown> = {};
    if (input.title && input.title !== bug.title) revised.title = input.title;
    if (input.description && input.description !== bug.text) revised.text = input.description;
    if (input.severity && input.severity !== bug.severity) revised.severity = input.severity;
    if (input.category && input.category !== bug.category) revised.category = input.category;
    if (Object.keys(revised).length) {
      await reviseBug(logRoot, universe, actor, bug.id, revised);
      done.push("revised");
    }
    if (added.length) { await anchorBug(logRoot, universe, actor, bug.id, added); done.push("anchored"); }
    if (input.note) { await commentOnBug(logRoot, universe, actor, bug.id, input.note); done.push("commented"); }
    if (input.state && input.state !== bug.state) {
      const e = await setBugState(logRoot, universe, actor, bug.id, input.state, input.reason);
      // The ratchet's refusal is the answer, not a partial success to swallow: an agent
      // told "done" while the state never moved will report the bug as closed.
      if ("error" in e) return { error: e.error, applied: done };
      state = input.state;
      done.push(`state -> ${input.state}`);
    }
    return null;
  });
  if (out && "error" in out) return out;
  return { ok: true, id: bug.id, state, shared: true, applied: done, ...rejected(rejects) };
}

/**
 * Backlog a bug — real, not now, and it comes back.
 *
 * The third exit, one record kind over from the finding backlog, and the argument is
 * `docs/finding-backlog.md`'s: a bug nobody will reach this quarter currently either
 * dilutes the open queue or is closed as won't-fix, which asserts a decision nobody
 * made. The first is what happens, and it is how a bug queue stops being read.
 *
 * **It leaves the WORKING queue and nothing else.** `listBugs` filters it out of the
 * default list and `search` does not filter it at all — see `SharedBug.backlogged` for
 * why that asymmetry is the whole constraint here.
 *
 * **The witnesses are snapshotted NOW**, from the working tree, not read off the bug's
 * citations. Backlogging follows an investigation, so a condition keyed on the filing
 * hashes fires the instant it is set, on code that moved days ago. This is the subtlety
 * the finding side had to fix and the one an implementation drifts from first.
 *
 * Principal-only, and the fold enforces it too. The refusal here exists to produce a
 * sentence rather than a silently dropped event.
 */
export async function backlogBugOp(
  root: string, id: string,
  input: { until: string; reason: string; ref?: { system: string; key?: string; url?: string } },
) {
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  if (isAgentActor(actor)) {
    return {
      error:
        "backlogging a bug is a person's decision, not an agent's — it is the cheapest way to "
        + "empty a queue, so it is granted the way `debt` is. Ask for it instead, and say what "
        + "the release condition should be.",
    };
  }
  const shared = await import("../ops-shared.js");
  const guard = shared.checkBacklogInput(input, "bug");
  if (guard) return guard;
  // Normalized ONCE, here, so both stores write the same strings. The finding path
  // shipped the other way round: the guard trimmed before validating and the two stores
  // then wrote different things, and `" 2027-01-01"` sorts below every digit — so an
  // identical request produced a bug due for ever locally and asleep until 2027 on the
  // team's copy.
  const until = shared.backlogUntil(input.until), reason = input.reason.trim();

  const bug = "bug" in r ? r.bug : r.local;
  // Best-effort, like the finding path: a bug whose code has already left the tree still
  // backlogs, with the date as its only release condition — which is exactly what an
  // acknowledgement has, so nothing is lost by comparison.
  const witnesses = (await witnessRefs(root, citedAnchors(bug))).witnesses;

  if ("local" in r) {
    const at = new Date().toISOString();
    r.local.backlogged = {
      until, reason, by: actor, at,
      ...(witnesses.length ? { witnesses } : {}),
      ...(input.ref ? { ref: { ...input.ref, at, by: actor } } : {}),
    };
    await writeLocalBug(root, r.local);
    return { ok: true, id, shared: false, until, witnessed: witnesses.length };
  }
  const out = await onBugLog(r.log, root, (logRoot, universe, who) =>
    backlogBugEvent(logRoot, universe, who, id, { until, reason, witnesses, ref: input.ref }));
  if (out && "error" in out) return out;
  return { ok: true, id, shared: true, until, witnessed: witnesses.length };
}

/** Bring one back into the working queue. A person's, exactly as backlogging is. */
export async function releaseBugBacklogOp(root: string, id: string, reason: string) {
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  if (isAgentActor(actor)) return { error: "bringing a bug back is a person's, exactly as backlogging it is" };
  if (!reason?.trim()) return { error: "say why it is coming back — it is the other half of the record" };
  const bug = "bug" in r ? r.bug : r.local;
  if (!bug.backlogged) return { error: `${id} is not backlogged` };

  if ("local" in r) {
    // The reason is RECORDED, not merely demanded. The finding path shipped
    // required-field theatre here — refusing an empty reason and then discarding it —
    // on the store that holds most of the backlog.
    r.local.thread.push({
      id: genId("c"), actor, at: new Date().toISOString(),
      body: `brought back from the backlog: ${reason.trim()}`,
    });
    delete r.local.backlogged;
    await writeLocalBug(root, r.local);
    return { ok: true, id, shared: false };
  }
  const out = await onBugLog(r.log, root, (logRoot, universe, who) =>
    releaseBugBacklogEvent(logRoot, universe, who, id, reason.trim()));
  if (out && "error" in out) return out;
  return { ok: true, id, shared: true };
}

/** Say something on a bug. The team surface the old free-text `history` was standing in for. */
export async function commentBug(root: string, id: string, body: string, inReplyTo?: string) {
  if (!body.trim()) return { error: "an empty comment says nothing" };
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  if ("local" in r) return updateBug(root, { id, note: body });
  const e = await onBugLog(r.log, root, (logRoot, universe, actor) =>
    commentOnBug(logRoot, universe, actor, id, body, inReplyTo));
  return { ok: true, id, comment: e.id };
}

/**
 * Record that this bug is tracked somewhere outside codemap.
 *
 * A Jira key, a GitHub issue, whatever the team uses. It does NOT close the bug: being
 * in a tracker is not being fixed, and the witness is still what decides that here.
 */
export async function trackBugExternally(
  root: string, id: string, ref: { system?: string; key?: string; url?: string },
) {
  if (!ref.key?.trim() && !ref.url?.trim()) {
    return { error: "a tracking reference needs a key or a URL — one of them is what somebody clicks" };
  }
  if (ref.url && !/^https?:\/\//i.test(ref.url)) {
    return { error: `"${ref.url}" is not a link — an external reference has to be a http(s) URL` };
  }
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  if ("local" in r) {
    return { error: `no sidecar is configured, so there is nowhere to record that ${id} is tracked in ${ref.system ?? "jira"}. Point one at a shared repo first.` };
  }
  await onBugLog(r.log, root, (logRoot, universe, actor) => trackBug(logRoot, universe, actor, id, ref));
  const after = await readBug(root, id);
  const held = after?.tracking.find((t) => t.system === (ref.system ?? "jira"));
  return {
    ok: true, id, tracking: after?.tracking.map((t) => ({ system: t.system, key: t.key, url: t.url })) ?? [],
    note: held && held.key === ref.key && held.url === ref.url
      ? "tracked; still open here until the code says otherwise"
      : `${ref.system ?? "jira"} is already recorded as ${held?.key ?? held?.url} — an agent may not re-point it`,
  };
}

/** Drop a citation from a bug. A person's act; the fold ignores an agent's. */
export async function unanchorBugOp(root: string, id: string, anchorId: string, reason: string) {
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  if ("local" in r) {
    const bug = r.local;
    const actor = requireActor(root);
    if ("error" in actor) return actor;
    if (actor.via) return { error: "removing the evidence under a bug is a person's call — say what you found in a comment instead" };
    const hit = bug.anchors.find((a) => a.anchorId === anchorId);
    if (!hit || hit.removed) return { error: `${id} does not cite ${anchorId.slice(0, 12)}` };
    hit.removed = { by: actor, at: new Date().toISOString(), reason };
    await writeLocalBug(root, bug);
    return { ok: true, id, anchorId };
  }
  const e = await onBugLog(r.log, root, (logRoot, universe, actor) =>
    unanchorBug(logRoot, universe, actor, id, anchorId, reason));
  return "error" in e ? e : { ok: true, id, anchorId };
}

/** A second opinion on somebody's bug. The disagreement is the signal — never collapsed. */
export async function corroborateBugOp(root: string, id: string, verdict: Verdict, rationale: string) {
  if (!rationale.trim()) return { error: "a verdict without a rationale is a vote, not a review — say what you checked" };
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  if ("local" in r) return { error: `no sidecar is configured, so there is nobody to corroborate ${id} for` };
  await onBugLog(r.log, root, (logRoot, universe, actor) => corroborateBug(logRoot, universe, actor, id, verdict, rationale));
  return { ok: true, id, verdict };
}

/** Surface a bug for team-wide human attention. A latch; saying it twice is not a change. */
export async function promoteBugOp(root: string, id: string) {
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  if ("local" in r) return { error: `no sidecar is configured, so there is no team to surface ${id} to` };
  await onBugLog(r.log, root, (logRoot, universe, actor) => promoteBug(logRoot, universe, actor, id));
  return { ok: true, id, note: "surfaced for the team; it does not gate anyone's triage" };
}

/** Ask a person to do what the ratchet will not let an agent do. */
export async function requestOnBugOp(root: string, id: string, ask: Ask, rationale: string) {
  if (!rationale.trim()) return { error: `asking to ${ask} without saying why leaves the human nothing to act on` };
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  if ("local" in r) return { error: `no sidecar is configured, so there is nobody to ask about ${id}` };
  await onBugLog(r.log, root, (logRoot, universe, actor) => requestOnBug(logRoot, universe, actor, id, ask, rationale));
  return { ok: true, id, ask, note: "queued for a person to acknowledge" };
}

/** Settle a field two people set differently. A person only. */
export async function resolveBugContestOp(root: string, id: string, field: string, value: unknown) {
  const r = await routeWrite(root, id);
  if ("error" in r) return r;
  if ("local" in r) return { error: `${id} is local — nothing can contest it` };
  const e = await onBugLog(r.log, root, (logRoot, universe, actor) =>
    resolveBugContest(logRoot, universe, actor, id, field, value));
  return "error" in e ? e : { ok: true, id, field };
}

// ---------------------------------------------------------------------------
// Publishing what was already here
// ---------------------------------------------------------------------------

/**
 * Send this machine's local bugs to the team.
 *
 * The backfill path, not the ordinary one: with a sidecar configured `report_bug`
 * already files into the log. What this is for is the backlog that predates the
 * sidecar — bugs migrated out of the old blob, or filed before anyone configured one.
 */
export async function publishBugs(root: string, opts: { dryRun?: boolean; ids?: string[] } = {}) {
  const log = bugLog(root);
  if (!log) return { error: "no sidecar configured for this universe — there is nowhere to publish to" };
  if ("error" in log) return log;

  const all = (await readBugs(root)).bugs;
  let local = all.filter((b) => !b.origin);
  if (opts.ids?.length) {
    const want = new Set(opts.ids);
    const missing = opts.ids.filter((id) => !all.some((b) => b.id === id));
    if (missing.length) return { error: `no such bug: ${missing.join(", ")}` };
    local = local.filter((b) => want.has(b.id));
  }

  // AFTER the filter and BEFORE any write. A count must not write.
  if (opts.dryRun) {
    return {
      universe: log.cfg.universe, total: all.length,
      alreadyShared: all.length - local.filter((b) => !b.origin).length,
      wouldPublish: local.length,
      bugs: local.map((b) => ({ id: b.id, title: b.title, state: b.state })),
    };
  }

  // A DEFERRAL cannot be published by an agent, and skipping it loudly is the only honest
  // option. `publishBug` re-emits `bug.backlogged` as the PUBLISHER, and the fold drops an
  // agent's — correctly, since an agent may not grant one — so publishing here would put
  // the bug on the team stripped of a person's decision, back in everybody's working
  // queue, with `published: N` and no mention of it. Verified by folding the log after an
  // agent publish: the bug arrives and the deferral is gone.
  const actor = requireActor(root);
  const byAnAgent = !("error" in actor) && isAgentActor(actor);
  const deferred = byAnAgent ? local.filter((b) => !!b.backlogged) : [];
  const publishable = byAnAgent ? local.filter((b) => !b.backlogged) : local;

  const published: string[] = [];
  for (const b of publishable) { await publishBug(log, root, b); published.push(b.id); }
  return {
    universe: log.cfg.universe, published: published.length, ids: published,
    ...(deferred.length ? { skipped: deferred.map((b) => b.id) } : {}),
    note: deferred.length
      ? `${deferred.length} bug(s) carry a person's deferral and were NOT published: publishing them `
        + `from an agent session would drop it, because the fold refuses an agent's. Ask a person to `
        + `run this.`
      : published.length ? "run `codemap sync` to send them" : "nothing local left to publish",
  };
}

// ---------------------------------------------------------------------------
// Accepting a finding
// ---------------------------------------------------------------------------

/**
 * Turn a pull-request finding into a bug, so it is not lost when the PR closes.
 *
 * The finding SURVIVES and cross-links: the PR's history should still show it was
 * raised there. What transfers is the OBLIGATION — the finding stops asking for a
 * decision because its successor is asking.
 *
 * The bug's id is derived from the finding's (`bugIdFor`) rather than minted. Two people
 * accepting the same finding offline would otherwise create two bugs for one defect, and
 * that is the duplicate this log exists to prevent; derived, both write the same id and
 * the fold merges them into one bug carrying both people's citations.
 */
export async function acceptFinding(
  root: string, pr: number | string, findingId: string,
  opts: { title?: string; severity?: BugSeverity } = {},
) {
  const log = bugLog(root);
  if (!log) return { error: "no sidecar configured for this universe — a finding can only be accepted into a shared bug" };
  if ("error" in log) return log;

  const shared = await import("../ops-shared.js");
  const f = await shared.findingRecord(root, pr, findingId);
  if ("error" in f) return f;
  if (f.bug) return { error: `${findingId} is already bug ${f.bug}` };

  // A finding on a NODE cites no anchor of its own. Its citations are this reader's
  // local node, which is a derivation — so accepting one is a judgement about what the
  // defect covers, made here, and the witnesses are taken here. That is an authored act
  // and belongs in the log; guessing it silently would not.
  const refs = f.target.kind === "anchor" ? [f.target.id] : (f.nodeAnchors ?? []);
  // The ref the finding was WITNESSED at — usually the pull request's head, which is
  // where code the branch introduces lives. Without it this refused the ordinary case on
  // a feature branch and told the caller to index a branch the store had already indexed.
  const { witnesses, errors } = await witnessRefs(root, refs, f.sourceRef, { includeOrphans: true });
  if (!witnesses.length) {
    return {
      error: `${findingId} points at ${f.target.kind} ${f.target.id.slice(0, 12)}, which resolves to no anchor here`
        + `${f.sourceRef ? ` or at ${String(f.sourceRef).slice(0, 12)}` : ""}`
        + `${errors.length ? ` (${errors.join("; ")})` : ""} — run \`codemap pr ${pr}\` to snapshot the branch, then try again`,
    };
  }

  const id = bugIdFor(findingId);
  await onBugLog(log, root, (logRoot, universe, actor) => fileBug(logRoot, universe, actor, {
    id,
    title: opts.title ?? f.text.split("\n")[0]!.slice(0, 120),
    // The full evidence, plus the submitter-facing summary if the finding had one.
    text: f.comment && f.comment !== f.text ? `${f.text}\n\n---\n\n${f.comment}` : f.text,
    severity: opts.severity ?? f.severity,
    category: f.category,
    anchors: witnesses,
    createdCommit: headCommit(root) ?? undefined,
    from: { pr, finding: findingId },
  }));
  const link = await shared.findingToBug(root, pr, findingId, id);
  if ("error" in link) return link;
  return {
    ok: true, id, finding: findingId, pr,
    note: "accepted — the finding stays on the pull request and the bug now carries the obligation",
    ...(await massConversionWarning(root, pr)),
    ...rejected(errors),
  };
}

/**
 * WARNS on the run, never on the act, and never refuses — the `cover` precedent.
 *
 * Converting a finding that is a real defect is the ordinary, correct use and should stay
 * easy. What devalues a bug queue is doing it in BULK to clear a pull request, until
 * "defects we said we would fix" quietly becomes "things reported on a PR six months
 * ago". Nothing can tell those apart from one call; a running count makes the second
 * visible while it is happening.
 *
 * **Here rather than on `deferFinding`, because this is where every route converges** —
 * the MCP tool, the CLI, and the web button, which posts straight to this function. It
 * was on the caller, so the one surface a person actually sweeps a queue from was the one
 * surface the guard could not reach.
 *
 * `warning`, not `note`: the caller already returns a note, and overwriting it would
 * trade one message for another rather than adding one.
 */
async function massConversionWarning(root: string, pr: number | string): Promise<{ warning?: string }> {
  // Counted from the canonical table rather than tracked, so it cannot drift and costs
  // one query. `bug` is set only by `finding.promotedToBug`, the act being counted.
  const { readFindings } = await import("../store.js");
  const sofar = await readFindings(root, { pr }).then((r) => r.findings.filter((x) => x.bug).length).catch(() => 0);
  if (sofar < MASS_CONVERSION) return {};
  return {
    warning:
      `${sofar} findings on ${pr} are now bugs. A queue swept in bulk stops reading as `
      + `"defects we said we would fix". If the rest are real but not worth a bug record, they can be `
      + `backlogged instead — a person's act, and they keep their witness and come back.`,
  };
}

/** Where a run of conversions stops looking like triage and starts looking like a sweep. */
const MASS_CONVERSION = 5;
