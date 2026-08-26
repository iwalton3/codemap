import { test } from "node:test";
import { testEvent } from "./test-events.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveSidecar, universeKey, scopeFor } from "./sidecar-config.js";
import * as shared from "./ops-shared.js";
import { foldDocs } from "./shared-docs.js";
import { db } from "./db.js";
import { readFindings, readFinding, writeLocalFinding } from "./store.js";
import type { SharedFinding } from "./shared-findings.js";

const git = (root: string, ...args: string[]) =>
  spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

const tmp = (t: string) => mkdtempSync(join(tmpdir(), `codemap-os-${t}-`));

/** A universe with an identity, and a sidecar pointed at by the pointer file. */
function universe(withSidecar = true) {
  const root = tmp("repo");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "izzie@x.com");
  git(root, "config", "user.name", "izzie");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  const side = tmp("side");
  if (withSidecar) writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, side, cleanup: () => [root, side].forEach((r) => rmSync(r, { recursive: true, force: true })) };
}

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
};

const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the ask" };

/** Events in the sidecar's graph scope, so a redundant publish can be caught writing. */
const countGraphEvents = (side: string): number => {
  const dir = join(side, "graph");
  const walk = (d: string): number => readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? walk(join(d, e.name))
      : readFileSync(join(d, e.name), "utf8").split("\n").filter(Boolean).length), 0);
  try { return walk(dir); } catch { return 0; }
};

// --- configuration -----------------------------------------------------------

test("no sidecar configured is a clear message, not a crash", async () => {
  const u = universe(false);
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      // Asserted on an op that genuinely NEEDS one. Reading a pull request's findings
      // no longer does — see the test below.
      const r = await shared.sharedStatus(u.root) as { error: string };
      assert.match(r.error, /no sidecar configured/);
      assert.match(r.error, /Everything else works without one/, "and it must not read as the whole tool being gated");
    });
  } finally { u.cleanup(); }
});

/**
 * "Everything else works without one" has to be true of the findings list too. A store
 * that never joined a team still has its own findings, and refusing to list them was
 * the shared/local split showing through a surface that should not know about it.
 */
test("a pull request's findings list works with no sidecar at all", async () => {
  const u = universe(false);
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      await writeLocalFinding(u.root, localFinding("f_solo", "filed with nobody to share it with"), 264);
      const r = await shared.sharedFindings(u.root, 264) as { total: number; findings: { id: string }[] };
      assert.equal(r.total, 1, "the local finding is listed, not gated behind a sidecar");
      assert.equal(r.findings[0]!.id, "f_solo");
    });
  } finally { u.cleanup(); }
});

test("the pointer file locates the sidecar, and the env var beats it", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      assert.equal(resolveSidecar(u.root)?.path, u.side);
    });
    await withEnv({ CODEMAP_SIDECAR: "/elsewhere" }, async () => {
      assert.equal(resolveSidecar(u.root)?.path, "/elsewhere");
    });
  } finally { u.cleanup(); }
});

test("scopes are universe-qualified — PR 264 exists in more than one repo", () => {
  // And two universes sharing a submodule have byte-identical anchor ids, so an
  // unqualified scope would cross-contaminate exactly the findings hardest to spot.
  const a = { path: "/s", universe: "acme/api" };
  const b = { path: "/s", universe: "acme/settlement" };
  assert.notEqual(scopeFor(a, "pr", 264), scopeFor(b, "pr", 264));
  assert.equal(scopeFor(a, "pr", 264), "acme/api/pr-264");
});

test("a universe key prefers the git remote over whatever it was cloned into", () => {
  const u = universe(false);
  try {
    assert.equal(universeKey(u.root), basename(u.root).toLowerCase(), "no remote: the directory");
    git(u.root, "remote", "add", "origin", "git@github.com:Acme/API.git");
    assert.equal(universeKey(u.root), "acme/api", "with a remote: what two people would agree on");
  } finally { u.cleanup(); }
});

// --- the loop, through the front-end surface ---------------------------------

test("a finding filed through ops is readable through ops", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const r = await shared.shareFinding(u.root, 264, NEW) as { ok: true; id: string };
      assert.ok(r.ok);
      const list = await shared.sharedFindings(u.root, 264) as any;
      assert.equal(list.total, 1);
      assert.equal(list.findings[0].id, r.id);
      assert.equal(list.findings[0].state, "created", "a person's finding");
      assert.equal(list.findings[0].author, "izzie@x.com");
    });
  } finally { u.cleanup(); }
});

test("an agent's finding opens as a proposal, and its model is recorded", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: "claude-opus-5" }, async () => {
      await shared.shareFinding(u.root, 264, NEW);
      const list = await shared.sharedFindings(u.root, 264) as any;
      assert.equal(list.findings[0].state, "issued");
      assert.equal(list.findings[0].authorModel, "claude-opus-5");
    });
  } finally { u.cleanup(); }
});

test("a verdict without a rationale is refused — that is a vote, not a review", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      const r = await shared.shareFinding(u.root, 264, NEW) as { id: string };
      const bad = await shared.corroborateFinding(u.root, 264, r.id, "confirm", "   ") as { error: string };
      assert.match(bad.error, /rationale/);
    });
  } finally { u.cleanup(); }
});

test("the queue holds what needs a person, and drops it once closed", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const { id } = await shared.shareFinding(u.root, 264, NEW) as { id: string };
      let q = await shared.sharedFindings(u.root, 264, { queue: true }) as any;
      assert.equal(q.waitingOnYou, 0, "nothing has been promoted or confirmed yet");

      await shared.promoteFinding(u.root, 264, id);
      q = await shared.sharedFindings(u.root, 264, { queue: true }) as any;
      assert.equal(q.waitingOnYou, 1);
      assert.equal(q.findings[0].needsAck, true);

      await shared.closeFinding(u.root, 264, id, "resolved", "fixed in abc123");
      q = await shared.sharedFindings(u.root, 264, { queue: true }) as any;
      assert.equal(q.waitingOnYou, 0);
    });
  } finally { u.cleanup(); }
});

test("an agent asks rather than closing, and the ask carries its rationale", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const { id } = await shared.shareFinding(u.root, 264, NEW) as { id: string };
      await withEnv({ CODEMAP_AGENT_MODEL: "claude-opus-5" }, async () => {
        // Closing IS the ask now: the agent states its conclusion once, in the verb it
        // reached for, and the rationale it gave becomes the ask's. Making it call a
        // second tool is what sent it to prose instead.
        const asked = await shared.closeFinding(u.root, 264, id, "resolved", "the guard was added in abc123") as
          { asked?: string; error?: string };
        assert.equal(asked.error, undefined);
        assert.equal(asked.asked, "resolve");
      });
      const list = await shared.sharedFindings(u.root, 264, { queue: true }) as any;
      assert.equal(list.findings[0].pending.ask, "resolve");
      assert.match(list.findings[0].pending.rationale, /abc123/);
    });
  } finally { u.cleanup(); }
});

