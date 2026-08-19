import { test } from "node:test";
import assert from "node:assert/strict";
import { planPromotion, promotionOwns } from "./pr-promote.js";
import { splitSpec, isDurableHeading } from "./pr-story.js";
import type { StoryChapter, StoryStep } from "./pr-story.js";

const step = (anchorId: string, symbol: string, layer: number): StoryStep => ({
  anchorId, file: "src/X.cs", symbol, signature: "", change: "added",
  complexity: "standard", severity: "untriaged", lane: "code", layer,
});
const chapter = (over: Partial<StoryChapter> & { steps: StoryStep[] }): StoryChapter => ({
  id: "c1", occurrence: 1, title: "Confirmation axis", source: "spec", specPath: "docs/specs/x/01-domain-model.md",
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

test("two chapters never share a node id — `document()` upserts, so a shared id is a silent rewrite", () => {
  // the same heading under two specs: routine in a numbered spec cluster
  const a = planPromotion(chapter({ title: "Validation rules", specPath: "docs/specs/x/01-domain-model.md", steps: [step("a1", "A", 3)] }));
  const b = planPromotion(chapter({ title: "Validation rules", specPath: "docs/specs/x/02-api.md", steps: [step("a2", "B", 3)] }));
  assert.notEqual(a.id, b.id);

  // headings that differ only past the slug's length cap
  const long = "Settlement reconciliation for partially delivered supplier orders (phase ";
  const one = planPromotion(chapter({ title: long + "one)", steps: [step("a1", "A", 3)] }));
  const two = planPromotion(chapter({ title: long + "two)", steps: [step("a2", "B", 3)] }));
  assert.notEqual(one.id, two.id, "a truncated slug must carry a digest of what was cut");

  // and the same heading twice inside ONE spec file
  const first = planPromotion(chapter({ title: "Notes", occurrence: 1, steps: [step("a1", "A", 3)] }));
  const again = planPromotion(chapter({ title: "Notes", occurrence: 2, steps: [step("a2", "B", 3)] }));
  assert.notEqual(first.id, again.id);
  assert.notEqual(first.promotedFrom, again.promotedFrom, "ownership must tell the two apart too");
});

test("promoting the same section twice targets the same node — a re-promote updates, it does not fork", () => {
  const c = chapter({ title: "Validation rules", steps: [step("a1", "A", 3)] });
  assert.equal(planPromotion(c).id, planPromotion(c).id);
  assert.equal(planPromotion(c).promotedFrom, planPromotion(c).promotedFrom);
});

test("the body's provenance line names the section, and is what marks the node as this chapter's", () => {
  const p = planPromotion(chapter({ title: "Validation rules", prose: "The rules.", steps: [step("a1", "A", 3)] }));
  assert.ok(p.promotedFrom, "a spec chapter owns the node it promotes to");
  assert.match(p.promotedFrom!, /01-domain-model\.md/);
  assert.match(p.promotedFrom!, /§ Validation rules/);
  assert.ok(p.body.includes(p.promotedFrom!), "the marker must be findable in the stored body");

  // a derived chapter cites no spec section, so it owns nothing and may never overwrite
  const d = planPromotion(chapter({ source: "derived", specPath: undefined, title: "Domains/Fin/Domain", steps: [step("a1", "A", 3)] }));
  assert.equal(d.promotedFrom, undefined);
});

test("a title that slugs to nothing falls back to the chapter, not to the bare prefix", () => {
  const p = planPromotion(chapter({ id: "spec-x-md", title: "—", steps: [step("a1", "A", 3)] }), { idPrefix: "pr42-" });
  assert.notEqual(p.id, "pr42-", "the fallback applied to the whole template only fired when the prefix was empty too");
  assert.match(p.id, /^pr42-/);
});

test("a promotion may only overwrite a node its own spec section wrote", () => {
  const p = planPromotion(chapter({ title: "Validation rules", prose: "The rules.", steps: [step("a1", "A", 3)] }));

  assert.equal(promotionOwns({ body: p.body }, p.promotedFrom), true, "re-promoting the same section updates its node");
  assert.equal(promotionOwns({ body: "Hand-written notes about validation." }, p.promotedFrom), false);
  assert.equal(promotionOwns(undefined, p.promotedFrom), false);

  // a sibling spec's section is a different claim even under the same heading
  const other = planPromotion(chapter({ title: "Validation rules", specPath: "docs/specs/x/02-api.md", steps: [step("a2", "B", 3)] }));
  assert.equal(promotionOwns({ body: other.body }, p.promotedFrom), false);

  // a derived chapter has no section to cite, so it owns nothing — an empty
  // marker must not make `includes` vacuously true
  const derived = planPromotion(chapter({ source: "derived", specPath: undefined, title: "src/api", steps: [step("a1", "A", 3)] }));
  assert.equal(promotionOwns({ body: derived.body }, derived.promotedFrom), false);
});

test("a fenced code line can never become the promoted node's summary", () => {
  // `isProse` dropped fence DELIMITERS but kept fence CONTENTS, so a SQL line that
  // starts with a capital and is long enough passed every check — and it was
  // reported as `summarySource: "spec"`, which tells the surface a real description
  // was found and stops it asking the human for one.
  const p = planPromotion(chapter({
    title: "Fallback title",
    prose: "Add the column:\n```sql\nSELECT * FROM orders WHERE settled = true\n```\nThe ledger is authoritative here.",
    steps: [step("a1", "A", 3)],
  }));
  assert.equal(p.summary.includes("SELECT"), false);
  assert.match(p.summary, /ledger is authoritative/);
  assert.equal(p.summarySource, "spec");

  // with nothing but code under it, there is no spec sentence — say so
  const only = planPromotion(chapter({
    title: "Migration", prose: "```sql\nALTER TABLE orders ADD COLUMN settled bool\n```", steps: [step("a1", "A", 3)],
  }));
  assert.equal(only.summarySource, "title", "the surface must ask the human rather than quote SQL at them");
});
