/**
 * A HASH_SCHEME bump must not turn the whole store red.
 *
 * The rule, stated in CLAUDE.md and in the proposal: a mismatch between hashes
 * from different schemes means the RULES for hashing changed, not the code. It has
 * to read as "cannot tell", never as drift. `comparableHashes` exists for exactly
 * this — but it was wired into `witnessDrift` and the sidecar's doc path only, and
 * not into either of the two places that decide what a user actually sees:
 *
 *   - `resolveAcceptance` (src/acceptance.ts) decides reviewed vs stale, with a
 *     bare `===`. Every review mark in every store read `stale` after the bump.
 *   - `evalVersion` (src/store.ts) decides a doc's status, with `.includes()`.
 *     Every local doc read `stale` — the same 985-of-985 failure already measured
 *     and fixed on the sidecar copy, still live on this path.
 *
 * The blast radius is what makes it worth a dedicated test: the prefix is on EVERY
 * hash, so this is 100% of anchors, not the small fraction whose body really moved.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAcceptance, type Ancestry } from "./acceptance.js";
import { comparableHashes, hashSchemeOf, ABSENT_HASH } from "./normalize.js";
import type { AcceptedEntry } from "./schema.js";
import { discard } from "./test-tmp.js";

/** No git in play: every commit is on-ref and known, so ancestry decides nothing. */
const flat: Ancestry = { onRef: () => true, precedes: () => false, known: () => true };

const DIGEST = "sha256:14b0ea1e00000000000000000000000000000000000000000000000000000000";
const OTHER = "sha256:deadbeef00000000000000000000000000000000000000000000000000000000";
const entry = (bodyHash: string): AcceptedEntry =>
  ({ bodyHash, commit: "c1", at: "2026-01-01T00:00:00Z" } as AcceptedEntry);

test("the same body under a new scheme is unverifiable, not stale", () => {
  // The exact shape of the bump: the digest is unchanged, only the stamp moved.
  const stored = [entry(DIGEST)];
  assert.equal(resolveAcceptance(stored, DIGEST, flat).via, "direct", "control: same scheme, still signed off");
  assert.equal(resolveAcceptance(stored, "h2:" + DIGEST, flat).via, "unverifiable",
    "a scheme bump must not read as drift — that is every mark in the store");
});

test("a body that genuinely moved is still stale", () => {
  // The half that matters more: the fix must not launder real drift into silence.
  assert.equal(resolveAcceptance([entry(DIGEST)], OTHER, flat).via, "none");
  assert.equal(resolveAcceptance([entry("h2:" + DIGEST)], "h2:" + OTHER, flat).via, "none");
});

test("one comparable entry is enough to make a mismatch mean drift", () => {
  // A legacy mark beside a current one. The current one CAN be compared and does
  // not match, so the code did move — reporting "cannot tell" here would hide it.
  const mixed = [entry(DIGEST), entry("h2:" + OTHER)];
  assert.equal(resolveAcceptance(mixed, "h2:" + DIGEST, flat).via, "none");
});

test("an absent body is comparable to anything, so a removal still reads as one", () => {
  assert.ok(comparableHashes(ABSENT_HASH, "h2:" + DIGEST));
  assert.ok(comparableHashes(DIGEST, ABSENT_HASH));
  assert.equal(hashSchemeOf(DIGEST), 1, "an unprefixed digest is scheme 1 — legacy rows have no other reading");
  assert.equal(hashSchemeOf("h2:" + DIGEST), 2);
});

test("a doc whose citations all predate the bump is unverifiable, not stale", async () => {
  const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "codemap-scheme-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(c: number) { return c; }\n");
    const { init, document: documentNode } = await import("./ops.js");
    const { readAnchorStore, loadNodes } = await import("./store.js");
    await init(root);
    const anchorId = (await readAnchorStore(root)).anchors[0]!.id;
    await documentNode(root, { type: "process", title: "Seam", summary: "s", body: "b", anchors: [anchorId] });

    const fresh = (await loadNodes(root)).find((n) => n.title === "Seam");
    assert.equal(fresh?.status, "fresh", "control: freshly written, freshly hashed");

    // Rewrite the accepted hashes to their pre-bump form — what every store that
    // predates HASH_SCHEME 2 actually holds — without touching a line of code.
    const { db } = await import("./db.js");
    const d = db(root);
    for (const row of d.prepare("SELECT version_id, citations FROM node_versions").all() as { version_id: string; citations: string }[]) {
      const cites = JSON.parse(row.citations).map((c: { acceptedHashes: string[] }) => ({
        ...c, acceptedHashes: c.acceptedHashes.map((h: string) => h.replace(/^h\d+:/, "")),
      }));
      d.prepare("UPDATE node_versions SET citations = ? WHERE version_id = ?").run(JSON.stringify(cites), row.version_id);
    }

    const after = (await loadNodes(root)).find((n) => n.title === "Seam");
    assert.equal(after?.status, "unverifiable",
      "the code is byte-identical; only the hashing rules moved");
    assert.notEqual(after?.status, "stale", "this is the 985-of-985 failure");
  } finally { discard(root); }
});
