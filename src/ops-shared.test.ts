import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveSidecar, universeKey, scopeFor } from "./sidecar-config.js";
import * as shared from "./ops-shared.js";

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

// --- configuration -----------------------------------------------------------

test("no sidecar configured is a clear message, not a crash", async () => {
  const u = universe(false);
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined }, async () => {
      const r = await shared.sharedFindings(u.root, 264) as { error: string };
      assert.match(r.error, /no sidecar configured/);
      assert.match(r.error, /Everything else works without one/, "and it must not read as the whole tool being gated");
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
        const denied = await shared.closeFinding(u.root, 264, id, "resolved") as { error: string };
        assert.match(denied.error, /request it instead|only request/);
        await shared.requestOnFinding(u.root, 264, id, "resolve", "the guard was added in abc123");
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
      nodeId: "n_theirs", type: "process", title: "Their doc", summary: "s", body: "b",
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
      nodeId: "n_transfer", type: "process", title: "How a transfer settles", summary: "s", body: "b",
      citations: [{ anchorId: transfer.id, acceptedHashes: [transfer.bodyHash] }],
      createdCommit: null, createdBranch: null,
    } as never);

    const hit = await shared.sharedDocsCiting(u.root, [transfer.id]);
    assert.equal(hit!.length, 1);
    assert.equal(hit![0]!.nodeId, "n_transfer");
    assert.equal(hit![0]!.by, "dana@x.com", "and who on the team said it");
    assert.equal(hit![0]!.status, "fresh", "the verdict is evalVersion's, not a fourth re-derivation");
    assert.deepEqual(hit![0]!.covers, [transfer.id]);

    // The control: the reverse lookup must select, not just return everything.
    assert.deepEqual(await shared.sharedDocsCiting(u.root, [post.id]), [],
      "a doc that cites another symbol is not this symbol's documentation");
    assert.deepEqual(await shared.sharedDocsCiting(u.root, []), []);

    const a = await getAnchor(u.root, transfer.id) as any;
    assert.equal(a.sharedDocs.length, 1);
    assert.equal(a.sharedDocs[0]!.title, "How a transfer settles");
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
      assert.equal(await shared.sharedDocsCiting(u.root, [id]), null);
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
      nodeId: "n_theirs", type: "process", title: "T", summary: "s", body: "b",
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
    const v = { nodeId: "n_x", type: "process", title: "T", summary: "s", body: "b", citations: [{ anchorId: id, acceptedHashes: [] }] };

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
      nodeId: "n_transfer", type: "process", title: "How a transfer settles", summary: "s", body: "b",
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
  } finally { u.cleanup(); }
});

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
      nodeId: "n_transfer", type: "process", title: "How a transfer settles", summary: "s", body: "b",
      citations: [{ anchorId: transfer.id, acceptedHashes: [transfer.bodyHash] }],
      createdCommit: null, createdBranch: null,
    } as never);

    const after = await context(u.root, ["src/pay.ts"]) as any;
    assert.equal(after.gaps.length, 0, "not a gap — somebody documented it");
    assert.equal(after.withDoc, 1);
    assert.equal(after.sharedDocs.length, 1);
    assert.equal(after.sharedDocs[0].title, "How a transfer settles");
    assert.match(after.verdict, /documented by the team/);
    assert.match(after.verdict, /read them/, "…and says to read theirs rather than trust them unseen");
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
