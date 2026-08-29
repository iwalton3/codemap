/**
 * Provisional audits as commit-discovered documents.
 *
 * The hole these cover: a branch finding used to stay on the machine that took it, so the
 * teammate reviewing that branch could not see it and only its author could ever promote
 * it. It now travels as a document under the commit it was taken at, which nothing folds —
 * see `provisional.ts` and `docs/cross-universe-standard.md`.
 *
 * The two-machine half is in `oracle-standard.test.ts`; these are the local mechanics and
 * the refusals, which need one root and a sidecar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { indexBlob } from "./repo.js";
import { writeStore, readAudits } from "./store.js";
import type { Audit, State } from "./schema.js";
import { discard } from "./test-tmp.js";
import { resolveSidecar } from "./sidecar-config.js";
import { readScope } from "./eventlog.js";
import { standardScope } from "./shared-standard.js";
import { draftSpec, addOperation, ratifySpec, listRequirements } from "./requirements.js";
import {
  recordAudit, provisionalAudits, promotableAudits, promoteProvisionalAudit, conformance, silenced,
} from "./audits.js";
import { readProvisionalAudits, PROVISIONAL_DIR } from "./provisional.js";

const state: State = { schemaVersion: 1, lastVerifiedCommit: null, branch: null } as State;
const SRC = "export function creditLine(cents) { return cents * 2; }\n";

const git = (root: string, ...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
const head = (root: string) => git(root, "rev-parse", "HEAD").stdout.trim();

const ok = <T>(r: T): Exclude<T, { error: string }> => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `unexpected error: ${(r as any)?.error}`);
  return r as Exclude<T, { error: string }>;
};

/** A store on `main`, a rule to audit, code to audit it against, and a sidecar. */
async function fixture(opts: { sidecar?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codemap-prov-"));
  const side = mkdtempSync(join(tmpdir(), "codemap-prov-side-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/credit.js"), SRC, "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  if (opts.sidecar !== false) writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  const indexed = await indexBlob(SRC, "src/credit.js");
  await writeStore(root, indexed, state);

  const sp = ok(await draftSpec(root, { title: "Credit currency policy" }));
  ok(await addOperation(root, {
    specId: sp.id, kind: "add_requirement", rationale: "x", reversibility: "reversible",
    title: "Credit line currency", section: "Credit/Limits",
    statement: "All credit lines are in USD.", provenance: "credit policy §4",
  }));
  ok(await ratifySpec(root, sp.id));
  return {
    root, side, anchors: indexed.map((a) => a.id), specId: sp.id,
    rule: (await listRequirements(root))[0]!,
    cleanup: () => { discard(root); discard(side); },
  };
}

/** Where the documents for this universe land. */
const docDir = (root: string, side: string) =>
  join(side, PROVISIONAL_DIR, ...resolveSidecar(root)!.universe.split("/"));

const events = async (root: string, side: string) =>
  readScope(side, standardScope(resolveSidecar(root)!.universe));

test("a provisional audit travels as a document under its commit, and enters no log", async () => {
  const f = await fixture();
  try {
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const commit = head(f.root);
    const found = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    assert.equal(found.audit.provisional, true, "the fixture must actually be provisional");
    assert.equal(found.notShared, undefined, "it went somewhere, so there is nothing to explain");

    // The document exists, keyed the way a reviewer would ask for it.
    const file = join(docDir(f.root, f.side), commit, found.id + ".json");
    assert.ok(existsSync(file), `expected a document at ${file}`);

    // And nothing about it is in the log — which is what makes it structurally unable to
    // reach any clone's `conformance()`, rather than filtered out of it.
    assert.deepEqual((await events(f.root, f.side)).map((e) => e.kind), [],
      "a branch observation is not an event");
    assert.equal((await readAudits(f.root))[0]!.origin, undefined, "a local row, not a folded one");

    // Read back through the reader a teammate would use.
    const back = await readProvisionalAudits(f.root, { commit });
    assert.equal(back.length, 1);
    assert.equal(back[0]!.id, found.id);
    assert.deepEqual(await readProvisionalAudits(f.root, { commit: "0".repeat(40) }), [],
      "and it is filed under the commit it was taken at, not under all of them");

    // A SHORT sha is what git prints and what a caller will type. An exact match would
    // answer it with an empty list, and "no findings here" reads as "nothing wrong".
    assert.deepEqual((await readProvisionalAudits(f.root, { commit: commit.slice(0, 8) })).map((a) => a.id),
      [found.id], "the reviewer types what git printed");
    assert.deepEqual((await provisionalAudits(f.root, { commit: commit.slice(0, 8) })).map((a) => a.id),
      [found.id], "and the served read agrees with the raw one");
  } finally { f.cleanup(); }
});

test("an audit of a dirty tree does not travel, and the author is told why", async () => {
  const f = await fixture();
  try {
    // On the DEFAULT branch, so dirtiness is the only thing making this provisional. The
    // witnesses come off the filesystem while `commit` names an unchanged HEAD, so filing
    // the document under that commit would attribute uncommitted work to a commit that
    // does not contain it.
    writeFileSync(join(f.root, "src/credit.js"), SRC + "// edited\n", "utf8");
    const found = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    assert.equal(found.audit.provisional, true);
    assert.match(found.notShared ?? "", /dirty/, "silence here is the failure this whole path exists to fix");
    assert.deepEqual(await readProvisionalAudits(f.root), [], "nothing was filed under a commit that is not it");
    assert.equal((await readAudits(f.root)).length, 1, "and the audit is still recorded here");
  } finally { f.cleanup(); }
});

test("no sidecar: the local row is the whole story, and there is nothing to explain", async () => {
  const f = await fixture({ sidecar: false });
  try {
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const found = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    assert.equal(found.audit.provisional, true);
    assert.equal(found.notShared, undefined,
      "a store that never joined a team is not a store with something to report");
    // It is still fully usable here — provisional does not mean second-class, only local.
    assert.equal((await provisionalAudits(f.root)).length, 1);
  } finally { f.cleanup(); }
});

test("a document that cannot be written FAILS the audit rather than quietly staying home", async () => {
  const f = await fixture();
  try {
    // A sidecar that cannot work: the configured path is a file.
    const broken = join(f.root, "src/credit.js");
    writeFileSync(join(f.root, ".codemap", "sidecar"), broken, "utf8");
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const refused = await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    });
    assert.ok("error" in refused, "an author who believes their team can see this must be told otherwise");
    assert.equal((await readAudits(f.root)).length, 0, "and no local row was written");
  } finally { f.cleanup(); }
});