test("independent confirmations are counted separately from self-agreement", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const { id } = await shared.shareFinding(u.root, 264, NEW) as { id: string };
      // izzie's own agent agreeing with izzie is not a second opinion.
      await withEnv({ CODEMAP_AGENT_MODEL: "claude-opus-5" }, async () => {
        await shared.corroborateFinding(u.root, 264, id, "confirm", "looks right to me");
      });
      const list = await shared.sharedFindings(u.root, 264) as any;
      assert.equal(list.findings[0].confirms, 1);
      assert.equal(list.findings[0].independentConfirms, 0, "same principal");
    });
  } finally { u.cleanup(); }
});

test("peers reports who is on the sidecar and what they write under", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      await shared.shareFinding(u.root, 264, NEW);
      await shared.sharedSync(u.root);
      const s = await shared.sharedStatus(u.root) as any;
      assert.equal(s.you, "izzie@x.com");
      assert.deepEqual(s.peers.map((p: any) => p.principal), ["izzie@x.com"]);
      assert.equal(s.blocked, undefined);
    });
  } finally { u.cleanup(); }
});

test("sync with no remote is a successful no-op, not an error", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      await shared.shareFinding(u.root, 264, NEW);
      const r = await shared.sharedSync(u.root) as any;
      assert.ok(!r.error, JSON.stringify(r));
      assert.equal(r.pushed, false, "nowhere to push, and that is fine");
    });
  } finally { u.cleanup(); }
});

test("the workspace manifest configures the sidecar for every universe under it", async () => {
  // Where it belongs for a team: one repo serves them all, and the manifest is
  // already the thing that knows which universes there are.
  const ws = tmp("ws");
  const side = join(ws, "review-state");
  mkdirSync(join(ws, "api"), { recursive: true });
  writeFileSync(join(ws, "codemap.workspace.json"), JSON.stringify({
    universes: [{ id: "api", path: "api", primary: true }],
    sidecar: "review-state",
  }), "utf8");
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      assert.equal(resolveSidecar(join(ws, "api"))?.path, side, "found by walking up to the manifest");
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a pointer file beats the workspace, and the env beats both", async () => {
  const ws = tmp("ws2");
  mkdirSync(join(ws, "api", ".codemap"), { recursive: true });
  writeFileSync(join(ws, "codemap.workspace.json"), JSON.stringify({ universes: [{ id: "api", path: "api" }], sidecar: "/from-workspace" }), "utf8");
  writeFileSync(join(ws, "api", ".codemap", "sidecar"), "/from-pointer", "utf8");
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      assert.equal(resolveSidecar(join(ws, "api"))?.path, "/from-pointer");
    });
    await withEnv({ CODEMAP_SIDECAR: "/from-env" }, async () => {
      assert.equal(resolveSidecar(join(ws, "api"))?.path, "/from-env");
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a workspace with no sidecar field configures nothing", async () => {
  const ws = tmp("ws3");
  mkdirSync(join(ws, "api"), { recursive: true });
  writeFileSync(join(ws, "codemap.workspace.json"), JSON.stringify({ universes: [{ id: "api", path: "api" }] }), "utf8");
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      assert.equal(resolveSidecar(join(ws, "api")), null);
    });
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

/**
 * Applying a relocation is the one place a FOREIGN anchor id is written INTO shared
 * state: `f.target.id` becomes whatever the proposer's machine minted. Anchor ids
 * are derived from the parse, so their `a_X` and ours can name different symbols —
 * and everywhere else in this design such an id is read and answered "cannot tell",
 * which is not enough here because the write outlives the reader.
 *
 * So the applier checks it against their own index first. See
 * docs/anchor-id-provenance.md §4.
 */
test("an applied relocation must name an anchor THIS checkout has", async () => {
  const u = universe();
  try {
    const { init, document: documentNode } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const here = (await readAnchorStore(u.root)).anchors[0]!.id;

    const filed = await shared.shareFinding(u.root, 264, {
      targetKind: "anchor", targetId: here, text: "evidence", comment: "the ask",
    } as never) as { id?: string; error?: string };
    assert.ok(filed.id, JSON.stringify(filed));

    const foreign = await shared.relocateFinding(u.root, 264, filed.id, "moved", "their build spells it differently",
      { to: "a_deadbeefdeadbeef", apply: true }) as { error?: string };
    assert.match(foreign.error ?? "", /not an anchor in this checkout/,
      "a bare foreign id must not become the target");

    // The control: a real local anchor still applies, and a PROPOSAL is never gated —
    // proposing is how a teammate tells you about a symbol you may not have yet.
    const proposal = await shared.relocateFinding(u.root, 264, filed.id, "moved", "seen elsewhere",
      { to: "a_deadbeefdeadbeef" }) as { ok?: true; error?: string };
    assert.ok(proposal.ok, `a proposal is not a write to the target: ${JSON.stringify(proposal)}`);
    const applied = await shared.relocateFinding(u.root, 264, filed.id, "moved", "it is right here",
      { to: here, apply: true }) as { ok?: true; error?: string };
    assert.ok(applied.ok, JSON.stringify(applied));
  } finally { u.cleanup(); }
});

/**
 * One verdict, and an id this build cannot derive is not a symbol that is gone.
 *
 * `sharedDocs` used to hand callers per-citation parts with no document status, so
 * the web, the CLI and `needAttention` each synthesized the verdict separately —
 * and all three read a foreign anchor id as `lost`, a claim about the code, while
 * `evalVersion` called the same doc `unverifiable`, a claim about the two builds.
 *
 * See PROPOSAL-sidecar-materialization.md §7.4 and docs/anchor-id-provenance.md §6.
 */
test("a doc citing an id from another build is unverifiable, not lost, and says so once", async () => {
  const u = universe();
  try {
    const { publishDocVersion } = await import("./shared-docs.js");
    const { hashTokens } = await import("./normalize.js");
    const { derivationTag } = await import("./grammars.js");
    const { init } = await import("./ops.js");
    const { resolveSidecar: rs } = await import("./sidecar-config.js");

    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);

    const theirs = { ...derivationTag("typescript"), grammarDigest: "f".repeat(64) };
    const cfg = rs(u.root)!;
    await publishDocVersion(cfg.path, cfg.universe, { principal: "dana@x.com" }, {
      nodeId: "n_theirs", type: "concept", title: "Their doc", summary: "s", body: "b",
      citations: [{ anchorId: "a_not_derivable_here", acceptedHashes: [hashTokens(["body"], theirs)] }],
      createdCommit: null, createdBranch: null,
    } as never);

    const out = await shared.sharedDocs(u.root, { nodeId: "n_theirs" }) as any;
    const row = out.docs[0];
    assert.equal(row.resolved.status, "unverifiable", "one status, from evalVersion");
    const c = row.resolved.citations[0];
    assert.equal(c.unverifiable, true, "the id cause joins the hash-scheme cause");
    assert.notEqual(c.where, "lost", "`lost` claims the code is gone; nobody established that");
    assert.equal(out.needAttention, 0, "and it is not the reader's work — aligning builds is");
  } finally { u.cleanup(); }
});

