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
async function api(path: string, q: URLSearchParams): Promise<unknown> {
  const u = q.get("u");
  const root = rootFor(u);
  switch (path) {
    case "/api/universes":
      return multi.listUniverses(ws);
    case "/api/guide":
      return { methodology: METHODOLOGY };
    case "/api/outline":
      return ops.outline(root, q.get("prefix") ?? "");
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
    case "/api/matrix":
      return ops.eventMatrix(root);
    case "/api/pipeline":
      return ops.pipelineGraph(root, { domain: q.get("domain") || undefined });
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
    case "/api/bugs":
      return ops.listBugs(root, { status: (q.get("status") as any) ?? undefined });
    case "/api/bug":
      return ops.bugDetail(root, q.get("id") ?? "");
    case "/api/stale":
      return ops.checkStale(root);
    case "/api/snapshots":
      return ops.snapshots(root);
    case "/api/diff":
      return ops.diff(root, q.get("base") ?? "", q.get("head") || undefined);
    case "/api/diff/code":
      return ops.diffCode(root, q.get("base") ?? "", q.get("head") || undefined, q.get("id") ?? "", q.get("file") ?? "");
    case "/api/diff/doc":
      return ops.docDiff(root, q.get("base") ?? "", q.get("head") || undefined, q.get("id") ?? "");
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
      const out = await withLock<unknown>(root, () =>
        body.unmark
          ? unmarkReviewed(root, { targetKind: body.targetKind, targetId: body.targetId, level: body.level })
          : markReviewed(root, { targetKind: body.targetKind, targetId: body.targetId, level: body.level, reviewer: body.reviewer }),
      );
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

server.listen(port, () => {
  process.stderr.write(
    `codemap-serve: http://localhost:${port}  (${ws.universes.length} universe(s): ${ws.universes.map((x) => x.id + (x.primary ? "*" : "")).join(", ")})\n`,
  );
});
