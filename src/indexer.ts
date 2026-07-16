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
import type { GrammarName } from "./grammars.js";

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

/** Collect terminal tokens under `node`, skipping comment subtrees. */
function collectLeaves(node: Node, out: string[], skipSpans?: Set<string>): void {
  if (isComment(node)) return;
  if (skipSpans && skipSpans.has(`${node.startIndex}:${node.endIndex}`)) return;
  if (node.childCount === 0) {
    out.push(node.text);
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
      bodyHash: hashTokens(tokens),
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
        disambiguator = String(i);
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
