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
import { lawScope, publishOperation } from "../shared-standard.js";
import { readScope } from "../eventlog.js";
import { discard } from "../test-tmp.js";
import { operationContent } from "../schema.js";
import type { Operation } from "../schema.js";

const pw = resolvePlaywright();
const AGENT = { agent: true, model: "claude-opus-5" } as const;
/** The same actor `AGENT` resolves to, for the raw events a nonconforming client writes. */
const MATE = { principal: "izzie@x.com", via: { kind: "agent" as const, model: "claude-opus-5" } };

/** Assert an ops call succeeded. A silent `{error}` in `before` cancels the whole suite. */
const ok = <T,>(r: T): T => {
  assert.ok(!(r && typeof r === "object" && "error" in (r as object)), `fixture failed: ${(r as any)?.error}`);
  return r;
};

/**
 * Sign off a proposal as the person, through the ops surface — `ratifySpec` refuses an
 * adoption its ratifier has not witnessed, so a fixture that wants a ratified rule has to
 * go round the loop like anybody else.
 */
async function approve(root: string, specId: string) {
  const f = await ops.signOffFraming(root, { specId } as any);
  assert.ok(!("error" in (f as object)), `sign-off failed: ${(f as any).error}`);
  const d = ok(await ops.getSpec(root, { specId } as any)) as any;
  for (const o of d.operations) {
    const r = await ops.signOffOperation(root, { operationId: o.operation.id } as any);
    assert.ok(!("error" in (r as object)), `sign-off failed: ${(r as any).error}`);
  }
}

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
    await approve(root, base.id);
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
      statement: "Captured float settles on the next business day.", provenance: "treasury practice",
      // `evidence` and, on the criterion below, `assertedBy`: both are hashed into a
      // sign-off, and a fixture without them lets "every signed field renders" pass on
      // absence — which is the vacuity this subsystem names as the standing risk.
      evidence: "treasury minute 2026-04-11", ...AGENT,
    } as any) as any;
    opId = o.id;
    await ops.acknowledgeGap(root, {
      operationId: opId, rationale: "no settlement code exists to conform yet",
      priority: "medium", revalidateBy: "2027-01-01T00:00:00Z", ...AGENT,
    } as any);
    // And an acceptance criterion on that same rule. No fixture in this file carried one,
    // so the card kind with its OWN body arm, its own correction fields and the only
    // operation `grouped()` nests was the one nothing here rendered, signed off or adopted.
    ok(await ops.addOperation(root, {
      specId: draft, kind: "add_criterion", rationale: "what would show the window slipped",
      reversibility: "reversible", targetOperationId: opId,
      criterion: "A capture on a Friday settles on the following Monday.",
      falsifier: "a capture on Friday that settles the same day",
      evidenceKind: "automated-test", ...AGENT,
    } as any));

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
    await approve(root, other.id);
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

  /**
   * Every operation the server serves renders exactly one card.
   *
   * `grouped()` files an `add_criterion` under the `add_requirement` it tests, and nesting
   * is how a card gets CONSUMED: a criterion naming ITSELF is marked nested and is its own
   * parent, so neither the parent pass nor the child pass reaches it, and one naming
   * another criterion is filed under a parent that is itself nested and gets no children
   * pass. Both render nothing whatever.
   *
   * Neither shape is authorable — `addOperation` refuses a target that is not an
   * `add_requirement` and the ratification fold refuses it again — but `case
   * "spec.operation"` in `shared-standard.ts` stores an operation VERBATIM, so a teammate's
   * clone holds whatever a nonconforming client wrote. Which is why the fixture below
   * arrives as a raw event: that is the honest reproduction, not a shortcut past the tool.
   *
   * It is asserted as a COUNT against what the server served rather than by looking for the
   * two bad cards, because the property is that nesting can never swallow an operation.
   * This is the ratification screen and adoption is all-or-nothing: an operation that does
   * not render is one the reader adopts without ever having seen it.
   */
  test("every operation a proposal contains renders, however its criteria are aimed", async () => {
    const sp = ok(await ops.draftSpec(root, { title: "Sweep criteria", ...AGENT })) as any;
    const rule = ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "the cutoff has never been written down",
      reversibility: "reversible", title: "Sweep cutoff time", section: "Settlement/Cutoff",
      statement: "The sweep cuts off at 17:00.", provenance: "treasury practice", ...AGENT,
    } as any)) as any;
    // The well-formed one, so the count below also proves nesting still RENDERS its child
    // rather than passing because nesting was disabled.
    ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_criterion", rationale: "what would show the cutoff moved",
      reversibility: "reversible", targetOperationId: rule.id,
      criterion: "A capture at 17:01 lands in the next sweep.",
      falsifier: "a capture at 17:01 that lands in the same sweep",
      evidenceKind: "automated-test", ...AGENT,
    } as any));

    const crit = (id: string, targetOperationId: string, criterion: string): Operation => ({
      id, specId: sp.id, kind: "add_criterion", ord: 9, targetOperationId, criterion,
      falsifier: `an observation that ${criterion} does not hold`,
      evidenceKind: "automated-test",
      rationale: "written by a client that never checked", reversibility: "reversible",
    });
    // Self-targeting, and criterion-on-criterion. `ord` collides on purpose — two rows a
    // conforming writer could never mint, arriving the only way they can.
    await publishOperation(side, lawScope(), MATE, crit("op_self", "op_self", "the sweep is idempotent"));
    await publishOperation(side, lawScope(), MATE, crit("op_chain", "op_self", "and it is logged"));

    const served = ok(await ops.getSpec(root, { specId: sp.id } as any)) as any;
    assert.equal(served.operations.length, 4, "the raw events must have reached the rows or this is vacuous");

    const { page, errors } = await open(`/u/${universe}/standard/spec/${sp.id}/`);
    await page.waitForSelector(".op-group .op-card", { timeout: 10_000 });
    assert.equal(
      await page.locator(".op-group .op-card").count(), served.operations.length,
      "the page must render one card per operation the server served — nesting may file a "
      + "criterion under its rule and may never consume it",
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  /**
   * A ratifier signs what they READ, and `operationContent` decides what "what" means.
   *
   * That function (`schema.ts`) is the exact field set a sign-off hashes, so a field it
   * includes and the card omits is a field the reader signs without ever seeing — the gate
   * this whole surface exists to be, failing silently. Four were missing: `requirementId`,
   * the criterion's anchors (shown as a COUNT, so two criteria differing only in what they
   * pinned rendered identically and signed to different hashes), `evidence`, and
   * `reversibility` whenever it was not `irreversible`.
   *
   * The anchors are no longer among them — a criterion's check is a detector `Pointer` now,
   * so it is not in `operationContent` and there is nothing here to render. The other three
   * are still required below, because the guard is what stops this passing on absence.
   *
   * Asserted against `operationContent` itself rather than a list written here, so a field
   * ADDED to the witness is covered by this the day it lands. `evidenceKind` is checked
   * verbatim, which is why the page stopped prettifying `automated-test` — do not
   * reintroduce that transform.
   */
  test("every field a sign-off hashes is on the card the reviewer signs", async () => {
    /** Shown structurally rather than verbatim. Each entry says how, and is checked nowhere else. */
    const STRUCTURAL: Record<string, string> = {
      kind: "the badge, with underscores as spaces",
      section: "the Area / Topic headings the card sits under, split on `/`",
      targetOperationId: "shown by nesting the criterion under the rule it tests",
      against: "the `now` block, which is what a base statement is",
    };
    let checked = 0;
    const seen = new Set<string>();
    for (const specId of [draft, moveSpec, staleSpec]) {
      const served = ok(await ops.getSpec(root, { specId } as any)) as any;
      const { page, errors } = await open(`/u/${universe}/standard/spec/${specId}/`);
      await page.waitForSelector(".op-group .op-card", { timeout: 10_000 });
      const cards: string[] = await page.evaluate(
        () => [...document.querySelectorAll(".op-group .op-card")].map((e) => (e as HTMLElement).innerText),
      );
      for (const o of served.operations) {
        // The card is found by its own rationale, which every operation carries and which
        // is rendered on every kind — there is no id in the markup to key on.
        const mine = cards.filter((c) => c.includes(o.operation.rationale));
        assert.equal(mine.length, 1, `no single card for ${o.operation.id} (${o.operation.kind})`);
        for (const [field, value] of Object.entries(operationContent(o.operation) as Record<string, string>)) {
          if (STRUCTURAL[field]) continue;
          seen.add(field);
          checked++;
          assert.ok(
            mine[0]!.includes(value),
            `\`${field}\` is signed and not rendered on the ${o.operation.kind} card: ${JSON.stringify(value)}`,
          );
        }
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    // Could this pass on absence? Only with a fixture carrying none of the fields the
    // defect was about — which is what made the original rendering look correct.
    assert.ok(checked >= 15, `only ${checked} signed fields reached the assertion`);
    for (const f of ["evidence", "reversibility", "requirementId"]) {
      assert.ok(seen.has(f), `no fixture operation carries \`${f}\`, so this says nothing about it`);
    }
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
    // The composer is behind a click — an empty box on every card cost a row apiece. An
    // existing THREAD is not, which the reload half below asserts without opening anything.
    await page.locator(".op-card .op-head").first().click();
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
    // framing does its damage through. Fields are addressed by their LABEL, not by being
    // the only textarea in the form — they were not, the moment `reason` was added.
    await page.locator(".op-edit button", { hasText: "correct title / background" }).click();
    await page.locator("label.fs", { hasText: "background" }).locator("textarea").fill("on branch feat/sweep");
    await page.locator("label.fs", { hasText: "CORRECTING" }).locator("textarea").fill("the draft named the wrong branch");
    await page.locator(".op-edit button", { hasText: "save" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("feat/sweep"), null, { timeout: 10_000 },
    );
    const afterSpec = await page.textContent("main");
    assert.doesNotMatch(afterSpec!, /feat\/typo/, "the ratifier reads ONE current text, not a correction chain");
    assert.match(afterSpec!, /corrected 1 time/, "and that it was corrected, by whom");
    // Why it was corrected, beside the fact of it. Without this the reader is told a text
    // they may already have read has moved, and not told what moved it.
    assert.match(afterSpec!, /the draft named the wrong branch/, "and why — the field `rationale` used to absorb");

    // One operation's statement.
    await page.locator(`.op-card`).filter({ hasText: "The sweep runs at 17:00." })
      .locator(".ft button", { hasText: "correct" }).click();
    await page.locator(".op-move textarea").first().fill("The sweep runs at 16:00.");
    await page.locator(".op-move .op-edit button", { hasText: "save" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("16:00"), null, { timeout: 10_000 },
    );

    // And pulling one out, which is the verb whose absence made the asymmetry backwards.
    await page.locator(`.op-card`).filter({ hasText: "The sweep rounds to the cent." })
      .locator(".ft button", { hasText: "correct" }).click();
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
   * Taking a proposal back, and what goes with it.
   *
   * The other disposal, and the one nothing here drove: the page sends `withdraw` with the
   * reason from a field no other act uses, and `withdrawSpec` refuses a blank one — "it
   * stays on the record as the act it is" — so a button that forgot to attach it would fail
   * on every proposal and pass every test in this file.
   *
   * The gap is the half worth asserting through ops. A pre-approved gap is chained to an
   * operation and ends with the proposal it was an argument for — RELEASED rather than
   * deleted, because the grant really happened. A withdrawal that left it pending would
   * leave a silencer behind for a rule nobody adopted.
   */
  test("a proposal is withdrawn from the browser, and the gap it carried ends with it", async () => {
    const sp = ok(await ops.draftSpec(root, { title: "Retire the paper mandate", ...AGENT })) as any;
    const op = ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "nothing has issued one since 2019",
      reversibility: "reversible", title: "Paper mandates", section: "Settlement/Mandates",
      statement: "Paper mandates are not accepted.", provenance: "operations", ...AGENT,
    } as any)) as any;
    const gap = ok(await ops.acknowledgeGap(root, {
      operationId: op.id, rationale: "no mandate code exists to conform yet",
      priority: "low", revalidateBy: "2027-06-01T00:00:00Z", ...AGENT,
    } as any)) as any;

    const { page, errors } = await open(`/u/${universe}/standard/spec/${sp.id}/`);
    await page.waitForSelector('.op-actions input[placeholder^="reason, if withdrawing"]', { timeout: 10_000 });
    await page.locator('.op-actions input[placeholder^="reason, if withdrawing"]')
      .fill("the mandate rule belongs in the onboarding spec");
    // The button is dead until there is a reason, and it must come alive from the TYPING
    // alone. It was bound `on-change`, which fires on blur — and a disabled button takes no
    // mouse event, so it never blurred the box and clicking withdraw did nothing, for ever.
    // The sibling removal-reason input was already `on-input` for this exact reason.
    await page.waitForFunction(
      () => [...document.querySelectorAll(".op-actions button")]
        .some((b) => b.textContent!.includes("withdraw") && !(b as HTMLButtonElement).disabled),
      null, { timeout: 10_000 },
    );
    await page.locator(".op-actions button", { hasText: "withdraw" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("withdrawn"), null, { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();

    const served = ok(await ops.getSpec(root, { specId: sp.id } as any)) as any;
    assert.equal(served.spec.status, "withdrawn");
    // The reason is on the EVENT and nowhere else — no `Spec` field holds it — so this is
    // the only place that can say the field reached the act rather than being dropped.
    const said = (await readScope(side, lawScope()))
      .find((e) => e.kind === "spec.withdrawn" && e.subject === sp.id);
    assert.match(String((said?.data as any)?.reason ?? ""), /onboarding spec/);
    const acks = (await ops.listAcknowledgements(root) as any).acknowledgements;
    const ended = acks.find((a: any) => a.id === gap.id);
    assert.equal(ended.state, "released", "a silencer for a rule nobody adopted must not outlive the proposal");
  });

  /**
   * Signing off ONE operation, which is not the same button as signing off all of them.
   *
   * The loop test below takes the bulk path, and a bulk sign-off is one call whatever the
   * count. The per-card button is the other axis — it is what a reviewer who read one
   * amendment and not the rest presses — and it writes one witness per press, so a body key
   * that stopped matching `signOffOperation` would leave the page reporting progress it had
   * not made. That the ratify button stays dead afterwards is the assertion that says the
   * signature covered one operation and not the proposal.
   */
  test("one operation is signed off on its own, and that is not the whole proposal", async () => {
    const sp = ok(await ops.draftSpec(root, { title: "Two things at once", ...AGENT })) as any;
    ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "the first",
      reversibility: "reversible", title: "Statement cadence", section: "Settlement/Statements",
      statement: "Statements are issued monthly.", provenance: "operations", ...AGENT,
    } as any));
    ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "the second",
      reversibility: "reversible", title: "Statement retention", section: "Settlement/Statements",
      statement: "Statements are retained for seven years.", provenance: "operations", ...AGENT,
    } as any));

    const { page, errors } = await open(`/u/${universe}/standard/spec/${sp.id}/`);
    await page.waitForSelector(".op-edit button", { timeout: 10_000 });
    // Pull first: the per-card badges are drawn from the review gap, so without it there is
    // nothing on the page that could tell a signed card from an unsigned one.
    await page.locator(".op-edit button", { hasText: "pull & show what moved" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("3 left to read"), null, { timeout: 10_000 },
    );
    await page.locator(".op-group .op-card", { hasText: "Statements are issued monthly." })
      .locator("button", { hasText: "sign off" }).click();
    // Two operations and the framing were outstanding; one press moves it to two.
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("2 left to read"), null, { timeout: 10_000 },
    );
    assert.equal(await page.locator(".op-group .op-card .qbadge.ok").count(), 1, "exactly the one that was pressed");
    assert.equal(await page.locator(".op-actions button", { hasText: "ratify" }).isDisabled(), true,
      "adoption is all-or-nothing, so one signature is not consent to the proposal");
    assert.deepEqual(errors, []);
    await page.close();

    const gap = ok(await ops.reviewProposal(root, { specId: sp.id } as any)) as any;
    assert.equal(gap.review.unwitnessed.length, 1, "one witness written, not two and not none");
    assert.equal(gap.review.unwitnessed[0].title, "Statement retention");
  });

  /**
   * The disabled button is a courtesy. The refusal is in the handler.
   *
   * A browser is a client and a client is not a guard — `curl` is the whole threat model
   * this route already has. So this drives the ROUTE with the notice satisfied, on a spec
   * this person has not signed, and gets the structured payload back rather than prose:
   * the web app can send the reviewer straight to what they have not approved, which is the
   * same thing the MCP refusal carries.
   */
  test("an unsigned ratification is refused by the SERVER, with the routing payload", async () => {
    const sp = ok(await ops.draftSpec(root, { title: "Unsigned", ...AGENT })) as any;
    ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "nobody read this",
      reversibility: "reversible", title: "Sweep cutoff", section: "Settlement/Cutoff",
      statement: "The sweep cuts off at 16:00.", provenance: "treasury", ...AGENT,
    } as any));

    const a = await (await fetch(`${server.url}/api/standard/attest`)).json();
    const post = async (act: string, body: Record<string, unknown>) =>
      (await (await fetch(`${server.url}/api/standard/${act}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ u: universe, attest: `${a.notice} ${a.nonce}`, ...body }),
      })).json()) as { error?: string; review?: any };

    const refused = await post("ratify", { specId: sp.id });
    assert.match(refused.error ?? "", /never signed off/);
    assert.equal(refused.review.unwitnessed.length, 1, "which operations, not just that there are some");
    assert.equal(refused.review.framing.state, "unwitnessed");
    assert.ok(refused.review.unwitnessed[0].title, "and what each one is, so a page can link to it");

    // The loop, over the same route, and then it adopts — so the refusal was about the
    // signature rather than about anything else being wrong with the proposal.
    ok(await post("sign_off_framing", { specId: sp.id }) as any);
    ok(await post("sign_off_section", { specId: sp.id, axis: "spec", count: 1 }) as any);
    assert.ok(!(await post("ratify", { specId: sp.id })).error);
    assert.ok(((await ops.listRequirements(root)) as any).requirements.some((r: any) => r.title === "Sweep cutoff"));
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

  /**
   * Releasing a silencer from the queue that reports it as overdue.
   *
   * The unsilencing direction, so it is open to any actor and is on the hub rather than on
   * the rule — the person reading the overdue queue is the one who notices. Nothing drove
   * it: the fixture's own debt is not due until 2027, so the section rendered empty and the
   * whole row — the per-row reason box, the id it posts, and the reason `releaseAcknowledgement`
   * refuses without — had never been exercised at all.
   *
   * The reason box is keyed PER ROW on purpose, so two overdue silencers cannot share a
   * draft; the second acknowledgement below is what makes that assertable rather than
   * incidental.
   */
  test("an overdue silencer is released from the hub, with the reason it needs", async () => {
    const stale = ok(await ops.acknowledgeDebt(root, {
      requirementId: ruleId, rationale: "waiting on the FX service", priority: "high",
      revalidateBy: "2020-01-01T00:00:00Z",
    } as any)) as any;
    const other = ok(await ops.acknowledgeDebt(root, {
      requirementId: ruleId, rationale: "waiting on the ledger rewrite", priority: "low",
      revalidateBy: "2020-06-01T00:00:00Z",
    } as any)) as any;
    assert.equal((await ops.dueForRevalidation(root) as any).acknowledgements.length, 2,
      "two overdue silencers, or the per-row keying below proves nothing");

    const { page, errors } = await open(`/u/${universe}/standard/`);
    await page.waitForSelector(".op-card", { timeout: 10_000 });
    const row = page.locator(".op-card", { hasText: "waiting on the FX service" });
    await row.locator('input[placeholder^="why it no longer applies"]').fill("the FX service shipped");
    await row.locator("button", { hasText: "release" }).click();
    await page.waitForFunction(
      () => !document.querySelector("main")?.textContent?.includes("waiting on the FX service"),
      null, { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();

    const acks = (await ops.listAcknowledgements(root) as any).acknowledgements;
    const gone = acks.find((a: any) => a.id === stale.acknowledgement.id);
    assert.equal(gone.state, "released");
    assert.equal(gone.releasedReason, "the FX service shipped",
      "the reason came off THIS row's box — `releaseAcknowledgement` refuses an empty one");
    assert.equal(acks.find((a: any) => a.id === other.acknowledgement.id).state, "active",
      "the other row's box was not the one that was filled in");

    // Left as it was found: the tests after this one read the same overdue queue.
    ok(await ops.releaseAcknowledgement(root, { id: other.acknowledgement.id, reason: "fixture cleanup" } as any));
  });

  /**
   * The `refile` route reaches the op, and says the one thing worth saying on a team store.
   *
   * `reorganizeRequirement` refuses a requirement carrying an `origin`, and on a store with
   * a sidecar the fold wrote one onto every rule — which is every configuration this
   * subsystem is for. So the dossier hides the form, and this drives the ROUTE, because the
   * hidden form is what left the handler with no caller at all: its body keys
   * (`id`, `section`) had never once been mapped onto the op's arguments.
   *
   * The refusal it gets back is what proves the mapping. `reorganizeRequirement` validates
   * the section and looks the rule up BEFORE it looks at the origin, so a dropped `id` says
   * `no requirement` and a dropped `section` says `a requirement needs a section` — only a
   * request whose keys both arrived reaches the sentence asserted here.
   */
  test("re-filing a shared rule is refused by the handler, and names the act that would work", async () => {
    const a = await (await fetch(`${server.url}/api/standard/attest`)).json() as { notice: string; nonce: string };
    const said = await (await fetch(`${server.url}/api/standard/refile`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        u: universe, id: ruleId, section: "Risk/Currency", attest: `${a.notice} ${a.nonce}`,
      }),
    })).json() as { error?: string };
    assert.match(said.error ?? "", /is the team's/, "the route reached the op with both keys intact");
    assert.match(said.error ?? "", /move_section/, "and it says what to do instead of nothing");
    const rule = ok(await ops.getRequirement(root, { id: ruleId } as any)) as any;
    assert.equal(rule.requirement.section, "Credit/Limits", "and the standard did not move");
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

  /**
   * No form control renders as a white box in a dark app.
   *
   * TWO shipped that way — the branch-findings commit box and the removal-reason input —
   * with one cause: `index.html` gives `button` a global base rule and gave `input` none,
   * so every box was dressed by an enclosing class (`.op-edit input`, `.cmt-new input`, …)
   * and the first box in a container with no rule fell through to the UA default.
   *
   * It probes the COMPUTED style because nothing else can see it: the markup of a broken
   * box and a styled one is identical, and `tsc -p web` and the template lint both read
   * markup. A clipped placeholder is checked in the same pass — that was the other half of
   * the same report, and it is the same kind of invisible-to-source defect.
   *
   * The removal-reason input exists only while an operation's editor is open, which is why
   * every `correct` is clicked first — that box is exactly the one a static read misses.
   */
  test("every form control is dressed, on every page that has one", async () => {
    const paths = [
      `/u/${universe}/standard/`,
      `/u/${universe}/standard/rules/`,
      `/u/${universe}/standard/branch/`,
      `/u/${universe}/standard/conformance/`,
      `/u/${universe}/standard/audit/`,
      `/u/${universe}/standard/spec/${draft}/`,
      `/u/${universe}/standard/r/${ruleId}/`,
    ];
    const bad: string[] = [];
    let probed = 0;
    for (const path of paths) {
      const { page } = await open(path);
      // Always the FIRST one, never a snapshot of them all: opening an editor HIDES that
      // card's own `correct` button, so the set shrinks under an `nth(i)` walk and the
      // second click waits for a locator that can no longer resolve.
      for (let guard = 0; guard < 20; guard++) {
        const b = page.locator(".ft button", { hasText: "correct" }).first();
        if (!(await b.count())) break;
        await b.click();
      }
      const rows: { tag: string; bg: string; lum: number; ph: string; clipped: boolean }[] =
        await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")].map((e) => {
          const c = getComputedStyle(e);
          const rgb = (c.backgroundColor.match(/\d+/g) ?? ["0", "0", "0"]).map(Number);
          return {
            tag: e.tagName.toLowerCase(), bg: c.backgroundColor,
            lum: (rgb[0]! + rgb[1]! + rgb[2]!) / 3,
            ph: (e as HTMLInputElement).placeholder ?? "",
            clipped: e.scrollWidth > e.clientWidth + 1,
          };
        }));
      probed += rows.length;
      for (const r of rows) {
        if (r.lum > 100) bad.push(`${path} <${r.tag}> background ${r.bg} — "${r.ph}"`);
        if (r.clipped) bad.push(`${path} <${r.tag}> placeholder is cut off — "${r.ph}"`);
      }
      await page.close();
    }
    // Without this the whole test passes on zero controls, which is what it would find if
    // the selector or a route ever broke — a green run asserting nothing.
    assert.ok(probed >= 6, `probed only ${probed} controls — this is not reaching the forms`);
    assert.deepEqual(bad, []);
  });

  /**
   * The POST surface does not let a caller name themselves.
   *
   * `revise_operation` was the one act in `serve.ts` that forwarded the request body whole,
   * and `reviseOperation` reaches `resolveActor`, whose first line is
   * `input.principal?.trim() || resolvePrincipal(root)`. So `{"principal":"boss@corp"}`
   * both RECORDED and PUBLISHED a `spec.operation.revised` event under an invented
   * principal with no `via` — forged provenance in an append-only log, on the surface whose
   * entire premise is that a named person signed something. `curl` is the whole threat
   * model this route already has; `mcp.ts` closes the same hole by refusing unknown
   * parameters outright.
   *
   * Driven over the ROUTE with the notice satisfied, because a disabled form is not a guard.
   */
  test("a forged principal on the POST surface is ignored, not recorded", async () => {
    const sp = ok(await ops.draftSpec(root, { title: "Spoof target", ...AGENT })) as any;
    const op = ok(await ops.addOperation(root, {
      specId: sp.id, kind: "add_requirement", rationale: "the sweep has a window",
      reversibility: "reversible", title: "Spoof rule", section: "Settlement/Spoof",
      statement: "The sweep runs at 17:00.", provenance: "treasury", ...AGENT,
    } as any)) as any;

    const a = await (await fetch(`${server.url}/api/standard/attest`)).json();
    const r = await (await fetch(`${server.url}/api/standard/revise_operation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        u: universe, attest: `${a.notice} ${a.nonce}`, operationId: op.id,
        statement: "The sweep runs at 16:00.", reason: "moved earlier",
        principal: "boss@corp", model: "some-model", harness: "some-harness",
      }),
    })).json();
    assert.ok(!r.error, `the revision itself should succeed: ${r.error}`);

    const served = ok(await ops.getSpec(root, { specId: sp.id })) as any;
    const rev = served.operations[0].operation.revisions.at(-1);
    assert.notEqual(rev.by.principal, "boss@corp", "the body must not be able to name the actor");
    assert.equal(rev.by.principal, "izzie@x.com", "it is the repository's git principal, as every other act on this route is");
    assert.equal(rev.by.via, undefined, "and a browser act is a person's — no agent marker either");
  });

  test("the ratify button is dead until the reviewer has signed what they are adopting", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/spec/${draft}/`);
    await page.waitForSelector(".op-card .ft button", { timeout: 10_000 });
    // The page says what is outstanding, and the button that would adopt it is disabled.
    // A disabled button is the courtesy; the refusal is server-side, which the test below
    // this one drives directly.
    assert.match((await page.textContent("main"))!, /left to read/);
    assert.equal(await page.locator(".op-actions button", { hasText: "ratify" }).isDisabled(), true);
    await page.close();
  });

  test("the whole loop from a browser: pull, read what moved, sign off, ratify", async () => {
    const { page, errors } = await open(`/u/${universe}/standard/spec/${draft}/`);
    await page.waitForSelector(".op-edit button", { timeout: 10_000 });
    await page.locator(".op-edit button", { hasText: "pull & show what moved" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("left to read"), null, { timeout: 10_000 },
    );
    // Waits for what only a SUCCESSFUL pull produces. Without this the click is unobserved:
    // the outstanding count comes from the spec read, so it renders whether or not the pull
    // did anything — and the test passed with the route deleted.
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("outstanding as of that read"),
      null, { timeout: 10_000 },
    );
    await page.locator(".op-edit button", { hasText: "sign off title" }).click();
    await page.waitForFunction(
      () => !document.querySelector("main")?.textContent?.includes("not read the title"), null, { timeout: 10_000 },
    );
    await page.locator(".op-edit button", { hasText: "sign off all" }).click();
    await page.waitForFunction(
      () => !!document.querySelector("main")?.textContent?.includes("read all of it"), null, { timeout: 10_000 },
    );
    await page.locator(".op-actions button", { hasText: "ratify" }).click();
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
