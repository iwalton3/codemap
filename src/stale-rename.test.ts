/**
 * A doc citing a symbol whose file was RENAMED must go stale, however the rename was made.
 *
 * `changedFilesSince` lists what `check_stale` re-checks, and git's rename detection is on
 * by default: a `git mv` — staged or committed — lists only the NEW path, so the old file's
 * anchors were never re-checked and the doc read fresh for ever. A plain `mv` (delete plus
 * untracked) always worked, which is the control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { init, checkStale } from "./ops.js";
import { document } from "./ops/docs.js";
import { discard } from "./test-tmp.js";

for (const mode of ["plain mv", "git mv, staged", "git mv, committed"] as const) {
  test(`a doc on a symbol whose file was renamed goes stale (${mode})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codemap-rename-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", ...a], { cwd: root, encoding: "utf8" });
    try {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, ".codemap"));
      writeFileSync(join(root, ".gitignore"), ".codemap/\n");
      writeFileSync(join(root, "src/a.ts"), "export function alpha() {\n  return 1;\n}\n");
      git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-qm", "base");
      await init(root);
      const d = await document(root, { type: "concept", title: "Alpha", summary: "what alpha does", anchors: ["src/a.ts#alpha"] }) as { error?: string };
      assert.equal(d.error, undefined, String(d.error));

      if (mode === "plain mv") renameSync(join(root, "src/a.ts"), join(root, "src/b.ts"));
      else git("mv", "src/a.ts", "src/b.ts");
      if (mode === "git mv, committed") git("commit", "-qm", "rename");

      const r = await checkStale(root);
      assert.deepEqual(r.stale.map((s) => s.status), ["lost"], "the old file's symbol is gone from where it was cited");
      assert.equal(r.flaggedDocs.length, 1, "and the doc citing it is flagged");
    } finally { discard(root); }
  });
}
