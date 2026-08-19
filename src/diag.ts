/**
 * Health report for a repo: coverage, parse failures, blind spots, timing.
 * Run: `node dist/diag.js <repo>...`
 *
 * A sanity tool — not part of the engine. Surfaces where the indexer is
 * silently missing code (parse errors, zero-anchor source files) so gaps show
 * up against real repos before anything depends on the index.
 */

import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parserForPath } from "./grammars.js";
import { indexSource } from "./indexer.js";
import { listSupportedFiles, toPosixRel } from "./fs-scan.js";

interface FileStat {
  rel: string;
  grammar: string;
  bytes: number;
  hasError: boolean;
  anchors: number;
}

async function report(root: string): Promise<void> {
  const t0 = performance.now();
  const files = await listSupportedFiles(root);
  const stats: FileStat[] = [];
  for (const abs of files) {
    const rel = toPosixRel(root, abs);
    const handle = await parserForPath(abs);
    if (!handle) continue;
    const src = await readFile(abs, "utf8");
    const tree = handle.parser.parse(src);
    if (!tree) {
      stats.push({ rel, grammar: handle.grammar, bytes: src.length, hasError: true, anchors: 0 });
      continue;
    }
    const anchors = indexSource(src, rel, handle.grammar, tree.rootNode);
    stats.push({ rel, grammar: handle.grammar, bytes: src.length, hasError: tree.rootNode.hasError, anchors: anchors.length });
    tree.delete();   // wasm-heap memory JS will not collect — see `parserForPath`
  }
  const ms = Math.round(performance.now() - t0);

  const byLang = new Map<string, { files: number; anchors: number }>();
  for (const s of stats) {
    const e = byLang.get(s.grammar) ?? { files: 0, anchors: 0 };
    e.files++;
    e.anchors += s.anchors;
    byLang.set(s.grammar, e);
  }
  const totalAnchors = stats.reduce((n, s) => n + s.anchors, 0);
  const parseErrors = stats.filter((s) => s.hasError);
  const zero = stats.filter((s) => !s.hasError && s.anchors === 0);

  console.log(`\n########## ${root}`);
  console.log(`files: ${stats.length}   anchors: ${totalAnchors}   parse-errors: ${parseErrors.length}   zero-anchor: ${zero.length}   ${ms}ms`);
  console.log("by language:");
  for (const [lang, e] of [...byLang].sort((a, b) => b[1].anchors - a[1].anchors)) {
    console.log(`  ${lang.padEnd(11)} files=${String(e.files).padStart(4)}  anchors=${e.anchors}`);
  }
  if (parseErrors.length) {
    console.log(`parse errors (first 15):`);
    for (const s of parseErrors.slice(0, 15)) console.log(`  ! ${s.grammar.padEnd(10)} ${s.rel} (${s.bytes}b)`);
  }
  if (zero.length) {
    console.log(`zero-anchor source files (first 15 — eyeball for blind spots):`);
    for (const s of zero.slice(0, 15)) console.log(`  0 ${s.grammar.padEnd(10)} ${s.rel} (${s.bytes}b)`);
  }
}

for (const root of process.argv.slice(2)) {
  await report(root);
}
