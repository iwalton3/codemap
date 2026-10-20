/**
 * Decisions are the workspace's (plan 2026-10-19-batch-release-held-sorts, Phase 1): one
 * `law/decisions` per sidecar, folded together with every legacy `decisions/<universe>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { Decision, State } from "./schema.js";
import { shareFinding, bindDecisions } from "./ops-shared.js";
import { postRound, answerDirect, readerBrief } from "./ops/decisions.js";
import { isLogDamage } from "./log-damage.js";
import { cachedDecisions, decisionsView } from "./ops/decision-holds.js";
import { adoptSidecar } from "./ops-shared.js";
import { begin, discard as discardStaged } from "./sync-engine.js";
import { draftSpec, addOperation } from "./requirements.js";
import { operationSignoffReaderBrief } from "./ops/operation-signoff.js";
import { findingReviewMatchesScope, resolveDecisionIssue, resolveWorkspaceIssue, type CanonicalIssueReference } from "./decision-issues.js";
import { DECISIONS_SCOPE, decisionScope, foldDecisions, foldDecisionsReport, heldFindings, postRoundEvent, readDecisionLog, recordAnswerEvent } from "./shared-decisions.js";
import { LINEAR_SHARD, readScope } from "./eventlog.js";
import { universeKey } from "./sidecar-config.js";
import { stable } from "./oracle-properties.js";
import { discard } from "./test-tmp.js";
import { appendUnfolded } from "./test-door.js";
import { findingKeyScope } from "./review-target.js";
import { findingScope } from "./shared-findings.js";

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
async function repo(side: string, name: string, id?: string) {
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
    ((await shareFinding(root, 7, { ...(id ? { id } : {}), targetKind: "anchor", targetId: anchors[0]!.id, text: `${name}: creditLine doubles` })) as { id: string }).id);
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

test("a bare finding id holds only in its round's universe, though two universes' ids coincide", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-collide-side-"));
  const api = await repo(side, "api", "f_collision"), settlement = await repo(side, "settlement", "f_collision");
  try {
    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    const question = (r: string): Decision[] => [{
      id: "d1", round: r, ref: "D1", kind: "options",
      payload: { question: "D1: is f_collision real?", options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: ["f_collision"], on: "unblock" }] },
        { label: "No", effects: [{ findings: ["f_collision"], on: "settle", as: "refuted" }] }],
    }];
    const legacy = await postRoundEvent(b.cfg.path, decisionScope(b.cfg.universe), b.actor, { id: "R1", source: "legacy", universe: b.cfg.universe }, question("R1"));
    assert.ok(!("error" in legacy), JSON.stringify(legacy));
    const workspace = await postRoundEvent(b.cfg.path, DECISIONS_SCOPE, b.actor, { id: "R2", source: "workspace", universe: b.cfg.universe }, question("R2"));
    assert.ok(!("error" in workspace), JSON.stringify(workspace));

    assert.equal((await decisionsView(api.root)).work("f_collision").allowed, false, "precondition: the api's own finding is held");
    const work = (await decisionsView(settlement.root)).work("f_collision");
    assert.equal(work.allowed, true, JSON.stringify(work));
    // What repair verification's `rulingContext` asks, over the same merged log.
    const s = foldDecisions((await readDecisionLog(side)).events);
    assert.equal(heldFindings(s, universeKey(settlement.root), () => true).has("f_collision"), false);
  } finally { discard(api.root); discard(settlement.root); discard(side); }
});

/** An unparseable line ahead of a shard's events: damage, not a torn tail `readShard` skips. */
const damage = (side: string, scope: string) => {
  const file = join(side, scope, LINEAR_SHARD);
  writeFileSync(file, "not json {\n" + readFileSync(file, "utf8"), "utf8");
};

test("a damaged scope another universe's decision reads is refused as unreadable, never folded past", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-damage-side-"));
  const api = await repo(side, "api"), settlement = await repo(side, "settlement");
  try {
    damage(side, settlement.ref.scope);
    const r = await resolveWorkspaceIssue(side, settlement.ref);
    assert.ok(!r.ok && r.reason === "unreadable" && r.error.includes(settlement.ref.scope), JSON.stringify(r));

    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    const legacy = decisionScope(b.cfg.universe);
    const first = await postRoundEvent(b.cfg.path, legacy, b.actor, { id: "R1", source: "api", universe: b.cfg.universe }, [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: `D1: is ${api.finding} real?`, options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: [api.finding], on: "unblock" }] }, { label: "No", effects: [] }],
    }]);
    assert.ok(!("error" in first), JSON.stringify(first));
    damage(side, legacy);
    const s = bindDecisions(settlement.root);
    assert.ok(!("error" in s));
    const next = await postRoundEvent(s.cfg.path, DECISIONS_SCOPE, s.actor, { id: "R2", source: "settlement", universe: s.cfg.universe }, [{
      id: "d2", round: "R2", ref: "D2", kind: "options",
      payload: { question: `D2: is ${settlement.finding} real?`, options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: [settlement.finding], on: "unblock" }] }, { label: "No", effects: [] }],
    }]);
    assert.ok("error" in next && next.error.includes(`${legacy} cannot be read`), JSON.stringify(next));
  } finally { discard(api.root); discard(settlement.root); discard(side); }
});

