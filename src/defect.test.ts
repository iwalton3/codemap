import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { reportDefect } from "./ops/defect.js";
import { readFindings, readBugs } from "./store.js";
import { discard } from "./test-tmp.js";

/**
 * One verb, and the CONTEXT decides what the record becomes. What is asserted here is
 * that there is no way to say it wrong: no storage parameter, no entity kind, and a
 * missing or malformed context is refused rather than defaulted.
 */

const repo = async (withSidecar = false) => {
  const root = mkdtempSync(join(tmpdir(), "codemap-def-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-def-side-"));
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...a], { cwd: root });
  git("init", "-q", "-b", "main"); git("config", "user.email", "izzie@x.com"); git("config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c) { return c; }\n", "utf8");
  if (withSidecar) writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  git("add", "-A"); git("commit", "-qm", "seed");
  const { init } = await import("./ops.js");
  await init(root);
  const { readAnchorStore } = await import("./store.js");
  return {
    root, anchor: (await readAnchorStore(root)).anchors[0]!.id,
    cleanup: () => [root, side].forEach((r) => discard(r)),
  };
};

test("a pull-request context files a finding on that pull request", async () => {
  const r = await repo();
  try {
    const out = await reportDefect(r.root, {
      context: { kind: "pull_request", pr: "270" },
      targetKind: "anchor", targetId: r.anchor,
      text: "the evidence", comment: "the ask", severity: "high", category: "Logic",
    }) as Record<string, unknown>;
    assert.equal(out.error, undefined);
    assert.equal(out.filedAs, "finding");

    const [f] = (await readFindings(r.root, { pr: 270 })).findings;
    assert.ok(f, "and it is a row on pr 270, not an annotation");
    assert.equal(f.severity, "high");
    assert.ok(f.witness, "witnessed, so staleness can be detected later");
    assert.equal((await readBugs(r.root)).bugs.length, 0, "a PR finding is not a bug");
  } finally { r.cleanup(); }
});

test("a drive-by context files a bug, and no finding", async () => {
  const r = await repo();
  try {
    const out = await reportDefect(r.root, {
      context: { kind: "drive_by", rationale: "noticed while changing the ledger" },
      title: "transfer does not round", text: "the evidence", anchors: [r.anchor], severity: "medium",
    }) as Record<string, unknown>;
    assert.equal(out.error, undefined);
    assert.equal(out.filedAs, "bug");
    assert.equal((await readBugs(r.root)).bugs.length, 1);
    assert.equal((await readFindings(r.root)).findings.length, 0, "a drive-by is not on a pull request");
  } finally { r.cleanup(); }
});

test("no context is refused, and the message says what to say instead", async () => {
  const r = await repo();
  try {
    const out = await reportDefect(r.root, { text: "something is wrong" } as never) as { error: string };
    assert.match(out.error, /say what you were doing/);
    assert.match(out.error, /pull_request/);
    assert.match(out.error, /drive_by/);
    assert.equal((await readFindings(r.root)).findings.length, 0, "and nothing is written on a guess");
    assert.equal((await readBugs(r.root)).bugs.length, 0);
  } finally { r.cleanup(); }
});

test("a drive-by with no rationale is refused — priority cannot be judged without it", async () => {
  const r = await repo();
  try {
    const out = await reportDefect(r.root, {
      context: { kind: "drive_by", rationale: "  " }, title: "t", text: "e", anchors: [r.anchor],
    } as never) as { error: string };
    assert.match(out.error, /what you were doing/);
    assert.equal((await readBugs(r.root)).bugs.length, 0);
  } finally { r.cleanup(); }
});

test("a pull-request finding needs the submitter-facing version", async () => {
  const r = await repo();
  try {
    const out = await reportDefect(r.root, {
      context: { kind: "pull_request", pr: "270" }, targetKind: "anchor", targetId: r.anchor, text: "evidence only",
    }) as { error: string };
    assert.match(out.error, /needs `comment`/);
    assert.equal((await readFindings(r.root)).findings.length, 0);
  } finally { r.cleanup(); }
});

/**
 * The guardrail is the SHAPE. A caller cannot ask for a bug on a pull request, because
 * the discriminator has no arm that carries both — the honest limit is that it cannot
 * stop a mislabel, only an impossible record.
 */
