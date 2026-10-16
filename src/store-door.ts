/**
 * Whether this process may CREATE a universe's store (owner, 2026-10-16, items 6 and 8).
 *
 * Opening a store creates it, so a command pointed at a checkout with none — a worktree, a
 * typo'd `--repo` — used to make an empty one and answer from it: `diff` said "+0 −0 ~0",
 * `rules` an INDEX.md of "None.". Without a person at a terminal only `init` may create one;
 * with one, any command may, and says so. Checked where a store is created (`db()`) and where
 * `.codemap/` is made for a lock (`withLock`), so a refused command leaves nothing behind.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type StoreCreation = "silent" | "announce" | "refuse";

/** The one decision. "Has a tty" is stdin: `codemap diff | less` is still a person. */
export function storeCreationFor(command: string, stdinIsTTY: boolean): StoreCreation {
  if (command === "init" || command === "reindex") return "silent";
  return stdinIsTTY ? "announce" : "refuse";
}

// Process-global, set only by `cli.ts` (never imported by a test; they spawn it). Anything
// else — a server, a test — keeps today's silent creation. A test of the door restores it.
let mode: StoreCreation = "silent";
export function setStoreCreation(m: StoreCreation): void { mode = m; }

export const storeFile = (root: string) => join(root, ".codemap", "codemap.db");

/** A legacy JSON store counts: the first open imports it (`db.ts` `importLegacy`). */
const hasStore = (root: string) =>
  existsSync(storeFile(root)) || existsSync(join(root, ".codemap", "anchors.json"));

export class NoStore extends Error {}

const announced = new Set<string>(); // `withLock` then `db()` both ask for one command

/** Call before creating anything under `<root>/.codemap/`. Throws `NoStore` when refused. */
export function admitStore(root: string): void {
  if (mode === "silent" || hasStore(root)) return;
  if (mode === "refuse") {
    throw new NoStore(`no codemap store at ${join(root, ".codemap")} — run \`codemap init ${root}\` first `
      + "(without a terminal, no command but init creates one)");
  }
  if (announced.has(root)) return;
  announced.add(root);
  process.stderr.write(`created an empty codemap store at ${join(root, ".codemap")} — run \`codemap init ${root}\` to index it\n`);
}
