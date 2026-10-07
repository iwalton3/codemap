/**
 * Reading a Claude Code session transcript, for the decision rounds.
 *
 * The only place codemap reads another program's private file format, so the rot is kept
 * here. Everything fails CLOSED: an unknown shape, a missing file or a question that does
 * not match reads `unverified` with a reason — never an error that blocks the caller,
 * because "I could not check" is not a verdict (docs/decision-rounds-worked-cases.md).
 *
 * The person's words are read only from the session's own top-level `<session>.jsonl`.
 * Subagents write to `<session>/subagents/`, so their words cannot be mistaken for the
 * person's by construction; that directory is read only by `readReader` and
 * `findVerdictCalls`, to check a reader.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
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
  /** The tool result entry's timestamp: when the person answered. */
  at: string;
  /** As sent — and checked equal to what the result says was asked. */
  questions: AskedQuestion[];
  /** Keyed by question text; a multi-select answer is a list, and typed "Other" text is one
   *  more element of it (measured 2026-09-23). */
  answers: Record<string, string | string[]>;
}

export interface PersonMessage { session: string; entryId: string; text: string; /** The entry's timestamp: when they typed it. */ at: string }

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

/**
 * The session whose own transcript holds `id` (a tool-use id or an entry id), newest first —
 * for an agent that knows what it asked but not its session id. Top-level files only, so a
 * subagent's transcript is never the answer.
 */
export function sessionHolding(id: string, dir: string = transcriptDir()): string | Unverified {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { unverified: `not an id: ${JSON.stringify(id)}` };
  let files: { name: string; at: number }[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && SESSION.test(f.slice(0, -6)))
      .map((f) => ({ name: f, at: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at);
  } catch { return { unverified: `no transcripts in ${dir}` }; }
  for (const f of files) {
    try { if (readFileSync(join(dir, f.name), "utf8").includes(`"${id}"`)) return f.name.slice(0, -6); } catch { /* unreadable: not this one */ }
  }
  return { unverified: `no session in ${dir} holds ${id}` };
}

/** Top-level transcripts (never a subagent's) written to at or after `since`, or only `session`'s. */
function sessionsSince(since: string, dir: string, session?: string): string[] | Unverified {
  if (session !== undefined) return SESSION.test(session) ? [session] : { unverified: `not a session id: ${JSON.stringify(session)}` };
  // Only saves scans. A file's mtime comes from a coarser clock than Date.now(), so one written
  // just after `since` can read as older; each entry's own timestamp is what decides.
  const floor = Date.parse(since) - 60_000;
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl") && SESSION.test(f.slice(0, -6)))
      .filter((f) => { try { return !(statSync(join(dir, f)).mtimeMs < floor); } catch { return false; } })
      .map((f) => f.slice(0, -6));
  } catch { return { unverified: `no transcripts in ${dir}` }; }
}

/**
 * Every `AskUserQuestion` call sent after `since` that asks at least one of `questions` — how
 * `log_question` finds a call the agent cannot name: the tool_use id is in the transcript file and
 * not in what the model sees (measured 2026-10-06). The caller refuses more than one.
 */
