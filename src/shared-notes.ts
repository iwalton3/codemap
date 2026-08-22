/**
 * Annotations on the sidecar — the codebase knowledge, as opposed to the
 * pull-request findings in `shared-findings.ts`.
 *
 * Shared because it is expensive to acquire and cheap to lose. A note saying why
 * the obvious refactor here is wrong, or a question nobody has answered yet, cost
 * somebody an afternoon of reading; keeping it in one person's SQLite means the
 * next person pays again. That is a different argument from the one for findings
 * — a finding is work in flight, a note is what the team knows — and it is the
 * stronger of the two.
 *
 * ## Why not the finding log
 *
 * Findings are scoped to a pull request and carry promotion, corroboration and an
 * ack queue. A note is scoped to a SYMBOL, outlives every branch, and has none of
 * that. Forcing them together would mean a note needing a `pr` it does not have,
 * and an ack queue full of things nobody is waiting on.
 *
 * ## Bucketing
 *
 * Scopes are `notes/<universe>/<bucket>`, where the bucket is derived from the
 * TARGET. Drawing one anchor's notes would otherwise read every note in the
 * universe, which is a full scan on a page view. 256 buckets keeps each one small
 * while a single target's notes stay in exactly one file per person.
 */

import { createHash } from "node:crypto";
import type { Actor, BugSeverity } from "./schema.js";
import { isAgentActor } from "./identity.js";
import { appendEvents, mintId, readScope, causalHeads, causality, type LogEvent } from "./eventlog.js";
import { applyRevision, newContestState, type Contested } from "./contest.js";

export type NoteKind = "note" | "question" | "finding" | "pointer";

export interface NoteAnswer {
  id: string;
  actor: Actor;
  at: string;
  body: string;
}

export interface SharedNote {
  id: string;
  target: { kind: "anchor" | "node"; id: string };
  kind: NoteKind;
  text: string;
  severity?: BugSeverity;
  category?: string;
  line?: number;
  author: Actor;
  createdAt: string;
  /** Answers to a question, or follow-ups on anything else. Append-only. */
  answers: NoteAnswer[];
  resolved?: { at: string; by: Actor; reason?: string };
  revisions: { at: string; by: Actor; was: Record<string, unknown> }[];
  /**
   * Fields two people set differently without having seen each other.
   *
   * Same rule and the same code as a finding's — `note.revised` used to overwrite
   * these scalars unconditionally, so two people editing one note concurrently
   * resolved to whoever happened to fold last. Nothing was destroyed (`revisions`
   * keeps both) but nobody was ever asked to arbitrate, which is the entire job of
   * this field.
   */
  contested?: Contested[];
}

/**
 * The scalars one person owns, and the only ones that can conflict.
 *
 * `answers` is append-only and `resolved` is a latch, so neither is here.
 */
const CONTESTABLE = ["text", "category", "severity", "line"] as const;

/** Which of 256 buckets a target's notes live in. */
export const bucketFor = (targetId: string): string =>
  createHash("sha256").update(targetId).digest("hex").slice(0, 2);

export const noteScope = (universe: string, bucket: string): string => `notes/${universe}/${bucket}`;

// ---------------------------------------------------------------------------
// The fold — same contract as findings: it is the authority, not the write path
// ---------------------------------------------------------------------------

type Data = Record<string, unknown>;
const str = (d: Data | undefined, k: string): string | undefined => {
  const v = d?.[k];
  return typeof v === "string" && v.trim() ? v : undefined;
};

const KINDS: readonly string[] = ["note", "question", "finding", "pointer"];

