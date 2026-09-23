/**
 * Where a person's answer to a decision reaches the folds that run today.
 *
 * - **The findings close path** accepts an agent's close that carries a stamp describing THIS
 *   close — the finding and the state — and names whose ruling it carries out (`ruler`). It
 *   never reopens, and a finding already closed stays as its closer left it.
 * - **The hold** on a triaged finding is the existing ratchet: once a sorter's verdict confirms
 *   a finding, an agent cannot close it without a stamp (owner, 2026-09-23: "The purpose of
 *   allowing agents to close agent findings was if they weren't triaged first").
 * - **The standard is untouched.** A sign-off carried out from an answer waits for the
 *   verifier (owner, 2026-09-23, "Waits for I9 too"), so an agent's stamped sign-off still
 *   signs nothing — pinned here so the old bypass cannot come back unannounced.
 *
 * Rulings: docs/decision-rounds-worked-cases.md.
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
/** What a verified settle of f_1 carries: whose ruling, the finding it closes, and how. */
const stamp = { ...base, finding: "f_1", as: "refuted" };

// --- findings ---------------------------------------------------------------------------

const created = testEvent({
  id: "0000000001-a", kind: "finding.created", subject: "f_1", actor: person,
  data: { targetKind: "anchor", targetId: "a_1", text: "t" },
});
const change = (id: string, state: string, data: Record<string, unknown> = {}, prev = created.id) => testEvent({
  id, kind: "finding.stateChanged", subject: "f_1", actor: agent, writerPrev: prev, after: [prev], data: { state, ...data },
});

test("an agent's close of a person's finding needs a decision stamp, and records whose ruling it was", () => {
  const bare = foldFindings([created, change("0000000002-b", "refuted")]).get("f_1")!;
  assert.notEqual(bare.state, "refuted", "unstamped, it is the ratchet as before");

  const f = foldFindings([created, change("0000000002-b", "refuted", { decision: stamp })]).get("f_1")!;
  assert.equal(f.state, "refuted");
  assert.deepEqual(f.closed?.decision, stamp, "the close says which decision it carried out");
  assert.equal(f.closed?.decision?.ruler, "alice@x.com", "and whose ruling — not the closing agent's principal");
  assert.equal(f.closed?.by.principal, "izzie@x.com", "the closer is still whoever's agent closed it");
});

test("a stamp that does not name its ruler is no stamp", () => {
  const { ruler: _r, ...noRuler } = stamp;
  const f = foldFindings([created, change("0000000002-b", "refuted", { decision: noRuler })]).get("f_1")!;
  assert.notEqual(f.state, "refuted");
});

test("a stamp does not let an agent reopen what a person closed", () => {
  const closed = testEvent({
    id: "0000000002-b", kind: "finding.stateChanged", subject: "f_1", actor: person,
    writerPrev: created.id, after: [created.id], data: { state: "resolved" },
  });
  const f = foldFindings([created, closed, change("0000000003-c", "issued", { decision: stamp }, closed.id)]).get("f_1")!;
  assert.equal(f.state, "resolved", "a decision settles; it never un-settles through an agent");
});

test("a malformed stamp is no stamp", () => {
  const f = foldFindings([created, change("0000000002-b", "refuted", { decision: { round: "R1" } })]).get("f_1")!;
  assert.notEqual(f.state, "refuted");
});

test("a stamp closes only the finding it names, and only as its `as` says", () => {
  const other = foldFindings([created, change("0000000002-b", "refuted", { decision: { ...stamp, finding: "f_2" } })]).get("f_1")!;
  assert.notEqual(other.state, "refuted", "a stamp for another finding closes nothing here");
  const wrongState = foldFindings([created, change("0000000002-b", "withdrawn", { decision: stamp })]).get("f_1")!;
  assert.notEqual(wrongState.state, "withdrawn", "a refuting decision does not withdraw");
  const bare = foldFindings([created, change("0000000002-b", "refuted", { decision: base })]).get("f_1")!;
  assert.notEqual(bare.state, "refuted", "a stamp that does not say what it closes is no stamp");
});

test("a stamped close leaves an already-closed finding closed, as its closer left it — whoever closed it", () => {
  for (const closer of [person, { principal: "bob@x.com", via: { kind: "agent" as const, model: "m" } }]) {
    const closed = testEvent({
      id: "0000000002-b", kind: "finding.stateChanged", subject: "f_1", actor: closer,
      writerPrev: created.id, after: [created.id], data: { state: "refuted", reason: "first closer's reason", ...(closer.via ? { decision: stamp } : {}) },
    });
    const f = foldFindings([created, closed, change("0000000003-c", "refuted", { decision: { ...stamp, answer: "e10" } }, closed.id)]).get("f_1")!;
    assert.equal(f.closed?.reason, "first closer's reason");
    assert.equal(f.closed?.by.principal, closer.principal);
  }
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

test("an untriaged agent finding is an agent's to refute; one a sorter confirmed is held for a stamp", () => {
  const untriaged = foldFindings([agentFiled, change("0000000002-b", "refuted", {}, agentFiled.id)]).get("f_1")!;
  assert.equal(untriaged.state, "refuted", "nobody stood behind it, so refuting it is triage");

  const c = verdict("0000000002-b", "confirm", "sorter", agentFiled.id);
  const triaged = foldFindings([agentFiled, c, change("0000000003-c", "refuted", {}, c.id)]).get("f_1")!;
  assert.notEqual(triaged.state, "refuted", "a sorter confirmed it: an agent alone cannot close it");
  const carried = foldFindings([agentFiled, c, change("0000000003-c", "refuted", { decision: stamp }, c.id)]).get("f_1")!;
  assert.equal(carried.state, "refuted", "carrying out a ruling on it can");

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