/**
 * Step 5, at its smallest useful size: the ordinary per-anchor read can see what
 * the team wrote. Before this, `get_anchor` answered "what documents this code"
 * from local nodes alone, so a colleague's synced doc read as a gap.
 */
test("a teammate's doc is visible on the anchor it describes", async () => {
  const u = universe();
  try {
    const { publishDocVersion } = await import("./shared-docs.js");
    const { init, getAnchor } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    const { resolveSidecar: rs } = await import("./sidecar-config.js");

    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    writeFileSync(join(u.root, "src", "ledger.ts"), "export function post(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const anchors = (await readAnchorStore(u.root)).anchors;
    const transfer = anchors.find((a) => a.file === "src/pay.ts")!;
    const post = anchors.find((a) => a.file === "src/ledger.ts")!;

    const cfg = rs(u.root)!;
    await publishDocVersion(cfg.path, cfg.universe, { principal: "dana@x.com" }, {
      nodeId: "n_transfer", type: "concept", title: "How a transfer settles", summary: "s", body: "b",
      citations: [{ anchorId: transfer.id, acceptedHashes: [transfer.bodyHash] }],
      createdCommit: null, createdBranch: null,
    } as never);

    // Asked through the front door. `sharedDocsCiting` was the bridge that existed
    // because a teammate's doc lived outside `node_versions`; it is an ordinary node
    // now, so `getAnchor` answers this directly and there is no second path to keep
    // in step. The QUESTION is what matters and it is the same one.
    const a = await getAnchor(u.root, transfer.id) as any;
    assert.equal(a.sharedDocs.length, 1);
    assert.equal(a.sharedDocs[0]!.nodeId, "n_transfer");
    assert.equal(a.sharedDocs[0]!.title, "How a transfer settles");
    assert.equal(a.sharedDocs[0]!.by, "dana@x.com", "and who on the team said it");
    assert.equal(a.sharedDocs[0]!.status, "fresh", "the verdict is evalVersion's, not a re-derivation");
    assert.equal(a.sharedScope, undefined, "a healthy scope says nothing extra");

    // CONTROL — it must SELECT, not return everything.
    assert.equal((await getAnchor(u.root, post.id) as any).sharedDocs, undefined,
      "absent rather than empty — an anchor nobody documented says nothing about the team");
  } finally { u.cleanup(); }
});

test("no sidecar leaves the local read exactly as it was", async () => {
  // The whole tool worked without a sidecar for its life. `null` is that answer,
  // and it must not read as an error or as an empty team.
  const u = universe(false);
  try {
    const { init, getAnchor } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const id = (await readAnchorStore(u.root)).anchors[0]!.id;
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      const a = await getAnchor(u.root, id) as any;
      assert.equal(a.error, undefined);
      assert.equal(a.sharedDocs, undefined);
    });
  } finally { u.cleanup(); }
});

test("share_doc cannot choose its own version id or its own time", async () => {
  // Version ids are unique per SCOPE, not per node. An id colliding with another
  // node's makes `foldDocs` drop the newcomer, costing that node its doc for
  // everybody; a `createdAt` in the future wins `selectWinner`'s tiebreak against
  // every later version forever. `share_doc` takes an opaque object, so neither
  // field can be taken on trust — and a NEW version has no identity to preserve.
  const u = universe();
  try {
    const { init } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const id = (await readAnchorStore(u.root)).anchors[0]!.id;

    const r = await shared.shareDoc(u.root, {
      nodeId: "n_theirs", type: "concept", title: "T", summary: "s", body: "b",
      citations: [{ anchorId: id, acceptedHashes: [] }],
      versionId: "nv_hijack", createdAt: "9999-01-01T00:00:00.000Z",
    } as never) as any;
    assert.equal(r.error, undefined);
    assert.notEqual(r.versionId, "nv_hijack");
    assert.match(r.versionId, /^nv_/);

    const out = await shared.sharedDocs(u.root, { nodeId: "n_theirs" }) as any;
    assert.notEqual(out.docs[0].resolved.versionId, "nv_hijack");
    const { readDocs } = await import("./shared-docs.js");
    const { resolveSidecar: rs } = await import("./sidecar-config.js");
    const cfg = rs(u.root)!;
    const doc = (await readDocs(cfg.path, cfg.universe)).get("n_theirs")!;
    assert.notEqual(doc.versions[0]!.createdAt, "9999-01-01T00:00:00.000Z", "and not its own place in the order");
  } finally { u.cleanup(); }
});

test("a tombstone cannot be published through share_doc", async () => {
  // `retireSharedDoc` makes retiring a person's act; this route takes an opaque
  // object, so without a refusal an agent publishes `removed: true` and has done it.
  // It looks inert — a tombstone must cite live anchors to pass validation, so it
  // loses to any content version — but it starts winning the day that code is
  // deleted. A planted tombstone is worse than a refused one.
  const u = universe();
  try {
    const { init } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const id = (await readAnchorStore(u.root)).anchors[0]!.id;
    const v = { nodeId: "n_x", type: "concept", title: "T", summary: "s", body: "b", citations: [{ anchorId: id, acceptedHashes: [] }] };

    const bad = await shared.shareDoc(u.root, { ...v, removed: true } as never) as any;
    assert.ok(bad.error);
    assert.match(bad.error, /retire_shared_doc/);
    const { readDocs } = await import("./shared-docs.js");
    const { resolveSidecar: rs } = await import("./sidecar-config.js");
    const cfg = rs(u.root)!;
    assert.equal((await readDocs(cfg.path, cfg.universe)).size, 0, "and nothing was published");

    // The control: the same version without the flag publishes fine.
    assert.equal((await shared.shareDoc(u.root, v as never) as any).error, undefined);
  } finally { u.cleanup(); }
});

