import { type LogicalNodeType, type EdgeType, type Edge } from "../schema.js";
import { liveHashes } from "../reviews.js";
import { createHash } from "node:crypto";
import { readAnchorStore, loadNodes, readGraph, readLocalGraph, writeGraph, writeNode, slug, readAnnotations, deleteNode as storeDeleteNode, confirmNode, ackHole as storeAckHole, loadNodeVersions, derivationLookup } from "../store.js";
import { evalVersion } from "../doc-version.js";
import { anchorIndex, derivationsOf } from "../anchor-resolve.js";
import { snapshotHashes, resolveRefs, rejected, loadNodesShared} from "./shared.js";
import { type WhereWas, whereWere } from "./orphans.js";
import { annotate, reviseAnnotation, assignAnnotation } from "./annotations.js";

// ---------------------------------------------------------------------------
// Documenting
// ---------------------------------------------------------------------------

// --- shared helpers for authoring ---
const LINK_RE = /\[\[([^\]]+)\]\]/g;
function extractLinks(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(text)) !== null) out.push(m[1]!.trim());
  return out;
}
function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
function addEdge(graph: { edges: Edge[] }, e: Edge): boolean {
  if (graph.edges.some((x) => x.from === e.from && x.to === e.to && x.type === e.type)) return false;
  graph.edges.push(e);
  return true;
}

interface StepInput { id?: string; title: string; summary: string; anchors: string[]; touches?: string[]; body?: string }

export async function document(
  root: string,
  input: { id?: string; type: LogicalNodeType; title: string; summary: string; anchors: string[]; body?: string; steps?: StepInput[]; ref?: string },
) {
  // `ref` documents code as a branch leaves it: anchors resolve against that
  // commit's snapshot as well as @work, and the version's accepted hashes are
  // captured there — otherwise a doc written while reviewing a PR would cite
  // symbols the working tree has never seen and match nothing.
  const r = await resolveRefs(root, input.anchors, input.ref);
  const wopts = input.ref ? { hashes: await snapshotHashes(root, input.ref), commit: input.ref, branch: null } : {};
  // Partial acceptance — but a node with no anchors is a floating claim, so a call
  // where nothing resolved is still rejected outright.
  if (!r.ids.length) return { error: r.errors.join("; ") || "no anchors given" };
  const id = input.id ?? slug(input.title);
  const body = input.body ?? "";
  await writeNode(root, { id, type: input.type, title: input.title, summary: input.summary, anchors: r.ids, body }, wopts);

  const result: Record<string, unknown> = { ok: true, id, anchors: r.ids.length, ...rejected(r.errors) };

  // P1.2 — inline ordered steps materialize step nodes + step_of + touches edges.
  if (input.type === "process" && input.steps?.length) {
    const graph = await readGraph(root);
    const allNodes = await loadNodesShared(root);
    const taken = new Set(allNodes.map((n) => n.id)); // includes the process just written
    // Re-documenting a process must UPDATE its steps, not mint a second set. Ids came
    // from `uniqueSlug` against every existing node, so a second promotion of the same
    // chapter produced `command-2`, `handler-2`, … and a second run of `step_of`
    // edges — the flow-walker then rendered the same flow twice. The promotion guard
    // explicitly permits re-promoting a section, and the UI advertises it, so this is
    // a path the product invites.
    const existingSteps = new Map(
      graph.edges.filter((e) => e.type === "step_of" && e.to === id)
        .map((e) => [allNodes.find((n) => n.id === e.from)?.title, e.from] as const)
        .filter((x): x is readonly [string, string] => typeof x[0] === "string"),
    );
    const created: string[] = [];
    const warnings: string[] = [];
    let i = 0;
    for (const step of input.steps) {
      const sr = await resolveRefs(root, step.anchors, input.ref);
      // A step with nothing resolved is SKIPPED, not fatal: the process node and
      // its other steps are already written, so aborting here would leave the map
      // half-built and the caller re-sending everything.
      if (!sr.ids.length) { warnings.push(`step "${step.title}" skipped — no anchor resolved: ${sr.errors.join("; ")}`); i++; continue; }
      for (const e of sr.errors) warnings.push(`step "${step.title}": ${e}`);
      const stepId = step.id ?? existingSteps.get(step.title) ?? uniqueSlug(slug(step.title), taken);
      taken.add(stepId);
      await writeNode(root, { id: stepId, type: "step", title: step.title, summary: step.summary, anchors: sr.ids, body: step.body ?? "" }, wopts);
      created.push(stepId);
      addEdge(graph, { from: stepId, to: id, type: "step_of", order: i });
      for (const t of step.touches ?? []) {
        if (taken.has(t)) addEdge(graph, { from: stepId, to: t, type: "touches" });
        else warnings.push(`step "${step.title}" touches unknown node "${t}"`);
      }
      i++;
    }
    await writeGraph(root, graph);
    result.steps = created;
    if (warnings.length) result.warnings = warnings;
  }

  // P1.4 — flag [[links]] that don't resolve to a node (target may come later).
  const known = new Set((await loadNodesShared(root)).map((n) => n.id));
  const dangling = [...new Set(extractLinks(input.summary + "\n" + body))].filter((l) => !known.has(l));
  if (dangling.length) result.danglingLinks = dangling;
  return result;
}

