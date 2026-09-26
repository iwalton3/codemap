import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { closeDb, db } from "./db.js";
import { discard } from "./test-tmp.js";
import { claimVerifierSession, recordVerifierDomain, taintVerifierSession, verifierSessionActivity } from "./verifier-local.js";
import type { VerifierIdentity } from "./verifier-boundary.js";

const identity = (child = "child-one"): VerifierIdentity => ({ principal: "owner", harness: "codex", session: "session", child, model: "same-model" });
const scratch = () => mkdtempSync(join(tmpdir(), "codemap-verifier-local-"));

test("used verifier identities stay used after DB reopen, reconnect and model changes", () => {
  const root = scratch();
  try {
    assert.deepEqual(recordVerifierDomain(root, identity(), "connection-one", "failed_read"), { ok: true });
    closeDb(root);
    assert.equal(claimVerifierSession(root, { ...identity(), model: "changed-model" }, "connection-two").ok, false);
    assert.deepEqual(recordVerifierDomain(root, identity(), "connection-two", "next_read"), { ok: true });
    assert.deepEqual(verifierSessionActivity(root, identity()), { kind: "domain", connectionId: "connection-one", firstAction: "failed_read" });
    assert.deepEqual(claimVerifierSession(root, identity("child-two"), "connection-three"), { ok: true });
    closeDb(root);
    assert.equal(claimVerifierSession(root, identity("child-two"), "connection-four").ok, false);
    assert.equal(recordVerifierDomain(root, identity("child-two"), "connection-four", "ordinary_read").ok, false);
    assert.equal(verifierSessionActivity(root, identity("child-two"))?.kind, "tainted");
    assert.equal(verifierSessionActivity(root, identity("child-two"))?.connectionId, "connection-three");
    assert.equal(claimVerifierSession(root, identity("child-two"), "connection-five").ok, false);
  } finally { discard(root); }
});

test("only the owning connection can directly taint its verifier claim", () => {
  const root = scratch();
  try {
    claimVerifierSession(root, identity(), "owner-connection");
    taintVerifierSession(root, identity(), "other-connection");
    assert.equal(verifierSessionActivity(root, identity())?.kind, "claimed");
    taintVerifierSession(root, identity(), "owner-connection");
    closeDb(root);
    assert.equal(verifierSessionActivity(root, identity())?.kind, "tainted");
  } finally { discard(root); }
});

test("two processes racing a verifier claim have exactly one durable owner", async () => {
  const root = scratch();
  try {
    db(root);
    closeDb(root);
    const script = `import { claimVerifierSession } from ${JSON.stringify(new URL("./verifier-local.js", import.meta.url).href)};
      const result = claimVerifierSession(process.argv[2], JSON.parse(process.argv[3]), process.argv[4]);
      console.log(JSON.stringify(result));`;
    const scriptPath = join(root, "claim.mjs");
    writeFileSync(scriptPath, script);
    const run = (connection: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", scriptPath, root, JSON.stringify(identity()), connection]);
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (status) => {
        if (status !== 0 || !stdout.trim()) reject(new Error(`claim child status ${status}: ${stdout} ${stderr}`));
        else resolve(stdout);
      });
    });
    const results = await Promise.all(["connection-one", "connection-two"].map(async (connection) => {
      const stdout = await run(connection);
      return { connection, result: JSON.parse(stdout) as { ok: boolean } };
    }));
    assert.equal(results.filter(({ result }) => result.ok).length, 1);
    assert.equal(verifierSessionActivity(root, identity())?.connectionId, results.find(({ result }) => result.ok)!.connection);
  } finally { discard(root); }
});

test("admission ledger migration preserves old local evidence and backs up the old schema", () => {
  const root = scratch();
  mkdirSync(join(root, ".codemap"));
  const old = new DatabaseSync(join(root, ".codemap", "codemap.db"));
  old.exec("CREATE TABLE reader_requests(answer TEXT PRIMARY KEY, body TEXT NOT NULL); INSERT INTO reader_requests VALUES('brief', 'unchanged evidence');");
  old.close();
  try {
    assert.deepEqual(claimVerifierSession(root, identity(), "connection-one"), { ok: true });
    assert.equal((db(root).prepare("SELECT body FROM reader_requests WHERE answer = 'brief'").get() as { body: string }).body, "unchanged evidence");
    const backups = readdirSync(join(root, ".codemap", "backups"));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(root, ".codemap", "backups", backups[0]!), { readOnly: true });
    try {
      assert.equal((backup.prepare("SELECT body FROM reader_requests WHERE answer = 'brief'").get() as { body: string }).body, "unchanged evidence");
      assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'verifier_session_activity'").get(), undefined);
    } finally { backup.close(); }
  } finally { discard(root); }
});
