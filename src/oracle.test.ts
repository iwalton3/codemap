import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { team, who, edit, commit, branch, pushBranch, fetchCode, openPr, settle, cloneMachine, type Team } from "./oracle.js";
import { universeKey } from "./sidecar-config.js";
import { document } from "./ops.js";
import { publishLocalDocs, sharedDocs } from "./ops-shared.js";
import { readAnchorStore } from "./store.js";

const A = "ana@acme.test";
const B = "ben@acme.test";

const withTeam = async (fn: (t: Team) => Promise<void>) => {
  const t = await team([A, B]);
  try { await fn(t); } finally { t.dispose(); }
};

test("a member is a whole universe: code, an index over it, and a sidecar", async () => {
  await withTeam(async (t) => {
    for (const m of t.all) {
      const anchors = await readAnchorStore(m.repo);
      assert.ok(anchors.anchors.length > 0, `${m.actor.principal} indexed the seed`);
      const symbols = anchors.anchors.map((a) => a.symbolPath.join("."));
      assert.ok(symbols.includes("transfer"), "the TypeScript grammar ran");
      assert.ok(symbols.some((s) => s === "settle"), "and the Python one");
      assert.ok(symbols.includes("Acme.Api.Settlement.SettlementService"), "and the C# one");
    }
  });
});

test("the seed really reaches the three C# shapes it exists for", async () => {
  // The CONTROL for the C# half of `SEED`. Each of these is a shape neither other
  // grammar can produce, and each is asserted by its own consequence rather than by
  // the presence of a `.cs` file — a seed that indexed C# into nothing but bare
  // symbol names would satisfy the test above and none of these.
  await withTeam(async (t) => {
    const anchors = (await readAnchorStore(who(t, A).repo)).anchors;

    // 1. OVERLOADS. Two anchors, one symbol path, told apart only by the
    // disambiguator — which is the field an id derivation carries and the reason a
    // signature change moves an id.
    const settle = anchors.filter((a) => a.symbolPath.join(".") === "Acme.Api.Settlement.SettlementService.Settle");
    assert.equal(settle.length, 2, "both overloads are anchored");
    assert.deepEqual(
      settle.map((a) => a.disambiguator).sort(),
      ["(decimal)", "(decimal,string)"],
      "and they are distinguished by their parameter types, not by position",
    );
    assert.equal(new Set(settle.map((a) => a.id)).size, 2, "so they are two ids");

    // 2. NAMESPACES. The declaration is nested under it, so a namespace rename moves
    // ids for symbols whose own text never changed.
    assert.ok(
      settle.every((a) => a.symbolPath[0] === "Acme.Api.Settlement"),
      "the namespace is in the symbol path",
    );

    // 3. PARTIALS ACROSS FILES. One class, two declarations, two ids — because the
    // file is the first field of the digest. A reader must not read them as duplicates.
    const account = anchors.filter((a) => a.symbolPath.join(".") === "Acme.Api.Settlement.LedgerAccount");
    assert.equal(account.length, 2, "each partial declaration is its own anchor");
    assert.equal(new Set(account.map((a) => a.file)).size, 2, "and they are in different files");
    assert.equal(new Set(account.map((a) => a.id)).size, 2, "so they do not collide");
    // Members of BOTH halves are present. This is what the one-file partial case
    // silently loses (`INSERT OR REPLACE` drops one), so it is the assertion that
    // would fail if the seed were ever collapsed into a single file.
    const members = anchors
      .filter((a) => a.symbolPath.slice(0, 2).join(".") === "Acme.Api.Settlement.LedgerAccount" && a.symbolPath.length === 3)
      .map((a) => a.symbolPath[2]).sort();
    assert.deepEqual(members, ["Balance", "Post"], "members from both halves survive");
  });
});

test("every clone resolves to ONE universe key, or nobody ever sees anybody's work", async () => {
  // The failure this guards is silent: different keys mean each person publishes to
  // scopes the others never look in. Every sync succeeds and the team stays empty.
  await withTeam(async (t) => {
    const keys = new Set(t.all.map((m) => universeKey(m.repo)));
    assert.equal(keys.size, 1, `clones disagree about the universe: ${[...keys].join(", ")}`);
  });
});

