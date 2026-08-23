/**
 * The shared-review page, in a real browser.
 *
 * Driven by playwright rather than the puppeteer the older UI suite uses — both
 * are resolved from wherever the machine happens to have them and both SKIP when
 * absent, because the golden rule applies to the test tree: a browser driver is
 * something the machine may have, never something this repo pulls in.
 *
 * What it is really guarding is the wiring. `web/shared.js` is a new module that
 * app.js imports for its side effects, and the ways that goes wrong — a helper
 * that was never exported, a route naming a component defined after routing was
 * enabled, a `.map()` where vdx demands `each()` — all render as a blank page and
 * a console error, and no unit test can see any of them.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolvePlaywright, launchPlaywright, startServer, type Server } from "./harness.js";
import { shareFinding, promoteFinding, corroborateFinding, requestOnFinding, publishLocalDocs } from "../ops-shared.js";

const pw = resolvePlaywright();

describe("shared review UI", { skip: pw ? false : "playwright not resolvable (set CODEMAP_E2E_PLAYWRIGHT)" }, () => {
  let root: string, side: string, server: Server, browser: any, universe: string, anchorId: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "codemap-sui-"));
    side = mkdtempSync(join(tmpdir(), "codemap-sui-side-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.email=izzie@x.com", "-c", "user.name=izzie", ...a], { cwd: root });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "izzie@x.com");
    git("config", "user.name", "izzie");
    mkdirSync(join(root, ".codemap"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "pay.ts"), "export function transfer(cents: number) { return cents; }\n");
    writeFileSync(join(root, ".codemap", "sidecar"), side, "utf8");
    git("add", "-A"); git("commit", "-qm", "seed");

    const { init } = await import("../ops.js");
    await init(root);
    const { readAnchorStore } = await import("../store.js");
    anchorId = (await readAnchorStore(root)).anchors[0]!.id;

    // One finding that needs a person, and one that does not — so the queue filter
    // has something to actually filter.
    const a = await shareFinding(root, 264, {
      targetKind: "anchor", targetId: "a_1", severity: "high", category: "Authorization",
      text: "the by-id branch has no tenant predicate",
      comment: "CreateTicket.cs:1006 queries Aircraft on x.Id without a tenant scope.",
    }) as { id: string };
    await promoteFinding(root, 264, a.id);
    await corroborateFinding(root, 264, a.id, "confirm", "reproduced on staging");
    await shareFinding(root, 264, {
      targetKind: "anchor", targetId: "a_2", severity: "low",
      text: "a nit about naming", comment: "rename this local for clarity",
    });
    // An agent asking a person to close it — the case the queue exists for. Written
    // with the agent env set, so the actor carries `via` and the ratchet applies.
    process.env.CODEMAP_AGENT_MODEL = "claude-opus-5";
    try {
      await requestOnFinding(root, 264, a.id, "resolve", "the guard landed in abc123");
    } finally { delete process.env.CODEMAP_AGENT_MODEL; }

    // A shared note on that anchor, and a doc citing it — so the anchor page and
    // the docs catalogue both have something real to render.
    const { annotate, document: documentNode } = await import("../ops.js");
    await annotate(root, {
      targetKind: "anchor", targetId: anchorId, kind: "question", author: "izzie",
      text: "is the retry idempotent, or does it double-post?",
    });
    await documentNode(root, {
      type: "process", title: "Payments seam",
      summary: "how a payment reaches the ledger",
      body: "transfer() is the only entry point.",
      anchors: [anchorId],
    });
    await publishLocalDocs(root);

    server = await startServer(root);
    browser = await launchPlaywright(pw);
    // Asked for, never assumed: a single-repo universe is keyed by its directory
    // basename, which is a fresh mkdtemp name here.
    universe = (await (await fetch(`${server.url}/api/universes`)).json()).primary;
  });

  after(async () => {
    await browser?.close();
    server?.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(side, { recursive: true, force: true });
  });

  /** A page plus every console error it produced — a blank render is the failure. */
  async function open(path: string) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e: Error) => errors.push(e.message));
    // The vdx router is HASH mode: a path-form deep link silently falls back to home.
    await page.goto(`${server.url}/#${path}`, { waitUntil: "networkidle" });
    return { page, errors };
  }

  test("the shared page renders a team's findings, with no console errors", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow", { timeout: 10_000 });
    const text = await page.textContent("main");
    assert.match(text, /tenant scope/, "the finding's submitter-facing comment is what leads");
    assert.deepEqual(errors, [], "a console error here means the module wiring is broken");
    await page.close();
  });

  test("the queue is the default view, and the toggle widens it", async () => {
    // The page exists to answer "what needs me"; showing everything first buries it.
    const { page } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow");
    assert.equal(await page.locator(".frow").count(), 1, "only the promoted+confirmed one");

    await page.getByRole("button", { name: /showing: needs a person/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".frow").length === 2, null, { timeout: 10_000 });
    assert.equal(await page.locator(".frow").count(), 2, "the nit appears once everything is shown");
    await page.close();
  });

  test("a finding that needs a person says so, and names its independent support", async () => {
    const { page } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".prbadge.needsack");
    const badges = await page.locator(".frow").first().textContent();
    assert.match(badges, /needs ack/);
    assert.match(badges, /promoted/);
    // izzie confirming izzie's own finding is NOT independent, and the page must
    // not claim otherwise — that number is what the queue would be ranked by.
    assert.doesNotMatch(badges, /\d+ independent/, "same principal is not a second opinion");
    await page.close();
  });

  test("expanding a finding shows the evidence and who said what", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".fdetail");
    const detail = await page.textContent(".fdetail");
    assert.match(detail, /tenant predicate/, "the evidence, which is never published");
    assert.match(detail, /reproduced on staging/, "and the rationale behind the verdict");
    assert.match(detail, /not independent/, "labelled honestly");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the peers page names who writes here and what they write under", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/peers/`);
    await page.waitForSelector("main");
    const text = await page.textContent("main");
    assert.match(text, /izzie@x\.com/);
    assert.match(text, /anchor scheme \d+/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a person can reply to a finding from the browser", async () => {
    // The other half of the loop. An agent files and asks; if the only answer
    // available here is to close it silently, the reason is lost and the agent
    // learns nothing.
    const { page, errors } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".composer textarea");

    await page.locator(".composer textarea").fill("checked the caller — it is guarded upstream");
    await page.getByRole("button", { name: /^reply$/ }).click();
    await page.waitForFunction(
      () => !!document.querySelector(".tcomment")?.textContent?.includes("guarded upstream"),
      null, { timeout: 10_000 },
    );
    const detail = await page.textContent(".fdetail");
    assert.match(detail, /guarded upstream/, "the reply is in the thread");
    assert.match(detail, /izzie@x\.com/, "attributed to the person who wrote it");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("an agent's ask is actionable, and says who asked and why", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector(".frow");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".askbox");
    const ask = await page.textContent(".askbox");
    assert.match(ask, /asked to/);
    assert.match(ask, /the guard landed in abc123/, "the rationale is what the human reads to decide");
    // Agreeing performs the act the agent could not.
    await page.getByRole("button", { name: /agree — resolve/ }).click();
    await page.waitForFunction(
      () => !document.querySelector(".askbox"), null, { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a pull request with nothing shared says so rather than rendering blank", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/999/`);
    await page.waitForSelector("main");
    const text = await page.textContent("main");
    assert.match(text, /nothing is waiting on a person|no shared findings/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  // --- shared notes, where they are actually useful -----------------------------

  test("the team's notes appear ON the anchor page, not one navigation away", async () => {
    // The point of sharing a note is that the next person does not pay again to
    // work something out — and they only avoid paying if it is in front of them
    // while they are reading the code.
    const { page, errors } = await open(`/u/${universe}/anchor/${anchorId}/`);
    await page.waitForSelector(".sharednotes");
    const text = await page.textContent(".sharednotes");
    assert.match(text, /double-post/, "the question itself");
    assert.match(text, /izzie@x\.com/, "and who asked it");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a person can answer a shared question from the anchor page", async () => {
    const { page, errors } = await open(`/u/${universe}/anchor/${anchorId}/`);
    await page.waitForSelector(".snote .composer textarea");
    await page.locator(".snote .composer textarea").fill("idempotent — the key is the ticket id");
    await page.getByRole("button", { name: /^answer$/ }).click();
    await page.waitForFunction(
      () => !!document.querySelector(".snote .tcomment")?.textContent?.includes("ticket id"),
      null, { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("an anchor nobody has written about renders no empty heading", async () => {
    // An empty "what the team knows" on every page teaches people to stop looking.
    const { page, errors } = await open(`/u/${universe}/anchor/a_does_not_exist/`);
    await page.waitForSelector("main");
    assert.equal(await page.locator(".sharednotes").count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  });

  // --- shared docs ----------------------------------------------------------------

  test("the docs catalogue resolves each doc against this checkout", async () => {
    const { page, errors } = await open(`/u/${universe}/shared-docs/`);
    await page.waitForSelector(".frow");
    const text = await page.textContent("main");
    assert.match(text, /Payments seam/);
    assert.match(text, /fresh/, "written against this very checkout");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("expanding a doc shows per-citation freshness, and it can be confirmed", async () => {
    const { page, errors } = await open(`/u/${universe}/shared-docs/`);
    await page.waitForSelector(".frow");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".fdetail");
    const detail = await page.textContent(".fdetail");
    assert.match(detail, /matches/, "the citation's live body is one this version accepts");
    assert.match(detail, /accepted hash/);

    // Confirming is idempotent when it already matches — it must not error.
    await page.getByRole("button", { name: /still true here/ }).click();
    await page.waitForFunction(
      () => !!document.querySelector(".empty")?.textContent?.includes("confirmed against"),
      null, { timeout: 10_000 },
    );
    assert.deepEqual(errors, []);
    await page.close();
  });

  // --- the sync button, end to end -------------------------------------------------

  test("sync reports honestly when there is no remote to reach", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/264/`);
    await page.waitForSelector("button");
    await page.getByRole("button", { name: /^sync$/ }).click();
    await page.waitForFunction(
      () => !!document.querySelector(".empty")?.textContent?.includes("received"),
      null, { timeout: 15_000 },
    );
    const note = await page.textContent(".empty");
    assert.match(note, /received \d+ event/);
    assert.deepEqual(errors, []);
    await page.close();
  });

  // --- contested: the loudest thing on the page, so it had better be right -------

  test("a contested field shows both values and refuses to pick", async () => {
    // Built by hand rather than through `revise`, because "concurrent" has a precise
    // meaning here — neither writer's `after` names the other's event — and the
    // whole detector turns on it. Writing the events directly is the only way to be
    // sure the fixture is testing that rather than two sequential edits.
    const { appendEvents, mintId } = await import("../eventlog.js");
    const { findingScope } = await import("../shared-findings.js");
    // NOT the workspace universe id: `universeKey` lowercases, and a mkdtemp name
    // contains uppercase, so the two namespaces differ. The sidecar scope is
    // always the former.
    const { universeKey } = await import("../sidecar-config.js");
    const uKey = universeKey(root);
    const izzie = { principal: "izzie@x.com" };
    const dana = { principal: "dana@x.com" };
    const scope = findingScope(`${uKey}/pr-900`);

    const created = { id: mintId(), kind: "finding.created", subject: "f_contest", actor: izzie, at: "t",
      data: { targetKind: "anchor", targetId: anchorId, text: "evidence", comment: "the ask", severity: "medium" } };
    await appendEvents(side, scope, "w_izzie_clone_a", [created]);
    // Both name `created` as what they had seen — and NOT each other.
    await appendEvents(side, scope, "w_izzie_clone_a", [{ id: mintId(), kind: "finding.revised", subject: "f_contest",
      actor: izzie, at: "t", after: created.id, data: { now: { severity: "critical" } } }]);
    await appendEvents(side, scope, "w_dana_clone_a", [{ id: mintId(), kind: "finding.revised", subject: "f_contest",
      actor: dana, at: "t", after: created.id, data: { now: { severity: "low" } } }]);

    const { page, errors } = await open(`/u/${universe}/shared/900/`);
    await page.waitForSelector(".prbadge.contested");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".contest");
    const text = await page.textContent(".contest");
    assert.match(text, /severity/);
    assert.match(text, /critical/, "izzie's value survives");
    assert.match(text, /low/, "and so does dana's — nothing is arbitrated");
    assert.match(text, /without seeing each other/, "and it says why this is a contest");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("a person settles a contest by choosing a value, and it stays settled", async () => {
    const { page, errors } = await open(`/u/${universe}/shared/900/`);
    await page.waitForSelector(".prbadge.contested");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".contest");
    await page.getByRole("button", { name: /keep izzie@x\.com's/ }).click();
    // The fold replays history on every read, so "settled" has to survive a reload —
    // that is the bug this would have shipped with.
    await page.waitForFunction(() => !document.querySelector(".prbadge.contested"), null, { timeout: 10_000 });
    await page.close();

    const again = await open(`/u/${universe}/shared/900/`);
    await again.page.waitForSelector("main");
    assert.equal(await again.page.locator(".prbadge.contested").count(), 0, "still settled after a reload");
    assert.deepEqual(again.errors, []);
    await again.page.close();
    assert.deepEqual(errors, []);
  });

  // --- relocation: the residue, in the browser ------------------------------------

  test("a finding whose target is on another branch says so, and asks for nothing", async () => {
    // The distinction the whole classification exists for. `offTree` must render as
    // information, never as an action item, or the queue fills with other people's
    // branches.
    const { appendEvents, mintId } = await import("../eventlog.js");
    const { findingScope } = await import("../shared-findings.js");
    const { universeKey } = await import("../sidecar-config.js");
    const { writeSnapshot } = await import("../store.js");
    const { readAnchorStore } = await import("../store.js");
    const izzie = { principal: "izzie@x.com" };
    const uKey = universeKey(root);

    // A symbol that exists only in a cached snapshot — i.e. on some other branch.
    const live = (await readAnchorStore(root)).anchors[0]!;
    await writeSnapshot(root, "cafebabe", "feature/elsewhere", [{ ...live, id: "a_only_on_branch" }], "2026-08-22T00:00:00Z");

    const scope = findingScope(`${uKey}/pr-901`);
    await appendEvents(side, scope, "w_izzie_clone_a", [{
      id: mintId(), kind: "finding.created", subject: "f_offtree", actor: izzie, at: "t",
      data: { targetKind: "anchor", targetId: "a_only_on_branch", text: "evidence", comment: "about a branch symbol" },
    }]);

    const { page, errors } = await open(`/u/${universe}/shared/901/?queue=0`);
    await page.waitForSelector("main");
    // It is not in the queue, because nobody has to do anything about it.
    await page.getByRole("button", { name: /showing: needs a person/ }).click();
    await page.waitForSelector(".frow");
    const text = await page.textContent(".frow");
    assert.match(text, /elsewhere/, "labelled as being on another branch");
    assert.doesNotMatch(text, /target (retained|lost)/, "and NOT as something to fix");
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("an agent's relocation proposal is visible and a person applies it", async () => {
    const { appendEvents, mintId } = await import("../eventlog.js");
    const { findingScope } = await import("../shared-findings.js");
    const { universeKey } = await import("../sidecar-config.js");
    const izzie = { principal: "izzie@x.com" };
    const opus = { principal: "izzie@x.com", via: { kind: "agent" as const, model: "claude-opus-5" } };
    const uKey = universeKey(root);
    const scope = findingScope(`${uKey}/pr-902`);

    const created = { id: mintId(), kind: "finding.created", subject: "f_moved", actor: izzie, at: "t",
      data: { targetKind: "anchor", targetId: "a_vanished", text: "evidence", comment: "about a renamed symbol" } };
    await appendEvents(side, scope, "w_izzie_clone_a", [created]);
    await appendEvents(side, scope, "w_izzie_clone_a", [{
      id: mintId(), kind: "finding.relocation", subject: "f_moved", actor: opus, at: "t", after: created.id,
      data: { kind: "moved", to: anchorId, rationale: "renamed in abc123; same body, new name" },
    }]);

    const { page, errors } = await open(`/u/${universe}/shared/902/`);
    await page.waitForSelector(".prbadge.ask");
    await page.locator(".frow .row").first().click();
    await page.waitForSelector(".askbox");
    const box = await page.textContent(".askbox");
    assert.match(box, /moved to/, "what it proposes");
    assert.match(box, /abc123/, "and the evidence a person judges it on");

    await page.getByRole("button", { name: /^apply$/ }).click();
    await page.waitForFunction(() => !document.querySelector(".prbadge.ask"), null, { timeout: 10_000 });
    await page.close();

    // Applied means applied — the target really moved, and survives a reload.
    const after = await (await fetch(`${server.url}/api/shared?u=${universe}&pr=902`)).json() as any;
    assert.equal(after.findings[0].target.id, anchorId, "the finding now points at the new symbol");
    assert.deepEqual(errors, []);
  });

  // --- a scope that may not be answered from --------------------------------------

  test("a forked scope says so above the rows, and still shows them", async () => {
    // §7 lets a blocked scope render its rows explicitly non-authoritative, which
    // is only worth anything if the page actually says so — and the failure mode
    // is a banner nobody notices, so this asserts on the rows too.
    const { appendEvents, mintId } = await import("../eventlog.js");
    const { findingScope } = await import("../shared-findings.js");
    const { universeKey } = await import("../sidecar-config.js");
    const scope = findingScope(`${universeKey(root)}/pr-903`);
    const izzie = { principal: "izzie@x.com" };
    const base = { kind: "finding.created", subject: "f_forked", actor: izzie, at: "t",
      data: { targetKind: "anchor", targetId: anchorId, text: "evidence", comment: "the ask" } };
    // Two events of ONE writer both opening the chain: a copied clone id.
    await appendEvents(side, scope, "w_copied", [{ ...base, id: mintId(), writerPrev: "GENESIS", writer: "w_copied" }]);
    await appendEvents(side, scope, "w_copied", [{
      id: mintId(), kind: "finding.commented", subject: "f_forked", actor: izzie, at: "t",
      writer: "w_copied", writerPrev: "GENESIS", data: { body: "from the other clone" },
    }]);

    const { page, errors } = await open(`/u/${universe}/shared/903/`);
    await page.waitForSelector(".blocked");
    const banner = await page.textContent(".blocked");
    assert.match(banner, /not authoritative/);
    assert.match(banner, /forked writer chain/, "and what to do about it");
    // The page opens on "needs a person" and this finding needs nobody, so switch
    // to everything: the claim being tested is that a blocked scope still RENDERS.
    await page.getByRole("button", { name: /showing: needs a person/ }).click();
    await page.waitForSelector(".frow");
    assert.equal(await page.locator(".frow").count(), 1, "the rows are shown, not hidden");
    assert.ok((await page.textContent(".blocked")).includes("not authoritative"),
      "and the banner is still there beside them");
    assert.deepEqual(errors, []);
    await page.close();
  });
});
