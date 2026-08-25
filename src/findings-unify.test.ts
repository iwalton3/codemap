/**
 * The one-time unification of local findings onto the sidecar.
 *
 * What is under test is mostly the REPLAY. The fold adopts a local row when it sees an
 * event for the same `(pr, id)`, and adoption replaces the row's body — so a migration
 * that published without re-emitting the history would not preserve it, it would destroy
 * it, silently, on the next sync. Every assertion about a surviving outcome or verdict
 * here is really an assertion that adoption had something to adopt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { unifyFindings, splitState, activationGate, unifiedAt } from "./findings-unify.js";
import { readFinding, writeLocalFinding } from "./store.js";
import * as shared from "./ops-shared.js";
import type { SharedFinding } from "./shared-findings.js";

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-uf-${t}-`));

function universe(withSidecar = true) {
  const root = tmp("repo");
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const side = tmp("side");
  if (withSidecar) writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, side, cleanup: () => [root, side].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

const local = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id,
  target: { kind: "anchor", id: "a_1" },
  text: "the evidence",
  comment: "the submitter-facing ask",
  severity: "high",
  category: "Logic",
  line: 12,
  author: { principal: "agent:pr-first-pass" },
  createdAt: "2026-08-01T00:00:00Z",
  state: "created",
  corroboration: [], thread: [], revisions: [],
  ...over,
});

test("a local finding becomes a shared one, keeping its id", async () => {
  const u = universe();
  try {
    await writeLocalFinding(u.root, local("finding_abc"), 264);
    assert.ok(await splitState(u.root), "the split state is what this exists to end");

    const r = await unifyFindings(u.root) as { published: string[]; refused: unknown[] };
    assert.deepEqual(r.published, ["finding_abc"]);
    assert.deepEqual(r.refused, []);

    const f = (await readFinding(u.root, "finding_abc"))!;
    // The id is PRESERVED: it is on a pull request, in somebody's notes, and in the
    // GitHub comment it was posted as. Minting a new one would strand all three.
    assert.equal(f.id, "finding_abc");
    assert.ok(f.origin, "and the row is the fold's now — one kind of finding");
    assert.equal(await splitState(u.root), null);
    assert.ok(unifiedAt(u.root), "recorded, so `already unified` differs from `never had any`");
  } finally { u.cleanup(); }
});

test("the history survives, because adoption would otherwise replace it with nothing", async () => {
  const u = universe();
  try {
    await writeLocalFinding(u.root, local("finding_hist", {
      state: "resolved",
      closed: { at: "2026-08-10T00:00:00Z", by: { principal: "izzie@x.com" }, reason: "fixed upstream" },
      corroboration: [{
        actor: { principal: "izzie@x.com" }, verdict: "confirm",
        at: "2026-08-02T00:00:00Z", rationale: "read the code", independent: false,
      }],
      thread: [{ id: "c_1", actor: { principal: "izzie@x.com" }, at: "2026-08-03T00:00:00Z", body: "looked again" }],
      outcome: { result: "fixed", detail: "guarded both call sites", files: ["src/pay.ts"], by: { principal: "izzie@x.com" }, at: "2026-08-04T00:00:00Z" },
      posted: { system: "github", key: "1", url: "https://github.com/o/r/pull/264#c1", at: "2026-08-05T00:00:00Z", by: { principal: "izzie@x.com" } },
      remediation: { state: "fixed-on-default", by: { principal: "izzie@x.com" }, at: "2026-08-06T00:00:00Z", detail: "merged" },
    }), 264);

    const r = await unifyFindings(u.root) as { published: string[] };
    assert.deepEqual(r.published, ["finding_hist"]);

    const f = (await readFinding(u.root, "finding_hist"))!;
    assert.ok(f.origin, "folded");
    assert.equal(f.state, "resolved", "a closed finding does not reopen by being published");
    assert.equal(f.corroboration.length, 1);
    assert.equal(f.thread.length, 1);
    assert.equal(f.outcome!.result, "fixed");
    assert.deepEqual(f.outcome!.files, ["src/pay.ts"]);
    assert.equal(f.posted!.url, "https://github.com/o/r/pull/264#c1", "the posted ref is how replies are read back");
    assert.equal(f.remediation!.state, "fixed-on-default");
    assert.equal(f.comment, "the submitter-facing ask");
    assert.equal(f.severity, "high");
    assert.equal(f.line, 12);
  } finally { u.cleanup(); }
});

test("what the local row said about its filer is kept, and not asserted as the truth", async () => {
  const u = universe();
  try {
    // Legacy author strings are not principals — `agent:pr-first-pass`, `human`, `codex`.
    // The event's actor is whoever runs the migration and cannot honestly be anyone else,
    // so the original is carried as the publisher's CLAIM rather than forged into `author`.
    await writeLocalFinding(u.root, local("finding_who"), 264);
    await unifyFindings(u.root);
    const f = (await readFinding(u.root, "finding_who"))!;
    assert.equal(f.author.principal, "izzie@x.com", "the actor is who published it");
    assert.equal(f.filed!.by, "agent:pr-first-pass", "and what the row said is not lost");
    assert.equal(f.filed!.at, "2026-08-01T00:00:00Z", "including when — the event's `at` is now, not then");
  } finally { u.cleanup(); }
});

test("a finding carrying somebody else's verdict is refused, not flattened", async () => {
  const u = universe();
  try {
    // `corroborate` keys on the reviewer, so replaying three people's verdicts as the
    // migrator's would collapse them to one — and "three models confirmed it" would
    // become a lie told by the migration rather than by anyone. Refuse and name it.
    await writeLocalFinding(u.root, local("finding_theirs", {
      corroboration: [{
        actor: { principal: "dana@x.com" }, verdict: "confirm",
        at: "2026-08-02T00:00:00Z", rationale: "she read it", independent: true,
      }],
    }), 264);
    await writeLocalFinding(u.root, local("finding_mine"), 264);

    const r = await unifyFindings(u.root) as { published: string[]; refused: { id: string; reason: string }[]; note: string };
    assert.deepEqual(r.published, ["finding_mine"], "the rest still migrate");
    assert.equal(r.refused.length, 1);
    assert.equal(r.refused[0]!.id, "finding_theirs");
    assert.match(r.refused[0]!.reason, /dana@x\.com/, "and the report names whose verdict it is");

    assert.ok(!(await readFinding(u.root, "finding_theirs"))!.origin, "left exactly as it was");
    // A partial run must NOT mark itself done: the gate stays on over findings the team
    // still cannot see.
    assert.equal(unifiedAt(u.root), null);
    assert.ok(await splitState(u.root));
  } finally { u.cleanup(); }
});

test("a dry run writes nothing and says what it would attribute", async () => {
  const u = universe();
  try {
    await writeLocalFinding(u.root, local("finding_dry"), 264);
    const r = await unifyFindings(u.root, { dryRun: true }) as { published: string[]; note: string };
    assert.deepEqual(r.published, ["finding_dry"]);
    assert.match(r.note, /izzie@x\.com/, "publishing re-attributes, and a count must say so before it happens");
    assert.ok(!(await readFinding(u.root, "finding_dry"))!.origin, "a count must not write");
    assert.equal(unifiedAt(u.root), null);
  } finally { u.cleanup(); }
});

test("the gate is silent without a sidecar — local findings are the ordinary case there", async () => {
  const u = universe(false);
  try {
    await writeLocalFinding(u.root, local("finding_solo"), 264);
    assert.equal(await splitState(u.root), null, "no sidecar, no split — there is nothing to be out of step with");
    assert.equal(await activationGate(u.root), null);
    const r = await unifyFindings(u.root) as { error: string };
    assert.match(r.error, /no sidecar/);
  } finally { u.cleanup(); }
});

test("the shared view reports the split rather than hiding it", async () => {
  const u = universe();
  try {
    await writeLocalFinding(u.root, local("finding_hidden"), 264);
    const before = await shared.sharedFindings(u.root, 264) as { splitStore?: { local: number }; findings: unknown[] };
    // It LISTS them — refusing the read would put the fix behind the surface that
    // reports the problem — but it no longer renders them as if the team could see them.
    assert.equal(before.findings.length, 1);
    assert.equal(before.splitStore!.local, 1);

    await unifyFindings(u.root);
    const after = await shared.sharedFindings(u.root, 264) as { splitStore?: unknown };
    assert.equal(after.splitStore, undefined);
  } finally { u.cleanup(); }
});
