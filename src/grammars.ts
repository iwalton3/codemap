/**
 * Grammar loading: file path -> a tree-sitter Parser for the right language.
 *
 * Grammars are inert `.wasm` blobs vendored under `grammars/` (see
 * grammars/PROVENANCE.md). Nothing is fetched or compiled at runtime.
 */

import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { Parser, Language } from "web-tree-sitter";
import { ANCHOR_SCHEME, HASH_SCHEME, type DerivationTag } from "./schema.js";

// dist/grammars.js -> repo root -> grammars/
const GRAMMARS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "grammars");

export type GrammarName = "c_sharp" | "python" | "javascript" | "typescript" | "tsx";

/** Every grammar this build ships. */
export const GRAMMAR_NAMES: readonly GrammarName[] = ["c_sharp", "python", "javascript", "typescript", "tsx"];

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

/**
 * How this build derives ids and hashes, for one grammar.
 *
 * The two digests are what make it an identity rather than a label. A version
 * string authenticates nothing: two `web-tree-sitter` builds can carry the same
 * version and tokenize differently, and then a reader reports real-looking drift
 * for a change nobody made. So we hash what we actually load.
 *
 * `parserIntegrity` comes from the runtime FILES rather than from
 * `package-lock.json`, which is a development artifact and is not shipped to
 * somebody who installed this — the lockfile says what should be there, the files
 * are what is.
 *
 * Plural, and that word is the whole correction: an earlier version hashed what
 * `require.resolve` returned, which is the CommonJS loader — neither the ESM entry
 * this actually imports nor `web-tree-sitter.wasm`, which is the lexing engine and
 * therefore the thing that decides tokenization. A wasm-only difference — a
 * hand-patch, a platform rebuild, or the supply-chain substitution this project is
 * built to resist — would have tokenized differently under an identical tag. That
 * is precisely the "two builds under one label" failure the tag exists to prevent,
 * reproduced one file over.
 *
 * Computed once with sync reads: five grammar blobs plus the runtime is ~6ms, it
 * happens at most once per process, and `indexSource` needs the answer
 * synchronously while building each anchor.
 */
let tags: Map<GrammarName, DerivationTag> | null = null;

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * Every shipped runtime artifact, hashed together.
 *
 * By extension rather than by name: which file is the loader and which is the
 * engine is the package's business and has changed before. Sorted so the digest is
 * stable, and `.map`/`.d.ts` are excluded because they cannot affect tokenization.
 */
function runtimeIntegrity(): string {
  const dir = dirname(createRequire(import.meta.url).resolve("web-tree-sitter"));
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((f) => /\.(js|cjs|mjs|wasm)$/.test(f)).sort()) {
    h.update(f).update("\0").update(readFileSync(join(dir, f))).update("\0");
  }
  return h.digest("hex");
}

/**
 * What this build would mint, as an index's provenance.
 *
 * For a hash map produced by indexing IN PROCESS (`liveHashes` with no ref, which
 * re-parses the files rather than reading stored rows): the index being searched is
 * this build's output, so this build's tags are what an id must have been minted
 * under to appear in it.
 *
 * All five grammars rather than the ones the files happen to use. A superset only
 * ever makes a comparison MORE permissive — the direction that falls back to
 * today's answer — where narrowing it wrongly would report a real deletion as
 * undecidable.
 */
export function currentDerivations(): { tags: DerivationTag[]; anyUntagged: boolean } {
  return { tags: GRAMMAR_NAMES.map(derivationTag), anyUntagged: false };
}

export function derivationTag(grammar: GrammarName): DerivationTag {
  if (!tags) {
    // The runtime we import, resolved the way the import resolves it — not a
    // guessed path into node_modules.
    const parserIntegrity = runtimeIntegrity();
    tags = new Map();
    for (const name of Object.keys(WASM_FILE) as GrammarName[]) {
      tags.set(name, {
        anchorScheme: ANCHOR_SCHEME,
        hashScheme: HASH_SCHEME,
        parserIntegrity,
        grammarDigest: sha256(join(GRAMMARS_DIR, WASM_FILE[name])),
      });
    }
  }
  return tags.get(grammar)!;
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

const parserCache = new Map<GrammarName, Parser>();

/**
 * A ready-to-use Parser for a path, or null if the language is unsupported.
 *
 * The parser is CACHED per grammar and must not be `delete()`d by the caller.
 * `Parser` and `Tree` live in tree-sitter's wasm heap, which the JS collector does
 * not touch — minting one per file leaked both, and a process that indexed a few
 * large trees (`indexCommit` over a 2000-file C# repo, twice) died on a bare
 * `Aborted()` out of wasm. Long-lived processes reach this: `serve.js` and the MCP
 * server snapshot a commit on demand. Callers own the TREE and must delete it;
 * `indexFile`/`indexBlob` are the ones that do.
 *
 * Reuse is safe because `parse()` and the `indexSource` walk that consumes its
 * nodes are both synchronous, so no second caller can interleave with them.
 */
export async function parserForPath(path: string): Promise<ParserHandle | null> {
  const grammar = grammarForPath(path);
  if (!grammar) return null;
  const cached = parserCache.get(grammar);
  if (cached) return { parser: cached, grammar };
  const lang = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  parserCache.set(grammar, parser);
  return { parser, grammar };
}
