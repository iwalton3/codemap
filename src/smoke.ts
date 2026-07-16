/**
 * Manual smoke test: parse real files and report whether the grammars load and
 * produce clean trees. Run: `node dist/smoke.js <file>...`
 */

import { readFile } from "node:fs/promises";
import { parserForPath } from "./grammars.js";

function summarizeTopLevel(node: { namedChildren: { type: string }[] }): string {
  const counts = new Map<string, number>();
  for (const c of node.namedChildren) counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${t}×${n}`).join(", ");
}

for (const path of process.argv.slice(2)) {
  const handle = await parserForPath(path);
  if (!handle) {
    console.log(`SKIP  ${path} (unsupported extension)`);
    continue;
  }
  const source = await readFile(path, "utf8");
  const tree = handle.parser.parse(source);
  if (!tree) {
    console.log(`FAIL  ${path} (parse returned null)`);
    continue;
  }
  const root = tree.rootNode;
  console.log(
    `OK    ${handle.grammar.padEnd(10)} ${path}\n` +
      `        root=${root.type} hasError=${root.hasError} ` +
      `bytes=${source.length} topLevel=[${summarizeTopLevel(root)}]`,
  );
}
