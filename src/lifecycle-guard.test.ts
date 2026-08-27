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
import { resolveActor, markObservedClient, clearObservedClient, markAgentSession, clearAgentSession, isIndependent, isErrorIndependent, errorProfiles } from "./identity.js";
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

test("fixed-on-default is a claim an AGENT cannot make, and a person can", () => {
  // Teeth beyond tidiness: a linked bug closes on it, so the defect ships while the
  // map says it is gone. But refusing it unconditionally — as the first version did —
  // left the value advertised in four MCP schemas and rendered in the web while being
  // reachable from nowhere, and named an escape hatch that did not exist.
  const fixed = { result: "fixed", files: ["a.ts"], remediation: "fixed-on-default" };
  assert.match(err(checkLifecycle(fixed, { agent: true }))!, /MAINLINE/);
  assert.match(err(checkLifecycle(fixed, { agent: true }))!, /request_human/, "and names a route that exists");
  assert.equal(err(checkLifecycle(fixed, { agent: false })), null,
    "a person CAN establish it — that is what accountability means");
  assert.equal(err(checkLifecycle(fixed)), null, "and the default caller is a person");
  assert.equal(err(checkLifecycle({ result: "fixed", files: ["a.ts"], remediation: "fixed-on-branch" }, { agent: true })), null);
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

test("independence stays CONSERVATIVE across the whole actor space", () => {
  // A differential check against the rule as specified, run exhaustively rather than
  // on hand-picked cases. It exists because a refactor that expressed independence as
  // a profile KEY disagreed with the rule on 160 of 400 pairs — every disagreement
  // over-claiming independence — while all the hand-written cases still passed. A key
  // cannot say "unknown matches anything", and that is the whole conservatism.
  const spec = (a: Actor, b: Actor): boolean => {
    const [va, vb] = [a.via, b.via];
    if (!va !== !vb) return true;                        // a person and an agent
    if (!va && !vb) return a.principal !== b.principal;  // two people
    if (va!.harness && vb!.harness && va!.harness !== vb!.harness) return true;
    if (va!.model && vb!.model && va!.model !== vb!.model) return true;
    return false;                                        // cannot establish a difference
  };
  const actors: Actor[] = [];
  for (const principal of ["izzie@x.com", "sam@x.com"]) {
    actors.push({ principal });
    for (const harness of [undefined, "claude-code", "codex"]) {
      for (const model of [undefined, "opus", "gpt"]) {
        actors.push({ principal, via: { kind: "agent", ...(harness ? { harness } : {}), ...(model ? { model } : {}) } });
      }
    }
  }
  let pairs = 0;
  for (const a of actors) for (const b of actors) {
    pairs++;
    assert.equal(isErrorIndependent(a, b), spec(a, b),
      `disagreed on ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  assert.ok(pairs >= 400, `covered ${pairs} pairs`);

  // The specific class the key-based version got wrong: nothing recorded is not a
  // distinct profile, it is an unanswered question.
  const bare: Actor = { principal: "izzie@x.com", via: { kind: "agent" } };
  const known: Actor = { principal: "izzie@x.com", via: { kind: "agent", model: "opus" } };
  assert.equal(isErrorIndependent(bare, known), false, "it MIGHT be the same agent");
});

test("counting profiles under-claims rather than inventing corroboration", () => {
  const person: Actor = { principal: "izzie@x.com" };
  const claude: Actor = { principal: "izzie@x.com", via: { kind: "agent", harness: "claude-code" } };
  const codex: Actor = { principal: "izzie@x.com", via: { kind: "agent", harness: "codex" } };
  const bare: Actor = { principal: "izzie@x.com", via: { kind: "agent" } };

  assert.equal(errorProfiles([]), 0);
  assert.equal(errorProfiles([claude]), 1);
  assert.equal(errorProfiles([claude, claude]), 1, "the same look twice is one look");
  assert.equal(errorProfiles([claude, codex]), 2, "one person's two vendors");
  assert.equal(errorProfiles([person, claude]), 2, "a person and an agent");
  assert.equal(errorProfiles([claude, bare]), 1, "an unidentifiable agent adds nothing");
  assert.equal(errorProfiles([undefined, claude]), 1, "a legacy row is skipped, not counted");
  assert.equal(errorProfiles([person, claude, codex]), 3);
});
