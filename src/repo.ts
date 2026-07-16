/**
 * Turning files into anchors: one file, or a whole repo.
 */

import { readFile } from "node:fs/promises";
import { type Anchor } from "./schema.js";
import { parserForPath } from "./grammars.js";
import { indexSource } from "./indexer.js";
import { listSupportedFiles, toPosixRel } from "./fs-scan.js";

/** Index a single file. `relPath` is the repo-relative POSIX path stored on anchors. */
export async function indexFile(absPath: string, relPath: string): Promise<Anchor[]> {
  const handle = await parserForPath(absPath);
  if (!handle) return [];
  const source = await readFile(absPath, "utf8");
  const tree = handle.parser.parse(source);
  if (!tree) return [];
  return indexSource(source, relPath, handle.grammar, tree.rootNode);
}

export async function indexRepo(root: string): Promise<Anchor[]> {
  const files = await listSupportedFiles(root);
  const anchors: Anchor[] = [];
  for (const abs of files) {
    anchors.push(...(await indexFile(abs, toPosixRel(root, abs))));
  }
  return anchors;
}
