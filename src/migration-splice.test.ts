import { test } from "node:test";
import assert from "node:assert/strict";
import { readSets, type LogEvent } from "./eventlog.js";
import { splice } from "./migration-splice.js";

const ev = (id: string, writer: string, writerPrev: string, after: string[]): LogEvent =>
  ({ id, kind: "k", subject: "s", actor: { principal: writer }, at: "", after, writer, writerPrev, sidecarProtocol: 1, eventSchema: 1 }) as LogEvent;
const migrate = (all: LogEvent[], drop: string[]) => {
  const d = new Set(drop);
  return splice(all, all.filter((e) => !d.has(e.id)), d).map((e, i) => ({ ...e, seq: i + 1 }));
};

test("a kept event whose writer's previous event is dropped keeps what that one had read", () => {
  const all = [ev("C", "W1", "GENESIS", []), ev("R2", "W2", "GENESIS", ["C"]), ev("K", "W2", "R2", [])];
  assert.equal(readSets(migrate(all, [])).saw("K", "C"), true);
  assert.equal(readSets(migrate(all, ["R2"])).saw("K", "C"), true);
});

test("an event that read a dropped one keeps what it saw through that one's writer chain", () => {
  const all = [ev("a0", "A", "GENESIS", []), ev("p", "A", "a0", []), ev("e", "B", "GENESIS", ["p"])];
  assert.equal(readSets(migrate(all, [])).saw("e", "a0"), true);
  const out = migrate(all, ["p"]);
  assert.equal(readSets(out).saw("e", "a0"), true);
  assert.ok(!out.some((x) => x.after.includes("p") || x.writerPrev === "p"), "the dropped id is named nowhere");
});
