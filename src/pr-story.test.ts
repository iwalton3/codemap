import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSpec, mentionedIdentifiers, layerOf, buildStory, type StoryStep } from "./pr-story.js";

const step = (o: Partial<StoryStep> & { anchorId: string; symbol: string }): StoryStep => ({
  file: "src/X.cs", signature: "", change: "added", complexity: "standard", severity: "untriaged",
  lane: "code", layer: 3, ...o,
} as StoryStep);

test("splitSpec cuts on headings but not on a # inside a fenced block", () => {
  const secs = splitSpec("docs/specs/x/01-domain-model.md", [
    "# Title", "intro prose", "## Section A", "```", "# not a heading", "```", "body a", "## Section B", "body b",
  ].join("\n"));
  const headings = secs.map((s) => s.heading);
  assert.deepEqual(headings, ["Title", "Section A", "Section B"]);
  assert.match(secs[1]!.text, /not a heading/);
});

test("a spec that describes the change is ephemeral; one that describes the system is durable", () => {
  assert.equal(splitSpec("docs/specs/x/01-domain-model.md", "# A\nx")[0]!.durable, true);
  assert.equal(splitSpec("docs/specs/x/02-api-and-notifications.md", "# A\nx")[0]!.durable, true);
  for (const p of ["docs/specs/x/implementation-log.md", "docs/specs/x/open-items.md", "docs/specs/x/05-implementation-plan.md", "docs/specs/x/README.md"]) {
    assert.equal(splitSpec(p, "# A\nx")[0]!.durable, false, `${p} should be ephemeral`);
  }
});

test("mentionedIdentifiers takes backticked spans and PascalCase, not prose", () => {
  const ids = mentionedIdentifiers("The `ConfirmShipment` endpoint emits OrderShipmentConfirmed when the supplier agrees.");
  assert.ok(ids.has("ConfirmShipment"));
  assert.ok(ids.has("OrderShipmentConfirmed"));
  assert.ok(!ids.has("supplier"), "lowercase prose must not become a match candidate");
});

test("layerOf orders a vertical slice command → handler → aggregate → query", () => {
  const l = (f: string, s = "X") => layerOf(f, s);
  assert.ok(l("Domains/D/Commands/Confirm.cs") < l("Domains/D/Handler/H.cs"));
  assert.ok(l("Domains/D/Handler/H.cs") < l("Domains/D/ModelAndProjections/A.cs"));
  assert.ok(l("Domains/D/ModelAndProjections/A.cs") < l("Domains/D/Queries/Q.cs"));
});

test("generic member names do not bind — only distinctive ones do", () => {
  const secs = splitSpec("docs/specs/x/01-domain-model.md", "## Changed: `OrderShipmentCreated`\nprose");
  const story = buildStory(secs, [
    step({ anchorId: "a_loc", symbol: "Location › Create", file: "Domains/Loc/Commands/CreateLocation.cs" }),
    step({ anchorId: "a_evt", symbol: "Order › OrderShipmentCreated" }),
  ]);
  const bound = story.chapters.filter((c) => c.source === "spec").flatMap((c) => c.steps.map((s) => s.anchorId));
  assert.deepEqual(bound, ["a_evt"], "a bare `Create` must not be claimed by an unrelated section");
});

test("an overload binds through its signature — the symbolPath alone cannot tell Applys apart", () => {
  const secs = splitSpec("docs/specs/x/01-domain-model.md", "## `Apply(OrderShipmentConfirmed e)` — new\nprose");
  const story = buildStory(secs, [
    step({ anchorId: "a_ok", symbol: "Order › Apply", signature: "public void Apply(OrderShipmentConfirmed e)" }),
    step({ anchorId: "a_no", symbol: "Order › Apply", signature: "public void Apply(OrderDeliveryCreated e)" }),
  ]);
  const chapter = story.chapters.find((c) => c.source === "spec")!;
  assert.deepEqual(chapter.steps.map((s) => s.anchorId), ["a_ok"]);
});

test("a prose-only section is not reported as shipped-without-code", () => {
  const secs = splitSpec("docs/specs/x/01-domain-model.md", "## Overview\nThis describes how suppliers confirm orders.\n## `WidgetService`\nprose");
  const story = buildStory(secs, []);
  assert.deepEqual(story.specWithoutCode.map((s) => s.heading), ["WidgetService"]);
});

test("symbols no section names are swept into derived chapters, grouped by directory", () => {
  const story = buildStory([], [
    step({ anchorId: "a_1", symbol: "A", file: "src/api/x.ts" }),
    step({ anchorId: "a_2", symbol: "B", file: "src/api/y.ts" }),
    step({ anchorId: "a_3", symbol: "C", file: "src/ui/z.ts" }),
  ]);
  assert.equal(story.undocumented, 3);
  assert.deepEqual(story.chapters.map((c) => c.title), ["src/api", "src/ui"]);
  assert.equal(story.chapters[0]!.durable, false);
});

test("a repeated heading yields two chapters, not one id shared by both", () => {
  // vdx keys the chapter list by id and drops a duplicate outright; the same id
  // also keys open/promoted state and is what the promoted node id derives from.
  const secs = splitSpec("docs/specs/x/01-domain-model.md",
    "## Refunds\n`RefundPolicy` applies.\n## Shipping\nprose\n## Refunds\n`RefundLedger` posts.");
  const story = buildStory(secs, [
    step({ anchorId: "a_1", symbol: "RefundPolicy", file: "src/RefundPolicy.cs" }),
    step({ anchorId: "a_2", symbol: "RefundLedger", file: "src/RefundLedger.cs" }),
  ]);
  const ids = story.chapters.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate chapter id in ${JSON.stringify(ids)}`);
  const refunds = story.chapters.filter((c) => c.title === "Refunds");
  assert.equal(refunds.length, 2);
  assert.deepEqual(refunds.map((c) => c.occurrence), [1, 2]);
});