test("a symbol a teammate documented is not offered as a gap", async () => {
  // The north star running backwards: `find_gaps` read `nodes`, which is ONE
  // person's store, so a doc synced last week came back as work to do.
  const u = universe();
  try {
    const { publishDocVersion } = await import("./shared-docs.js");
    const { init, findGaps } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    const { resolveSidecar: rs } = await import("./sidecar-config.js");

    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    writeFileSync(join(u.root, "src", "ledger.ts"), "export function post(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const anchors = (await readAnchorStore(u.root)).anchors;
    const transfer = anchors.find((a) => a.file === "src/pay.ts")!;
    const post = anchors.find((a) => a.file === "src/ledger.ts")!;

    const before = await findGaps(u.root) as any;
    assert.equal(before.openCount, 2, "precondition: nobody has documented either");
    assert.equal(before.documentedByTeam, undefined);

    const cfg = rs(u.root)!;
    await publishDocVersion(cfg.path, cfg.universe, { principal: "dana@x.com" }, {
      nodeId: "n_transfer", type: "concept", title: "How a transfer settles", summary: "s", body: "b",
      citations: [{ anchorId: transfer.id, acceptedHashes: [transfer.bodyHash] }],
      createdCommit: null, createdBranch: null,
    } as never);

    const after = await findGaps(u.root) as any;
    assert.equal(after.openCount, 1, "one gap left, not two");
    assert.deepEqual(after.open.map((a: any) => a.id), [post.id], "and it is the one nobody wrote about");
    assert.equal(after.documentedByTeam.count, 1);
    assert.equal(after.documentedByTeam.anchors[0].anchorId, transfer.id);
    assert.equal(after.documentedByTeam.anchors[0].docs[0].title, "How a transfer settles");
    assert.equal(after.documentedByTeam.anchors[0].docs[0].by, "dana@x.com", "with who to go and read");

    // And now fork that scope. A blocked scope may SHOW what the team wrote and may
    // not decide there is no work here — suppressing a gap is an authoritative act,
    // which is exactly what §7 says a blocked scope may not perform.
    forkDocScope(cfg.path, cfg.universe);
    const forked = await findGaps(u.root) as any;
    assert.equal(forked.openCount, 2, "the gap the team's doc had removed is back");
    assert.equal(forked.documentedByTeam, undefined);
  } finally { u.cleanup(); }
});

/** Fork the doc scope's chain in place: a second event of one writer at GENESIS. */
function forkDocScope(sidecar: string, universe: string): void {
  const dir = join(sidecar, "docs", universe);
  const name = readdirSync(dir).find((n) => n.endsWith(".ndjson"))!;
  // Through `testEvent`, so this is a well-formed protocol-1 event that forks rather
  // than a malformed one the reader drops at the door — which would make the test
  // pass by finding no fork in a scope that has none.
  appendFileSync(join(dir, name), JSON.stringify(testEvent({
    id: "9999999999-ffffffffff", kind: "doc.published", subject: "n_other",
    actor: { principal: "dana@x.com" }, at: "2026-08-23T00:00:00Z",
    writer: name.replace(/\.ndjson$/, ""), writerPrev: "GENESIS",
  })) + "\n");
}

test("with no sidecar the work queue is exactly what it always was", async () => {
  const u = universe(false);
  try {
    const { init, findGaps } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      const g = await findGaps(u.root) as any;
      assert.equal(g.openCount, 1);
      assert.equal(g.documentedByTeam, undefined, "absent, not an empty bucket");
    });
  } finally { u.cleanup(); }
});

test("context answers for the team, not just for this machine", async () => {
  // `context` is the call an agent makes FIRST, which makes it the worst place to be
  // blind to a colleague's doc: it would report a gap and send the agent to explore
  // code somebody already wrote about.
  const u = universe();
  try {
    const { publishDocVersion } = await import("./shared-docs.js");
    const { init, context } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    const { resolveSidecar: rs } = await import("./sidecar-config.js");

    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const transfer = (await readAnchorStore(u.root)).anchors.find((a) => a.file === "src/pay.ts")!;

    const before = await context(u.root, ["src/pay.ts"]) as any;
    assert.match(before.verdict, /^gap/, "precondition: nobody here has documented it");
    assert.equal(before.gaps.length, 1);
    assert.equal(before.sharedDocs, undefined);

    const cfg = rs(u.root)!;
    await publishDocVersion(cfg.path, cfg.universe, { principal: "dana@x.com" }, {
      nodeId: "n_transfer", type: "concept", title: "How a transfer settles", summary: "s", body: "b",
      citations: [{ anchorId: transfer.id, acceptedHashes: [transfer.bodyHash] }],
      createdCommit: null, createdBranch: null,
    } as never);

    const after = await context(u.root, ["src/pay.ts"]) as any;
    assert.equal(after.gaps.length, 0, "not a gap — somebody documented it");
    assert.equal(after.withDoc, 1);
    assert.equal(after.sharedDocs.length, 1);
    assert.equal(after.sharedDocs[0].title, "How a transfer settles");
    // The verdict is the ordinary one now, and that is the change unification makes.
    // "documented by the team — read them with `shared_docs`" existed because a
    // teammate's doc was NOT in this store, so the only honest instruction was to go
    // and fetch it. It is a `node_versions` row now: `get_node` shows it, coverage
    // counts it, and how much to trust it is the same question as for any other doc.
    // Whose it is has not been lost — `sharedDocs` above is what carries that.
    assert.match(after.verdict, /^partial/, "trust ranking, not provenance ranking");
    assert.equal(after.sharedDocs[0].by, "dana@x.com", "and it still says whose it is");
  } finally { u.cleanup(); }
});

test("context with no sidecar is exactly what it always was", async () => {
  const u = universe(false);
  try {
    const { init, context } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      const c = await context(u.root, ["src/pay.ts"]) as any;
      assert.match(c.verdict, /^gap/);
      assert.equal(c.gaps.length, 1);
      assert.equal(c.sharedDocs, undefined, "absent, not an empty list");
    });
  } finally { u.cleanup(); }
});

/**
 * Blocker 5 of "Clearing a doc nobody can place": a doc that exists only on the
 * sidecar could not be queued at all.
 *
 * `annotate`'s guard refuses a node target absent from local `node_versions`, which
 * is right — a claim about a node that is nowhere is a floating claim. A doc the
 * team published and this store never adopted is not nowhere, and it cannot be
 * adopted either: `document` refuses a node whose anchors do not resolve, which is
 * precisely the doc being queued.
 */
