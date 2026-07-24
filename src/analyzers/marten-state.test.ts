/**
 * State-machine extraction tests: buildMartenModel + deriveStateMachines +
 * analyzeMarten checks, over a synthesized C# fixture (no store, no git).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMartenModel, deriveStateMachines, analyzeMarten } from "./marten.js";
import { emitMartenGraph } from "./marten-emit.js";
import { writeStore, loadNodes, readGraph } from "../store.js";
import { indexRepo } from "../repo.js";
import { document as documentNode, connect, stateMap, nodeCatalog } from "../ops.js";
import { markReviewed } from "../reviews.js";

// Hold: class aggregate — object-initializer Create, `this.`/bare assignments,
// if/else branch targets, ternary (dynamic), `e.X` RHS (dynamic), a second
// enum-typed property (Audit) that must NOT become the machine.
const HOLD_CS = `
namespace Bank;

public enum HoldStatus { Pending, Approved, Settled, Cancelled }
public enum AuditKind { None, Full }

public record HoldCreated(string Id);
public record HoldApproved(string Id);
public record HoldCancelled(bool Hard);
public record HoldRouted(int Kind);
public record HoldSynced(HoldStatus Status);
public record HoldAudited();

public class Hold
{
    public string Id { get; set; } = "";
    public HoldStatus Status { get; set; } = HoldStatus.Pending;
    public AuditKind Audit { get; set; }

    public static Hold Create(HoldCreated e) => new Hold { Id = e.Id, Status = HoldStatus.Pending };
    public void Apply(HoldApproved e) { this.Status = HoldStatus.Approved; }
    public void Apply(HoldCancelled e)
    {
        if (e.Hard) { Status = HoldStatus.Cancelled; }
        else { Status = HoldStatus.Pending; }
    }
    public void Apply(HoldRouted e) { Status = e.Kind == 1 ? HoldStatus.Approved : HoldStatus.Pending; }
    public void Apply(HoldSynced e) { Status = e.Status; }
    public void Apply(HoldAudited e) { Audit = AuditKind.Full; }
}
`;

// Shipment: record aggregate — with-expression targets (non-status initializers
// ignored), switch-expression inside a with-initializer (dynamic).
const SHIPMENT_CS = `
namespace Bank;

public enum ShipStatus { New, Sent, Delivered }

public record ShipCreated(string Id);
public record ShipSent(string Id);
public record ShipRouted(int Kind);

public record Shipment
{
    public string Id { get; init; } = "";
    public ShipStatus State { get; init; }

    public static Shipment Create(ShipCreated e) => new Shipment { Id = e.Id, State = ShipStatus.New };
    public Shipment Apply(ShipSent e) => this with { State = ShipStatus.Sent, Id = e.Id };
    public Shipment Apply(ShipRouted e) => this with { State = e.Kind switch { 1 => ShipStatus.Delivered, _ => ShipStatus.Sent } };
}
`;

// Invoice: constructor-style Create — the enum literal is a positional arg
// ("?ctor"); the e.Id arg must not pollute the machine.
const INVOICE_CS = `
namespace Bank;

public enum InvStatus { Draft, Issued }

public record InvCreated(string Id);
public record InvIssued(string Id);

public class Invoice
{
    public string Id { get; set; } = "";
    public InvStatus Status { get; set; }

    public Invoice(string id, InvStatus status) { Id = id; Status = status; }
    public static Invoice Create(InvCreated e) => new Invoice(e.Id, InvStatus.Draft);
    public void Apply(InvIssued e) { Status = InvStatus.Issued; }
}
`;

// Order: fully static machine with an unreachable member (Lost) — the
// state-unreachable warn fires only when no transition is dynamic.
const ORDER_CS = `
namespace Bank;

public enum OrderStatus { Draft, Placed, Lost }

public record OrderCreated(string Id);
public record OrderPlaced(string Id);

public class Order
{
    public OrderStatus Status { get; set; } = OrderStatus.Draft;

    public static Order Create(OrderCreated e) => new Order { Status = OrderStatus.Draft };
    public void Apply(OrderPlaced e) { Status = OrderStatus.Placed; }
}
`;

// Quote: the Guid state-constant pattern (Acme.API) — no enum anywhere; the
// vocabulary is a static class of Guid constants, bound to the status prop by
// usage. Includes a generic state-changed event (dynamic) and an unreferenced
// constant (Orphan) that dynamic transitions keep out of the unreachable warn.
const QUOTE_CS = `
namespace Bank;

public static class QuoteStates
{
    public static readonly Guid Quoting = new Guid("930A79B9-21FD-40BF-9F90-6FF20FB618F7");
    public static readonly Guid Released = new Guid("7A815EDE-A451-4AA0-AA53-066B5C12CAE6");
    public static Guid Cancelled = new Guid("955857ED-2AF7-4FCA-B93B-43DC0E5F8FF3");
    public static readonly Guid Orphan = new Guid("11111111-1111-1111-1111-111111111111");
}

public record QuoteCreated(string Id);
public record QuoteReleased(string Id);
public record QuoteCancelled(string Id);
public record QuoteStateChanged(Guid NewStateId);

public class Quote
{
    public string Id { get; set; } = "";
    public Guid EntityStateId { get; set; } = QuoteStates.Quoting;

    public static Quote Create(QuoteCreated e) => new Quote { Id = e.Id };
    public void Apply(QuoteReleased e) { EntityStateId = QuoteStates.Released; }
    public void Apply(QuoteCancelled e) { EntityStateId = QuoteStates.Cancelled; }
    public void Apply(QuoteStateChanged e) { EntityStateId = e.NewStateId; }
}
`;

// Widget: an enum-typed TYPE DISCRIMINATOR (not status-named, only ever copied
// from the event payload → all-dynamic) must NOT become a state machine — the
// Acme CustomFieldType/Order false-positive class.
const WIDGET_CS = `
namespace Bank;

public enum WidgetKind { Text, Number, Date }

public record WidgetCreated(WidgetKind Kind);

public class Widget
{
    public string Id { get; set; } = "";
    public WidgetKind Kind { get; set; } = WidgetKind.Text;

    public static Widget Create(WidgetCreated e) => new Widget { Kind = e.Kind };
}
`;

// Endpoints: Approve emits HoldApproved without reading Status (unguarded
// candidate); Cancel reads hold.Status before emitting (guarded).
const ENDPOINTS_CS = `
namespace Bank;

public record ApproveHold(string Id) : IIntentCommand;
public record CancelHold(string Id) : IIntentCommand;

public static class HoldEndpoints
{
    [WolverinePost("/holds/approve")]
    public static void Approve(ApproveHold cmd, IDocumentSession session)
    {
        session.Events.Append(cmd.Id, new HoldApproved(cmd.Id));
    }

    [WolverinePost("/holds/cancel")]
    public static void Cancel(CancelHold cmd, Hold hold, IDocumentSession session)
    {
        if (hold.Status != HoldStatus.Approved) return;
        session.Events.Append(cmd.Id, new HoldCancelled(true));
    }
}
`;

function mkFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "codemap-state-"));
  mkdirSync(join(root, "Domain"));
  mkdirSync(join(root, "Api"));
  writeFileSync(join(root, "Domain", "Hold.cs"), HOLD_CS);
  writeFileSync(join(root, "Domain", "Shipment.cs"), SHIPMENT_CS);
  writeFileSync(join(root, "Domain", "Invoice.cs"), INVOICE_CS);
  writeFileSync(join(root, "Domain", "Order.cs"), ORDER_CS);
  writeFileSync(join(root, "Domain", "Widget.cs"), WIDGET_CS);
  writeFileSync(join(root, "Domain", "Quote.cs"), QUOTE_CS);
  writeFileSync(join(root, "Api", "Endpoints.cs"), ENDPOINTS_CS);
  return root;
}

test("state machines: extraction and derivation", async () => {
  const root = mkFixture();
  try {
    const machines = deriveStateMachines(await buildMartenModel(root));
    const by = new Map(machines.map((x) => [x.aggregate, x]));
    // Widget is absent: a non-status-named enum prop with zero static targets is
    // a type discriminator, not a machine.
    assert.deepEqual([...by.keys()].sort(), ["Hold", "Invoice", "Order", "Quote", "Shipment"]);

    // Quote: Guid state-constant vocabulary, bound by usage
    const quote = by.get("Quote")!;
    assert.equal(quote.prop, "EntityStateId");
    assert.equal(quote.enumName, "QuoteStates");
    assert.deepEqual(quote.members, ["Quoting", "Released", "Cancelled", "Orphan"]);
    assert.deepEqual(quote.initialMembers, ["Quoting"]); // property default
    const qt = new Map(quote.transitions.map((t) => [t.event, t]));
    assert.deepEqual(qt.get("QuoteReleased")!.targets, ["Released"]);
    assert.deepEqual(qt.get("QuoteCancelled")!.targets, ["Cancelled"]);
    assert.equal(qt.get("QuoteStateChanged")!.dynamic, true); // e.NewStateId
    assert.equal(qt.has("QuoteCreated"), false); // Create assigns no state

    // Hold: enum + prop choice, all assignment forms
    const hold = by.get("Hold")!;
    assert.equal(hold.prop, "Status");
    assert.equal(hold.enumName, "HoldStatus");
    assert.deepEqual(hold.members, ["Pending", "Approved", "Settled", "Cancelled"]);
    assert.deepEqual(hold.otherEnumProps, ["Audit"]);
    assert.deepEqual(hold.initialMembers.sort(), ["Pending"]); // object-init Create + property default
    const ht = new Map(hold.transitions.map((t) => [t.event, t]));
    assert.deepEqual(ht.get("HoldApproved")!.targets, ["Approved"]); // this.Status = …
    assert.equal(ht.get("HoldApproved")!.dynamic, false);
    assert.deepEqual(ht.get("HoldCancelled")!.targets.sort(), ["Cancelled", "Pending"]); // if/else branches
    assert.equal(ht.get("HoldCancelled")!.dynamic, false);
    assert.deepEqual(ht.get("HoldRouted")!.targets, []); // ternary
    assert.equal(ht.get("HoldRouted")!.dynamic, true);
    assert.equal(ht.get("HoldSynced")!.dynamic, true); // e.Status is not a state literal
    assert.deepEqual(ht.get("HoldSynced")!.targets, []);
    assert.equal(ht.has("HoldAudited"), false); // assigns Audit, not the machine prop
    assert.equal(ht.get("HoldCreated")!.isCreate, true);

    // Shipment: with-expression + switch-inside-with
    const ship = by.get("Shipment")!;
    assert.equal(ship.prop, "State");
    const st = new Map(ship.transitions.map((t) => [t.event, t]));
    assert.deepEqual(st.get("ShipSent")!.targets, ["Sent"]); // Id = e.Id initializer ignored
    assert.equal(st.get("ShipSent")!.dynamic, false);
    assert.equal(st.get("ShipRouted")!.dynamic, true);
    assert.deepEqual(ship.initialMembers, ["New"]);

    // Invoice: positional ctor arg resolves; e.Id arg doesn't pollute
    const inv = by.get("Invoice")!;
    const it = new Map(inv.transitions.map((t) => [t.event, t]));
    assert.deepEqual(it.get("InvCreated")!.targets, ["Draft"]);
    assert.equal(it.get("InvCreated")!.dynamic, false);
    assert.deepEqual(it.get("InvIssued")!.targets, ["Issued"]);
    assert.deepEqual(inv.initialMembers, ["Draft"]);

    // Order: fully static
    const order = by.get("Order")!;
    assert.equal(order.transitions.some((t) => t.dynamic), false);
    assert.deepEqual(order.initialMembers.sort(), ["Draft"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state machines: findings", async () => {
  const root = mkFixture();
  try {
    const r = await analyzeMarten(root, { verbose: true });
    const of = (check: string) => r.findings.filter((f) => f.check === check);

    // unreachable fires for the static Order machine only — Hold has dynamic
    // transitions (which may reach Settled), so it must stay quiet.
    assert.ok(of("state-unreachable").some((f) => f.entity === "Order.Lost"));
    assert.ok(!of("state-unreachable").some((f) => f.entity.startsWith("Hold.")));

    assert.ok(of("transition-dynamic").some((f) => f.entity === "Hold ← HoldRouted"));
    assert.ok(of("transition-dynamic").some((f) => f.entity === "Shipment ← ShipRouted"));
    assert.ok(of("status-prop-ambiguous").some((f) => f.entity === "Hold"));

    const unguarded = of("transition-unguarded-candidate");
    assert.ok(unguarded.some((f) => f.entity === "HoldEndpoints.Approve → HoldApproved"));
    assert.ok(!unguarded.some((f) => f.entity.startsWith("HoldEndpoints.Cancel")));

    assert.equal(r.summary.stateMachines, 5);
    assert.equal(r.summary.states, 4 + 3 + 2 + 3 + 4);
    // warns (non-verbose path) still include state-unreachable
    const quiet = await analyzeMarten(root, {});
    assert.ok(quiet.findings.some((f) => f.check === "state-unreachable"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state machines: emission, idempotence, enrichment survival", async () => {
  const root = mkFixture();
  try {
    await writeStore(root, await indexRepo(root), { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });
    const r1 = await emitMartenGraph(root);
    assert.equal(r1.states, 16);
    assert.equal(r1.transitions, 15);

    const nodes1 = await loadNodes(root);
    const byId = new Map(nodes1.map((n) => [n.id, n]));
    const tHoldApproved = byId.get("mtr-hold-holdapproved")!;
    assert.ok(tHoldApproved, "transition skeleton exists");
    assert.equal(tHoldApproved.type, "transition");
    assert.equal(tHoldApproved.generatedBy, "marten");
    assert.ok(tHoldApproved.anchors.length >= 2, "cites the Apply method AND the emitting handler");
    const sPending = byId.get("mst-hold-pending")!;
    assert.equal(sPending.type, "state");
    assert.ok(sPending.anchors.length === 1, "state cites the enum shell anchor");

    const g1 = await readGraph(root);
    const has = (from: string, to: string, type: string) =>
      g1.edges.some((e) => e.from === from && e.to === to && e.type === type);
    assert.ok(has("mtr-hold-holdapproved", "mst-hold-approved", "transitions_to"));
    assert.ok(has("mst-hold-pending", "magg-hold", "state_of"));
    assert.ok(has("magg-hold", "mst-hold-pending", "initial_state"));
    assert.ok(has("mtr-hold-holdapproved", "mev-holdapproved", "on_event"));
    // dynamic transition has no static target edge
    assert.ok(!g1.edges.some((e) => e.from === "mtr-hold-holdrouted" && e.type === "transitions_to"));

    // idempotence: same node ids and edge set on re-emit
    await emitMartenGraph(root);
    const nodes2 = await loadNodes(root);
    assert.deepEqual(nodes2.map((n) => n.id).sort(), nodes1.map((n) => n.id).sort());
    assert.equal((await readGraph(root)).edges.length, g1.edges.length);

    // enrichment: an authored tr- node + from_state edge survive a re-emit untouched
    const doc = await documentNode(root, {
      id: "tr-hold-holdapproved", type: "transition", title: "Hold ← HoldApproved (sources)",
      summary: "Only from Pending; guard lives in the approve endpoint.", anchors: tHoldApproved.anchors,
    });
    assert.ok(!("error" in doc), `document: ${JSON.stringify(doc)}`);
    const conn = await connect(root, { from: "mst-hold-pending", to: "mtr-hold-holdapproved", type: "from_state" });
    assert.ok(!("error" in conn), `connect: ${JSON.stringify(conn)}`);
    await emitMartenGraph(root);
    const tr = (await loadNodes(root)).find((n) => n.id === "tr-hold-holdapproved");
    assert.ok(tr && !tr.generatedBy, "enrichment node survives re-emit as authored");
    assert.equal(tr!.status, "fresh");
    const g3 = await readGraph(root);
    assert.ok(
      g3.edges.some((e) => e.from === "mst-hold-pending" && e.to === "mtr-hold-holdapproved" && e.type === "from_state" && !e.generatedBy),
      "authored from_state edge survives re-emit",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stateMap op: fully authored machine (no analyzer involvement)", async () => {
  const root = mkFixture();
  try {
    await writeStore(root, await indexRepo(root), { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });
    // No emit: the machine is documented by hand, the way an agent maps a
    // handler-mutated document or collection-child lifecycle the static pass
    // can't see (Widget is the rejected discriminator — perfect stand-in).
    const doc = async (input: Parameters<typeof documentNode>[1]) => {
      const r = await documentNode(root, input);
      assert.ok(!("error" in r), JSON.stringify(r));
    };
    await doc({ id: "widget", type: "module", title: "Widget", summary: "Owner of the authored machine.", anchors: ["Widget.cs#Widget"] });
    for (const s of ["Text", "Number", "Date"]) {
      await doc({ id: `st-widget-${s.toLowerCase()}`, type: "state", title: `Widget · ${s}`, summary: `State ${s}.`, anchors: ["Widget.cs#WidgetKind"] });
    }
    await doc({ id: "tr-widget-widgetcreated", type: "transition", title: "Widget ← WidgetCreated", summary: "Created as Number when the payload says so.", anchors: ["Widget.cs#Create"] });
    const conn = await connect(root, { edges: [
      ...["text", "number", "date"].map((s) => ({ from: `st-widget-${s}`, to: "widget", type: "state_of" as const })),
      { from: "tr-widget-widgetcreated", to: "widget", type: "transition_of" as const },
      { from: "st-widget-text", to: "tr-widget-widgetcreated", type: "from_state" as const },
      { from: "tr-widget-widgetcreated", to: "st-widget-number", type: "transitions_to" as const },
      { from: "widget", to: "st-widget-text", type: "initial_state" as const },
    ] });
    assert.ok(!("error" in conn), JSON.stringify(conn));

    const r = await stateMap(root, { aggregate: "widget" });
    assert.equal(r.machines.length, 1);
    const m = r.machines[0]!;
    assert.equal(m.states.length, 3);
    const st = (id: string) => m.states.find((s) => s.id === id)!;
    assert.equal(st("st-widget-text").initial, true);
    assert.equal(st("st-widget-text").layer, 0);
    assert.equal(st("st-widget-number").layer, 1); // via real from_state chain
    assert.deepEqual(m.unreachable, ["st-widget-date"]);
    const t = m.transitions[0]!;
    // an authored transition is its own enrichment — never queued as unenriched
    assert.equal(t.enriched, true);
    assert.equal(t.enrichment!.id, "tr-widget-widgetcreated");
    assert.equal(t.enrichment!.trust, "unverified");
    assert.deepEqual(m.unenriched, []);
    assert.deepEqual(t.sources, ["st-widget-text"]);
    assert.deepEqual(t.targets, ["st-widget-number"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stateMap op: layout, enrichment join, work queue, trust", async () => {
  const root = mkFixture();
  try {
    await writeStore(root, await indexRepo(root), { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });
    await emitMartenGraph(root);

    // Before enrichment: every transition is source-less → flat two-layer map.
    let r = await stateMap(root, { aggregate: "Hold" });
    assert.deepEqual(r.aggregates.map((a) => a.title), ["Hold", "Invoice", "Order", "Quote", "Shipment"]);
    assert.equal(r.machines.length, 1);
    let m = r.machines[0]!;
    const state = (id: string) => m.states.find((s) => s.id === id)!;
    assert.equal(state("mst-hold-pending").initial, true);
    assert.equal(state("mst-hold-pending").layer, 0);
    assert.equal(state("mst-hold-approved").layer, 1); // gutter-fed
    assert.equal(state("mst-hold-settled").layer, 2); // unplaced → final layer
    assert.deepEqual(m.unreachable, ["mst-hold-settled"]);
    assert.equal(m.hasDynamic, true);
    const tr = (id: string) => m.transitions.find((t) => t.id === id)!;
    assert.equal(tr("mtr-hold-holdrouted").dynamic, true);
    assert.equal(tr("mtr-hold-holdapproved").dynamic, false);
    assert.equal(tr("mtr-hold-holdapproved").event!.id, "mev-holdapproved");
    assert.deepEqual(tr("mtr-hold-holdapproved").sources, []);
    assert.ok(m.unenriched.includes("mtr-hold-holdapproved"));
    assert.equal(tr("mtr-hold-holdapproved").enrichment, null);

    // Enrich: authored tr- node + from_state edge → joined, sourced, out of queue.
    const nodes = await loadNodes(root);
    const skeletonNode = nodes.find((n) => n.id === "mtr-hold-holdapproved")!;
    await documentNode(root, {
      id: "tr-hold-holdapproved", type: "transition", title: "Hold ← HoldApproved (sources)",
      summary: "Only from Pending; the approve endpoint does not read Status (unguarded).",
      anchors: skeletonNode.anchors,
    });
    await connect(root, { from: "mst-hold-pending", to: "mtr-hold-holdapproved", type: "from_state" });

    r = await stateMap(root, { aggregate: "Hold" });
    m = r.machines[0]!;
    const enrichedTr = tr("mtr-hold-holdapproved");
    assert.deepEqual(enrichedTr.sources, ["mst-hold-pending"]);
    assert.equal(enrichedTr.enriched, true);
    assert.equal(enrichedTr.enrichment!.id, "tr-hold-holdapproved");
    assert.equal(enrichedTr.enrichment!.trust, "unverified"); // authored, nobody vouched yet
    assert.ok(!m.unenriched.includes("mtr-hold-holdapproved"));
    // Approved is now reached through a real source → still layer 1, from Pending(0)
    assert.equal(state("mst-hold-approved").layer, 1);

    // Agent review on the enrichment → trust climbs to "checked".
    await markReviewed(root, { targetKind: "node", targetId: "tr-hold-holdapproved", level: "logical", actor: "agent" });
    r = await stateMap(root, { aggregate: "Hold" });
    m = r.machines[0]!;
    assert.equal(tr("mtr-hold-holdapproved").enrichment!.trust, "checked");

    // Catalog folds the pair: the skeleton row disappears, the enrichment row
    // absorbs its connectivity — one logical transition, not two entries.
    const cat = await nodeCatalog(root);
    const rows = cat.nodes.filter((n: { id: string }) => n.id.endsWith("hold-holdapproved") && n.id !== "mev-holdapproved");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, "tr-hold-holdapproved");
    assert.equal((rows[0] as { skeleton?: string }).skeleton, "mtr-hold-holdapproved");
    assert.ok(rows[0]!.degree > 0, "skeleton connectivity folded into the enrichment row");
    // unpaired skeletons still list normally
    assert.ok(cat.nodes.some((n: { id: string }) => n.id === "mtr-hold-holdrouted"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
