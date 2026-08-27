/**
 * Two things that were explained in prose and enforced nowhere.
 *
 * The finding lifecycle states three axes — `result` (what you DID), `remediation`
 * (what HAPPENED to the code), `disposition` (what is TRUE of the claim) — and
 * models conflate them, reporting `fixed` to mean "settled". The comment contract
 * is reliable because it REFUSES; these are the same treatment for the axes.
 *
 * And `via.harness` was a self-report on the one field corroboration depends on:
 * `checked` claims a different session confirmed the doc, and the practice that
 * gives it meaning is one vendor's model checking another's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLifecycle } from "./ops/annotations.js";
import { resolveActor, markObservedClient, clearObservedClient, markAgentSession, clearAgentSession, isIndependent, isErrorIndependent } from "./identity.js";
import type { Actor } from "./schema.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { discard } from "./test-tmp.js";

// ---------------------------------------------------------------------------
// The lifecycle axes
// ---------------------------------------------------------------------------

const err = (r: ReturnType<typeof checkLifecycle>) => ("error" in r ? r.error : null);

test("saying you fixed it means naming what you touched", () => {
  // The mix-up the guard is for: `fixed` used to mean "this finding is settled".
  assert.match(err(checkLifecycle({ result: "fixed" }))!, /files. must name what you touched/);
  assert.match(err(checkLifecycle({ result: "fixed" }))!, /disposition/,
    "and it says where 'settled' actually goes, rather than only refusing");
  assert.equal(err(checkLifecycle({ result: "fixed", files: ["src/pay.ts"] })), null);
});

test("a report that changed no code cannot claim the code was fixed", () => {
  for (const result of ["answered", "declined"]) {
    const e = err(checkLifecycle({ result, remediation: "fixed-on-branch" }));
    assert.ok(e, `${result} + fixed-on-branch must be refused`);
    assert.match(e!, /revise_finding/, "and it names the verb for somebody ELSE's fix");
  }
  // Could this fail? The same pairs without the remediation are fine.
  assert.equal(err(checkLifecycle({ result: "answered" })), null);
  assert.equal(err(checkLifecycle({ result: "declined" })), null);
});

test("a false positive and a fix for it cannot both be true", () => {
  assert.match(err(checkLifecycle({ result: "fixed", files: ["a.ts"], disposition: "refuted" }))!,
    /cannot hold/);
  for (const d of ["confirmed", "partial", "rerated"]) {
    assert.equal(err(checkLifecycle({ result: "fixed", files: ["a.ts"], disposition: d })), null,
      `${d} is a normal pairing with a fix`);
  }
});

test("fixed-on-default is a claim a branch report cannot make", () => {
  // It also has teeth beyond tidiness: a linked bug closes on it, so the defect
  // ships while the map says it is gone.
  assert.match(err(checkLifecycle({ result: "fixed", files: ["a.ts"], remediation: "fixed-on-default" }))!,
    /MAINLINE/);
  assert.equal(err(checkLifecycle({ result: "fixed", files: ["a.ts"], remediation: "fixed-on-branch" })), null);
});

test("an empty report is not a contradiction", () => {
  // The guard must not turn into a required-fields check: `close_finding` has its
  // own required set, and refusing here would move that error to the wrong place.
  assert.equal(err(checkLifecycle({})), null);
  assert.equal(err(checkLifecycle({ disposition: "confirmed" })), null);
  assert.equal(err(checkLifecycle({ remediation: "deferred" })), null);
});

// ---------------------------------------------------------------------------
// Who is on the other end
// ---------------------------------------------------------------------------

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-ident-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  writeFileSync(join(root, "x.txt"), "x\n");
  return root;
};

test("the observed client beats a self-reported harness", () => {
  const root = repo();
  markAgentSession();
  try {
    markObservedClient("Claude Code");
    // A caller naming a different vendor does not get to say so: this is the field
    // "a DIFFERENT session corroborated" is checked against, and the transport saw
    // who actually connected.
    const a = resolveActor(root, { harness: "codex-cli", agent: true })!;
    assert.equal(a.via?.harness, "claude-code", "transport-observed wins");

    // Normalised, because it is COMPARED. "Claude Code" and "claude-code" reading as
    // two harnesses would let one session corroborate itself across a spelling.
    markObservedClient("claude-code");
    assert.equal(resolveActor(root, { agent: true })!.via?.harness, "claude-code");
  } finally { clearObservedClient(); clearAgentSession(); discard(root); }
});

test("with no handshake to observe, the self-report is still used", () => {
  // The CLI has no `initialize`, so this must not become a way to lose attribution.
  const root = repo();
  try {
    clearObservedClient();
    const a = resolveActor(root, { harness: "codex-cli", agent: true })!;
    assert.equal(a.via?.harness, "codex-cli");
  } finally { discard(root); }
});

test("two vendors' clients do not read as the same harness", () => {
  // The whole point: one model finds, another verifies. If both recorded the same
  // harness the corroboration would look independent and not be.
  const root = repo();
  markAgentSession();
  try {
    markObservedClient("claude-code");
    const first = resolveActor(root, { agent: true })!.via?.harness;
    markObservedClient("codex");
    const second = resolveActor(root, { agent: true })!.via?.harness;
    assert.notEqual(first, second);
    assert.deepEqual([first, second], ["claude-code", "codex"]);
  } finally { clearObservedClient(); clearAgentSession(); discard(root); }
});

// ---------------------------------------------------------------------------
// Independence: two different questions, and only one of them can vary here.
// ---------------------------------------------------------------------------

const person = (principal: string): Actor => ({ principal });
const agent = (principal: string, harness?: string, model?: string): Actor =>
  ({ principal, via: { kind: "agent", ...(harness ? { harness } : {}), ...(model ? { model } : {}) } });

test("one person's two vendors are error-independent but not independent", () => {
  // The practice this exists to score, and the reason `independent` alone was not
  // enough: on a team where the reviewer dispatches every agent, it is always false.
  const claude = agent("izzie@x.com", "claude-code");
  const codex = agent("izzie@x.com", "codex");
  assert.equal(isIndependent(claude, codex), false, "same person — no second opinion");
  assert.equal(isErrorIndependent(claude, codex), true, "different vendor — different mistakes");
});

test("the same harness twice is not error-independent, whoever ran it", () => {
  assert.equal(isErrorIndependent(agent("izzie@x.com", "claude-code"), agent("izzie@x.com", "claude-code")), false);
  // And a second PERSON running the same harness is a second opinion but not a
  // second error profile — the two axes genuinely come apart in both directions.
  const other = agent("sam@x.com", "claude-code");
  assert.equal(isIndependent(agent("izzie@x.com", "claude-code"), other), true);
  assert.equal(isErrorIndependent(agent("izzie@x.com", "claude-code"), other), false);
});

test("a self-reported model can only ADD evidence of difference", () => {
  // Harness is transport-observed, model is not. Same harness with differing
  // self-reported models still counts — it is evidence, just weaker.
  assert.equal(isErrorIndependent(
    agent("izzie@x.com", "claude-code", "claude-opus-5"),
    agent("izzie@x.com", "claude-code", "claude-haiku-4-5"),
  ), true);
  // But two agents with nothing recorded are NOT independent: nothing establishes it.
  assert.equal(isErrorIndependent(agent("izzie@x.com"), agent("izzie@x.com")), false);
  assert.equal(isErrorIndependent(agent("izzie@x.com"), agent("sam@x.com")), false,
    "different people, but as AGENTS with unknown models this says nothing");
});

test("a person checking an agent is error-independent", () => {
  assert.equal(isErrorIndependent(person("izzie@x.com"), agent("izzie@x.com", "claude-code")), true);
  assert.equal(isErrorIndependent(person("izzie@x.com"), person("izzie@x.com")), false, "themselves");
  assert.equal(isErrorIndependent(person("izzie@x.com"), person("sam@x.com")), true);
});
