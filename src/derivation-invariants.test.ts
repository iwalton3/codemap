import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexBlob } from "./repo.js";
import { derivationTag, GRAMMAR_NAMES, GRAMMARS_DIR, WASM_FILE } from "./grammars.js";
import { derivationMark, derivationFingerprint } from "./normalize.js";

/**
 * The two couplings the whole anchor-id design rests on, and neither is enforced by
 * a type. `docs/anchor-id-provenance.md` §4 names them; this file is the reason it
 * gets to name them rather than merely hope.
 *
 * The design decided ids stay BARE and take their derivation evidence from the body
 * hash minted beside them. That is only sound while the two really are minted
 * together, by the build the tag names. Both are true today by construction, and
 * both are the kind of thing a refactor breaks silently.
 */

/**
 * ONE: an id and the hash beside it come from the same build.
 *
 * If a future path ever set a `bodyHash` from one moment and a `derivation` from
 * another — a copied row, a re-stamped tag, a hash carried across an upgrade — the
 * mark on the hash would describe a build that did not mint the id, and every
 * resolution in §6 would be reasoning from the wrong evidence.
 */
test("an anchor's hash carries the same derivation as the anchor", async () => {
  for (const [src, file] of [
    ["class C { void M(int x){} }", "a.cs"],
    ["def m():\n    pass\n", "a.py"],
    ["export function m(a) { return a; }", "a.ts"],
  ] as const) {
    const anchors = await indexBlob(src, file);
    assert.ok(anchors.length, `${file} produced no anchors`);
    for (const a of anchors) {
      assert.ok(a.derivation, `${file}: an anchor without a tag cannot be checked`);
      assert.equal(derivationMark(a.bodyHash), derivationFingerprint(a.derivation!),
        `${file}: the hash beside this id describes a different build than the row does`);
    }
  }
});

/**
 * TWO: `derivationTag(grammar)` names the blob that actually parses.
 *
 * It digests `GRAMMARS_DIR/WASM_FILE[name]` — the vendored file for that grammar
 * NAME — while `indexSource` takes a name and an already-parsed tree and never
 * checks they correspond. `repo.ts` gets this right by loading the same blob; the
 * two-grammar demonstration in §1 deliberately does not, which is why both of its
 * runs stamp one mark despite minting different ids.
 *
 * So this pins the half that can be pinned: the tag describes the vendored file, and
 * `loadLanguage` loads that same file.
 */
test("a grammar's tag digests the vendored blob that loadLanguage loads", () => {
  for (const name of GRAMMAR_NAMES) {
    const file = join(GRAMMARS_DIR, WASM_FILE[name]);
    const onDisk = createHash("sha256").update(readFileSync(file)).digest("hex");
    assert.equal(derivationTag(name).grammarDigest, onDisk,
      `${name}: the tag does not describe ${WASM_FILE[name]}, so it names a parser that did not run`);
  }
});
