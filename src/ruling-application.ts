/** Versioned evidence carried by a target-scope ruling application act. */
import { createHash } from "node:crypto";
import type { Actor } from "./schema.js";

export type ApplicationIssueRef =
  | { kind: "finding"; universe: string; id: string; scope: string; review: string }
  | { kind: "bug"; universe: string; id: string; scope: string };

export interface ApplicationReaderReceipt {
  id: string;
  request: string;
  launch: string;
  session: string;
  by: Actor;
  briefHash: string;
  manifestHash: string;
  issueHash: string;
  rulingHash: string;
  verdict: "sound" | "unsound";
  rationale: string;
}

export interface ApplicationCapsuleV1 {
  version: 1;
  key: string;
  issue: {
    ref: ApplicationIssueRef;
    key: string;
    openEpoch: string;
    openState: "created" | "issued";
    claimHash: string;
  };
  ruling: {
    /** Authority identity, stable across retries/readers, changed only by a substantive human ruling. */
    key: string;
    answerId: string;
    answerEvent: string;
    roundId: string;
    questionId: string;
    display: { question: string; answer: string; context: string };
    displayHash: string;
    authority: {
      /** Writer validates these against the ruling scope immediately before append. */
      checkedAt: string;
      sourceFingerprint: string;
      status: "current";
      comparison: "clear";
    };
  };
  evidence: {
    directMention?: string;
    readers: ApplicationReaderReceipt[];
    arbitrator?: ApplicationReaderReceipt;
  };
  reason: string;
}

export interface ApplicationAttempt {
  eventId: string;
  at: string;
  by: Actor;
  status: "executed" | "duplicate" | "refused";
  reason?: string;
  key?: string;
  capsule?: ApplicationCapsuleV1;
}

const canonicalIssueKey = (ref: ApplicationIssueRef): string =>
  "issue_" + createHash("sha256")
    .update(JSON.stringify(["codemap-issue-v1", ref.kind, ref.universe, ref.scope, ref.id]))
    .digest("hex");

const hash = (value: unknown): string => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const applicationDisplayHash = (display: ApplicationCapsuleV1["ruling"]["display"]): string => hash(display);
export const applicationKey = (rulingKey: string, issueKey: string): string =>
  "apply_" + createHash("sha256").update(JSON.stringify(["codemap-ruling-application-v1", rulingKey, issueKey])).digest("hex");

/** Claim meaning only. State, assignments, comments and observation times are separate. */
export function issueClaimHash(kind: "finding" | "bug", issue: Record<string, any>): string {
  return kind === "finding"
    ? hash([issue.target, issue.text, issue.comment ?? null, issue.severity ?? null,
      issue.category ?? null, issue.line ?? null, issue.witness ?? null])
    : hash([issue.title, issue.text, issue.severity, issue.category ?? null,
      (issue.anchors ?? []).filter((a: { removed?: unknown }) => !a.removed)
        .map((a: { anchorId: string; bodyHash: string; deleted?: true }) => [a.anchorId, a.bodyHash, !!a.deleted])
        .sort((a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0])))]);
}

const expectedFindingScope = (ref: Extract<ApplicationIssueRef, { kind: "finding" }>): string | null => {
  if (/^\d+$/.test(ref.review)) return `findings/${ref.universe}/pr-${ref.review}`;
  if (!ref.review.startsWith("branch:") || !ref.review.slice(7)) return null;
  const branch = ref.review.slice(7);
  const digest = createHash("sha256").update(`${ref.universe}\0branch\0${branch}`).digest("hex").slice(0, 40);
  return `findings/${ref.universe}/b-${digest}`;
};

const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const directTargetShown = (mention: string, ref: ApplicationIssueRef, display: ApplicationCapsuleV1["ruling"]["display"]): boolean => {
  if (![display.question, display.answer].some((s) => s.includes(mention))) return false;
  if (mention === ref.id) {
    return [display.question, display.answer].some((shown) => {
      let at = shown.indexOf(ref.id);
      while (at >= 0) {
        const before = shown[at - 1];
        const after = shown[at + ref.id.length];
        if ((!before || !/[A-Za-z0-9_]/.test(before)) && (!after || !/[A-Za-z0-9_]/.test(after))) return true;
        at = shown.indexOf(ref.id, at + 1);
      }
      return false;
    });
  }
  try {
    const url = new URL(mention, "https://codemap.invalid/");
    const hash = url.hash.slice(1);
    const [path, query] = hash.split("?", 2);
    const encoded = encodeURIComponent(ref.universe);
    if (!path?.startsWith(`/u/${encoded}/`) && !path?.startsWith(`/u/${ref.universe}/`)) return false;
    const tail = path.slice(path.indexOf("/u/") + 3 + (path.startsWith(`/u/${encoded}/`) ? encoded.length : ref.universe.length));
    if (ref.kind === "finding") {
      const review = /^\/shared\/([^/]+)\//.exec(tail)?.[1];
      if (!review || decodeURIComponent(review) !== ref.review) return false;
    }
    if (ref.kind === "bug" && !tail.startsWith("/bugs/")) return false;
    return new URLSearchParams(query).get(ref.kind === "finding" ? "f" : "bug") === ref.id;
  } catch { return false; }
};

