/**
 * Two universes on one sidecar, for the cross-repo repair tests. Unlike the oracle's clones,
 * the two directories have DIFFERENT basenames, so `universeKey` differs and each has its own
 * findings scopes — the shape a real api + settlement workspace has.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { State } from "./schema.js";
import { shareFinding } from "./ops-shared.js";
import { postRepairSort, recordRepairEvidence } from "./ops/repairs.js";
import { requestRepairVerification } from "./ops/repair-verification.js";
import { resolveDecisionIssue, type CanonicalIssueReference } from "./decision-issues.js";
import { universeKey } from "./sidecar-config.js";
import type { RepairConnection } from "./verifier-boundary.js";
import type { RepairClaimVerdict } from "./repair-verification.js";
import type { RepairSortInput } from "./repair-records.js";
import { discard } from "./test-tmp.js";

const SRC = "export function creditLine(cents) {\n  return cents * 2;\n}\n";
const state = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
export const PRINCIPAL = "alice@x.com";
const ok = (v: unknown) => assert.equal((v as { error?: string }).error, undefined, JSON.stringify(v));

export interface Universe { id: string; root: string; sha: string; anchor: string }

async function universe(base: string, side: string, id: string): Promise<Universe> {
  const root = join(base, id);
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  const git = (...a: string[]) => assert.equal(spawnSync("git", a, { cwd: root }).status, 0, a.join(" "));
  git("init", "-q", "-b", "main");
  git("config", "user.email", PRINCIPAL);
  git("config", "user.name", "alice");
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  writeFileSync(join(root, ".gitignore"), ".codemap/\n", "utf8");
  git("add", "-A");
  git("commit", "-qm", "seed");
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, state);
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { id, root, sha, anchor: anchors[0]!.id };
}

/** `api` (primary) and `settlement`, one sidecar, and a workspace manifest naming both. */
export async function twoUniverses() {
  const base = mkdtempSync(join(tmpdir(), "codemap-xu-"));
  const side = join(base, "sidecar");
  const api = await universe(base, side, "api"), settlement = await universe(base, side, "settlement");
  assert.notEqual(universeKey(api.root), universeKey(settlement.root), "precondition: two universes on one sidecar");
  const manifest = join(base, "codemap.workspace.json");
  writeFileSync(manifest, JSON.stringify({ universes: [{ id: "api", path: "api", primary: true }, { id: "settlement", path: "settlement" }] }), "utf8");
  return { base, side, api, settlement, manifest, dispose: () => discard(base) };
}

/** A finding in `u` with an owner-reviewed sort, inspection evidence and an open request. */
export async function repairable(u: Universe, orchestrator: RepairConnection, sortOver: Partial<RepairSortInput> = {}) {
  const f = await shareFinding(u.root, 7, { targetKind: "anchor", targetId: u.anchor, text: `${u.id}: creditLine doubles`, sourceRef: u.sha }) as { id: string };
  ok(f);
  const coverage = [{ findingId: f.id, claimIds: [`${f.id}:original`] }];
  const sort = await postRepairSort(u.root, 7, { classification: "mechanical", kind: "isolated", source: "approved owner worklist", stakes: "low",
    coverage, restsOn: [], provenance: "owner-reviewed", assessments: [], disagreements: [], ...sortOver }) as { id: string };
  ok(sort);
  const evidence = await recordRepairEvidence(u.root, 7, { sortId: sort.id, witnessCommit: u.sha, baseCommit: u.sha, fixCommit: u.sha,
    coverage: coverage.map((c) => ({ ...c, result: "complete", reason: "r", claimResults: [{ claimId: c.claimIds[0]!, result: "complete", reason: "r" }] })),
    reproducer: [], regression: [], inspected: [{ source: "src/credit.js", commit: u.sha, reasoning: "read" }], noCheckReason: "no runnable check", rulingIds: [], attribution: [] }) as { id: string };
  ok(evidence);
  const requested = await requestRepairVerification(u.root, 7, { sortId: sort.id, evidenceId: evidence.id }, orchestrator) as { id: string };
  ok(requested);
  const ref = await resolveDecisionIssue(u.root, { kind: "finding", universe: universeKey(u.root), id: f.id, review: 7 });
  assert.ok(ref.ok, JSON.stringify(ref));
  return { finding: f.id, sortId: sort.id, evidenceId: evidence.id, requestId: requested.id, ref: ref.ref as CanonicalIssueReference };
}

/** An inspection verdict of `fixed` on the one original claim of `finding`. */
export const fixedBy = (u: Universe, finding: string): RepairClaimVerdict[] => [{ findingId: finding, claimId: `${finding}:original`, verdict: "fixed",
  reason: "independently inspected the guard at the fix commit", grade: "inspection", executions: [],
  inspected: [{ source: "src/credit.js", commit: u.sha, reasoning: "the guard is present" }], noCheckReason: "no runnable check" }];

/** One subagent launched with `prompt` making several submit calls of `tool`, each returning its own held receipt. */
export function batchTranscript(dir: string, agentId: string, prompt: string, calls: { input: unknown; result: unknown }[], tool = "repair_verification") {
  const session = "5e55a0a0-0000-0000-0000-00000000000" + agentId.slice(-1), launch = `launch_${agentId}`;
  const sub = join(dir, session, "subagents");
  mkdirSync(sub, { recursive: true });
  const lines = (rows: object[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "general-purpose", toolUseId: launch }));
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), lines([
    { type: "user", isSidechain: true, agentId, sessionId: session, message: { role: "user", content: prompt } },
    ...calls.flatMap((c, i) => [
      { type: "assistant", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_use", id: `toolu_${agentId}_${i}`, name: `mcp__codemap__${tool}`, input: c.input }] } },
      { type: "user", isSidechain: true, agentId, sessionId: session, message: { content: [{ type: "tool_result", tool_use_id: `toolu_${agentId}_${i}`, content: JSON.stringify(c.result) }] } },
    ]),
  ]));
  writeFileSync(join(dir, `${session}.jsonl`), lines([
    { type: "assistant", isSidechain: false, timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", id: launch, name: "Agent", input: { prompt, subagent_type: "general-purpose" } }] } },
    { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: launch, content: "launched" }] }, toolUseResult: { agentId } },
  ]));
  return session;
}
