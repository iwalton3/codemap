/**
 * Grammar loading: file path -> a tree-sitter Parser for the right language.
 *
 * Grammars are inert `.wasm` blobs vendored under `grammars/` (see
 * grammars/PROVENANCE.md). Nothing is fetched or compiled at runtime.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { Parser, Language } from "web-tree-sitter";

// dist/grammars.js -> repo root -> grammars/
const GRAMMARS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "grammars");

export type GrammarName = "c_sharp" | "python" | "javascript" | "typescript" | "tsx";

const WASM_FILE: Record<GrammarName, string> = {
  c_sharp: "tree-sitter-c_sharp.wasm",
  python: "tree-sitter-python.wasm",
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
};

const EXT_TO_GRAMMAR: Record<string, GrammarName> = {
  ".cs": "c_sharp",
  ".py": "python",
  ".pyi": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
};

/** Grammar for a path, or null if the extension isn't one we map. */
export function grammarForPath(path: string): GrammarName | null {
  return EXT_TO_GRAMMAR[extname(path).toLowerCase()] ?? null;
}

let initPromise: Promise<void> | null = null;
const langCache = new Map<GrammarName, Language>();

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  await initPromise;
}

/** Load (and cache) a Language from its vendored wasm. */
export async function loadLanguage(name: GrammarName): Promise<Language> {
  await ensureInit();
  const cached = langCache.get(name);
  if (cached) return cached;
  const bytes = new Uint8Array(await readFile(join(GRAMMARS_DIR, WASM_FILE[name])));
  const lang = await Language.load(bytes);
  langCache.set(name, lang);
  return lang;
}

export interface ParserHandle {
  parser: Parser;
  grammar: GrammarName;
}

/** A ready-to-use Parser for a path, or null if the language is unsupported. */
export async function parserForPath(path: string): Promise<ParserHandle | null> {
  const grammar = grammarForPath(path);
  if (!grammar) return null;
  const lang = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  return { parser, grammar };
}