export function findAskCalls(questions: AskedQuestion[], since: string, dir: string = transcriptDir(), session?: string):
  { session: string; toolUseId: string; at: string }[] | Unverified {
  const sessions = sessionsSince(since, dir, session);
  if (isUnverified(sessions)) return sessions;
  const out: { session: string; toolUseId: string; at: string }[] = [];
  for (const s of sessions) {
    const all = entries(s, dir);
    if (isUnverified(all)) continue;
    for (const e of all) {
      if (e.type !== "assistant" || e.isSidechain === true || !Array.isArray(e.message?.content)) continue;
      const at = stampOf(e);
      if (isUnverified(at) || !(Date.parse(at) > Date.parse(since))) continue;
      for (const b of e.message.content) {
        if (b?.type !== "tool_use" || b.name !== "AskUserQuestion" || typeof b.id !== "string" || !Array.isArray(b.input?.questions)) continue;
        if (b.input.questions.some((q: unknown) => isQuestion(q) && questions.some((p) => sameQuestion(q, p)))) out.push({ session: s, toolUseId: b.id, at });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The one `AskUserQuestion` call after `since` that asked exactly `question`, for an op that built
 * the question itself and so knows it exactly. None, or several, is an error naming them.
 */
export function soleAskCall(question: AskedQuestion, since: string, dir: string = transcriptDir(), session?: string):
  { session: string; toolUseId: string } | { error: string } {
  const found = findAskCalls([question], since, dir, session);
  if (isUnverified(found)) return { error: found.unverified };
  if (!found.length) return { error: "no AskUserQuestion call asked this exact question: ask it verbatim, then call this again" };
  if (found.length > 1) return { error: `${found.length} AskUserQuestion calls asked this exact question: ${found.map((c) => c.toolUseId).join(", ")}. Which one is meant cannot be told; pass its toolUseId` };
  return { session: found[0]!.session, toolUseId: found[0]!.toolUseId };
}

/**
 * The latest entry in `session`'s own transcript where the skill `skill` ran: the model's `Skill`
 * call, or the person typing `/<skill>` — the two shapes measured 2026-10-06. Evidence the skill
 * was run, never of what it concluded.
 */
export function findSkillRun(session: string, skill: string, dir: string = transcriptDir()): { session: string; entry: string } | Unverified {
  const all = entries(session, dir);
  if (isUnverified(all)) return all;
  const typed = `<command-name>/${skill}</command-name>`;
  const ran = all.filter((e) => e.isSidechain !== true && typeof e.uuid === "string" && (
    (e.type === "assistant" && Array.isArray(e.message?.content) && e.message.content.some((b: any) => b?.type === "tool_use" && b.name === "Skill" && b.input?.skill === skill))
    || (e.type === "user" && e.origin?.kind === "human" && textOf(e.message?.content)?.includes(typed))));
  const last = ran.at(-1);
  return last ? { session, entry: last.uuid } : { unverified: `no /${skill} run in session ${session}'s transcript` };
}

/** An entry's own timestamp. An answer is bound only to a question posted before it, so an
 *  entry without one cannot be bound at all. */
const stampOf = (e: Record<string, any>): string | Unverified =>
  typeof e.timestamp === "string" && !Number.isNaN(Date.parse(e.timestamp)) ? e.timestamp : { unverified: "the entry carries no timestamp" };

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

export { canonical, codeUnitOrder } from "./canonical.js";
import { canonical } from "./canonical.js";

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
  const at = stampOf(result);
  if (isUnverified(at)) return at;
  return { session, toolUseId, entryId: String(result.uuid ?? ""), at, questions: asked.map(normalizeQuestion), answers };
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

// --- the reader ------------------------------------------------------------------------------

/** A reader agent, as the harness recorded it: launched, and calling `submit_verdict` itself. */
export interface ReaderAgent {
  agentId: string; session: string; toolUseId: string;
  /** When the parent's `Agent` call was made: the reader cannot have read words typed after it. */
  launchedAt: string;
  /** What it was launched with: the parent's `Agent` call input. */
  prompt: string;
  subagentType: string;
}

const AGENT = /^a[A-Za-z0-9]{6,63}$/;

function jsonl(file: string): Record<string, any>[] | undefined {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return undefined; }
  const out: Record<string, any>[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const v = JSON.parse(line); if (v && typeof v === "object" && !Array.isArray(v)) out.push(v); } catch { /* a torn last line */ }
  }
  return out;
}

/** Whether `e` holds an assistant `tool_use` with id `id`. */
const callsTool = (e: Record<string, any>, id: string): boolean =>
  e.type === "assistant" && Array.isArray(e.message?.content) && e.message.content.some((x: any) => x?.type === "tool_use" && x.id === id);

/**
 * The subagent `agentId`, verified as a separate agent the harness launched on this machine, up
 * to its call `callId` (docs/decision-rounds-worked-cases.md, "What a reader subagent leaves",
 * measured 2026-09-23; the MCP call measured 2026-09-24): its own
 * `<session>/subagents/agent-<id>.jsonl`, every entry a sidechain carrying its id, holding that
 * call; a meta file naming the parent's `Agent` call; and, in the parent's own transcript, that
 * call and a launch result naming the id. Plain files, so this is C14's strength and no more
 * (owner, the P7 gate). Fails closed on any shape it does not know.
 *
 * A message sent into it counts only BEFORE `callId` (Codex plan review, 2): one sent after the
 * reader has given its verdict cannot have shaped it.
 */
export function readReader(agentId: string, callId: string, dir: string = transcriptDir()): ReaderAgent | Unverified {
  if (!AGENT.test(agentId)) return { unverified: `not a subagent id: ${JSON.stringify(agentId)}` };
  let sessions: string[];
  try { sessions = readdirSync(dir).filter((s) => SESSION.test(s)); } catch { return { unverified: `no transcripts in ${dir}` }; }
  const session = sessions.find((s) => { try { return statSync(join(dir, s, "subagents", `agent-${agentId}.jsonl`)).isFile(); } catch { return false; } });
  if (!session) return { unverified: `no subagent ${agentId} in ${dir}` };
  let meta: any;
  try { meta = JSON.parse(readFileSync(join(dir, session, "subagents", `agent-${agentId}.meta.json`), "utf8")); } catch { return { unverified: `subagent ${agentId} has no readable meta file` }; }
  const toolUseId = meta?.toolUseId;
  if (typeof toolUseId !== "string" || !toolUseId) return { unverified: `subagent ${agentId}'s meta file names no call` };
  const own = jsonl(join(dir, session, "subagents", `agent-${agentId}.jsonl`));
  if (!own) return { unverified: `subagent ${agentId}'s transcript is unreadable` };
  // A fork inherits the conversation, and with it the agent's own reading (measured 2026-09-23:
  // its meta says `isFork`, and its transcript opens on a `fork-context-ref`, not its sidechain).
  if (meta?.isFork === true || meta?.agentType === "fork") return { unverified: `subagent ${agentId} is a fork: it inherits the conversation, so it is not blind to your reading` };
  if (!own.length || own.some((e) => e.isSidechain !== true || e.agentId !== agentId || e.sessionId !== session)) {
    return { unverified: `subagent ${agentId}'s transcript is not all its own sidechain` };
  }
  const at = own.findIndex((e) => callsTool(e, callId));
  if (at < 0) return { unverified: `subagent ${agentId}'s transcript does not hold call ${callId}` };
  // A second channel: a message sent into it after launch (`SendMessage`) — measured 2026-09-23 as
  // a `user` entry with an `origin` and text, where a reader's own turns are tool results. The
  // harness's own reminders are `isMeta` with no origin (measured 2026-09-24, right after launch).
  // It sees what the harness records in the sidechain, not text riding inside a tool result.
  if (own.slice(1, at).some((e) => e.type === "user" && !(e.isMeta === true && e.origin === undefined)
    && (e.origin !== undefined || !Array.isArray(e.message?.content) || !e.message.content.some((x: any) => x?.type === "tool_result")))) {
    return { unverified: `subagent ${agentId} was sent a message after it was launched: it may have been told how to read the words` };
  }
  const parent = entries(session, dir);
  if (isUnverified(parent)) return parent;
  const call = parent.find((e) => e.isSidechain !== true && Array.isArray(e.message?.content)
    && e.type === "assistant" && e.message.content.some((x: any) => x?.type === "tool_use" && x.id === toolUseId && x.name === "Agent"));
  const launched = parent.some((e) => e.type === "user" && e.isSidechain !== true && e.toolUseResult?.agentId === agentId
    && Array.isArray(e.message?.content) && e.message.content.some((x: any) => x?.type === "tool_result" && x.tool_use_id === toolUseId));
  if (!call || !launched) return { unverified: `session ${session} does not record launching subagent ${agentId}` };
  const input = call.message.content.find((x: any) => x?.type === "tool_use" && x.id === toolUseId)?.input;
  if (!input || typeof input.prompt !== "string") return { unverified: `session ${session}'s launch of subagent ${agentId} records no prompt` };
  if (input.subagent_type === "fork") return { unverified: `subagent ${agentId} is a fork: it inherits the conversation, so it is not blind to your reading` };
  const launchedAt = stampOf(call);
  if (isUnverified(launchedAt)) return launchedAt;
  return { agentId, session, toolUseId, launchedAt, prompt: input.prompt, subagentType: typeof input.subagent_type === "string" ? input.subagent_type : "" };
}

/** A submit_verdict call paired with its own result in the same transcript. */
export interface VerdictCall {
  session: string; agentId?: string; callId: string; at: string;
  result: "missing" | "held" | "failed" | "legacy-held";
  receipt?: string;
}

const SUBMIT = /(^|__)submit_verdict$/;

const resultObject = (v: unknown): any => {
  if (v && typeof v === "object") {
    if (Array.isArray(v)) return resultObject(v.find((x) => x?.type === "text")?.text);
    if ((v as any).content && !(v as any).held) return resultObject((v as any).content);
    return v;
  }
  if (typeof v === "string") { try { return resultObject(JSON.parse(v)); } catch { return undefined; } }
  return undefined;
};

/** The file mtime only saves scans; it says nothing about an individual call's age. */
export function findVerdictCalls(answer: string, verdict: string, since: number, dir: string = transcriptDir()): VerdictCall[] {
  const files: { file: string; session: string; agentId?: string }[] = [];
  let top: string[];
  try { top = readdirSync(dir); } catch { return []; }
  for (const name of top) {
    if (name.endsWith(".jsonl") && SESSION.test(name.slice(0, -6))) files.push({ file: join(dir, name), session: name.slice(0, -6) });
    else if (SESSION.test(name)) {
      let subs: string[] = [];
      try { subs = readdirSync(join(dir, name, "subagents")); } catch { /* no subagents */ }
      for (const s of subs) {
        const m = /^agent-(a[A-Za-z0-9]{6,63})\.jsonl$/.exec(s);
        if (m) files.push({ file: join(dir, name, "subagents", s), session: name, agentId: m[1]! });
      }
    }
  }
  const out: VerdictCall[] = [];
  for (const f of files) {
    try { if (statSync(f.file).mtimeMs < since) continue; } catch { continue; }
    const entries = jsonl(f.file);
    if (!entries) continue;
    for (const e of entries) {
      if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
      if (f.agentId ? e.isSidechain !== true || e.agentId !== f.agentId : e.isSidechain === true) continue;
      for (const x of e.message.content) {
        if (x?.type !== "tool_use" || typeof x.name !== "string" || !SUBMIT.test(x.name) || typeof x.id !== "string") continue;
        if (x.input?.answer !== answer || x.input?.verdict !== verdict) continue;
        const results = entries.filter((r) => r.type === "user" && r.isSidechain === e.isSidechain
          && (!f.agentId || r.agentId === f.agentId) && Array.isArray(r.message?.content)
          && r.message.content.some((b: any) => b?.type === "tool_result" && b.tool_use_id === x.id));
        let result: VerdictCall["result"] = "missing", receipt: string | undefined;
        if (results.length > 1) result = "failed";
        else if (results.length === 1) {
          const r = results[0]!;
          const block = r.message.content.find((b: any) => b?.type === "tool_result" && b.tool_use_id === x.id);
          const oneResult = r.message.content.filter((b: any) => b?.type === "tool_result").length === 1;
          const payload = (oneResult ? resultObject(r.toolUseResult) : undefined) ?? resultObject(block?.content);
          if (payload?.ok === true && payload?.held === true && typeof payload.receipt === "string" && payload.receipt) {
            result = "held"; receipt = payload.receipt;
          } else if ((payload?.ok === true && payload?.held === true && payload.receipt === undefined) || (payload === undefined && block?.content === "held")) result = "legacy-held";
          else result = "failed";
        }
        out.push({ session: f.session, ...(f.agentId ? { agentId: f.agentId } : {}), callId: x.id,
          at: typeof e.timestamp === "string" ? e.timestamp : "", result, ...(receipt ? { receipt } : {}) });
      }
    }
  }
  return out.sort((x, y) => x.at.localeCompare(y.at));
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
  return messageOf(session, entryId, e);
}

/**
 * Every message the person typed after `since` whose WHOLE text is `words` (edge whitespace
 * aside) — how `relay_answer` finds a message the agent can quote but not name. Part of a
 * message never matches, for the reason `readMessage` copies whole ones. The caller refuses
 * more than one.
 */
export function findMessages(words: string, since: string, dir: string = transcriptDir(), session?: string): PersonMessage[] | Unverified {
  const sessions = sessionsSince(since, dir, session);
  if (isUnverified(sessions)) return sessions;
  const out: PersonMessage[] = [];
  for (const s of sessions) {
    const all = entries(s, dir);
    if (isUnverified(all)) continue;
    for (const e of all) {
      if (typeof e.uuid !== "string") continue;
      const m = messageOf(s, e.uuid, e);
      if (!isUnverified(m) && m.text.trim() === words.trim() && Date.parse(m.at) > Date.parse(since)) out.push(m);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function messageOf(session: string, entryId: string, e: Record<string, any>): PersonMessage | Unverified {
  if (e.isSidechain === true) return { unverified: "the entry is a subagent's" };
  if (e.type === "user") {
    if (e.origin?.kind !== "human") return { unverified: `the entry's origin is ${JSON.stringify(e.origin?.kind ?? null)}, not the person` };
    if (e.toolUseResult !== undefined) return { unverified: "the entry is a tool result" };
    const text = textOf(e.message?.content);
    if (text === undefined) return { unverified: "the message is not plain text" };
    const at = stampOf(e);
    return isUnverified(at) ? at : { session, entryId, text, at };
  }
  if (e.type === "attachment" && e.attachment?.type === "queued_command") {
    // Measured: a queued command carries its origin on the attachment, not the entry.
    const kind = e.attachment.origin?.kind;
    if (kind !== "human") return { unverified: `the queued message's origin is ${JSON.stringify(kind ?? null)}, not the person` };
    const text = textOf(e.attachment.prompt);
    if (text === undefined) return { unverified: "the queued message is not plain text" };
    const at = stampOf(e);
    return isUnverified(at) ? at : { session, entryId, text, at };
  }
  return { unverified: `entry ${entryId} is a ${String(e.type)}, not a message the person typed` };
}

/** A comparison reader's successful submit call/result, correlated by its held receipt. */
export function findComparisonCalls(requestId: string, verdict: string, rationale: string,
  dir: string = transcriptDir()): VerdictCall[] {
  const files: { file: string; session: string; agentId?: string }[] = [];
  let top: string[];
  try { top = readdirSync(dir); } catch { return []; }
  for (const name of top) {
    if (name.endsWith(".jsonl") && SESSION.test(name.slice(0, -6)))
      files.push({ file: join(dir, name), session: name.slice(0, -6) });
    else if (SESSION.test(name)) {
      let subs: string[] = [];
      try { subs = readdirSync(join(dir, name, "subagents")); } catch { /* no subagents */ }
      for (const subName of subs) {
        const m = /^agent-(a[A-Za-z0-9]{6,63})\.jsonl$/.exec(subName);
        if (m) files.push({ file: join(dir, name, "subagents", subName), session: name, agentId: m[1]! });
      }
    }
  }
  const out: VerdictCall[] = [];
  for (const file of files) {
    const rows = jsonl(file.file);
    if (!rows) continue;
    for (const row of rows) {
      if (row.type !== "assistant" || !Array.isArray(row.message?.content)) continue;
      if (file.agentId ? row.isSidechain !== true || row.agentId !== file.agentId : row.isSidechain === true) continue;
      for (const call of row.message.content) {
        if (call?.type !== "tool_use" || !/(^|__)submit_comparison_judgment$/.test(call.name ?? "")
          || typeof call.id !== "string" || call.input?.request !== requestId
          || call.input?.verdict !== verdict || call.input?.rationale !== rationale) continue;
        const results = rows.filter((result) => result.type === "user" && result.isSidechain === row.isSidechain
          && (!file.agentId || result.agentId === file.agentId) && Array.isArray(result.message?.content)
          && result.message.content.some((block: any) => block?.type === "tool_result" && block.tool_use_id === call.id));
        let state: VerdictCall["result"] = "missing", receipt: string | undefined;
        if (results.length > 1) state = "failed";
        else if (results.length === 1) {
          const result = results[0]!;
          const block = result.message.content.find((x: any) => x?.type === "tool_result" && x.tool_use_id === call.id);
          const single = result.message.content.filter((x: any) => x?.type === "tool_result").length === 1;
          const payload = (single ? resultObject(result.toolUseResult) : undefined) ?? resultObject(block?.content);
          if (payload?.ok === true && payload?.held === true && typeof payload.receipt === "string" && payload.receipt) {
            state = "held"; receipt = payload.receipt;
          } else state = "failed";
        }
        out.push({ session: file.session, ...(file.agentId ? { agentId: file.agentId } : {}),
          callId: call.id, at: typeof row.timestamp === "string" ? row.timestamp : "", result: state,
          ...(receipt ? { receipt } : {}) });
      }
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Subagent `agentId`'s own call `callId` to a codemap tool whose name matches `tool`, verified
 * the way `readReader` verifies a reader (its own sidechain, launched by the named session, no
 * message sent in first), with the call's arguments and the result the tool gave it. One call
 * and one result, or unverified: a retry makes a second call, which is a second submission.
 */
export function readSubagentCall(agentId: string, callId: string, tool: RegExp, dir: string = transcriptDir()):
  { reader: ReaderAgent; input: any; result: any } | Unverified {
  const reader = readReader(agentId, callId, dir);
  if (isUnverified(reader)) return reader;
  const own = jsonl(join(dir, reader.session, "subagents", `agent-${agentId}.jsonl`)) ?? [];
  const calls = own.filter((e) => e.type === "assistant").flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : [])
    .filter((x: any) => x?.type === "tool_use" && x.id === callId));
  if (calls.length !== 1 || !tool.test(String(calls[0]!.name ?? ""))) return { unverified: `subagent ${agentId} made no single ${tool.source} call ${callId}` };
  const results = own.filter((e) => e.type === "user" && Array.isArray(e.message?.content))
    .flatMap((e) => e.message.content.filter((x: any) => x?.type === "tool_result" && x.tool_use_id === callId).map((x: any) => ({ e, x })));
  if (results.length !== 1) return { unverified: `subagent ${agentId}'s call ${callId} has no single result` };
  // A row's `toolUseResult` is the row's, not the block's: trust it only when the row holds one result.
  const { e, x } = results[0]!;
  const single = e.message.content.filter((y: any) => y?.type === "tool_result").length === 1;
  return { reader, input: calls[0]!.input, result: (single ? resultObject(e.toolUseResult) : undefined) ?? resultObject(x.content) };
}

/** How long a held submission may go unfound on disk before it is invalid. The call reaches its
 *  transcript ~12 ms after it returns (measured 2026-09-24). */
export const verdictGraceMs = () => Number(process.env.CODEMAP_VERDICT_GRACE_MS ?? 60_000);

/**
 * The one subagent call to `tool` whose own result returned `receipt`, verified as
 * `readSubagentCall` verifies it. Found by the receipt, as `findVerdictCalls` finds a reader's
 * verdict, rather than by ids the caller passes: a mistyped id would settle the receipt invalid.
 * Not found, or found more than once, is `pending` until the receipt is older than the grace and
 * unverified after — a call this machine's transcripts never show (a directory codemap cannot
 * see) must not read as "try again" for ever.
 */
export function readReceiptCall(tool: RegExp, receipt: string, heldAt: string, dir: string = transcriptDir()):
  { agentId: string; callId: string; reader: ReaderAgent; input: any; result: any } | Unverified | { pending: string } {
  const found: { agentId: string; callId: string }[] = [];
  let top: string[] = [];
  try { top = readdirSync(dir).filter((s) => SESSION.test(s)); } catch { /* nothing found */ }
  for (const session of top) {
    let subs: string[] = [];
    try { subs = readdirSync(join(dir, session, "subagents")); } catch { continue; }
    for (const name of subs) {
      const agentId = /^agent-(a[A-Za-z0-9]{6,63})\.jsonl$/.exec(name)?.[1];
      const rows = agentId ? jsonl(join(dir, session, "subagents", name)) : undefined;
      if (!agentId || !rows) continue;
      for (const row of rows) {
        if (row.type !== "user" || !Array.isArray(row.message?.content)) continue;
        const blocks = row.message.content.filter((x: any) => x?.type === "tool_result");
        for (const block of blocks) {
          const payload = (blocks.length === 1 ? resultObject(row.toolUseResult) : undefined) ?? resultObject(block.content);
          if (payload?.held !== true || payload?.receipt !== receipt || typeof block.tool_use_id !== "string") continue;
          const called = rows.some((e) => e.type === "assistant" && Array.isArray(e.message?.content)
            && e.message.content.some((x: any) => x?.type === "tool_use" && x.id === block.tool_use_id && tool.test(String(x.name ?? ""))));
          if (called) found.push({ agentId, callId: block.tool_use_id });
        }
      }
    }
  }
  if (found.length !== 1) {
    const what = found.length ? `${found.length} calls returned receipt ${receipt}` : `no subagent call that returned receipt ${receipt} is in ${dir}`;
    return Date.now() - Date.parse(heldAt) > verdictGraceMs() ? { unverified: `${what}, past the grace` } : { pending: `${what} yet` };
  }
  const { agentId, callId } = found[0]!;
  const call = readSubagentCall(agentId, callId, tool, dir);
  return isUnverified(call) ? call : { agentId, callId, ...call };
}