test("a finding ref whose review contradicts its scope is refused at the op, the door and on read", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-review-side-"));
  const api = await repo(side, "api"), settlement = await repo(side, "settlement");
  try {
    const wrong = { ...settlement.ref, review: "999" } as CanonicalIssueReference;
    assert.ok(settlement.ref.kind === "finding" && settlement.ref.scope.endsWith("/pr-7"), "precondition: a valid scope, review 7");
    const op = await resolveWorkspaceIssue(side, wrong);
    assert.ok(!op.ok && op.reason === "wrong-scope", JSON.stringify(op));
    assert.ok((await resolveWorkspaceIssue(side, settlement.ref)).ok, "the matching ref still resolves");

    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    const round = (issue: CanonicalIssueReference) => ({ publication: 2, round: { id: "R1", source: "x", universe: b.cfg.universe }, decisions: [{
      id: "d1", round: "R1", ref: "D1", kind: "options",
      payload: { question: `D1: is ${issue.id} real?`, options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: [], issues: [issue], on: "unblock" }] }, { label: "No", effects: [] }],
    }] });
    const door = await postRoundEvent(b.cfg.path, DECISIONS_SCOPE, b.actor, round(wrong).round, round(wrong).decisions as Decision[]);
    assert.ok("error" in door, JSON.stringify(door));
    const planted = await appendUnfolded(b.cfg.path, DECISIONS_SCOPE, b.actor, "decision.round.posted", "R1", round(wrong));
    const read = foldDecisionsReport(await readScope(side, DECISIONS_SCOPE));
    assert.ok(read.refused.some((r) => r.id === planted.id), JSON.stringify(read.refused));

    // Every key kind's own scope still matches, so the refusal is the mismatch and not the shape.
    for (const review of ["7", "branch:feat/x", "topic:settlement-rules"])
      assert.ok(findingReviewMatchesScope({ universe: "u", review, scope: findingScope(findingKeyScope({ path: "", universe: "u" }, review)) }), review);
  } finally { discard(api.root); discard(settlement.root); discard(side); }
});

test("a finding ref whose review is spelled unnormalized but resolves to its scope is accepted at the op and on read, and posted canonical", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-spelling-side-"));
  const api = await repo(side, "api"), settlement = await repo(side, "settlement");
  try {
    for (const review of ["#12", " 12"])
      assert.equal(findingReviewMatchesScope({ universe: "acme", review, scope: "findings/acme/pr-12" }), true, review);
    assert.equal(findingReviewMatchesScope({ universe: "acme", review: "999", scope: "findings/acme/pr-12" }), false, "a contradiction is still refused");

    const across = await resolveWorkspaceIssue(side, { ...settlement.ref, review: "#7" } as CanonicalIssueReference);
    assert.ok(across.ok, JSON.stringify(across));
    assert.equal((across.ref as { review: string }).review, "7", "the cross-universe arm returns the canonical ref");

    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    const round = (issue: CanonicalIssueReference, id: string) => ({ publication: 2, round: { id, source: "x", universe: b.cfg.universe }, decisions: [{
      id: "d1", round: id, ref: "D1", kind: "options",
      payload: { question: `D1: is ${issue.id} real?`, options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: [], issues: [issue], on: "unblock" }] }, { label: "No", effects: [] }],
    }] });
    // What an older build could have pushed: the fold must take it, or every upgraded clone locks.
    const planted = await appendUnfolded(b.cfg.path, decisionScope(b.cfg.universe), b.actor, "decision.round.posted", "R0",
      round({ ...api.ref, review: "#7" } as CanonicalIssueReference, "R0"));
    const read = foldDecisionsReport(await readScope(side, decisionScope(b.cfg.universe)));
    assert.ok(!read.refused.some((r) => r.id === planted.id), JSON.stringify(read.refused));

    const posted = await asAgent(() => postRound(api.root, { round: { id: "R1", source: "x" }, decisions: round({ ...settlement.ref, review: "#7" } as CanonicalIssueReference, "R1").decisions as Decision[] })) as any;
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const ev = (await readScope(side, DECISIONS_SCOPE)).find((e) => e.kind === "decision.round.posted")!;
    assert.equal((ev.data as any).decisions[0].options[0].effects[0].issues[0].review, "7", "the log holds the canonical ref");
  } finally { discard(api.root); discard(settlement.root); discard(side); }
});

