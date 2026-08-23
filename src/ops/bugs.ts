import { type Bug, type BugStatus, type BugSeverity } from "../schema.js";
import { headCommit } from "../git.js";
import { readAnchorStore, readBugs, writeBugs } from "../store.js";
import { witnessDrift, realDrift } from "../reviews.js";
import { genId, liveIndex, liveAnchors, resolveRefs, rejected } from "./shared.js";

// ---------------------------------------------------------------------------
// Bugs
// ---------------------------------------------------------------------------

export async function reportBug(
  root: string,
  input: { title: string; description: string; anchors: string[]; severity?: BugSeverity },
) {
  const r = await resolveRefs(root, input.anchors);
  // Partial acceptance (see resolveRefs) — a bug still needs somewhere to point.
  if (!r.ids.length) return { error: r.errors.join("; ") || "no anchors given" };
  const anchorIds = r.ids;
  const store = await readAnchorStore(root);
  const files = anchorIds.map((id) => store.anchors.find((a) => a.id === id)!.file);
  const live = await liveAnchors(root, files);
  const witnesses = anchorIds.map((id) => ({ anchorId: id, bodyHash: live.get(id)?.bodyHash ?? "sha256:absent" }));
  const bug: Bug = {
    id: genId("bug"),
    title: input.title,
    status: "open",
    severity: input.severity ?? "medium",
    description: input.description,
    anchors: anchorIds,
    witnesses,
    createdCommit: headCommit(root),
    history: ["opened"],
  };
  const bugStore = await readBugs(root);
  bugStore.bugs.push(bug);
  await writeBugs(root, bugStore.bugs);
  return { ok: true, id: bug.id };
}

/** List bugs, flagging those whose anchored code changed since filing ("possibly fixed"). */
export async function listBugs(root: string, opts: { status?: BugStatus } = {}) {
  const [bugStore, store] = await Promise.all([readBugs(root), readAnchorStore(root)]);
  let bugs = bugStore.bugs;
  if (opts.status) bugs = bugs.filter((b) => b.status === opts.status);
  const files = new Set<string>();
  for (const b of bugs) for (const id of b.anchors) {
    const a = store.anchors.find((x) => x.id === id);
    if (a) files.add(a.file);
  }
  const live = await liveAnchors(root, files);
  const idx = liveIndex(root, live);
  return {
    counts: bugStore.bugs.reduce((m, b) => ((m[b.status] = (m[b.status] ?? 0) + 1), m), {} as Record<string, number>),
    bugs: bugs.map((b) => {
      const changed = realDrift(witnessDrift(b.witnesses, idx)).map((c) => c.anchorId);
      return {
        id: b.id, title: b.title, status: b.status, severity: b.severity,
        anchors: b.anchors,
        possiblyFixed: b.status === "open" && changed.length > 0,
        // Code moved under the bug regardless of status (a closed bug whose code
        // changed may warrant a fresh look); `possiblyFixed` narrows this to open.
        codeChanged: changed.length > 0,
        changedAnchors: changed,
      };
    }),
  };
}

/**
 * Full detail for one bug: prose, history, and each cited anchor resolved to its
 * live symbol/file/lines with a `stale` flag (the anchor's code changed since the
 * bug's witness was taken — same witness-hash mechanism as doc/review staleness).
 */
export async function bugDetail(root: string, id: string) {
  const [bugStore, store] = await Promise.all([readBugs(root), readAnchorStore(root)]);
  const bug = bugStore.bugs.find((b) => b.id === id);
  if (!bug) return { error: `no bug "${id}"` };
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const files = new Set<string>();
  for (const aid of bug.anchors) { const a = byId.get(aid); if (a) files.add(a.file); }
  const live = await liveAnchors(root, files);
  const idx = liveIndex(root, live);
  const witness = new Map(bug.witnesses.map((w) => [w.anchorId, w.bodyHash]));
  const anchors = bug.anchors.map((aid) => {
    const a = byId.get(aid);
    const liveA = live.get(aid);
    const witHash = witness.get(aid);
    const loc = liveA?.loc ?? a?.loc;
    const w = witHash === undefined ? [] : [{ anchorId: aid, bodyHash: witHash }];
    return {
      id: aid,
      symbol: a ? a.symbolPath.join(" › ") : aid.slice(0, 12),
      file: a?.file ?? null,
      lines: loc ? `${loc.startLine}-${loc.endLine}` : null,
      present: !!liveA,
      // Stale when we have a witness and the live code no longer matches it — but
      // an id this build could not have minted is not a body that moved, and saying
      // so needs the resolution rather than `?? ABSENT_HASH`.
      stale: witHash !== undefined && realDrift(witnessDrift(w, idx)).length > 0,
      // And `present: false` alone would move the confident claim rather than remove
      // it: absent + not-stale renders as "renamed or removed, and the bug is
      // unaffected". This says which of the two absences it is.
      unverifiable: witHash !== undefined && !liveA
        && witnessDrift(w, idx).some((c) => c.unverifiable),
    };
  });
  const changed = anchors.filter((a) => a.stale).length;
  return {
    id: bug.id, title: bug.title, status: bug.status, severity: bug.severity,
    description: bug.description, createdCommit: bug.createdCommit, history: bug.history,
    anchors, staleAnchors: changed, possiblyFixed: bug.status === "open" && changed > 0,
  };
}

export async function updateBug(
  root: string,
  input: { id: string; status?: BugStatus; note?: string; addAnchors?: string[]; refreshWitnesses?: boolean },
) {
  const bugStore = await readBugs(root);
  const bug = bugStore.bugs.find((b) => b.id === input.id);
  if (!bug) return { error: `no bug "${input.id}"` };
  const rejects: string[] = [];
  if (input.addAnchors?.length) {
    const r = await resolveRefs(root, input.addAnchors);
    rejects.push(...r.errors); // partial: add what resolved, report the rest
    for (const a of r.ids) if (!bug.anchors.includes(a)) bug.anchors.push(a);
  }
  if (input.status && input.status !== bug.status) {
    bug.history.push(`status: ${bug.status} → ${input.status}`);
    bug.status = input.status;
  }
  if (input.note) bug.history.push(input.note);
  if (input.refreshWitnesses || input.status === "fixed") {
    const store = await readAnchorStore(root);
    const files = bug.anchors.map((id) => store.anchors.find((a) => a.id === id)?.file).filter(Boolean) as string[];
    const live = await liveAnchors(root, files);
    bug.witnesses = bug.anchors.map((id) => ({ anchorId: id, bodyHash: live.get(id)?.bodyHash ?? "sha256:absent" }));
    bug.history.push("witnesses refreshed");
  }
  await writeBugs(root, bugStore.bugs);
  return { ok: true, id: bug.id, status: bug.status, ...rejected(rejects) };
}
