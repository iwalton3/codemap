/**
 * Indexer: a parsed file -> anchors.
 *
 * Grain (chosen): one anchor per callable (function / method / constructor,
 * hashing its whole body) PLUS a "shell" anchor per type (class / interface /
 * struct / record / enum) whose hash covers the type's structure — fields,
 * property/base/attribute declarations, and method *signatures* — but NOT the
 * method bodies. So a method edit flags that method; a structural edit (new
 * field, changed base) flags the type shell; neither drowns the other in noise.
 *
 * Language specifics live in the small CONFIG table below; the walk is generic.
 */

import type { Node } from "web-tree-sitter";
import { type Anchor, type AnchorKind, anchorId } from "./schema.js";
import { hashTokens } from "./normalize.js";
import { derivationTag, type GrammarName } from "./grammars.js";

interface LangConfig {
  /** Type declarations: emit a shell anchor AND recurse into as a container. */
  typeDecl: Set<string>;
  /** Callable declarations: emit a body anchor. */
  callable: Set<string>;
  /** Namespace declarations: a name segment + container, but no anchor. */
  namespaceDecl: Set<string>;
}

const s = (...xs: string[]) => new Set(xs);

const CSHARP: LangConfig = {
  typeDecl: s(
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "record_declaration",
    "record_struct_declaration",
    "enum_declaration",
  ),
  callable: s(
    "method_declaration",
    "constructor_declaration",
    "destructor_declaration",
    "operator_declaration",
  ),
  namespaceDecl: s("namespace_declaration", "file_scoped_namespace_declaration"),
};

const PYTHON: LangConfig = {
  typeDecl: s("class_definition"),
  callable: s("function_definition"),
  namespaceDecl: s(),
};

const JS: LangConfig = {
  typeDecl: s("class_declaration"),
  callable: s("function_declaration", "generator_function_declaration", "method_definition"),
  namespaceDecl: s(),
};

const TS: LangConfig = {
  typeDecl: s(
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "enum_declaration",
  ),
  callable: s("function_declaration", "generator_function_declaration", "method_definition"),
  namespaceDecl: s("internal_module", "module"),
};

const CONFIG: Record<GrammarName, LangConfig> = {
  c_sharp: CSHARP,
  python: PYTHON,
  javascript: JS,
  typescript: TS,
  tsx: TS,
};

const KIND_BY_TYPE: Record<string, AnchorKind> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  class_definition: "class",
  interface_declaration: "interface",
  struct_declaration: "struct",
  record_declaration: "record",
  record_struct_declaration: "record",
  enum_declaration: "enum",
  method_declaration: "method",
  method_definition: "method",
  constructor_declaration: "constructor",
  destructor_declaration: "method",
  operator_declaration: "method",
  function_declaration: "function",
  generator_function_declaration: "function",
  function_definition: "function",
};

const isComment = (n: Node): boolean => n.type.includes("comment");

/**
 * `#region` / `#endregion` — organisation, not code.
 *
 * The whole subtree goes, so both the keyword and the region NAME leave the hash:
 * adding, removing or renaming a region is a cosmetic edit, and discarding
 * cosmetics is what normalization is for. Before this, renaming a region flipped
 * the enclosing type's shell hash and staled every mark on it — 180 anchors across
 * 176 files on one live C# repo, none of which had changed.
 *
 * Scoped by NODE, not by token type, on purpose. `preproc_arg` looked like the
 * handle but is the wrong one twice over: `#if DEBUG` carries its condition as an
 * `identifier` (so conditional compilation is untouched either way), while
 * `#warning` / `#error` carry their message AS a `preproc_arg` and those are
 * diagnostics the build emits, not layout.
 */
const isRegionType = (t: string): boolean => t === "preproc_region" || t === "preproc_endregion";

/**
 * Line endings inside a token that spans lines.
 *
 * Whitespace BETWEEN tokens never reaches the hash — only leaf tokens are emitted —
 * but a leaf that spans lines carries its own: C# verbatim/raw strings, Python
 * triple-quotes, JS template literals, JSX text. So the same file hashed on Windows
 * and on Linux disagreed, which reads as drift and is not.
 *
 * CR is stripped rather than normalized to CRLF because LF is what git stores and
 * what every non-Windows checkout has.
 */
