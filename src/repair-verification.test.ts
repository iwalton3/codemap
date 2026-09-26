import { test } from "node:test";
import assert from "node:assert/strict";
import { RepairSealService } from "./repair-seals.js";
import { RepairVerifierBoundary, type VerifierIdentity } from "./verifier-boundary.js";
import { testChain } from "./test-events.js";
import { foldRepairVerification, repairVerificationDecision, repairVerificationHash, repairVerificationPayload,
  type RepairVerificationCapsule, type RepairVerificationRun, type RepairClaimVerdict } from "./repair-verification.js";
const actor = { principal: "alice" };
const identity = (session: string) => ({ principal: "alice", harness: "codex", session, model: "same-model" });
const service = new RepairSealService({ loadKey: () => undefined, saveKey: () => {} });
const capsule: RepairVerificationCapsule = {
  scope: "findings/acme/1", targets:[{findingId:"f",openEpoch:"created-event",claimHash:"current-claim"}], code:{witnessCommit:"a".repeat(40),baseCommit:"b".repeat(40),fixCommit:"c".repeat(40),diff:"guard added",availability:"available"}, claims: [{ id: "f:original", findingId: "f", text: "missing guard", eventId: "original", actor, at: "2026-08-21T00:00:00Z", asFiled:{text:"missing guard",targetId:"anchor",targetKind:"anchor",sourceRef:"a".repeat(40)} }],
  sort: {id:"sort",classification:"mechanical",kind:"isolated",coverage:[{findingId:"f",claimIds:["f:original"]}],restsOn:[],source:"reviewed",provenance:"owner-reviewed",assessments:[],disagreements:[]},
  evidence: {id:"proof",sortId:"sort",witnessCommit:"a".repeat(40),baseCommit:"b".repeat(40),fixCommit:"c".repeat(40),coverage:[{findingId:"f",claimIds:["f:original"],result:"complete",reason:"all original",claimResults:[{claimId:"f:original",result:"complete",reason:"all original"}]}],reproducer:[],changeFalsifier:[],regression:[],inspected:[],rulingIds:[],attribution:[]},
  rulingContext: "no current ruling holds", orchestrator: identity("orchestrator")
};
const requestBoundaries = new Map<string, RepairVerifierBoundary>();
function sealed(kind: string, data: Record<string, unknown>, who = capsule.orchestrator) {
  const boundary = new RepairVerifierBoundary({context:{supported:true,identity:who},participants:()=>[]});
  assert.equal(boundary.claim().ok,true);
  if(kind === "repair.verification-requested") requestBoundaries.set(String(data.id),boundary);
  if (kind !== "repair.verification-requested") data.connectionId = boundary.connectionId;
  const cap = boundary.sealCapability(kind === "repair.verification-requested" ? String(data.id) : String(data.requestId),repairVerificationPayload(kind,String(data.id),data));
  assert.ok(!("error" in cap));
  const seal = service.seal(cap);
  assert.ok(!("error" in seal));
  return {kind, subject:String(data.id), data:{...data,seal}};
}
const request = (c = capsule) => sealed("repair.verification-requested",{id:"request",capsule:c,capsuleHash:repairVerificationHash(c)},c.orchestrator);
const result = (over: Partial<RepairClaimVerdict> = {}): RepairClaimVerdict => ({findingId:"f",claimId:"f:original",verdict:"fixed",reason:"guard rejects negative credits",grade:"inspection",executions:[],inspected:[{source:"guard body",commit:capsule.evidence.fixCommit,reasoning:"negative values throw before credit changes"}, ...(over.verdict === "factually-refuted" ? [{source:"original guard body",commit:capsule.evidence.witnessCommit,reasoning:"guard was already present at original filing"}] : [])],noCheckReason:"no runnable target exists",...over});
const run = (slot: 1|2, r = result(), who: VerifierIdentity = identity(`verifier-${slot}`)) => sealed("repair.verification-sealed",{id:`run-${slot}`,requestId:"request",capsuleHash:repairVerificationHash(capsule),slot,identity:who,results:[r]},who);
const fold = (events: {kind:string;subject:string;data:Record<string,unknown>}[], participants: any[] = []) => {
 const c:RepairVerificationCapsule=(events.find(e=>e.kind === "repair.verification-requested")?.data as any)?.capsule ?? capsule;
 const children=c.claims.filter(claim=>claim.parentId);
 const decomposition=children.length ? [{kind:"repair.claims-recorded",subject:"f",data:{findingId:"f",parentId:"f:original",reason:"two obligations",claims:children.map(claim=>({id:claim.id,text:claim.text}))}}] : [];
 return foldRepairVerification(testChain("writer",[{kind:"finding.created",subject:"f",data:{text:"missing guard",targetId:"anchor",targetKind:"anchor",sourceRef:c.claims[0]!.asFiled!.sourceRef}}, ...decomposition,
 {kind:"repair.sort-recorded",subject:"sort",data:{...c.sort}}, {kind:"repair.evidence-recorded",subject:"proof",data:{...c.evidence}},
 {kind:"repair.verification-producer",subject:service.publicProducer().producerKeyId,data:{...service.publicProducer()}},...events]
 .map((e,i)=>({id:i === 0 ? "original" : e.kind === "repair.claims-recorded" ? "decomposition" : String(i+1),actor,...e}))),{participants});
};

