import { test } from "node:test";
import assert from "node:assert/strict";
import { foldRepairRecords, type RepairSortInput, type RepairEvidenceInput } from "./repair-records.js";
import { foldFindings } from "./shared-findings.js";
import { issueClaimHash } from "./ruling-application.js";
import { testChain } from "./test-events.js";
import { repairVerificationHash, type RepairVerificationCapsule, type RepairClaimVerdict, type RepairVerificationState } from "./repair-verification.js";
import type { LogEvent } from "./eventlog.js";

function fixture(verdict: "fixed" | "factually-refuted" | "invalid" | "unknown" = "fixed") {
 const actor={principal:"owner"};
 const identity=(session:string)=>({principal:"verifier",harness:"mcp" as const,session});
 const sort:RepairSortInput={id:"sort",classification:verdict === "invalid" ? "invalid" : "mechanical",...(verdict === "invalid" ? {refutationSubtype:"assumed" as const} : {}),kind:"isolated",coverage:[{findingId:"f",claimIds:["f:original"]}],restsOn:[],source:"owner reviewed exact guard",provenance:"owner-reviewed",assessments:[],disagreements:[]};
 const evidence:RepairEvidenceInput={id:"proof",sortId:"sort",witnessCommit:"a".repeat(40),baseCommit:"b".repeat(40),fixCommit:"c".repeat(40),coverage:[{findingId:"f",claimIds:["f:original"],result:"complete",reason:"whole claim",claimResults:[{claimId:"f:original",result:"complete",reason:"whole claim"}]}],reproducer:[],regression:[],inspected:[],rulingIds:[],attribution:[]};
 const events:LogEvent[]=testChain("writer",[
 {id:"created",actor,kind:"finding.created",subject:"f",data:{text:"missing guard",targetId:"a",targetKind:"anchor",sourceRef:"a".repeat(40)}},
 {id:"sort-event",actor,kind:"repair.sort-recorded",subject:sort.id,data:{...sort}},
 {id:"evidence-event",actor,kind:"repair.evidence-recorded",subject:evidence.id,data:{...evidence}},
 ]);
 const finding=foldFindings(events).get("f")!;
 const c:RepairVerificationCapsule={scope:"findings/acme/1",claims:foldRepairRecords(events).claims,sort,evidence,targets:[{findingId:"f",openEpoch:finding.openEpoch!,claimHash:issueClaimHash("finding",finding)}],code:{witnessCommit:evidence.witnessCommit,baseCommit:evidence.baseCommit,fixCommit:evidence.fixCommit,diff:"added negative guard",availability:"available"},rulingContext:"no holds",orchestrator:identity("orchestrator")};
 function append(kind:string,subject:string,data:Record<string,unknown>,by:{principal:string}=actor) {
  const id=`event-${events.length}`;
  events.push(...testChain("writer",[{id,kind,subject,actor:by,data,writerPrev:events.at(-1)!.id,after:[events.at(-1)!.id]}]));
  return id;
 }
 const verifier={principal:"verifier"};
 append("repair.verification-requested","request",{id:"request",capsule:c,capsuleHash:repairVerificationHash(c)},verifier);
 for(const slot of [1,2] as const) {
  const who=identity(`verifier-${slot}`);
  const result:RepairClaimVerdict={findingId:"f",claimId:"f:original",verdict,reason:verdict === "factually-refuted" || verdict === "invalid" ? "guard already exists at cited target" : "guard rejects negatives",grade:verdict === "unknown" ? "none":"inspection",executions:[],inspected:verdict === "unknown" ? []:[{source:"guard",commit:verdict === "factually-refuted" || verdict === "invalid" ? evidence.witnessCommit : evidence.fixCommit,reasoning:"negative branch returns before mutation"}],noCheckReason:"no runnable target"};
  append("repair.verification-recorded",`run-${slot}`,{id:`run-${slot}`,requestId:"request",capsuleHash:repairVerificationHash(c),slot,identity:who,results:[result]},verifier);
 }
 const apply=()=>append("finding.repairApplied","f",{id:`application-${events.length}`,requestId:"request",capsuleHash:repairVerificationHash(c),findingId:"f",openEpoch:finding.openEpoch,claimHash:issueClaimHash("finding",finding),outcome:verdict === "unknown" ? "fixed":verdict,contextHash:repairVerificationHash(c.rulingContext),reason:"independent inspection covers exact whole claim",identity:identity("orchestrator")},verifier);
 return {events,append,apply,sort,c,identity};
}

test("a repair application closes exact finding with discovered proof",()=>{
 for(const verdict of ["fixed","factually-refuted","invalid"] as const) {
 const f=fixture(verdict);const closure=f.apply();const records=foldFindings(JSON.parse(JSON.stringify(f.events)));
 assert.equal(records.get("f")!.state,{fixed:"resolved","factually-refuted":"refuted",invalid:"invalid"}[verdict]);
 assert.equal(records.get("f")!.closed!.eventId,closure);
 assert.equal((records.repairVerification as RepairVerificationState).applications.length,1);
 }
});
test("unknown independent results and stale claim/sort never close",()=>{
 const unknown=fixture("unknown");unknown.apply();assert.equal(foldFindings(unknown.events).get("f")!.state,"created");
 const claim=fixture();claim.append("finding.revised","f",{now:{text:"additional required condition"},was:{text:"missing guard"}});claim.apply();assert.equal(foldFindings(claim.events).get("f")!.state,"created");
 const sort=fixture();sort.append("repair.sort-recorded","sort-2",{...sort.sort,id:"sort-2",prior:"sort",reason:"new assessment"});sort.apply();assert.equal(foldFindings(sort.events).get("f")!.state,"created");
});
test("reopened finding starts a new epoch and cannot reuse the closure",()=>{
 const f=fixture();const closed=f.apply();f.append("finding.reopened","f",{state:"created",observedClosure:closed});const epoch=foldFindings(f.events).get("f")!.openEpoch;f.apply();const finding=foldFindings(f.events).get("f")!;
 assert.equal(finding.state,"created");assert.equal(finding.openEpoch,epoch);assert.notEqual(epoch,"created");
});
test("a retired participant record changes nothing about a closure",()=>{
 const f=fixture();f.apply();
 f.append("repair.participant-recorded","proof",{repairId:"proof",identity:f.identity("verifier-1"),role:"fixer"},{principal:"verifier"});
 const replayed=foldFindings(f.events).get("f")!;
 assert.equal(replayed.state,"resolved");
 assert.deepEqual(replayed.repairClosure!.attention,[]);
});
test("a new preserved claim makes otherwise complete evidence partial",()=>{
 const f=fixture();f.append("repair.claims-recorded","f",{findingId:"f",parentId:"f:original",reason:"split omitted obligation",claims:[{id:"f:second",text:"second guard required"}]});f.apply();
 assert.equal(foldFindings(f.events).get("f")!.state,"created");
});
