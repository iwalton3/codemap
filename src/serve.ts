/**
 * codemap web server — zero dependencies (node:http).
 *
 * Serves the vendored web UI plus a small JSON API that mirrors the ops/multi
 * layer (the same source of truth the MCP server exposes). Read-only: the web
 * UI browses; documenting happens through the agent/MCP.
 *
 * Launch: `node dist/serve.js <workspace> [port]`
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import * as ops from "./ops.js";
import * as shared from "./ops-shared.js";
import { revertedMarks as opsRevertedMarks } from "./reviews.js";
import * as multi from "./multi.js";
import { loadWorkspace, type Workspace } from "./workspace.js";
import { METHODOLOGY } from "./guide.js";
import { markReviewed, unmarkReviewed } from "./reviews.js";
import { withLock } from "./lock.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

const target = process.argv[2] ?? process.env.CODEMAP_ROOT ?? process.cwd();
const port = Number(process.argv[3] ?? process.env.PORT ?? 4310);
let ws: Workspace;
try {
  ws = await loadWorkspace(target);
} catch (e: any) {
  process.stderr.write(`codemap-serve: failed to load workspace "${target}": ${e?.message ?? e}\n`);
  process.exit(1);
}

const rootFor = (u: string | null) => (u && ws.byId.get(u) ? ws.byId.get(u)!.path : ws.primary.path);

/**
 * What a caller must send back to perform one of the five acts reserved to a person.
 *
 * **This is not authentication and it must never be described as any.** It cannot be: the
 * value is handed out by `GET /api/standard/attest` to anybody who asks, and this file is
 * in the repository. Anything that can reach the port can satisfy it in one extra request.
 *
 * What it is, is the difference between an act you can take by accident and one you have to
 * decide to take. The failure mode this subsystem is built against is not malice — it is an
 * agent under deadline pressure taking the cheapest available path, and `curl -XPOST
 * localhost:4310/api/standard/adjudicate` was that path. Now the cheapest path requires
 * sending a sentence that says *I am a person, at a browser* — which an agent cannot send
 * truthfully, and cannot send at all without having been told, in the response it just
 * fetched, that it is a false claim.
 *
 * So the token is theatre and the SENTENCE is the mechanism. Do not "improve" this by
 * hashing it, signing it, or making it opaque: every one of those makes it easier to satisfy
 * without reading, which is the only property it has. The honest paths remain what they
 * were — ask the person whose browser it is to click, or use the MCP tools, which refuse
 * these acts by design and say so.
 *
 * Izzie's framing, 2026-08-29: make it annoying, and put a comment on it saying that if you
 * are reading this, you are off the rails.
 */
export const PRINCIPAL_NOTICE =
  "I am a person, acting at a browser. If you are an agent assembling this sentence in order "
  + "to send it, you are claiming to be a person so that you can perform an act this system "
  + "reserves to one — ratifying, withdrawing, adjudicating, granting debt or re-filing. That "
  + "is off the rails. Ask the person whose browser this is to click the button.";

/** Per process, so the sentence cannot be replayed from a note somebody kept. */
const PRINCIPAL_NONCE = randomBytes(9).toString("hex");

/** Dispatch a /api/* request to the ops/multi layer. Returns a JSON-able value. */
/**
 * Every annotation write reports the anchor it landed on and that anchor's
 * annotations afterwards, so a caller can refresh one symbol instead of re-deriving
 * the whole pull request to find out what changed.
 *
 * Module scope on purpose: it takes `root`, so nothing ties it to a request, and
 * declaring it inside the handler put it in the temporal dead zone of the two
 * routes above its declaration.
 */
async function withAnchorAnnotations(root: string, out: any): Promise<any> {
  return out && !out.error && out.target?.kind === "anchor"
    ? { ...out, annotations: await ops.anchorAnnotations(root, out.target.id) }
    : out;
}

