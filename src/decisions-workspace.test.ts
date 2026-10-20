/**
 * Decisions are the workspace's (plan 2026-10-19-batch-release-held-sorts, Phase 1): one
 * `law/decisions` per sidecar, folded together with every legacy `decisions/<universe>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { State } from "./schema.js";
import { shareFinding, bindDecisions } from "./ops-shared.js";
import { postRound, answerDirect } from "./ops/decisions.js";
import { cachedDecisions, decisionsView } from "./ops/decision-holds.js";
import { resolveDecisionIssue, type CanonicalIssueReference } from "./decision-issues.js";
import { DECISIONS_SCOPE, decisionScope, foldDecisions, postRoundEvent, recordAnswerEvent } from "./shared-decisions.js";
import { readScope } from "./eventlog.js";
import { universeKey } from "./sidecar-config.js";
import { stable } from "./oracle-properties.js";
import { discard } from "./test-tmp.js";

const SRC = "export function creditLine(cents) {\n  return cents * 2;\n}\n";
const state = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;

const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};
const asAgent = <T>(fn: () => Promise<T>) => withEnv({ CODEMAP_AGENT_MODEL: "claude-opus-5" }, fn);
const asPerson = <T>(fn: () => Promise<T>) => withEnv({ CODEMAP_AGENT_MODEL: undefined }, fn);

/** A repo whose universe is its directory's name, pointed at `side`. */
async function repo(side: string, name: string) {
  const root = mkdtempSync(join(tmpdir(), `codemap-ws-${name}-`));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: root });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "alice@x.com");
  git("config", "user.name", "alice");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, state);
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  const finding = await asAgent(async () =>
    ((await shareFinding(root, 7, { targetKind: "anchor", targetId: anchors[0]!.id, text: `${name}: creditLine doubles` })) as { id: string }).id);
  const resolved = await resolveDecisionIssue(root, { kind: "finding", universe: universeKey(root), id: finding, review: 7 });
  assert.ok(resolved.ok, JSON.stringify(resolved));
  return { root, finding, ref: resolved.ref as CanonicalIssueReference };
}

test("a round in the workspace scope unblocks a finding in each of two universes", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-side-"));
  const api = await repo(side, "api"), settlement = await repo(side, "settlement");
  try {
    assert.notEqual(api.ref.universe, settlement.ref.universe, "precondition: two universes on one sidecar");
    const question = `D1: are ${api.finding} and ${settlement.finding} real defects?`;
    const posted = await asAgent(() => postRound(api.root, { round: { id: "R1", source: "cross-repo review" }, decisions: [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question, options: [{ label: "Real, fix both" }, { label: "Neither" }] },
      options: [
        { label: "Real, fix both", effects: [{ findings: [], issues: [api.ref, settlement.ref], on: "unblock" }] },
        { label: "Neither", effects: [{ findings: [], issues: [api.ref, settlement.ref], on: "settle", as: "refuted" }] },
      ],
    }] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.ok((await readScope(side, DECISIONS_SCOPE)).some((e) => e.kind === "decision.round.posted"), "posted in the workspace's scope");

    for (const u of [api, settlement])
      assert.equal((await decisionsView(u.root)).issueWork(u.ref).allowed, false, `${u.ref.universe}: held until answered`);
    const answered = await asPerson(() => answerDirect(settlement.root, { decision: "d1", option: "Real, fix both" })) as any;
    assert.equal(answered.recorded, true, JSON.stringify(answered));
    for (const u of [api, settlement]) {
      const work = (await decisionsView(u.root)).issueWork(u.ref);
      assert.equal(work.allowed, true, `${u.ref.universe}: ${JSON.stringify(work)}`);
    }
  } finally { discard(api.root); discard(settlement.root); discard(side); }
});

test("a sidecar holding only legacy decisions/<u> rounds folds to the same projection as before the workspace scope", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-legacy-side-"));
  const api = await repo(side, "api");
  try {
    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    const legacy = decisionScope(b.cfg.universe);
    const round = await postRoundEvent(b.cfg.path, legacy, b.actor, { id: "R1", source: "before the split", universe: b.cfg.universe }, [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: `D1: is ${api.finding} real?`, options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: [api.finding], on: "unblock" }] },
        { label: "No", effects: [{ findings: [api.finding], on: "settle", as: "refuted" }] }],
    }]);
    assert.ok(!("error" in round), JSON.stringify(round));
    const d = foldDecisions(await readScope(side, legacy)).decisions[0]!;
    await asPerson(async () => {
      const person = bindDecisions(api.root);
      assert.ok(!("error" in person));
      const a = await recordAnswerEvent(person.cfg.path, legacy, person.actor, { decision: d.id, hash: d.hash, via: { kind: "direct", option: "Yes" } });
      assert.ok(!("error" in a), JSON.stringify(a));
    });
    // The fold of the legacy scope alone is what every build before the split served.
    const before = foldDecisions(await readScope(side, legacy));
    assert.equal(before.decisions[0]!.answers.length, 1, "precondition: the answer folded");
    assert.equal(stable((await decisionsView(api.root)).s), stable(before));
  } finally { discard(api.root); discard(side); }
});

test("absent is not empty, over every decisions scope: another universe's legacy log is folded, and a store with rows keeps them when none is on disk", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-absent-side-"));
  const api = await repo(side, "api"), settlement = await repo(side, "settlement");
  try {
    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    const legacy = decisionScope(b.cfg.universe);
    const round = await postRoundEvent(b.cfg.path, legacy, b.actor, { id: "R1", source: "api only", universe: b.cfg.universe }, [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: `D1: is ${api.finding} real?`, options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: [api.finding], on: "unblock" }] },
        { label: "No", effects: [{ findings: [api.finding], on: "settle", as: "refuted" }] }],
    }]);
    assert.ok(!("error" in round), JSON.stringify(round));
    assert.ok(!existsSync(join(side, DECISIONS_SCOPE)), "precondition: only the api's legacy log is on disk");

    // The settlement store reads the api's legacy decision, and folding it (as a sync does) does
    // not turn every later read into "the log is missing".
    assert.equal((await decisionsView(settlement.root)).s.decisions.length, 1, "the fold reads every decisions scope");
    const s = bindDecisions(settlement.root);
    assert.ok(!("error" in s));
    await cachedDecisions(settlement.root, s.cfg);
    const after = await decisionsView(settlement.root);
    assert.equal(after.status.status, "complete", JSON.stringify(after.status));

    // The api store has folded the decision; then no decisions scope is on disk at all.
    assert.equal((await decisionsView(api.root)).s.decisions.length, 1);
    rmSync(join(side, "decisions"), { recursive: true, force: true });
    const r = await cachedDecisions(api.root, b.cfg);
    assert.equal(r.status.status, "blocked", "the materializer declines rather than fold nothing");
    const view = await decisionsView(api.root);
    assert.equal(view.status.status, "blocked");
    assert.equal(view.s.decisions.length, 1, "the stored rows are served, never overwritten with empty");
  } finally { discard(api.root); discard(settlement.root); discard(side); }
});