/** P1.3 — add one edge or many in a single call (same-universe; use `link` for cross). */
export async function connect(
  root: string,
  input: { from?: string; to?: string; type?: EdgeType; order?: number; edges?: { from: string; to: string; type: EdgeType; order?: number }[] },
) {
  const list = input.edges ?? (input.from && input.to && input.type ? [{ from: input.from, to: input.to, type: input.type, order: input.order }] : []);
  if (!list.length) return { error: "provide an edge (from/to/type) or edges[]" };
  // Node existence against the MERGED view — a teammate's node is a legitimate target.
  const nodeIds = new Set((await loadNodesShared(root)).map((n) => n.id));
  // But the graph being MUTATED is this clone's own. Read-modify-write over the merged
  // view would copy every teammate edge into the local partition, where the next fold
  // would produce it again alongside — the seam bug triage was built to prevent.
  const graph = await readLocalGraph(root);
  let added = 0;
  const errors: string[] = [];
  for (const e of list) {
    const missing = [e.from, e.to].filter((x) => !nodeIds.has(x));
    if (missing.length) {
      errors.push(`unknown node(s): ${missing.join(", ")}`);
      continue;
    }
    if (addEdge(graph, { from: e.from, to: e.to, type: e.type, order: e.order })) added++;
  }
  await writeGraph(root, graph);
  // Publish the wiring of every node this touched. AFTER the local write and never in
  // place of it: codemap worked without a sidecar for its whole life, and an edge must
  // not be lost because a shared repo is misconfigured.
  // Nothing added means nothing to say. Publishing an unchanged set would mint an event
  // whose only effect is to move the wall-clock winner — which is how a no-op write
  // starts winning races against real ones.
  const touched = added ? [...new Set(list.map((e) => e.from))] : [];
  const shared = await import("../graph-publish.js")
    .then((m) => m.mirrorWiring(root, touched))
    .catch(() => ({ shared: false, configured: false, error: undefined as string | undefined }));
  return {
    ok: true, added, edges: graph.edges.length,
    ...(errors.length ? { errors } : {}),
    ...(shared.shared ? { shared: true } : {}),
    // Said, not swallowed: the edge is local either way, and a teammate not seeing it is
    // a different outcome from it not existing.
    ...(shared.configured && !shared.shared ? { shareError: shared.error ?? "the wiring could not be published" } : {}),
  };
}

/**
 * Write a version of a doc the TEAM owns, as a shared write.
 *
 * This is what "write-through" means: the event is appended and that scope is
 * materialized, so the row appears immediately and the caller never observes the log.
 * SQLite goes on feeling like the store while the log stays the authority.
 *
 * The alternative — forking a private local version of a doc a colleague wrote — is
 * what the code did before, and it is the wrong shape for the situation. A doc with a
 * version history and named authors is ONE doc that several people have worked on;
 * editing it is contributing a version, not starting a rival copy nobody else will
 * ever see. Forking is still right when the winning version is your OWN, which is
 * what `writeNode` continues to do.
 *
 * Returns `null` when this is not a shared doc or there is no sidecar, so the caller
 * falls through to the ordinary local path.
 */