const receipt = (v: unknown, issueHash: string, rulingHash: string): v is ApplicationReaderReceipt => {
  if (!obj(v) || !obj(v.by) || !str(v.by.principal)) return false;
  return [v.id, v.request, v.launch, v.session, v.briefHash, v.manifestHash, v.rationale].every(str)
    && v.issueHash === issueHash && v.rulingHash === rulingHash
    && (v.verdict === "sound" || v.verdict === "unsound");
};

/** Pure target-scope validation. Source receipt authenticity belongs to write admission. */
export function validateApplicationCapsule(
  raw: unknown, kind: "finding" | "bug", subject: string,
): { capsule: ApplicationCapsuleV1 } | { error: string } {
  if (!obj(raw) || raw.version !== 1) return { error: "unsupported or missing application capsule version" };
  const c = raw as unknown as ApplicationCapsuleV1;
  if (!obj(c.issue) || !obj(c.issue.ref) || !obj(c.ruling) || !obj(c.evidence)) return { error: "incomplete application capsule" };
  const ref = c.issue.ref;
  if (ref.kind !== kind || ref.id !== subject || !str(ref.universe) || !str(ref.scope)
    || (kind === "finding" && (!str((ref as { review?: string }).review)
      || expectedFindingScope(ref as Extract<ApplicationIssueRef, { kind: "finding" }>) !== ref.scope))
    || (kind === "bug" && ref.scope !== `bugs/${ref.universe}`)) return { error: "application issue identity differs from target" };
  if (c.issue.key !== canonicalIssueKey(ref) || !str(c.issue.openEpoch)
    || (c.issue.openState !== "created" && c.issue.openState !== "issued") || !str(c.issue.claimHash))
    return { error: "application issue witness is invalid" };
  const r = c.ruling;
  if (![r.key, r.answerId, r.answerEvent, r.roundId, r.questionId].every(str)
    || !obj(r.display) || ![r.display.question, r.display.answer, r.display.context].every(str)
    || r.displayHash !== applicationDisplayHash(r.display)
    || !obj(r.authority) || !str(r.authority.checkedAt) || !str(r.authority.sourceFingerprint)
    || r.authority.status !== "current" || r.authority.comparison !== "clear")
    return { error: "application ruling authority snapshot is invalid" };
  // The pair key is what spends a ruling, so a key that is not the answer it cites would let
  // one answer close a reopened issue again under a fresh key.
  if (r.key !== r.answerId) return { error: "application ruling key must be the answer it cites" };
  if (c.key !== applicationKey(r.key, c.issue.key) || !str(c.reason))
    return { error: "application key or reason is invalid" };
  const readers = c.evidence.readers;
  if (!Array.isArray(readers) || !readers.every((x) => receipt(x, c.issue.claimHash, r.displayHash)))
    return { error: "application reader receipts are invalid or unbound" };
  const direct = c.evidence.directMention;
  if (direct !== undefined && (!str(direct) || !directTargetShown(direct, ref, r.display)))
    return { error: "direct target mention was not shown with the ruling" };
  if (direct && readers.length !== 1) return { error: "direct application requires one reader" };
  if (!direct && readers.length !== 2) return { error: "indirect application requires two readers" };
  if (new Set(readers.map((x) => x.session)).size !== readers.length
    || new Set(readers.map((x) => x.launch)).size !== readers.length
    || new Set(readers.map((x) => x.id)).size !== readers.length)
    return { error: "application readers are not independently launched" };
  const sound = readers.filter((x) => x.verdict === "sound").length;
  if (direct && sound !== 1) return { error: "application reader did not find the ruling sound" };
  if (!direct && sound === 2 && c.evidence.arbitrator !== undefined)
    return { error: "unneeded arbitrator receipt" };
  if (!direct && sound === 0) return { error: "neither reader found the ruling sound" };
  if (!direct && sound === 1) {
    const arb = c.evidence.arbitrator;
    if (!receipt(arb, c.issue.claimHash, r.displayHash) || arb.verdict !== "sound"
      || readers.some((x) => x.session === arb.session || x.launch === arb.launch || x.id === arb.id))
      return { error: "reader disagreement lacks an independent sound arbitrator" };
  }
  return { capsule: c };
}
