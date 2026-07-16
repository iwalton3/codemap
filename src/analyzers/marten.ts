/**
 * Opt-in Marten/Wolverine analyzer — consistency checks first.
 *
 * NOT part of the codebase-agnostic core: this is a plugin that keys off
 * Marten/Wolverine conventions to find the bugs that hand-review of an
 * event-sourced backend can't (the CLAUDE.md #8/#33 shapes). It does its own
 * tree-sitter C# pass because the base indexer doesn't capture parameter types,
 * base lists, or `new EventT()` call arguments.
 *
 * Detection (all confirmed against real code):
 *   fold       aggregate.Apply(EventT)                          → EventT folds→ aggregate
 *   project    projection.Transform(IEvent<EventT>) / Apply(T)  → EventT projected
 *   emit       session.Events.Append/StartStream(…, new EventT) → EventT emitted
 *   command    record : IIntentCommand / ILineCommand           → a command
 *   handler    Handle/Consume(CommandT, …)                      → handles CommandT
 */

import { readFile } from "node:fs/promises";
import type { Node } from "web-tree-sitter";
import { listSupportedFiles, toPosixRel } from "../fs-scan.js";
import { grammarForPath, parserForPath } from "../grammars.js";

// Convention config — the Acme defaults; a real deployment could override these.
const COMMAND_MARKERS = new Set(["IIntentCommand", "ILineCommand", "ICommand"]);
const PROJECTION_BASES = new Set(["EventProjection", "SingleStreamProjection", "MultiStreamProjection"]);
const APPEND_MEMBERS = new Set(["Append", "StartStream", "AppendOptimistic", "AppendExclusive"]);

interface Where {
  file: string;
  line: number;
}

interface Model {
  folded: Map<string, Where & { aggregate: string }>; // event → aggregate that Apply()s it
  projected: Map<string, Where & { projection: string }>; // event → projection
  appended: Map<string, Where>; // event → a place it's `new`'d into an append
  commands: Map<string, Where>; // command record → where declared
  consumed: Set<string>; // any type that is a parameter of a Handle/Consume/endpoint (command handled, or event consumed)
  endpointFiles: Set<string>; // files containing a Wolverine/HTTP endpoint (GET endpoints bind command fields from the query string, not as a param)
  snapshotted: Set<string>; // aggregates registered via Snapshot<T>/SingleStreamProjection<T> (self-projecting)
  events: Set<string>; // union of all event names seen
  aggregateDecls: Map<string, Where>; // aggregate type name → where declared (for emission)
  projectionDecls: Map<string, Where>; // projection type name → where declared
  records: Map<string, Where>; // every record decl name → where (to resolve event record anchors)
  handlers: Map<string, HandlerInfo>; // "file:line" → a handler/endpoint method (for emits/handles edges)
}

interface HandlerInfo {
  name: string; // "ContainingType.Method"
  file: string;
  line: number;
  params: string[]; // parameter type names (⊇ the command handled)
  emits: string[]; // event types `new`'d into Events.Append/StartStream in its body
}

/** A command marker interface by convention (IAcmeCommand, IIntentCommand, ILineCommand, …). */
const isCommandMarker = (name: string) => COMMAND_MARKERS.has(name) || /^I[A-Za-z]*Command$/.test(name);

// --- AST helpers -------------------------------------------------------------

function typeToName(t: Node | null): string | null {
  if (!t) return null;
  switch (t.type) {
    case "identifier":
    case "predefined_type":
      return t.text;
    case "generic_name":
      return t.namedChild(0)?.text ?? null; // outer name, e.g. IEvent
    case "nullable_type":
      return typeToName(t.namedChild(0));
    case "qualified_name":
      return t.namedChildren.at(-1)?.text ?? null;
    default:
      return t.text;
  }
}

function genericArgs(t: Node | null): string[] {
  if (t?.type !== "generic_name") return [];
  const tal = t.namedChildren.find((c) => c.type === "type_argument_list");
  return tal ? tal.namedChildren.map(typeToName).filter((x): x is string => Boolean(x)) : [];
}

