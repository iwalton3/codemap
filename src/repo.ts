/**
 * Turning files into anchors: one file, or a whole repo.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Anchor } from "./schema.js";
import { parserForPath } from "./grammars.js";
import { indexSource } from "./indexer.js";
import { listSupportedFiles, toPosixRel, isIndexablePath, MAX_BYTES } from "./fs-scan.js";
import { compileIgnore, loadIgnore, type Ignore } from "./ignore.js";
import { lsTreeEntries, readBlobs, showFile } from "./git.js";

/** Index a single file. `relPath` is the repo-relative POSIX path stored on anchors. */
export async function indexFile(absPath: string, relPath: string): Promise<Anchor[]> {
  const handle = await parserForPath(absPath);
  if (!handle) return [];
  const source = await readFile(absPath, "utf8");
  const tree = handle.parser.parse(source);
  if (!tree) return [];
  // The tree lives in the wasm heap, which JS does not collect — see `parserForPath`.
  try { return indexSource(source, relPath, handle.grammar, tree.rootNode); }
  finally { tree.delete(); }
}

/**
 * Index provided source text (grammar chosen by `relPath`'s extension) — for
 * indexing a git blob without touching the filesystem. Anchor ids match
 * `indexFile` on the same relPath, so an anchor can be looked up by id and its
 * fresh `loc` used to slice the same decoded blob. `loc` offsets are UTF-16
 * code-unit indices into the parsed string (matching node.text) — slice the
 * string, not the raw buffer, or multi-byte chars will misalign the window.
 */
export async function indexBlob(source: string, relPath: string): Promise<Anchor[]> {
  const handle = await parserForPath(relPath);
  if (!handle) return [];
  const tree = handle.parser.parse(source);
  if (!tree) return [];
  try { return indexSource(source, relPath, handle.grammar, tree.rootNode); }
  finally { tree.delete(); }
}

export async function indexRepo(root: string): Promise<Anchor[]> {
  const files = await listSupportedFiles(root);
  const anchors: Anchor[] = [];
  for (const abs of files) {
    anchors.push(...(await indexFile(abs, toPosixRel(root, abs))));
  }
  return anchors;
}

/**
 * Index a commit straight from its git objects — no checkout, no working-tree
 * writes, ~2s for a 1200-file repo.
 *
 * This is what lets a snapshot exist for an *arbitrary* sha. A pull request's
 * true base is the merge-base of its head and the base branch, which is almost
 * never the commit anyone has checked out, and checking one out in a tree
 * another person (or agent) is working in is not an option. `indexRepo` can
 * only ever index what is on disk; this can index any commit in the repo.
 *
 * Verified to produce byte-identical anchors to `indexRepo` at HEAD on a clean
 * tree — keep it that way, since a divergence would surface as phantom
 * added/removed symbols in every diff built on it.
 */
export async function indexCommit(
  root: string,
  sha: string,
  opts: { prefix?: string; ignore?: Ignore } = {},
): Promise<Anchor[] | null> {
  const tree = lsTreeEntries(root, sha);
  if (!tree) return null;
  const prefix = opts.prefix ?? "";

  // Committed rules win — a branch may legitimately change what it excludes, and
  // judging it by another commit's rules invents added/removed symbols. But
  // `.codemapignore` is frequently *untracked* (both live universes keep it in
  // .git/info/exclude), and then the working copy is the only statement of intent
  // there is, so fall back to it rather than indexing everything.
  // Inherited on recursion so one ruleset covers submodule paths too, matching
  // `listSupportedFiles`, which loads the ignore file once for the whole walk.
  const committed = showFile(root, sha, ".codemapignore")?.toString("utf8");
  const ignore = opts.ignore ?? (committed !== undefined ? compileIgnore(committed) : await loadIgnore(root));

  const files = tree.filter((e) => e.type === "blob" && e.size <= MAX_BYTES && isIndexablePath(prefix + e.path, ignore));
  // `readBlobs` throws when a batch fails. A partial read here would be cached as
  // this commit's snapshot and read as a mass symbol deletion by the next diff, so
  // it becomes the documented `null` — no snapshot at all beats a truncated one.
  let blobs: Map<string, string>;
  try { blobs = readBlobs(root, sha, files.map((f) => f.path)); }
  catch { return null; }

  const anchors: Anchor[] = [];
  // relPath must carry the prefix: it is hashed into the anchor id, so indexing a
  // submodule under its own root would mint ids that never match the parent's.
  for (const [path, source] of blobs) anchors.push(...(await indexBlob(source, prefix + path)));

  for (const link of tree) {
    if (link.type !== "commit") continue;
    if (ignore.ignores(prefix + link.path, true)) continue;
    const sub = await indexCommit(join(root, link.path), link.oid, { prefix: `${prefix}${link.path}/`, ignore });
    if (sub) anchors.push(...sub);
  }
  return anchors;
}
