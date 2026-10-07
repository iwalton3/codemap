/**
 * Releasing a held repair sort after the person rules (owner, D2): "If two readers agree on a
 * solid implementation direction approved by clear rulings, it gets unblocked for autonomous
 * fixing. Otherwise a session with a user doing an ez-plan targeted at the backlog is needed."
 * Unanimous, so no arbitrator. The readers see the held claims as filed and the rulings — nothing
 * of the fixer's — and `release_held_sort` builds the correction itself, so the fixer chooses
 * nothing about it.
 */
import { randomUUID } from "node:crypto";
import { requireActor } from "../identity.js";
import { decisionOfEntry, releaseBriefContent, releaseBriefHash, type ReleaseReceipt, type ReleaseRuling, type RepairSortInput } from "../repair-records.js";
import { holdReaderReceipt, readerReceipts, readerRequest, saveReaderRequest } from "../reader-local.js";
import { isUnverified, readReceiptCall, readSubagentCall, transcriptDir } from "../transcript.js";
import { verifierIdentityKey } from "../verifier-boundary.js";
import { standing } from "../shared-decisions.js";
import { decisionsView } from "./decision-holds.js";
import { recordSort, repairRecords } from "./repairs.js";

export interface ReleaseReaderRef { requestId: string; receipt: string; agentId?: string; callId?: string }
const PURPOSE = "release-review" as const;
const TOOL = /(^|__)submit_release_verdict$/;
/** Fixed per sort, rulings and slot, so a `no` held on it stays found (Q5). */
const requestIdOf = (content: unknown, slot: 1 | 2) => "release_" + releaseBriefHash({ content, slot }).slice(7, 39);

/** The held sort and what a release of it would carry, or why there is nothing to release. */
async function heldSort(root: string, review: number | string, sortId: string) {
  const r = await repairRecords(root, review);
  if (r.error !== undefined) return { error: r.error };
  const sort = r.records.sorts.find((s) => s.input.id === sortId);
  if (!sort?.current) return { error: `no current sort ${String(sortId)}: a release names the sort that holds the claims now` };
  const entries = sort.input.restsOn.map(decisionOfEntry).filter((x): x is string => !!x);
  if (!entries.length) return { error: `${sortId} rests on no decision entry: re-point its labels to decision:<id> with a correction first` };
  const view = await decisionsView(root);
  const rulings: ReleaseRuling[] = [];
  for (const id of entries) {
    const d = view.s.decisions.find((x) => x.id === id);
    const a = d && standing(d);
    if (!d || !a || !a.verified || a.sourceAnswer || a.withdrawn || a.cancelled)
      return { error: `decision ${id} has no verified standing answer yet: the person rules first` };
    rulings.push({ decision: id, answer: a.id, question: d.payload.question, words: a.words });
  }
  const claims = r.records.claims.filter((c) => sort.input.coverage.some((ref) => ref.findingId === c.findingId && ref.claimIds.includes(c.id)));
  return { sort: sort.input, content: releaseBriefContent(sort.input, claims, rulings), rulings };
}

/** The exact prompt to launch release reader `slot` with: a new background subagent, blind to the other. */
export async function releaseReaderBrief(root: string, review: number | string, input: { sort: string; slot: 1 | 2 }) {
  if (input?.slot !== 1 && input?.slot !== 2) return { error: "a release has two readers: slot 1 or 2" };
  const held = await heldSort(root, review, input.sort);
  if ("error" in held) return held;
  const requestId = requestIdOf(held.content, input.slot);
  const prompt = JSON.stringify({ requestId, ...held.content,
    task: "Decide, blind to any other reader, whether these rulings, as the person gave them, settle a solid implementation direction for every claim below: yes if fixing it needs no further decision, no otherwise. Call submit_release_verdict with this requestId, yes or no, and your rationale." });
  const saved = saveReaderRequest(root, { purpose: PURPOSE, requestId }, prompt);
  if ("error" in saved) return saved;
  return { ok: true as const, requestId, prompt };
}

export function submitReleaseVerdict(root: string, input: { requestId: string; verdict: "yes" | "no"; rationale: string }) {
  if (!readerRequest(root, { purpose: PURPOSE, requestId: input?.requestId })) return { error: "no release brief with that request id" };
  if (input.verdict !== "yes" && input.verdict !== "no") return { error: "verdict must be yes or no" };
  if (typeof input.rationale !== "string" || !input.rationale.trim()) return { error: "the reader must explain its verdict" };
  const receipt = randomUUID();
  const held = holdReaderReceipt(root, { purpose: PURPOSE, requestId: input.requestId }, receipt, JSON.stringify({ verdict: input.verdict, rationale: input.rationale }));
  return "error" in held ? held : { ok: true as const, held: true as const, receipt };
}