test("a question can be filed on a doc that lives only on the sidecar", async () => {
  const u = universe();
  try {
    const { publishDocVersion } = await import("./shared-docs.js");
    const { init, annotate, reviewQueue } = await import("./ops.js");
    const { readAnchorStore } = await import("./store.js");
    const { resolveSidecar: rs } = await import("./sidecar-config.js");

    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
    await init(u.root);
    const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;

    const cfg = rs(u.root)!;
    await publishDocVersion(cfg.path, cfg.universe, { principal: "dana@x.com" }, {
      nodeId: "n_theirs", type: "concept", title: "Dana's doc", summary: "s", body: "b",
      citations: [{ anchorId, acceptedHashes: ["sha256:whatever"] }],
      createdCommit: null, createdBranch: null,
    } as never);

    const ok = await annotate(u.root, {
      targetKind: "node", targetId: "n_theirs", kind: "question",
      text: "cannot place this doc's citations here",
    } as never) as Record<string, unknown>;
    assert.equal(ok.error, undefined, "the team's node is a legitimate target");

    // And it lands in the SAME queue a local doc's question lands in — which is the
    // whole requirement: one queue, one shape, wherever the doc lives.
    // `assignedOnly: false` lists every question; assignment is a separate act
    // (`assign`), and what matters here is that the item exists on a shared node.
    const q = await reviewQueue(u.root, { assignedOnly: false }) as Record<string, any>;
    assert.ok(q.queue.some((i: any) => i.id === ok.id), "visible in the review queue");

    // The control: the guard still refuses a node that is nowhere at all.
    const bad = await annotate(u.root, {
      targetKind: "node", targetId: "n_nowhere", kind: "question", text: "x",
    } as never) as { error?: string };
    assert.match(bad.error ?? "", /unknown node/);
  } finally { u.cleanup(); }
});

// --- materialize at sync ---------------------------------------------------------

test("sync folds the scopes a PULL moved, so a later query never touches the log", async () => {
  // The rule this makes true rather than aspirational: the log is pull/push and is
  // never read on an ordinary query. A locally written finding is already folded by
  // write-through, so the case that matters is a teammate's — without this, a pulled
  // scope sits in the log until whoever queries it first happens to fold it, and a
  // cross-scope query returns only the warmed scopes while looking total.
  //
  // It is also the prerequisite for docs unification: once the bridges are gone, a
  // pulled version reaches SQLite only if sync put it there.
  const origin = tmp("origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const a = universe(), b = universe();
  // Two clones of ONE universe, not two universes: the universe key comes from the
  // code repo's origin slug, and scopes are universe-qualified, so without this the
  // two stores correctly ignore each other's scopes and nothing is pulled.
  for (const r of [a.root, b.root]) git(r, "remote", "add", "origin", "https://github.com/acme/api.git");
  git(a.side, "init", "-q", "-b", "main");
  git(b.side, "init", "-q", "-b", "main");
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      await shared.sharedSync(a.root);
      await shared.sharedSync(b.root);
      git(a.side, "remote", "add", "origin", origin);
      git(b.side, "remote", "add", "origin", origin);

      await shared.shareFinding(a.root, 264, NEW);
      await shared.sharedSync(a.root);

      // b has never seen this scope. Its sync must leave the rows in SQLite.
      const r = await shared.sharedSync(b.root) as { materialized?: shared.Materialized };
      assert.ok(r.materialized, "sync reports what it folded");
      assert.ok(r.materialized!.folded >= 1, "it folded the scope the pull brought in");
      assert.deepEqual(r.materialized!.blocked, [], "with nothing blocked");

      const scope = `findings/${scopeFor(resolveSidecar(b.root)!, "pr", 264)}`;
      const row = db(b.root).prepare("SELECT fingerprint FROM shared_scope WHERE scope = ?").get(scope) as { fingerprint?: string } | undefined;
      assert.ok(row?.fingerprint, `the scope row is in SQLite after sync (${scope})`);

      // CONTROL — a second sync with nothing new folds NOTHING. Without this the test
      // passes just as well against an implementation that re-folds the universe on
      // every sync, which is exactly what the fingerprint exists to avoid.
      const again = await shared.sharedSync(b.root) as { materialized?: shared.Materialized };
      assert.ok(again.materialized!.scanned >= 1, "it still scanned the scope");
      assert.equal(again.materialized!.folded, 0, "but folded none of it");
    });
  } finally { a.cleanup(); b.cleanup(); rmSync(origin, { recursive: true, force: true }); }
});

// --- sidecar heal ----------------------------------------------------------------

/** Two clones of one universe sharing a remote, with b holding a's writer id. */
async function forkedPair() {
  const origin = tmp("origin");
  git(origin, "init", "-q", "--bare", "-b", "main");
  const a = universe(), b = universe();
  for (const r of [a.root, b.root]) git(r, "remote", "add", "origin", "https://github.com/acme/api.git");
  git(a.side, "init", "-q", "-b", "main");
  git(b.side, "init", "-q", "-b", "main");
  await shared.sharedSync(a.root);
  await shared.sharedSync(b.root);
  git(a.side, "remote", "add", "origin", origin);
  git(b.side, "remote", "add", "origin", origin);
  await shared.shareFinding(a.root, 264, NEW);
  await shared.sharedSync(a.root);
  // The fork itself: b picks up a's writer id, so both write one shard file.
  const id = (r: string) => join(r, ".git", "codemap-writer");
  writeFileSync(id(b.side), readFileSync(id(a.side), "utf8"), "utf8");
  return { origin, a, b, cleanup: () => { a.cleanup(); b.cleanup(); rmSync(origin, { recursive: true, force: true }); } };
}

test("heal unions the divided shard, rotates the writer, and clears the scope", async () => {
  const t = await forkedPair();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      await shared.shareFinding(t.b.root, 264, { ...NEW, targetId: "a_2" });
      const before = await shared.sharedSync(t.b.root) as { error?: string };
      assert.ok(before.error, "precondition: the shared writer id fails the sync closed");

      const beforeId = readFileSync(join(t.b.side, ".git", "codemap-writer"), "utf8").trim();
      const r = await shared.sharedHeal(t.b.root) as any;
      assert.equal(r.error, undefined, `heal failed: ${r.error}`);

      assert.equal(r.resolved.length, 1, "the divided shard is unioned");
      assert.ok(r.resolved[0].events >= 2, "and BOTH sides' events are in it");
      assert.ok(r.rotated, "this clone held the forked id, so it rotated");
      assert.notEqual(r.rotated, beforeId);
      assert.ok(r.acknowledged.length >= 1, "and a person acknowledged the evidence");

      // Nothing was deleted: both findings survive, on both clones.
      assert.equal((await shared.sharedFindings(t.b.root, 264) as any).findings.length, 2);
      await shared.sharedSync(t.a.root);
      assert.equal((await shared.sharedFindings(t.a.root, 264) as any).findings.length, 2);

      // The sync that failed now goes through, which is the point of a repair.
      const after = await shared.sharedSync(t.b.root) as { error?: string };
      assert.equal(after.error, undefined, "and syncing works again");
    });
  } finally { t.cleanup(); }
});