/**
 * A document is written by whatever client its author was running, so the READER is the
 * only end that binds it — the same reason every write gate in this subsystem is repeated
 * in the fold. The one that matters most is `provisional`: without it, a document would be
 * a second route to a `conformant` claim that no fold ever agreed to.
 */
test("the reader binds the writer: a document that does not match its own path is not read", async () => {
  const f = await fixture();
  try {
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const commit = head(f.root);
    const found = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    const dir = join(docDir(f.root, f.side), commit);
    const honest = { ...found.audit } as Audit;
    rmSync(join(dir, found.id + ".json"));

    const forge = (name: string, a: Partial<Audit>) =>
      writeFileSync(join(dir, name), JSON.stringify({ ...honest, ...a }, null, 2), "utf8");

    forge("au_notprovisional.json", { id: "au_notprovisional", provisional: undefined });
    forge("au_othercommit.json", { id: "au_othercommit", commit: "0".repeat(40) });
    forge("au_otheruniverse.json", { id: "au_otheruniverse", universe: "someone/else" });
    forge("au_renamed.json", { id: "au_original" });
    // And the ones about the CLAIM rather than the path. The first is the one that mattered:
    // a conformant audit with no witnesses read `conformant` under `about: "branch"` FOR
    // EVER, because a claim with nothing to compare against can never be superseded.
    forge("au_nowitness.json", {
      id: "au_nowitness", outcome: "conformant", witnesses: [], evidence: {}, finding: "looks fine",
    });
    forge("au_nofinding.json", { id: "au_nofinding", finding: "   " });
    forge("au_noevidence.json", {
      id: "au_noevidence", outcome: "nonconformant", witnesses: [], evidence: {}, finding: "it is broken",
    });
    // Witnesses that do not match the evidence they were supposedly derived from. This is
    // what promotion re-records: it validates the WITNESSES and then re-derives them from
    // `evidence.read`, so a file whose halves disagree promotes to a verdict with nothing
    // under it.
    // Evidence that is real, witnesses that are of something else — so the outcome gates
    // all pass and only the correspondence catches it.
    forge("au_mismatched.json", {
      id: "au_mismatched", outcome: "nonconformant", evidence: { read: [f.anchors[0]!] },
      witnesses: [{ anchorId: "a_somethingelse", bodyHash: "sha256:whatever" }], finding: "it is broken",
    });
    assert.equal(readdirSync(dir).length, 8, "the forgeries must actually be on disk");

    assert.deepEqual(await readProvisionalAudits(f.root, { commit }), [],
      "none of these is a finding about this universe at this commit");
  } finally { f.cleanup(); }
});