test("real GitHub remotes resolve to ONE universe from differently-named checkouts", async () => {
  // The harness gives every clone the basename `acme-api` on purpose — a local bare
  // origin is never a GitHub URL, so `universeKey` takes its fallback and the names
  // have to agree. The cost is that the harness would keep passing if slug extraction
  // were completely broken, so the real path needs its own fixture. No clone: this is
  // `git remote get-url origin` and nothing else, which is all `universeKey` reads.
  const root = mkdtempSync(join(tmpdir(), "codemap-slug-"));
  try {
    const remotes = {
      "checkout-one": "https://github.com/Acme/API.git",
      "another-name-entirely": "git@github.com:Acme/API.git",
    };
    const keys = new Set<string>();
    for (const [dir, url] of Object.entries(remotes)) {
      const repo = join(root, dir);
      mkdirSync(repo, { recursive: true });
      spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      spawnSync("git", ["remote", "add", "origin", url], { cwd: repo });
      keys.add(universeKey(repo));
    }
    assert.deepEqual([...keys], ["acme/api"],
      "https and ssh remotes for one repository are one universe, whatever the directory is called");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a doc one person publishes is readable by the other after a sync", async () => {
  await withTeam(async (t) => {
    const a = who(t, A), b = who(t, B);
    const d = await document(a.repo, {
      id: "n_transfer", type: "concept", title: "Transfer",
      summary: "moves money", anchors: ["src/pay.ts#transfer"],
    }) as { error?: string };
    assert.equal(d.error, undefined, `document failed: ${d.error}`);

    const pub = await publishLocalDocs(a.repo) as { publishedNodes?: number; error?: string };
    assert.equal(pub.error, undefined, `publish failed: ${pub.error}`);
    assert.equal(pub.publishedNodes, 1, "one shareable doc");

    // CONTROL — before the sync, B must NOT have it. Without this the test passes on
    // a harness where both people share one store by accident.
    const beforeB = await sharedDocs(b.repo) as { docs: { nodeId: string }[] };
    assert.equal(beforeB.docs.length, 0, "B has not synced yet");

    await settle(t);
    const afterB = await sharedDocs(b.repo) as { docs: { nodeId: string }[] };
    assert.deepEqual(afterB.docs.map((x) => x.nodeId), ["n_transfer"]);
  });
});

test("two clones are two writers, and cloneMachine is what makes them one", async () => {
  // Same-shard concurrency is untestable without the copy: ordinary clones write
  // different shards, so no amount of concurrent writing produces a fork.
  await withTeam(async (t) => {
    const a = who(t, A), b = who(t, B);
    const idOf = (m: { sidecar: string }) => {
      try { return readFileSync(join(m.sidecar, ".git", "codemap-writer"), "utf8").trim(); }
      catch { return null; }
    };
    await document(a.repo, { id: "n_1", type: "concept", title: "One", summary: "s", anchors: ["src/pay.ts#transfer"] });
    await publishLocalDocs(a.repo);
    await document(b.repo, { id: "n_2", type: "concept", title: "Two", summary: "s", anchors: ["src/pay.ts#refund"] });
    await publishLocalDocs(b.repo);
    assert.notEqual(idOf(a), idOf(b), "ordinary clones hold different writer ids");

    cloneMachine(a, b);
    assert.equal(idOf(b), idOf(a), "and after the copy they are one machine");
  });
});

test("the code repo moves: branches, commits, and a synthetic pull ref", async () => {
  await withTeam(async (t) => {
    const a = who(t, A), b = who(t, B);
    branch(a, "feature/pay", { create: true });
    edit(a, { "src/pay.ts": "export function transfer(amount: number, to: string) {\n  return { to, amount };\n}\n" });
    const head = commit(a, "simplify transfer");
    pushBranch(a, "feature/pay");

    // A same-origin PR: the pull ref and the branch point at one sha, which is the
    // mapping that recovers a branch name with no `gh` in the loop.
    assert.equal(openPr(a, 11, { branch: "feature/pay" }), head);

    // A FORK: a head in no branch of this origin, so the number is the only identity.
    branch(a, "detached/work", { create: true });
    edit(a, { "src/ledger.ts": "export class Ledger {\n  post(e: { amount: number }) { return e.amount * 2; }\n}\n" });
    const forkHead = commit(a, "fork work");
    openPr(a, 12, { sha: forkHead });
    branch(a, "main");

    fetchCode(b);
    const ls = spawnSync("git", ["ls-remote", "origin"], { cwd: b.repo, encoding: "utf8" }).stdout;
    assert.match(ls, /refs\/pull\/11\/head/);
    assert.match(ls, /refs\/pull\/12\/head/);
    assert.match(ls, /refs\/heads\/feature\/pay/);
    assert.doesNotMatch(ls, /refs\/heads\/detached\/work/, "the fork's head is in no origin branch");
  });
});
