/**
 * Manual inspection: print the anchors extracted from files.
 * Run: `node dist/dump.js <file>...`
 */

import { readFile } from "node:fs/promises";
import { parserForPath } from "./grammars.js";
import { indexSource } from "./indexer.js";

for (const path of process.argv.slice(2)) {
  const handle = await parserForPath(path);
  if (!handle) {
    console.log(`SKIP ${path}`);
    continue;
  }
  const source = await readFile(path, "utf8");
  const tree = handle.parser.parse(source);
  if (!tree) {
    console.log(`FAIL ${path}`);
    continue;
  }
  const anchors = indexSource(source, path, handle.grammar, tree.rootNode);
  console.log(`\n=== ${path}  (${handle.grammar}, ${anchors.length} anchors) ===`);
  for (const a of anchors) {
    const dis = a.disambiguator !== undefined ? `#${a.disambiguator}` : "";
    const kind = a.kind.padEnd(11);
    console.log(`  ${kind} ${a.symbolPath.join(" › ")}${dis}   ${a.bodyHash.slice(7, 19)}`);
  }
}
