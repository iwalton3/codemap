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

import { registerKinds, registerReferences, tipReader, type ScopeReader } from "./eventlog.js";
import { createHash } from "node:crypto";
import type { Actor, Agreement, BugSeverity } from "./schema.js";
import { isAgentActor } from "./identity.js";
import { mintId, readScope, registerDoor, type LogEvent } from "./eventlog.js";
import { emitEvent } from "./write.js";
import { collector, foldJudged, registerReport, staleRevision, wasOf, type RefusalClass, type Refusal } from "./validation.js";

export type NoteKind = "note" | "question" | "finding" | "pointer";

export interface NoteAnswer {
  id: string;
  actor: Actor;
  at: string;
  body: string;
}

export interface SharedNote {
  id: string;
  target: { kind: NoteTargetKind; id: string };
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
  /** A resolve or reopen that found the note already so, from another person. */
  agreements?: Agreement[];
  revisions: { at: string; by: Actor; was: Record<string, unknown> }[];
}

/**
 * What a note can be ABOUT.
 *
 * `anchor`/`node` are code; `spec`/`operation` are a PROPOSAL, which is the other
 * kind of thing a team argues about before it lands. One list, exported, because the
 * publish surface and the FOLD both filter on it — and a guard in the tool and not in
 * the fold binds one machine, which is the defect this subsystem keeps re-producing.
 *
 * A note on a proposal is discourse, never an edit: nothing here changes a spec, and
 * suggesting a change still means drafting one (`draft_spec`), which is what keeps the
 * operative content in the operations a principal actually ratifies.
 */
export const NOTE_TARGET_KINDS = ["anchor", "node", "spec", "operation"] as const;
export type NoteTargetKind = typeof NOTE_TARGET_KINDS[number];

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

/** The fold and every event it did not apply, classed (plan 3.1). The door and the scans read this. */
export function foldNotesReport(events: LogEvent[]): { value: Map<string, SharedNote>; refused: Refusal[] } {
  const { refused, refuse } = collector();
  return { value: foldNotesWith(events, refuse), refused };
}


/** Every kind this family folds or knows to skip: anything else here is newer (`eventlog.ts registerKinds`). */
const NOTE_KINDS = registerKinds((scope) => scope.startsWith("notes/"), ["note.created", "note.revised", "note.answered", "note.resolved"]);
/** The fold for a READ: a refused linear event is damage and locks; see `validation.ts`. */
export function foldNotes(events: LogEvent[]): Map<string, SharedNote> {
  return foldJudged(events, foldNotesReport, NOTE_KINDS).value;
}

