/**
 * The standard fold's `?.trim()` sites, each fed a field that is not text: the fold HALTS
 * naming the entry, never throws a TypeError from somewhere inside it (plan 1.2, owner batch 2:
 * "Rule, for decisions + standard"). One shape check at entry makes all eleven unreachable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldStandard } from "./shared-standard.js";
import { isLogDamage } from "./log-damage.js";
import type { LogEvent } from "./eventlog.js";

const alice = { principal: "alice" };
const ev = (id: string, kind: string, subject: string, data: Record<string, unknown>, after: string[] = []): LogEvent =>
  ({ id, kind, subject, actor: alice, at: "2026-09-28T00:00:00Z", after, writer: "w", data } as LogEvent);
const spec = { id: "S", title: "t", createdAt: "2026-09-28T00:00:00Z" };
const drafted = ev("e1", "spec.drafted", "S", { spec });
const op = { id: "o1", specId: "S", kind: "add_requirement", ord: 0, title: "t", section: "A", statement: "s", provenance: "p", rationale: "r", reversibility: "reversible" };

const cases: [string, LogEvent[]][] = [
  ["spec.drafted title", [ev("e1", "spec.drafted", "S", { spec: { ...spec, title: 5 } })]],
  ["spec.revised title", [drafted, ev("e2", "spec.revised", "S", { spec: { id: "S", title: 5 } }, ["e1"])]],
  ["a removal's reason", [drafted, ev("e2", "spec.operation", "S", { operation: op }, ["e1"]),
    ev("e3", "spec.operation.removed", "S", { operation: { ...op, removed: { reason: 5 } } }, ["e2"])]],
  ["an acknowledgement's rationale", [ev("e1", "ack.granted", "a", { ack: { id: "a", basis: "debt", rationale: 5, priority: "medium", revalidateBy: "2027-01-01" } })]],
  ["a vacuity check's method", [ev("e1", "vacuity.checked", "c", { check: { id: "v", criterionId: "c", verdict: "demonstrated", method: 5, witnesses: [{}] } })]],
  ["a pointer's rationale", [ev("e1", "pointer.declared", "p", { pointer: { id: "p", requirementId: "r", rationale: 5, target: { kind: "node" } } })]],
  ["a population member's id", [ev("e1", "population.pinned", "pp", { pin: { id: "pp", requirementId: "r", basis: "lint", members: [{ id: 5, state: "conforms" }] } })]],
  ["a population's reason", [ev("e1", "population.pinned", "pp", { pin: { id: "pp", requirementId: "r", basis: "not-expressible", members: [], reason: 5 } })]],
  ["a criterion's text", [drafted, ev("e2", "spec.operation", "S", { operation: { ...op, id: "o2", kind: "add_criterion", criterion: 5, falsifier: "f", evidenceKind: "lint-test", targetOperationId: "o1" } }, ["e1"])]],
  ["a new rule's title", [drafted, ev("e2", "spec.operation", "S", { operation: { ...op, title: 5 } }, ["e1"])]],
  ["an amendment's statement", [drafted, ev("e2", "spec.operation", "S", { operation: { ...op, kind: "amend_statement", requirementId: "r", statement: 5 } }, ["e1"])]],
];

for (const [name, events] of cases) {
  test(`halts naming the entry, not a TypeError: ${name}`, () => {
    const bad = events.at(-1)!.id;
    assert.throws(() => foldStandard(events), (e: unknown) => isLogDamage(e) && e.entry.id === bad);
  });
}
