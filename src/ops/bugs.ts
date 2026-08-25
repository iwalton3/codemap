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

import { type BugSeverity, type BugWitness } from "../schema.js";
import { headCommit } from "../git.js";
import { readAnchorStore, readBugs, readBug, writeLocalBug, findAnchorsOutsideWork, readOrphans } from "../store.js";
import { witnessDrift, realDrift } from "../reviews.js";
import { requireActor } from "../identity.js";
import {
  bugLog, materializeBugs, onBugLog, publishBug, type BugLog,
} from "../bugs-publish.js";
import {
  anchorBug, bugIdFor, citedAnchors, commentOnBug, corroborateBug, fileBug, isClosed,
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
  contested: b.contested?.map((c) => c.field) ?? [],
  // Judged against LIVE hashes, never the stored ones — an open bug whose code moved
  // may have been fixed by that change, and is the one to re-validate.
  possiblyFixed: !isClosed(b.state) && changed.length > 0,
  // Code moved under the bug regardless of state (a closed bug whose code changed may
  // warrant a fresh look); `possiblyFixed` narrows this to the ones still open.
  codeChanged: changed.length > 0,
  changedAnchors: changed,
});

/** List bugs, flagging those whose anchored code changed since filing ("possibly fixed"). */
export async function listBugs(root: string, opts: { state?: BugState; open?: boolean; queue?: boolean } = {}) {
  await refreshShared(root);
  const all = (await readBugs(root)).bugs;
  const { idx } = await drift(root, all);
  const changedFor = (b: SharedBug) => realDrift(witnessDrift(witnessesOf(b), idx)).map((c) => c.anchorId);

  let bugs = all;
  if (opts.state) bugs = bugs.filter((b) => b.state === opts.state);
  if (opts.open) bugs = bugs.filter((b) => !isClosed(b.state));

  const rows = bugs.map((b) => publicView(b, changedFor(b)));
  // The queue is the whole point of sharing them: what needs a PERSON here. Drift is in
  // it and is not in the log's own `bugAckQueue`, which cannot see this machine's index.
  const queue = rows.filter((r) => r.waitingOnYou || r.possiblyFixed);
  return {
    counts: all.reduce((m, b) => ((m[b.state] = (m[b.state] ?? 0) + 1), m), {} as Record<string, number>),
    shared: all.filter((b) => b.origin).length,
    waitingOnYou: queue.length,
    bugs: opts.queue ? queue : rows,
  };
}

/**
 * Full detail for one bug: prose, thread, and each cited anchor resolved to its live
 * symbol/file/lines with a `stale` flag (the anchor's code changed since the witness was
 * taken — the same mechanism as doc and review staleness).
 */
export async function bugDetail(root: string, id: string) {
  await refreshShared(root);
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
async function refreshShared(root: string): Promise<void> {
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
  await refreshShared(root);
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

  const published: string[] = [];
  for (const b of local) { await publishBug(log, root, b); published.push(b.id); }
  return {
    universe: log.cfg.universe, published: published.length, ids: published,
    note: published.length ? "run `codemap sync` to send them" : "nothing local left to publish",
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
    ...rejected(errors),
  };
}
