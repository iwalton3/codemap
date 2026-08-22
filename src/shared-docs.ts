/**
 * Docs on the sidecar.
 *
 * The fit is unusually good, and it is worth saying why: a doc was ALREADY an
 * append-only log. `docs/doc-versioning.md` made a node a set of immutable
 * versions, each recording the anchors it cites with the hashes it was written
 * against, and resolution picks the version whose accepted hashes match the code
 * in front of you. That is a fold over an accumulating set of records — which is
 * what this module stores, rather than a new model bolted on.
 *
 * ## Why `node_versions` had to stay
 *
 * `docs/proposal-committed-docs.md` could drop versioning because committing docs
 * into the code repo makes selection trivial: a checkout IS the version. The
 * sidecar's timeline is not the code repo's, so that shortcut is gone and
 * per-citation accepted hashes are what makes one linear log serve every branch.
 * `winningVersionAt` does the selection and is reused verbatim — no branch tags,
 * no git, just hash-match against whatever is checked out.
 *
 * ## One scope per universe
 *
 * Unlike notes, which are bucketed by target because drawing one symbol's notes
 * must not read the universe, the common read for docs is the CATALOGUE — the
 * outline, the node list, `find_gaps`. Bucketing would turn that into 256 reads
 * to save nothing: node counts are hundreds, not the tens of thousands notes can
 * reach.
 */

import type { Actor } from "./schema.js";
import type { NodeVersion, NodeCitation, LogicalNodeType } from "./schema.js";
import { winningVersionAt } from "./doc-version.js";
import { appendEvents, mintId, readScope, causalHeads, type LogEvent } from "./eventlog.js";

export const docScope = (universe: string): string => `docs/${universe}`;

export interface SharedDoc {
  nodeId: string;
  /** Oldest first. Immutable once written — a change is a new version. */
  versions: NodeVersion[];
  /** Who wrote each version, which `NodeVersion` itself has no room for. */
  authors: Map<string, Actor>;
}

type Data = Record<string, unknown>;

/**
 * Fold the log into each node's version set.
 *
 * Accepted hashes are merged as a GROW-ONLY set per (version, anchor): confirming
 * a doc against a second branch's body is exactly the append-only act the design
 * wants, and two people confirming on different branches must both stick. That is
 * the same shape as a review's accepted set, and merge-free for the same reason.
 */
export function foldDocs(events: LogEvent[]): Map<string, SharedDoc> {
  const out = new Map<string, SharedDoc>();
  const byVersion = new Map<string, NodeVersion>();

  for (const e of events) {
    const d = e.data as Data | undefined;

    if (e.kind === "doc.version") {
      const v = d?.version as NodeVersion | undefined;
      // Skipped rather than fatal: it arrived from somebody else's client. The
      // citations check earns its place — `citations: "bad"` parses, passes every
      // other test here, and then throws on `.map()`, which is not one bad doc but
      // every shared doc in the universe becoming unreadable for everyone, forever.
      if (!v || typeof v.versionId !== "string" || v.nodeId !== e.subject) continue;
      if (v.citations !== undefined && !Array.isArray(v.citations)) continue;
      let doc = out.get(e.subject);
      if (!doc) { doc = { nodeId: e.subject, versions: [], authors: new Map() }; out.set(e.subject, doc); }
      if (byVersion.has(v.versionId)) continue; // a version id is written once
      const copy: NodeVersion = {
        ...v,
        citations: (v.citations ?? [])
          .filter((c) => c && typeof c.anchorId === "string")
          .map((c) => ({ ...c, acceptedHashes: Array.isArray(c.acceptedHashes) ? [...c.acceptedHashes] : [] })),
      };
      byVersion.set(v.versionId, copy);
      doc.versions.push(copy);
      doc.authors.set(v.versionId, e.actor);
      continue;
    }

    if (e.kind === "doc.accepted") {
      const versionId = typeof d?.versionId === "string" ? d.versionId : null;
      const anchorId = typeof d?.anchorId === "string" ? d.anchorId : null;
      const bodyHash = typeof d?.bodyHash === "string" ? d.bodyHash : null;
      if (!versionId || !anchorId || !bodyHash) continue;
      const v = byVersion.get(versionId);
      if (!v) continue;
      const cite = v.citations.find((c) => c.anchorId === anchorId);
      // Only a hash for an anchor this version already cites: confirming a doc
      // against code it never claimed anything about would make it read `fresh`
      // for a reason nobody wrote down.
      if (!cite) continue;
      if (!cite.acceptedHashes.includes(bodyHash)) cite.acceptedHashes.push(bodyHash);
    }
  }
  return out;
}

/**
 * The version that best fits the code in front of you.
 *
 * `winningVersionAt` is shared with `store.ts` rather than reimplemented — the
 * selection rule is the same whether the versions came from SQLite or from a
 * shared log, and two copies of it is how they would drift.
 *
 * It picks the LEAST-BAD version, so a doc with versions always resolves to one
 * even when none of them was written against this checkout. Whether the winner is
 * actually fresh is a separate question, answered per citation by comparing its
 * accepted hashes to the live body. Undefined only when there are no versions.
 */
export function resolveDoc(doc: SharedDoc, liveHashes: Map<string, string>): NodeVersion | undefined {
  return winningVersionAt(doc.versions, liveHashes);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function emit(logRoot: string, universe: string, actor: Actor, subject: string, kind: string, data: Data): Promise<LogEvent> {
  const scope = docScope(universe);
  const seen = causalHeads(await readScope(logRoot, scope));
  const event: LogEvent = {
    id: mintId(), kind, subject, actor, at: new Date().toISOString(),
    ...(seen.length ? { after: seen } : {}),
    data,
  };
  await appendEvents(logRoot, scope, actor, [event]);
  return event;
}

export interface NewDocVersion {
  nodeId: string;
  type: LogicalNodeType;
  title: string;
  summary: string;
  body: string;
  citations: NodeCitation[];
  generatedBy?: string;
  removed?: boolean;
  createdCommit?: string | null;
  createdBranch?: string | null;
}

/** Publish a version. Every write is a new version — nothing is ever edited. */
export async function publishDocVersion(logRoot: string, universe: string, actor: Actor, v: NewDocVersion): Promise<string> {
  const versionId = "nv_" + mintId();
  const version: NodeVersion = {
    versionId,
    nodeId: v.nodeId,
    type: v.type,
    title: v.title,
    summary: v.summary,
    body: v.body,
    citations: v.citations,
    ...(v.generatedBy ? { generatedBy: v.generatedBy } : {}),
    ...(v.removed ? { removed: true } : {}),
    createdCommit: v.createdCommit ?? null,
    createdBranch: v.createdBranch ?? null,
    createdAt: new Date().toISOString(),
  };
  await emit(logRoot, universe, actor, v.nodeId, "doc.version", { version: version as unknown as Data });
  return versionId;
}

/**
 * Record that a version is valid against a body it had not seen.
 *
 * The confirm act, and the one that makes a doc travel between branches: a
 * version confirmed against `develop`'s body and against a feature branch's is
 * `fresh` on both, without either being tagged.
 */
export const acceptDocHash = (logRoot: string, universe: string, actor: Actor, nodeId: string, versionId: string, anchorId: string, bodyHash: string) =>
  emit(logRoot, universe, actor, nodeId, "doc.accepted", { versionId, anchorId, bodyHash });

export async function readDocs(logRoot: string, universe: string): Promise<Map<string, SharedDoc>> {
  return foldDocs(await readScope(logRoot, docScope(universe)));
}
