/**
 * The requirement record, and the four things it exists to make impossible.
 *
 * Every assertion here is about a NEGATIVE — no edit path, no agent adoption, no
 * stale state, no leak into the node surface — and a negative is exactly the shape
 * that passes vacuously. So each test first proves the positive case works, then
 * proves the negative one is refused: if the refusal were removed, the second half
 * fails rather than the whole file silently asserting nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, loadNodes, readRequirement } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import {
  proposeRequirement, proposeAmendment, ratifyRequirement, ratifyAmendment,
  rejectAmendment, retireRequirement, listRequirements, getRequirement, pendingAmendments,
  reorganizeRequirement, requirementSections,
} from "./requirements.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents; }\n";

async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-req-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  spawnSync("git", ["config", "user.email", "izzie@x.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "izzie"], { cwd: root });
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  const indexed = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, indexed, state);
  return { root, anchors: indexed.map((a) => a.id) };
}

/** Re-index the same file with a CHANGED body, the way a real edit would. */
async function editCode(root: string, src: string) {
  writeFileSync(join(root, "src/credit.js"), src, "utf8");
  await writeStore(root, await indexBlob(src, "src/credit.js"), state);
}

/**
 * Propose with organization filled in. The tests below are about adoption, drift and
 * refusals; `title`/`section` being REQUIRED has its own tests, so defaulting them here
 * keeps each test about one thing without letting the requirement go unchecked.
 */
const propose = (root: string, over: Record<string, unknown>) =>
  proposeRequirement(root, { title: "Credit line currency", section: "Credit/Limits", ...over } as any);

const ok = <T>(r: T | { error: string }): T => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as T;
};