test("heal on a healthy sidecar changes nothing", async () => {
  // CONTROL. Without it, a heal that unioned and rotated unconditionally — or one
  // that reported success having done nothing at all — passes the test above.
  const t = await forkedPair();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      // Give b its own writer id back, so there is no fork.
      writeFileSync(join(t.b.side, ".git", "codemap-writer"), "w_00000000deadbeef\n", "utf8");
      const before = readFileSync(join(t.b.side, ".git", "codemap-writer"), "utf8").trim();
      const r = await shared.sharedHeal(t.b.root) as any;
      assert.equal(r.error, undefined);
      assert.deepEqual(r.resolved, [], "nothing to union");
      assert.equal(r.rotated, undefined, "and no reason to rotate");
      assert.deepEqual(r.acknowledged, []);
      assert.equal(readFileSync(join(t.b.side, ".git", "codemap-writer"), "utf8").trim(), before);
    });
  } finally { t.cleanup(); }
});

test("an agent may not heal", async () => {
  const t = await forkedPair();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: "claude-opus-5" }, async () => {
      const r = await shared.sharedHeal(t.b.root) as { error?: string };
      assert.ok(r.error, "refused");
      assert.match(r.error!, /agent may not/i);
    });
  } finally { t.cleanup(); }
});

// --- the publishable surface -----------------------------------------------------

test("analyzer output is refused at the publish surface, and flows are NOT", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const { init } = await import("./ops.js");
      const { readAnchorStore } = await import("./store.js");
      mkdirSync(join(u.root, "src"), { recursive: true });
      writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
      await init(u.root);
      const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
      const base = { nodeId: "n_x", title: "t", summary: "s", body: "b", citations: [{ anchorId, acceptedHashes: [] }] };

      const gen = await shared.shareDoc(u.root, { ...base, type: "concept", generatedBy: "marten" } as any) as { error?: string };
      assert.ok(gen.error, "analyzer output does not travel");
      assert.match(gen.error!, /regenerated by every machine/);

      // Flows TRAVEL now. They were refused because their steps are `step_of` edges and
      // edges did not sync, so a shared flow rendered as an empty one on every
      // teammate's machine. Edges sync (`shared-graph.ts`) and a flow is a node whose
      // `step_of` set is ordered, so the refusal is gone rather than weakened.
      for (const type of ["process", "step"]) {
        const r = await shared.shareDoc(u.root, { ...base, type, nodeId: `n_${type}` } as any) as { error?: string };
        assert.equal(r.error, undefined, `${type} docs travel now`);
      }

      // CONTROL — an ordinary doc still publishes. Without it, "refuse everything"
      // passes every assertion above.
      const ok = await shared.shareDoc(u.root, { ...base, type: "concept" } as any) as { error?: string };
      assert.equal(ok.error, undefined, "a concept doc is publishable");
    });
  } finally { u.cleanup(); }
});

test("the fold drops them too, because it is the only gate that binds every writer", () => {
  // There is no server and no central validation. The publish surface binds writers
  // who ask; an older client, a hand-written line, or a future one that forgets are
  // bound only here. This is the load-bearing half of the narrowing.
  const version = (over: Record<string, unknown>) => ({
    versionId: "v" + (over.nodeId as string), nodeId: over.nodeId, type: "concept",
    title: "t", summary: "s", body: "b", citations: [{ anchorId: "a_1", acceptedHashes: [] }],
    createdCommit: null, createdBranch: null, createdAt: "2026-01-01T00:00:00Z", ...over,
  });
  const ev = (nodeId: string, over: Record<string, unknown> = {}) => testEvent({
    id: "0000000001-" + nodeId, kind: "doc.version", subject: nodeId,
    data: { version: version({ nodeId, ...over }) as never },
  });

  const folded = foldDocs([
    ev("n_gen", { generatedBy: "marten" }),
    ev("n_flow", { type: "process" }),
    ev("n_step", { type: "step" }),
    ev("n_ok"),
  ]);
  assert.deepEqual(
    [...folded.keys()].sort(), ["n_flow", "n_ok", "n_step"],
    "analyzer output is still dropped; flows are not, now that their edges travel",
  );
  // Worth pinning the direction this was discovered from. Removing the PUBLISH check
  // alone left every flow event arriving and being silently dropped here — the fold is
  // the gate that binds writers this build did not write, and a publish check only
  // binds writers who ask. A two-clone walk found it; no unit test would have.
  assert.ok(!folded.has("n_gen"), "the both-ends rule still holds for what is regenerable");
});

test("publishing reports what it skipped rather than narrowing in silence", async () => {
  // A version that never travels and is never mentioned reads, from the other side,
  // exactly like one that did.
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const { init, document: documentNode } = await import("./ops.js");
      const { readAnchorStore } = await import("./store.js");
      mkdirSync(join(u.root, "src"), { recursive: true });
      writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n", "utf8");
      await init(u.root);
      const anchorId = (await readAnchorStore(u.root)).anchors[0]!.id;
      await documentNode(u.root, { type: "process", title: "Flow", summary: "s", body: "b", anchors: [anchorId] });
      await documentNode(u.root, { type: "concept", title: "Idea", summary: "s", body: "b", anchors: [anchorId] });

      const r = await shared.publishLocalDocs(u.root) as any;
      assert.equal(r.skipped?.flows ?? 0, 0, "a flow is no longer skipped — it travels");
      assert.ok(r.publishedVersions >= 2, "both the flow and the concept doc went");
    });
  } finally { u.cleanup(); }
});

// --- write-through -----------------------------------------------------------

/**
 * A shared write appends its event and then materializes that scope, so the row is
 * there and the caller never observes the log. Findings were the one entity kind that
 * skipped it: all thirteen write ops appended and returned, so the tool that had just
 * filed a finding read back nothing until something else happened to fold.
 *
 * Asserted against the TABLE, not through `sharedFindings` — that folds on a miss, so
 * it would answer correctly whether or not the write ever wrote through, which is the
 * shape that let this go unnoticed.
 */
test("a filed finding is a row before anything reads it", async () => {
  const u = universe();
  try {
    const r = await shared.shareFinding(u.root, 264, NEW) as { id: string };
    const row = db(u.root).prepare("SELECT pr, target_id, source_scope FROM findings WHERE id = ?")
      .get(r.id) as { pr: string; target_id: string; source_scope: string | null } | undefined;
    assert.ok(row, "the event is appended AND the scope is materialized");
    assert.equal(row!.pr, "264", "and the pull request is a stored column, not an inference");
    assert.equal(row!.target_id, "a_1", "with the queryable columns filled from the fold");
    assert.ok(row!.source_scope?.endsWith("/pr-264"), "owned by the scope it was filed into");
  } finally { u.cleanup(); }
});

