/**
 * A decision stamp on a finding close opens NOTHING, and a stamped sign-off signs nothing.
 *
 * No close is opened by a decision stamp — an agent may not close a finding a person stood behind
 * because the event carries a person's answer to a decision (owner, 2026-09-23, S0.6: "Remove it
 * now"). The findings fold cannot check such a stamp against the decisions record, so any close
 * carrying a well-formed one would pass. The verifier (I9) adds its own close path under its own
 * ruling. These pin that such a bypass cannot come back unannounced, and that stamped events
 * already in logs are read as ordinary closes.
 *
 * Rulings: docs/decision-rounds-worked-cases.md; `.git/triage/2026-09-23-decision-rounds-2-impl-review/owner.md`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { Actor, State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { readScope, type LogEvent } from "./eventlog.js";
import { foldStandard, lawScope } from "./shared-standard.js";
import { foldFindings } from "./shared-findings.js";
import { draftSpec, addOperation } from "./requirements.js";
import { signOffEverything } from "./test-approve.js";
import { testEvent } from "./test-events.js";

const person: Actor = { principal: "izzie@x.com" };
const agent: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "m" } };
const base = { round: "R1", decision: "d1", answer: "e9", ruler: "alice@x.com" };
/** What a stamped close event carried, when a build still wrote them. */
const stamp = { ...base, finding: "f_1", as: "refuted" };

// --- findings ---------------------------------------------------------------------------

const created = testEvent({
  id: "0000000001-a", kind: "finding.created", subject: "f_1", actor: person,
  data: { targetKind: "anchor", targetId: "a_1", text: "t" },
});
const change = (id: string, state: string, data: Record<string, unknown> = {}, prev = created.id) => testEvent({
  id, kind: "finding.stateChanged", subject: "f_1", actor: agent, writerPrev: prev, after: [prev], data: { state, ...data },
});

test("S0.6: an agent's stamped close of a person's finding is ignored, like an unstamped one", () => {
  for (const data of [{}, { decision: stamp }]) {
    const f = foldFindings([created, change("0000000002-b", "refuted", data)]).get("f_1")!;
    assert.notEqual(f.state, "refuted", JSON.stringify(data));
    assert.equal((f as any).settledBy, undefined);
  }
});

test("S0.6: a person's close carrying a stamp is their own close, as ever", () => {
  const byPerson = testEvent({ id: "0000000002-b", kind: "finding.stateChanged", subject: "f_1", actor: person, writerPrev: created.id, after: [created.id], data: { state: "refuted", reason: "mine", decision: stamp } });
  const f = foldFindings([created, byPerson]).get("f_1")!;
  assert.equal(f.state, "refuted");
  assert.equal(f.closed?.reason, "mine");
  assert.equal((f.closed as any)?.decision, undefined, "the stamp is not carried onto the close");
});

// --- the hold on a triaged finding (N13) -------------------------------------------------

const agentFiled = testEvent({
  id: "0000000001-a", kind: "finding.created", subject: "f_1", actor: agent,
  data: { targetKind: "anchor", targetId: "a_1", text: "t" },
});
const verdict = (id: string, v: string, model: string, prev: string) => testEvent({
  id, kind: "finding.corroborated", subject: "f_1", actor: { principal: "izzie@x.com", via: { kind: "agent", model } },
  writerPrev: prev, after: [prev], data: { verdict: v, note: "sorter" },
});

test("an untriaged agent finding is an agent's to refute; one a sorter confirmed is held, stamp or no stamp", () => {
  const untriaged = foldFindings([agentFiled, change("0000000002-b", "refuted", {}, agentFiled.id)]).get("f_1")!;
  assert.equal(untriaged.state, "refuted", "nobody stood behind it, so refuting it is triage");

  const c = verdict("0000000002-b", "confirm", "sorter", agentFiled.id);
  for (const data of [{}, { decision: stamp }]) {
    const triaged = foldFindings([agentFiled, c, change("0000000003-c", "refuted", data, c.id)]).get("f_1")!;
    assert.notEqual(triaged.state, "refuted", `a sorter confirmed it: an agent alone cannot close it (${JSON.stringify(data)})`);
  }

  const r = verdict("0000000002-b", "refute", "sorter", agentFiled.id);
  const refutedBySort = foldFindings([agentFiled, r, change("0000000003-c", "refuted", {}, r.id)]).get("f_1")!;
  assert.equal(refutedBySort.state, "refuted", "a sorter's refute stands behind nothing, so it holds nothing");
});

// --- the standard: untouched, a stamped sign-off waits for I9 --------------------------------

test("an agent's sign-off signs nothing, stamp or no stamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-stamp-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-stamp-side-"));
  try {
    const git = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "izzie@x.com");
    git("config", "user.name", "izzie");
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    const SRC = "export function creditLine(cents) { return cents; }\n";
    writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
    git("add", "-A");
    git("commit", "-qm", "init");
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    await writeStore(root, await indexBlob(SRC, "src/credit.js"), { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
    const sp = await draftSpec(root, { title: "Credit currency policy" }) as { id: string };
    await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "never written down", reversibility: "reversible",
      title: "Credit line currency", section: "Credit/Limits", statement: "All credit lines are in USD.", provenance: "policy §4",
    });
    const signed = await signOffEverything(root, sp.id);
    assert.ok(!("error" in signed), JSON.stringify(signed));
    const events = await readScope(side, lawScope());
    assert.ok(foldStandard(events).witnesses.length > 0, "the person's own sign-offs count");
    const asAgent = (data: (e: LogEvent) => Record<string, unknown>) =>
      events.map((e) => (e.kind === "spec.reviewed" ? { ...e, actor: agent, data: data(e) } : e));
    assert.equal(foldStandard(asAgent((e) => e.data!)).witnesses.length, 0);
    assert.equal(foldStandard(asAgent((e) => ({ ...e.data!, decision: { ...base, operationId: (e.data as any).witness.operationId, content: "x" } }))).witnesses.length, 0);
  } finally { discard(root); discard(side); }
});