function leafText(n: Node): string {
  // `node.text` is a wasm-boundary getter that materialises a fresh JS string on
  // every read, onto a heap that is not garbage-collected (see `parserForPath`).
  // Reading it twice per leaf — once to test, once to return — doubled the
  // allocations for every token in every file and made the indexer intermittently
  // wedge. Read once.
  const t = n.text;
  return t.includes("\r") ? t.replace(/\r/g, "") : t;
}

/** Collect terminal tokens under `node`, skipping comment and region subtrees. */
function collectLeaves(node: Node, out: string[], skipSpans?: Set<string>): void {
  // `type` and `text` are wasm-boundary getters, each materialising a fresh JS
  // value on a heap that is not garbage-collected. This runs once per NODE in
  // every file indexed, so reading either more than once here is not a style
  // point — it multiplies allocations across the whole tree.
  const type = node.type;
  if (type.includes("comment") || isRegionType(type)) return;
  if (skipSpans && skipSpans.has(`${node.startIndex}:${node.endIndex}`)) return;
  if (node.childCount === 0) {
    out.push(leafText(node));
    return;
  }
  for (const child of node.children) collectLeaves(child, out, skipSpans);
}

function callableTokens(node: Node): string[] {
  const out: string[] = [];
  collectLeaves(node, out);
  return out;
}

/** Shell = the type's tokens minus every callable body it contains. */
function shellTokens(typeNode: Node, cfg: LangConfig): string[] {
  const skip = new Set<string>();
  for (const call of typeNode.descendantsOfType([...cfg.callable])) {
    const body = call.childForFieldName("body");
    if (body) skip.add(`${body.startIndex}:${body.endIndex}`);
  }
  const out: string[] = [];
  collectLeaves(typeNode, out, skip);
  return out;
}

/**
 * What tells two same-named callables apart: their parameter TYPES.
 *
 * The disambiguator used to be the overload's ordinal position in its scope, which
 * is not an identity at all. Deleting `Apply(OrderCreated)` renumbered every later
 * `Apply`, so each one inherited a sibling's anchor id — and a diff then reported
 * `Apply(QuoteTicketCreated)` as having "changed" into
 * `Apply(QuoteReleaseCreditStatusUpdated)` and showed two unrelated bodies side
 * by side. Reviews, triage and citations key on that id, so they retargeted with
 * it. Merely reordering methods in a file did the same, against the documented
 * invariant that an id is stable across line-moves.
 *
 * Types and the modifiers that distinguish an overload (`ref`/`out`/`in`) — never
 * the parameter's NAME and never a default VALUE. Letting either in would orphan
 * every review on a method whose parameter was renamed, instead of leaving the mark
 * intact, and it would break the documented invariant that only a file or symbol
 * rename moves an id. A parameter declared without a type contributes a bare slot,
 * because arity is genuinely all such a signature carries.
 */
function signatureKey(node: Node): string | undefined {
  const params = node.childForFieldName("parameters");
  if (!params) return undefined;
  const parts: string[] = [];
  // A `params`/varargs parameter is not wrapped in a `parameter` node by the C#
  // grammar: the list's children are the TYPE and then a bare identifier naming it.
  let expectName = false;
  for (const c of params.namedChildren) {
    if (expectName && c.type === "identifier") { expectName = false; continue; }   // that name
    expectName = false;
    const type = c.childForFieldName("type");
    const mods = c.namedChildren.filter((x) => x.type === "modifier").map((x) => x.text);
    if (type) { parts.push([...mods, type.text].join(" ").replace(/\s+/g, "")); continue; }
    if (c.childForFieldName("name") || c.childForFieldName("pattern") || /parameter/.test(c.type)) {
      // Declared without a type — Python, JS. Nothing but the slot is signature,
      // and saying so is honest: arity is all these languages overload on.
      parts.push(mods.length ? `${mods.join("")}_` : "_");
      continue;
    }
    // A bare type sitting directly under the list; its name follows.
    parts.push(c.text.replace(/\s+/g, ""));
    expectName = true;
  }
  return `(${parts.join(",")})`;
}

type ItemKind = "type" | "callable" | "nsBlock" | "nsFile";

interface Item {
  name: string;
  kind: ItemKind;
  anchorKind: AnchorKind;
  /** Node used to read the `body` field / recurse. */
  defNode: Node;
  /** Node whose tokens are hashed (differs from defNode for decorated defs). */
  hashNode: Node;
}