test("a requirement is proposed by anyone and ratified only by a principal", async () => {
  const { root } = await universe();
  try {
    // An AGENT may author. This half must pass, or the refusal below proves nothing —
    // a module that rejected every write would also "refuse the agent".
    const made = ok(await propose(root, {
      statement: "All credit lines are in USD.",
      provenance: "credit policy §4",
      agent: true, model: "claude-opus-5",
    }));
    assert.equal(made.requirement.status, "proposed");
    assert.ok(made.requirement.author.via, "an agent's authorship records the agent");

    // ...and may NOT adopt.
    const denied = await ratifyRequirement(root, made.id, { agent: true, model: "claude-opus-5" });
    assert.ok("error" in denied, "an agent must not be able to ratify");
    assert.match((denied as any).error, /principal's act/);
    assert.equal((await readRequirement(root, made.id))!.status, "proposed", "a refused ratify changes nothing");

    const done = ok(await ratifyRequirement(root, made.id));
    assert.equal(done.requirement.status, "ratified");
    assert.ok(done.requirement.ratifiedBy && !done.requirement.ratifiedBy.via, "ratification names a person, not an agent");
  } finally { discard(root); }
});

test("provenance is required, because a rule with no source reads as arbitrary", async () => {
  const { root } = await universe();
  try {
    const bad = await propose(root, { statement: "Settlement is idempotent.", provenance: "  " });
    assert.ok("error" in bad);
    assert.match((bad as any).error, /provenance/);
    // The same call WITH provenance succeeds, so the refusal is about the field and
    // not about the statement being rejected for some other reason.
    ok(await propose(root, { statement: "Settlement is idempotent.", provenance: "COD-29" }));
  } finally { discard(root); }
});

test("a requirement may cite nothing, but not something that does not exist", async () => {
  const { root, anchors } = await universe();
  try {
    // Uncited is the "missing gate" case — a requirement the code does not yet satisfy.
    // It is a well-formed record, not a floating claim.
    const uncited = ok(await propose(root, {
      statement: "Every settlement endpoint requires an idempotency key.",
      provenance: "our own past choice",
    }));
    assert.deepEqual(uncited.requirement.cites, []);

    ok(await propose(root, { statement: "USD only.", provenance: "policy", cites: anchors }));

    const bogus = await propose(root, {
      statement: "Nonsense.", provenance: "policy", cites: ["a_does_not_exist"],
    });
    assert.ok("error" in bogus);
    assert.match((bogus as any).error, /unknown anchor/);
  } finally { discard(root); }
});

test("drifted code makes a requirement recheck-due — never stale, and never untrusted", async () => {
  const { root, anchors } = await universe();
  try {
    const made = ok(await propose(root, {
      statement: "All credit lines are in USD.", provenance: "credit policy §4", cites: anchors,
    }));
    ok(await ratifyRequirement(root, made.id));

    // Before the edit: ratified and settled. Asserting this is what makes the flip below
    // evidence — without it, `recheckDue: true` could have been true from the start.
    const before = ok(await getRequirement(root, made.id));
    assert.equal(before.requirement.recheckDue, false);

    await editCode(root, "export function creditLine(cents) { return cents * 2; }\n");

    const after = ok(await getRequirement(root, made.id));
    assert.equal(after.requirement.recheckDue, true, "cited code moved");
    assert.equal(after.requirement.status, "ratified", "drift is evidence about the CODE, not a downgrade of the rule");
    assert.deepEqual(after.requirement.drifted, anchors);
    // The shape a reader is served must not carry anything a doc carries: acquiring one
    // of these is how "update it to match the code" becomes the obvious next move.
    for (const forbidden of ["trust", "state", "stale", "vouch"]) {
      assert.ok(!(forbidden in after.requirement), `a requirement must never be served with \`${forbidden}\``);
    }
  } finally { discard(root); }
});

test("the statement changes only by ratified amendment, and never in place", async () => {
  const { root } = await universe();
  try {
    const made = ok(await propose(root, {
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    ok(await ratifyRequirement(root, made.id));

    const am = ok(await proposeAmendment(root, {
      requirementId: made.id, kind: "requirement-misstated",
      statement: "All credit lines are in USD, except settlement float, held in the tender currency.",
      rationale: "The exception surfaced during a conformance check.",
      agent: true, model: "claude-opus-5",
    }));

    // Proposing does NOT move the live text. This is the whole mechanism.
    assert.equal((await readRequirement(root, made.id))!.statement, "All credit lines are in USD.");

    const denied = await ratifyAmendment(root, am.id, { agent: true, model: "claude-opus-5" });
    assert.ok("error" in denied, "an agent must not be able to adopt its own proposal");
    assert.equal((await readRequirement(root, made.id))!.statement, "All credit lines are in USD.");

    const adopted = ok(await ratifyAmendment(root, am.id));
    assert.equal(adopted.statementChanged, true);
    assert.match((await readRequirement(root, made.id))!.statement, /settlement float/);
  } finally { discard(root); }
});

test("`code-wrong` records that the rule stands, and cannot smuggle new text in", async () => {
  const { root, anchors } = await universe();
  try {
    const made = ok(await propose(root, {
      statement: "All credit lines are in USD.", provenance: "credit policy §4", cites: anchors,
    }));
    ok(await ratifyRequirement(root, made.id));

    const smuggled = await proposeAmendment(root, {
      requirementId: made.id, kind: "code-wrong",
      statement: "Credit lines may be in any currency.",
      rationale: "making the rule agree with what the code does",
    });
    assert.ok("error" in smuggled, "`code-wrong` must not carry a replacement statement");

    const filed = ok(await proposeAmendment(root, {
      requirementId: made.id, kind: "code-wrong",
      rationale: "creditLine doubles the amount; the rule stands.",
    }));
    const adopted = ok(await ratifyAmendment(root, filed.id));
    assert.equal(adopted.statementChanged, false);
    assert.equal((await readRequirement(root, made.id))!.statement, "All credit lines are in USD.");
  } finally { discard(root); }
});

test("retire is principal-only too, so retire-and-recreate is not a way around the gate", async () => {
  const { root } = await universe();
  try {
    const made = ok(await propose(root, { statement: "USD only.", provenance: "policy" }));
    ok(await ratifyRequirement(root, made.id));

    const denied = await retireRequirement(root, made.id, { agent: true, model: "claude-opus-5" });
    assert.ok("error" in denied);
    assert.equal((await readRequirement(root, made.id))!.status, "ratified");

    ok(await retireRequirement(root, made.id));
    assert.equal((await readRequirement(root, made.id))!.status, "retired");

    // And a retired requirement is not an amendment target — otherwise "retire, then
    // amend the corpse" is the edit path by another name.
    const after = await proposeAmendment(root, {
      requirementId: made.id, kind: "requirement-changed",
      statement: "Anything goes.", rationale: "no",
    });
    assert.ok("error" in after);
  } finally { discard(root); }
});

test("requirements do not appear on the node surface", async () => {
  const { root, anchors } = await universe();
  try {
    const made = ok(await propose(root, {
      statement: "All credit lines are in USD.", provenance: "credit policy §4", cites: anchors,
    }));
    ok(await ratifyRequirement(root, made.id));

    // The structural half of "a requirement has no stale state": it cannot acquire one,
    // because the code that computes one is never handed a requirement.
    const nodes = await loadNodes(root);
    assert.equal(nodes.find((n) => n.id === made.id), undefined, "a requirement is not a node");
    assert.equal(nodes.length, 0);

    // And it IS readable through its own surface, so the emptiness above is separation
    // rather than the requirement having failed to be stored at all.
    assert.equal((await listRequirements(root)).length, 1);
  } finally { discard(root); }
});

test("the ratification queue carries the context needed to dispose of a proposal", async () => {
  const { root } = await universe();
  try {
    const made = ok(await propose(root, {
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    ok(await ratifyRequirement(root, made.id));
    const a1 = ok(await proposeAmendment(root, {
      requirementId: made.id, kind: "requirement-misstated",
      statement: "USD, except settlement float.", rationale: "conformance check", evidence: "COD-29",
    }));
    ok(await proposeAmendment(root, {
      requirementId: made.id, kind: "requirement-changed",
      statement: "USD and EUR.", rationale: "new market",
    }));

    const queue = await pendingAmendments(root);
    assert.equal(queue.length, 2);
    const row = queue.find((q) => q.amendment.id === a1.id)!;
    assert.equal(row.requirement.statement, "All credit lines are in USD.", "current text, for the diff");
    assert.equal(row.amendment.statement, "USD, except settlement float.", "proposed text, for the diff");
    assert.equal(row.amendment.evidence, "COD-29", "what provoked it");
    assert.equal(row.alsoPending, 1, "the other proposal against the same rule is visible from here");

    ok(await rejectAmendment(root, a1.id, "float is a separate rule; file it as one"));
    assert.equal((await pendingAmendments(root)).length, 1, "a disposed proposal leaves the queue");
  } finally { discard(root); }
});

test("a requirement needs a title and a section, or the store becomes a heap", async () => {
  const { root } = await universe();
  try {
    for (const [missing, over] of [
      ["title", { title: "  " }],
      ["section", { section: "  /  " }],
    ] as const) {
      const bad = await proposeRequirement(root, {
        title: "Credit line currency", section: "Credit/Limits",
        statement: "All credit lines are in USD.", provenance: "credit policy §4",
        ...over,
      } as any);
      assert.ok("error" in bad, `${missing} must be required`);
      assert.match((bad as any).error, new RegExp(missing));
    }
    // The same call with both present succeeds, so the refusals above are about these
    // two fields and not about the proposal being rejected for some other reason.
    ok(await propose(root, { statement: "All credit lines are in USD.", provenance: "credit policy §4" }));
  } finally { discard(root); }
});

test("sections normalize, and a case-variant of an existing one is refused", async () => {
  const { root } = await universe();
  try {
    // Ragged input files under the normalized path, so spacing cannot fork a section.
    const made = ok(await propose(root, {
      title: "Credit line currency", section: "  Credit / Limits  ",
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
    }));
    assert.equal(made.requirement.section, "Credit/Limits");

    const clash = await propose(root, {
      title: "Credit line ceiling", section: "credit/limits",
      statement: "No credit line exceeds 500k.", provenance: "credit policy §7",
    });
    assert.ok("error" in clash, "a case-variant of an existing section must be refused");
    assert.match((clash as any).error, /only by case/);

    // A genuinely different section is NOT refused — the guard must not be so eager that
    // it stops anyone opening a new one.
    ok(await propose(root, {
      title: "Float currency", section: "Settlement/Float",
      statement: "Settlement float is held in the tender currency.", provenance: "credit policy §9",
    }));
    assert.deepEqual(
      (await requirementSections(root)).map((x) => x.section),
      ["Credit/Limits", "Settlement/Float"],
    );
  } finally { discard(root); }
});

test("re-filing a ratified requirement is a principal's act; fixing your own proposal is not", async () => {
  const { root } = await universe();
  try {
    const mine = ok(await propose(root, {
      statement: "All credit lines are in USD.", provenance: "credit policy §4",
      agent: true, model: "claude-opus-5",
    }));
    // Still proposed, nothing binding: the author may fix their own filing.
    ok(await reorganizeRequirement(root, mine.id, { section: "Credit/Currency" }, { agent: true, model: "claude-opus-5" }));
    assert.equal((await readRequirement(root, mine.id))!.section, "Credit/Currency");

    ok(await ratifyRequirement(root, mine.id));

    // Once binding, retitling is how you make a rule READ differently without touching
    // its statement — so it is gated where the amendment path is gated.
    const denied = await reorganizeRequirement(root, mine.id, { title: "Credit lines may be any currency" }, { agent: true, model: "claude-opus-5" });
    assert.ok("error" in denied);
    assert.equal((await readRequirement(root, mine.id))!.title, "Credit line currency");

    ok(await reorganizeRequirement(root, mine.id, { title: "Credit line currency (USD)" }));
    const after = (await readRequirement(root, mine.id))!;
    assert.equal(after.title, "Credit line currency (USD)");
    assert.equal(after.statement, "All credit lines are in USD.", "re-filing never touches the rule");
  } finally { discard(root); }
});

test("listing narrows to a section and everything under it", async () => {
  const { root } = await universe();
  try {
    for (const [title, section] of [
      ["Credit line currency", "Credit/Limits"],
      ["Credit review cadence", "Credit"],
      ["Float currency", "Settlement/Float"],
    ] as const) {
      ok(await propose(root, { title, section, statement: `${title} rule.`, provenance: "policy" }));
    }
    const credit = await listRequirements(root, { section: "Credit" });
    assert.deepEqual(credit.map((r) => r.section).sort(), ["Credit", "Credit/Limits"]);
    assert.equal((await listRequirements(root)).length, 3);
  } finally { discard(root); }
});
