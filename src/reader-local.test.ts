import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "./db.js";
import { discard } from "./test-tmp.js";
import { holdReaderReceipt, readerReceipts, readerRequest, saveReaderRequest, settleReaderReceipt } from "./reader-local.js";
import { mintCodexReaderSubmission } from "./codex-reader.js";
import { codexCliVerifierFixture } from "./test-codex-verifier.js";

test("purpose-keyed reader persistence upgrades an existing store without changing answer-keyed evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-reader-local-"));
  mkdirSync(join(root, ".codemap"));
  const old = new DatabaseSync(join(root, ".codemap", "codemap.db"));
  old.exec(`CREATE TABLE reader_requests(answer TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE reader_verdicts(seq INTEGER PRIMARY KEY AUTOINCREMENT, answer TEXT NOT NULL,
      verdict TEXT NOT NULL, held_at TEXT NOT NULL, state TEXT NOT NULL, why TEXT, call TEXT);
    CREATE TABLE unrelated_data(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE reader_work_requests(purpose TEXT NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(purpose,request_id));
    CREATE TABLE reader_work_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT, purpose TEXT NOT NULL,
      request_id TEXT NOT NULL, receipt TEXT NOT NULL UNIQUE, body TEXT NOT NULL, held_at TEXT NOT NULL,
      state TEXT NOT NULL, why TEXT, call TEXT);
    INSERT INTO reader_work_requests VALUES('issue-application','legacy-work','exact old work brief');
    INSERT INTO reader_work_receipts(purpose,request_id,receipt,body,held_at,state,call)
      VALUES('issue-application','legacy-work','legacy-token','legacy-verdict','2026-09-23T00:00:00Z','recorded','legacy-call');
    INSERT INTO reader_requests VALUES('same-id', 'issued old brief');
    INSERT INTO reader_verdicts(answer, verdict, held_at, state)
      VALUES('same-id', 'old pending verdict', '2026-09-23T00:00:00Z', 'pending');
    INSERT INTO unrelated_data VALUES('keep', 'unrelated content');`);
  old.close();
  try {
    const interpretation = { purpose: "answer-interpretation" as const, requestId: "same-id" };
    const comparison = { purpose: "pair-comparison" as const, requestId: "same-id" };
    assert.deepEqual(saveReaderRequest(root, interpretation, "new exact interpretation brief"), { saved: true });
    assert.deepEqual(saveReaderRequest(root, comparison, "full pair comparison brief"), { saved: true });
    assert.equal(readerRequest(root, interpretation), "new exact interpretation brief");
    assert.equal(readerRequest(root, comparison), "full pair comparison brief");
    assert.deepEqual(saveReaderRequest(root, comparison, "full pair comparison brief"), { saved: false });
    assert.match(String((saveReaderRequest(root, comparison, "silently changed brief") as { error: string }).error), /already issued/);

    assert.deepEqual(holdReaderReceipt(root, interpretation, "receipt-one", "sound"), { held: true, seq: 2 });
    assert.deepEqual(holdReaderReceipt(root, comparison, "receipt-two", "equivalent"), { held: true, seq: 3 });
    assert.deepEqual(holdReaderReceipt(root, interpretation, "receipt-one", "sound"), { held: false, seq: 2 });
    assert.match(String((holdReaderReceipt(root, comparison, "receipt-one", "equivalent") as { error: string }).error), /different request/);
    assert.equal(readerReceipts(root, interpretation)[0]?.body, "sound");
    assert.equal(readerReceipts(root, comparison)[0]?.body, "equivalent");
    assert.deepEqual(settleReaderReceipt(root, comparison, "receipt-two", "recorded", undefined, "tool-call-two"), { settled: true });
    assert.deepEqual(settleReaderReceipt(root, interpretation, "receipt-two", "invalid", "wrong purpose"), { settled: false });
    assert.equal(readerReceipts(root, comparison)[0]?.call, "tool-call-two");
    assert.equal(readerReceipts(root, interpretation)[0]?.state, "pending");

    const d = db(root);
    assert.deepEqual(readerReceipts(root, { purpose: "issue-application", requestId: "legacy-work" }),
      [{ seq: 1, purpose: "issue-application", requestId: "legacy-work", receipt: "legacy-token", body: "legacy-verdict",
        heldAt: "2026-09-23T00:00:00Z", state: "recorded", call: "legacy-call" }]);
    assert.equal((d.prepare("SELECT native_host FROM reader_work_receipts WHERE receipt='legacy-token'").get() as { native_host: null }).native_host, null);
    assert.equal((d.prepare("SELECT body FROM reader_requests WHERE answer = 'same-id'").get() as { body: string }).body, "issued old brief");
    assert.equal((d.prepare("SELECT verdict, state FROM reader_verdicts WHERE answer = 'same-id'").get() as { verdict: string; state: string }).verdict, "old pending verdict");
    assert.equal((d.prepare("SELECT state FROM reader_verdicts WHERE answer = 'same-id'").get() as { state: string }).state, "pending");
    assert.equal((d.prepare("SELECT body FROM unrelated_data WHERE id = 'keep'").get() as { body: string }).body, "unrelated content");
    assert.ok(readdirSync(join(root, ".codemap", "backups")).length > 0);
  } finally { discard(root); }
});

test("native held provenance is immutable and only accepted through a dispatcher capability", () => {
  const root = mkdtempSync(join(tmpdir(), "codemap-reader-native-"));
  const f = codexCliVerifierFixture();
  try {
    const key = { purpose: "issue-application" as const, requestId: "request" };
    const args = { requestId: key.requestId, verdict: "sound", rationale: "exact ruling" };
    const body = JSON.stringify({ verdict: args.verdict, rationale: args.rationale });
    saveReaderRequest(root, key, "issued");
    const cap = mintCodexReaderSubmission({ ...f.options, tool: "submit_application_verdict", arguments: args }, f.options.transcriptDir);
    assert.ok(!("error" in cap));
    assert.deepEqual(holdReaderReceipt(root, key, "native-token", body, undefined, cap), { held: true, seq: 1 });
    const held = readerReceipts(root, key)[0]!;
    assert.equal(JSON.parse(held.nativeHost!).requestMeta.callId, f.options.requestMeta.callId);
    f.options.requestMeta.callId = "mutated-after-mint";
    assert.deepEqual(holdReaderReceipt(root, key, "native-token", body, undefined, cap), { held: false, seq: 1 });
    assert.ok("error" in holdReaderReceipt(root, key, "native-token", body));
    assert.ok("error" in holdReaderReceipt(root, key, "forged-token", body, undefined, { nativeReaderSubmission: true }));
    assert.equal(readerReceipts(root, key).length, 1);
    settleReaderReceipt(root, key, "native-token", "recorded", undefined, "claim-call");
    assert.equal(readerReceipts(root, key)[0]?.nativeHost, held.nativeHost);
  } finally { f.clean(); discard(root); }
});