async function writeThroughShared(
  root: string,
  node: { id: string; type: string; title: string; summary: string; body: string; anchors: string[] },
  winner: { origin?: string; citations?: { anchorId: string; acceptedHashes: string[] }[] },
): Promise<{ ok: true; id: string; shared: true } | { error: string } | null> {
  if (!winner.origin) return null;
  const shared = await import("../ops-shared.js").catch(() => null);
  if (!shared) return null;
  // The witness state has to travel with the edit. Publishing `acceptedHashes: []`
  // resets it: the new version wins, carries no evidence, and an edit made against
  // code that has not moved immediately reads `unverifiable` — a doc reporting itself
  // unverifiable the moment somebody improved its prose. `writeNode`'s local path
  // preserves the prior hashes and adds the current one, and a shared write has no
  // reason to be different.
  const prior = new Map((winner.citations ?? []).map((c) => [c.anchorId, c.acceptedHashes]));
  const live = await liveHashes(root, node.anchors);
  const citations = node.anchors.map((anchorId) => {
    const set = new Set(prior.get(anchorId) ?? []);
    const now = live.get(anchorId);
    if (now) set.add(now);
    return { anchorId, acceptedHashes: [...set] };
  });
  const r = await shared.shareDoc(root, {
    nodeId: node.id, type: node.type, title: node.title, summary: node.summary, body: node.body,
    citations, createdCommit: null, createdBranch: null,
  } as never) as { error?: string };
  if (r.error) return { error: r.error };
  return { ok: true, id: node.id, shared: true };
}

/** P1.3 — patch a node without resending the whole body. */
export async function updateNode(
  root: string,
  input: { id: string; setTitle?: string; setSummary?: string; setBody?: string; addAnchors?: string[]; removeAnchors?: string[] },
) {
  const nodes = await loadNodesShared(root);
  const node = nodes.find((n) => n.id === input.id);
  if (!node) return { error: `no node "${input.id}"` };
  if (input.setTitle !== undefined) node.title = input.setTitle;
  if (input.setSummary !== undefined) node.summary = input.setSummary;
  if (input.setBody !== undefined) node.body = input.setBody;
  const rejects: string[] = [];
  if (input.addAnchors?.length) {
    const r = await resolveRefs(root, input.addAnchors);
    rejects.push(...r.errors); // partial: add what resolved, report the rest
    for (const a of r.ids) if (!node.anchors.includes(a)) node.anchors.push(a);
  }
  if (input.removeAnchors?.length) {
    // Raw ids (a_…) are removed literally so a vanished/orphaned anchor ref can be
    // dropped even when it no longer resolves; other refs are resolved normally.
    const rm = new Set(input.removeAnchors.filter((r) => /^a_[0-9a-f]+$/.test(r)));
    const refs = input.removeAnchors.filter((r) => !/^a_[0-9a-f]+$/.test(r));
    if (refs.length) {
      const r = await resolveRefs(root, refs);
      rejects.push(...r.errors);
      r.ids.forEach((id) => rm.add(id));
    }
    node.anchors = node.anchors.filter((a) => !rm.has(a));
  }
  if (!node.anchors.length) return { error: "a node must keep ≥1 anchor (no floating claims)" };
  // Write-through: editing a doc the team owns appends a shared version rather than
  // forking a private copy nobody else will see. `node.origin` is the winning
  // version's scope, which `loadNodes` carries.
  const winner = (await loadNodeVersions(root, node.id)).find((v) => v.origin) ?? node;
  const through = await writeThroughShared(root, node as never, winner as never);
  if (through && "error" in through) return through;
  if (!through) await writeNode(root, node);
  const known = new Set(nodes.map((n) => n.id));
  const dangling = [...new Set(extractLinks(node.summary + "\n" + node.body))].filter((l) => !known.has(l));
  return {
    ok: true, id: node.id, anchors: node.anchors.length,
    ...(through ? { shared: true as const } : {}),
    ...rejected(rejects), ...(dangling.length ? { danglingLinks: dangling } : {}),
  };
}

/**
 * Confirm the winning doc version is still accurate at the current code (no edit,
 * no fork) — clears `stale` by accepting the current hashes. The right move when a
 * change touched the code a doc cites but the doc's claims still hold.
 */
