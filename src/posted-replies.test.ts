import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as shared from "./ops-shared.js";
import type { GhRunner } from "./pr-push.js";

const git = (root: string, ...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const NEW = { targetKind: "anchor" as const, targetId: "a_1", text: "evidence", comment: "the submitter-facing ask" };

/** A universe with a GitHub origin — `inboundReplies` needs the slug — and a sidecar. */
function universe() {
  const dirs = [mkdtempSync(join(tmpdir(), "codemap-pub-repo-")), mkdtempSync(join(tmpdir(), "codemap-pub-side-"))];
  const [root, side] = dirs as [string, string];
  for (const r of dirs) {
    git(r, "init", "-q", "-b", "main");
    git(r, "config", "user.email", "izzie@x.com");
    git(r, "config", "user.name", "izzie");
  }
  git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
  mkdirSync(join(root, ".codemap"), { recursive: true });
  writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
  return { root, cleanup: () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } }
};

/**
 * A pull request with one thread: our comment, and the submitter answering it.
 *
 * Shaped as the GraphQL `reviewThreads` query returns it, because that is what
 * `fetchReviewThreads` parses — a fake that agrees with the caller but not with
 * GitHub would test nothing.
 */
const fakeGh = (rootCommentId: number): GhRunner => () => ({
  ok: true,
  err: "",
  out: JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{
        id: "PRRT_1", isResolved: false, resolvedBy: null, path: "src/a.cs", line: 12,
        comments: { pageInfo: { hasNextPage: false }, nodes: [
          { databaseId: rootCommentId, author: { login: "izzie" }, body: "the submitter-facing ask", createdAt: "2026-08-20T00:00:00Z" },
          { databaseId: rootCommentId + 1, author: { login: "submitter" }, body: "guarded upstream, see Startup.cs", createdAt: "2026-08-20T01:00:00Z" },
        ] },
      }],
    } } } },
  }),
});

/**
 * The whole point of `posted`: the submitter's answer comes back to the team.
 *
 * Their reply exists nowhere but GitHub — the reviewers' discussion lives on the
 * sidecar, but the person who has to fix it answers on the pull request. Nothing
 * wrote `posted`, so `inboundReplies` returned "nothing from here has been
 * published" for every finding forever, which reads as "they have not replied".
 */
test("a finding recorded as published brings the submitter's reply back", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const created = await shared.shareFinding(u.root, 264, NEW) as { id: string; error?: string };
      assert.ok(!created.error, JSON.stringify(created));

      const before = await shared.inboundReplies(u.root, 264, { gh: fakeGh(9001) }) as { note?: string };
      assert.match(before.note ?? "", /nothing from here has been published/);

      const rec = await shared.recordPublished(u.root, 264, created.id, { key: "9001", url: "https://github.com/acme/api/pull/264#discussion_r9001" }) as { error?: string };
      assert.ok(!rec.error, JSON.stringify(rec));

      const after = await shared.inboundReplies(u.root, 264, { gh: fakeGh(9001) }) as
        { note?: string; findings: { id: string; url?: string; replies: { by: string; body: string }[] }[] };
      assert.equal(after.note, undefined, "no longer 'nothing published'");
      assert.equal(after.findings.length, 1);
      assert.equal(after.findings[0]!.id, created.id);
      assert.deepEqual(after.findings[0]!.replies.map((r) => r.body), ["guarded upstream, see Startup.cs"],
        "our own comment is the thread root, not a reply to ourselves");
    });
  } finally { u.cleanup(); }
});

/** And it shows up on the finding itself, which is where a person looks first. */
test("and the finding says where it landed", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const created = await shared.shareFinding(u.root, 264, NEW) as { id: string };
      const url = "https://github.com/acme/api/pull/264#discussion_r9001";
      await shared.recordPublished(u.root, 264, created.id, { key: "9001", url });
      const v = await shared.sharedFindings(u.root, 264) as { findings: { posted?: string }[] };
      assert.equal(v.findings[0]!.posted, url);
    });
  } finally { u.cleanup(); }
});

/**
 * A second record does not overwrite the first.
 *
 * The fold takes the earliest (`if (!f.posted)`), because a comment already on
 * somebody's pull request cannot be un-posted: a later id is a SECOND comment,
 * not a correction, and pointing the finding at it silently abandons the thread
 * the submitter is actually replying in.
 */
test("the first place it landed is the one that sticks", async () => {
  const u = universe();
  try {
    await withEnv({ CODEMAP_SIDECAR: undefined, CODEMAP_AGENT_MODEL: undefined }, async () => {
      const created = await shared.shareFinding(u.root, 264, NEW) as { id: string };
      await shared.recordPublished(u.root, 264, created.id, { key: "9001", url: "first" });
      await shared.recordPublished(u.root, 264, created.id, { key: "9002", url: "second" });
      const v = await shared.sharedFindings(u.root, 264) as { findings: { posted?: string }[] };
      assert.equal(v.findings[0]!.posted, "first");
    });
  } finally { u.cleanup(); }
});
