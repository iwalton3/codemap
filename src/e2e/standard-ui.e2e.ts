/**
 * The standard, in a real browser — the surface a principal disposes of a proposal on.
 *
 * This is the half an agent structurally cannot perform: `ratify_spec` is
 * principal-gated and the MCP agent latch is a ratchet, so the browser is where a
 * spec becomes the standard. Until this file existed nothing exercised that at all —
 * `routes.e2e.ts` swept the routes for console errors against a fixture holding no
 * spec and no requirement, so every one of them rendered its empty state and passed.
 *
 * What each test asserts is the thing the page is FOR, not its markup: that the
 * ratifier can see what they are adopting (how much a move takes, what arrives
 * pre-silenced), that a proposal whose ground moved cannot be adopted by accident,
 * and that a rule's history says when it was last looked at and what has been
 * silencing it.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
import * as ops from "../ops.js";
import { discard } from "../test-tmp.js";

const pw = resolvePlaywright();
const AGENT = { agent: true, model: "claude-opus-5" } as const;

/** Assert an ops call succeeded. A silent `{error}` in `before` cancels the whole suite. */
const ok = <T,>(r: T): T => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `fixture failed: ${(r as any)?.error}`);
  return r;
};

describe("the standard UI", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string;
  let anchor = "", draft = "", moveSpec = "", staleSpec = "", ruleId = "", opId = "";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-std-"));
    side = mkdtempSync(join(tmpdir(), "codemap-std-side-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "izzie@x.com");
    git("config", "user.name", "izzie");
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(cents: number) { return cents; }\n");
    // A sidecar, because a comment is a shared note and there is nowhere to put one
    // without it. Committed BEFORE `init`: an uncommitted fixture makes every act
    // provisional, which silently voids half the assertions in this subsystem.
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    git("add", "-A"); git("commit", "-qm", "seed");
    await ops.init(root);
    anchor = (await ops.search(root, "transfer") as any).anchors[0].id;

    // A rule that already stands, so there is something to browse and to audit.
    const base = await ops.draftSpec(root, { title: "Credit currency policy", ...AGENT }) as any;
    await ops.addOperation(root, {
      specId: base.id, kind: "add_requirement", rationale: "policy §4 was never written down",
      reversibility: "reversible", title: "Credit line currency", section: "Credit/Limits",
      statement: "All credit lines are in USD.", provenance: "credit policy §4", ...AGENT,
    } as any);
    // Fail LOUDLY if the fixture stops building. A `before` hook that throws reports
    // `fail 0` with every test CANCELLED, which reads like a pass at a glance — this
    // suite did exactly that when `cites` became a refusal.
    ok(await ops.ratifySpec(root, { specId: base.id }));
    const seeded = (await ops.listRequirements(root) as any).requirements;
    assert.equal(seeded.length, 1, "the fixture must have a ratified rule or every test below is vacuous");
    ruleId = seeded[0].id;
    await ops.recordAudit(root, {
      requirementId: ruleId, outcome: "nonconformant", finding: "no currency check on entry",
      evidence: { read: [anchor] }, ...AGENT,
    } as any);
    // And a BRANCH finding, which is a different kind of thing and must render as one:
    // it is an observation of somebody's work in progress, not of the codebase, so the
    // dossier keeps it in its own section rather than in the audit history.
    git("checkout", "-q", "-b", "fix/currency");
    ok(await ops.recordAudit(root, {
      requirementId: ruleId, outcome: "nonconformant", finding: "the branch drops the currency field",
      evidence: { read: [anchor] }, ...AGENT,
    } as any));
    git("checkout", "-q", "main");
    await ops.declarePointer(root, {
      requirementId: ruleId, targetKind: "anchor", targetId: anchor,
      rationale: "the conversion happens here", ...AGENT,
    } as any);
    await ops.acknowledgeDebt(root, {
      requirementId: ruleId, rationale: "fix scheduled for Q4", priority: "medium",
      revalidateBy: "2027-01-01T00:00:00Z",
    } as any);

    // A draft carrying an irreversible operation AND a pre-approved gap — the two
    // things a ratifier is the last person able to refuse.
    const d = await ops.draftSpec(root, { title: "Float settles next business day", ...AGENT }) as any;
    draft = d.id;
    const o = await ops.addOperation(root, {
      specId: draft, kind: "add_requirement", rationale: "the sweep has always been T+1",
      reversibility: "irreversible", title: "Float settlement window", section: "Settlement/Float",
      statement: "Captured float settles on the next business day.", provenance: "treasury practice", ...AGENT,
    } as any) as any;
    opId = o.id;
    await ops.acknowledgeGap(root, {
      operationId: opId, rationale: "no settlement code exists to conform yet",
      priority: "medium", revalidateBy: "2027-01-01T00:00:00Z", ...AGENT,
    } as any);

    // A problem awaiting adjudication. This is the act an agent structurally CANNOT do —
    // the same argument that put ratification on the web — and until this suite drove it
    // the hub counted the queue and offered no way to empty it.
    const audit = ok(await ops.recordAudit(root, {
      requirementId: ruleId, outcome: "nonconformant", finding: "transfer() takes no currency at all",
      evidence: { read: [anchor] }, ...AGENT,
    } as any)) as any;
    ok(await ops.raiseProblem(root, {
      auditId: audit.id, summary: "the rule says USD and nothing enforces a currency", ...AGENT,
    } as any));

    // A section move, so the "what would actually move" panel has something to say.
    const m = await ops.draftSpec(root, { title: "Credit belongs under Risk", ...AGENT }) as any;
    moveSpec = m.id;
    await ops.addOperation(root, {
      specId: moveSpec, kind: "move_section", rationale: "credit policy is risk policy",
      reversibility: "reversible", fromSection: "Credit", toSection: "Risk", ...AGENT,
    } as any);

    // A proposal whose ground moves out from under it before anyone adopts it.
    const st = await ops.draftSpec(root, { title: "Widen the currency rule", ...AGENT }) as any;
    staleSpec = st.id;
    await ops.addOperation(root, {
      specId: staleSpec, kind: "amend_statement", requirementId: ruleId,
      statement: "All credit lines are in USD or EUR.", rationale: "EU launch",
      reversibility: "reversible", ...AGENT,
    } as any);
    const other = await ops.draftSpec(root, { title: "Someone amended first", ...AGENT }) as any;
    await ops.addOperation(root, {
      specId: other.id, kind: "amend_statement", requirementId: ruleId,
      statement: "All credit lines are in USD or GBP.", rationale: "UK first",
      reversibility: "reversible", ...AGENT,
    } as any);
    await ops.ratifySpec(root, { specId: other.id });

    server = await startServer(root);
    browser = await launchPlaywright(pw);
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    discard(root);
    discard(side);
  });

  async function open(path: string) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    // HASH mode: a path-form deep link falls back to home and the test would pass on
    // the wrong page.
    await page.goto(`${server.url}/#${path}`, { waitUntil: "networkidle" });
    return { page, errors };
  }

  test("the queue warns about the two things only the ratifier can refuse", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/`);
    await page.waitForSelector(".spec-card", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text!, /Float settles next business day/);
    assert.match(text!, /irreversible/, "satisfying it cannot be undone, and that changes the decision");
    assert.match(text!, /pre-silenced/, "a gap binds the moment this is adopted — this is the last screen it can be refused on");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a section move shows the rules it would actually take, not just the two paths", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/spec/${moveSpec}/`);
    await page.waitForSelector(".op-move", { timeout: 10_000 });
    const move = await page.textContent(".op-move");
    assert.match(move!, /Credit\/Limits/, "the source heading");
    assert.match(move!, /Risk\/Limits/, "and where that rule lands");
    assert.match(move!, /Credit line currency/, "named, because 'Credit → Risk' does not say how much is filed under it");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a proposal whose base moved cannot be adopted, and says so before the click", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/spec/${staleSpec}/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text!, /cannot be adopted as drafted/);
    assert.equal(await page.locator(".op-actions button").first().isDisabled(), true,
      "the ratify button is disabled — a refusal after the click is a worse answer than a disabled button");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a comment lands on the OPERATION it was written against, and is there on reload", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/spec/${draft}/`);
    await page.waitForSelector(".cmt-new", { timeout: 10_000 });
    // The operation's composer, not the spec's — an objection to one amendment has to
    // render against that amendment or the ratifier reads it in the wrong place.
    await page.locator(".op-card .cmt-new input").first().fill("Is T+1 calendar or business days?");
    await page.locator(".op-card .cmt-new button").first().click();
    await page.waitForSelector(".op-card .cmt", { timeout: 10_000 });
    assert.match((await page.textContent(".op-card .cmt"))!, /calendar or business days/);
    assert.deepEqual(errors, []);
    await page.close();

    // Reload: it is in the shared log, not in the page's head.
    const again = await open(`/u/${universe}/standard/spec/${draft}/`);
    await again.page.waitForSelector(".op-card .cmt", { timeout: 10_000 });
    const cmt = (await again.page.textContent(".op-card .cmt"))!;
    assert.match(cmt, /calendar or business days/);
    // WHO said it, which the assertion above cannot see and which is the point of the
    // thread: `sharedNotes` flattens a note to `{by, model, at}` and the page read
    // `n.author.principal` / `n.createdAt`, so every comment rendered as "unknown" with a
    // blank date — losing exactly the `via` the module's own docstring calls load-bearing.
    assert.match(cmt, /izzie@x\.com/, "a comment with no author is the misattribution this has shipped once already");
    assert.doesNotMatch(cmt, /unknown/);
    assert.match(cmt, /\d{4}-\d{2}-\d{2}/, "and when");
    await again.page.close();
  });

  test("a comment on the PROPOSAL is a different thread from one on an operation", async () => {
    // Written because a mutation caught this untested: dropping the spec-level thread
    // from `getSpec` failed nothing, since the test above reads only the operation's.
    // Two targets, two threads — that separation is the whole reason to comment per
    // operation, so both halves need a test.
    const { page, errors } = await open(`/u/${universe}/standard/spec/${moveSpec}/`);
    await page.waitForSelector(".cmt-new", { timeout: 10_000 });
    const specComposer = page.locator("main > .cmt-new");
    await specComposer.locator("input").fill("Does Treasury own Risk/ now?");
    await specComposer.locator("button").click();
    await page.waitForSelector("main > .cmts .cmt", { timeout: 10_000 });
    assert.match((await page.textContent("main > .cmts"))!, /Does Treasury own/);
    assert.equal(await page.locator(".op-card .cmt").count(), 0,
      "it belongs to the proposal, and must not appear against an operation nobody aimed it at");
    assert.deepEqual(errors, []);
    await page.close();
  });

  /**
   * Correcting a DRAFT from the browser — deliverable's other half.
   *
   * An agent drafts, goes away, and the principal about to adopt the thing is the one who
   * spots that the narrative names the wrong branch. Their only alternative was refusing
   * the whole proposal, or a comment the ratifier reads AFTER the wrong framing.
   *
   * A fresh spec of its own, because the tests in this file share one fixture and this one
   * ends by removing an operation — reusing `draft` would change what the ratification
   * test below adopts.
   */
  test("a person corrects a draft in the browser: the title, an operation, and pulling one", async () => {
    const sp = ok(await ops.draftSpec(root, { title: "Sweep window", narrative: "on branch feat/typo", ...AGENT })) as any;
    const keep = ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "the sweep has a window",
      reversibility: "reversible", title: "Sweep window", section: "Settlement/Sweep",
      statement: "The sweep runs at 17:00.", provenance: "treasury practice", ...AGENT,
    } as any)) as any;
    const pull = ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "second thought",
      reversibility: "reversible", title: "Sweep rounding", section: "Settlement/Sweep",
      statement: "The sweep rounds to the cent.", provenance: "treasury practice", ...AGENT,
    } as any)) as any;

    const { page, errors } = await open(`/u/${universe}/standard/spec/${sp.id}/`);
    await page.waitForSelector(".op-edit button", { timeout: 10_000 });

    // The narrative, which is the thing that renders and therefore the thing a wrong
    // framing does its damage through.
    await page.locator(".op-edit button", { hasText: "correct title / background" }).click();
    await page.locator("main > .op-card textarea").fill("on branch feat/sweep");
    await page.locator(".op-edit button", { hasText: "save" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("feat/sweep"), null, { timeout: 10_000 },
    );
    const afterSpec = await page.textContent("main");
    assert.doesNotMatch(afterSpec!, /feat\/typo/, "the ratifier reads ONE current text, not a correction chain");
    assert.match(afterSpec!, /corrected 1 time/, "and that it was corrected, by whom");

    // One operation's statement.
    await page.locator(`.op-card`).filter({ hasText: "The sweep runs at 17:00." })
      .locator(".op-edit button", { hasText: "correct this operation" }).click();
    await page.locator(".op-move textarea").first().fill("The sweep runs at 16:00.");
    await page.locator(".op-move .op-edit button", { hasText: "save" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("16:00"), null, { timeout: 10_000 },
    );

    // And pulling one out, which is the verb whose absence made the asymmetry backwards.
    await page.locator(`.op-card`).filter({ hasText: "The sweep rounds to the cent." })
      .locator(".op-edit button", { hasText: "correct this operation" }).click();
    await page.locator(".op-move input").last().fill("rounding belongs in its own spec");
    await page.locator(".op-move button", { hasText: "remove operation" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("pulled from this proposal"), null, { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();

    // Asserted through ops, not through the page that just told us it happened.
    const served = ok(await ops.getSpec(root, { specId: sp.id })) as any;
    assert.equal(served.spec.narrative, "on branch feat/sweep");
    assert.deepEqual(served.operations.map((o: any) => o.operation.id), [keep.id]);
    assert.equal(served.operations[0].operation.statement, "The sweep runs at 16:00.");
    assert.deepEqual(served.removed.map((o: any) => o.id), [pull.id]);
    assert.match(served.removed[0].removed.reason, /own spec/);
  });

  /**
   * The UI hides the buttons on a ratified spec; that is not what stops the edit.
   *
   * A browser is a client, and a client is not a guard. `curl` is the whole threat model
   * this route already has (`PRINCIPAL_NOTICE`), so the refusal has to be in the handler —
   * and it is, in `requirements.ts` and again in `foldStandard`. This drives the ROUTE
   * with the notice satisfied, which is the strongest form of the attempt.
   */
  test("a correction to a RATIFIED spec is refused by the server, not merely hidden by the page", async () => {
    const a = await (await fetch(`${server.url}/api/standard/attest`)).json();
    const attest = `${a.notice} ${a.nonce}`;
    const post = async (act: string, body: Record<string, unknown>) =>
      (await (await fetch(`${server.url}/api/standard/${act}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ u: universe, attest, ...body }),
      })).json()) as { error?: string };

    // The rule that already stands, and the operation that produced it.
    const history = ok(await ops.getRequirement(root, { id: ruleId })) as any;
    const producing = history.history.find((o: any) => o.kind === "add_requirement");
    const specOf = producing.specId;

    assert.match((await post("revise_spec", { specId: specOf, title: "quietly different" })).error ?? "", /ratified/);
    assert.match((await post("revise_operation", { operationId: producing.id, statement: "All credit lines are in GBP." })).error ?? "", /ratified/);
    assert.match((await post("remove_operation", { operationId: producing.id, reason: "second thoughts" })).error ?? "", /ratified/);

    // And the standard did not move.
    const rule = ok(await ops.getRequirement(root, { id: ruleId })) as any;
    assert.equal(rule.requirement.statement, "All credit lines are in USD or GBP.");
  });

  test("a rule says when it was last looked at, what is watching it, and what has silenced it", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/r/${ruleId}/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text!, /audit history/i);
    assert.match(text!, /no currency check on entry/, "the finding, not just a verdict");
    assert.match(text!, /the conversion happens here/, "the pointer — where to look");
    assert.match(text!, /fix scheduled for Q4/, "and the debt that is keeping it quiet");
    // Branch work is on the page, and it is on a different part of it. The reviewer of a
    // branch could not see this at all before, and it must not read as the codebase's
    // record — which is the whole reason it has a section of its own.
    assert.match(text!, /branch findings/i);
    assert.match(text!, /the branch drops the currency field/);
    assert.match(text!, /fix\/currency/, "and it says which branch, because that is what makes it provisional");
    assert.ok(
      text!.indexOf("no currency check on entry") < text!.indexOf("the branch drops the currency field"),
      "the codebase's record comes first — a branch observation is not the headline",
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the hub opens every queue it counts, not only the one with a page", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/`);
    await page.waitForSelector(".spec-card", { timeout: 10_000 });
    const text = await page.textContent("main");
    // Six counted queues, and the reason this test exists: five of them had no rows on
    // any surface, so a person could see a number and not what it was made of.
    for (const q of [/ratification queue/i, /awaiting adjudication/i, /owed/i,
                     /settled without adjudication/i, /promotable branch findings/i,
                     /silencers past their revalidate-by/i]) {
      assert.match(text!, q);
    }
    assert.match(text!, /the rule says USD and nothing enforces a currency/, "the problem itself, not just a count");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a principal adjudicates from the browser — the act an agent cannot perform", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/`);
    await page.waitForSelector(".op-actions button", { timeout: 10_000 });
    const before = (await ops.awaitingAdjudication(root) as any).problems.length;
    assert.equal(before, 1, "the fixture must have something to decide or this is vacuous");

    // The reason box first: `adjudicate` refuses an empty one, and that refusal is the
    // point — a decision with no reason leaves a later reader nothing but the verb.
    await page.locator('input[placeholder^="why"]').first().fill("the rule stands");
    await page.locator('.op-actions button:has-text("code-wrong")').first().click();
    await page.waitForFunction(
      () => !document.querySelector('main')?.textContent?.includes('un-adjudicated'),
      { timeout: 10_000 },
    );
    const after = await ops.awaitingAdjudication(root) as any;
    assert.equal(after.problems.length, 0, "the queue emptied because the decision landed");
    assert.equal((await ops.listProblems(root) as any).problems[0].disposition, "code-wrong");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("branch findings are visible, and say they are not the codebase", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/branch/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text!, /the branch drops the currency field/, "the finding a teammate could not see before");
    assert.match(text!, /fix\/currency/);
    assert.match(text!, /reach no clone's conformance/i, "and the page says what it is NOT");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("conformance says where every rule stands, about the codebase or about this branch", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/conformance/`);
    await page.waitForSelector(".spec-card", { timeout: 10_000 });
    assert.match((await page.textContent("main"))!, /Credit line currency/);

    // The toggle is the half worth driving: it is the only read where a branch finding
    // counts, and it must actually re-fetch rather than re-filter what is already loaded.
    await page.locator('button:has-text("this branch")').click();
    await page.waitForFunction(
      () => document.querySelector('main')?.textContent?.includes('feeds no queue'),
      { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the audit plan says where to look, which the distribution never does", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/audit/`);
    await page.waitForSelector(".sec", { timeout: 10_000 });
    const text = await page.textContent("main");
    for (const s of [/pointers firing/i, /nothing is watching/i, /coverage deadlines/i,
                     /pins whose lint moved/i, /checks nobody has shown can fail/i, /baseline sweep/i]) {
      assert.match(text!, s);
    }
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the dossier carries what discharges a rule, what it ranges over, and the acts only a person can do", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/r/${ruleId}/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text!, /what discharges it/i);
    assert.match(text!, /what it ranges over/i);
    assert.match(text!, /covering audits/i);
    assert.match(text!, /accept debt/i, "granting debt is a PRINCIPAL act and had nowhere to happen");
    // The fixture has a sidecar, so this rule came from the FOLD and carries an origin —
    // and `reorganizeRequirement` refuses a shared row. The panel therefore says so instead
    // of offering a button that errors on every team store, which is the only configuration
    // this subsystem is for. `requirements-architecture.md` § *Deliberately open* named the
    // failure ("the only way to fix filing is to write a spec about filing") before it was
    // built; the affordance shipped anyway and this is what found it.
    assert.match(text!, /re-file/i);
    assert.match(text!, /move the whole heading with a/i, "and it says what to do instead");
    assert.equal(await page.locator('input[placeholder^="section"]').count(), 0,
      "no form that cannot work");

    // DRIVE it, because a form is a set of field names and a typo in one is invisible to
    // every other kind of test: the POST would arrive with the key missing and the act
    // would refuse or, worse, record something empty.
    await page.locator('input[placeholder^="why we are living"]').fill("fix scheduled for Q1");
    await page.locator('input[placeholder^="revalidate by"]').fill("2028-01-01T00:00:00Z");
    await page.locator('.op-actions button:has-text("high")').click();
    await page.waitForFunction(
      () => document.querySelector('main')?.textContent?.includes('fix scheduled for Q1'),
      { timeout: 10_000 },
    );
    const acks = (await ops.listAcknowledgements(root, { requirementId: ruleId }) as any).acknowledgements;
    const granted = acks.find((a: any) => a.rationale === "fix scheduled for Q1");
    assert.ok(granted, "the debt reached the store, not just the page");
    assert.equal(granted.basis, "debt");
    assert.equal(granted.priority, "high", "the priority is the button that was clicked, not a default");
    assert.ok(!granted.grantedBy.via, "a browser is a person — an agent cannot grant debt at all");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a branch finding is promoted from the hub, and stops being offered", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    const before = (await ops.promotableAudits(root) as any).audits;
    assert.equal(before.length, 1, "the branch finding must be promotable here or this is vacuous");

    await page.locator('.op-actions button:has-text("promote")').click();
    await page.waitForFunction(
      () => document.querySelector('main')?.textContent?.includes('nothing to promote'),
      { timeout: 10_000 },
    );
    assert.equal((await ops.promotableAudits(root) as any).audits.length, 0);
    const promoted = (await ops.auditsFor(root, { requirementId: ruleId }) as any).audits
      .find((a: any) => a.promotedFrom === before[0].id);
    assert.ok(promoted, "a NEW audit of the codebase — the original was taken on a branch");
    assert.equal(promoted.provisional, undefined);
    assert.deepEqual(errors, []);
    await page.close();
  });

  /**
   * The bare POST — the cheapest path, and the one the design had accepted.
   *
   * `docs/cross-universe-standard.md` argued that no gate here removes the capability, which
   * is true and is not the point. The failure mode this subsystem targets is not malice: it
   * is an agent under deadline pressure taking the cheapest available path, and
   * `curl -XPOST .../adjudicate` was dramatically cheaper than forging a log event. It is now
   * one request more expensive, and that request hands back a sentence saying what sending it
   * would mean. Nothing here is authentication and the test asserts nothing that resembles it
   * — only that the act cannot be performed WITHOUT being told.
   */
  test("a principal act cannot be performed without being told what it is", async () => {
    // Its OWN problem: the browser test above adjudicated the fixture's, and a second
    // adjudication of one is refused — which would have made the last assertion here pass
    // for the wrong reason.
    const au = ok(await ops.recordAudit(root, {
      requirementId: ruleId, outcome: "nonconformant", finding: "no currency on the settlement path",
      evidence: { read: [anchor] }, ...AGENT,
    } as any)) as any;
    const target = (ok(await ops.raiseProblem(root, {
      auditId: au.id, summary: "settlement float has no currency check", ...AGENT,
    } as any)) as any).problem;
    assert.ok(target && !target.disposition, "a fresh, un-adjudicated problem or this proves nothing");

    const bare = await fetch(`${server.url}/api/standard/adjudicate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ u: universe, problemId: target.id, disposition: "code-wrong", reason: "by curl" }),
    });
    assert.equal(bare.status, 400);
    const said = await bare.json() as { error: string };
    assert.match(said.error, /reserves to a person/, "and it says what it is, not just no");
    assert.match(said.error, /attest/);

    // The notice itself is handed to anybody who asks — deliberately. It is a claim about
    // who you are, not a secret, and an opaque token would be EASIER to satisfy without
    // reading, which is the only property this has.
    const a = await (await fetch(`${server.url}/api/standard/attest`)).json() as { notice: string; nonce: string };
    assert.match(a.notice, /I am a person, acting at a browser/);
    assert.match(a.notice, /off the rails/);

    const withNotice = await fetch(`${server.url}/api/standard/adjudicate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        u: universe, problemId: target.id, disposition: "requirement-misstated",
        reason: "settlement float is held in the tender currency", attest: `${a.notice} ${a.nonce}`,
      }),
    });
    assert.equal(withNotice.status, 200);
    const after = (await ops.listProblems(root) as any).problems.find((p: any) => p.id === target.id);
    assert.equal(after.disposition, "requirement-misstated", "and then it is an ordinary act");
  });

  test("ratifying from the browser applies the spec and empties the queue", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/spec/${draft}/`);
    await page.waitForSelector(".op-actions button", { timeout: 10_000 });
    await page.locator(".op-actions button").first().click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("ratified"), null, { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();

    // The standard really moved — asserted through ops, not through the page that
    // just told us it did.
    const rules = (await ops.listRequirements(root) as any).requirements;
    assert.ok(rules.some((r: any) => r.title === "Float settlement window"), "the rule is in the standard");
    const acks = (await ops.listAcknowledgements(root) as any).acknowledgements;
    assert.ok(acks.some((a: any) => a.basis === "gap" && a.state === "active"),
      "and the pre-approved gap bound and activated in the same act");
  });

  /**
   * The banner that says *this is not the team's standard*.
   *
   * It rendered on NOTHING for as long as these pages existed: `servedNote` read
   * `d.served` and `served()` attaches `scope`. `tsc -p web` could not see it — the
   * parameter is untyped — and no test blocked a scope in a browser, so a blocked team's
   * rows were served with no warning on every page. That is the exact failure
   * `standardScopeWarning` was written to close, reintroduced one layer up.
   *
   * LAST, because it corrupts the sidecar for every test after it.
   */
  test("a blocked log says so in the browser, on every page that serves its rows", async () => {
    // Fork one writer's shard: replay the same events under a second writer id, which is
    // the shape `scopeStatus` refuses to read as settled.
    const { readdirSync, readFileSync: rf, writeFileSync: wf, statSync } = await import("node:fs");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? (f === ".git" ? [] : walk(p)) : p.endsWith(".ndjson") ? [p] : [];
    });
    const shard = walk(side)[0];
    assert.ok(shard, "the fixture must have written events, or blocking it proves nothing");
    const lines = rf(shard!, "utf8").split("\n").filter(Boolean)
      .map((l: string) => JSON.stringify({ ...JSON.parse(l), subject: "tampered" }));
    wf(shard!.replace(/[^/]+\.ndjson$/, "w_impostor.ndjson"), lines.join("\n") + "\n", "utf8");
    assert.equal((await ops.listRequirements(root) as any).scope?.status, "blocked",
      "the fixture must actually be blocked or the assertions below are vacuous");

    for (const path of [`/u/${universe}/standard/`, `/u/${universe}/standard/conformance/`,
                        `/u/${universe}/standard/r/${ruleId}/`]) {
      const { page, errors } = await open(path);
      await page.waitForSelector(".attn-banner", { timeout: 10_000 });
      const text = await page.textContent("main");
      assert.match(text!, /not the team's standard/i, `${path} served a blocked scope silently`);
      assert.match(text!, /refusing to be read as settled/i);
      assert.deepEqual(errors, []);
      await page.close();
    }
  });
});
