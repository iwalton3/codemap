/**
 * Reading a Claude Code session transcript, for the decision rounds.
 *
 * The only place codemap reads another program's private file format, so the rot is kept
 * here. Everything fails CLOSED: an unknown shape, a missing file or a question that does
 * not match reads `unverified` with a reason — never an error that blocks the caller,
 * because "I could not check" is not a verdict (docs/decision-rounds-worked-cases.md).
 *
 * Only the session's own top-level `<session>.jsonl` is read. Subagents write to
 * `<session>/subagents/`, so their words cannot be mistaken for the person's by construction.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AskedQuestion } from "./schema.js";

export interface Unverified { unverified: string }
export const isUnverified = (v: unknown): v is Unverified =>
  !!v && typeof v === "object" && typeof (v as Unverified).unverified === "string";

/** One `AskUserQuestion` call and what the person answered, as the transcript holds it. */
export interface TranscriptCall {
  session: string;
  toolUseId: string;
  /** The tool result's entry id. */
  entryId: string;
  /** As sent — and checked equal to what the result says was asked. */
  questions: AskedQuestion[];
  /** Keyed by question text; a multi-select answer is a list, and typed "Other" text is one
   *  more element of it (measured 2026-09-23). */
  answers: Record<string, string | string[]>;
}

export interface PersonMessage { session: string; entryId: string; text: string }

/** Where Claude Code keeps a project's transcripts: every non-alphanumeric in the cwd
 *  becomes `-`. `CODEMAP_TRANSCRIPT_DIR` overrides the directory, for tests. */
export function transcriptDir(cwd: string = process.cwd()): string {
  return process.env.CODEMAP_TRANSCRIPT_DIR ?? join(homedir(), ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

// A session id names a file; anything that is not a plain id could name a different one.
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function entries(session: string, dir: string): Record<string, any>[] | Unverified {
  if (!SESSION.test(session)) return { unverified: `not a session id: ${JSON.stringify(session)}` };
  let raw: string;
  try { raw = readFileSync(join(dir, `${session}.jsonl`), "utf8"); } catch {
    return { unverified: `no transcript for session ${session} in ${dir}` };
  }
  const out: Record<string, any>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch { /* a torn last line while the session is still writing */ }
  }
  return out;
}

// --- questions --------------------------------------------------------------------------

/** The question as compared: `multiSelect` false when absent, nothing else kept. */
export function normalizeQuestion(q: AskedQuestion): AskedQuestion {
  return {
    question: q.question,
    ...(q.header !== undefined ? { header: q.header } : {}),
    options: (Array.isArray(q.options) ? q.options : []).map((o) => ({ label: o?.label, ...(o?.description !== undefined ? { description: o.description } : {}) })),
    multiSelect: q.multiSelect === true,
  };
}

/** A key-sorted serialisation, so two equal questions compare equal whatever the key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const sameQuestion = (a: AskedQuestion, b: AskedQuestion): boolean =>
  canonical(normalizeQuestion(a)) === canonical(normalizeQuestion(b));

const isQuestion = (q: unknown): q is AskedQuestion =>
  !!q && typeof q === "object" && typeof (q as any).question === "string" && Array.isArray((q as any).options)
  && (q as any).options.every((o: unknown) => !!o && typeof o === "object" && typeof (o as any).label === "string");

/**
 * The call `toolUseId` made in `session`, and its answers. Verified means: the assistant sent
 * this `AskUserQuestion`, the paired result is in the session's own (not a sidechain's)
 * record, the result says the same questions were asked, and every answer is keyed by one of
 * them. Answers come from the structured `toolUseResult`, never the result's text, which
 * breaks on a question containing a quote mark.
 */
export function readCall(session: string, toolUseId: string, dir: string = transcriptDir()): TranscriptCall | Unverified {
  const all = entries(session, dir);
  if (isUnverified(all)) return all;
  let sent: { uuid: string; questions: unknown } | undefined;
  for (const e of all) {
    if (e.type !== "assistant" || e.isSidechain === true || !Array.isArray(e.message?.content)) continue;
    const b = e.message.content.find((x: any) => x?.type === "tool_use" && x.id === toolUseId);
    if (b) { if (b.name !== "AskUserQuestion") return { unverified: `${toolUseId} is a ${String(b.name)} call, not AskUserQuestion` }; sent = { uuid: e.uuid, questions: b.input?.questions }; break; }
  }
  if (!sent) return { unverified: `no AskUserQuestion call ${toolUseId} in session ${session}` };
  if (!Array.isArray(sent.questions) || !sent.questions.every(isQuestion)) return { unverified: "the call's questions are not in a known shape" };

  const result = all.find((e) => e.type === "user" && e.isSidechain !== true && Array.isArray(e.message?.content)
    && e.message.content.some((x: any) => x?.type === "tool_result" && x.tool_use_id === toolUseId));
  if (!result) return { unverified: `call ${toolUseId} has no answer in the transcript` };
  // A tool result carries no origin; one that does is somebody's message, not this result.
  if (result.origin !== undefined) return { unverified: "the answer entry carries an origin, so it is not a tool result" };
  if (typeof result.sourceToolAssistantUUID === "string" && result.sourceToolAssistantUUID !== sent.uuid) {
    return { unverified: "the answer names a different call as its source" };
  }
  const r = result.toolUseResult;
  if (!r || typeof r !== "object" || !Array.isArray(r.questions) || !r.questions.every(isQuestion)
    || !r.answers || typeof r.answers !== "object" || Array.isArray(r.answers)) {
    return { unverified: "the answer has no structured result (questions and answers)" };
  }
  const asked = sent.questions as AskedQuestion[];
  if (asked.length !== r.questions.length || asked.some((q, i) => !sameQuestion(q, r.questions[i]))) {
    return { unverified: "what the result says was asked differs from what was sent" };
  }
  const texts = new Set(asked.map((q) => q.question));
  const answers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(r.answers as Record<string, unknown>)) {
    if (!texts.has(k)) return { unverified: `an answer is keyed by a question that was not asked: ${JSON.stringify(k.slice(0, 60))}` };
    if (typeof v === "string") answers[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) answers[k] = v as string[];
    else return { unverified: "an answer is neither text nor a list of text" };
  }
  return { session, toolUseId, entryId: String(result.uuid ?? ""), questions: asked.map(normalizeQuestion), answers };
}