/** The same, for a write that is not the create — a comment must land in rows too. */
test("commenting on a finding writes through as well", async () => {
  const u = universe();
  try {
    const r = await shared.shareFinding(u.root, 264, NEW) as { id: string };
    await shared.commentOnFinding(u.root, 264, r.id, "checked it, still holds");
    const row = db(u.root).prepare("SELECT body FROM findings WHERE id = ?").get(r.id) as { body: string };
    assert.equal(JSON.parse(row.body).thread.length, 1, "the thread is in the row, not only in the log");
  } finally { u.cleanup(); }
});

/** A minimal local finding — what filing with no sidecar configured produces. */
const localFinding = (id: string, text: string): SharedFinding => ({
  id, target: { kind: "anchor", id: "a_local" }, text,
  author: { principal: "izzie@x.com" }, createdAt: "2026-01-01T00:00:00Z",
  state: "created", corroboration: [], thread: [], revisions: [],
});

/**
 * The point of one canonical table: a caller asks for a pull request's findings and
 * gets both halves, with no bridge and no knowledge of where either came from.
 */
test("one list holds this machine's findings and the team's", async () => {
  const u = universe();
  try {
    await shared.shareFinding(u.root, 264, NEW);
    await writeLocalFinding(u.root, localFinding("f_mine", "filed with no sidecar"), 264);

    const all = (await readFindings(u.root, { pr: 264 })).findings;
    assert.equal(all.length, 2, "both, in one query");
    const mine = all.find((f) => f.id === "f_mine")!;
    assert.equal(mine.origin, undefined, "a local finding has no origin");
    assert.equal(mine.pr, "264", "and carries the pull request it was filed against");
    assert.ok(all.find((f) => f.origin?.scope.endsWith("/pr-264")), "the shared one names its scope");
    // And the pr column is what narrows: a different PR sees neither.
    assert.equal((await readFindings(u.root, { pr: 999 })).findings.length, 0);
  } finally { u.cleanup(); }
});

/**
 * The ownership rule, made mechanical. A local write to a fold-owned row is quiet in a
 * specific way — nothing about it moves the scope fingerprint, so the cache keeps
 * serving it until something forces a re-fold and the change then vanishes. An error
 * at the call site is the only version of that anybody can debug.
 */
test("a local write to a fold-owned finding is refused, not silently lost", async () => {
  const u = universe();
  try {
    const r = await shared.shareFinding(u.root, 264, NEW) as { id: string };
    const folded = (await readFinding(u.root, r.id))!;
    assert.ok(folded.origin, "precondition: the fold owns it");
    await assert.rejects(
      () => writeLocalFinding(u.root, { ...folded, text: "quietly rewritten" }, 264),
      /owned by the sidecar fold/,
    );
    assert.equal((await readFinding(u.root, r.id))!.text, NEW.text, "and the row is untouched");
  } finally { u.cleanup(); }
});

/**
 * Cross-model agreement is only measurable if the model is recorded, and on the shared
 * path it was not: `annotate` had a `model` parameter from the start, `share_finding`
 * and `corroborate` had none, and nothing in this repo sets `CODEMAP_AGENT_MODEL`. On a
 * real universe that produced 19 corroborated findings with every author and every
 * verdict attributed to the person, model unknown — so "a second model confirmed it"
 * was not merely unmeasured, it was unrecordable.
 */
test("a model that says what it is is recorded on the finding and on the verdict", async () => {
  const u = universe();
  try {
    const r = await shared.shareFinding(u.root, 264, NEW, { model: "claude-opus-5" }) as { id: string };
    await shared.corroborateFinding(u.root, 264, r.id, "confirm", "read it again", { model: "gpt-5.2" });

    const f = (await readFinding(u.root, r.id))!;
    assert.equal(f.author.via?.model, "claude-opus-5", "the finding says which model raised it");
    assert.equal(f.corroboration[0]!.actor.via?.model, "gpt-5.2", "and which one weighed in");
  } finally { u.cleanup(); }
});

/** And an agent that was not told what it is must not invent one. */
test("no model given records no model, rather than a guess", async () => {
  const u = universe();
  try {
    // Explicitly cleared: unset in this process anyway, so without this the test would
    // pass for the environment's reasons rather than the code's — and `resolveActor`
    // reads CODEMAP_AGENT_MODEL as a fallback, which is exactly what must not leak in.
    await withEnv({ CODEMAP_AGENT_MODEL: undefined, CODEMAP_AGENT_HARNESS: undefined }, async () => {
      const r = await shared.shareFinding(u.root, 264, NEW) as { id: string };
      assert.equal((await readFinding(u.root, r.id))!.author.via?.model, undefined);
    });
  } finally { u.cleanup(); }
});

/** Adoption must not reach across pull requests: (pr, id) is the identity, not id. */
test("a local finding on one pull request is not adopted by another's fold", async () => {
  const u = universe();
  try {
    await writeLocalFinding(u.root, localFinding("f_x", "mine, on 900"), 900);
    // The same id published on a DIFFERENT pull request.
    await shared.shareFinding(u.root, 901, { ...NEW, id: "f_x" } as never);
    await shared.sharedFindings(u.root, 901);

    const rows = db(u.root).prepare("SELECT pr, source_scope FROM findings WHERE id = ? ORDER BY pr")
      .all("f_x") as unknown as { pr: string; source_scope: string | null }[];
    assert.equal(rows.length, 2, "two pull requests, two rows");
    assert.equal(rows[0]!.pr, "900");
    assert.equal(rows[0]!.source_scope, null, "900's local row is untouched by 901's fold");
    assert.ok(rows[1]!.source_scope, "901's row is the fold's");
  } finally { u.cleanup(); }
});

/**
 * Write-through on more than the two ops that first had it. Only `share_finding` and
 * `comment_on_finding` were covered, so removing any of the other eleven calls still
 * passed — which is the same blind spot that let findings skip write-through entirely.
 */
test("every finding write op leaves its change in the rows", async () => {
  const u = universe();
  try {
    const r = await shared.shareFinding(u.root, 264, NEW) as { id: string };
    const body = () => JSON.parse((db(u.root).prepare("SELECT body FROM findings WHERE id = ?")
      .get(r.id) as { body: string }).body);

    await shared.corroborateFinding(u.root, 264, r.id, "confirm", "read it");
    assert.equal(body().corroboration.length, 1, "corroborate");

    await shared.promoteFinding(u.root, 264, r.id);
    assert.ok(body().promotion, "promote");

    await shared.requestOnFinding(u.root, 264, r.id, "resolve", "done with it");
    assert.ok(body().pending, "request");

    await shared.reportOnFinding(u.root, 264, r.id, "fixed", "changed it", ["a.ts"]);
    assert.ok(body().outcome, "report");

    await shared.upstreamFinding(u.root, 264, r.id, { key: "JIRA-1" });
    assert.ok(body().upstream, "upstream");

    await shared.reviseFinding(u.root, 264, r.id, { text: "sharper evidence" });
    assert.equal(body().text, "sharper evidence", "revise");

    await shared.closeFinding(u.root, 264, r.id, "resolved", "fixed upstream");
    assert.equal(body().state, "resolved", "close");
  } finally { u.cleanup(); }
});