export async function confirm(root: string, id: string) {
  // Fold first. `confirmNode` reads versions straight from the store, so on a store
  // whose docs scope has not been materialized a teammate's doc has NO versions and
  // this answers "no node" — not "that is theirs", so the shared route below is never
  // reached. Same class as the diff endpoints: an ops entry point reading nodes
  // without materializing.
  await import("../docs-lookup.js").then((m) => m.docsVerdict(root)).catch(() => null);
  const r = await confirmNode(root, id);
  // Write-through, the other half. `confirmNode` refuses a fold-owned winner because
  // accepting hashes into it locally would be reverted by the next fold — so route it
  // to the event that survives one. The refusal stays for the case with no sidecar to
  // route to, which is why this is a fallback rather than a branch above.
  if ("error" in r && /teammate's/.test(r.error ?? "")) {
    const shared = await import("../ops-shared.js").catch(() => null);
    if (shared) return shared.confirmSharedDoc(root, id);
  }
  return r;
}

/** Marks a queued question as one of these, so a second `ackHole` finds it. */
export const UNPLACEABLE_CATEGORY = "unplaceable-doc";

/**
 * Ack a hole: the doc's cited code was removed here and that's correct → tombstone
 * it on this branch (disappears from this branch's map; still live on branches
 * where the code exists). Only valid when the doc is `dangling`.
 *
 * A doc whose citations this build cannot place at all is a different answer and
 * gets a different one: the removal is refused — an incomparable absence is not
 * evidence of absence, and hiding is the direction with no recovery — and the
 * attempt is FILED as work instead of returned as an error. See
 * docs/anchor-id-provenance.md § "Clearing a doc nobody can place".
 *
 * Entered by the ACT, never by the state. A `HASH_SCHEME` bump made 985 of 985 docs
 * unverifiable at once, so queueing every such doc would deliver that store's whole
 * catalogue as a work list; queueing one person's attempt to clear one doc is
 * bounded by attempts.
 */
type Unplaceable = { anchorId: string; file?: string; symbol?: string; marks: string[]; was?: WhereWas };
type Refusal = { versionId?: string; createdCommit?: string | null; unplaceable?: Unplaceable[] };

/**
 * The question's identity, derived from the EVIDENCE and nothing else.
 *
 * A re-attempt has to know whether the open item still describes the doc, and
 * comparing rendered text answers a different question: the text carries
 * instructions and wording too, so a copy edit here would read as new evidence,
 * revise the item and re-assign it — and re-assigning CLEARS the outcome, throwing
 * away an answer nobody has read. Prose can change freely; this cannot.
 */
