import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));

// Round 3, I7: the damage scan classes a scope no family registered as newer, which blocks every
// push. Run alone — as the migration runs it — it must know every family. A child process,
// because in this suite every family is already imported by something else.
test("the damage scan alone knows every family's scopes", () => {
  const scopes = ["docs/u", "notes/u", "walkthrough/u", "reviews/u", "graph/u", "findings/u/1", "bugs/u", "triage/u", "decisions/u", "materializer"];
  const r = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `
    await import(${JSON.stringify(new URL("./damage-scan.js", import.meta.url).href)});
    const { kindsFor } = await import(${JSON.stringify(new URL("./eventlog.js", import.meta.url).href)});
    console.log(JSON.stringify(${JSON.stringify(scopes)}.filter((s) => !kindsFor(s))));`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").at(-1)!), []);
});

test("families.ts imports every module that registers a vocabulary", () => {
  const src = here("../src/");
  const registering = readdirSync(src).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "eventlog.ts"
    && /^\s*(?:export\s+)?const\s+\w+\s*=\s*registerKinds\(|^registerKinds\(/m.test(readFileSync(src + f, "utf8")));
  const listed = readFileSync(src + "families.ts", "utf8");
  assert.ok(registering.length >= 11, `found ${registering.length}: the scan must see the families`);
  assert.deepEqual(registering.filter((f) => !listed.includes(`"./${f.replace(/\.ts$/, ".js")}"`)), []);
});
