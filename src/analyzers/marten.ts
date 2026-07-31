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
 *   state      status-enum property + literal assignments in folds → per-aggregate
 *              state machine (states, event → target-state transitions, initials)
 */

import { readFile } from "node:fs/promises";
import type { Node } from "web-tree-sitter";
import { listSupportedFiles, toPosixRel } from "../fs-scan.js";
import { grammarForPath, parserForPath } from "../grammars.js";

// Convention config — the target repo's defaults; a real deployment could override these.
const COMMAND_MARKERS = new Set(["IIntentCommand", "ILineCommand", "ICommand"]);
const PROJECTION_BASES = new Set(["EventProjection", "SingleStreamProjection", "MultiStreamProjection"]);
const APPEND_MEMBERS = new Set(["Append", "StartStream", "AppendOptimistic", "AppendExclusive"]);

interface Where {
  file: string;
  line: number;
}

interface EnumDecl extends Where {
  members: string[];
}

/** A property (or positional record param) and its declared type name. */
interface TypeProp {
  prop: string;
  typeName: string;
  file: string;
  line: number;
  /** `= Enum.Member` default initializer — an initial state candidate. */
  defaultMember?: { typeName: string; member: string };
}

/** RHS of a state assignment: `Enum.Member` is a literal; anything else is runtime-determined. */
type AssignedValue = { kind: "literal"; typeName: string; member: string } | { kind: "dynamic" };

/** One property assignment inside an Apply/Create body — the raw material of a transition. */
interface FoldAssignment {
  aggregate: string;
  event: string;
  /** LHS property name; "?ctor" = a positional `new Agg(…)` argument (resolved against the enum later). */
  prop: string;
  rhs: AssignedValue;
  isCreate: boolean;
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
  enums: Map<string, EnumDecl[]>; // enum simple name → declarations (same name may recur across namespaces)
  guidStates: Map<string, EnumDecl[]>; // Guid state-constant classes (`static class FooStates { static Guid Draft = … }`)
  typeProps: Map<string, TypeProp[]>; // type name → property/positional-param candidates (enum resolved post-parse)
  foldAssignments: FoldAssignment[]; // per-assignment records from Apply/Create bodies (state transitions)
}