export function foldNotes(events: LogEvent[]): Map<string, SharedNote> {
  const out = new Map<string, SharedNote>();
  const contest = newContestState();
  const causal = causality(events);
  for (const e of events) {
    const d = e.data as Data | undefined;

    if (e.kind === "note.created") {
      if (out.has(e.subject)) continue;
      const text = str(d, "text");
      const targetId = str(d, "targetId");
      const targetKind = str(d, "targetKind");
      if (!text || !targetId || (targetKind !== "anchor" && targetKind !== "node")) continue;
      const kind = str(d, "kind");
      out.set(e.subject, {
        id: e.subject,
        target: { kind: targetKind, id: targetId },
        kind: (KINDS.includes(kind ?? "") ? kind : "note") as NoteKind,
        text,
        severity: str(d, "severity") as BugSeverity | undefined,
        category: str(d, "category"),
        line: typeof d?.line === "number" ? d.line : undefined,
        author: e.actor,
        createdAt: e.at,
        answers: [],
        revisions: [],
      });
      continue;
    }

    const n = out.get(e.subject);
    if (!n) continue;

    switch (e.kind) {
      case "note.revised": {
        const now = (d?.now as Record<string, unknown>) ?? {};
        applyRevision(n, e, now, CONTESTABLE, contest, causal);
        n.revisions.push({ at: e.at, by: e.actor, was: (d?.was as Record<string, unknown>) ?? {} });
        if (typeof now.text === "string") n.text = now.text;
        if (typeof now.category === "string") n.category = now.category;
        if (typeof now.severity === "string") n.severity = now.severity as BugSeverity;
        if (typeof now.line === "number") n.line = now.line;
        break;
      }
      case "note.answered": {
        const body = str(d, "body");
        if (!body) break;
        n.answers.push({ id: e.id, actor: e.actor, at: e.at, body });
        break;
      }
      case "note.resolved": {
        // An agent may answer a question, and may not declare it settled: closing
        // out is the same human act it is on a finding. Enforced HERE because a
        // write-time check only ever protects the honest writer.
        if (isAgentActor(e.actor)) break;
        n.resolved = d?.resolved === false ? undefined : { at: e.at, by: e.actor, reason: str(d, "reason") };
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function emit(
  logRoot: string, universe: string, targetId: string, actor: Actor,
  subject: string, kind: string, data?: Data,
): Promise<LogEvent> {
  const scope = noteScope(universe, bucketFor(targetId));
  const seen = causalHeads(await readScope(logRoot, scope));
  const event: LogEvent = {
    id: mintId(), kind, subject, actor, at: new Date().toISOString(),
    ...(seen.length ? { after: seen } : {}),
    ...(data ? { data } : {}),
  };
  await appendEvents(logRoot, scope, actor, [event]);
  return event;
}

export interface NewNote {
  id?: string;
  targetKind: "anchor" | "node";
  targetId: string;
  kind?: NoteKind;
  text: string;
  severity?: BugSeverity;
  category?: string;
  line?: number;
}

export async function createNote(logRoot: string, universe: string, actor: Actor, n: NewNote): Promise<string> {
  const id = n.id ?? "n_" + mintId();
  await emit(logRoot, universe, n.targetId, actor, id, "note.created", { ...n, id: undefined } as Data);
  return id;
}

export const answerNote = (logRoot: string, universe: string, targetId: string, actor: Actor, id: string, body: string) =>
  emit(logRoot, universe, targetId, actor, id, "note.answered", { body });

export const resolveNote = (logRoot: string, universe: string, targetId: string, actor: Actor, id: string, resolved: boolean, reason?: string) =>
  emit(logRoot, universe, targetId, actor, id, "note.resolved", { resolved, ...(reason ? { reason } : {}) });

export const reviseNote = (logRoot: string, universe: string, targetId: string, actor: Actor, id: string, now: Record<string, unknown>) =>
  emit(logRoot, universe, targetId, actor, id, "note.revised", { now });

/** Everything anyone has written about one target. One bucket, one read. */
export async function notesForTarget(logRoot: string, universe: string, targetId: string): Promise<SharedNote[]> {
  const all = foldNotes(await readScope(logRoot, noteScope(universe, bucketFor(targetId))));
  return [...all.values()].filter((n) => n.target.id === targetId);
}

/**
 * Every note in the universe — all 256 buckets.
 *
 * Deliberately separate from `notesForTarget`, which is what a page view calls.
 * Anything that needs this is doing something wholesale (a catalogue, a publish)
 * and should be paying the cost knowingly.
 */
export async function allNotes(logRoot: string, universe: string): Promise<SharedNote[]> {
  const out: SharedNote[] = [];
  for (let i = 0; i < 256; i++) {
    const bucket = i.toString(16).padStart(2, "0");
    const notes = foldNotes(await readScope(logRoot, noteScope(universe, bucket)));
    out.push(...notes.values());
  }
  return out;
}