function foldNotesWith(events: LogEvent[], refuse: (e: LogEvent, cls: RefusalClass, why: string) => void): Map<string, SharedNote> {
  const out = new Map<string, SharedNote>();
  // Each note's creating payload: the same bytes again are one act seen twice, different ones
  // are a claim on an id already taken (owner, Q5).
  const created = new Map<string, string>();
  for (const e of events) {
    const d = e.data as Data | undefined;

    if (e.kind === "note.created") {
      if (out.has(e.subject)) {
        if (created.get(e.subject) !== JSON.stringify(d ?? null)) refuse(e, "state", `note ${e.subject} already exists`);
        continue;
      }
      const text = str(d, "text");
      const targetId = str(d, "targetId");
      const targetKind = str(d, "targetKind");
      if (!text || !targetId || !NOTE_TARGET_KINDS.includes(targetKind as NoteTargetKind)) {
        refuse(e, "shape", `a note needs text and a target that is one of ${NOTE_TARGET_KINDS.join(", ")}`); continue;
      }
      created.set(e.subject, JSON.stringify(d ?? null));
      const kind = str(d, "kind");
      out.set(e.subject, {
        id: e.subject,
        target: { kind: targetKind as NoteTargetKind, id: targetId },
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
    if (!n) {
      if (e.kind.startsWith("note.")) refuse(e, "reference", `no note ${e.subject} in this bucket`);
      continue;
    }

    switch (e.kind) {
      case "note.revised": {
        const now = (d?.now as Record<string, unknown>) ?? {};
        const stale = staleRevision(e, n as unknown as Record<string, unknown>);
        if (stale) { refuse(e, "state", stale); break; }
        n.revisions.push({ at: e.at, by: e.actor, was: (d?.was as Record<string, unknown>) ?? {} });
        if (typeof now.text === "string") n.text = now.text;
        if (typeof now.category === "string") n.category = now.category;
        if (typeof now.severity === "string") n.severity = now.severity as BugSeverity;
        if (typeof now.line === "number") n.line = now.line;
        break;
      }
      case "note.answered": {
        const body = str(d, "body");
        if (!body) { refuse(e, "shape", "an answer needs a body"); break; }
        n.answers.push({ id: e.id, actor: e.actor, at: e.at, body });
        break;
      }
      case "note.resolved": {
        // An agent may answer a question, and may not declare it settled: closing
        // out is the same human act it is on a finding. Enforced HERE because a
        // write-time check only ever protects the honest writer.
        if (isAgentActor(e.actor)) { refuse(e, "state", "closing or re-opening a shared note is a person's act"); break; }
        // `from`: what its author decided against. Absent on events written before it.
        const from = str(d, "from");
        const now = n.resolved ? "resolved" : "open";
        const want = d?.resolved === false ? "open" : "resolved";
        // Already so (P-identical): the same person's act changes nothing, another's is agreement.
        if (want === now) {
          if (n.resolved?.by.principal !== e.actor.principal && !n.agreements?.some((a) => a.by.principal === e.actor.principal))
            (n.agreements ??= []).push({ by: e.actor, at: e.at, eventId: e.id, ...(str(d, "reason") ? { reason: str(d, "reason") } : {}) });
          break;
        }
        if (from && from !== now) { refuse(e, "state", `the note is ${now}; this was decided when it was ${from}`); break; }
        n.resolved = d?.resolved === false ? undefined : { at: e.at, by: e.actor, reason: str(d, "reason") };
        break;
      }
    }
  }
  return out;
}

/**
 * The references a note makes OUTSIDE its bucket (docs/sidecar-references.md, rows 84-85): a
 * note on a proposal names a spec or operation that must have been drafted in the law log (or a
 * pre-split `standard/<universe>`). Existence only — a withdrawn spec or a removed operation is
 * still something to talk about. A node target is never checked: an unpublished or analyzer
 * node is local, not a foreign key (owner, Q2), and a published one needs no check to resolve.
 */
async function outsideReferences(scope: string, e: LogEvent, _own: LogEvent[], read: ScopeReader): Promise<Refusal[]> {
  if (e.kind !== "note.created") return [];
  const d = e.data as Data | undefined;
  const targetKind = str(d, "targetKind"), targetId = str(d, "targetId");
  if ((targetKind !== "spec" && targetKind !== "operation") || !targetId) return [];
  const universe = /^notes\/(.+)\/[^/]+$/.exec(scope)?.[1];
  const law = [...await read.read("law/standard"), ...universe ? await read.read(`standard/${universe}`) : []];
  const found = targetKind === "spec"
    ? law.some((x) => x.kind === "spec.drafted" && (x.data as { spec?: { id?: unknown } } | undefined)?.spec?.id === targetId)
    : law.some((x) => x.kind === "spec.operation" && (x.data as { operation?: { id?: unknown } } | undefined)?.operation?.id === targetId);
  return found ? [] : [{ id: e.id, kind: e.kind, cls: "reference", why: `no ${targetKind} ${targetId} has been drafted` }];
}

registerReport((scope) => scope.startsWith("notes/"), foldNotesReport);
registerDoor((scope) => scope.startsWith("notes/"), (logRoot, scope) => async (events, minted) => ({
  refused: [...foldNotesReport(events).refused, ...await outsideReferences(scope, minted, events, tipReader(logRoot)), ...misfiled(scope, minted)],
}));
registerReferences((scope) => scope.startsWith("notes/"), outsideReferences);

/** A note lives in its target's bucket, the one scope its target's page reads (owner, O26). */
function misfiled(scope: string, e: LogEvent): Refusal[] {
  const targetId = e.kind === "note.created" ? str(e.data as Data | undefined, "targetId") : undefined;
  if (!targetId) return [];
  const want = bucketFor(targetId);
  return scope.endsWith(`/${want}`) ? [] : [{ id: e.id, kind: e.kind, cls: "reference", why: `a note on ${targetId} belongs in bucket ${want}, not ${scope}` }];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const emit = (
  logRoot: string, universe: string, targetId: string, actor: Actor,
  subject: string, kind: string, data?: Data,
): Promise<LogEvent> => emitEvent(logRoot, noteScope(universe, bucketFor(targetId)), actor, kind, subject, data);

export interface NewNote {
  id?: string;
  targetKind: NoteTargetKind;
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

export async function resolveNote(
  logRoot: string, universe: string, targetId: string, actor: Actor, id: string, resolved: boolean, reason?: string,
): Promise<LogEvent> {
  // `from`: a replay onto a note a teammate has since closed or re-opened is refused rather
  // than silently overwriting their call (plan 3.1).
  const current = (await notesForTarget(logRoot, universe, targetId)).find((n) => n.id === id);
  const from = current ? { from: current.resolved ? "resolved" : "open" } : {};
  return emit(logRoot, universe, targetId, actor, id, "note.resolved", { resolved, ...from, ...(reason ? { reason } : {}) });
}

/** `was`: each changed field as this author reads it, so a replay onto a moved note is refused (`staleRevision`). */
export async function reviseNote(
  logRoot: string, universe: string, targetId: string, actor: Actor, id: string, now: Record<string, unknown>,
): Promise<LogEvent> {
  const current = (await notesForTarget(logRoot, universe, targetId)).find((n) => n.id === id);
  return emit(logRoot, universe, targetId, actor, id, "note.revised", { now, was: wasOf(current, now) });
}

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
