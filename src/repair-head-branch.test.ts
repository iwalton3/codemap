/**
 * Review O24 (owner: "Use the PR's head branch as GitHub reports it"): a pull request linked to
 * branches at different tips judges against the one GitHub names, and a failed lookup judges
 * nothing and says why. `gh` is a stand-in on PATH, restored in `finally`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeLocalLink } from "./store.js";
import { repairSourceBranch } from "./repair-lifecycle.js";
import { discard } from "./test-tmp.js";
import type { SharedFinding } from "./shared-findings.js";

test("O24: linked branches that disagree are settled by GitHub's head branch; an unanswered lookup judges nothing", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-head-"));
  const bin = mkdtempSync(join(tmpdir(), "codemap-gh-"));
  const path = process.env.PATH;
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://github.com/acme/api.git");
    git("commit", "-q", "--allow-empty", "-m", "base");
    git("branch", "feat-a");
    git("checkout", "-q", "-b", "feat-b");
    git("commit", "-q", "--allow-empty", "-m", "b moves on");
    const b = git("rev-parse", "feat-b").stdout.trim();
    mkdirSync(join(root, ".codemap"), { recursive: true });
    writeLocalLink(root, "5", "feat-a");
    writeLocalLink(root, "5", "feat-b");
    const finding = { pr: "5" } as SharedFinding & { pr: string };
    const gh = (body: string) => { writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, "gh"), 0o755); };
    process.env.PATH = `${bin}${delimiter}${path}`;

    gh(`echo '{"headRefName":"feat-b"}'`);
    assert.deepEqual(repairSourceBranch(root, finding), { sha: b });

    // Another PR number, so the 60s answer cache cannot stand in for the failure.
    writeLocalLink(root, "6", "feat-a");
    writeLocalLink(root, "6", "feat-b");
    gh(`echo 'HTTP 502' >&2; exit 1`);
    const failed = repairSourceBranch(root, { pr: "6" } as SharedFinding & { pr: string });
    assert.equal(failed.sha, null);
    assert.match(failed.why ?? "", /could not be asked.*HTTP 502/);
  } finally {
    process.env.PATH = path;
    discard(root); discard(bin);
  }
});