function evidenceKey(r: Refusal): string {
  const canonical = JSON.stringify({
    v: r.versionId ?? null,
    c: r.createdCommit ?? null,
    u: [...(r.unplaceable ?? [])]
      .map((x) => ({ a: x.anchorId, f: x.file ?? null, s: x.symbol ?? null, m: [...x.marks].sort(), w: x.was ?? null }))
      .sort((a, b) => a.a.localeCompare(b.a)),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** Reads the key back off a filed question. Absent on anything not filed by this. */
const keyOf = (text: string): string | null => /^\[evidence ([0-9a-f]{12})\]$/m.exec(text)?.[1] ?? null;

/** What the queued question says. The key line is the contract; the rest is prose. */
function unplaceableQuestion(r: Refusal): string {
  const where = (c: Unplaceable) => {
    const w = c.was;
    // The identified address first when there is one: it is the only line here that
    // was CHECKED rather than remembered — an anchor this build minted itself, from
    // source at that commit, whose own id is the one in question.
    if (w?.at === "found") return `  ${c.anchorId} — WAS ${w.file} › ${w.symbol}${w.startLine ? `:${w.startLine}` : ""} at ${w.ref.slice(0, 12)}`;
    if (w?.at === "ambiguous") return `  ${c.anchorId} — AMBIGUOUS at ${w.ref.slice(0, 12)}: this build mints that id for ${w.candidates.map((x) => `${x.file} › ${x.symbol}`).join(" and ")}`;
    const tail = `${c.marks.length ? `, minted under ${c.marks.join(", ")}` : ""}`;
    if (w?.at === "absent") return `  ${c.anchorId} — not produced by this build at ${w.ref.slice(0, 12)} (${w.indexed} anchors read there)${tail}`;
    return `  ${c.anchorId}${c.file ? ` — last seen at ${c.file} › ${c.symbol}` : " — no record of it anywhere"}${tail}`;
  };
  const cites = r.unplaceable ?? [];
  const identified = cites.filter((c) => c.was?.at === "found");
  const located = cites.filter((c) => c.was?.at !== "found" && c.file);
  const blind = cites.filter((c) => c.was?.at !== "found" && !c.file);
  return [
    `This doc cannot be retired: its citations were minted by a build whose anchor derivation this one cannot reproduce, so "the code is gone" is not something anybody here can establish.`,
    ``,
    `Version ${r.versionId}, written at ${r.createdCommit ?? "an unrecorded commit"}.`,
    ``,
    `Cannot be placed:`,
    ...cites.map(where),
    ``,
    // Two different jobs, and a set can need both. An id is an opaque digest of file
    // plus symbol path, so a last-known location is something to follow and no
    // location leaves the commit as the only handle.
    ...(identified.length ? [
      `The ones marked WAS are settled: that commit, indexed by this build, produces that id for that symbol and no other. What is NOT settled is what the symbol is now — a rename or a signature change gives it a different id by construction, and no digest can confirm the pairing. Ask git what happened to the file and symbol since, and if you can establish the continuation beyond doubt, re-cite the doc with \`update_node\` — add the current anchor, drop the old id.`,
    ] : []),
    ...(located.length ? [
      `For the ones with only a last-known location: same job, weaker starting point — that location is remembered rather than checked.`,
    ] : []),
    ...(blind.length ? [
      `For the ones with neither, this build cannot produce those ids from that commit at all, so it cannot say what they named — another build's derivation spelled them. Somebody whose build reproduces them can answer; you cannot check their answer, so if that is where this stops, say so. That blocker IS the answer.`,
    ] : []),
    ``,
    `If the subject is genuinely gone, report that and stop: retiring is a person's act, and the tombstone that would record it is not built yet — your answer is what it will be built on.`,
    ``,
    `[evidence ${evidenceKey(r)}]`,
  ].join("\n");
}

export async function ackHole(root: string, id: string) {
  const r = await storeAckHole(root, id);
  // On the evidence, not the headline status — the store refuses a tombstone
  // whenever anything is unplaceable, and a version with one gone citation and one
  // foreign one reads `dangling`.
  if (!r.unplaceable?.length) return r;

  // Step 1 of recovery, run HERE rather than left as an instruction: index the
  // commit the version names once and look every unplaceable id up in it. That turns
  // a queue item saying "go and find out where this was" into one that says where it
  // was — the only part of the answer anybody can check.
  const was = await whereWere(root, r.unplaceable.map((c) => c.anchorId), r.createdCommit ?? undefined)
    .catch(() => new Map<string, WhereWas>());
  const evidence = { ...r, unplaceable: r.unplaceable.map((c) => ({ ...c, ...(was.get(c.anchorId) ? { was: was.get(c.anchorId) } : {}) })) };
  const text = unplaceableQuestion(evidence);
  const key = evidenceKey(evidence);

  // One evolving investigation per doc, not one question per version. But the ids,
  // the commit and the locations ARE the question, so an item describing a version
  // that no longer wins would send an agent to repair citations the doc does not
  // have any more — it is revised, not left alone.
  const open = (await readAnnotations(root)).annotations.find((a) =>
    a.target.kind === "node" && a.target.id === id && a.category === UNPLACEABLE_CATEGORY && !a.resolved);
  if (open) {
    const moved = keyOf(open.text) !== key;
    // Answered and still accurate: waiting on a person, not on an agent. Saying
    // `alreadyQueued` about it would point at something `review_queue` hides by
    // default, and re-assigning would throw away an answer nobody has read.
    if (open.outcome && !moved) return { ...r, queued: open.id, alreadyAnswered: true };
    if (moved) {
      const rev = await reviseAnnotation(root, { id: open.id, text, by: "ack_hole" }) as { error?: string };
      if (rev.error) return { ...r, queued: open.id, queueError: rev.error };
    }
    // Filing and assigning are two writes, so an item can exist unassigned — and the
    // dedupe would keep answering `alreadyQueued` about something no queue shows.
    // A revision re-asks, so it re-assigns too (which clears the stale outcome).
    if (moved || !open.assignment) {
      const again = await assignAnnotation(root, { id: open.id, kind: "investigate", by: "ack_hole" }) as { error?: string };
      if (again.error) return { ...r, queued: open.id, queueError: again.error };
    }
    return { ...r, queued: open.id, alreadyQueued: true, ...(moved ? { revised: true } : {}) };
  }

  // `annotate` mirrors to the sidecar, and that is wanted here rather than tolerated:
  // "this build cannot place these ids" is a fact about ONE build, and a teammate
  // whose build minted them can answer it outright. A question only the asker can
  // see is the one shape this is least useful in.
  const filed = await annotate(root, {
    targetKind: "node", targetId: id, kind: "question", category: UNPLACEABLE_CATEGORY,
    author: "ack_hole", text,
  }) as { id?: string; error?: string };
  // Said, not swallowed: the caller asked for this doc to be dealt with, and a
  // refusal that also failed to file the work is a different answer from one that
  // filed it.
  if (!filed.id) return { ...r, queueError: filed.error ?? "could not file the question" };
  const handed = await assignAnnotation(root, { id: filed.id, kind: "investigate", by: "ack_hole" }) as { error?: string };
  if (handed.error) return { ...r, queued: filed.id, queueError: handed.error };
  return { ...r, queued: filed.id };
}

/** All versions of a node, each with its per-branch status (for the version UI). */
export async function nodeVersions(root: string, id: string) {
  const versions = await loadNodeVersions(root, id);
  const store = await readAnchorStore(root);
  // `evalVersion`, not a second copy of it. This function used to reimplement the
  // rule with raw `work.has` / `sameBody` — which is why it was the one surface the
  // provenance work did NOT reach when the type of the index changed: a duplicate
  // implementation is invisible to a typed seam. Two copies of a status rule is how
  // the version UI and the version selection start disagreeing about one doc.
  const work = anchorIndex(
    new Map(store.anchors.map((a) => [a.id, a.bodyHash])),
    derivationsOf(store.anchors),
    derivationLookup(root),
  );
  return {
    id,
    versions: versions.map((v) => {
      const e = evalVersion(v, work);
      return {
        versionId: v.versionId, title: v.title, summary: v.summary, removed: !!v.removed,
        createdCommit: v.createdCommit, createdBranch: v.createdBranch, createdAt: v.createdAt,
        anchors: v.citations.map((c) => c.anchorId),
        status: v.generatedBy ? "generated" : e.status,
        staleAnchors: e.stale, danglingAnchors: e.dangling,
        unverifiableAnchors: e.unverifiable ?? [],
      };
    }),
  };
}

/** Delete a logical node outright (and any edges touching it) — for obsolete/tombstoned docs. */
export async function removeNode(root: string, id: string) {
  const nodes = await loadNodesShared(root);
  if (!nodes.some((n) => n.id === id)) return { error: `no node "${id}"` };
  await storeDeleteNode(root, id);
  // `deleteNode` removes only LOCAL rows, so a node whose versions are a teammate's
  // survives it. Reporting `deleted` anyway — and dropping every edge touching it —
  // would be a deletion that did not happen, with real collateral. Check that the
  // node actually went before touching the graph.
  if ((await loadNodesShared(root)).some((n) => n.id === id)) {
    return { error: `node "${id}" is a teammate's doc here, so deleting your copy does not `
      + `remove it. If its subject is genuinely gone, a person retires it with `
      + `\`retire_shared_doc\`; otherwise write a version saying what you know.` };
  }
  const graph = await readGraph(root);
  const kept = graph.edges.filter((e) => e.from !== id && e.to !== id);
  if (kept.length !== graph.edges.length) await writeGraph(root, { edges: kept });
  return { ok: true, deleted: id, removedEdges: graph.edges.length - kept.length };
}

/** P1.4 — every dangling [[link]] across the universe. */
export async function linksReport(root: string) {
  const nodes = await loadNodesShared(root);
  const known = new Set(nodes.map((n) => n.id));
  const dangling: { node: string; danglingLinks: string[] }[] = [];
  for (const n of nodes) {
    const bad = [...new Set(extractLinks(n.summary + "\n" + n.body))].filter((l) => !known.has(l));
    if (bad.length) dangling.push({ node: n.id, danglingLinks: bad });
  }
  return { danglingCount: dangling.reduce((s, d) => s + d.danglingLinks.length, 0), nodes: dangling };
}