/** An api store that has folded its own legacy round and settlement's: two decisions scopes read. */
async function twoScopes(name: string) {
  const side = mkdtempSync(join(tmpdir(), `codemap-ws-${name}-side-`));
  const api = await repo(side, "api"), settlement = await repo(side, "settlement");
  const b = bindDecisions(api.root), s = bindDecisions(settlement.root);
  assert.ok(!("error" in b) && !("error" in s));
  const round = (universe: string, finding: string, id: string): [any, Decision[]] => [{ id, source: "x", universe }, [{
    id: "d1", round: id, ref: "D1", kind: "options",
    payload: { question: `D1: is ${finding} real?`, options: [{ label: "Yes" }, { label: "No" }] },
    options: [{ label: "Yes", effects: [{ findings: [finding], on: "unblock" }] }, { label: "No", effects: [] }],
  }]];
  assert.ok(!("error" in await postRoundEvent(b.cfg.path, decisionScope(b.cfg.universe), b.actor, ...round(b.cfg.universe, api.finding, "R1"))));
  assert.ok(!("error" in await postRoundEvent(s.cfg.path, decisionScope(s.cfg.universe), s.actor, ...round(s.cfg.universe, settlement.finding, "R2"))));
  assert.equal((await decisionsView(api.root)).s.decisions.length, 2, "precondition: folded both");
  return { side, api, settlement, b, s,
    cleanup: () => { discard(api.root); discard(settlement.root); discard(side); } };
}

test("absent is not empty, per scope: this universe's own decisions log vanishing while another's is present blocks and keeps the rows", async () => {
  const w = await twoScopes("own-absent");
  try {
    rmSync(join(w.side, decisionScope(w.b.cfg.universe), LINEAR_SHARD));
    assert.ok(existsSync(join(w.side, decisionScope(w.s.cfg.universe))), "precondition: the other universe's scope is present");
    const r = await cachedDecisions(w.api.root, w.b.cfg);
    assert.equal(r.status.status, "blocked", JSON.stringify(r.status));
    assert.match(r.status.diagnostic?.detail ?? "", new RegExp(decisionScope(w.b.cfg.universe)));
    assert.equal(r.value.decisions.length, 2, "the stored rows are served, never overwritten");

    // Every op reading decisions authority fresh asks the same guard (`decisionsAbsence`).
    const spec = await asAgent(() => draftSpec(w.api.root, { title: "Credit approval" }));
    assert.ok("id" in spec, JSON.stringify(spec));
    const op = await asAgent(() => addOperation(w.api.root, { specId: spec.id, kind: "add_requirement", title: "Credit bound", section: "Credit",
      statement: "Bound credit.", provenance: "Owner", rationale: "Exposure", reversibility: "reversible" }));
    assert.ok("operation" in op, JSON.stringify(op));
    const signoff = await asAgent(() => operationSignoffReaderBrief(w.api.root, { operationId: op.id, answerId: "a_any" })) as { error?: string };
    assert.match(String(signoff.error), /the answer scope is blocked/);
  } finally { w.cleanup(); }
});

test("adopting a sidecar forgets which decisions scopes the old one had", async () => {
  const w = await twoScopes("adopt");
  const other = mkdtempSync(join(tmpdir(), "codemap-ws-adopt-other-"));
  try {
    const { ensureSidecar, sync } = await import("./sidecar.js");
    assert.ok(!("error" in await ensureSidecar(other, { principal: "dana@x.com" })));
    assert.ok(!("error" in await sync(other, { principal: "dana@x.com" }, "dana's team")));
    writeFileSync(join(w.api.root, ".codemap", "sidecar"), other, "utf8");
    const adopted = await asPerson(() => adoptSidecar(w.api.root)) as { error?: string };
    assert.equal(adopted.error, undefined, JSON.stringify(adopted));
    const r = await cachedDecisions(w.api.root, { path: other, universe: w.b.cfg.universe });
    assert.equal(r.status.status, "complete", JSON.stringify(r.status));
  } finally { w.cleanup(); discard(other); }
});

