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
    assert.match((await again.page.textContent(".op-card .cmt"))!, /calendar or business days/);
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
});