/** A reader's held verdict, checked against its own transcript: the exact brief, the exact call. */
function releaseReceipt(root: string, ref: ReleaseReaderRef, principal: string, dir: string): ReleaseReceipt | { error: string } {
  const key = { purpose: PURPOSE, requestId: ref?.requestId };
  const prompt = readerRequest(root, key);
  const held = readerReceipts(root, key).find((r) => r.receipt === ref?.receipt);
  if (!prompt || !held || (held.state !== "pending" && held.state !== "recorded")) return { error: `no held release verdict ${String(ref?.receipt)}` };
  const body = JSON.parse(held.body) as { verdict: "yes" | "no"; rationale: string };
  const call = ref.agentId && ref.callId ? readSubagentCall(ref.agentId, ref.callId, TOOL, dir) : readReceiptCall(TOOL, ref.receipt, held.heldAt, dir);
  if ("pending" in call) return { error: `${call.pending}: its call is not on disk yet — release again in a moment` };
  if (isUnverified(call)) return { error: call.unverified };
  if (call.reader.prompt !== prompt) return { error: "the reader was not launched with exactly the issued release brief" };
  if (call.input?.requestId !== ref.requestId || call.input?.verdict !== body.verdict || call.input?.rationale !== body.rationale || call.result?.receipt !== ref.receipt)
    return { error: "the reader's own call does not match the held verdict" };
  const { requestId: _r, task: _t, ...content } = JSON.parse(prompt) as Record<string, unknown>;
  return { id: ref.receipt, request: ref.requestId, principal, session: call.reader.session, launch: call.reader.toolUseId,
    briefHash: releaseBriefHash(content), verdict: body.verdict, rationale: body.rationale };
}

/**
 * Release the held sort on its two readers' yes: a correction codemap builds — the held sort's
 * coverage, kind, predicate and sites, `implementation-defect`, its decision entries dropped. A
 * `no` held on either slot's request blocks it on this clone (Q5: local, as withdrawal is); the
 * sort stays held for a person-led /ez-plan.
 */
export async function releaseHeldSort(root: string, review: number | string, input: { sort: string; readers: ReleaseReaderRef[] }, dir: string = transcriptDir()) {
  const held = await heldSort(root, review, input?.sort);
  if ("error" in held) return held;
  const slots = [requestIdOf(held.content, 1), requestIdOf(held.content, 2)];
  if (!Array.isArray(input.readers) || input.readers.length !== 2 || input.readers.some((ref, i) => ref?.requestId !== slots[i]))
    return { error: "a release needs both readers of the current briefs: [slot 1 ref, slot 2 ref]; a brief from before the sort or its rulings changed is stale — issue fresh ones" };
  const actor = requireActor(root);
  if ("error" in actor) return actor;
  const checked = input.readers.map((ref) => releaseReceipt(root, ref, actor.principal, dir));
  const bad = checked.find((r) => "error" in r);
  if (bad) return bad as { error: string };
  const readers = checked as ReleaseReceipt[];
  const brief = releaseBriefHash(held.content);
  if (readers.some((r) => r.briefHash !== brief)) return { error: "a reader read a brief from before the sort or its rulings changed: issue fresh briefs" };
  const key = (x: ReleaseReceipt) => verifierIdentityKey({ principal: x.principal, session: x.session, child: x.launch });
  if (key(readers[0]!) === key(readers[1]!) || readers[0]!.launch === readers[1]!.launch) return { error: "the two release readers were not independently launched" };
  const said = slots.flatMap((requestId) => readerReceipts(root, { purpose: PURPOSE, requestId }))
    .some((r) => (r.state === "pending" || r.state === "recorded") && (JSON.parse(r.body) as { verdict?: string }).verdict === "no");
  if (said || readers.some((r) => r.verdict !== "yes"))
    return { error: "a reader said no: the sort stays held — a person-led /ez-plan over it asks sharper questions, and their answers start a new release" };
  const prior = held.sort;
  const release: Omit<RepairSortInput, "id"> = {
    prior: prior.id, reason: `released on ${held.rulings.map((r) => r.answer).join(", ")} by two readers`,
    classification: "implementation-defect", kind: prior.kind, coverage: prior.coverage,
    ...(prior.predicate !== undefined ? { predicate: prior.predicate } : {}), ...(prior.sites !== undefined ? { sites: prior.sites } : {}),
    restsOn: prior.restsOn.filter((x) => !decisionOfEntry(x)), source: prior.source, provenance: "released",
    assessments: [], disagreements: [], release: { rulings: held.rulings, readers },
  };
  return recordSort(root, review, release);
}
