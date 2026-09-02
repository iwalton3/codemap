/**
 * Findings in global search — the one canonical record kind it could not reach.
 *
 * `search` covered anchors, nodes and bugs, so the only ways to find a finding were to
 * already know its pull request or to page a list: a defect somebody reported eight
 * months ago was unfindable by what it says. The backlog is what made that urgent. A
 * finding used to be scoped to a live pull request and read in that context; it can now
 * be live on the trunk for months, which is exactly the kind of thing somebody
 * rediscovers from scratch — and search is how you find out it was already known.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexBlob } from "./repo.js";
import { writeStore, writeLocalFinding } from "./store.js";
import type { State, Actor } from "./schema.js";
import type { SharedFinding } from "./shared-findings.js";
import * as ops from "./ops.js";
import { discard } from "./test-tmp.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) {\n  return cents * 2;\n}\n";
const PERSON: Actor = { principal: "izzie@x.com" };

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...args], { cwd: root, encoding: "utf8" });

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-fsearch-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const anchors = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, anchors, state);
  return { root, id: anchors[0]!.id };
}

const finding = (id: string, over: Partial<SharedFinding> = {}): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_x" }, text: "", comment: "",
  author: PERSON, createdAt: "2026-08-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [], ...over,
} as SharedFinding);

test("a finding is found by what it SAYS, and the hit leads with the description", async () => {
  const { root, id } = await universe();
  try {
    // The two text fields are inverted from what their names suggest: `comment` is the
    // description of the defect, `text` is the running triage narrative. A hit that led
    // with `text` would answer "what is the defect" with the audit trail of what people
    // did about it — the mistake the backlog page shipped once and had to swap.
    await writeLocalFinding(root, finding("f_1", {
      target: { kind: "anchor", id },
      comment: "creditLine doubles the amount instead of adding it",
      text: "RE-TRIAGE 2026-08-21 — verified at head b24dc21e, still reproduces",
    }), 41);

    const byDescription = await ops.search(root, "doubles the amount") as any;
    assert.deepEqual(byDescription.findings.map((f: any) => f.id), ["f_1"]);
    assert.match(byDescription.findings[0]!.summary, /doubles the amount/,
      "the description, not the triage narrative");
    assert.equal(byDescription.findings[0]!.pr, "41", "and which pull request it was filed on");

    // The narrative is matched too — it holds the verification detail, which is how
    // somebody finds the round that already answered their question.
    assert.deepEqual((await ops.search(root, "b24dc21e") as any).findings.map((f: any) => f.id), ["f_1"]);

    // The id, and the TARGET's id, so a finding filed on an anchor is reachable from it.
    assert.deepEqual((await ops.search(root, "f_1") as any).findings.map((f: any) => f.id), ["f_1"]);
    assert.deepEqual((await ops.search(root, id) as any).findings.map((f: any) => f.id), ["f_1"]);

    assert.deepEqual((await ops.search(root, "nothing matches this") as any).findings, []);
  } finally { discard(root); }
});

test("the discussion is searchable, because that is where the reasoning ends up", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_thread", {
      comment: "rounding",
      thread: [{ id: "c1", actor: PERSON, at: "2026-08-02T00:00:00Z", body: "this is the same as the banker's-rounding case" }],
    }), 42);
    assert.deepEqual((await ops.search(root, "banker's-rounding") as any).findings.map((f: any) => f.id), ["f_thread"]);
  } finally { discard(root); }
});

test("a closed finding still matches, sorts last, and says which it is", async () => {
  const { root } = await universe();
  try {
    // "Was this ever reported?" is the question search is for, and a refuted finding is
    // often the best possible answer: somebody already looked, and their reasoning is in
    // the record. Filtering them out would answer "no" to a question whose answer is yes.
    await writeLocalFinding(root, finding("f_open", { comment: "ledger totals disagree" }), 43);
    await writeLocalFinding(root, finding("f_shut", { comment: "ledger rounding drifts", state: "refuted" }), 43);

    const r = await ops.search(root, "ledger") as any;
    assert.deepEqual(r.findings.map((f: any) => f.id), ["f_open", "f_shut"], "open first");
    assert.equal(r.findings[0]!.closed, false);
    assert.equal(r.findings[1]!.closed, true, "and it says so, rather than looking live");
    assert.equal(r.findings[1]!.state, "refuted", "with the verdict, which is the answer");
  } finally { discard(root); }
});

test("a backlogged finding says so in the hit, with its deadline", async () => {
  const { root } = await universe();
  try {
    await writeLocalFinding(root, finding("f_asleep", {
      comment: "settlement retry storm",
      backlogged: { until: "2027-01-31", reason: "slated for replacement", by: PERSON, at: "2026-09-01T00:00:00Z" },
    }), 44);
    await writeLocalFinding(root, finding("f_awake", { comment: "settlement double post" }), 44);

    const r = await ops.search(root, "settlement") as any;
    const asleep = r.findings.find((f: any) => f.id === "f_asleep");
    // Without this it reads as an open finding nobody is working on, which is precisely
    // what the backlog exists to stop a deliberate deferral looking like.
    assert.equal(asleep.backlogged.until, "2027-01-31");
    assert.equal(asleep.backlogged.reason, "slated for replacement");
    // Mutation check: the field is not simply always present.
    assert.equal(r.findings.find((f: any) => f.id === "f_awake").backlogged, undefined);
  } finally { discard(root); }
});

test("findings sit BESIDE the code results, never in front of them", async () => {
  const { root, id } = await universe();
  try {
    await writeLocalFinding(root, finding("f_credit", { target: { kind: "anchor", id }, comment: "creditLine is wrong" }), 45);
    const r = await ops.search(root, "creditLine") as any;
    assert.ok(r.anchors.length, "the symbol itself is still found");
    assert.equal(r.findings.length, 1);
    // Search is primarily how an agent locates a symbol; findings are context. The key
    // order is how that reads over MCP, where the answer is serialized JSON.
    assert.deepEqual(Object.keys(r), ["anchors", "nodes", "bugs", "findings"]);
  } finally { discard(root); }
});

/**
 * Search must MATERIALIZE first, for the reason `findingBacklog` does.
 *
 * The canonical table is a projection. A teammate's finding is in the log the moment
 * their push lands, and a read straight off the table would not see it until some
 * unrelated list happened to fold the scope — which is exactly the finding somebody is
 * most likely to search for. The same defect the bug arm shipped and had to fix.
 */
test("a teammate's finding is found straight from the log, with no list read first", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-fsearch-log-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-fsearch-side-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "one");
    await ops.init(root);

    const { createFinding } = await import("./shared-findings.js");
    const { resolveSidecar } = await import("./sidecar-config.js");
    const cfg = resolveSidecar(root)!;
    await createFinding(cfg.path, `${cfg.universe}/77`, { principal: "mate@x.com" }, {
      targetKind: "anchor", targetId: "a_1",
      text: "filed during the 2026-08 sweep", comment: "the settlement window is off by one",
    });

    // No list read first. That is what used to be doing the materializing.
    const r = await ops.search(root, "off by one") as any;
    assert.equal(r.findings.length, 1, "a finding in the log and not yet in the rows is the one worth finding");
    assert.equal(r.findings[0]!.shared, true, "and the hit says it is the team's, not this machine's");
  } finally { [root, side].forEach(discard); }
});
