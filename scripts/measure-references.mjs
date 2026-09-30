#!/usr/bin/env node
// Measure dangling SHARED references in a sidecar (plan 2026-09-30-online-only-sync, item 1.3).
//
//   node scripts/measure-references.mjs <sidecar-path> [--dist <compiled-js-dir>] [--json]
//
// READ-ONLY: it only readdir()s and readFile()s under the sidecar; nothing is written there.
// The FK rows are the 165 of the foreign-key spec (sidecar-references.md §1.1, against 64c27f8)
// plus its nine ambiguous candidates A1-A9 (§1.1b), measured and labelled separately. The
// local-only fields of §1.1c are never counted.
//
// --dist supplies `sortEvents` (eventlog.js) and `foldStandardReport` (shared-standard.js) from a
// build. Without it an inlined copy of 64c27f8's sortEvents is used, and requirement/criterion
// existence is derived from spec.ratified alone (no conflict detection) — the output says which.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const root = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--dist");
const distArg = argv.includes("--dist") ? argv[argv.indexOf("--dist") + 1] : null;
const asJson = argv.includes("--json");
if (!root) {
    console.error("usage: node scripts/measure-references.mjs <sidecar-path> [--dist <compiled-js-dir>] [--json]");
    process.exit(2);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
const requirementIdFor = (op) => "r_" + sha(op).slice(0, 12);
const criterionIdFor = (op) => "ac_" + sha(op).slice(0, 12);
const bugIdFor = (f) => "bug_" + sha(`finding\0${f}`).slice(0, 12);

// ---- ordering ---------------------------------------------------------------
const GENESIS = "GENESIS";
function sortEventsInline(events) { // verbatim algorithm of 64c27f8 eventlog.ts sortEvents
    const edges = (e) => (e.writerPrev && e.writerPrev !== GENESIS ? [...(e.after ?? []), e.writerPrev] : e.after ?? []);
    const byId = new Map(events.map((e) => [e.id, e]));
    const pending = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const emitted = new Set(), out = [];
    while (pending.length) {
        let i = pending.findIndex((e) => edges(e).every((p) => !byId.has(p) || emitted.has(p)));
        if (i < 0) i = 0;
        const [e] = pending.splice(i, 1);
        out.push(e); emitted.add(e.id);
    }
    return out;
}
let sortEvents = sortEventsInline, foldStandardReport = null, sortSource = "inline copy of 64c27f8 sortEvents";
if (distArg) {
    const d = pathToFileURL(distArg.endsWith("/") ? distArg : distArg + "/");
    sortEvents = (await import(new URL("eventlog.js", d))).sortEvents;
    foldStandardReport = (await import(new URL("shared-standard.js", d))).foldStandardReport;
    sortSource = `${distArg}/eventlog.js`;
}

// ---- reading ----------------------------------------------------------------
const wellFormed = (e) => !!e && typeof e.id === "string" && !!e.id && typeof e.kind === "string"
    && typeof e.subject === "string" && !!e.actor && typeof e.actor.principal === "string" && !!e.actor.principal.trim()
    && typeof e.writer === "string" && !!e.writer && e.id !== GENESIS && typeof e.writerPrev === "string" && !!e.writerPrev
    && Array.isArray(e.after) && typeof e.sidecarProtocol === "number" && typeof e.eventSchema === "number";

const damage = [], torn = [], malformed = [], collisions = [];
const scopes = new Map(); // scope -> { events (sorted), pos: Map(id -> idx) }
let lines = 0;
async function walk(rel) {
    let entries;
    try { entries = await readdir(join(root, rel), { withFileTypes: true }); } catch { return; }
    const shards = entries.filter((e) => e.isFile() && e.name.endsWith(".ndjson")).map((e) => e.name).sort();
    if (shards.length) {
        const seen = new Map(), evs = [];
        for (const n of shards) {
            const text = await readFile(join(root, rel, n), "utf8");
            const ls = text.split("\n");
            const tornIdx = ls[ls.length - 1].trim().startsWith("{") ? ls.length - 1 : -1;
            ls.forEach((line, i) => {
                if (!line.trim()) return;
                lines++;
                let e;
                try { e = JSON.parse(line); } catch {
                    (i === tornIdx ? torn : damage).push({ shard: `${rel}/${n}`, line: i + 1, sample: line.trim().slice(0, 80) });
                    return;
                }
                if (!wellFormed(e)) { malformed.push({ shard: `${rel}/${n}`, line: i + 1, id: e?.id, kind: e?.kind }); return; }
                const first = seen.get(e.id);
                if (first !== undefined) { if (first !== line.trim()) collisions.push({ scope: rel, id: e.id }); return; }
                seen.set(e.id, line.trim()); evs.push(e);
            });
        }
        const sorted = sortEvents(evs);
        scopes.set(rel, { events: sorted, pos: new Map(sorted.map((e, i) => [e.id, i])) });
    }
    for (const e of entries) if (e.isDirectory() && e.name !== ".git") await walk(rel ? `${rel}/${e.name}` : e.name);
}
await walk("");

const family = (s) => s.split("/")[0];
function universeOf(s) {
    const p = s.split("/"), f = p[0];
    if (f === "law") return null;
    if (f === "findings" || f === "walkthrough" || f === "notes") return p.slice(1, -1).join("/");
    return p.slice(1).join("/");
}
const allScopes = [...scopes.keys()];
const universes = [...new Set(allScopes.map(universeOf).filter(Boolean))].sort();
const LAW = "law/standard";
const standardScopes = allScopes.filter((s) => family(s) === "standard");

// Standard views: the fold merges law with evidence and sorts the union, so "earlier" there is
// a fold-defined order. Read view = law + standard/<u>; door view (for law events) = law + every
// standard/*.
const views = new Map();
const mkView = (key, ss) => {
    const evs = sortEvents(ss.flatMap((s) => scopes.get(s)?.events ?? []));
    views.set(key, { events: evs, pos: new Map(evs.map((e, i) => [e.id, i])) });
};
mkView("door", [LAW, ...standardScopes]);
for (const s of standardScopes) mkView(`read:${universeOf(s)}`, [LAW, s]);
const viewFor = (scope) => scope === LAW ? views.get("door") : family(scope) === "standard" ? views.get(`read:${universeOf(scope)}`) : null;

// ---- registries: every shared target that exists, with where it was minted ------------------
const reg = new Map();
const add = (name, id, scope, e, extra = {}) => {
    if (typeof id !== "string" || !id) return;
    if (!reg.has(name)) reg.set(name, new Map());
    const m = reg.get(name);
    if (!m.has(id)) m.set(id, []);
    m.get(id).push({ scope, evId: e.id, subject: e.subject, ...extra });
};
const events = [];
for (const [scope, { events: evs }] of scopes) for (const e of evs) events.push({ scope, e });

const CLOSING = new Set(["invalid", "refuted", "resolved", "withdrawn", "accepted"]);
const labelRounds = new Map(); // decisions scope -> Map(label -> [roundEvId])
for (const { scope, e } of events) {
    const d = e.data ?? {};
    switch (e.kind) {
        case "finding.created": add("finding", e.subject, scope, e); add("findingEpoch", e.id, scope, e);
            add("repairClaim", `${e.subject}:original`, scope, e); break;
        case "finding.commented": add("findingComment", e.id, scope, e); break;
        case "finding.reopened": add("findingEpoch", e.id, scope, e); break;
        case "finding.stateChanged":
            if (CLOSING.has(d.state)) add("findingClosure", e.id, scope, e); else add("findingEpoch", e.id, scope, e); break;
        case "finding.repairApplied": case "finding.rulingApplied": add("findingClosure", e.id, scope, e); break;
        case "repair.claims-recorded": for (const c of d.claims ?? []) add("repairClaim", c?.id, scope, e); break;
        case "repair.sort-recorded": add("repairSort", d.id, scope, e); break;
        case "repair.evidence-recorded": add("repairEvidence", d.id, scope, e); break;
        case "repair.verification-requested": add("repairRequest", d.id, scope, e); break;
        case "repair.verification-recorded": add("repairRun", d.id, scope, e); break;
        case "bug.filed": add("bug", e.subject, scope, e); add("bugEpoch", e.id, scope, e); break;
        case "bug.commented": add("bugComment", e.id, scope, e); break;
        case "bug.reopened": add("bugEpoch", e.id, scope, e); break;
        case "bug.stateChanged": if (CLOSING.has(d.state)) add("bugClosure", e.id, scope, e); else add("bugEpoch", e.id, scope, e); break;
        case "bug.rulingApplied": add("bugClosure", e.id, scope, e); break;
        case "note.created": add("note", e.subject, scope, e); break;
        case "doc.version": add("docVersion", d.version?.versionId, scope, e, { nodeId: d.version?.nodeId });
            add("node", e.subject, scope, e, { removed: !!d.version?.removed }); break;
        case "decision.round.posted": {
            add("round", e.id, scope, e);
            if (d.round?.id) { add("roundLabel", d.round.id, scope, e); }
            for (const q of d.decisions ?? []) { add("decision", `${e.id}:${q?.id}`, scope, e); add("decisionLabel", q?.id, scope, e); }
            break;
        }
        case "decision.confirm.posted": add("decision", e.id, scope, e); add("decisionLabel", d.decision?.id, scope, e); break;
        case "decision.question.logged": add("loggedQuestion", e.id, scope, e); break;
        case "decision.answer.recorded": case "decision.answer.revised": add("answer", e.id, scope, e); break;
        case "decision.questionnaire.submitted":
            for (const a of d.staged?.answers ?? []) add("answer", "qans_" + sha(`${e.id}\0${a?.questionId}`).slice(0, 24), scope, e);
            break;
        case "decision.withdrawn": add("withdrawal", e.id, scope, e); break;
        case "decision.comparison.requested": add("comparisonRequest", d.request?.id, scope, e); break;
        case "decision.comparison.resolved": add("comparisonResolution", e.id, scope, e); break;
        case "spec.drafted": add("spec", d.spec?.id, scope, e); break;
        case "spec.operation": add("op", d.operation?.id, scope, e, { specId: d.operation?.specId, opKind: d.operation?.kind }); break;
        case "spec.ratified": case "spec.withdrawn": add("specVerdict", e.id, scope, e); break;
        case "problem.adjudicated": add("problemVerdict", e.id, scope, e); break;
        case "ack.granted": add("ack", d.ack?.id, scope, e); break;
        case "audit.recorded": add("audit", d.audit?.id, scope, e); break;
        case "pointer.declared": add("pointer", d.pointer?.id, scope, e); break;
        case "population.pinned": add("population", d.pin?.id, scope, e); break;
        case "problem.raised": add("problem", d.problem?.id, scope, e); break;
    }
}
const removedOps = new Set(events.filter(({ e }) => e.kind === "spec.operation.removed").map(({ e }) => e.data?.operation?.id));
const withdrawnSpecs = new Set(events.filter(({ e }) => e.kind === "spec.withdrawn").map(({ e }) => e.subject));

// Requirements and criteria have no minting event: they exist once a spec.ratified APPLIES the
// add_requirement / add_criterion op. Minting position = that ratification.
const opById = new Map([...(reg.get("op") ?? new Map())].map(([id, occ]) => [id, occ[0]]));
const derived = { requirement: new Map(), criterion: new Map() }; // id -> {scope, evId, opId}
for (const { scope, e } of events) {
    if (e.kind !== "spec.ratified") continue;
    for (const opId of e.data?.operations ?? []) {
        const op = opById.get(opId);
        if (op?.opKind === "add_requirement") derived.requirement.set(requirementIdFor(opId), { scope, evId: e.id, subject: e.subject, opId });
        if (op?.opKind === "add_criterion") derived.criterion.set(criterionIdFor(opId), { scope, evId: e.id, subject: e.subject, opId });
    }
}
let lawFold = null, lawFoldNote;
if (foldStandardReport) {
    try {
        lawFold = foldStandardReport(views.get("door").events).value;
        lawFoldNote = "existence from foldStandardReport over law/standard + every standard/* (door view)";
    } catch (err) { lawFoldNote = `foldStandardReport threw (${err.message}); fell back to derivation`; }
} else lawFoldNote = "no --dist: existence derived from spec.ratified operations, without conflict detection";
const foldMismatch = [];
for (const [name, list] of [["requirement", lawFold?.requirements], ["criterion", lawFold?.criteria]]) {
    const m = new Map();
    if (list) {
        for (const r of list) {
            const at = derived[name].get(r.id);
            if (!at) foldMismatch.push(`${name} ${r.id} in fold but not derivable from a spec.ratified`);
            m.set(r.id, [{ ...(at ?? { scope: LAW, evId: null }), retired: r.status === "retired" }]);
        }
        for (const id of derived[name].keys()) if (!m.has(id)) foldMismatch.push(`${name} ${id} derivable from a spec.ratified but NOT applied by the fold (conflicted?)`);
    } else for (const [id, at] of derived[name]) m.set(id, [{ ...at, retired: withdrawnSpecs.has(at.subject) }]);
    reg.set(name, m);
}
const specStatus = new Map((lawFold?.specs ?? []).map((s) => [s.id, s.status]));
const pointerRetired = new Set((lawFold?.pointers ?? []).filter((p) => p.state === "retired").map((p) => p.id));
// A pending pointer names the id its op WILL mint; that is "prospective", not never-existed.
const prospective = { requirement: new Map(), criterion: new Map() };
for (const [id, o] of opById) {
    if (o.opKind === "add_requirement") prospective.requirement.set(requirementIdFor(id), id);
    if (o.opKind === "add_criterion") prospective.criterion.set(criterionIdFor(id), id);
}

// ---- checking ---------------------------------------------------------------
// `prospective-unratified` is reported but NOT counted as dangling: a pending pointer names the
// requirement/criterion id its draft op will mint at ratification, by design (pointer state
// `pending`, shared-standard.ts:1015-1022 at 64c27f8).
const DANGLING = new Set(["never-existed", "exists-only-elsewhere", "exists-but-only-later", "wrong-owner",
    "label-ambiguous", "never-existed (prospective id of an unratified op)", "names-another-scope", "unverifiable", "not-published-anywhere",
    "published-only-in-another-universe", "review-scope-absent", "qualified-alias-unresolved"]);
const results = new Map();
const rowOf = (n) => {
    n = String(n);
    if (!results.has(n)) results.set(n, { events: 0, eventsWithValue: 0, values: 0, classes: new Map() });
    return results.get(n);
};
const tally = (n, cls, ex) => {
    const r = rowOf(n); r.values++;
    if (!r.classes.has(cls)) r.classes.set(cls, { count: 0, examples: [] });
    const c = r.classes.get(cls); c.count++;
    if (c.examples.length < 3) c.examples.push(ex);
};

// loc: { scopes: string[] | (s => bool), order: "scope" | "view" | null, filter?: occ => bool,
//        filterClass?: string, retired?: occ => bool, prospective?: "requirement"|"criterion" }
function resolve(n, regName, value, scope, e, loc) {
    const ex = { event: e.id, scope, value };
    if (typeof value !== "string" || !value) { tally(n, "malformed-value", { ...ex, value: JSON.stringify(value) }); return; }
    const occs = reg.get(regName)?.get(value) ?? [];
    const inScope = typeof loc.scopes === "function" ? loc.scopes : (s) => loc.scopes.includes(s);
    const here = occs.filter((o) => inScope(o.scope));
    const owned = loc.filter ? here.filter(loc.filter) : here;
    if (!occs.length) {
        const p = loc.prospective && prospective[loc.prospective].get(value);
        const pending = e.kind === "pointer.declared" && e.data?.pointer?.state === "pending";
        tally(n, !p ? "never-existed" : pending ? "prospective-unratified" : "never-existed (prospective id of an unratified op)", p ? { ...ex, op: p } : ex); return;
    }
    if (!here.length) { tally(n, "exists-only-elsewhere", { ...ex, foundIn: [...new Set(occs.map((o) => o.scope))].slice(0, 3) }); return; }
    if (!owned.length) { tally(n, loc.filterClass ?? "wrong-owner", ex); return; }
    if (loc.unique && new Set(owned.map((o) => o.scope)).size > 1) { tally(n, "label-ambiguous", { ...ex, foundIn: owned.map((o) => o.scope) }); return; }
    let cls = "ok-unordered";
    if (loc.order) {
        const ord = loc.order === "view" ? viewFor(scope) : scopes.get(scope);
        const at = ord.pos.get(e.id);
        const earlier = owned.some((o) => o.evId && ord.pos.has(o.evId) && ord.pos.get(o.evId) < at);
        cls = earlier ? "ok" : "exists-but-only-later";
    } else if (owned.every((o) => o.evId && o.evId > e.id)) {
        // Cross-scope: no order exists. Ids are minted time-first (mintId), so this is a CLOCK
        // comparison only — informational, never a verdict.
        cls = "ok-unordered (target minted later by id clock; heuristic)";
    }
    if (DANGLING.has(cls)) { tally(n, cls, ex); return; }
    tally(n, loc.retired && owned.every(loc.retired) ? `${cls} (target retired/withdrawn)` : cls, ex);
}

const same = (scope) => ({ scopes: [scope], order: "scope" });
const bugsOf = (scope) => ({ scopes: [`bugs/${universeOf(scope)}`], order: null });
const decisionsOf = (u) => ({ scopes: [`decisions/${u}`], order: null });
const anyFindingsOf = (u) => ({ scopes: (s) => s.startsWith(`findings/${u}/`), order: null });
// Law targets. From a law or standard event: the fold's own merged view, which is ordered.
// From anywhere else (notes): law + legacy standard/<u>, which no single fold orders.
const lawLoc = (scope, extra = {}) => {
    const v = viewFor(scope);
    if (v) return { scopes: scope === LAW ? [LAW, ...standardScopes] : [LAW, scope], order: "view", ...extra };
    return { scopes: [LAW, `standard/${universeOf(scope)}`], order: null, ...extra };
};
const evidenceLoc = (scope) => ({ scopes: [scope === LAW ? null : scope].filter(Boolean), order: viewFor(scope) ? "view" : null });
const specRetired = (o) => (specStatus.get(o.subject ?? "") ?? "") === "withdrawn" || withdrawnSpecs.has(o.subject);
const opRetired = (o) => removedOps.has(o.evId && opIdOfEvent.get(o.evId)) || withdrawnSpecs.has(o.specId);
const opIdOfEvent = new Map(events.filter(({ e }) => e.kind === "spec.operation").map(({ e }) => [e.id, e.data?.operation?.id]));
const specLoc = (scope) => lawLoc(scope, { retired: (o) => withdrawnSpecs.has(o.subject) || specStatus.get(o.subject) === "withdrawn" });
const opLoc = (scope, extra = {}) => lawLoc(scope, { retired: opRetired, ...extra });
const reqLoc = (scope) => lawLoc(scope, { prospective: "requirement", retired: (o) => o.retired });
const critLoc = (scope) => lawLoc(scope, { prospective: "criterion", retired: (o) => o.retired });

// Decision references: an exact id, or a label that is unique in the scope (exactRound /
// exactDecision). `labels: false` for exact-only rows (decision.withdrawn).
function resolveDecisionish(n, idReg, labelReg, value, scope, e, labels = true) {
    const exact = reg.get(idReg)?.get(value)?.filter((o) => o.scope === scope) ?? [];
    if (exact.length || !labels) return resolve(n, idReg, value, scope, e, same(scope));
    const lab = reg.get(labelReg)?.get(value)?.filter((o) => o.scope === scope) ?? [];
    if (lab.length > 1) return tally(n, "label-ambiguous", { event: e.id, scope, value });
    return resolve(n, labels ? labelReg : idReg, value, scope, e, same(scope));
}
function resolveIssue(n, ref, scope, e) {
    const ex = { event: e.id, scope, value: JSON.stringify(ref) };
    if (!ref || typeof ref !== "object") return tally(n, "malformed-value", ex);
    if (ref.kind === "finding") return resolve(n, "finding", ref.id, scope, e, { scopes: [ref.scope], order: null });
    if (ref.kind === "bug") return resolve(n, "bug", ref.id, scope, e, { scopes: [ref.scope], order: null });
    if (ref.kind === "decision") return resolveDecisionish(n, "decision", "decisionLabel", ref.id, scope, e);
    tally(n, "unverifiable", ex);
}
function selfScope(n, ref, scope, e, wantId) {
    const ex = { event: e.id, scope, value: JSON.stringify(ref) };
    if (!ref) return tally(n, "malformed-value", ex);
    const refScope = typeof ref === "string" ? ref : ref.scope;
    if (wantId !== undefined && ref.id !== wantId) return tally(n, "wrong-owner", ex);
    tally(n, refScope === scope ? "ok-unordered" : "names-another-scope", ex);
}
function resolveNode(n, value, scope, e) {
    const u = universeOf(scope);
    const ex = { event: e.id, scope, value };
    if (typeof value !== "string" || !value) return tally(n, "malformed-value", ex);
    let target = value, tu = u;
    const q = value.indexOf("::");
    if (q > 0) { // `calls_api` style `<alias>::<node>` — alias matched to a universe by its tail
        const alias = value.slice(0, q); target = value.slice(q + 2);
        const cands = universes.filter((x) => x.split("/").pop().split(".").pop() === alias || x.split("/").pop() === alias);
        if (cands.length !== 1) return tally(n, "qualified-alias-unresolved", ex);
        tu = cands[0];
    }
    const occs = reg.get("node")?.get(target) ?? [];
    const here = occs.filter((o) => o.scope === `docs/${tu}`);
    if (here.length) return tally(n, here.every((o) => o.removed) ? "published (target retired/withdrawn)" : (q > 0 ? "published (cross-universe qualified)" : "published"), ex);
    if (occs.length) return tally(n, "published-only-in-another-universe", { ...ex, foundIn: occs.map((o) => o.scope).slice(0, 3) });
    tally(n, "not-published-anywhere", ex);
}

const arr = (x) => (Array.isArray(x) ? x : x === undefined || x === null ? [] : [x]);
const R = []; // { n, kind, field, run(scope, e) -> had value? }
const row = (n, kind, field, run, opts = {}) => R.push({ n: String(n), kind, field, run, ...opts });
const each = (n, regName, values, scope, e, loc) => { const v = arr(values); for (const x of v) resolve(n, regName, x, scope, e, loc); return v.length > 0; };

// Findings scope
const FSUBJ = ["revised", "corroborated", "remediated", "backlogged", "backlogReleased", "rewitnessed", "commented", "promoted",
    "posted", "upstreamed", "assigned", "outcome", "requested", "askDeclined", "stateChanged", "reopened", "repairApplied",
    "rulingApplied", "relocation", "promotedToBug"];
FSUBJ.forEach((k, i) => row(i + 1, `finding.${k}`, "E.subject", (s, e) => each(i + 1, "finding", e.subject, s, e, same(s))));
row(21, "finding.commented", "d.inReplyTo", (s, e) => each(21, "findingComment", e.data?.inReplyTo, s, e, same(s)));
row(22, "finding.reopened", "d.observedClosure", (s, e) => each(22, "findingClosure", e.data?.observedClosure, s, e, { ...same(s), filter: (o) => o.subject === e.subject }));
row(23, "finding.promotedToBug", "d.bug", (s, e) => each(23, "bug", e.data?.bug, s, e, bugsOf(s)));
row(24, "finding.repairApplied", "d.requestId", (s, e) => each(24, "repairRequest", e.data?.requestId, s, e, same(s)));
row(25, "finding.repairApplied", "d.findingId", (s, e) => each(25, "finding", e.data?.findingId, s, e, same(s)));
row(26, "finding.repairApplied", "d.openEpoch", (s, e) => each(26, "findingEpoch", e.data?.openEpoch, s, e, { ...same(s), filter: (o) => o.subject === e.subject }));
row(27, "finding.rulingApplied", "d.capsule.issue.ref", (s, e) => { const r = e.data?.capsule?.issue?.ref; if (r === undefined) return false; selfScope(27, r, s, e, e.subject); return true; });
row(28, "finding.rulingApplied", "d.capsule.issue.openEpoch", (s, e) => each(28, "findingEpoch", e.data?.capsule?.issue?.openEpoch, s, e, { ...same(s), filter: (o) => o.subject === e.subject }));
row(29, "finding.rulingApplied", "d.capsule.ruling.answerId", (s, e) => each(29, "answer", e.data?.capsule?.ruling?.answerId, s, e, decisionsOf(universeOf(s))));
row(30, "finding.rulingApplied", "d.capsule.ruling.roundId", (s, e) => each(30, "round", e.data?.capsule?.ruling?.roundId, s, e, decisionsOf(universeOf(s))));
row(31, "finding.rulingApplied", "d.capsule.ruling.questionId", (s, e) => each(31, "decision", e.data?.capsule?.ruling?.questionId, s, e, decisionsOf(universeOf(s))));
row(32, "finding.rulingApplied", "d.capsule.acceptance.findingId", (s, e) => each(32, "finding", e.data?.capsule?.acceptance?.findingId, s, e, same(s)));
row(33, "repair.claims-recorded", "E.subject / d.findingId", (s, e) => each(33, "finding", [...new Set([e.subject, e.data?.findingId].filter(Boolean))], s, e, same(s)));
row(34, "repair.claims-recorded", "d.parentId", (s, e) => each(34, "repairClaim", e.data?.parentId, s, e, same(s)));
row(35, "repair.sort-recorded", "d.coverage[].findingId", (s, e) => each(35, "finding", arr(e.data?.coverage).map((c) => c?.findingId), s, e, same(s)));
row(36, "repair.sort-recorded", "d.coverage[].claimIds[]", (s, e) => each(36, "repairClaim", arr(e.data?.coverage).flatMap((c) => arr(c?.claimIds)), s, e, same(s)));
row(37, "repair.sort-recorded", "d.prior", (s, e) => each(37, "repairSort", e.data?.prior, s, e, same(s)));
row(38, "repair.sort-recorded", "d.ruling", (s, e) => each(38, "answer", e.data?.ruling, s, e, decisionsOf(universeOf(s))));
row(39, "repair.evidence-recorded", "d.sortId", (s, e) => each(39, "repairSort", e.data?.sortId, s, e, same(s)));
row(40, "repair.evidence-recorded", "d.coverage[].findingId/.claimIds[]", (s, e) => {
    const c = arr(e.data?.coverage);
    const a = each(40, "finding", c.map((x) => x?.findingId), s, e, same(s));
    const b = each(40, "repairClaim", c.flatMap((x) => arr(x?.claimIds)), s, e, same(s));
    return a || b;
});
row(41, "repair.evidence-recorded", "d.rulingIds[]", (s, e) => each(41, "answer", e.data?.rulingIds, s, e, decisionsOf(universeOf(s))));
row(42, "repair.verification-requested", "d.capsule.sort.id", (s, e) => each(42, "repairSort", e.data?.capsule?.sort?.id, s, e, same(s)));
row(43, "repair.verification-requested", "d.capsule.evidence.id", (s, e) => each(43, "repairEvidence", e.data?.capsule?.evidence?.id, s, e, same(s)));
row(44, "repair.verification-requested", "d.capsule.claims[].id", (s, e) => each(44, "repairClaim", arr(e.data?.capsule?.claims).map((c) => c?.id), s, e, same(s)));
row(45, "repair.verification-requested", "d.capsule.targets[].findingId", (s, e) => each(45, "finding", arr(e.data?.capsule?.targets).map((t) => t?.findingId), s, e, same(s)));
row(46, "repair.verification-requested", "d.capsule.targets[].openEpoch", (s, e) => each(46, "findingEpoch", arr(e.data?.capsule?.targets).map((t) => t?.openEpoch), s, e, same(s)));
row(47, "repair.verification-requested", "d.capsule.scope", (s, e) => { const v = e.data?.capsule?.scope; if (v === undefined) return false; selfScope(47, v, s, e); return true; });
row(48, "repair.verification-requested", "d.capsule.rulingContext rulings[].id/.decision", (s, e) => {
    const raw = e.data?.capsule?.rulingContext; if (raw === undefined) return false;
    let j; try { j = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { tally(48, "malformed-value", { event: e.id, scope: s, value: String(raw).slice(0, 60) }); return true; }
    const rs = arr(j?.rulings), u = universeOf(s);
    each(48, "answer", rs.map((r) => r?.id), s, e, decisionsOf(u));
    each(48, "decision", rs.map((r) => r?.decision).filter(Boolean), s, e, decisionsOf(u));
    return true;
});
row(49, "repair.verification-recorded", "d.requestId", (s, e) => each(49, "repairRequest", e.data?.requestId, s, e, same(s)));
row(50, "repair.verification-recorded", "d.results[].claimId", (s, e) => each(50, "repairClaim", arr(e.data?.results).map((r) => r?.claimId), s, e, same(s)));
row(51, "repair.verification-recorded", "d.results[].sites[].bug", (s, e) => each(51, "bug", arr(e.data?.results).flatMap((r) => arr(r?.sites)).map((x) => x?.bug).filter((b) => b !== undefined), s, e, bugsOf(s)));
row(52, "repair.verification-arbitrated", "d.requestId", (s, e) => each(52, "repairRequest", e.data?.requestId, s, e, same(s)));
row(53, "repair.verification-arbitrated", "d.runIds[]", (s, e) => each(53, "repairRun", e.data?.runIds, s, e, same(s)));
row(54, "repair.verification-arbitrated", "d.addresses[].claimId", (s, e) => each(54, "repairClaim", arr(e.data?.addresses).map((a) => a?.claimId), s, e, same(s)));

// Bugs scope
const BSUBJ = ["revised", "anchored", "unanchored", "corroborated", "backlogged", "backlogReleased", "commented", "promoted",
    "tracked", "assigned", "outcome", "requested", "reopened", "rulingApplied", "stateChanged"];
BSUBJ.forEach((k, i) => row(55 + i, `bug.${k}`, "E.subject", (s, e) => each(55 + i, "bug", e.subject, s, e, same(s))));
const findingScopeFor = (u, pr) => {
    const k = String(pr).trim().replace(/^#/, "");
    if (k.startsWith("branch:")) return `findings/${u}/b-${sha(`${u}\0branch\0${k.slice(7)}`).slice(0, 40)}`;
    return /^\d+$/.test(k) ? `findings/${u}/pr-${k}` : null;
};
row(70, "bug.filed", "d.fromFinding (@ findingKeyScope(u, d.fromPr))", (s, e) => {
    const d = e.data ?? {}; if (!d.fromFinding) return false;
    const fs = d.fromPr !== undefined ? findingScopeFor(universeOf(s), d.fromPr) : null;
    if (!fs) { tally(70, "unverifiable", { event: e.id, scope: s, value: d.fromFinding, note: "no/invalid fromPr" }); return true; }
    resolve(70, "finding", d.fromFinding, s, e, { scopes: [fs], order: null }); return true;
});
row(71, "bug.filed", "d.fromPr (the finding's review scope)", (s, e) => {
    const d = e.data ?? {}; if (d.fromPr === undefined) return false;
    const fs = findingScopeFor(universeOf(s), d.fromPr);
    tally(71, fs && scopes.has(fs) ? "ok-unordered" : "review-scope-absent", { event: e.id, scope: s, value: String(d.fromPr), expectedScope: fs });
    return true;
});
row(72, "bug.filed", "d.inherits.author / .corroboration[]", (s, e) => {
    const d = e.data ?? {}; if (!d.inherits) return false;
    const fs = d.fromPr !== undefined ? findingScopeFor(universeOf(s), d.fromPr) : null;
    const ex = { event: e.id, scope: s, value: d.fromFinding };
    const created = fs && scopes.get(fs)?.events.find((x) => x.kind === "finding.created" && x.subject === d.fromFinding);
    if (!created) { tally(72, "never-existed", ex); return true; }
    const corrs = scopes.get(fs).events.filter((x) => x.kind === "finding.corroborated" && x.subject === d.fromFinding);
    const authorOk = d.inherits.author?.principal === created.actor.principal;
    const corrOk = arr(d.inherits.corroboration).every((c) => corrs.some((x) => x.actor.principal === c?.actor?.principal && x.data?.verdict === c?.verdict));
    tally(72, authorOk && corrOk ? "ok-unordered" : "wrong-owner", ex); return true;
});
row(73, "bug.filed", "E.subject = bugIdFor(d.fromFinding[@site])", (s, e) => {
    const f = e.data?.fromFinding; if (!f) return false;
    tally(73, e.subject === bugIdFor(f) ? "ok-unordered" : "unverifiable", { event: e.id, scope: s, value: e.subject, fromFinding: f });
    return true;
}, { note: "`unverifiable` = subject is not bugIdFor(fromFinding); it may be the per-site id bugIdFor(`finding@site`), whose site is not recorded" });
row(74, "bug.commented", "d.inReplyTo", (s, e) => each(74, "bugComment", e.data?.inReplyTo, s, e, same(s)));
row(75, "bug.reopened", "d.observedClosure", (s, e) => each(75, "bugClosure", e.data?.observedClosure, s, e, { ...same(s), filter: (o) => o.subject === e.subject }));
row(76, "bug.rulingApplied", "d.capsule.issue.ref", (s, e) => { const r = e.data?.capsule?.issue?.ref; if (r === undefined) return false; selfScope(76, r, s, e, e.subject); return true; });
row(77, "bug.rulingApplied", "d.capsule.issue.openEpoch", (s, e) => each(77, "bugEpoch", e.data?.capsule?.issue?.openEpoch, s, e, { ...same(s), filter: (o) => o.subject === e.subject }));
row(78, "bug.rulingApplied", "d.capsule.ruling.answerId", (s, e) => each(78, "answer", e.data?.capsule?.ruling?.answerId, s, e, decisionsOf(universeOf(s))));
row(79, "bug.rulingApplied", "d.capsule.ruling.roundId", (s, e) => each(79, "round", e.data?.capsule?.ruling?.roundId, s, e, decisionsOf(universeOf(s))));
row(80, "bug.rulingApplied", "d.capsule.ruling.questionId", (s, e) => each(80, "decision", e.data?.capsule?.ruling?.questionId, s, e, decisionsOf(universeOf(s))));

// Notes
["revised", "answered", "resolved"].forEach((k, i) => row(81 + i, `note.${k}`, "E.subject", (s, e) => each(81 + i, "note", e.subject, s, e, same(s))));
row(84, "note.created", "d.targetId (targetKind spec)", (s, e) => e.data?.targetKind === "spec" && each(84, "spec", e.data.targetId, s, e, specLoc(s)));
row(85, "note.created", "d.targetId (targetKind operation)", (s, e) => e.data?.targetKind === "operation" && each(85, "op", e.data.targetId, s, e, opLoc(s)));

// Docs
row(86, "doc.accepted", "d.versionId (nodeId = E.subject)", (s, e) => each(86, "docVersion", e.data?.versionId, s, e, { ...same(s), filter: (o) => o.nodeId === e.subject, filterClass: "wrong-owner" }));
row(87, "doc.accepted", "E.subject (shared node)", (s, e) => each(87, "node", e.subject, s, e, same(s)));

// Decisions — NB: no decisions/ scope exists in the measured sidecar; these resolvers are
// exercised only if one does.
const dsc = (e) => arr(e.data?.decisions);
const effects = (e) => dsc(e).flatMap((q) => arr(q?.options)).flatMap((o) => arr(o?.effects));
row(88, "decision.round.posted", "d.decisions[].options[].effects[].findings[]", (s, e) => each(88, "finding", effects(e).flatMap((x) => arr(x?.findings)), s, e, { ...anyFindingsOf(universeOf(s)), unique: true }));
row(89, "decision.round.posted", "d.decisions[].options[].effects[].issues[]", (s, e) => { const v = effects(e).flatMap((x) => arr(x?.issues)); v.forEach((r) => resolveIssue(89, r, s, e)); return v.length > 0; });
row(90, "decision.round.posted", "d.decisions[].follows|supersedes", (s, e) => { const v = dsc(e).map((q) => q?.follows ?? q?.supersedes).filter(Boolean); v.forEach((x) => resolveDecisionish(90, "decision", "decisionLabel", x, s, e)); return v.length > 0; });
row(91, "decision.round.posted", "d.decisions[].origin.answer", (s, e) => each(91, "answer", dsc(e).map((q) => q?.origin?.answer).filter(Boolean), s, e, same(s)));
row(92, "decision.round.posted", "d.decisions[].resolves.answers[]", (s, e) => each(92, "answer", dsc(e).flatMap((q) => arr(q?.resolves?.answers)), s, e, same(s)));
row(93, "decision.confirm.posted", "d.round", (s, e) => { const v = e.data?.round; if (!v) return false; resolveDecisionish(93, "round", "roundLabel", v, s, e); return true; });
row(94, "decision.confirm.posted", "d.decision.confirms.answer", (s, e) => each(94, "answer", e.data?.decision?.confirms?.answer, s, e, same(s)));
row(95, "decision.confirm.posted", "d.decision.confirms.readings[][].decision", (s, e) => { const v = arr(e.data?.decision?.confirms?.readings).flatMap(arr).map((r) => r?.decision); v.forEach((x) => resolveDecisionish(95, "decision", "decisionLabel", x, s, e)); return v.length > 0; });
row(96, "decision.question.logged", "d.rounds[]", (s, e) => { const v = arr(e.data?.rounds); v.forEach((x) => resolveDecisionish(96, "round", "roundLabel", x, s, e)); return v.length > 0; });
row(97, "decision.question.logged", "d.bound{→ round}", (s, e) => { const v = Object.values(e.data?.bound ?? {}); v.forEach((x) => resolveDecisionish(97, "round", "roundLabel", x, s, e)); return v.length > 0; });
row(98, "decision.answer.recorded", "d.decision", (s, e) => { const v = e.data?.decision; if (!v) return false; resolveDecisionish(98, "decision", "decisionLabel", v, s, e); return true; });
row(99, "decision.answer.recorded", "d.via.question (via.kind question)", (s, e) => e.data?.via?.kind === "question" && each(99, "loggedQuestion", e.data.via.question, s, e, same(s)));
row(100, "decision.answer.recorded", "d.via.round (via.kind message)", (s, e) => { if (e.data?.via?.kind !== "message") return false; resolveDecisionish(100, "round", "roundLabel", e.data.via.round, s, e); return true; });
row(101, "decision.answer.revised", "d.decision", (s, e) => { const v = e.data?.decision; if (!v) return false; resolveDecisionish(101, "decision", "decisionLabel", v, s, e); return true; });
row(102, "decision.answer.revised", "d.revision.of[]", (s, e) => each(102, "answer", e.data?.revision?.of, s, e, same(s)));
row(103, "decision.answer.revised", "d.revision.findings[]", (s, e) => each(103, "finding", e.data?.revision?.findings, s, e, anyFindingsOf(universeOf(s))), { note: "named set: a `words` decision may name its own decision id, which this reports as never-existed" });
row(104, "decision.answer.revised", "d.revision.issues[]", (s, e) => { const v = arr(e.data?.revision?.issues); v.forEach((r) => resolveIssue(104, r, s, e)); return v.length > 0; });
row(105, "decision.answer.revised", "d.revision.resolves.answers[]", (s, e) => each(105, "answer", e.data?.revision?.resolves?.answers, s, e, same(s)));
row(106, "decision.answer.revised", "d.revision.resolves.priorResolution", (s, e) => each(106, "answer", e.data?.revision?.resolves?.priorResolution, s, e, same(s)));
row(107, "decision.questionnaire.submitted", "d.round", (s, e) => { const v = e.data?.round; if (!v) return false; resolveDecisionish(107, "round", "roundLabel", v, s, e); return true; });
row(108, "decision.questionnaire.submitted", "d.staged.questionnaireId", (s, e) => { const v = e.data?.staged?.questionnaireId; if (v === undefined) return false; tally(108, "unverifiable", { event: e.id, scope: s, value: v }); return true; }, { ambiguousIdentity: "the round's questionnaire id location is not stated by the spec; not resolved" });
row(109, "decision.questionnaire.submitted", "d.staged.answers[].questionId", (s, e) => { const v = arr(e.data?.staged?.answers).map((a) => a?.questionId); v.forEach((x) => resolveDecisionish(109, "decision", "decisionLabel", x, s, e)); return v.length > 0; });
row(110, "decision.comparison.nominated", "d.answers[]", (s, e) => each(110, "answer", e.data?.answers, s, e, same(s)));
row(111, "decision.comparison.nominated", "d.findings[]", (s, e) => each(111, "finding", e.data?.findings, s, e, anyFindingsOf(universeOf(s))));
row(112, "decision.comparison.nominated", "d.issues[]", (s, e) => { const v = arr(e.data?.issues); v.forEach((r) => resolveIssue(112, r, s, e)); return v.length > 0; });
row(113, "decision.comparison.requested", "d.request.left/right.answerId", (s, e) => each(113, "answer", [e.data?.request?.left?.answerId, e.data?.request?.right?.answerId].filter((x) => x !== undefined), s, e, same(s)));
row(114, "decision.comparison.requested", "d.request.left/right.questionId", (s, e) => each(114, "decision", [e.data?.request?.left?.questionId, e.data?.request?.right?.questionId].filter((x) => x !== undefined), s, e, same(s)));
row(115, "decision.comparison.requested", "d.request.issues[]", (s, e) => { const v = arr(e.data?.request?.issues); v.forEach((r) => resolveIssue(115, r, s, e)); return v.length > 0; });
row(116, "decision.comparison.judged", "d.judgment.requestId", (s, e) => each(116, "comparisonRequest", e.data?.judgment?.requestId, s, e, same(s)));
row(117, "decision.comparison.resolved", "d.resolution.requestId", (s, e) => each(117, "comparisonRequest", e.data?.resolution?.requestId, s, e, same(s)));
row(118, "decision.comparison.resolved", "d.resolution.preserve", (s, e) => each(118, "answer", e.data?.resolution?.preserve, s, e, same(s)));
row(119, "decision.comparison.resolved", "d.resolution.revises / .shownResolution.id", (s, e) => each(119, "comparisonResolution", [e.data?.resolution?.revises, e.data?.resolution?.shownResolution?.id].filter(Boolean), s, e, same(s)));
row(120, "decision.withdrawn", "d.decision (exact)", (s, e) => { const v = e.data?.decision; if (!v) return false; resolveDecisionish(120, "decision", "decisionLabel", v, s, e, false); return true; });
row(121, "decision.withdrawn", "d.answer", (s, e) => each(121, "answer", e.data?.answer, s, e, same(s)));
row(122, "decision.withdrawn", "d.knownAnswers[]", (s, e) => each(122, "answer", e.data?.knownAnswers, s, e, same(s)));
row(123, "decision.withdrawn", "d.relay", (s, e) => { const v = e.data?.relay; if (!v) return false; resolveDecisionish(123, "decision", "decisionLabel", typeof v === "string" ? v : v.decision, s, e); return true; });
row(124, "decision.conflict.resolved", "d.decision", (s, e) => { const v = e.data?.decision; if (!v) return false; resolveDecisionish(124, "decision", "decisionLabel", v, s, e, false); return true; });
row(125, "decision.conflict.resolved", "d.withdrawal", (s, e) => each(125, "withdrawal", e.data?.withdrawal, s, e, same(s)));
row(126, "decision.conflict.resolved", "d.keep (an answer)", (s, e) => e.data?.keep !== undefined && e.data.keep !== "withdrawal" && each(126, "answer", e.data.keep, s, e, same(s)));
row(127, "decision.reading.recorded", "d.answer", (s, e) => each(127, "answer", e.data?.answer, s, e, same(s)));
row(128, "decision.reading.recorded", "d.reader.verdict[].decision", (s, e) => { const v = arr(e.data?.reader?.verdict).map((x) => x?.decision); v.forEach((x) => resolveDecisionish(128, "decision", "decisionLabel", x, s, e)); return v.length > 0; });
row(129, "decision.reading.recorded", "d.session.maps[].decision", (s, e) => { const v = arr(e.data?.session?.maps).map((x) => x?.decision); v.forEach((x) => resolveDecisionish(129, "decision", "decisionLabel", x, s, e)); return v.length > 0; });

// Standard
const op = (e) => e.data?.operation ?? {};
row(130, "spec.operation", "d.operation.specId", (s, e) => each(130, "spec", op(e).specId, s, e, specLoc(s)));
row(131, "spec.operation", "d.operation.requirementId", (s, e) => each(131, "requirement", op(e).requirementId, s, e, reqLoc(s)));
row(132, "spec.operation", "d.operation.context.requirementId", (s, e) => each(132, "requirement", op(e).context?.requirementId, s, e, reqLoc(s)));
row(133, "spec.operation", "d.operation.targetOperationId", (s, e) => each(133, "op", op(e).targetOperationId, s, e, opLoc(s, { filter: (o) => o.specId === op(e).specId && o.opKind === "add_requirement", filterClass: "wrong-owner" })));
row(134, "spec.revised", "d.spec.id", (s, e) => each(134, "spec", e.data?.spec?.id, s, e, specLoc(s)));
row(135, "spec.operation.revised", "d.operation.id", (s, e) => each(135, "op", op(e).id, s, e, opLoc(s)));
row(136, "spec.operation.removed", "d.operation.id", (s, e) => each(136, "op", op(e).id, s, e, opLoc(s)));
row(137, "spec.operation-signoff-applied", "E.subject", (s, e) => each(137, "op", e.subject, s, e, opLoc(s)));
row(138, "spec.operation-signoff-applied", "d.capsule.operationId / .specId", (s, e) => {
    const c = e.data?.capsule ?? {};
    const a = each(138, "op", c.operationId, s, e, opLoc(s)); const b = each(138, "spec", c.specId, s, e, specLoc(s)); return a || b;
});
const rulingU = (e) => e.data?.capsule?.ruling?.universe ?? String(e.data?.capsule?.ruling?.sourceScope ?? "").replace(/^decisions\//, "");
row(139, "spec.operation-signoff-applied", "d.capsule.ruling.answerId", (s, e) => each(139, "answer", e.data?.capsule?.ruling?.answerId, s, e, decisionsOf(rulingU(e))));
row(140, "spec.operation-signoff-applied", "d.capsule.ruling.decisionId", (s, e) => each(140, "decision", e.data?.capsule?.ruling?.decisionId, s, e, decisionsOf(rulingU(e))));
row(141, "spec.operation-signoff-applied", "d.capsule.ruling.sourceScope", (s, e) => { const v = e.data?.capsule?.ruling?.sourceScope; if (v === undefined) return false; tally(141, scopes.has(v) ? "ok-unordered" : "never-existed", { event: e.id, scope: s, value: v }); return true; });
row(142, "spec.reviewed", "d.witness.specId", (s, e) => each(142, "spec", e.data?.witness?.specId, s, e, specLoc(s)));
row(143, "spec.reviewed", "d.witness.operationId", (s, e) => each(143, "op", e.data?.witness?.operationId, s, e, opLoc(s, { filter: (o) => o.specId === e.data.witness.specId, filterClass: "wrong-owner" })));
row(144, "spec.ratified", "E.subject", (s, e) => each(144, "spec", e.subject, s, e, specLoc(s)));
row(145, "spec.ratified", "d.operations[]", (s, e) => each(145, "op", e.data?.operations, s, e, opLoc(s, { filter: (o) => o.specId === e.subject, filterClass: "wrong-owner" })));
row(146, "spec.ratified", "keys of d.witnesses", (s, e) => each(146, "op", Object.keys(e.data?.witnesses ?? {}), s, e, opLoc(s)));
row(147, "spec.withdrawn", "E.subject", (s, e) => each(147, "spec", e.subject, s, e, specLoc(s)));
row(148, "spec.conflict.resolved", "E.subject + d.keep", (s, e) => {
    each(148, "spec", e.subject, s, e, specLoc(s));
    each(148, "specVerdict", e.data?.keep, s, e, lawLoc(s, { filter: (o) => o.subject === e.subject })); return true;
});
row(149, "problem.conflict.resolved", "E.subject + d.keep", (s, e) => {
    each(149, "problem", e.subject, s, e, evidenceLoc(s));
    each(149, "problemVerdict", e.data?.keep, s, e, { ...evidenceLoc(s), filter: (o) => o.subject === e.subject }); return true;
});
row(150, "ack.granted", "d.ack.operationId (basis gap)", (s, e) => e.data?.ack?.basis === "gap" && each(150, "op", e.data.ack.operationId, s, e, opLoc(s)));
row(151, "ack.granted", "d.ack.requirementId (basis debt)", (s, e) => e.data?.ack?.basis === "debt" && each(151, "requirement", e.data.ack.requirementId, s, e, reqLoc(s)));
row(152, "ack.released", "E.subject", (s, e) => each(152, "ack", e.subject, s, e, lawLoc(s)));
row(153, "audit.recorded", "d.audit.requirementId", (s, e) => each(153, "requirement", e.data?.audit?.requirementId, s, e, reqLoc(s)));
row(154, "audit.recorded", "d.audit.observations[].pointerId", (s, e) => each(154, "pointer", arr(e.data?.audit?.observations).map((o) => o?.pointerId), s, e, evidenceLoc(s)));
row(155, "vacuity.checked", "d.check.criterionId", (s, e) => each(155, "criterion", e.data?.check?.criterionId, s, e, critLoc(s)));
row(156, "pointer.declared", "d.pointer.requirementId", (s, e) => each(156, "requirement", e.data?.pointer?.requirementId, s, e, reqLoc(s)));
row(157, "pointer.declared", "d.pointer.criterionId", (s, e) => each(157, "criterion", e.data?.pointer?.criterionId, s, e, critLoc(s)));
row(158, "pointer.declared", "d.pointer.operationId (state pending)", (s, e) => e.data?.pointer?.state === "pending" && each(158, "op", e.data.pointer.operationId, s, e, opLoc(s, { filter: (o) => o.opKind === "add_criterion", filterClass: "wrong-owner" })));
row(159, "pointer.restated", "E.subject", (s, e) => each(159, "pointer", e.subject, s, e, { ...evidenceLoc(s), retired: (o) => pointerRetired.has(o.subject) }));
row(160, "pointer.retired", "E.subject", (s, e) => each(160, "pointer", e.subject, s, e, evidenceLoc(s)));
row(161, "population.pinned", "d.pin.requirementId", (s, e) => each(161, "requirement", e.data?.pin?.requirementId, s, e, reqLoc(s)));
row(162, "population.pinned", "d.supersedes", (s, e) => each(162, "population", e.data?.supersedes, s, e, evidenceLoc(s)));
row(163, "problem.raised", "d.problem.requirementId", (s, e) => each(163, "requirement", e.data?.problem?.requirementId, s, e, reqLoc(s)));
row(164, "problem.raised", "d.problem.auditId", (s, e) => each(164, "audit", e.data?.problem?.auditId, s, e, evidenceLoc(s)));
row(165, "problem.adjudicated", "E.subject", (s, e) => each(165, "problem", e.subject, s, e, evidenceLoc(s)));

// Ambiguous candidates (§1.1b): shared iff the node was published as a doc.version.
const amb = { ambiguous: true };
const nodeRow = (n, kind, field, get) => row(n, kind, field, (s, e) => { const v = get(e); if (v === undefined) return false; arr(v).forEach((x) => resolveNode(n, x, s, e)); return arr(v).length > 0; }, amb);
nodeRow("A1", "finding.created", "d.targetId (targetKind node)", (e) => (e.data?.targetKind === "node" ? e.data.targetId : undefined));
nodeRow("A2", "note.created", "d.targetId (targetKind node)", (e) => (e.data?.targetKind === "node" ? e.data.targetId : undefined));
nodeRow("A3", "triage.asserted", "d.targetId (targetKind node)", (e) => (e.data?.targetKind === "node" ? e.data.targetId : undefined));
nodeRow("A4", "triage.cleared", "d.targetId (targetKind node)", (e) => (e.data?.targetKind === "node" ? e.data.targetId : undefined));
nodeRow("A5", "graph.published", "d.nodeId", (e) => e.data?.nodeId);
nodeRow("A6", "graph.published", "d.edges[].to", (e) => arr(e.data?.edges).map((x) => x?.to));
nodeRow("A7", "pointer.declared", "d.pointer.target.id (target.kind node)", (e) => (e.data?.pointer?.target?.kind === "node" ? e.data.pointer.target.id : undefined));
row("A8", "repair.sort-recorded", "d.restsOn[] (free labels)", (s, e) => {
    const v = arr(e.data?.restsOn);
    for (const x of v) {
        const hit = reg.get("requirement")?.has(x) || reg.get("answer")?.has(x);
        tally("A8", hit ? "ok-unordered" : "unverifiable", { event: e.id, scope: s, value: x });
    }
    return v.length > 0;
}, amb);
row("A9", "decision.* (round/confirm/answer/reading/question kinds)", "E.subject vs d.decision / d.round.id", (s, e) => {
    const want = e.kind === "decision.round.posted" ? e.data?.round?.id : e.kind === "decision.question.logged" ? undefined : e.data?.decision?.id ?? e.data?.decision ?? e.data?.answer;
    if (want === undefined || typeof want !== "string") return false;
    tally("A9", e.subject === want ? "ok-unordered" : "unverifiable", { event: e.id, scope: s, value: e.subject, data: want });
    return true;
}, { ...amb, kinds: ["decision.round.posted", "decision.confirm.posted", "decision.answer.recorded", "decision.answer.revised", "decision.reading.recorded", "decision.question.logged"] });

// ---- run ---------------------------------------------------------------------
const kindCount = new Map();
for (const { e } of events) kindCount.set(e.kind, (kindCount.get(e.kind) ?? 0) + 1);
for (const r of R) {
    const res = rowOf(r.n);
    const kinds = r.kinds ?? [r.kind];
    for (const { scope, e } of events) {
        if (!kinds.includes(e.kind)) continue;
        res.events++;
        if (r.run(scope, e)) res.eventsWithValue++;
    }
}

// Cross-scope reuse of a subject id is worth knowing: "exists anywhere" is ambiguous for it.
const dupSubjects = {};
for (const name of ["finding", "bug", "note", "spec", "op"]) {
    const m = reg.get(name) ?? new Map();
    const d = [...m].filter(([, o]) => new Set(o.map((x) => x.scope)).size > 1);
    dupSubjects[name] = { ids: m.size, inMoreThanOneScope: d.length, examples: d.slice(0, 3).map(([id, o]) => ({ id, scopes: [...new Set(o.map((x) => x.scope))] })) };
}

const out = {
    sidecar: root, order: sortSource, law: lawFoldNote, foldMismatch,
    read: { scopes: scopes.size, nonBlankLines: lines, events: events.length, damage: damage.length, damageExamples: damage.slice(0, 3),
        tornTail: torn.length, tornExamples: torn.slice(0, 3), malformedEnvelope: malformed.length, malformedExamples: malformed.slice(0, 3),
        idCollisions: collisions.length, collisionExamples: collisions.slice(0, 3) },
    universes, kindCount: Object.fromEntries([...kindCount].sort()), duplicateSubjects: dupSubjects,
    rows: R.map((r) => {
        const res = rowOf(r.n);
        const classes = Object.fromEntries([...res.classes].map(([k, v]) => [k, v]));
        const dangling = [...res.classes].filter(([k]) => DANGLING.has(k) || k === "malformed-value").reduce((a, [, v]) => a + v.count, 0);
        return { n: r.n, kind: r.kinds ? r.kinds.join("|") : r.kind, field: r.field, ambiguous: !!r.ambiguous,
            eventsOfKind: res.events, eventsWithValue: res.eventsWithValue, referencesChecked: res.values, dangling, classes,
            ...(r.note ? { note: r.note } : {}), ...(r.ambiguousIdentity ? { ambiguousIdentity: r.ambiguousIdentity } : {}) };
    }),
};
out.totals = {};
for (const key of ["definite", "ambiguous"]) {
    const rs = out.rows.filter((r) => r.ambiguous === (key === "ambiguous"));
    out.totals[key] = {
        rows: rs.length, rowsWithEvents: rs.filter((r) => r.eventsOfKind > 0).length,
        eventsChecked: rs.reduce((a, r) => a + r.eventsOfKind, 0), referencesChecked: rs.reduce((a, r) => a + r.referencesChecked, 0),
        dangling: rs.reduce((a, r) => a + r.dangling, 0),
        byClass: rs.reduce((a, r) => { for (const [k, v] of Object.entries(r.classes)) a[k] = (a[k] ?? 0) + v.count; return a; }, {}),
    };
}

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
const p = console.log;
p(`sidecar: ${root}`);
p(`order: ${sortSource}   law: ${lawFoldNote}`);
p(`read: ${out.read.scopes} scopes, ${lines} non-blank lines, ${events.length} events; damage (non-JSON) ${damage.length}, torn tail ${torn.length}, malformed envelope ${malformed.length}, id collisions ${collisions.length}`);
for (const d of damage.slice(0, 3)) p(`  damage: ${d.shard}:${d.line} ${d.sample}`);
if (foldMismatch.length) p(`fold vs derivation: ${foldMismatch.join("; ")}`);
p("NB: 'earlier' is measured within one scope (sortEvents), or within the standard fold's merged view; across scopes it cannot be measured on this data (no global order) — those resolve as ok-unordered.");
for (const r of out.rows) {
    const head = `${r.ambiguous ? "[AMBIGUOUS] " : ""}#${r.n} ${r.kind} ${r.field}`;
    if (!r.eventsOfKind) { p(`${head}: NO EVENTS of this kind`); continue; }
    p(`${head}: ${r.eventsOfKind} events, ${r.eventsWithValue} carry the field, ${r.referencesChecked} refs, ${r.dangling} dangling`);
    for (const [k, v] of Object.entries(r.classes)) p(`    ${k}: ${v.count}  e.g. ${v.examples.map((x) => JSON.stringify(x)).join(" ")}`);
}
p(`totals: ${JSON.stringify(out.totals)}`);
p(`subject ids in >1 scope: ${JSON.stringify(Object.fromEntries(Object.entries(dupSubjects).map(([k, v]) => [k, v.inMoreThanOneScope])))}`);