async function api(path: string, q: URLSearchParams): Promise<unknown> {
  const u = q.get("u");
  const root = rootFor(u);
  switch (path) {
    case "/api/universes":
      return multi.listUniverses(ws);
    case "/api/guide":
      return { methodology: METHODOLOGY };
    case "/api/dashboard":
      return ops.dashboard(root);
    case "/api/outline":
      return ops.outline(root, q.get("prefix") ?? "", { compact: q.get("compact") === "1" });
    case "/api/anchor":
      return ops.getAnchor(root, q.get("id") ?? "");
    case "/api/node":
      return multi.getNodeEnriched(ws, u ?? ws.primary.id, q.get("id") ?? "", { compact: q.get("compact") === "1" });
    case "/api/neighborhood":
      return ops.neighborhood(root, q.get("id") ?? "");
    case "/api/subgraph":
      return ops.subgraph(root, (q.get("ids") ?? "").split(",").filter(Boolean), q.get("expand") || undefined);
    case "/api/nodes":
      return ops.nodeCatalog(root);
    case "/api/node_versions":
      return ops.nodeVersions(root, q.get("id") ?? "");
    case "/api/node_review":
      return ops.nodeReview(root, q.get("id") ?? "");
    case "/api/file":
      return ops.fileSource(root, q.get("path") ?? "");
    case "/api/matrix":
      return ops.eventMatrix(root);
    case "/api/pipeline":
      return ops.pipelineGraph(root, { domain: q.get("domain") || undefined });
    case "/api/statemap":
      return ops.stateMap(root, { aggregate: q.get("aggregate") || undefined });
    case "/api/flows":
      return ops.flows(root);
    case "/api/flow":
      return ops.flow(root, q.get("id") ?? "", { brief: q.get("brief") === "1" });
    case "/api/search":
      return q.get("all") === "1"
        ? multi.searchAll(ws, q.get("q") ?? "")
        : ops.search(root, q.get("q") ?? "");
    case "/api/gaps":
      return ops.findGaps(root, { pathPrefix: q.get("prefix") ?? undefined, kind: q.get("kind") ?? undefined });
    case "/api/context":
      return ops.context(root, (q.get("refs") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    case "/api/lint":
      return ops.lintSummaries(root);
    case "/api/bugs":
      return ops.listBugs(root, {
        state: (q.get("state") as any) ?? undefined,
        open: q.get("open") === "1",
        queue: q.get("queue") === "1",
        asked: q.get("asked") === "1",
        sort: (q.get("sort") as any) ?? undefined,
      });
    case "/api/bug":
      return ops.bugDetail(root, q.get("id") ?? "");
    case "/api/queue":
      // Full form here, unlike MCP. `brief` exists because a 100k-character response
      // blew an agent's token limit; a browser has no such ceiling, and the queue
      // view renders the file, symbol and source that brief drops.
      return ops.reviewQueue(root, {
        includeAnswered: q.get("answered") === "1", brief: q.get("brief") === "1",
        // `all=1` drops the assignment requirement — the "what is on this map" view,
        // as opposed to "what have I been asked to do".
        assignedOnly: q.get("all") !== "1",
        includeResolved: q.get("resolved") === "1",
        pr: q.get("pr") ?? undefined, tier: q.get("tier") ?? undefined,
      });
    case "/api/orphans":
      // `locate` indexes a commit per stranded record's address, so it is opt-in
      // here too — a page load must not spend seconds per orphan.
      return ops.orphanedWork(root, { locate: q.get("locate") === "1" });
    // Cheap and read-only on purpose — every page asks it on load, and a reviewer
    // switching pull requests must be TOLD rather than silently answered from the
    // branch they left. The re-baseline itself is POST /api/rebaseline.
    case "/api/index-state":
      return ops.indexFreshness(root);
    case "/api/questions":
      return ops.listQuestions(root, { includeResolved: q.get("all") === "1" });
    // Writes: `checkStale` re-indexes on a branch change, applies the index update
    // and refreshes analyzer graphs — all whole-blob read-modify-write. MCP has
    // always treated `check_stale` as mutating; the HTTP route was missed.
    case "/api/stale":
      return withLock(root, () => ops.checkStale(root));
    case "/api/snapshots":
      return ops.snapshots(root);
    case "/api/diff":
      return ops.diff(root, q.get("base") ?? "", q.get("head") || undefined);
    case "/api/diff/code":
      return ops.diffCode(root, q.get("base") ?? "", q.get("head") || undefined, q.get("id") ?? "", q.get("file") ?? "");
    case "/api/diff/doc":
      return ops.docDiff(root, q.get("base") ?? "", q.get("head") || undefined, q.get("id") ?? "");
    // These four are GETs that WRITE: each runs `prTriage`, which caches two commit
    // snapshots through `ensureSnapshot`, and with fetch on also fetches into .git.
    // They stay GETs — a snapshot is keyed by sha and immutable, and a fetch is
    // idempotent, so a browser retrying one changes nothing — but they must hold the
    // write lock like every other writer, or a snapshot write interleaves with a
    // locked one. The lock is taken HERE and never inside `ensureSnapshot`:
    // `withLock` is not re-entrant, and the POST routes already hold it over ops
    // that reach the same code.
    //
    // `fetch` defaults ON, matching `prTriage` and the CLI. Reading the param as a
    // bare === "1" made its ABSENCE an explicit false, so the web UI refused any PR
    // whose head was not already local — with an error blaming the universe — while
    // `codemap pr` on the same PR just worked. Only `fetch=0` disables it now.
    case "/api/pr":
      return withLock(root, () => ops.pr(root, q.get("pr") ?? "", { fetch: q.get("fetch") !== "0" }));
    case "/api/pr/story":
      return withLock(root, () => ops.prStoryFor(root, q.get("pr") ?? "", { fetch: q.get("fetch") !== "0" }));
    case "/api/pr/findings":
      return withLock(root, () => ops.prOffStoryFindings(root, q.get("pr") ?? "", { fetch: q.get("fetch") !== "0" }));
    case "/api/pr/promote_plan":
      return withLock(root, () => ops.prPromotePlan(root, q.get("pr") ?? "", q.get("chapter") ?? ""));
    // What WOULD go to GitHub. Nothing leaves the machine on this route — see the
    // POST below, which is the only thing that publishes.
    case "/api/pr/push_plan":
      return withLock(root, () => ops.prPushPlan(root, q.get("pr") ?? "", {
        electedOnly: q.get("all") !== "1",
        minSeverity: (q.get("min_severity") as any) || undefined,
        // The summary and verdict come in on the PLAN, not on the publish, so what
        // the human reads in the preview is byte-for-byte what goes out — the
        // fingerprint covers both.
        summary: q.get("summary") || undefined,
        event: (q.get("event") as any) || undefined,
      }));
    // Shared review. Read-only; nothing here touches the sidecar's remote — that
    // is POST /api/shared/sync, so a page load never surprises anyone with network.
    case "/api/shared":
      return shared.sharedFindings(root, q.get("pr") ?? "", {
        queue: q.get("queue") === "1", tier: (q.get("tier") ?? undefined) as never,
      });
    case "/api/shared/peers":
      return shared.sharedStatus(root);
    case "/api/shared/hub":
      return shared.sharedHub(root);
    case "/api/findings/backlog":
      return shared.findingBacklog(root, { asOf: q.get("asOf") || undefined });
    case "/api/shared/triage":
      return shared.sharedTriage(root, (q.get("kind") as "node" | "anchor") || undefined, q.get("target") || undefined);
    case "/api/shared/contested":
      return shared.contestedTriage(root);
    case "/api/shared/graph":
      return shared.sharedGraph(root);
    case "/api/shared/walkthroughs":
      return shared.sharedWalkthroughs(root, q.get("pr") ?? "", q.get("head") || undefined);
    case "/api/shared/notes":
      return shared.sharedNotes(root, q.get("target") ?? "");
    case "/api/shared/docs":
      return shared.sharedDocs(root, { nodeId: q.get("node") || undefined });
    case "/api/shared/replies":
      return shared.inboundReplies(root, q.get("pr") ?? "");
    case "/api/pr/code":
      return withLock(root, () => ops.prCode(root, q.get("pr") ?? "", q.get("id") ?? ""));
    case "/api/prs":
      return ops.prsFor(root);
    case "/api/reverted":
      return { reverted: await opsRevertedMarks(root) };
    case "/api/tripwires":
      return ops.tripwires(root);
    case "/api/triage_drift":
      return ops.triageDriftList(root);
    // --- the standard ---------------------------------------------------------
    // Agent-only until now: `mcp.ts` has carried the whole surface since it was built
    // and `serve.ts` none of it, which left ratification — the one act an agent
    // structurally cannot perform, because the latch is a ratchet — with nowhere to
    // happen. These are the reads behind that.
    case "/api/standard":
      return ops.standardStatus(root);
    case "/api/standard/spec":
      return ops.getSpec(root, { specId: q.get("id") ?? "" });
    case "/api/standard/sections":
      return ops.requirementSections(root);
    case "/api/standard/requirements":
      return ops.listRequirements(root, {
        ...(q.get("section") ? { section: q.get("section")! } : {}),
        ...(q.get("status") ? { status: q.get("status") as "ratified" | "retired" } : {}),
      });
    case "/api/standard/requirement":
      return ops.getRequirement(root, { id: q.get("id") ?? "" });
    case "/api/standard/conformance":
      return ops.conformance(root, q.get("about") === "branch" ? { about: "branch" } : {});
    // The rows behind the six counts `standardStatus` reports, and the five reads that say
    // where to look next. Both were MCP-only, which left the hub showing numbers a person
    // could not open and no way at all to choose what to audit from a browser.
    case "/api/standard/queues":
      return ops.standardQueues(root);
    case "/api/standard/health":
      return ops.standardHealth(root);
    // The notice a principal act has to carry back. See `PRINCIPAL_NOTICE`.
    case "/api/standard/attest":
      return { notice: PRINCIPAL_NOTICE, nonce: PRINCIPAL_NONCE };
    // Branch findings — this machine's and the team's. `commit` is the reviewer's question.
    case "/api/standard/provisional":
      return ops.provisionalAudits(root, q.get("commit") ? { commit: q.get("commit")! } : {});
    case "/api/changed_since":
      return ops.changedSince(root, {
        targetKind: (q.get("targetKind") as "node" | "anchor") ?? "node",
        targetId: q.get("targetId") ?? "",
        level: (q.get("level") as "logical" | "code") ?? "code",
        attestation: q.get("attestation") === "viewed" ? "viewed" : "signed",
        // Absent, "now" is the working tree — which for a PR sign-off is some other
        // branch, and every mark then reads as drifted.
        ref: q.get("ref") || undefined,
      });
    default:
      return null;
  }
}

async function serveStatic(urlPath: string): Promise<{ body: Buffer; type: string } | null> {
  // Map URL path into WEB_DIR, blocking traversal.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_DIR, rel === "/" || rel === "" ? "index.html" : rel);
  if (!file.startsWith(WEB_DIR)) return null;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    return { body, type: MIME[extname(file)] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    // The one write path from the UI: mark/unmark a review (under the write lock).
    // Ratifying and withdrawing are PRINCIPAL acts, and this is a person at a browser
    // — so no `agent`/`model` is threaded through and `requireActor` resolves the git
    // identity, exactly as it does for a human MCP session.
    //
    // **This is a statement of intent, not a security boundary, and it must not be mistaken
    // for one.** Anything that can reach 127.0.0.1 can `curl` these acts and be recorded as
    // the repository's git principal — including an agent with a shell, which is the actor
    // the MCP latch exists to stop. The latch is not thereby pointless: an agent that could
    // do this could equally write events into the sidecar by hand, so no gate here would
    // close it either. What the latch buys is that the door is MARKED, and the tool
    // descriptions say the closure is deliberate. Hardening this route would cost real
    // work and move nothing, because the threat model is an agent that respects a stated
    // intent — attribution without prevention, which is the same trade principal identity
    // makes everywhere else in this subsystem.
    if (req.method === "POST" && url.pathname.startsWith("/api/standard/")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const act = url.pathname.slice("/api/standard/".length);
      if (body.attest !== `${PRINCIPAL_NOTICE} ${PRINCIPAL_NONCE}`) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error:
            `\`${act}\` is one of the acts this system reserves to a person, so it needs the `
            + `notice from GET /api/standard/attest sent back as \`attest\`. Read it before you `
            + `send it: it is a claim about who you are, and it is the whole of the control.`,
        }));
        return;
      }
      const out = await withLock<unknown>(root, async () => {
        if (act === "ratify") return ops.ratifySpec(root, { specId: body.specId });
        if (act === "withdraw") return ops.withdrawSpec(root, { specId: body.specId, reason: body.reason ?? "" });
        // The other three PRINCIPAL acts. Same argument that put `ratify` here and no
        // weaker: an agent may establish a disagreement and may not decide it, may propose
        // a re-filing and may not perform one, and may never grant debt — so without these
        // the browser is missing the half only a person can do, which is the whole reason
        // this surface exists. `adjudicate` is the one that matters most: it is counted on
        // the hub as a queue and it is the human act the loop is built around.
        if (act === "adjudicate") {
          return ops.adjudicate(root, {
            problemId: body.problemId, disposition: body.disposition, reason: body.reason ?? "",
          });
        }
        if (act === "acknowledge_debt") {
          return ops.acknowledgeDebt(root, {
            requirementId: body.requirementId, rationale: body.rationale ?? "",
            priority: body.priority, revalidateBy: body.revalidateBy,
          });
        }
        if (act === "refile") {
          return ops.reorganizeRequirement(root, { id: body.id, title: body.title, section: body.section });
        }
        // Correcting a DRAFT. Open to any actor over MCP, and open here too — a person
        // refining a proposal before adopting it is the commonest case, and the agent that
        // drafted it is frequently not around. Every refusal is in `requirements.ts` and in
        // `foldStandard`; nothing about the act is decided by this route, which is why the
        // browser can be handed the same three verbs without a second set of rules. They
        // still take the attestation the whole POST surface takes.
        if (act === "revise_spec") {
          return ops.reviseSpec(root, {
            specId: body.specId, title: body.title, narrative: body.narrative, reason: body.reason,
          });
        }
        // An EXPLICIT field list, like every sibling act above — and here it is load-bearing
        // rather than tidy. `reviseOperation` reaches `resolveActor`, whose first line is
        // `input.principal?.trim() || resolvePrincipal(root)`, so forwarding `body` whole let
        // any caller post `{"principal":"someone.else@corp"}` and both RECORD and PUBLISH a
        // `spec.operation.revised` event under an invented principal with no `via`. `curl` is
        // the whole threat model this route already has (`PRINCIPAL_NOTICE`), and `mcp.ts`
        // closes the same hole on its side by refusing unknown parameters outright.
        if (act === "revise_operation") {
          return ops.reviseOperation(root, {
            operationId: body.operationId, reason: body.reason,
            rationale: body.rationale, reversibility: body.reversibility,
            requirementId: body.requirementId, title: body.title, section: body.section,
            statement: body.statement, provenance: body.provenance, evidence: body.evidence,
            criterion: body.criterion, falsifier: body.falsifier, evidenceKind: body.evidenceKind,
            targetOperationId: body.targetOperationId,
            fromSection: body.fromSection, toSection: body.toSection,
          });
        }
        // The review loop. `review` pulls and shows what moved since this person last
        // looked; the three sign-offs write their witness; `ratify` refuses without them.
        // On the web the actor is the repository's git principal with no agent marker,
        // which is what makes a browser sign-off a person's — the same property that lets
        // this surface ratify at all, and it carries the same notice.
        if (act === "review") return ops.reviewProposal(root, { specId: body.specId });
        if (act === "sign_off_operation") return ops.signOffOperation(root, { operationId: body.operationId });
        if (act === "sign_off_framing") return ops.signOffFraming(root, { specId: body.specId });
        if (act === "sign_off_section") {
          return ops.signOffSection(root, {
            specId: body.specId, axis: body.axis, section: body.section, count: body.count,
          });
        }
        if (act === "remove_operation") {
          return ops.removeOperation(root, { operationId: body.operationId, reason: body.reason ?? "" });
        }
        // Open to any actor, and here because the person reading the queue is the one who
        // notices. Releasing is the UNSILENCING direction — its failure mode is noise —
        // which is why it is not gated the way granting is.
        if (act === "release") {
          return ops.releaseAcknowledgement(root, { id: body.id, reason: body.reason ?? "" });
        }
        // Also open to any actor. It is on the web because the queue it comes off is.
        if (act === "promote_audit") return ops.promoteProvisionalAudit(root, { auditId: body.auditId });
        // One verb, record-dispatched — the same `comment` an agent calls over MCP, so a
        // person and an agent write into one thread rather than two parallel ones.
        if (act === "comment") return ops.commentOn(root, { id: body.id, body: body.body });
        if (act === "answer") {
          const shared = await import("./ops-shared.js");
          return shared.answerSharedNote(root, body.targetId, body.id, body.body);
        }
        return { error: `no such action "${act}"` };
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/review") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      // A web review is always a human act; `attestation` picks which human mark —
      // "viewed" (exposure) or "signed" (sign-off). Absent → "signed" (legacy behavior).
      const attestation = body.attestation === "viewed" ? "viewed" : "signed";
      const out = await withLock<unknown>(root, async () => {
        const r = body.unmark
          ? await unmarkReviewed(root, { targetKind: body.targetKind, targetId: body.targetId, level: body.level, attestation, actor: "human" })
          // `ref` (the PR head) makes the witness cover the code actually read.
          : await markReviewed(root, { targetKind: body.targetKind, targetId: body.targetId, level: body.level, reviewer: body.reviewer, actor: "human", attestation, ref: body.ref });
        // Hand back the resulting mark so a caller can update that one symbol in
        // place. The walkthrough re-fetched the WHOLE story to learn this, which on
        // a large pull request is seconds of work to answer a question about one
        // anchor — and the answer has real nuance (replayed, sitting on a revert),
        // so the client must not guess it.
        //
        // Never alongside an ERROR, though, and that spread used to be unconditional: a
        // refusal came back as `{ error, mark }`, so a caller that branched on `mark` — the
        // field this arm exists to provide — read a refusal as a success and rendered the
        // unchanged mark as the new one. An error reply carries the error and nothing that
        // looks like it worked.
        if (r && typeof r === "object" && "error" in r) return r;
        if (body.targetKind === "anchor" && typeof body.targetId === "string") {
          return { ...(r as object), mark: await ops.anchorMark(root, body.targetId, { ref: body.ref }) };
        }
        return r;
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Stakes triage from the UI (a human source → confirmed tier; can raise or lower).
    /**
     * Every shared-review write, and the sync.
     *
     * One handler because they share a shape and a guard: each is a call into
     * `ops-shared`, which resolves the sidecar and the actor and refuses when either is
     * missing.
     *
     * **Most take this universe's lock, and the exceptions are listed rather than
     * assumed.** This comment used to say none of them touched `.codemap/` — true when
     * it was written and false the moment `sharedSync` began reconciling the contest
     * queue (which writes annotations) and `publish_*` began rewriting the local
     * partition. Both are whole-blob read-modify-writes, so a concurrent locked
     * `/api/annotate` and an unlocked sync would each write back a blob missing the
     * other's change.
     *
     * The sidecar's own concurrency is a separate arbiter (git's non-fast-forward
     * rejection, plus `withSidecarLock`); this lock is only about `.codemap/`.
     */
    if (req.method === "POST" && url.pathname.startsWith("/api/shared/")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const pr = String(body.pr ?? "");
      const action = url.pathname.slice("/api/shared/".length);
      // Which of these write `.codemap/`. Named explicitly: a new action that mutates
      // and is not listed here races the rest of the server silently.
      const TOUCHES_LOCAL = new Set(["sync", "pull", "publish_docs", "publish_notes", "publish_triage", "publish_graph", "heal"]);
      const run = <T>(fn: () => Promise<T>): Promise<T> =>
        TOUCHES_LOCAL.has(action) ? withLock(root, fn) : fn();
      let out: unknown;
      switch (action) {
        case "sync": out = await run(() => shared.sharedSync(root)); break;
        // Receive without sending. The top bar offers this on every page, so it must
        // never publish: a button that reached other people from wherever you happened
        // to be standing is not one anybody can leave in the chrome.
        case "pull": out = await run(() => shared.sharedPull(root)); break;
        // Publishing this store's existing state, and repairing a fork. These were
        // terminal-only, which made JOINING a team and RECOVERING from one the two
        // things a browser user could not do.
        case "publish_docs": out = await run(() => shared.publishLocalDocs(root, { dryRun: body.dryRun === true })); break;
        case "publish_notes": out = await run(() => shared.publishLocalNotes(root, { dryRun: body.dryRun === true })); break;
        case "publish_triage": out = await run(() => shared.publishLocalTriage(root, { dryRun: body.dryRun === true })); break;
        case "publish_graph": out = await run(() => shared.publishLocalGraph(root, { dryRun: body.dryRun === true })); break;
        // A person's act, and there is deliberately no MCP tool for it: an agent
        // repairing a fork it may itself have caused is the case the person-gate is
        // for. `sharedHeal` IS the complete operation — union, rotate, acknowledge,
        // sync — and it must be called once, not wrapped: the sidecar lock is not
        // reentrant, so a wrapper that took it around the four steps would deadlock.
        case "heal": out = await run(() => shared.sharedHeal(root)); break;
        // Dispatched on the RECORD, not sent to the log. This page lists the canonical
        // table — this store's own findings beside the team's, which is the point of one
        // table — so a button that assumed the fold owned every row it was offered on
        // answered `no finding finding_… on pr <scope>`: a real id, a real row, and an
        // error naming the one place it could not be. On PR 264 that was every row.
        case "corroborate": out = await ops.corroborateOn(root, { id: body.id, verdict: body.verdict, rationale: body.rationale ?? "" }); break;
        case "comment": out = await ops.commentOn(root, { id: body.id, body: body.body ?? "", inReplyTo: body.inReplyTo }); break;
        case "promote": out = await ops.promoteOn(root, body.id); break;
        case "request": out = await ops.requestHuman(root, { id: body.id, action: body.ask, rationale: body.rationale ?? "" }); break;
        case "close": out = await ops.setFindingState(root, { id: body.id, state: body.state, reason: body.reason }); break;
        // Saying NO to an ask, which cleared nothing before — the badge and the queue
        // entry stood until somebody did the thing that had been asked for.
        case "decline": out = await shared.declineFindingAsk(root, pr, body.id, String(body.reason ?? "")); break;
        case "revise": out = await ops.reviseOn(root, { id: body.id, ...(body.now ?? {}) }); break;
        case "settle": out = await shared.settleContest(root, pr, body.id, body.field, body.value); break;
        case "upstream": out = await shared.upstreamFinding(root, pr, body.id, { system: body.system, key: body.key, url: body.url }); break;
        case "to_bug": out = await shared.findingToBug(root, pr, body.id, body.bug); break;
        // Where a finding landed on the pull request. `inboundReplies` reads
        // nothing else, so without this the replies view is permanently empty.
        case "published": out = await shared.recordPublished(root, pr, body.id, { key: body.key, url: body.url }); break;
        // Notes and docs are not pull-request scoped, so they take a target/node
        // rather than `pr`. Same handler because the guard is the same one.
        case "note_answer": out = await shared.answerSharedNote(root, String(body.target ?? ""), body.id, body.body ?? ""); break;
        case "note_resolve": out = await shared.resolveSharedNote(root, String(body.target ?? ""), body.id, body.resolved !== false, body.reason); break;
        case "doc_share": out = await shared.shareDoc(root, body.version ?? {}); break;
        case "doc_confirm": out = await shared.confirmSharedDoc(root, body.nodeId, body.versionId); break;
        case "doc_retire": out = await shared.retireSharedDoc(root, body.nodeId, body.rationale ?? ""); break;
        case "walkthrough_share": out = await shared.shareWalkthrough(root, body.walkthrough); break;
        case "relocate": out = await shared.relocateFinding(root, pr, body.id, body.kind, body.rationale ?? "", { to: body.to, apply: body.apply === true }); break;
        // Carrying is a PERSON's, like `heal` above, and for the same reason one step
        // over: with a backlog this size deferral is the cheapest way to empty a queue,
        // so there is deliberately no MCP tool for it (`ops-reach.test.ts` enforces
        // that). The web is where a principal is actually a principal.
        // Dispatched on the RECORD, like `corroborate` above: the backlog is full of local
        // rows, and a write that went straight to the log answers "no finding … on pr
        // <scope>" for every one of them.
        case "backlog": out = await ops.backlogOn(root, { id: body.id, until: String(body.until ?? ""), reason: String(body.reason ?? ""), ref: body.ref }); break;
        case "backlog_release": out = await ops.releaseBacklogOn(root, body.id, String(body.reason ?? "")); break;
        // …and this one an agent MAY do, which is the whole point of it: the witness-less
        // bucket is the one nothing can judge, and left to people it is never repaired.
        case "rewitness": out = await ops.rewitnessOn(root, body.id, { anchorId: body.anchorId }); break;
        // Ungated: it asks for a fresh look rather than asserting anything, and it lands
        // in the queue an agent already reads.
        case "reevaluate": out = await ops.reevaluateOn(root, body.id, { note: body.note }); break;
        default: out = { error: `unknown shared action "${action}"` };
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/triage") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () =>
        body.derive
          ? ops.deriveTriage(root)
          : body.clear
            ? ops.clearTriage(root, { targetKind: body.targetKind, targetId: body.targetId })
            : ops.setTriage(root, { targetKind: body.targetKind, targetId: body.targetId, importance: body.importance, complexity: body.complexity, source: "human", reason: body.reason, tripwire: body.tripwire }),
      );
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // The reviewer's half of the agent loop: hand a finding over, and read back
    // what the agent reported. Closing it stays a human act.
    if (req.method === "POST" && (url.pathname === "/api/annotation_assign" || url.pathname === "/api/annotation_close")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, async () => withAnchorAnnotations(root,
        await (url.pathname === "/api/annotation_assign"
          ? ops.assignAnnotation(root, { id: body.id, kind: body.kind, by: body.by, note: body.note })
          : ops.closeFinding(root, { id: body.id, result: body.result, detail: body.detail, files: body.files, by: body.by })),
      ));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Importing GitHub's per-file viewed ticks: reaches the GitHub API and writes
    // `viewed` marks — never `signed`, since a tick is one click on a whole file.
    // The act behind the banner `/api/index-state` raises. `checkStale` is what
    // re-baselines on a branch change, and it also runs the staleness pass and
    // refreshes analyzer graphs — which is what a reviewer arriving on a new branch
    // wants anyway, and why this is not a narrower op.
    if (req.method === "POST" && url.pathname === "/api/rebaseline") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () => ops.checkStale(root));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Reporting a defect, from the browser. The same op the agents use, with the same
    // required context — so a person raising something while reading a diff and an
    // agent raising it during a review land in exactly one place.
    if (req.method === "POST" && url.pathname === "/api/defect") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock(root, () => ops.reportDefect(root, body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/pr/pull_viewed") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () => ops.prPullViewed(root, String(body.pr ?? ""), { dryRun: body.dryRun }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pr/triage") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () => ops.prTriageDerive(root, String(body.pr ?? "")));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Editing a finding, and deciding against sending one. Both local; the map is
    // the only thing that moves until /api/pr/push.
    if (req.method === "POST" && (url.pathname === "/api/annotation_revise" || url.pathname === "/api/annotation_withdraw")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, async () => withAnchorAnnotations(root,
        await (url.pathname === "/api/annotation_revise"
          ? ops.reviseAnnotation(root, {
              id: String(body.id ?? ""), by: body.by || "human", allowPostEdit: !!body.allowPostEdit,
              text: body.text, comment: body.comment, disposition: body.disposition, severity: body.severity,
              publishPath: body.publishPath, publishLine: body.publishLine, publishAttribution: body.publishAttribution,
            })
          : ops.withdrawAnnotation(root, { id: String(body.id ?? ""), withdraw: body.withdraw !== false, by: body.by, reason: body.reason })),
      ));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Raising an agent's finding to the maintainer — the act that makes it
    // publishable. Local only; nothing is sent until /api/pr/push.
    if (req.method === "POST" && url.pathname === "/api/annotation_escalate") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, async () => withAnchorAnnotations(root,
        await ops.escalateAnnotation(root, { id: String(body.id ?? ""), escalate: body.escalate !== false, by: body.by }),
      ));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // THE outward-facing route: this posts to somebody else's pull request and
    // notifies them. A plan cannot be handed back by reference over HTTP, so the
    // caller returns the FINGERPRINT of the plan it displayed and the push is
    // refused if re-deriving no longer matches it — publishing something the human
    // did not read is the failure the plan/execute split exists to prevent.
    // Which review conversations are settled, and syncing that either way. The plan
    // is read-only; both directions are separate, confirmed acts.
    if (req.method === "POST" && url.pathname.startsWith("/api/pr/resolve")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, async () => {
        const plan = await ops.prResolvePlan(root, String(body.pr ?? ""));
        if ("error" in plan) return plan;
        if (url.pathname === "/api/pr/resolve_plan") return plan;
        if (url.pathname === "/api/pr/resolve_push") return { plan, result: await ops.prResolvePush(root, plan) };
        if (url.pathname === "/api/pr/resolve_pull") return { plan, result: await ops.prResolvePull(root, plan, { anyone: body.anyone === true }) };
        return { error: `unknown route ${url.pathname}` };
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // The plan is also a POST, because the reviewer's summary travels with it and a
    // few paragraphs URL-encoded into a query string approaches Node's 16KB header
    // limit — failing exactly when someone has just written something they care
    // about. The GET form stays for callers with nothing to send.
    if (req.method === "POST" && url.pathname === "/api/pr/push_plan") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () => ops.prPushPlan(root, String(body.pr ?? ""), {
        electedOnly: body.all !== true,
        minSeverity: body.minSeverity || undefined,
        summary: body.summary || undefined,
        event: body.event || undefined,
        ids: Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : undefined,
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pr/push") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, async () => {
        const plan = await ops.prPushPlan(root, String(body.pr ?? ""), {
          electedOnly: body.all !== true,
          minSeverity: body.minSeverity || undefined,
          summary: body.summary || undefined,
          event: body.event || undefined,
          ids: Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : undefined,
        });
        if ("error" in plan) return plan;
        if (body.fingerprint !== plan.fingerprint) {
          return { error: "this pull request changed since you reviewed the plan — reopen it and look again before publishing", staleFingerprint: true, plan };
        }
        return ops.prPushExecute(root, plan, { comments: body.comments !== false, markViewed: body.markViewed === true });
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Signing or viewing ONE symbol on the walkthrough. Unlike `/api/review` this
    // carries the pull request, which is what lets the mark cover the symbols the
    // change touches inside the one clicked (see `prStepMark`).
    if (req.method === "POST" && url.pathname === "/api/pr/step_mark") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () => ops.prStepMark(root, String(body.pr ?? ""), String(body.id ?? ""), {
        attestation: body.attestation === "viewed" ? "viewed" : "signed",
        unmark: body.unmark === true,
        reviewer: body.reviewer,
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Signing or viewing a whole chapter — the shortcut over per-symbol marking. It
    // writes the ordinary per-anchor marks underneath, so nothing about staleness or
    // acceptance changes.
    if (req.method === "POST" && url.pathname === "/api/pr/chapter_mark") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () => ops.prChapterMark(root, String(body.pr ?? ""), String(body.chapter ?? ""), {
        attestation: body.attestation === "viewed" ? "viewed" : "signed",
        unmark: body.unmark === true,
        reviewer: body.reviewer,
      }));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Promoting a walkthrough chapter into the map — a write, and a human act:
    // the walkthrough only ever proposes.
    if (req.method === "POST" && url.pathname === "/api/pr/promote") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () =>
        ops.prPromote(root, String(body.pr ?? ""), String(body.chapter ?? ""), { id: body.id, title: body.title, summary: body.summary, type: body.type }),
      );
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Review-time notes/questions from the UI: create, and resolve (close a question).
    if (req.method === "POST" && (url.pathname === "/api/annotate" || url.pathname === "/api/annotation_resolve")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, async () => withAnchorAnnotations(root,
        await (url.pathname === "/api/annotate"
          ? ops.annotate(root, { targetKind: body.targetKind, targetId: body.targetId, text: body.text, comment: body.comment, disposition: body.disposition, publishPath: body.publishPath, publishLine: body.publishLine, kind: body.kind, severity: body.severity, category: body.category, author: body.author, line: body.line, ref: body.ref })
          : ops.resolveAnnotation(root, body.id, body.resolved !== false)),
      ));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Bug triage from the UI. One router rather than a route each, the same shape as
    // `/api/shared/` above — a bug is now a team object and every one of these is a
    // thing somebody does to it.
    if (req.method === "POST" && url.pathname.startsWith("/api/bug/")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const action = url.pathname.slice("/api/bug/".length);
      // Which of these write `.codemap/` directly. Everything else appends to the log
      // and folds; naming them explicitly is what stops a new action racing the rest of
      // the server silently.
      const TOUCHES_LOCAL = new Set(["update", "publish", "accept", "unanchor"]);
      const run = <T>(fn: () => Promise<T>): Promise<T> =>
        TOUCHES_LOCAL.has(action) ? withLock(root, fn) : fn();
      let out: unknown;
      switch (action) {
        case "update": out = await run(() => ops.updateBug(root, {
          id: body.id, state: body.state, reason: body.reason, note: body.note,
          addAnchors: body.addAnchors, refreshWitnesses: body.refreshWitnesses,
          title: body.title, description: body.description, severity: body.severity, category: body.category,
        })); break;
        case "comment": out = await ops.commentBug(root, body.id, body.body ?? "", body.inReplyTo); break;
        case "track": out = await ops.trackBugExternally(root, body.id, { system: body.system, key: body.key, url: body.url }); break;
        case "corroborate": out = await ops.corroborateBugOp(root, body.id, body.verdict, body.rationale ?? ""); break;
        case "promote": out = await ops.promoteBugOp(root, body.id); break;
        case "request": out = await ops.requestOnBugOp(root, body.id, body.ask, body.rationale ?? ""); break;
        case "settle": out = await ops.resolveBugContestOp(root, body.id, body.field, body.value); break;
        case "unanchor": out = await run(() => ops.unanchorBugOp(root, body.id, body.anchorId, body.reason ?? "")); break;
        case "publish": out = await run(() => ops.publishBugs(root, { dryRun: body.dryRun === true, ids: body.ids })); break;
        case "accept": out = await run(() => ops.acceptFinding(root, String(body.pr ?? ""), body.finding, { title: body.title, severity: body.severity })); break;
        default: out = { error: `unknown bug action "${action}"` };
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Doc-versioning write paths from the UI (under the write lock).
    if (req.method === "POST" && (url.pathname === "/api/confirm" || url.pathname === "/api/ack_hole")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const fn = url.pathname === "/api/confirm" ? ops.confirm : ops.ackHole;
      const out = await withLock<unknown>(root, () => fn(root, body.id));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const out = await api(url.pathname, url.searchParams);
      if (out === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }
    const file = await serveStatic(url.pathname);
    if (!file) {
      // SPA fallback: unknown non-API path → index.html
      const index = await serveStatic("/index.html");
      if (index) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(index.body);
        return;
      }
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": file.type });
    res.end(file.body);
  } catch (e: any) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e?.message ?? String(e) }));
  }
});

// Loopback only. The server has no authentication and now carries write routes that
// mutate the map, fetch from remotes and post to GitHub; binding every interface put
// all of that on the local network. Set CODEMAP_HOST to widen it deliberately.
const host = process.env.CODEMAP_HOST ?? "127.0.0.1";
server.listen(port, host, () => {
  process.stderr.write(
    `codemap-serve: http://localhost:${port}  (${ws.universes.length} universe(s): ${ws.universes.map((x) => x.id + (x.primary ? "*" : "")).join(", ")})\n`,
  );
});