function baseNames(typeDecl: Node): string[] {
  const bl = typeDecl.namedChildren.find((c) => c.type === "base_list");
  return bl ? bl.namedChildren.map(typeToName).filter((x): x is string => Boolean(x)) : [];
}

function firstParamType(method: Node): Node | null {
  const pl = method.childForFieldName("parameters");
  const param = pl?.namedChildren.find((c) => c.type === "parameter");
  return param?.childForFieldName("type") ?? null;
}

/** All parameter type names of a method (a command may not be the first param — routes bind ids first). */
function paramTypeNames(method: Node): string[] {
  const pl = method.childForFieldName("parameters");
  const out: string[] = [];
  for (const p of pl?.namedChildren ?? []) {
    if (p.type !== "parameter") continue;
    const t = typeToName(p.childForFieldName("type"));
    if (t) out.push(t);
  }
  return out;
}

/** Attribute names on a method, e.g. ["WolverinePost", "Authorize"]. */
function methodAttributes(method: Node): string[] {
  const names: string[] = [];
  for (const c of method.namedChildren) {
    if (c.type !== "attribute_list") continue;
    for (const attr of c.namedChildren) {
      if (attr.type !== "attribute") continue;
      const t = typeToName(attr.childForFieldName("name") ?? attr.namedChild(0));
      if (t) names.push(t);
    }
  }
  return names;
}

/** A method that dispatches a command: a Wolverine message Handle/Consume, or an HTTP endpoint. */
function isHandlerMethod(name: string | undefined, attrs: string[]): boolean {
  return name === "Handle" || name === "Consume" || attrs.some((a) => /^Wolverine/.test(a) || /^Http(Post|Get|Put|Delete|Patch)$/.test(a));
}