const kindFor = (type: string): AnchorKind => KIND_BY_TYPE[type] ?? "function";

// Exported-const initializers worth anchoring as a `variable`: config object/array
// literals, singleton `new X()` instances, and factory calls (e.g. TanStack's
// `createFileRoute(...)({...})`, `createRouter(...)`, zustand `create(...)`). These
// carry structure/behavior a doc wants to cite but aren't functions. Scalars,
// identifiers, and member accesses are skipped as trivial.
const SIGNIFICANT_INIT = s("object", "array", "new_expression", "call_expression");
function isSignificantInitializer(val: Node): boolean {
  let v: Node | null = val;
  // Unwrap `... as const` / `... satisfies T` to the underlying expression.
  while (v && (v.type === "as_expression" || v.type === "satisfies_expression")) {
    const inner = v.namedChild(0);
    if (!inner || inner === v) break;
    v = inner;
  }
  return !!v && SIGNIFICANT_INIT.has(v.type);
}

/** Turn one member node into 0..n indexable items, unwrapping wrappers. */
function classify(node: Node, cfg: LangConfig, exported = false): Item[] {
  const t = node.type;

  // `export ...` (JS/TS) — index the inner declaration (and remember it's exported).
  if (t === "export_statement") {
    const decl = node.childForFieldName("declaration");
    return decl ? classify(decl, cfg, true) : [];
  }

  // `@decorator def ...` (Python) — hash the whole thing so decorators count.
  if (t === "decorated_definition") {
    const inner = node.childForFieldName("definition") ?? node.namedChildren.at(-1);
    if (!inner) return [];
    return classify(inner, cfg, exported).map((it) => ({ ...it, hashNode: node }));
  }

  // `const f = () => {}` / `const f = function () {}` (JS/TS) — always anchored.
  // Additionally, an EXPORTED `const x = {…} | [...] | new X() | factory(…)` is
  // anchored as a `variable` (config objects, singletons, route consts) — hashing
  // its whole initializer, no recursion (so nested arrows don't spawn sub-anchors).
  if (t === "lexical_declaration" || t === "variable_declaration") {
    const out: Item[] = [];
    for (const d of node.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name")?.text;
      if (!name) continue;
      const val = d.childForFieldName("value");
      if (val && (val.type === "arrow_function" || val.type === "function_expression")) {
        out.push({ name, kind: "callable", anchorKind: "function", defNode: d, hashNode: d });
      } else if (exported && val && isSignificantInitializer(val)) {
        out.push({ name, kind: "callable", anchorKind: "variable", defNode: d, hashNode: d });
      }
    }
    return out;
  }

  if (cfg.namespaceDecl.has(t)) {
    const name = node.childForFieldName("name")?.text ?? "<ns>";
    const kind: ItemKind = t.startsWith("file_scoped") ? "nsFile" : "nsBlock";
    return [{ name, kind, anchorKind: "namespace", defNode: node, hashNode: node }];
  }

  if (cfg.typeDecl.has(t)) {
    const name = node.childForFieldName("name")?.text;
    return name ? [{ name, kind: "type", anchorKind: kindFor(t), defNode: node, hashNode: node }] : [];
  }

  if (cfg.callable.has(t)) {
    const name = node.childForFieldName("name")?.text ?? (t === "constructor_declaration" ? "ctor" : null);
    if (!name) return [];
    const anchorKind: AnchorKind = name === "constructor" ? "constructor" : kindFor(t);
    return [{ name, kind: "callable", anchorKind, defNode: node, hashNode: node }];
  }

  return [];
}

