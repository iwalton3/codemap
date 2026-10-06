import { test } from "node:test";
import assert from "node:assert/strict";
import { RepairConnection, verifierIdentityKey } from "./verifier-boundary.js";

test("a connection claims the verifier role only before any other call, and then stays inside it", () => {
  const fresh = new RepairConnection("alice");
  assert.equal(fresh.claim().ok, true);
  assert.equal(fresh.claimed(), true);
  assert.equal(fresh.enter("repair_brief").ok, true);
  assert.equal(fresh.enter("repair_pending").ok, true, "a claimed session finds its work blind");
  assert.equal(fresh.enter("pull").ok, true, "D1: it pulls a request made on another clone; it still has no tool that reads the records");
  assert.match((fresh.enter("sync") as { error: string }).error, /does not allow/, "but it pushes nothing");
  assert.match((fresh.enter("repair_records") as { error: string }).error, /does not allow/, "B13: the records are off the blind verifier's allowlist");
  assert.equal(fresh.enter("repair_verification").ok, true, "a refused call does not end the role");
  assert.match((fresh.claim() as { error: string }).error, /already claimed/);

  const worked = new RepairConnection("alice");
  assert.equal(worked.enter("search").ok, true);
  assert.match((worked.claim() as { error: string }).error, /before any other codemap call/);
  assert.equal(worked.claimed(), false);
});

test("identity is the connection, and a subagent on it is a different verifier", () => {
  const a = new RepairConnection("alice"), b = new RepairConnection("alice");
  assert.notEqual(verifierIdentityKey(a.identity()), verifierIdentityKey(b.identity()), "two sessions of one person are two identities");
  const child = { ...a.identity(), harness: "claude-subagent" as const, child: "a1234567" };
  assert.notEqual(verifierIdentityKey(child), verifierIdentityKey(a.identity()));
  assert.equal(child.session, a.identity().session, "and it still names the connection it arrived on");
});