test("a staged decisions act that is dropped leaves no scope recorded as read", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-staged-side-"));
  const api = await repo(side, "api");
  try {
    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    begin(b.cfg.path);
    try {
      const staged = await postRoundEvent(b.cfg.path, DECISIONS_SCOPE, b.actor, { id: "R1", source: "x", universe: b.cfg.universe }, [{
        id: "d1", round: "R1", ref: "D1", kind: "options",
        payload: { question: `D1: is ${api.finding} real?`, options: [{ label: "Yes" }, { label: "No" }] },
        options: [{ label: "Yes", effects: [{ findings: [api.finding], on: "unblock" }] }, { label: "No", effects: [] }],
      }]);
      assert.ok(!("error" in staged), JSON.stringify(staged));
      assert.equal((await decisionsView(api.root)).s.decisions.length, 1, "precondition: the overlay read sees the staged round");
      assert.ok(!existsSync(join(side, DECISIONS_SCOPE, LINEAR_SHARD)), "precondition: staged, not on the log");
    } finally { discardStaged(b.cfg.path); }
    const r = await cachedDecisions(api.root, b.cfg);
    assert.equal(r.status.status, "complete", JSON.stringify(r.status));
  } finally { discard(api.root); discard(side); }
});

test("every production reader of the merged decisions log asks the absence guard first", () => {
  const sites: string[] = [];
  for (const dir of ["src", "src/ops"]) for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "shared-decisions.ts") continue;
    const text = readFileSync(join(dir, f), "utf8");
    const reads = text.match(/readDecisionLog\(/g)?.length ?? 0;
    if (!reads) continue;
    sites.push(`${dir}/${f}`);
    assert.equal(text.match(/decisionsAbsence\(/g)?.length ?? 0, reads, `${dir}/${f}: one guard per read`);
  }
  // A new reader fails here first: it is guarded, or the list says why not.
  assert.deepEqual(sites.sort(), ["src/ops/operation-signoff.ts", "src/ops/repair-verification.ts", "src/ops/ruling-application.ts"]);
});

test("a reading on a workspace question cannot bind onto a legacy decision: refused at the op and on read, by the same-round rule", async () => {
  const side = mkdtempSync(join(tmpdir(), "codemap-ws-reading-side-"));
  const api = await repo(side, "api");
  try {
    const b = bindDecisions(api.root);
    assert.ok(!("error" in b));
    const question = (r: string): Decision[] => [{
      id: "d1", round: r, ref: "D1", kind: "options",
      payload: { question: `D1: is ${api.finding} real?`, options: [{ label: "Yes" }, { label: "No" }] },
      options: [{ label: "Yes", effects: [{ findings: [api.finding], on: "unblock" }] }, { label: "No", effects: [] }],
    }];
    assert.ok(!("error" in await postRoundEvent(b.cfg.path, decisionScope(b.cfg.universe), b.actor, { id: "RL", source: "legacy", universe: b.cfg.universe }, question("RL"))));
    assert.ok(!("error" in await postRoundEvent(b.cfg.path, DECISIONS_SCOPE, b.actor, { id: "RW", source: "workspace", universe: b.cfg.universe }, question("RW"))));
    const s = foldDecisions((await readDecisionLog(side)).events);
    const roundOf = (label: string) => s.rounds.find((r) => r.label === label)!.id;
    const legacy = s.decisions.find((d) => d.round === roundOf("RL"))!, workspace = s.decisions.find((d) => d.round === roundOf("RW"))!;
    const words = await asPerson(async () => {
      const p = bindDecisions(api.root);
      assert.ok(!("error" in p));
      return recordAnswerEvent(p.cfg.path, DECISIONS_SCOPE, p.actor, { decision: workspace.id, hash: workspace.hash, via: { kind: "direct", words: "yes, and the legacy one too" } });
    });
    assert.ok(!("error" in words), JSON.stringify(words));
    const answer = foldDecisions((await readDecisionLog(side)).events).decisions.find((d) => d.id === workspace.id)!.answers[0]!.id;
    const across = [{ decision: legacy.id, option: "Yes" }];

    const op = await asAgent(() => readerBrief(api.root, { answer, maps: across })) as { error?: string };
    assert.match(String(op.error), /not a question in round/);

    const planted = await appendUnfolded(b.cfg.path, DECISIONS_SCOPE, b.actor, "decision.reading.recorded", answer, {
      answer, session: { maps: across },
      reader: { agent: "aPLANTED00000001", verdict: across, launchedAt: new Date(Date.now() + 60_000).toISOString(), brief: "a brief", verified: { session: "s", toolUseId: "t" } },
    });
    const events = (await readDecisionLog(side)).events;
    // On the WHY: without the same-round rule a later check (its brief) still refuses it.
    const refused = foldDecisionsReport(events).refused.find((r) => r.id === planted.id);
    assert.match(refused?.why ?? "", /not a question in round/, JSON.stringify(refused));
    assert.throws(() => foldDecisions(events), (e: unknown) => isLogDamage(e) && e.entry.id === planted.id);
  } finally { discard(api.root); discard(side); }
});