export function indexSource(
  source: string,
  file: string,
  grammar: GrammarName,
  root: Node,
): Anchor[] {
  const cfg = CONFIG[grammar];
  const tag = derivationTag(grammar);
  const anchors: Anchor[] = [];

  const push = (
    symbolPath: string[],
    kind: AnchorKind,
    disambiguator: string | undefined,
    tokens: string[],
    locNode: Node,
  ) => {
    anchors.push({
      id: anchorId(file, symbolPath, disambiguator),
      file,
      symbolPath,
      kind,
      disambiguator,
      bodyHash: hashTokens(tokens, tag),
      // Stamped at the ONE place anchors are born, so nothing downstream has to
      // remember to. What produced this id and hash is a fact about them, and a
      // later reader cannot recover it from anywhere else.
      //
      // Twice over, and not redundantly: the row's tag describes THIS row, while
      // the fingerprint inside the hash travels with the value into witnesses and
      // sidecar events, where no row of ours goes.
      derivation: tag,
      lastVerifiedCommit: null,
      loc: {
        startByte: locNode.startIndex,
        endByte: locNode.endIndex,
        startLine: locNode.startPosition.row + 1,
        endLine: locNode.endPosition.row + 1,
      },
    });
  };

  const key = (path: string[], name: string) => path.join("\0") + "\0" + name;

  const processScope = (scope: Node, basePath: string[]): void => {
    // Pass 1: expand members to items, tracking the effective path. A C#
    // file-scoped namespace has no body — it re-roots every following sibling.
    const entries: { item: Item; path: string[] }[] = [];
    let path = basePath;
    for (const member of scope.namedChildren) {
      for (const item of classify(member, cfg)) {
        if (item.kind === "nsFile") {
          path = [...path, item.name];
          continue;
        }
        entries.push({ item, path });
      }
    }

    // Pass 2: disambiguate overloads/duplicates by ordinal within (path,name),
    // emit anchors, and recurse into type/namespace bodies.
    const totals = new Map<string, number>();
    for (const e of entries) {
      if (e.item.kind === "nsBlock") continue;
      const k = key(e.path, e.item.name);
      totals.set(k, (totals.get(k) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const usedKeys = new Set<string>();
    for (const { item, path: p } of entries) {
      if (item.kind === "nsBlock") {
        const body = item.defNode.childForFieldName("body");
        if (body) processScope(body, [...p, item.name]);
        continue;
      }
      const k = key(p, item.name);
      let disambiguator: string | undefined;
      if ((totals.get(k) ?? 0) > 1) {
        const i = seen.get(k) ?? 0;
        seen.set(k, i + 1);
        const sig = item.kind === "callable" ? signatureKey(item.defNode) : undefined;
        // Fall back to the ordinal only when there is no signature to go on (a
        // non-callable, or a grammar with no parameter list here), or when two
        // same-named items genuinely share one — otherwise they would collide onto
        // a single id, which is worse than an unstable one.
        disambiguator = sig && !usedKeys.has(`${k}\0${sig}`) ? sig : `${sig ?? ""}#${i}`;
        usedKeys.add(`${k}\0${sig ?? String(i)}`);
      }
      const symbolPath = [...p, item.name];
      if (item.kind === "callable") {
        push(symbolPath, item.anchorKind, disambiguator, callableTokens(item.hashNode), item.hashNode);
      } else {
        push(symbolPath, item.anchorKind, disambiguator, shellTokens(item.defNode, cfg), item.defNode);
        const body = item.defNode.childForFieldName("body");
        if (body) processScope(body, symbolPath);
      }
    }
  };

  processScope(root, []);
  return anchors;
}

/**
 * Anchors this index produced that share an id — which is supposed to be nobody.
 *
 * An id is a digest of `file + symbolPath + disambiguator`, and a container's
 * disambiguator is NOT carried into its children's path. So two `partial class C`
 * declarations in one file give their members `["C","M"]` with no disambiguator
 * each — one id, two methods. `anchors` is keyed `(ref, id)` and written
 * `INSERT OR REPLACE`, so the loser silently ceases to exist for the whole map.
 *
 * Measured at 0 groups in 18,761 anchors across five repositories: real `partial`
 * classes live in different files, and the file is the first field of the digest.
 * Latent rather than active — which is why this reports instead of refusing, and
 * why the derivation fix (carry the container's disambiguator down) waits for the
 * next `ANCHOR_SCHEME` bump rather than forcing one.
 *
 * It also makes "at most one anchor per id" checkable, which
 * `docs/anchor-id-provenance.md` § Recovery needs: identifying what an old id named
 * is only sound if the answer cannot be two symbols.
 */
export function collidingAnchors(anchors: readonly Anchor[]): Map<string, Anchor[]> {
  const byId = new Map<string, Anchor[]>();
  for (const a of anchors) (byId.get(a.id) ?? byId.set(a.id, []).get(a.id)!).push(a);
  for (const [id, list] of byId) if (list.length < 2) byId.delete(id);
  return byId;
}
