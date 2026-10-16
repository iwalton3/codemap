/**
 * The generated `docs/rules/` (plan 2026-10-07-ladder-support, phase B): today's format,
 * deterministic, and never written over a repository's committed rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore } from "./store.js";
import type { State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { draftSpec, addOperation } from "./requirements.js";
import { ratifyReviewed } from "./test-approve.js";
import { GENERATED, renderRules, writeRulesProjection } from "./rules-projection.js";
import { acknowledgeDebt, releaseAcknowledgement } from "./acknowledgements.js";
import { listRequirements } from "./requirements.js";
import { GOLDEN_RULES } from "./rules-projection-fixture.js";

const AGENT = { agent: true, model: "claude-opus-5" } as const;
const GOLDEN = "src/testdata/rules-projection";

test("the projection renders a hand-built standard to the golden files, byte for byte", () => {
  const files = renderRules(GOLDEN_RULES);
  assert.deepEqual([...files.keys()].sort(), readdirSync(GOLDEN).sort());
  for (const [name, text] of files) assert.equal(text, readFileSync(join(GOLDEN, name), "utf8"), name);
});

const git = (root: string, ...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });

test("areas whose names slug alike each get a file, named the same way on every run", () => {
  const at = (id: string, section: string) => ({ ...GOLDEN_RULES[1]!, rule: { ...GOLDEN_RULES[1]!.rule, id, title: id, section } });
  const rules = [at("r_b", "Credit-Card"), at("r_a", "Credit Card"), at("r_i", "Index")];
  for (const order of [rules, [...rules].reverse()]) {
    const files = renderRules(order);
    assert.deepEqual([...files.keys()].sort(), ["INDEX.md", "credit-card-2.md", "credit-card.md", "index-2.md"]);
    assert.match(files.get("credit-card.md")!, /# Credit Card\n/);
    assert.match(files.get("credit-card-2.md")!, /# Credit-Card\n/);
    assert.match(files.get("INDEX.md")!, /\| Credit-Card \| 1 \| \[credit-card-2\.md\]\(credit-card-2\.md\) \|/);
  }
});

/** A committed universe with two ratified rules, one of them system-wide. */
async function universe() {
  const root = mkdtempSync(join(tmpdir(), "codemap-rules-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  const src = "export function creditLine(cents) { return cents; }\n";
  writeFileSync(join(root, "src/credit.js"), src, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "fixture");
  await writeStore(root, await indexBlob(src, "src/credit.js"), { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State);
  const sp = await draftSpec(root, { title: "Rules", ...AGENT }) as { id: string };
  for (const [title, section] of [["No title", "System-wide"], ["Currency", "Credit"]]) {
    await addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "r", reversibility: "reversible", title, section,
      statement: `${title} statement.`, provenance: "owner", level: 4, authority: "owner", lapsesWhen: "owner says", ...AGENT,
    });
  }
  const r = await ratifyReviewed(root, sp.id);
  assert.ok(!("error" in r), JSON.stringify(r));
  return root;
}

test("a second write over an unchanged standard writes nothing", async () => {
  const root = await universe();
  const out = mkdtempSync(join(tmpdir(), "codemap-rules-out-"));
  try {
    const first = await writeRulesProjection(root, { out });
    assert.ok("ok" in first);
    assert.deepEqual(first.written.sort(), ["INDEX.md", "credit.md"]);
    assert.match(readFileSync(join(out, "INDEX.md"), "utf8"), /### No title — ratified/);
    const second = await writeRulesProjection(root, { out });
    assert.ok("ok" in second);
    assert.deepEqual(second.written, []);
  } finally { discard(root); discard(out); }
});

test("a rule prints the debts granted against it, and a released one goes", async () => {
  const root = await universe();
  const out = mkdtempSync(join(tmpdir(), "codemap-rules-out-"));
  try {
    const rule = (await listRequirements(root))[0]!;
    const granted = await acknowledgeDebt(root, {
      requirementId: rule.id, rationale: "the bank's sample fails strict totals", priority: "low", revalidateBy: "2027-01-01",
    });
    assert.ok(!("error" in granted), JSON.stringify(granted));
    assert.ok("ok" in await writeRulesProjection(root, { out }));
    const file = readdirSync(out).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    assert.match(file, /Accepted deviations: the bank's sample fails strict totals \(revalidate by 2027-01-01\)/);
    const id = (granted as { acknowledgement: { id: string } }).acknowledgement.id;
    assert.ok(!("error" in await releaseAcknowledgement(root, id, "conformant now", { agent: true, model: "m" })));
    assert.ok("ok" in await writeRulesProjection(root, { out }));
    const after = readdirSync(out).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    assert.doesNotMatch(after, /Accepted deviations/);
  } finally { discard(root); discard(out); }
});

test("a checkout with no store generates nothing, rather than an empty rule set", async () => {
  // A worktree has no `.codemap/` of its own: `codemap rules` there created an empty store and
  // wrote an INDEX.md with no rules — a missing rule set read as "no rules" (dry run, 2026-10-16).
  const { writeRulesProjection: op } = await import("./ops.js");
  const root = mkdtempSync(join(tmpdir(), "codemap-rules-nostore-"));
  try {
    git(root, "init", "-q");
    const r = await op(root, {});
    assert.ok("error" in r, JSON.stringify(r));
    assert.match((r as { error: string }).error, /no codemap store/);
    assert.ok(!existsSync(join(root, ".codemap")), "it must not create a store");
    assert.ok(!existsSync(join(root, "docs")), "it must not write files");
  } finally { discard(root); }
});

test("a .codemap/ with no codemap.db is no store: an empty one, or one holding only a legacy JSON store", async () => {
  // Owner, C1: "Store file exists". A legacy import carries no standard, so it renders "None." too.
  const { writeRulesProjection: op } = await import("./ops.js");
  for (const seed of [[], ["anchors.json", JSON.stringify({ anchors: [] })]]) {
    const root = mkdtempSync(join(tmpdir(), "codemap-rules-nodb-"));
    try {
      git(root, "init", "-q");
      mkdirSync(join(root, ".codemap"));
      if (seed.length) writeFileSync(join(root, ".codemap", seed[0]!), seed[1]!);
      const r = await op(root, {});
      assert.match((r as { error?: string }).error ?? JSON.stringify(r), /no codemap store/, `seeded ${seed[0] ?? "nothing"}`);
      assert.ok(!existsSync(join(root, ".codemap", "codemap.db")), "it must not create a store");
      assert.ok(!existsSync(join(root, "docs")), "it must not write files");
    } finally { discard(root); }
  }
});

test("a tracked docs/rules/ is never written over, and the refusal names the cutover", async () => {
  const root = await universe();
  try {
    mkdirSync(join(root, "docs/rules"), { recursive: true });
    const mine = "# Rules the system must obey\n\nhand-written\n";
    writeFileSync(join(root, "docs/rules/INDEX.md"), mine);
    git(root, "add", "-A"); git(root, "commit", "-qm", "rules");
    const r = await writeRulesProjection(root);
    assert.ok("error" in r && /tracked by git/.test(r.error) && /cut over/.test(r.error), JSON.stringify(r));
    assert.equal(readFileSync(join(root, "docs/rules/INDEX.md"), "utf8"), mine);
    assert.ok(!existsSync(join(root, "docs/rules/credit.md")));
  } finally { discard(root); }
});

test("an automatic write happens only where docs/rules/ is ignored", async () => {
  const root = await universe();
  try {
    for (const when of ["sync", "open"] as const) {
      assert.ok("skipped" in await writeRulesProjection(root, { when }), when);
      assert.ok(!existsSync(join(root, "docs/rules")), `${when} wrote into a tree that has not been cut over`);
    }
    writeFileSync(join(root, ".gitignore"), "docs/rules/\n");
    const r = await writeRulesProjection(root, { when: "sync" });
    assert.ok("ok" in r, JSON.stringify(r));
    assert.ok(existsSync(join(root, "docs/rules/INDEX.md")));
    assert.ok("skipped" in await writeRulesProjection(root, { when: "open" }), "open writes only when it is absent");
  } finally { discard(root); }
});

test("--out never writes into a directory git tracks", async () => {
  const root = await universe();
  try {
    const out = join(root, "docs/notes");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "INDEX.md"), "hand-written\n");
    git(root, "add", "-A"); git(root, "commit", "-qm", "notes");
    const r = await writeRulesProjection(root, { out });
    assert.ok("error" in r && /tracked by git/.test(r.error), JSON.stringify(r));
    assert.equal(readFileSync(join(out, "INDEX.md"), "utf8"), "hand-written\n");
    assert.ok("ok" in await writeRulesProjection(root, { out: join(root, "docs/fresh") }), "an untracked directory inside the repository is fine");
    const link = mkdtempSync(join(tmpdir(), "codemap-rules-link-"));
    try {
      symlinkSync(out, join(link, "to-notes"));
      assert.ok("error" in await writeRulesProjection(root, { out: join(link, "to-notes") }), "through a symlink");
      assert.equal(readFileSync(join(out, "INDEX.md"), "utf8"), "hand-written\n");
    } finally { discard(link); }
    discard(out);
    assert.ok("error" in await writeRulesProjection(root, { out }), "deleted from the working tree is still tracked");
  } finally { discard(root); }
});

test("a write removes the files it generated and nothing else", async () => {
  const root = await universe();
  const out = mkdtempSync(join(tmpdir(), "codemap-rules-out-"));
  try {
    writeFileSync(join(out, "gone-area.md"), `${GENERATED}\n\n# Gone\n`);
    writeFileSync(join(out, "older.md"), "> Generated by codemap from the standard. An earlier header.\n\n# Older\n");
    writeFileSync(join(out, "notes.md"), "# Somebody's notes\n");
    const r = await writeRulesProjection(root, { out });
    assert.ok("ok" in r);
    assert.deepEqual(r.removed.sort(), ["gone-area.md", "older.md"], "an earlier header is still ours");
    assert.ok(existsSync(join(out, "notes.md")));
  } finally { discard(root); discard(out); }
});

test("a sync writes docs/rules/ only once the repository ignores it", async () => {
  const root = await universe();
  const side = mkdtempSync(join(tmpdir(), "codemap-rules-side-"));
  try {
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    const { sharedSync } = await import("./ops-shared.js");
    const first = await sharedSync(root) as Record<string, unknown>;
    assert.ok(!first.error, JSON.stringify(first));
    assert.ok(!existsSync(join(root, "docs/rules")), "a sync wrote into a tree that has not been cut over");
    writeFileSync(join(root, ".gitignore"), "docs/rules/\n");
    const second = await sharedSync(root) as Record<string, unknown>;
    assert.ok((second.rules as { ok?: boolean })?.ok, JSON.stringify(second.rules));
    assert.ok(existsSync(join(root, "docs/rules/INDEX.md")));
  } finally { discard(root); discard(side); }
});