/** All `new T()` type names anywhere under `node` (filtered to known events by the caller). */
function constructedTypesUnder(node: Node): string[] {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.type === "object_creation_expression") {
      const t = typeToName(n.childForFieldName("type"));
      if (t) out.push(t);
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/** Event types constructed into an Events.Append/StartStream call anywhere under `node`. */
function appendedEventsUnder(node: Node): { event: string; line: number }[] {
  const out: { event: string; line: number }[] = [];
  const walk = (n: Node) => {
    if (n.type === "invocation_expression") {
      const fn = n.childForFieldName("function");
      if (fn?.type === "member_access_expression") {
        const mnNode = fn.childForFieldName("name");
        const mn = mnNode?.type === "generic_name" ? mnNode.namedChild(0)?.text : mnNode?.text;
        const onEvents = /(^|\.)Events$/.test(fn.childForFieldName("expression")?.text ?? "");
        if (mn && APPEND_MEMBERS.has(mn) && onEvents) {
          for (const arg of n.childForFieldName("arguments")?.namedChildren ?? []) {
            const expr = arg.type === "argument" ? arg.namedChild(0) : arg;
            if (expr?.type === "object_creation_expression") {
              const ev = typeToName(expr.childForFieldName("type"));
              if (ev) out.push({ event: ev, line: n.startPosition.row + 1 });
            }
          }
        }
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

/** The event a method folds/projects: Apply(T)→T, Transform(IEvent<T>)→T. */
function eventOfMethod(method: Node): string | null {
  const t = firstParamType(method);
  if (!t) return null;
  if (t.type === "generic_name") return genericArgs(t)[0] ?? null; // IEvent<T>
  return typeToName(t);
}

/** Return type, unwrapping Task<T>/ValueTask<T>. */
function returnTypeName(method: Node): string | null {
  const rt = method.childForFieldName("returns");
  if (!rt) return null;
  if (rt.type === "generic_name") {
    const outer = rt.namedChild(0)?.text;
    return outer === "Task" || outer === "ValueTask" ? (genericArgs(rt)[0] ?? outer ?? null) : (outer ?? null);
  }
  return typeToName(rt);
}

/**
 * A fold method. Marten aggregates use Apply(Event) for subsequent events and
 * Create(Event) for the first — the latter only when it returns the aggregate
 * itself (so it isn't confused with an endpoint `Create(Request)` method).
 * Projections use Transform(IEvent<T>) / Apply(T).
 */
function isFoldMethod(name: string | undefined, method: Node, containingType: string): boolean {
  if (name === "Apply" || name === "Transform") return true;
  return name === "Create" && returnTypeName(method) === containingType;
}

const TYPE_DECLS = new Set(["class_declaration", "record_declaration", "struct_declaration"]);

// --- extraction --------------------------------------------------------------

function collectFromFile(root: Node, file: string, m: Model): void {
  const walk = (node: Node) => {
    if (TYPE_DECLS.has(node.type)) {
      const name = node.childForFieldName("name")?.text ?? "?";
      const bases = baseNames(node);
      const isProjection = bases.some((b) => PROJECTION_BASES.has(b));
      const line = node.startPosition.row + 1;

      if (node.type === "record_declaration") {
        m.records.set(name, { file, line });
        // command record?
        if (bases.some(isCommandMarker)) m.commands.set(name, { file, line });
      }

      // methods on this type
      const body = node.childForFieldName("body");
      for (const member of body?.namedChildren ?? []) {
        if (member.type !== "method_declaration") continue;
        const mname = member.childForFieldName("name")?.text;
        const mline = member.startPosition.row + 1;
        const attrs = methodAttributes(member);
        if (isFoldMethod(mname, member, name)) {
          const ev = eventOfMethod(member);
          if (ev) {
            m.events.add(ev);
            if (isProjection) {
              m.projected.set(ev, { file, line: mline, projection: name });
              if (!m.projectionDecls.has(name)) m.projectionDecls.set(name, { file, line });
            } else {
              m.folded.set(ev, { file, line: mline, aggregate: name });
              if (!m.aggregateDecls.has(name)) m.aggregateDecls.set(name, { file, line });
            }
          }
        } else if (isHandlerMethod(mname, attrs)) {
          // The command may be any parameter (route ids bind first), so mark all.
          const params = paramTypeNames(member);
          for (const t of params) m.consumed.add(t);
          if (attrs.some((a) => /^Wolverine/.test(a) || /^Http/.test(a))) m.endpointFiles.add(file);
          // Broad: any event `new`'d in the body (incl. via a local var), filtered to
          // known events at emission — the strict Append-arg form misses variable emits.
          const emits = [...new Set(constructedTypesUnder(member))];
          m.handlers.set(`${file}:${mline}`, { name: `${name}.${mname ?? "?"}`, file, line: mline, params, emits });
        }
      }
    }

    // snapshot registrations: Snapshot<T> / SingleStreamProjection<T> → T self-projects.
    if (node.type === "generic_name") {
      const outer = node.namedChild(0)?.text;
      if (outer === "Snapshot" || outer === "SingleStreamProjection") {
        const agg = genericArgs(node)[0];
        if (agg) m.snapshotted.add(agg);
      }
    }

    // emissions: Events.Append/StartStream(…, new EventT(…))
    if (node.type === "invocation_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "member_access_expression") {
        const memberName = fn.childForFieldName("name");
        const mn = memberName?.type === "generic_name" ? memberName.namedChild(0)?.text : memberName?.text;
        const onEvents = /(^|\.)Events$/.test(fn.childForFieldName("expression")?.text ?? "");
        if (mn && APPEND_MEMBERS.has(mn) && onEvents) {
          const args = node.childForFieldName("arguments");
          for (const arg of args?.namedChildren ?? []) {
            const expr = arg.type === "argument" ? arg.namedChild(0) : arg;
            if (expr?.type === "object_creation_expression") {
              const ev = typeToName(expr.childForFieldName("type"));
              if (ev) {
                m.events.add(ev);
                if (!m.appended.has(ev)) m.appended.set(ev, { file, line: node.startPosition.row + 1 });
              }
            }
          }
        }
      }
    }

    for (const c of node.children) walk(c);
  };
  walk(root);
}

// --- checks ------------------------------------------------------------------

export type Severity = "warn" | "info";
export interface Finding {
  check: string;
  severity: Severity;
  entity: string;
  message: string;
  file?: string;
  line?: number;
}

function runChecks(m: Model, verbose: boolean): Finding[] {
  const out: Finding[] = [];

  // 1. command with no handler — high signal (warn). Consumed = a handler/endpoint
  // param; or co-located with an endpoint in its file (GET query-bound commands).
  for (const [cmd, w] of m.commands) {
    if (!m.consumed.has(cmd) && !m.endpointFiles.has(w.file)) {
      out.push({ check: "command-no-handler", severity: "warn", entity: cmd, message: `command \`${cmd}\` has no handler or endpoint`, ...w });
    }
  }

  // 2. event appended but nothing folds, projects, OR consumes it (a message/notification
  // handler counts) — a true orphan (warn). Any one of those means it does something.
  for (const [ev, w] of m.appended) {
    if (!m.folded.has(ev) && !m.projected.has(ev) && !m.consumed.has(ev)) {
      out.push({ check: "appended-orphan", severity: "warn", entity: ev, message: `event \`${ev}\` is appended but nothing folds, projects, or consumes it (dead event?)`, ...w });
    }
  }

  if (!verbose) return out;

  // 3. folded event with no projection, on a NON-snapshot aggregate (info). Snapshot
  // aggregates are self-projecting, so folding without a separate projection is normal.
  for (const [ev, w] of m.folded) {
    if (!m.projected.has(ev) && !m.snapshotted.has(w.aggregate)) {
      out.push({ check: "folded-not-projected", severity: "info", entity: ev, message: `event \`${ev}\` is folded on non-snapshot aggregate \`${w.aggregate}\` but no projection Transforms it (read-model gap?)`, ...w });
    }
  }

  // 4. projected but no aggregate fold — often intentional (projection-only), surface anyway.
  for (const [ev, w] of m.projected) {
    if (!m.folded.has(ev)) {
      out.push({ check: "projected-not-folded", severity: "info", entity: ev, message: `event \`${ev}\` is projected on \`${w.projection}\` but no aggregate Apply()s it`, ...w });
    }
  }

  return out;
}

/** Parse a repo's C# and extract the Marten/Wolverine model (shared by checks + emission). */
export async function buildMartenModel(repoRoot: string): Promise<Model> {
  const m: Model = {
    folded: new Map(), projected: new Map(), appended: new Map(),
    commands: new Map(), consumed: new Set(), endpointFiles: new Set(), snapshotted: new Set(), events: new Set(),
    aggregateDecls: new Map(), projectionDecls: new Map(), records: new Map(), handlers: new Map(),
  };
  const files = (await listSupportedFiles(repoRoot)).filter((f) => grammarForPath(f) === "c_sharp");
  for (const abs of files) {
    const handle = await parserForPath(abs);
    if (!handle) continue;
    const tree = handle.parser.parse(await readFile(abs, "utf8"));
    if (tree) collectFromFile(tree.rootNode, toPosixRel(repoRoot, abs), m);
  }
  return m;
}

export type MartenModel = Model;

export async function analyzeMarten(repoRoot: string, opts: { verbose?: boolean } = {}): Promise<{
  summary: { events: number; commands: number; aggregatesFolds: number; projections: number; snapshots: number; warnings: number; info: number };
  findings: Finding[];
  note: string;
}> {
  const m = await buildMartenModel(repoRoot);
  const findings = runChecks(m, opts.verbose ?? false).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1));
  return {
    summary: {
      events: m.events.size, commands: m.commands.size, aggregatesFolds: m.folded.size,
      projections: m.projected.size, snapshots: m.snapshotted.size,
      warnings: findings.filter((f) => f.severity === "warn").length,
      info: findings.filter((f) => f.severity === "info").length,
    },
    findings,
    note: "Emission detection sees `new EventT()` into Events.Append/StartStream; events appended via a local variable are a known blind spot. Info checks (verbose) are review candidates, not confirmed bugs.",
  };
}
