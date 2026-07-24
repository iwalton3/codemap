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
import { document as documentNode, connect, stateMap } from "../ops.js";
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
    assert.deepEqual([...by.keys()].sort(), ["Hold", "Invoice", "Order", "Shipment"]);

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

    assert.equal(r.summary.stateMachines, 4);
    assert.equal(r.summary.states, 4 + 3 + 2 + 3);
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
    assert.equal(r1.states, 12);
    assert.equal(r1.transitions, 12);

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

test("stateMap op: layout, enrichment join, work queue, trust", async () => {
  const root = mkFixture();
  try {
    await writeStore(root, await indexRepo(root), { schemaVersion: 1, lastVerifiedCommit: null, grammarVersions: {} });
    await emitMartenGraph(root);

    // Before enrichment: every transition is source-less → flat two-layer map.
    let r = await stateMap(root, { aggregate: "Hold" });
    assert.deepEqual(r.aggregates.map((a) => a.title), ["Hold", "Invoice", "Order", "Shipment"]);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
