import { test } from "node:test";
import assert from "node:assert/strict";
import { team } from "./oracle.js";
import { rpc } from "./test-mcp.js";
import { codexVerifierFixture } from "./test-codex-verifier.js";
import { verifierSessionActivity } from "./store.js";
import { db } from "./db.js";
import { shareFinding } from "./ops-shared.js";

test("MCP verifier claims expose unsupported provenance and cannot accept caller identity", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const replies = await rpc(t.all[0]!.repo, [
      { name: "claim_verifier", arguments: {} },
      { name: "claim_verifier", arguments: { session: "pretend-child", model: "same-model" } },
      { name: "status", arguments: {} },
      { name: "claim_verifier", arguments: {} },
    ]);
    const first = JSON.parse(replies[0]!);
    assert.match(first.error, /unsupported MCP client/);
    assert.match(replies[1]!, /unknown parameter/);
    assert.doesNotMatch(replies[2]!, /unsupported/);
    assert.match(JSON.parse(replies[3]!).error, /domain|fresh|before/i);
  } finally { t.dispose(); }
});

test("measured native claim binds the actual child and forbids legacy authority tools", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const calls = ["claim_verifier", "submit_verdict", "claim_verifier"].map(name =>
      ({ name, arguments: {}, _meta: f.options.requestMeta }));
    const replies = await rpc(root, calls, { clientInfo: f.options.clientInfo,
      env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } });
    const claimed = JSON.parse(replies[0]!);
    assert.equal(claimed.ok, true, replies[0]!);
    assert.deepEqual(claimed.identity, { principal: "alice@acme.test", harness: "codex", session: "parent", child: "child" });
    assert.match(claimed.connectionId, /^[a-z0-9-]+$/);
    assert.match(replies[1]!, /role forbids submit_verdict/);
    assert.match(replies[2]!, /forbidden|eligible/);
    assert.equal(verifierSessionActivity(root, claimed.identity)?.kind, "tainted");
  } finally { f.clean(); t.dispose(); }
});

test("native session domain activity and role claims survive separate MCP processes", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const options = { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } };
    const call = (name: string) => ({ name, arguments: {}, _meta: f.options.requestMeta });
    const first = await rpc(root, [call("status")], options);
    assert.doesNotMatch(first[0]!, /prior domain|cannot resume/);
    const reconnect = await rpc(root, [call("claim_verifier")], options);
    assert.match(reconnect[0]!, /already performed domain work|prior domain/);
  } finally { f.clean(); t.dispose(); }
});

test("missing metadata after claim invalidates the connection and its durable role", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const options = { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } };
    const replies = await rpc(root, [
      { name: "claim_verifier", arguments: {}, _meta: f.options.requestMeta },
      { name: "repair_brief", arguments: {} },
      { name: "claim_verifier", arguments: {}, _meta: f.options.requestMeta },
    ], options);
    assert.equal(JSON.parse(replies[0]!).ok, true, replies[0]!);
    assert.match(replies[1]!, /host request metadata/);
    assert.match(replies[2]!, /invalid|metadata|eligible/);
    const resumed = await rpc(root, [{ name: "status", arguments: {}, _meta: f.options.requestMeta }], options);
    assert.match(resumed[0]!, /cannot resume ordinary domain/);
  } finally { f.clean(); t.dispose(); }
});

test("clean native role claims cannot be reclaimed or bypassed by reconnecting", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const options = { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } };
    const call = (name: string) => ({ name, arguments: {}, _meta: f.options.requestMeta });
    const first = await rpc(root, [call("claim_verifier")], options);
    assert.equal(JSON.parse(first[0]!).ok, true, first[0]!);
    const second = await rpc(root, [call("claim_verifier"), call("status")], options);
    assert.match(second[0]!, /already performed domain work or claimed/);
    assert.match(second[1]!, /cannot resume ordinary domain/);
    const omitted = await rpc(root, [{ name: "status", arguments: {} }], options);
    assert.match(omitted[0]!, /native request identity metadata/);
    const upgraded = await rpc(root, [call("status"), call("claim_verifier")],
      { ...options, clientInfo: { ...options.clientInfo, version: "next" } });
    assert.match(upgraded[0]!, /cannot resume ordinary domain/);
    assert.match(upgraded[1]!, /before any domain action/);
  } finally { f.clean(); t.dispose(); }
});

test("malformed native domain calls consume freshness before validation", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const options = { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } };
    const first = await rpc(root, [{ name: "status", arguments: { imaginary: true }, _meta: f.options.requestMeta }], options);
    assert.match(first[0]!, /unknown parameter/);
    const second = await rpc(root, [{ name: "claim_verifier", arguments: {}, _meta: f.options.requestMeta }], options);
    assert.match(second[0]!, /already performed domain work/);
  } finally { f.clean(); t.dispose(); }
});

