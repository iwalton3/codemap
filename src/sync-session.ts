/**
 * Who owns a staged write (plan 2.4, F20d). An MCP process is one session — its
 * connection. A web page mints a random tab id on load and sends it with every write and
 * poll. Anything else (the CLI, a test) is its own process's session.
 *
 * Carried in AsyncLocalStorage because the write door sits many calls below the surface
 * that knows who is asking, and threading a session through every op signature would touch
 * all of them for one fact.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { SessionKind, SessionRow } from "./sync-queue.js";

export interface SessionCtx { session: string; kind: SessionKind }

const als = new AsyncLocalStorage<SessionCtx>();
const nonce = randomBytes(4).toString("hex");
let processKind: SessionKind = "cli";

/** The process's own session id. Carries the pid, so a dead one can be recognised. */
export const processSession = (): string => `${processKind}:${process.pid}:${nonce}`;

/** An MCP server is one session for its whole life: say so once, at startup. */
export function setProcessSessionKind(kind: SessionKind): void { processKind = kind; }

export function currentSession(): SessionCtx {
  return als.getStore() ?? { session: processSession(), kind: processKind };
}

/** Run `fn` as a web tab's session. The id is the page's, validated by the caller. */
export function withSession<T>(session: string, kind: SessionKind, fn: () => T): T {
  return als.run({ session, kind }, fn);
}

const replaying = new AsyncLocalStorage<true>();
/** A sync replays against the tip alone: no session's staged acts may leak into what it checks. */
export const withoutOverlay = <T>(fn: () => T): T => replaying.run(true, fn);
export const overlaySuppressed = (): boolean => replaying.getStore() === true;

export const webSession = (tab: string): string => `web:${tab}`;
export const isTabId = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{16,64}$/.test(s);

/**
 * How long a tab may go without polling before it counts as closed. Well above a minute (review
 * C13): Chrome's intensive throttling runs a hidden tab's timers about once a minute, so a 45s
 * limit swept the writes of tabs that were only in the background. A closed tab is caught sooner
 * by its pagehide beacon; this is the fallback, and it loses little by waiting.
 */
export const TAB_GONE_MS = 180_000;
/** `CODEMAP_TAB_GONE_MS` shortens it for a test that closes a tab and cannot wait the real time. */
const tabGoneMs = (): number => Number(process.env.CODEMAP_TAB_GONE_MS) || TAB_GONE_MS;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Whether the session is gone, so the server attempts its writes (plan 2.5). A tab is gone
 * when its polls stop; an MCP or CLI session when its process is. A session with no row
 * staged through nothing that registered it, and is judged by the pid in its id.
 */
export function sessionGone(session: string, row: SessionRow | null, now = Date.now()): boolean {
  if (session === processSession()) return false;
  // A tab belongs to the server that served it (`row.pid`): gone when its polls stop, or
  // when that server is.
  if (row?.kind === "web" || session.startsWith("web:")) {
    return !row || now - Date.parse(row.seen) > tabGoneMs() || !pidAlive(row.pid);
  }
  // Anything else IS a process, and its id carries the pid; the row's is whoever touched it.
  const pid = Number(session.split(":")[1]);
  return !Number.isFinite(pid) || !pidAlive(pid);
}
