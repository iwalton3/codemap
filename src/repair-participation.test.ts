import { test } from "node:test";
import assert from "node:assert/strict";
import { issueRepairParticipation, repairParticipationIdentity } from "./repair-participation.js";

const identity = () => ({ principal: "owner", harness: "codex", session: "parent", child: "fixer" });

test("repair participation capability binds the native identity and exact repository principal", () => {
  const who = identity();
  const token = issueRepairParticipation(who);
  assert.deepEqual(repairParticipationIdentity(token, "owner"), who);
  assert.equal(repairParticipationIdentity(token, "other"), undefined);
  assert.equal(repairParticipationIdentity(token, null), undefined);
  assert.equal(Object.isFrozen(token), true);
  assert.deepEqual(Object.keys(token), []);
});

test("caller objects, identity strings and serialized capabilities cannot spoof repair participation", () => {
  const token = issueRepairParticipation(identity());
  for (const untrusted of [identity(), {}, JSON.parse(JSON.stringify(token)), structuredClone(token), null, "parent"]) {
    assert.equal(repairParticipationIdentity(untrusted, "owner"), undefined);
  }
});

test("issued participation and resolved identities cannot be changed through caller aliases", () => {
  const who = identity();
  const token = issueRepairParticipation(who);
  who.child = "verifier";
  const resolved = repairParticipationIdentity(token, "owner")!;
  assert.equal(resolved.child, "fixer");
  resolved.child = "verifier";
  resolved.principal = "other";
  assert.deepEqual(repairParticipationIdentity(token, "owner"), identity());
});

test("ordinary parent participation is recorded without claiming fresh verifier admission", () => {
  const who = { principal: "owner", harness: "codex", session: "parent" };
  assert.deepEqual(repairParticipationIdentity(issueRepairParticipation(who), "owner"), who);
});

test("incomplete participation identities cannot obtain a capability", () => {
  for (const who of [{ ...identity(), principal: "" }, { ...identity(), session: " " },
    { ...identity(), harness: "" }, { ...identity(), child: "" }]) {
    assert.throws(() => issueRepairParticipation(who), /resolved native session identity/);
  }
});