// --- one answer, classified ----------------------------------------------------------------

export type AnswerPart =
  | { kind: "label"; label: string }
  /** Typed "Other" text: the person's own words, for the reader. */
  | { kind: "words"; words: string }
  /** An offered label with the person's words after it. */
  | { kind: "label+words"; label: string; words: string };

/**
 * An answer, element by element. A single-select answer is one element; a multi-select is
 * a list, where typed Other text is simply an element that matches no label. "Label plus
 * words" is detected as starting with an offered label and being longer — the longest
 * matching label wins, so "Keep" never swallows "Keep both".
 */
export function classifyAnswer(q: AskedQuestion, answer: string | string[]): AnswerPart[] {
  const labels = q.options.map((o) => o.label).sort((a, b) => b.length - a.length);
  return (Array.isArray(answer) ? answer : [answer]).map((a): AnswerPart => {
    if (labels.includes(a)) return { kind: "label", label: a };
    const l = labels.find((x) => a.startsWith(x));
    if (l) return { kind: "label+words", label: l, words: a.slice(l.length).replace(/^[\s:,.;—-]+/, "") };
    return { kind: "words", words: a };
  });
}

// --- the person's typed words ----------------------------------------------------------------

const textOf = (c: unknown): string | undefined => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.filter((x: any) => x?.type === "text" && typeof x.text === "string").map((x: any) => x.text as string);
    return parts.length === c.length && parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
};

/**
 * The WHOLE message the person typed, by its entry id — never a part of it, so "do not run
 * the tests" cannot be relayed as "run the tests". The person's words are a `user` entry, or
 * a `queued_command` attachment, whose `origin.kind` is `human`. Goal continuations
 * (`auto-continuation`), subagent hand-backs (`peer`), a bare `queue-operation` and an entry
 * with no origin are not.
 */
export function readMessage(session: string, entryId: string, dir: string = transcriptDir()): PersonMessage | Unverified {
  const all = entries(session, dir);
  if (isUnverified(all)) return all;
  const e = all.find((x) => x.uuid === entryId);
  if (!e) return { unverified: `no entry ${entryId} in session ${session}` };
  if (e.isSidechain === true) return { unverified: "the entry is a subagent's" };
  if (e.type === "user") {
    if (e.origin?.kind !== "human") return { unverified: `the entry's origin is ${JSON.stringify(e.origin?.kind ?? null)}, not the person` };
    if (e.toolUseResult !== undefined) return { unverified: "the entry is a tool result" };
    const text = textOf(e.message?.content);
    return text === undefined ? { unverified: "the message is not plain text" } : { session, entryId, text };
  }
  if (e.type === "attachment" && e.attachment?.type === "queued_command") {
    // Measured: a queued command carries its origin on the attachment, not the entry.
    const kind = e.attachment.origin?.kind;
    if (kind !== "human") return { unverified: `the queued message's origin is ${JSON.stringify(kind ?? null)}, not the person` };
    const text = textOf(e.attachment.prompt);
    return text === undefined ? { unverified: "the queued message is not plain text" } : { session, entryId, text };
  }
  return { unverified: `entry ${entryId} is a ${String(e.type)}, not a message the person typed` };
}
