import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type Anchor, type LogicalNode, type CoverageState, type Annotation } from "../schema.js";
import { indexFile, indexBlob } from "../repo.js";
import { headCommit, readBlobs } from "../git.js";
import { citedAnchors, isClosed } from "../shared-bugs.js";
import { readAnchorStore, loadNodes, readGraph, readBugs, readAnnotations, readFindings, readReviews, findAnchorsOutsideWork, snapshotBranch, readOrphans } from "../store.js";
import { teamNotesByAnchor, type PinnedNote } from "../notes-lookup.js";
import { resolveAnchorRefs } from "../refs.js";
import { reviewStatus, reviewStatesFor, anchorReviewMap, deriveCodeReview, type ReviewPair } from "../reviews.js";
import { triageStatus } from "../triage.js";
import { langFor, anchorBrief, type Trust, trustOf, coverageFor, loadNodesShared} from "./shared.js";

// ---------------------------------------------------------------------------
// Reading the graph & code
// ---------------------------------------------------------------------------

/**
 * Drill-down navigation over the structural tree that already lives in the
 * anchor paths — the primitive for understanding a large codebase top-down.
 * A directory prefix returns its immediate children (dirs/files) with anchor
 * counts, documentation coverage, and node/bug rollups; a file prefix returns
 * its symbols. You never list everything — you expand one level at a time.
 */