test("durable signed independent inspection survives JSON replay with visible weaker grade",()=>{
 const records = fold(JSON.parse(JSON.stringify([request(),run(1),run(2)])));
 assert.deepEqual(records.rejected,[]);
 assert.deepEqual(repairVerificationDecision(records,"request","f"),{verdict:"fixed",complete:true,grade:"inspection",reasons:[]});
});
test("same session changed model, fixer and orchestrator cannot count as independent",()=>{
 const same = fold([request(),run(1),run(2,result(),{...identity("verifier-1"),model:"different"})]);
 assert.equal(same.runs.length,1);
 const fixer = fold([request(),run(1),run(2)], [{identity:identity("verifier-2"),role:"fixer"}]);
 assert.equal(fixer.runs.length,1);
 const own = fold([request(),run(1,result(),capsule.orchestrator)]);
 assert.equal(own.runs.length,0);
});
test("missing, altered and self-declared unregistered seal refuse",()=>{
 const altered = run(1); (altered.data as any).results[0].reason = "tampered";
 const records = fold([request(),altered]);
 assert.equal(records.runs.length,0);
 const unsigned = {...run(1),data:{...run(1).data,seal:undefined}};
 assert.equal(fold([request(),unsigned]).runs.length,0);
 const foreign = new RepairSealService({loadKey:()=>undefined,saveKey:()=>{}});
 const unknown = run(1); (unknown.data as any).seal.publicKey = foreign.publicProducer().publicKey;
 assert.equal(fold([request(),unknown]).runs.length,0);
});
test("partial coverage cannot close original finding even after agreement",()=>{
 const c = structuredClone(capsule); c.claims.push({id:"f:other",findingId:"f",text:"second obligation",parentId:"f:original",eventId:"decomposition",actor,at:"2026-08-21T00:00:00Z",reason:"two obligations"});
 const records = fold([request(c),run(1),run(2)].map(e=>e.kind === "repair.verification-sealed" ? sealed(e.kind,{...e.data,seal:undefined,capsuleHash:repairVerificationHash(c)},(e.data as any).identity):e));
 assert.equal(records.requests.length,1); assert.equal(records.runs.length,2);
 assert.equal(repairVerificationDecision(records,"request","f").complete,false);
});
test("regression green alone and bare inspection are never closure evidence",()=>{
 assert.equal(fold([request(),run(1,result({grade:"executable",inspected:[],executions:[{id:"suite",command:"test",commit:capsule.evidence.fixCommit,environment:"scratch",phase:"regression",outcome:"passed",exitCode:0}]}))]).runs.length,0);
 assert.equal(fold([request(),run(1,result({noCheckReason:undefined}))]).runs.length,0);
});
test("unknown and requirement decision remain unresolved",()=>{
 for(const verdict of ["unknown","decision-needed"] as const) {
 const records=fold([request(),run(1,result({verdict,grade:"none",inspected:[]})),run(2,result({verdict,grade:"none",inspected:[]}))]);
 assert.equal(repairVerificationDecision(records,"request","f").complete,false);
 assert.equal(repairVerificationDecision(records,"request","f").verdict,verdict);
 }
});
test("arbitration requires real conflict, third identity and semantic addressed claim",()=>{
 const events=[request(),run(1),run(2,result({verdict:"factually-refuted"}))];
 const arb=(addresses:any[],who=identity("arb"))=>sealed("repair.verification-arbitrated",{id:"arb",requestId:"request",capsuleHash:repairVerificationHash(capsule),identity:who,runIds:["run-1","run-2"],addresses},who);
 assert.equal(repairVerificationDecision(fold(events),"request","f").complete,false);
 assert.equal(fold([...events,arb([])]).arbitrations.length,0);
 assert.equal(fold([...events,arb([{findingId:"f",claimId:"f:original",reason:"guard now exists, initial absence was true",verdict:"fixed"}],identity("verifier-1"))]).arbitrations.length,0);
 const records=fold([...events,arb([{findingId:"f",claimId:"f:original",reason:"original witness lacked guard; fix added it, so repaired rather than refuted",verdict:"fixed"}])]);
 assert.equal(repairVerificationDecision(records,"request","f").complete,true);
 assert.equal(fold([request(),run(1),run(2),arb([{findingId:"f",claimId:"f:original",reason:"agree",verdict:"fixed"}])]).arbitrations.length,0);
});
test("separate signed application binds exact issue epoch and context, once",()=>{
 const events=[request(),run(1),run(2)];
 const app=(over:Record<string,unknown>={})=>{
 const boundary=requestBoundaries.get("request")!;
 const data={id:"application",requestId:"request",capsuleHash:repairVerificationHash(capsule),findingId:"f",openEpoch:"created-event",claimHash:"current-claim",outcome:"fixed",contextHash:repairVerificationHash(capsule.rulingContext),reason:"both independent inspections cover original claim",...over};
 const kind="finding.repairApplied"; const cap=boundary.sealCapability("request",repairVerificationPayload(kind,"f",data));assert.ok(!("error" in cap));const seal=service.seal(cap);assert.ok(!("error" in seal));
 return {kind,subject:"f",data:{...data,seal}};
 };
 assert.equal(fold([...events,app()]).applications.length,1);
 for(const stale of [{openEpoch:"reopened-event"},{claimHash:"changed"},{contextHash:"changed"},{outcome:"factually-refuted"}]) assert.equal(fold([...events,app(stale)]).applications.length,0);
 assert.equal(fold([...events,app(),app({id:"duplicate"})]).applications.length,1);
});
test("fixed executable proof requires witness failure, fix success and a useful falsifier",()=>{
 const c=structuredClone(capsule);
 const checks=[{id:"witness",command:"check negative credit",commit:c.evidence.witnessCommit,environment:"isolated fixture",phase:"witness" as const,outcome:"failed" as const,exitCode:1},
 {id:"fix",command:"check negative credit",commit:c.evidence.fixCommit,environment:"isolated fixture",phase:"fix" as const,outcome:"passed" as const,exitCode:0},
 {id:"falsifier",command:"check negative credit",commit:c.evidence.fixCommit,environment:"isolated fixture",phase:"mutation" as const,mutation:"remove negative guard",outcome:"failed" as const,exitCode:1}];
 c.evidence.reproducer=checks.slice(0,2);c.evidence.changeFalsifier=checks.slice(2);
 const rerun=(slot:1|2,executions=checks)=>sealed("repair.verification-sealed",{id:`run-${slot}`,requestId:"request",capsuleHash:repairVerificationHash(c),slot,identity:identity(`execution-${slot}`),results:[result({grade:"executable",executions,inspected:[],noCheckReason:undefined})]},identity(`execution-${slot}`));
 assert.equal(repairVerificationDecision(fold([request(c),rerun(1),rerun(2)]),"request","f").complete,true);
 assert.equal(fold([request(c),rerun(1,checks.slice(1))]).runs.length,0);
 assert.equal(fold([request(c),rerun(1,[...checks.slice(0,2),{...checks[2]!,outcome:"passed" as never,exitCode:0}])]).runs.length,0);
 assert.equal(fold([request(c),rerun(1,[checks[0]!,{...checks[1]!,commit:"d".repeat(40)},checks[2]!])]).runs.length,0);
});
test("ineligible design sort and missing original pattern site cannot gain authority from signed runs",()=>{
 const design=structuredClone(capsule);design.sort.classification="design-defect";
 assert.equal(fold([request(design)]).requests.length,0);
 const pattern=structuredClone(capsule);pattern.sort.kind="pattern";pattern.sort.predicate="negative input must reject";pattern.sort.sites=["api","batch"];
 pattern.evidence.patternEnumeration={expected:["api","batch"],actual:["api"],method:"enumerated commands"};
 const r=sealed("repair.verification-sealed",{id:"run-1",requestId:"request",capsuleHash:repairVerificationHash(pattern),slot:1,identity:identity("pattern"),results:[result()]},identity("pattern"));
 assert.equal(fold([request(pattern),r]).runs.length,0);
});
test("job identities and connections cannot cross verification requests",()=>{
 const second=sealed("repair.verification-requested",{id:"request-two",capsule,capsuleHash:repairVerificationHash(capsule)});
 assert.equal(fold([request(),second]).requests.length,1);
 const foreign=structuredClone(capsule);foreign.orchestrator=identity("verifier-1");
 const attempted=sealed("repair.verification-requested",{id:"request-two",capsule:foreign,capsuleHash:repairVerificationHash(foreign)},foreign.orchestrator);
 assert.equal(fold([request(),run(1),attempted]).requests.length,1);
});
test("nested malformed signed and projected records fail closed",async()=>{
 const {isRepairVerificationState}=await import("./repair-verification.js");
 const malformed=sealed("repair.verification-sealed",{id:"run-1",requestId:"request",capsuleHash:repairVerificationHash(capsule),slot:1,identity:identity("bad"),results:[{...result(),executions:[null]}]},identity("bad"));
 assert.equal(fold([request(),malformed]).runs.length,0);
 const state=fold([request(),run(1),run(2)]);assert.equal(isRepairVerificationState(state),true);
 (state.runs[0]!.results[0] as any).inspected=[null];assert.equal(isRepairVerificationState(state),false);
});
test("a method added by the fix cannot factually refute its as-filed absence",()=>{
 const addedMethod=result({verdict:"factually-refuted",reason:"method exists on repaired branch",inspected:[{source:"method added by fix",commit:capsule.evidence.fixCommit,reasoning:"method exists after repair"}]});
 const refused=fold([request(),run(1,addedMethod),run(2,addedMethod)]);
 assert.equal(refused.runs.length,0);
 assert.match(refused.rejected.map(x=>x.reason).join(),/as-filed witness/);
 const existingMethod=result({verdict:"factually-refuted",reason:"method already existed when the claim was filed",inspected:[{source:"original method",commit:capsule.evidence.witnessCommit,reasoning:"original witness defines the method claimed absent"}]});
 const accepted=fold([request(),run(1,existingMethod),run(2,existingMethod)]);
 assert.equal(accepted.runs.length,2);assert.equal(repairVerificationDecision(accepted,"request","f").verdict,"factually-refuted");
});
test("executable factual contradiction must pass at witness, not only repaired code",()=>{
 const check={id:"exists",command:"check method exists",commit:capsule.evidence.fixCommit,environment:"isolated fixture",phase:"fix" as const,outcome:"passed" as const,exitCode:0};
 const prove=(atWitness:boolean)=>{
 const c=structuredClone(capsule);const pinned={...check,commit:atWitness ? c.evidence.witnessCommit:c.evidence.fixCommit,phase:atWitness ? "witness" as const:"fix" as const};c.evidence.reproducer=[pinned];
 const r=sealed("repair.verification-sealed",{id:"run-1",requestId:"request",capsuleHash:repairVerificationHash(c),slot:1,identity:identity("fact-check"),results:[result({verdict:"factually-refuted",grade:"executable",executions:[pinned],inspected:[],noCheckReason:undefined})]},identity("fact-check"));
 return fold([request(c),r]);
 };
 assert.equal(prove(false).runs.length,0);assert.equal(prove(true).runs.length,1);
});
test("arbitration cannot turn witness-only refutation into fix verification",()=>{
 const refuted=result({verdict:"factually-refuted",inspected:[{source:"original method",commit:capsule.evidence.witnessCommit,reasoning:"method existed at filing"}]});
 const who=identity("commit-arbitrator");
 const arb=sealed("repair.verification-arbitrated",{id:"arb",requestId:"request",capsuleHash:repairVerificationHash(capsule),identity:who,runIds:["run-1","run-2"],addresses:[{findingId:"f",claimId:"f:original",reason:"fixed outcome selected after comparison of both rationales",verdict:"fixed"}]},who);
 const records=fold([request(),run(1),run(2,refuted),arb]);
 assert.equal(records.arbitrations.length,1);
 assert.equal(repairVerificationDecision(records,"request","f").complete,false);
 assert.match(repairVerificationDecision(records,"request","f").reasons.join(),/another commit/);
});
test("a fixer cannot relabel the repaired commit as the as-filed witness",()=>{
 const c=structuredClone(capsule);c.evidence.witnessCommit=c.evidence.fixCommit;c.code.witnessCommit=c.evidence.fixCommit;
 const records=fold([request(c)]);assert.equal(records.requests.length,0);
 assert.match(records.rejected.map(r=>r.reason).join(),/immutable as-filed source/);
});
test("missing or branch-only original source cannot grant factual refutation",()=>{
 for(const sourceRef of [undefined,"feature-branch"]) {
 const c=structuredClone(capsule);c.claims[0]!.asFiled!.sourceRef=sourceRef;
 const who=identity("unsupported-original");
 const run=sealed("repair.verification-sealed",{id:"run-1",requestId:"request",capsuleHash:repairVerificationHash(c),slot:1,identity:who,results:[result({verdict:"factually-refuted"})]},who);
 const records=fold([request(c),run]);assert.equal(records.requests.length,1);assert.equal(records.runs.length,0);
 assert.match(records.rejected.map(r=>r.reason).join(),/unknown or mismatched immutable as-filed source/);
 }
});
