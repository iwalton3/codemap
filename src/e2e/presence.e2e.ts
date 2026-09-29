/**
 * Presence comes only from the page's own poll (F39). Any other GET of the questionnaire list —
 * a probe, a script, an agent — must not tell an agent that a person has the web UI open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startServer } from "./harness.js";
import { webPresence } from "../ops/decisions.js";
import { discard } from "../test-tmp.js";

test("F39: only the page's poll records web presence", async () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-presence-"));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "alice@x.com"], ["config", "user.name", "Alice"]]) {
      assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    }
    mkdirSync(join(root, ".codemap"));
    writeFileSync(join(root, "code.ts"), "export const x = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-qm", "seed"], { cwd: root });
    server = await startServer(root);
    const u = (await (await fetch(`${server.url}/api/universes`)).json() as { primary: string }).primary;
    const probe = await fetch(`${server.url}/api/decisions/questionnaires?u=${encodeURIComponent(u)}`);
    assert.equal(probe.status, 200);
    assert.equal(webPresence(root).open, false, "a bare GET is not a person at the page");
    const poll = await fetch(`${server.url}/api/decisions/questionnaires?u=${encodeURIComponent(u)}&presence=poll`);
    assert.equal(poll.status, 200);
    assert.equal(webPresence(root).open, true, "the page's own poll is");
  } finally {
    server?.stop();
    discard(root);
  }
});
