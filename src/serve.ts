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
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import * as ops from "./ops.js";
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
      return multi.getNodeEnriched(ws, u ?? ws.primary.id, q.get("id") ?? "");
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
      return ops.flow(root, q.get("id") ?? "");
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
      return ops.listBugs(root, { status: (q.get("status") as any) ?? undefined });
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
      });
    case "/api/orphans":
      return ops.orphanedWork(root);
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
          ? await unmarkReviewed(root, { targetKind: body.targetKind, targetId: body.targetId, level: body.level, attestation })
          // `ref` (the PR head) makes the witness cover the code actually read.
          : await markReviewed(root, { targetKind: body.targetKind, targetId: body.targetId, level: body.level, reviewer: body.reviewer, actor: "human", attestation, ref: body.ref });
        // Hand back the resulting mark so a caller can update that one symbol in
        // place. The walkthrough re-fetched the WHOLE story to learn this, which on
        // a large pull request is seconds of work to answer a question about one
        // anchor — and the answer has real nuance (replayed, sitting on a revert),
        // so the client must not guess it.
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
          : ops.closeAssignment(root, { id: body.id, result: body.result, detail: body.detail, files: body.files, by: body.by })),
      ));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(out));
      return;
    }

    // Importing GitHub's per-file viewed ticks: reaches the GitHub API and writes
    // `viewed` marks — never `signed`, since a tick is one click on a whole file.
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

    // Bug triage from the UI: change status / append a note / refresh witnesses.
    if (req.method === "POST" && url.pathname === "/api/bug/update") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const root = rootFor(body.u ?? null);
      const out = await withLock<unknown>(root, () =>
        ops.updateBug(root, { id: body.id, status: body.status, note: body.note, refreshWitnesses: body.refreshWitnesses }),
      );
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
