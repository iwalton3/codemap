import { test } from "node:test";
import assert from "node:assert/strict";
import { planPromotion } from "./pr-promote.js";
import { splitSpec, isDurableHeading } from "./pr-story.js";
import type { StoryChapter, StoryStep } from "./pr-story.js";

const step = (anchorId: string, symbol: string, layer: number): StoryStep => ({
  anchorId, file: "src/X.cs", symbol, signature: "", change: "added",
  complexity: "standard", severity: "untriaged", lane: "code", layer,
});
const chapter = (over: Partial<StoryChapter> & { steps: StoryStep[] }): StoryChapter => ({
  id: "c1", title: "Confirmation axis", source: "spec", specPath: "docs/specs/x/01-domain-model.md",
  durable: true, prose: "", ...over,
});

test("a chapter spanning layers becomes a flow, one step per layer — not one per symbol", () => {
  const p = planPromotion(chapter({ steps: [
    step("a1", "ConfirmEndpoint", 0), step("a2", "ConfirmRequest", 0),
    step("a3", "Handler", 1),
    step("a4", "Apply", 3), step("a5", "Shipment", 3),
  ] }));
  assert.equal(p.type, "process");
  assert.deepEqual(p.steps!.map((s) => s.title), ["Command", "Handler", "Aggregate"]);
  assert.deepEqual(p.steps!.map((s) => s.anchors.length), [2, 1, 2]);
  assert.equal(p.anchors.length, 5, "the process cites every symbol in the chapter");
});

test("a chapter at a single layer becomes a module — a one-step flow says nothing extra", () => {
  const p = planPromotion(chapter({ steps: [step("a1", "A", 3), step("a2", "B", 3)] }));
  assert.equal(p.type, "module");
  assert.equal(p.steps, undefined);
  assert.match(p.rationale, /single layer/i);
});

test("line references are stripped from the name the map will carry", () => {
  const p = planPromotion(chapter({ title: "4.4 Apply(OrderDeliveryCreated) (L540-544)", steps: [step("a1", "A", 3)] }));
  assert.equal(p.title, "4.4 Apply(OrderDeliveryCreated)");
  assert.ok(!/L540/.test(p.id));
});

test("a summary is taken from the spec only when it reads like one", () => {
  // an instruction, a path and a line reference are all patch talk, not descriptions
  for (const prose of [
    "Add `public bool ConfirmationRequired { get; set; }` to the aggregate.",
    "In `Domains/OrderDomain/ModelAndProjections/Shipment.cs`, after the block (L132-135):",
    "**Status:** Draft for review (v0.2)",
  ]) {
    const p = planPromotion(chapter({ prose, steps: [step("a1", "A", 3)] }));
    assert.equal(p.summarySource, "title", `should not summarise from: ${prose}`);
    assert.equal(p.summary, p.title);
  }
  // a statement about how the system behaves is a real summary
  const good = planPromotion(chapter({ prose: "When false (default), releases are auto-confirmed and no supplier email is sent.", steps: [step("a1", "A", 3)] }));
  assert.equal(good.summarySource, "spec");
  assert.match(good.summary, /auto-confirmed/);
});

test("the body keeps the prose and cites the spec it came from", () => {
  const p = planPromotion(chapter({ prose: "The confirmation axis lives on the aggregate.", steps: [step("a1", "A", 3)] }));
  assert.match(p.body, /confirmation axis lives/);
  assert.match(p.body, /01-domain-model\.md/, "the source spec is the citation that makes it checkable");
});

test("a change-scoped heading is not promotable even inside a system-describing spec", () => {
  // the file is durable; these sections describe the patch, not the system
  for (const h of ["3.1 Changed: `OrderShipmentCreated` (L903-968)", "3.2 New: `OrderShipmentConfirmed`", "4.4 Apply(X) — extend (D7)", "3.5 Not added"]) {
    assert.equal(isDurableHeading(h), false, `"${h}" should read as change-scoped`);
  }
  for (const h of ["Domain Model: the confirmation axis", "6. Failure semantics per transition", "Location preference (D1, D10)"]) {
    assert.equal(isDurableHeading(h), true, `"${h}" describes the system`);
  }
  const secs = splitSpec("docs/specs/x/01-domain-model.md", "## Overview of the axis\nprose\n## 3.1 Changed: `Foo` (L1-2)\nprose");
  assert.deepEqual(secs.map((s) => s.durable), [true, false]);
});