interface HandlerInfo {
  name: string; // "ContainingType.Method"
  file: string;
  line: number;
  params: string[]; // parameter type names (⊇ the command handled)
  emits: string[]; // event types `new`'d into Events.Append/StartStream in its body
  memberRefs: string[]; // unique member-access names in the body (guard detection: does it read `.Status`?)
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

/** Classify a value expression: `Enum.Member` → literal; anything else (ternary, switch, call, `e.X`…) → dynamic. */
function classifyValue(expr: Node | null): AssignedValue {
  if (expr?.type === "member_access_expression") {
    const tn = typeToName(expr.childForFieldName("expression"));
    const member = expr.childForFieldName("name")?.text;
    if (tn && member) return { kind: "literal", typeName: tn.split(".").pop()!, member };
  }
  return { kind: "dynamic" };
}

/**
 * Property assignments under a fold method: plain/`this.` assignments, `with { … }`
 * initializers, and positional `new <Agg>(…)` ctor args (recorded as "?ctor" and
 * resolved against the status enum later). Object initializers parse as
 * assignment_expressions, so `new Agg { Status = X }` needs no special case — but
 * initializers of OTHER constructed types are skipped so a `new LineItem { Status = … }`
 * can't masquerade as an aggregate transition.
 */
function stateAssignmentsUnder(method: Node, aggregate: string): { prop: string; rhs: AssignedValue; line: number }[] {
  const out: { prop: string; rhs: AssignedValue; line: number }[] = [];
  const walk = (n: Node, foreign: boolean) => {
    if (n.type === "assignment_expression" && !foreign) {
      const left = n.childForFieldName("left");
      const prop = left?.type === "identifier" ? left.text
        : left?.type === "member_access_expression" ? left.childForFieldName("name")?.text : undefined;
      if (prop) out.push({ prop, rhs: classifyValue(n.childForFieldName("right")), line: n.startPosition.row + 1 });
    }
    if (n.type === "with_expression" && !foreign) {
      for (const wi of n.namedChildren) {
        if (wi.type !== "with_initializer") continue;
        const prop = wi.namedChild(0)?.text;
        if (prop) out.push({ prop, rhs: classifyValue(wi.namedChild(1)), line: wi.startPosition.row + 1 });
      }
    }
    if (n.type === "object_creation_expression") {
      const isAgg = typeToName(n.childForFieldName("type")) === aggregate;
      if (isAgg) {
        for (const arg of n.childForFieldName("arguments")?.namedChildren ?? []) {
          const expr = arg.type === "argument" ? arg.namedChild(0) : arg;
          if (expr?.type === "member_access_expression") {
            const v = classifyValue(expr);
            if (v.kind === "literal") out.push({ prop: "?ctor", rhs: v, line: expr.startPosition.row + 1 });
          }
        }
      }
      for (const c of n.children) walk(c, !isAgg);
      return;
    }
    for (const c of n.children) walk(c, foreign);
  };
  walk(method, false);
  return out;
}

/** Names of Guid-typed fields/properties on a type body (the Guid state-constant shape). */
function guidMemberNames(body: Node | null): string[] {
  const out: string[] = [];
  for (const member of body?.namedChildren ?? []) {
    if (member.type === "field_declaration") {
      const vd = member.namedChildren.find((c) => c.type === "variable_declaration");
      if (typeToName(vd?.childForFieldName("type") ?? null) !== "Guid") continue;
      for (const d of vd?.namedChildren ?? []) {
        if (d.type !== "variable_declarator") continue;
        const n = d.childForFieldName("name")?.text ?? d.namedChild(0)?.text;
        if (n) out.push(n);
      }
    } else if (member.type === "property_declaration") {
      if (typeToName(member.childForFieldName("type")) !== "Guid") continue;
      const n = member.childForFieldName("name")?.text;
      if (n) out.push(n);
    }
  }
  return out;
}

/** Unique member-access names under a node (`hold.Status` → "Status") — for guard detection. */
function memberAccessNamesUnder(node: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.type === "member_access_expression") {
      const nm = n.childForFieldName("name");
      const t = nm?.type === "generic_name" ? nm.namedChild(0)?.text : nm?.text;
      if (t) out.add(t);
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return [...out];
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

      // members: enum-typed property candidates (state machines) + methods. The
      // enum may live in another file, so candidates are collected raw and
      // resolved against `m.enums` in deriveStateMachines.
      const body = node.childForFieldName("body");
      const props: TypeProp[] = [];
      for (const member of body?.namedChildren ?? []) {
        if (member.type === "property_declaration") {
          const tn = typeToName(member.childForFieldName("type"));
          const pn = member.childForFieldName("name")?.text;
          if (tn && pn) {
            const dv = classifyValue(member.childForFieldName("value"));
            props.push({
              prop: pn, typeName: tn, file, line: member.startPosition.row + 1,
              ...(dv.kind === "literal" ? { defaultMember: { typeName: dv.typeName, member: dv.member } } : {}),
            });
          }
          continue;
        }
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
              // Capture state transitions inline — `folded` keeps only the last
              // aggregate per event, so it can't source per-assignment records.
              for (const a of stateAssignmentsUnder(member, name)) {
                m.foldAssignments.push({ aggregate: name, event: ev, prop: a.prop, rhs: a.rhs, isCreate: mname === "Create", file, line: a.line });
              }
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
          m.handlers.set(`${file}:${mline}`, { name: `${name}.${mname ?? "?"}`, file, line: mline, params, emits, memberRefs: memberAccessNamesUnder(member) });
        }
      }