export async function outline(root: string, prefix = "", opts: { compact?: boolean } = {}) {
  const [{ store, nodes, result }, bugStore, reviewStore] = await Promise.all([coverageFor(root), readBugs(root), readReviews(root)]);
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const state = (id: string) => result.state.get(id) ?? "open";
  const reviews = await anchorReviewMap(root, store.anchors, nodes, reviewStore.reviews);
  const rv = (id: string) => reviews.get(id) ?? { code: "unreviewed" as const, logical: "unreviewed" as const, codeActor: null, logicalActor: null, codeVia: undefined, logicalVia: undefined };
  const inScope = (id: string) => { const s = state(id); return s === "open" || s === "cited" || s === "covered"; };

  // A file prefix → list that file's symbols.
  const fileAnchors = store.anchors.filter((a) => a.file === prefix);
  if (fileAnchors.length) {
    const byLine = [...fileAnchors].sort((a, b) => (a.loc?.startLine ?? 0) - (b.loc?.startLine ?? 0));
    // `compact` is the cheap symbol listing: id, symbol, kind, lines and nothing
    // else. A big C# file's full listing (coverage + per-anchor review + citing
    // node ids) runs to tens of KB, which pushed callers to grep the file instead.
    if (opts.compact) {
      return {
        prefix,
        kind: "file" as const,
        compact: true,
        symbols: byLine.map((a) => ({ id: a.id, symbol: a.symbolPath.join(" › "), kind: a.kind, lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined })),
      };
    }
    return {
      prefix,
      kind: "file" as const,
      symbols: byLine
        .map((a) => ({
          ...anchorBrief(a),
          coverage: state(a.id),
          review: rv(a.id),
          nodes: nodes.filter((n) => n.anchors.includes(a.id)).map((n) => n.id),
        })),
    };
  }

  // Otherwise a directory prefix → group by the next path segment, rolling up
  // the coverage state breakdown so docPct/open counts are honest.
  const p = prefix ? (prefix.endsWith("/") ? prefix : prefix + "/") : "";
  type Grp = { anchors: number; b: Record<CoverageState, number>; isFile: boolean; rDenom: number; rc: number; rcStale: number; rcReverted: number; rl: number; rlStale: number };
  const groups = new Map<string, Grp>();
  for (const a of store.anchors) {
    if (!a.file.startsWith(p)) continue;
    const rest = a.file.slice(p.length);
    const slash = rest.indexOf("/");
    const seg = slash === -1 ? rest : rest.slice(0, slash);
    let g = groups.get(seg);
    if (!g) groups.set(seg, (g = { anchors: 0, b: { open: 0, cited: 0, covered: 0, trivial: 0, deferred: 0, owned: 0 }, isFile: slash === -1, rDenom: 0, rc: 0, rcStale: 0, rcReverted: 0, rl: 0, rlStale: 0 }));
    g.anchors++;
    g.b[state(a.id)]++;
    if (inScope(a.id)) { // review % over documentable anchors only
      g.rDenom++;
      const r = rv(a.id);
      if (r.code === "reviewed") { g.rc++; if (r.codeVia === "reverted") g.rcReverted++; } else if (r.code === "stale") g.rcStale++;
      if (r.logical === "reviewed") g.rl++; else if (r.logical === "stale") g.rlStale++;
    }
  }
  const underPath = (nodeAnchorIds: string[], childPath: string) =>
    nodeAnchorIds.some((id) => {
      const a = byId.get(id);
      return a && (a.file === childPath || a.file.startsWith(childPath + "/"));
    });
  const children = [...groups.entries()]
    .map(([name, g]) => {
      const path = p + name;
      const denom = g.b.open + g.b.cited + g.b.covered;
      return {
        name,
        path,
        kind: g.isFile ? ("file" as const) : ("dir" as const),
        anchors: g.anchors,
        open: g.b.open, // in-scope, undocumented — the real work here
        docPct: denom ? Math.round((100 * (g.b.cited + g.b.covered)) / denom) : 0,
        // The stronger claim: cited BY a doc, not just swept in by a `cover`
        // selector. docPct counts both, so it can read 100% on a map where almost
        // nothing is actually described — report them apart.
        citedPct: denom ? Math.round((100 * g.b.cited) / denom) : 0,
        cited: g.b.cited,
        covered: g.b.covered,
        review: { total: g.rDenom, logical: g.rl, logicalStale: g.rlStale, code: g.rc, codeStale: g.rcStale, codeReverted: g.rcReverted },
        nodes: nodes.filter((n) => underPath(n.anchors, path)).length,
        bugs: bugStore.bugs.filter((b) => underPath(citedAnchors(b), path)).length,
      };
    })
    .sort((x, y) => y.anchors - x.anchors);
  return { prefix: p, kind: "dir" as const, childrenCount: children.length, children };
}
export async function search(root: string, query: string, limit = 30) {
  const q = query.toLowerCase();
  const [store, nodes] = await Promise.all([readAnchorStore(root), loadNodesShared(root)]);
  const anchors = store.anchors
    .filter((a) => a.symbolPath.join(".").toLowerCase().includes(q) || a.file.toLowerCase().includes(q))
    .slice(0, limit)
    .map(anchorBrief);
  const matched = nodes
    .filter((n) =>
      n.id.toLowerCase().includes(q) ||
      n.title.toLowerCase().includes(q) ||
      n.summary.toLowerCase().includes(q) ||
      n.body.toLowerCase().includes(q),
    )
    .slice(0, limit);
  // Surface the trust ladder inline so a searching agent can tell a trusted answer
  // from a stale guess without a second round-trip.
  const reviews = await reviewStatesFor(root, matched.map((n) => ({ kind: "node" as const, id: n.id })));
  const nodeHits = matched.map((n) => {
    const rp = reviews.get(`node:${n.id}`);
    const review = { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" };
    return { id: n.id, type: n.type, title: n.title, summary: n.summary, status: n.status ?? "fresh", review, trust: trustOf(n.status, rp) };
  });
  return { anchors, nodes: nodeHits };
}

/**
 * "What does codemap already know about this code, and can I trust it?" — the
 * answer-first entry point for a codemap-aware Explore agent. Given refs (files,
 * dirs, `file#Symbol`, `file:line`, or anchor ids), returns the covering docs with
 * their trust level, the flows/bugs on that code, and the still-undocumented
 * anchors (the gaps to fill). Lets the agent skip re-exploration when a trusted
 * doc already answers, and focus its reading on the gaps when it doesn't.
 */
export async function context(root: string, refs: string[]) {
  const { store, nodes, deciding: decidingNodes, result, verdict } = await coverageFor(root);
  const [graph, bugStore] = await Promise.all([readGraph(root), readBugs(root)]);
  const anchorsById = new Map(store.anchors.map((a) => [a.id, a]));

  // Resolve each ref → anchor ids. Precise refs (id / file#Symbol / file:line) go
  // through resolveAnchorRefs; a bare path is treated as a file or directory scope.
  const scope = new Set<string>();
  const errors: string[] = [];
  for (const ref of refs) {
    if (anchorsById.has(ref)) { scope.add(ref); continue; }
    if (ref.includes("#") || /:\d+$/.test(ref)) {
      const r = resolveAnchorRefs(store.anchors, [ref]);
      r.ids.forEach((id) => scope.add(id));
      errors.push(...r.errors);
      continue;
    }
    const pref = ref.replace(/\/+$/, "");
    const hits = store.anchors.filter((a) => a.file === pref || a.file.startsWith(pref + "/") || a.file.endsWith("/" + pref));
    if (hits.length) hits.forEach((a) => scope.add(a.id));
    else errors.push(`no anchors for "${ref}"`);
  }
  const scopeIds = [...scope];

  const fileOf = (id: string) => anchorsById.get(id)?.file;
  const scopeFiles = new Set(scopeIds.map((id) => fileOf(id)).filter(Boolean) as string[]);

  // A doc "covers" the scope if it cites any anchor in a SCOPE FILE — file-level, so a
  // module doc for the file surfaces even when it doesn't cite the exact member asked
  // about (the dry-run's RatingProfile.cs case). Exact-anchor overlap still ranks first.
  // Two sets, deliberately. `covering` is what the answer SHOWS; `deciding` is what
  // it is allowed to conclude from. They differ only when a scope is blocked.
  const covering = nodes.filter((n) => n.anchors.some((id) => scopeFiles.has(fileOf(id) ?? "")));
  const deciding = decidingNodes.filter((n) => n.anchors.some((id) => scopeFiles.has(fileOf(id) ?? "")));

  // Flows whose OWN anchors or any of their STEPS' anchors touch the scope — a raw
  // `type === 'process'` filter missed the flow that actually answers the question,
  // because a process node cites its steps by edge, not the code directly.
  const stepsOf = new Map<string, string[]>();
  for (const e of graph.edges) if (e.type === "step_of") { const a = stepsOf.get(e.to) ?? []; a.push(e.from); stepsOf.set(e.to, a); }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const flowNodes = nodes.filter((n) => n.type === "process" &&
    (n.anchors.some((id) => scope.has(id)) || (stepsOf.get(n.id) ?? []).some((sid) => (nodeById.get(sid)?.anchors ?? []).some((id) => scope.has(id)))));

  const rank: Record<Trust, number> = { verified: 0, checked: 1, unverified: 2, stale: 3, generated: 4 };
  const reviewed = await reviewStatesFor(root, [...covering, ...flowNodes].map((n) => ({ kind: "node" as const, id: n.id })));
  const view = (n: LogicalNode) => {
    const rp = reviewed.get(`node:${n.id}`);
    return { id: n.id, title: n.title, type: n.type, summary: n.summary, status: n.status ?? "fresh",
      review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" }, trust: trustOf(n.status, rp) };
  };
  const docs = covering.map((n) => ({ ...view(n), coversInScope: n.anchors.filter((id) => scope.has(id)).length }))
    .sort((a, b) => (rank[a.trust] - rank[b.trust]) || b.coversInScope - a.coversInScope);
  const decidingIds = new Set(deciding.map((n) => n.id));
  const decidingDocs = docs.filter((d) => decidingIds.has(d.id));
  const flows = flowNodes.map((n) => ({ ...view(n), steps: (stepsOf.get(n.id) ?? []).length }));

  // Files that DO have a readable doc (some node cites an anchor in them).
  // From the DECIDING set. `docFiles` decides — it is what lets a file-level rule say
  // an anchor is not a gap — so a blocked scope's doc must not put a file in it.
  const docFiles = new Set(deciding.flatMap((n) => n.anchors.map(fileOf)).filter(Boolean) as string[]);
  // Gaps = scope anchors with no readable doc that aren't intentionally excluded:
  // `open`, or `covered`-by-a-rule but no doc actually cites anything in the file.
  // (`cited`/`trivial`/`deferred`/`owned` are not gaps.)
  // A teammate's doc is an ordinary node now, so `covering` already holds it and
  // there is no second lookup to keep in step — which is what stopped `context`, the
  // call an agent makes FIRST, being blind to half the answer.
  //
  // What still needs deciding is which scopes may DECIDE. A blocked one shows its
  // rows and may not remove a gap, so it is filtered out of the deciding set only.
  const blocked = verdict?.excludeFromDecisions;
  const decides = (id: string) => deciding.some((n) => n.anchors.includes(id));
  const gaps = scopeIds.filter((id) => {
    const st = result.state.get(id);
    if (decides(id)) return false;   // somebody documented it; reading theirs is the work
    return st === "open" || (st === "covered" && !docFiles.has(fileOf(id) ?? ""));
  }).map((id) => anchorBrief(anchorsById.get(id)!));
  const withDoc = scopeIds.filter((id) => covering.some((n) => n.anchors.includes(id))).length;
  const teamDocs = covering.filter((n) => n.origin).map((n) => ({
    nodeId: n.id, title: n.title, ...(n.author ? { by: n.author } : {}), status: n.status,
    covers: n.anchors.filter((id) => scope.has(id)),
  }));

  const bugs = bugStore.bugs
    .filter((b) => !isClosed(b.state) && citedAnchors(b).some((id) => scope.has(id)))
    .map((b) => ({ id: b.id, title: b.title, severity: b.severity }));

  return {
    scopeAnchors: scopeIds.length,
    withDoc,           // scope anchors a doc directly cites
    gaps,              // scope anchors with no readable doc (the explore-then-document list)
    docs,
    ...(teamDocs.length ? { sharedDocs: teamDocs } : {}),
    ...(verdict && verdict.status !== "complete" ? { sharedDocsVerdict: verdict.status } : {}),
    // The team's half of this answer came from a scope that cannot be answered
    // from. Said out loud because coverage SUPPRESSES gaps — the harm is what is
    // missing from the list above, which nothing else here can hint at.
    ...(verdict && verdict.status !== "complete" && verdict.scope ? { sharedScope: verdict.scope } : {}),
    flows,
    bugs,
    // A one-line read for the agent: is this area answered by something, and how much to trust it?
    // The one-line verdict is a CONCLUSION, so it reads the deciding set. `docs` above
    // still lists everything: a blocked scope's doc is shown and does not get to say
    // this area is covered.
    verdict: !scopeIds.length ? "empty scope"
      : decidingDocs.some((d) => d.trust === "verified") ? "covered — human-verified docs exist; rely on them"
      : decidingDocs.some((d) => d.trust === "checked") ? "covered — agent-checked docs exist; solid, spot-check if critical"
      : decidingDocs.some((d) => d.trust === "unverified") ? "partial — docs exist but unchecked; use as hypotheses, verify against code (and sanity_check what holds)"
      : decidingDocs.some((d) => d.trust === "stale") ? "stale — docs here need re-validation against current code"
      // Below every trust-based verdict, and only when nothing else spoke: a
      // teammate's doc IS in this store now, so how much to trust it is the same
      // question as for any other doc and the branches above already answer it. This
      // is the case where the team's doc is the only coverage and carries no trust
      // signal yet. Not when the scope is blocked: the docs are still listed so a
      // reader can look, but "covered" is a decision a blocked scope may not make.
      : teamDocs.length && !blocked?.size ? `documented by the team — ${teamDocs.length} shared doc(s) cover this; read them with \`shared_docs\` before exploring`
      : gaps.length ? "gap — no docs cover this code; explore, then document the reusable claims"
      : "no docs and no open gaps (this code may be intentionally deferred/trivial)",
    ...(errors.length ? { errors } : {}),
  };
}

/**
 * A teammate's notes on one target, or nothing at all.
 *
 * Dynamic import and a swallowed failure, like `docsVerdict` above: the agnostic core
 * does not depend on the sidecar, and a shared store that is missing or unreadable must
 * not fail a local read that worked before shared notes existed.
 */
async function sharedNotesOn(
  root: string, targetId: string, localIds: Set<string>,
): Promise<{ sharedNotes?: PinnedNote[] }> {
  const notes = (await teamNotesByAnchor(root, localIds)).get(targetId) ?? [];
  return notes.length ? { sharedNotes: notes } : {};
}

export async function getAnchor(root: string, id: string) {
  // One fold, not two. `loadNodesShared` already calls `docsVerdict`, so asking for
  // the verdict separately folded the scope twice on the hottest drill-down path.
  // Sequenced before the rest deliberately: it is what materializes the rows the
  // load is about to read.
  const anchorVerdict = await import("../docs-lookup.js").then((m) => m.docsVerdict(root)).catch(() => null);
  const [store, nodes, bugStore, annStore] = await Promise.all([
    readAnchorStore(root), loadNodes(root), readBugs(root), readAnnotations(root),
  ]);
  let anchor = store.anchors.find((a) => a.id === id);
  // Three places to look, and WHICH one answered is part of the answer.
  //
  // The working tree first. Then any cached commit snapshot — during a pull-request
  // review that is where the files the branch ADDS live, and this is the read path a
  // reviewer reaches for first, so refusing them here while `annotate` accepts them
  // is the tool disagreeing with itself. Then retained anchors, whose code is gone
  // everywhere but whose last known state is still worth returning: the finding on
  // it is real, and the reader needs to learn the CODE went, not that the id is wrong.
  const off = anchor ? undefined : findAnchorsOutsideWork(root, [id]).get(id);
  if (!anchor && off) anchor = off.anchor;
  const orphaned = !anchor;
  if (!anchor) anchor = readOrphans(root, [id]).get(id);
  if (!anchor) return { error: `no anchor "${id}"` };

  // Resolve the code live so it is always exact — from the commit that holds it when
  // the working tree does not.
  let code: string | null = null;
  let present = false;
  try {
    if (off) {
      const src = readBlobs(root, off.ref, [anchor.file]).get(anchor.file);
      const live = src ? (await indexBlob(src, anchor.file)).find((a) => a.id === id) : undefined;
      if (src && live?.loc) { code = src.slice(live.loc.startByte, live.loc.endByte); present = true; }
    } else {
    const src = await readFile(join(root, anchor.file), "utf8"); // loc index the parsed string, not raw bytes
    const fresh = await indexFile(join(root, anchor.file), anchor.file);
    const live = fresh.find((a) => a.id === id);
    if (live?.loc) {
      code = src.slice(live.loc.startByte, live.loc.endByte);
      present = true;
    }
    }
  } catch {
    /* file gone */
  }
  const citing = nodes.filter((n) => n.anchors.includes(id));
  const citeReviews = await reviewStatesFor(root, citing.map((n) => ({ kind: "node" as const, id: n.id })));
  // Dynamic, like `mirrorNote`: the agnostic core does not depend on the sidecar,
  // and a shared store that is missing or unreadable must not fail a local read
  // that worked before shared docs existed.
  // `citing` already includes a teammate's doc — it is an ordinary node. Reported
  // separately so a reader can tell whose it is; `getAnchor` suppresses nothing, so
  // it needs no verdict to decide with, only one to report.
  const sharedCites = citing.filter((n) => n.origin).map((n) => ({
    nodeId: n.id, title: n.title, ...(n.author ? { by: n.author } : {}), status: n.status,
  }));
  return {
    ...anchorBrief(anchor),
    present,
    code,
    // WHICH version this is. The working tree is a third thing during a PR review —
    // neither the PR under review nor whatever branch the reader last had in mind —
    // and a response that just says "current" invites all three to be conflated.
    sourceRef: orphaned ? "@orphan" : off ? off.ref : "@work",
    sourceCommit: off ? off.ref : headCommit(root),
    ...(off ? {
      offTree: true,
      offTreeNote: `${anchor.file} is not in the working tree — this is the body at ${off.ref.slice(0, 12)}${snapshotBranch(root, off.ref) ? ` (${snapshotBranch(root, off.ref)})` : ""}, which is where the code actually lives. The tree is on another branch.`,
    } : {}),
    ...(orphaned ? {
      orphaned: true,
      orphanedNote: `this symbol is no longer in the working tree — ${anchor.file} › ${anchor.symbolPath.join(" › ")} was retained because findings or reviews point at it. \`code\` is null; the last known body hash is ${anchor.bodyHash}. It may exist on a branch: check a PR head before concluding it was deleted.`,
    } : {}),
    // citedBy carries the trust ladder so "what documents this code, and can I
    // trust it?" is answerable from the anchor alone.
    citedBy: citing.map((n) => {
      const rp = citeReviews.get(`node:${n.id}`);
      return { id: n.id, title: n.title, status: n.status ?? "fresh", trust: trustOf(n.status, rp) };
    }),
    // Separate from `citedBy` rather than merged: one is this machine's store and
    // the other is the sidecar's, and merging them makes "who says so"
    // unanswerable from the reply.
    ...(sharedCites.length ? { sharedDocs: sharedCites } : {}),
    // A read, not a decision: `getAnchor` shows the team's docs and suppresses
    // nothing, so a blocked scope is reported rather than emptied. See §7.
    ...(anchorVerdict && anchorVerdict.status !== "complete"
      ? { sharedScope: { status: anchorVerdict.status, diagnostic: anchorVerdict.diagnostic } } : {}),
    bugs: bugStore.bugs.filter((b) => citedAnchors(b).includes(id)).map((b) => ({ id: b.id, title: b.title, state: b.state })),
    annotations: annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === id),
    // The team's notes about this symbol, the way `sharedDocs` above carries the team's
    // docs. This read merged teammates' DOCS and returned local annotations only, so a
    // colleague's note on the very symbol being read was one navigation away on a
    // surface nothing pointed at. Separate from `annotations` for the reason
    // `sharedDocs` is separate from `citedBy`: merging them makes "who says so"
    // unanswerable from the reply.
    //
    // A mirrored note is one note under one id, so this drops what `annotations`
    // already carries. Findings are excluded outright — they are rows in `findings`
    // below, and the note store still holds pre-canonical copies of them.
    ...(await sharedNotesOn(root, id, new Set(annStore.annotations.map((a) => a.id)))),
    // Findings are rows, not annotations, so without this an anchor's page showed
    // notes and questions about it and none of the findings raised against it.
    findings: (await readFindings(root)).findings
      .filter((f) => f.target.kind === "anchor" && f.target.id === id)
      .map((f) => ({
        id: f.id, pr: f.pr, state: f.state, severity: f.severity, category: f.category,
        text: f.comment || f.text, author: f.author.principal, shared: !!f.origin,
      })),
    lang: langFor(anchor.file),
    review: await reviewStatus(root, { kind: "anchor", id }),
    // The `viewed` exposure marks, separate from the vouch above, so the UI can show
    // "looked at" distinctly from "signed off" (and each with its own staleness).
    viewed: await reviewStatus(root, { kind: "anchor", id }, { viewed: true }),
    // Stakes + resulting severity (stakes × attestation gap). See docs/triage.md.
    triage: await triageStatus(root, { kind: "anchor", id }),
  };
}

/**
 * A node's referenced code segments as a review queue — each cited anchor with its
 * live source, code review + viewed marks, ordered by file then position (reading
 * order). Powers the dedicated code-review page, where you read & sign each segment
 * in one place instead of hopping to a per-anchor page. `codeReview` is the derived
 * rollup; `files` lists the distinct files touched (for the file modal).
 */
export async function nodeReview(root: string, id: string) {
  const [nodes, store, annStore] = await Promise.all([loadNodesShared(root), readAnchorStore(root), readAnnotations(root)]);
  const node = nodes.find((n) => n.id === id);
  if (!node) return { error: `no node "${id}"` };
  const byId = new Map(store.anchors.map((a) => [a.id, a]));
  const annFor = (aid: string) => annStore.annotations.filter((a) => a.target.kind === "anchor" && a.target.id === aid);
  // The team's, beside your own and never merged in — see `notes-lookup.ts`.
  const teamNotes = await teamNotesByAnchor(root, new Set(annStore.annotations.map((a) => a.id)));
  const targets = node.anchors.map((aid) => ({ kind: "anchor" as const, id: aid }));
  const [rev, revView] = await Promise.all([reviewStatesFor(root, targets), reviewStatesFor(root, targets, { viewed: true })]);
  // Cache live-indexed files so several anchors in one file re-index once. loc
  // offsets index the parsed source string (UTF-16 units), so slice the string.
  const fileCache = new Map<string, { src: string; byId: Map<string, Anchor> }>();
  const load = async (file: string) => {
    let fc = fileCache.get(file);
    if (!fc) {
      try { const src = await readFile(join(root, file), "utf8"); fc = { src, byId: new Map((await indexFile(join(root, file), file)).map((x) => [x.id, x])) }; }
      catch { fc = { src: "", byId: new Map() }; }
      fileCache.set(file, fc);
    }
    return fc;
  };
  const segments = [];
  for (const aid of node.anchors) {
    const a = byId.get(aid);
    // `annotations` even here. Every consumer treats it as a list, and leaving the
    // field off made the union un-narrowable at the one call site that filters on it —
    // `tsc -p web` caught that, which is what it is for.
    if (!a) { segments.push({ id: aid, missing: true as const, annotations: [] as Annotation[] }); continue; }
    const fc = await load(a.file);
    const live = fc.byId.get(aid);
    segments.push({
      id: a.id, symbol: a.symbolPath.join(" › "), file: a.file, kind: a.kind, lang: langFor(a.file),
      startLine: a.loc?.startLine ?? 0, lines: a.loc ? `${a.loc.startLine}-${a.loc.endLine}` : undefined,
      present: Boolean(live?.loc), code: live?.loc ? fc.src.slice(live.loc.startByte, live.loc.endByte) : null,
      review: rev.get("anchor:" + aid), viewed: revView.get("anchor:" + aid),
      annotations: annFor(aid), // line-pinned findings + segment notes
      ...(teamNotes.get(aid)?.length ? { sharedNotes: teamNotes.get(aid)! } : {}),
    });
  }
  segments.sort((x, y) => ((x as { file?: string }).file ?? "").localeCompare((y as { file?: string }).file ?? "") || ((x as { startLine?: number }).startLine ?? 0) - ((y as { startLine?: number }).startLine ?? 0));
  const codeReview = deriveCodeReview(segments.filter((s) => !("missing" in s) && s.review).map((s) => (s as { review: ReviewPair }).review.code));
  const files = [...new Set(segments.filter((s) => !("missing" in s)).map((s) => (s as { file: string }).file))];
  const openFindings = annStore.annotations.filter((a) => a.target.kind === "anchor" && node.anchors.includes(a.target.id) && !a.resolved && (a.kind === "finding" || a.kind === "question")).length;
  return { id, title: node.title, type: node.type, summary: node.summary, files, segments, codeReview, openFindings };
}

/**
 * Whole-file source + the stored anchors within it (line ranges + code review /
 * viewed marks) — for the review page's file modal, so a segment can be read in
 * full-file context and signed there.
 */
export async function fileSource(root: string, file: string) {
  // `file` arrives from a query string. `join` happily resolves `../` out of the
  // repo, so without this the endpoint reads any file the server user can — it
  // served /etc/hostname. Resolve and require containment; the static handler
  // guards its own paths, this one did not.
  const abs = resolve(root, file);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return { error: `"${file}" is outside this universe` };

  const [store, annStore] = await Promise.all([readAnchorStore(root), readAnnotations(root)]);
  const teamNotes = await teamNotesByAnchor(root, new Set(annStore.annotations.map((a) => a.id)));
  const inFile = store.anchors.filter((a) => a.file === file);
  let code: string;
  try { code = await readFile(abs, "utf8"); } catch { return { error: `cannot read "${file}"` }; }
  const live = new Map((await indexFile(join(root, file), file)).map((x) => [x.id, x]));
  const targets = inFile.map((a) => ({ kind: "anchor" as const, id: a.id }));
  const [rev, revView] = await Promise.all([reviewStatesFor(root, targets), reviewStatesFor(root, targets, { viewed: true })]);
  const anchors = inFile.map((a) => {
    const lv = live.get(a.id);
    return {
      id: a.id, symbol: a.symbolPath.join(" › "), kind: a.kind,
      startLine: lv?.loc?.startLine ?? a.loc?.startLine ?? null,
      endLine: lv?.loc?.endLine ?? a.loc?.endLine ?? null,
      present: Boolean(lv?.loc),
      review: rev.get("anchor:" + a.id), viewed: revView.get("anchor:" + a.id),
      annotations: annStore.annotations.filter((an) => an.target.kind === "anchor" && an.target.id === a.id),
      ...(teamNotes.get(a.id)?.length ? { sharedNotes: teamNotes.get(a.id)! } : {}),
    };
  }).sort((x, y) => (x.startLine ?? 0) - (y.startLine ?? 0));
  return { file, lang: langFor(file), code, anchors };
}