test("with no sidecar a pull-request finding is still a finding on that pull request", async () => {
  const r = await repo(false);
  try {
    const out = await reportDefect(r.root, {
      context: { kind: "pull_request", pr: "270" },
      targetKind: "anchor", targetId: r.anchor, text: "e", comment: "c",
    }) as Record<string, unknown>;
    assert.equal(out.shared, false, "degraded delivery, said out loud");
    const [f] = (await readFindings(r.root, { pr: 270 })).findings;
    assert.equal(f!.pr, "270", "and never degraded semantics — it still knows its pull request");
    assert.equal(f!.origin, undefined);
  } finally { r.cleanup(); }
});

test("with a sidecar the same call reaches the team", async () => {
  const r = await repo(true);
  try {
    const out = await reportDefect(r.root, {
      context: { kind: "pull_request", pr: "270" },
      targetKind: "anchor", targetId: r.anchor, text: "e", comment: "c", model: "claude-opus-5",
    }) as Record<string, unknown>;
    assert.equal(out.error, undefined);
    const [f] = (await readFindings(r.root, { pr: 270 })).findings;
    assert.ok(f!.origin, "the fold owns it — it is in the log");
    assert.equal(f!.author.via?.model, "claude-opus-5", "and it records which model spoke");
  } finally { r.cleanup(); }
});

// --- one verb per ACT, over both kinds of record ------------------------------

/**
 * Findings and bugs have the same lifecycle acts and had two tools each, so the caller
 * picked the entity type by picking a tool name — the same mistake `report_defect`
 * removed from creation. Dispatch resolves the id against the RECORDS: `f_`, `finding_`
 * and `bug_` come from one generic helper and say nothing about where a row lives.
 */
test("one comment verb reaches a finding or a bug, by id alone", async () => {
  const r = await repo(true);
  try {
    const { reportDefect: file, commentOn } = await import("./ops.js");
    const f = await file(r.root, {
      context: { kind: "pull_request", pr: "270" },
      targetKind: "anchor", targetId: r.anchor, text: "e", comment: "c",
    }) as Record<string, string>;
    const b = await file(r.root, {
      context: { kind: "drive_by", rationale: "unrelated work" },
      title: "a bug", text: "e", anchors: [r.anchor],
    }) as Record<string, string>;
    assert.notEqual(f.id, b.id);

    // No `pr`, no entity kind, no tool choice — just the id.
    assert.equal((await commentOn(r.root, { id: f.id!, body: "on the finding" }) as { error?: string }).error, undefined);
    assert.equal((await commentOn(r.root, { id: b.id!, body: "on the bug" }) as { error?: string }).error, undefined);

    const finding = (await readFindings(r.root, { pr: 270 })).findings[0]!;
    assert.equal(finding.thread.length, 1, "the finding's thread");
    assert.match(finding.thread[0]!.body, /on the finding/);
    assert.match(JSON.stringify((await readBugs(r.root)).bugs[0]), /on the bug/, "and the bug's");
  } finally { r.cleanup(); }
});

test("an id that is neither is refused, not routed to a default", async () => {
  const r = await repo(true);
  try {
    const { commentOn, corroborateOn, requestHuman } = await import("./ops.js");
    for (const call of [
      () => commentOn(r.root, { id: "nope", body: "x" }),
      () => corroborateOn(r.root, { id: "nope", verdict: "confirm" as const, rationale: "x" }),
      () => requestHuman(r.root, { id: "nope", action: "resolve" as const, rationale: "x" }),
    ]) {
      assert.match(String(((await call()) as { error: string }).error), /no finding or bug "nope"/);
    }
  } finally { r.cleanup(); }
});

test("a finding carries its own pull request, so the caller cannot pass the wrong one", async () => {
  const r = await repo(true);
  try {
    const { reportDefect: file, corroborateOn } = await import("./ops.js");
    const f = await file(r.root, {
      context: { kind: "pull_request", pr: "901" },
      targetKind: "anchor", targetId: r.anchor, text: "e", comment: "c",
    }) as Record<string, string>;
    // Nothing here names a pull request. It is read off the record.
    const out = await corroborateOn(r.root, { id: f.id!, verdict: "confirm", rationale: "checked", model: "gpt-5.2" }) as { error?: string };
    assert.equal(out.error, undefined);
    const finding = (await readFindings(r.root, { pr: 901 })).findings[0]!;
    assert.equal(finding.corroboration.length, 1);
    assert.equal(finding.corroboration[0]!.actor.via?.model, "gpt-5.2");
  } finally { r.cleanup(); }
});