test("a teammate's document is promotable, and the promotion is what enters the log", async () => {
  const f = await fixture();
  try {
    // Somebody else's finding, arriving as a document — the state a clone is in after a
    // sync. The local row is removed so that nothing here can be answered from it.
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const commit = head(f.root);
    const found = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    const { db } = await import("./db.js");
    db(f.root).prepare("DELETE FROM audits").run();
    assert.deepEqual(await readAudits(f.root), [], "only the document is left");

    assert.equal((await promotableAudits(f.root)).length, 0, "not while still on the branch");
    git(f.root, "checkout", "-q", "main");
    git(f.root, "merge", "-q", "--no-edit", "feature/credit");

    const promotable = await promotableAudits(f.root);
    assert.equal(promotable.length, 1, "a teammate's finding, on witnesses rather than on ancestry");
    assert.equal(promotable[0]!.id, found.id);

    const before = (await events(f.root, f.side)).length;
    const promoted = ok(await promoteProvisionalAudit(f.root, found.id));
    assert.equal(promoted.audit.provisional, undefined);
    assert.equal(promoted.audit.promotedFrom, found.id);
    assert.ok((await events(f.root, f.side)).length > before, "the promotion is what reaches the team");
    assert.equal((await promotableAudits(f.root)).length, 0, "and it is not promotable twice");

    // The commit-keyed view still holds it: promotion re-records the finding, it does not
    // falsify the branch observation that produced it.
    assert.equal((await provisionalAudits(f.root, { commit })).length, 1);
  } finally { f.cleanup(); }
});

/**
 * Izzie's call, 2026-08-28: a branch finding must not show under the PROJECT's conformance,
 * and must show when somebody asks for an audit of the branch.
 *
 * The default is the team's standard, so `silenced()` means the same number on every
 * machine — which it did not, on the one machine that took the finding.
 */
test("a branch finding moves the branch's conformance and not the codebase's", async () => {
  const f = await fixture();
  try {
    const before = (await conformance(f.root)).map((c) => c.conformance);
    assert.deepEqual(before, ["unknown"], "never audited, and unknown must never read as conformant");

    git(f.root, "checkout", "-q", "-b", "feature/credit");
    ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "conformant",
      finding: "creditLine is USD throughout on this branch", evidence: { read: f.anchors },
    }));

    assert.deepEqual((await conformance(f.root)).map((c) => c.conformance), ["unknown"],
      "a positive audit of somebody's branch must not certify the codebase");
    assert.deepEqual((await conformance(f.root, { about: "branch" })).map((c) => c.conformance),
      ["conformant"], "and the reviewer of that branch has to be able to see it");

    // The distribution follows, which is the number that would otherwise mean two things.
    assert.equal((await silenced(f.root)).conformant, 0);
    assert.equal((await silenced(f.root, { about: "branch" })).conformant, 1);
  } finally { f.cleanup(); }
});