test("native admission storage failure answers the RPC without granting authority", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    db(root).exec("ALTER TABLE verifier_session_activity RENAME TO original_verifier_activity; CREATE TABLE verifier_session_activity(broken TEXT)");
    const replies = await rpc(root, [{ name: "claim_verifier", arguments: {}, _meta: f.options.requestMeta }],
      { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } });
    assert.match(replies[0]!, /verifier admission failed.*no such column/);
  } finally { f.clean(); t.dispose(); }
});

test("even an unknown domain tool consumes the fresh claim boundary", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const replies = await rpc(t.all[0]!.repo, [
      { name: "not_a_tool", arguments: {} },
      { name: "claim_verifier", arguments: {} },
    ]);
    assert.match(replies[0]!, /unknown tool/);
    assert.match(JSON.parse(replies[1]!).error, /domain|fresh|before/i);
  } finally { t.dispose(); }
});

test("native claimed repair tools reach bounded ops without accepting caller seals", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const replies = await rpc(t.all[0]!.repo, [
      { name: "claim_verifier", arguments: {}, _meta: f.options.requestMeta },
      { name: "repair_brief", arguments: { review: "1", requestId: "absent", role: "verifier", slot: 1 }, _meta: f.options.requestMeta },
      { name: "repair_verification", arguments: { review: "1", requestId: "absent", slot: 1, results: [], seal: {} }, _meta: f.options.requestMeta },
    ], { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } });
    assert.equal(JSON.parse(replies[0]!).ok, true);
    assert.doesNotMatch(replies[1]!, /unknown tool|role forbids/);
    assert.ok(JSON.parse(replies[1]!).error, replies[1]!);
    assert.match(replies[2]!, /unknown parameter.*seal/);
  } finally { f.clean(); t.dispose(); }
});

test("native sorter claim constrains the dispatcher and survives reconnect without role switching", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const options = { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } };
    const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: args, _meta: f.options.requestMeta });
    const replies = await rpc(root, [call("claim_repair_sorter"),
      call("repair_sort_assess", { review: "1", classification: "implementation-defect", reason: "No assigned brief." }),
      call("repair_request", { review: "1", sortId: "s", evidenceId: "e" })], options);
    const claimed = JSON.parse(replies[0]!);
    assert.equal(claimed.ok, true, replies[0]!);
    assert.equal(claimed.role, "repair-sorter");
    assert.match(replies[1]!, /unused exact bounded brief/);
    assert.match(replies[2]!, /role forbids repair_request/);
    assert.equal(verifierSessionActivity(root, claimed.identity)?.kind, "tainted");
    const reconnect = await rpc(root, [call("claim_verifier"), call("status")], options);
    assert.match(reconnect[0]!, /already performed|claimed|tainted/);
    assert.match(reconnect[1]!, /cannot resume ordinary domain/);
  } finally { f.clean(); t.dispose(); }
});

test("sorter claims refuse caller identity and prior domain use", async () => {
  const t = await team(["alice@acme.test"]);
  try {
    const replies = await rpc(t.all[0]!.repo, [
      { name: "claim_repair_sorter", arguments: { session: "forged" } },
      { name: "status", arguments: {} },
      { name: "claim_repair_sorter", arguments: {} },
    ]);
    assert.match(replies[0]!, /unknown parameter/);
    assert.match(replies[2]!, /before any domain action/);
  } finally { t.dispose(); }
});


test("native sorter receipt crosses MCP processes through the public sort schema", async () => {
  const t = await team(["alice@acme.test"]), f = codexVerifierFixture();
  try {
    const root = t.all[0]!.repo;
    const finding = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "Missing transfer guard." }) as { id: string };
    assert.ok(finding.id);
    const sort = { id: "native-sort", classification: "mechanical", kind: "isolated", provenance: "dual-sorted",
      source: "Synthetic native sorter fixture", coverage: [{ findingId: finding.id, claimIds: [finding.id + ":original"] }],
      restsOn: [], assessments: [] as any[], disagreements: [] };
    const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: args, _meta: f.options.requestMeta });
    const replies = await rpc(root, [call("claim_repair_sorter"), call("repair_sort_brief", { review: "7", sort, role: "sorter" }),
      call("repair_sort_assess", { review: "7", classification: "mechanical", reason: "The original claim names a missing guard with no policy choice." })],
      { clientInfo: f.options.clientInfo, env: { CODEMAP_CODEX_TRANSCRIPT_DIR: f.options.transcriptDir } });
    const sealed = JSON.parse(replies[2]!);
    assert.equal(sealed.ok, true, replies[2]!);
    assert.ok(sealed.assessment.receipt.seal.signature);
    sort.assessments = [sealed.assessment, { identity: { principal: "alice@acme.test", harness: "codex", session: "reported-only" }, classification: "mechanical", reason: "Unverified second report." }];
    const posted = JSON.parse((await rpc(root, [{ name: "post_repair_sort", arguments: { review: "7", sort } }]))[0]!);
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.equal(posted.records.sorts[0].eligible, false, "one sealed assessment cannot replace two independent receipts");
    assert.equal(posted.records.sorts[0].input.assessments[0].receipt.seal.signature, sealed.assessment.receipt.seal.signature);
  } finally { f.clean(); t.dispose(); }
});