      // Guid state-constant class (`public static class FooStates { public static Guid Draft = … }`)
      // — a state vocabulary for aggregates whose status prop is a Guid id, not an enum
      // (the Acme.API reference-data pattern). Name-gated for precision; it only binds
      // to a machine when a status-ish Guid prop's fold assignments reference it.
      if (node.type === "class_declaration" && /stat(e|us)/i.test(name)) {
        const gm = guidMemberNames(body);
        if (gm.length >= 2) (m.guidStates.get(name) ?? m.guidStates.set(name, []).get(name)!).push({ file, line, members: gm });
      }

      // positional record / primary-ctor params are properties too
      const plist = node.namedChildren.find((c) => c.type === "parameter_list");
      for (const p of plist?.namedChildren ?? []) {
        if (p.type !== "parameter") continue;
        const tn = typeToName(p.childForFieldName("type"));
        const pn = p.childForFieldName("name")?.text;
        if (tn && pn) props.push({ prop: pn, typeName: tn, file, line: p.startPosition.row + 1 });
      }
      if (props.length) m.typeProps.set(name, [...(m.typeProps.get(name) ?? []), ...props]);
    }

    // enum declarations — the state vocabulary for per-aggregate machines
    if (node.type === "enum_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        const members = (node.childForFieldName("body")?.namedChildren ?? [])
          .filter((c) => c.type === "enum_member_declaration")
          .map((c) => c.childForFieldName("name")?.text)
          .filter((x): x is string => Boolean(x));
        (m.enums.get(name) ?? m.enums.set(name, []).get(name)!).push({ file, line: node.startPosition.row + 1, members });
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

// --- state machines ----------------------------------------------------------

export interface StateTransition {
  event: string;
  /** Statically-resolved target members (an if/else assigning two literals yields two). */
  targets: string[];
  /** Some assignment's target isn't statically resolvable (ternary/switch/call/cross-enum) — needs enrichment. */
  dynamic: boolean;
  isCreate: boolean;
  file: string;
  line: number;
}

export interface StateMachine {
  aggregate: string;
  /** The chosen status property. */
  prop: string;
  /** The state VOCABULARY type: an enum, or a Guid state-constant class (Acme.API pattern). */
  enumName: string;
  enumWhere: Where;
  members: string[];
  /** Create-assigned targets ∪ the property's default initializer. */
  initialMembers: string[];
  transitions: StateTransition[];
  /** Enum-typed properties NOT tracked (surfaced by `status-prop-ambiguous`). */
  otherEnumProps: string[];
}

/**
 * Per-aggregate state machine, derived post-parse (the status enum may live in a
 * different file than the aggregate). ONE machine per aggregate — the emission id
 * convention (mtr-<agg>-<event>) can't address two — so when several enum-typed
 * properties exist the status-ish one wins and the rest become a finding.
 */
export function deriveStateMachines(m: Model): StateMachine[] {
  const out: StateMachine[] = [];
  for (const [agg] of m.aggregateDecls) {
    const assigns = (prop: string) => m.foldAssignments.filter((a) => a.aggregate === agg && a.prop === prop);
    // Vocabulary binding: an enum-typed prop binds by TYPE; a Guid-typed status-ish
    // prop binds by USAGE — the state-constant class its default/fold assignments
    // reference (majority wins so one stray cross-class literal can't flip it).
    const bind = (p: TypeProp): { vocabName: string; decls: EnumDecl[] } | null => {
      const byType = m.enums.get(p.typeName);
      if (byType) return { vocabName: p.typeName, decls: byType };
      if (p.typeName === "Guid" && /stat(e|us)/i.test(p.prop)) {
        const refs = [
          ...(p.defaultMember ? [p.defaultMember.typeName] : []),
          ...assigns(p.prop).flatMap((a) => (a.rhs.kind === "literal" ? [a.rhs.typeName] : [])),
        ].filter((t) => m.guidStates.has(t));
        if (refs.length) {
          const counts = new Map<string, number>();
          for (const t of refs) counts.set(t, (counts.get(t) ?? 0) + 1);
          const vocabName = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
          return { vocabName, decls: m.guidStates.get(vocabName)! };
        }
      }
      return null;
    };
    const candidates = (m.typeProps.get(agg) ?? [])
      .map((p) => ({ p, b: bind(p) }))
      .filter((x): x is { p: TypeProp; b: { vocabName: string; decls: EnumDecl[] } } => x.b !== null);
    if (!candidates.length) continue;
    const statusish = candidates.filter((x) => /status|state|phase|stage|lifecycle/i.test(x.p.prop));
    const isStatusish = statusish.length > 0;
    const pool = isStatusish ? statusish : candidates;
    const bestC = pool.reduce((a, b) => (assigns(b.p.prop).length > assigns(a.p.prop).length ? b : a));
    const best = bestC.p;
    const vocabName = bestC.b.vocabName;
    const en = bestC.b.decls.find((e) => e.file === best.file) ?? bestC.b.decls[0]!; // prefer same-file on name collision
    const members = new Set(en.members);
    const resolves = (v: AssignedValue): v is { kind: "literal"; typeName: string; member: string } =>
      v.kind === "literal" && v.typeName === vocabName && members.has(v.member);

    // "?ctor" args are positional guesses — they count only when they resolve to
    // this machine's vocabulary; real prop assignments count always (unresolvable ⇒ dynamic).
    const relevant = m.foldAssignments.filter((a) => a.aggregate === agg &&
      (a.prop === best.prop || (a.prop === "?ctor" && resolves(a.rhs))));
    if (!relevant.length) continue; // status prop never assigned in folds — not a state machine
    // A prop that isn't status-named qualifies only with ≥1 statically-resolved
    // target: type/kind DISCRIMINATORS copied from a command payload (`Type =
    // cmd.Type`) look like all-dynamic machines and are pure noise (the Acme.API
    // CustomFieldType/Order false-positive class). A status-NAMED prop keeps
    // its machine even when fully dynamic — the name signals intent and the
    // dynamic transitions are exactly the enrichment queue.
    if (!isStatusish && !relevant.some((a) => resolves(a.rhs))) continue;

    const byEvent = new Map<string, FoldAssignment[]>();
    for (const a of relevant) (byEvent.get(a.event) ?? byEvent.set(a.event, []).get(a.event)!).push(a);
    const transitions: StateTransition[] = [...byEvent.entries()].map(([event, as]) => ({
      event,
      targets: [...new Set(as.flatMap((a) => (resolves(a.rhs) ? [a.rhs.member] : [])))],
      dynamic: as.some((a) => !resolves(a.rhs)),
      isCreate: as.some((a) => a.isCreate),
      file: as[0]!.file,
      line: as[0]!.line,
    }));
    const initial = new Set<string>(transitions.filter((t) => t.isCreate).flatMap((t) => t.targets));
    if (best.defaultMember && best.defaultMember.typeName === vocabName && members.has(best.defaultMember.member)) {
      initial.add(best.defaultMember.member);
    }
    out.push({
      aggregate: agg, prop: best.prop, enumName: vocabName, enumWhere: { file: en.file, line: en.line },
      members: en.members, initialMembers: [...initial], transitions,
      otherEnumProps: candidates.filter((c) => c !== bestC).map((c) => c.p.prop),
    });
  }
  return out;
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

function runChecks(m: Model, machines: StateMachine[], verbose: boolean): Finding[] {
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

  // 3. unreachable state — no transition targets it and it isn't initial (warn).
  // Only when every transition is statically resolved: a dynamic one may reach anything.
  for (const mach of machines) {
    if (mach.transitions.some((t) => t.dynamic)) continue;
    const reachable = new Set(mach.transitions.flatMap((t) => t.targets));
    for (const s of mach.members) {
      if (!reachable.has(s) && !mach.initialMembers.includes(s)) {
        out.push({ check: "state-unreachable", severity: "warn", entity: `${mach.aggregate}.${s}`, message: `state \`${s}\` of \`${mach.aggregate}\` is never assigned by any fold and is not an initial state (unreachable?)`, ...mach.enumWhere });
      }
    }
  }

  if (!verbose) return out;

  // 4. folded event with no projection, on a NON-snapshot aggregate (info). Snapshot
  // aggregates are self-projecting, so folding without a separate projection is normal.
  for (const [ev, w] of m.folded) {
    if (!m.projected.has(ev) && !m.snapshotted.has(w.aggregate)) {
      out.push({ check: "folded-not-projected", severity: "info", entity: ev, message: `event \`${ev}\` is folded on non-snapshot aggregate \`${w.aggregate}\` but no projection Transforms it (read-model gap?)`, ...w });
    }
  }

  // 5. projected but no aggregate fold — often intentional (projection-only), surface anyway.
  for (const [ev, w] of m.projected) {
    if (!m.folded.has(ev)) {
      out.push({ check: "projected-not-folded", severity: "info", entity: ev, message: `event \`${ev}\` is projected on \`${w.projection}\` but no aggregate Apply()s it`, ...w });
    }
  }

  // 6. state-machine review candidates (info): dynamic transitions (enrichment queue),
  // untracked enum props, and handlers that emit a state-changing event without ever
  // reading the status property (missing guard candidate).
  for (const mach of machines) {
    for (const t of mach.transitions) {
      if (t.dynamic) {
        out.push({ check: "transition-dynamic", severity: "info", entity: `${mach.aggregate} ← ${t.event}`, message: `transition on \`${t.event}\` sets \`${mach.aggregate}.${mach.prop}\` to a runtime-determined value — target state needs enrichment`, file: t.file, line: t.line });
      }
      if (!t.isCreate) {
        for (const h of m.handlers.values()) {
          if (!h.emits.includes(t.event) || h.memberRefs.includes(mach.prop)) continue;
          out.push({ check: "transition-unguarded-candidate", severity: "info", entity: `${h.name} → ${t.event}`, message: `handler \`${h.name}\` emits \`${t.event}\` (a \`${mach.aggregate}\` state change) without reading \`${mach.prop}\` — missing state guard?`, file: h.file, line: h.line });
        }
      }
    }
    if (mach.otherEnumProps.length) {
      out.push({ check: "status-prop-ambiguous", severity: "info", entity: mach.aggregate, message: `\`${mach.aggregate}\` has other enum-typed properties (${mach.otherEnumProps.join(", ")}) — the state machine tracks \`${mach.prop}\` only`, ...mach.enumWhere });
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
    enums: new Map(), guidStates: new Map(), typeProps: new Map(), foldAssignments: [],
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
  summary: {
    events: number; commands: number; aggregatesFolds: number; projections: number; snapshots: number;
    stateMachines: number; states: number; transitions: number; warnings: number; info: number;
  };
  findings: Finding[];
  note: string;
}> {
  const m = await buildMartenModel(repoRoot);
  const machines = deriveStateMachines(m);
  const findings = runChecks(m, machines, opts.verbose ?? false).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1));
  return {
    summary: {
      events: m.events.size, commands: m.commands.size, aggregatesFolds: m.folded.size,
      projections: m.projected.size, snapshots: m.snapshotted.size,
      stateMachines: machines.length,
      states: machines.reduce((n, x) => n + x.members.length, 0),
      transitions: machines.reduce((n, x) => n + x.transitions.length, 0),
      warnings: findings.filter((f) => f.severity === "warn").length,
      info: findings.filter((f) => f.severity === "info").length,
    },
    findings,
    note: "Emission detection sees `new EventT()` into Events.Append/StartStream; events appended via a local variable are a known blind spot. Info checks (verbose) are review candidates, not confirmed bugs.",
  };
}