/** A pull request key that is not a number would make a second scope for one PR. */
test("a url or owner/repo#N is refused as a findings scope, not silently accepted", async () => {
  const u = universe();
  try {
    await assert.rejects(
      () => shared.shareFinding(u.root, "https://github.com/o/r/pull/5", NEW),
      /not a pull request number/,
    );
    await assert.rejects(() => shared.shareFinding(u.root, "o/r#5", NEW), /not a pull request number/);
    // And the ordinary forms still work, `#5` included.
    assert.ok(((await shared.shareFinding(u.root, "#5", NEW)) as { id?: string }).id);
  } finally { u.cleanup(); }
});

/**
 * The count and the publish must share a predicate.
 *
 * They did not: the dry run counted NODES the sidecar had not seen, and the publish
 * then sent only the versions `notPublishable` allows. On a store whose unshared docs
 * are all analyzer output — 746 of them on a real universe — the hub advertised 746
 * unpublished, the button appended nothing, and the next count said 746 again, with no
 * reason anywhere on screen.
 */
test("the docs count offers only what publishing would actually send", async () => {
  const u = universe();
  try {
    const { document: documentNode } = await import("./ops.js");
    const { init } = await import("./ops.js");
    mkdirSync(join(u.root, "src"), { recursive: true });
    writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c) { return c; }\n", "utf8");
    git(u.root, "add", "-A"); git(u.root, "commit", "-qm", "seed");
    await init(u.root);
    const { readAnchorStore } = await import("./store.js");
    const anchor = (await readAnchorStore(u.root)).anchors[0]!.id;

    await documentNode(u.root, { type: "concept", title: "Human doc", summary: "s", body: "b", anchors: [anchor] });
    await documentNode(u.root, { id: "gen1", type: "command", title: "Generated", summary: "s", body: "b", anchors: [anchor] });
    // As an analyzer emit would leave it.
    db(u.root).prepare("UPDATE node_versions SET generated_by = 'marten' WHERE node_id = 'gen1'").run();

    const before = await shared.publishLocalDocs(u.root, { dryRun: true }) as unknown as unknown as Record<string, number>;
    assert.equal(before.wouldPublish, 1, "the generated one is not work");
    assert.equal(before.skippedGenerated, 1, "and it is reported rather than silently dropped");

    await shared.publishLocalDocs(u.root);
    const after = await shared.publishLocalDocs(u.root, { dryRun: true }) as unknown as unknown as Record<string, number>;
    assert.equal(after.wouldPublish, 0, "pressing publish moves the count — the button can finish");
    assert.equal(after.skippedGenerated, 1, "the analyzer output stays local-only, and still says so");
  } finally { u.cleanup(); }
});

/**
 * The wiring count must say what is NOT already said.
 *
 * It counted every node with a human edge, published all of them, and counted the same
 * number again — so the hub read "96 unpublished" for ever and each press appended 96
 * more events. Measured on a real sidecar: 480 `graph.published` events over exactly 96
 * subjects, five presses of a button that looked like it had done nothing.
 *
 * The fixture wires BEFORE the sidecar exists, because `connect` mirrors as it goes —
 * `publishLocalGraph` is the backfill for wiring that predates joining a team, which is
 * exactly the state that store was in.
 */
const wiredBeforeSidecar = async (u: ReturnType<typeof universe>, extra?: string) => {
  const { document: documentNode, connect, init } = await import("./ops.js");
  mkdirSync(join(u.root, "src"), { recursive: true });
  writeFileSync(join(u.root, "src", "pay.ts"), "export function transfer(c) { return c; }\n", "utf8");
  git(u.root, "add", "-A"); git(u.root, "commit", "-qm", "seed");
  await init(u.root);
  const { readAnchorStore } = await import("./store.js");
  const anchor = (await readAnchorStore(u.root)).anchors[0]!.id;
  for (const id of ["a", "b", "c"]) {
    await documentNode(u.root, { id, type: "concept", title: id, summary: "s", body: "b", anchors: [anchor] });
  }
  await connect(u.root, { from: "a", to: "b", type: "depends_on" });
  if (extra) await connect(u.root, { from: "a", to: extra, type: "depends_on" });
  // Join the team only now.
  writeFileSync(join(u.root, ".codemap", "sidecar"), u.side, "utf8");
  return { connect };
};

test("publishing wiring twice sends it once", async () => {
  const u = universe(false);
  try {
    await wiredBeforeSidecar(u);
    const first = await shared.publishLocalGraph(u.root, { dryRun: true }) as unknown as Record<string, number>;
    assert.equal(first.wouldPublish, 1, "one node has wiring the team has not seen");

    const sent = await shared.publishLocalGraph(u.root) as unknown as Record<string, number>;
    assert.equal(sent.published, 1);

    const after = await shared.publishLocalGraph(u.root, { dryRun: true }) as unknown as Record<string, number>;
    assert.equal(after.wouldPublish, 0, "the count moves — the button can finish");
    assert.equal(after.alreadyShared, 1, "and says why it is zero");

    // The second press must append nothing at all, not merely report nothing.
    const before = countGraphEvents(u.side);
    await shared.publishLocalGraph(u.root);
    assert.equal(countGraphEvents(u.side), before, "a redundant press writes no events");
  } finally { u.cleanup(); }
});

/** Changing the wiring makes it publishable again — the skip is not a latch. */
test("wiring that changed is published again", async () => {
  const u = universe(false);
  try {
    const { connect } = await wiredBeforeSidecar(u);
    await shared.publishLocalGraph(u.root);
    assert.equal((await shared.publishLocalGraph(u.root, { dryRun: true }) as unknown as Record<string, number>).wouldPublish, 0);

    await connect(u.root, { from: "a", to: "c", type: "depends_on" });
    // `connect` mirrors as it goes, so the team already has the new set — which is the
    // right answer and the reason the count is zero rather than one.
    const after = await shared.publishLocalGraph(u.root, { dryRun: true }) as unknown as Record<string, number>;
    assert.equal(after.wouldPublish, 0, "connect already sent it; the backfill has nothing left to do");
  } finally { u.cleanup(); }
});