test("a TEAMMATE's branch finding counts toward the branch's conformance too", async () => {
  const f = await fixture();
  try {
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    // Their finding, our checkout: the local row goes, the document stays.
    const { db } = await import("./db.js");
    db(f.root).prepare("DELETE FROM audits").run();

    assert.deepEqual((await conformance(f.root, { about: "branch" })).map((c) => c.lastAudit?.outcome),
      ["nonconformant"], "the witnesses match this checkout, so it is about the code in front of us");
    assert.deepEqual((await conformance(f.root)).map((c) => c.lastAudit), [undefined],
      "and a document reaches the codebase's answer by no route at all");
  } finally { f.cleanup(); }
});

/**
 * `conformance` reads `audits[audits.length - 1]` as the most recent word on a rule, so the
 * merged list has to BE sorted rather than be two sorted lists end to end.
 */
test("the branch view's last audit is the latest one, not the last list it came from", async () => {
  const f = await fixture();
  try {
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const commit = head(f.root);
    // A teammate's document from LAST WEEK, hand-written the way a sync would leave it.
    const old = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "stale finding from last week", evidence: { read: f.anchors },
    }));
    const dir = join(docDir(f.root, f.side), commit);
    const backdated = { ...old.audit, at: "2020-01-01T00:00:00.000Z" };
    writeFileSync(join(dir, old.id + ".json"), JSON.stringify(backdated), "utf8");
    const { db } = await import("./db.js");
    db(f.root).prepare("DELETE FROM audits").run();

    // And this morning's local one.
    const fresh = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "conformant",
      finding: "fixed on this branch", evidence: { read: f.anchors },
    }));

    const [row] = await conformance(f.root, { about: "branch" });
    assert.equal(row!.lastAudit?.id, fresh.id,
      "concatenating two sorted lists is not sorting them — the week-old document sorted last");
  } finally { f.cleanup(); }
});

/**
 * Reliance is one rule with two implementations, and the fold cannot see branch work.
 *
 * `foldStandard` refuses every provisional audit, problem and pin, so `foldReliance` — the
 * fold's half — counts none of them. `relianceOn` read the raw rows and counted all of
 * them, so a withdrawal was refused on this machine citing an audit id that exists on no
 * other clone. The failure is safe (it refuses before appending, so nothing diverges in the
 * log) and it is still the divergence §BOTH_ENDS exists to keep out.
 */
test("a branch finding is not reliance — the fold cannot see one, so neither may the tool", async () => {
  const f = await fixture();
  try {
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const branchFinding = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    assert.equal(branchFinding.audit.provisional, true, "the fixture must be provisional or this is vacuous");
    git(f.root, "checkout", "-q", "main");

    const { relianceOn, withdrawSpec } = await import("./requirements.js");
    const { readOperations } = await import("./store.js");
    assert.deepEqual(
      await relianceOn(f.root, await readOperations(f.root, { specId: f.specId })), [],
      "nothing the team can see relies on this rule",
    );
    const done = await withdrawSpec(f.root, f.specId, { reason: "never adopted" });
    assert.ok(!("error" in done), `withdrawal refused on invisible evidence: ${(done as any).error}`);
  } finally { f.cleanup(); }
});

test("provisionalAudits unions the local row with the document, without doubling it", async () => {
  const f = await fixture();
  try {
    git(f.root, "checkout", "-q", "-b", "feature/credit");
    const commit = head(f.root);
    const found = ok(await recordAudit(f.root, {
      requirementId: f.rule.id, outcome: "nonconformant",
      finding: "creditLine doubles the amount", evidence: { read: f.anchors },
    }));
    // Both places hold it — the author wrote the row AND the document.
    assert.equal((await readAudits(f.root)).length, 1);
    assert.equal((await readProvisionalAudits(f.root)).length, 1);
    const both = await provisionalAudits(f.root, { commit });
    assert.equal(both.length, 1, "one id, minted once, is one finding");
    assert.equal(both[0]!.id, found.id);
    assert.equal(both[0]!.superseded, false);
  } finally { f.cleanup(); }
});
