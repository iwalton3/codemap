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
import type { AnchorIndex } from "./anchor-resolve.js";
import { appendEvents, mintId, readScope, causalHeads, type LogEvent } from "./eventlog.js";

export const docScope = (universe: string): string => `docs/${universe}`;

export interface SharedDoc {
  nodeId: string;
  /** Oldest first. Immutable once written — a change is a new version. */
  versions: NodeVersion[];
  /** Who wrote each version, which `NodeVersion` itself has no room for. */
  authors: Map<string, Actor>;
  /**
   * Acceptances that found no citation to attach to.
   *
   * Kept OUT of the citation sets on purpose (see the fold) and kept out of the bin
   * as well. A teammate whose build derives anchor ids differently confirms
   * `a_theirs` against a version that cites `a_mine`, and the two ids name the same
   * symbol — which nothing here can know, so merging would be a guess. Dropping was
   * the other extreme: their acceptance simply never happened, with no trace.
   *
   * The fold recomputes from the log on every read, so retention costs nothing
   * durable and a later reader that CAN pair them recovers what this one could not.
   */
  unmatched?: UnmatchedAcceptance[];
}

export interface UnmatchedAcceptance {
  versionId: string;
  anchorId: string;
  bodyHash: string;
  /** `no-version` — this fold never saw that version; `no-citation` — it did, and
   *  the version does not cite that anchor id. */
  why: "no-version" | "no-citation";
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
      // A version id is written once, and once per SCOPE — not per node, because
      // `doc.accepted` carries no node and resolves the id globally. So the drop
      // has to come BEFORE the doc is created: a node whose every version collides
      // with another node's used to be left as an existing doc with no versions,
      // which reads as "written and empty" rather than "never arrived".
      if (byVersion.has(v.versionId)) continue;
      let doc = out.get(e.subject);
      if (!doc) { doc = { nodeId: e.subject, versions: [], authors: new Map() }; out.set(e.subject, doc); }
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
      // Its OWN node's version. The id resolves globally, so an acceptance under a
      // colliding id would otherwise reach into another node's version and add a
      // hash nobody claimed there — the false-provenance direction, and silent.
      const found = byVersion.get(versionId);
      const v = found?.nodeId === e.subject ? found : undefined;
      const cite = v?.citations.find((c) => c.anchorId === anchorId);
      // Only a hash for an anchor this version already cites: confirming a doc
      // against code it never claimed anything about would make it read `fresh`
      // for a reason nobody wrote down. But RETAINED rather than dropped — see
      // `SharedDoc.unmatched`. This is the one join in the design that is
      // record-against-record, so it fails before any reader-side resolution could
      // run, and it used to fail by leaving nothing behind.
      if (!cite) {
        const doc = out.get(e.subject);
        if (doc) (doc.unmatched ??= []).push({ versionId, anchorId, bodyHash, why: v ? "no-citation" : "no-version" });
        continue;
      }
      // EXACT, deliberately — not `sameBody`. This is an insert, not a comparison.
      // A hash string is a digest plus annotations about how it was derived, and
      // deduping by body would mean a better-annotated form of a hash already in
      // the set is silently dropped: the set could never improve, and this doc
      // would stay unable to tell derivation drift from code drift, permanently.
      // Membership questions elsewhere DO use `sameBody`; see
      // docs/decision-receipts-vs-prefix.md.
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
export function resolveDoc(doc: SharedDoc, liveHashes: AnchorIndex): NodeVersion | undefined {
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
  /**
   * ONLY for an id this machine's own store minted — never from an opaque caller,
   * which is why `shareDoc` strips it. Version ids are unique per SCOPE and not per
   * node: `foldDocs` drops any repeat, so a colliding id costs THAT node its doc for
   * the whole team.
   *
   * It exists because the pending overlay identifies a local row with its own
   * published event, which needs the two to carry one id — see
   * PROPOSAL-sidecar-materialization.md §7, "the outbox model".
   */
  versionId?: string;
  /**
   * When it was WRITTEN, when that is not now. A backfill republishes a node's whole
   * history, and `selectWinner` tiebreaks equal badness on this — so stamping it at
   * migration time ranks versions by publication order instead of authorship.
   */
  createdAt?: string;
}

/** Publish a version. Every write is a new version — nothing is ever edited. */
export async function publishDocVersion(logRoot: string, universe: string, actor: Actor, v: NewDocVersion): Promise<string> {
  // A supplied id has to be usable as one: the fold drops a version whose id is not
  // a string, so a bad one here is a write that silently never arrives.
  const versionId = typeof v.versionId === "string" && v.versionId.trim() ? v.versionId : "nv_" + mintId();
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
    createdAt: v.createdAt ?? new Date().toISOString(),
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
