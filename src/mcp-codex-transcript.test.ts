import { test } from "node:test";
import assert from "node:assert/strict";
import { team } from "./oracle.js";
import { shareFinding } from "./ops-shared.js";
import { postRound, decisionRound } from "./ops/decisions.js";
import { rpc } from "./test-mcp.js";
import { CODEX_CALL, CODEX_SESSION, codexReply, codexRows, codexTranscript } from "./test-codex-transcript.js";

test("MCP selects the native transcript adapter without accepting caller identity claims", async () => {
  const t = await team(["alice@acme.test"]);
  const tx = codexTranscript([]);
  const saved = process.env.CODEMAP_CODEX_TRANSCRIPT_DIR;
  try {
    const root = t.all[0]!.repo;
    const f = await shareFinding(root, 7, { targetKind: "anchor", targetId: "src/pay.ts#transfer", text: "negative transfer" }) as any;
    assert.equal(f.ok, true, JSON.stringify(f));
    const question = `D1: Should ${f.id} be repaired?`;
    assert.equal((await postRound(root, { round: { id: "R1", source: "native MCP" }, decisions: [{
      id: "d1", round: "R1", ref: "D1", kind: "options", payload: { question, options: [{ label: "Repair" }] },
      options: [{ label: "Repair", effects: [{ findings: [f.id], on: "unblock" }] }],
    }] }) as any).ok, true);
    const questions = [{ title: question, options: ["Repair"] }], now = Date.now();
    const all = codexRows(questions, ["Repair"]) as any[];
    all[2].timestamp = new Date(now + 1000).toISOString();
    all[3].timestamp = new Date(now + 1500).toISOString();
    all[4] = codexReply(questions, ["Repair"], new Date(now + 2000).toISOString());
    tx.write(all);
    process.env.CODEMAP_CODEX_TRANSCRIPT_DIR = tx.dir;
    const args = { harness: "codex", session: CODEX_SESSION, toolUseId: CODEX_CALL, round: "R1" };
    const out = await rpc(root, [{ name: "log_question", arguments: args },
      { name: "log_question", arguments: { ...args, sessionIdentity: "fabricated-verifier" } },
      { name: "log_question", arguments: { ...args, harness: "unknown" } }]);
    const first = JSON.parse(out[0]!);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.answered[0].recorded, true);
    assert.equal(first.readerSupport.supported, false);
    assert.match(first.readerSupport.reason, /native verdict receipt recording/);
    assert.match(out[1]!, /unknown parameter.*sessionIdentity/);
    assert.match(out[2]!, /harness.*codex|harness.*enum/);
    const view = await decisionRound(root, "R1") as any;
    assert.equal(view.decisions[0].answers.length, 1);
    assert.equal(view.decisions[0].answers[0].sourceReceipt.harness, "codex");
  } finally {
    if (saved === undefined) delete process.env.CODEMAP_CODEX_TRANSCRIPT_DIR;
    else process.env.CODEMAP_CODEX_TRANSCRIPT_DIR = saved;
    tx.cleanup(); t.dispose();
  }
});
