/** Versioned evidence carried by a target-scope ruling application act. */
import { createHash } from "node:crypto";
import type { Actor } from "./schema.js";
import { codeUnitOrder } from "./canonical.js";
import { topicHex } from "./shared-topics.js";

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
  /** An arbitrator's only: the two reader receipts it was shown, so the fold can bind it to them. */
  readerReceipts?: string[];
}

/** What the ruling closes the issue AS — from the option the person chose, never a default. */
export type ApplicationOutcome = "refuted" | "accepted" | "invalid";

/**
 * Version 3 is the only version a fold accepts (plan 1.1): 1 and 2 carried no outcome, so a ruling
 * that said "refuted" closed as `invalid`, and no arbitrator binding the fold could check. None
 * were ever published; an event carrying one is damage.
 */
export interface ApplicationCapsuleV1 {
  version: 3;
  outcome: ApplicationOutcome;
  /** Explicit acceptance, bound to the verified human choice. Present iff `outcome` is accepted. */
  acceptance?: { by: Actor; option: string; findingId: string };
  key: string;
  issue: {
    ref: ApplicationIssueRef;
    key: string;
    openEpoch: string;
    openState: "created" | "issued";
    claimHash: string;
  };
  ruling: {
    /** The answer this applies — the whole of the ruling's identity: the pair key that spends
     *  it is derived from this id, so no second field can disagree with it. */
    answerId: string;
    answerer?: { principal: string };
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
export const applicationKey = (answerId: string, issueKey: string): string =>
  "apply_" + createHash("sha256").update(JSON.stringify(["codemap-ruling-application-v1", answerId, issueKey])).digest("hex");
/** An answer given through a questionnaire has no event of its own: its id derives from the submission. */
export const questionnaireAnswerId = (submission: string, questionId: string): string =>
  "qans_" + createHash("sha256").update(`${submission}\0${questionId}`).digest("hex").slice(0, 24);

/** Claim meaning only. State, assignments, comments and observation times are separate. */
export function issueClaimHash(kind: "finding" | "bug", issue: Record<string, any>): string {
  return kind === "finding"
    ? hash([issue.target, issue.text, issue.comment ?? null, issue.severity ?? null,
      issue.category ?? null, issue.line ?? null, issue.witness ?? null])
    : hash([issue.title, issue.text, issue.severity, issue.category ?? null,
      (issue.anchors ?? []).filter((a: { removed?: unknown }) => !a.removed)
        .map((a: { anchorId: string; bodyHash: string; deleted?: true }) => [a.anchorId, a.bodyHash, !!a.deleted])
        .sort((a: unknown[], b: unknown[]) => codeUnitOrder(String(a[0]), String(b[0])))]);
}

const expectedFindingScope = (ref: Extract<ApplicationIssueRef, { kind: "finding" }>): string | null => {
  if (/^\d+$/.test(ref.review)) return `findings/${ref.universe}/pr-${ref.review}`;
  if (ref.review.startsWith("topic:") && ref.review.length > 6) return `findings/${ref.universe}/t-${topicHex(ref.universe, ref.review.slice(6))}`;
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
  if (!obj(raw) || raw.version !== 3) return { error: "unsupported or missing application capsule version" };
  const c = raw as unknown as ApplicationCapsuleV1;
  if (!obj(c.issue) || !obj(c.issue.ref) || !obj(c.ruling) || !obj(c.evidence)) return { error: "incomplete application capsule" };
  const ref = c.issue.ref;
  if (c.outcome !== "refuted" && c.outcome !== "accepted" && c.outcome !== "invalid") return { error: "an application says what it closes the issue as" };
  if ((c.outcome === "accepted") !== (c.acceptance !== undefined)) return { error: "only an accepting ruling carries acceptance, and it always does" };
  // The outcome is the chosen option's own settle, read from the context the person was shown.
  let shownRuling: any;
  try { shownRuling = JSON.parse(c.ruling.display.context); } catch { return { error: "the ruling context is not comparable" }; }
  const chosen = obj(shownRuling) && Array.isArray(shownRuling.options) && Array.isArray(shownRuling.selected)
    ? shownRuling.options.filter((o: any) => obj(o) && shownRuling.selected.includes(o.label)) : undefined;
  if (!chosen) return { error: "the ruling context does not show the chosen options" };
  const namesThis = (e: any) => obj(e) && ((Array.isArray(e.findings) && e.findings.includes(subject))
    || (Array.isArray(e.issues) && e.issues.some((i: any) => obj(i) && i.kind === kind && i.id === subject)));
  const settles = chosen.flatMap((o: any) => (Array.isArray(o.effects) ? o.effects : []).filter((e: any) => namesThis(e) && e.on === "settle"));
  const said = settles.length ? settles[0].as : undefined;
  if (settles.some((e: any) => e.as !== said) || (said ? said !== c.outcome : c.outcome !== "invalid"))
    return { error: `the chosen option settles this issue as ${said ?? "nothing"}, not ${c.outcome}` };
  if (c.acceptance !== undefined) {
    const a = c.acceptance;
    if (kind !== "finding" || !obj(a) || !obj(a.by) || !str(a.by.principal) || a.by.via !== undefined
      || !str(a.option) || a.findingId !== subject) return { error: "acceptance requires a human principal and exact finding" };
    let shown: any;
    try { shown = JSON.parse(c.ruling.display.context); } catch { return { error: "acceptance context is not comparable" }; }
    if (!obj(c.ruling.answerer) || !str(c.ruling.answerer.principal) || c.ruling.answerer.principal !== a.by.principal
      || !obj(shown) || shown.answerer !== a.by.principal || !Array.isArray(shown.options) || !Array.isArray(shown.selected)
      || !shown.selected.every(str) || !shown.options.every((o: any) => obj(o) && str(o.label) && Array.isArray(o.effects)
        && o.effects.every((e: any) => obj(e) && Array.isArray(e.findings) && e.findings.every(str)
          && (e.issues === undefined || Array.isArray(e.issues) && e.issues.every((i: any) => obj(i))))))
      return { error: "acceptance context or answering principal is invalid" };
    const targets = (e: any) => e.findings.includes(subject) || e.issues?.some((i: any) => i.kind === "finding" && canonicalIssueKey(i) === c.issue.key);
    const selected = shown.options.filter((o: any) => shown.selected.includes(o.label));
    const accepting = selected.filter((o: any) => o.effects.some((e: any) => e.on === "settle" && e.as === "accepted" && targets(e)));
    if (accepting.length !== 1 || accepting[0].label !== a.option
      || selected.some((o: any) => o.effects.some((e: any) => targets(e) && (e.on !== "settle" || e.as !== "accepted"))))
      return { error: "acceptance is not the selected exact finding disposition" };
  }
  if (ref.kind !== kind || ref.id !== subject || !str(ref.universe) || !str(ref.scope)
    || (kind === "finding" && (!str((ref as { review?: string }).review)
      || expectedFindingScope(ref as Extract<ApplicationIssueRef, { kind: "finding" }>) !== ref.scope))
    || (kind === "bug" && ref.scope !== `bugs/${ref.universe}`)) return { error: "application issue identity differs from target" };
  if (c.issue.key !== canonicalIssueKey(ref) || !str(c.issue.openEpoch)
    || (c.issue.openState !== "created" && c.issue.openState !== "issued") || !str(c.issue.claimHash))
    return { error: "application issue witness is invalid" };
  const r = c.ruling;
  if (![r.answerId, r.roundId, r.questionId].every(str)
    || !obj(r.display) || ![r.display.question, r.display.answer, r.display.context].every(str)
    || r.displayHash !== applicationDisplayHash(r.display)
    || !obj(r.authority) || !str(r.authority.checkedAt) || !str(r.authority.sourceFingerprint)
    || r.authority.status !== "current" || r.authority.comparison !== "clear")
    return { error: "application ruling authority snapshot is invalid" };
  if (c.key !== applicationKey(r.answerId, c.issue.key) || !str(c.reason))
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
    // Bound here, not only in the op: the arbitrator read THESE two receipts (plan 1.1).
    if (JSON.stringify(arb.readerReceipts) !== JSON.stringify(readers.map((x) => x.id)))
      return { error: "the arbitrator did not read these two reader receipts" };
  }
  return { capsule: c };
}
