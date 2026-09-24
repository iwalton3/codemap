/**
 * Decision rounds, folded from `decisions/<universe>`.
 *
 * Five events: `decision.round.posted`, `decision.confirm.posted`, `decision.question.logged`,
 * `decision.answer.recorded` and `decision.reading.recorded`. The rules are the owner's, word
 * for word in docs/decision-rounds-worked-cases.md and the review rounds' `owner.md` files;
 * the C/H/S-numbers below are theirs.
 *
 * **A ruling is not its carrying-out.** The answer is the person's ruling and stands as given.
 * Carrying it out — closing a finding — is the verifier's act (I9) or a person's in session, in
 * the FINDINGS scope. So this record never stores "carried out": the finding record is the one
 * authority for that, and `ruledNotCarriedOut` joins the two at read time.
 *
 * **Which answer stands is derived from the set, never from recording order** (owner, 2026-09-23,
 * plan A2). The fold records each answer's facts; `standing` ranks them when read: verified
 * before unverified, then the later GIVEN, then the later in the log. Nothing here marks an
 * answer "superseded" — a flag set in recording order is how the same two events gave two
 * rulings in two orders.
 *
 * **Verification happens before the log** (owner: "verification needs to happen before it ends
 * up in the fold"). A logged question, a relayed message or a reader's `submit_verdict` was checked
 * against the transcript on the machine that asked; a clone cannot re-read that transcript and
 * trusts the logger for it. Everything that travels is checked here.
 */
import { createHash } from "node:crypto";
import { causality, emitEvent, type LogEvent } from "./eventlog.js";
import { isAgentActor } from "./identity.js";
import { canonical, normalizeQuestion, sameQuestion } from "./transcript.js";
import { ISO_DATE, type Actor, type AskedQuestion, type Decision, type DecisionEffect, type DecisionOption, type DecisionRound, type LoggedQuestion } from "./schema.js";

export const decisionScope = (universe: string): string => `decisions/${universe}`;

/** How an answer reached the log. */
export type AnswerVia =
  /** An `AskUserQuestion` call, logged by `log_question`. */
  | { kind: "question"; question: string }
  /** The person's whole typed message, copied from the transcript by its entry id, with
   *  when they typed it and the round the relaying agent says it answered (H5). */
  | { kind: "message"; session: string; entryId: string; text: string; at: string; round: string }
  /** An agent's words the transcript could not confirm. Unblocks only (C8). */
  | { kind: "unverified"; words: string }
  /** The person on the page. `checked` is a bulk decision's items to rule on separately. */
  | { kind: "direct"; option?: string; park?: string; words?: string; checked?: string[] };

export interface Mapping { decision: string; option: string | null }

/** One effect an answer ruled, finding by finding. */
export interface Ruled { finding: string; on: "settle" | "unblock"; as?: "refuted" }

export interface FoldedAnswer {
  id: string;
  by: Actor;
  at: string;
  via: AnswerVia["kind"];
  /** The words are the person's (C8): an unverified answer's settles wait for them. */
  verified: boolean;
  /** When the person gave it — the transcript entry's time, or the page's — never when it
   *  was recorded: between two verified answers, the later GIVEN stands (H7.9). */
  givenAt: string;
  /** Log position of the event that made it: breaks a tie in `givenAt` (S0.5). */
  seq: number;
  /** Replacement postings visible when this answer was admitted. */
  knownReplacements: string[];
  /** Original answer event for a reading copied onto another question. */
  sourceAnswer?: string;
  /** Original answer events this writer had not yet received. Human knowledge may differ. */
  concurrentWith?: string[];
  /** A verified choice keeps this source visible but removes it from actionable ranking. */
  resolvedOutBy?: string;
  /** What it was given through, so one call or message answers a decision once (B1.4). */
  once?: string;
  /** The person's words as recorded — never an agent's summary of them. */
  words: string;
  /** The options (or bulk items) this answer ruled, directly or through a binding. */
  options: string[];
  /** What those options rule, finding by finding. */
  ruled: Ruled[];
  /** Settles it chose but could not rule, because it is unverified (C8). They wait for you. */
  unruled: string[];
  park?: string;
  /** An unverified park: it applies nothing and waits for you (owner: "an awaits you flag"). */
  parkWaits?: string;
  /** Bulk items checked to be ruled on separately; each waits for a decision of its own. */
  separately?: string[];
  /** Words waiting for a binding — unread, read as unclear, or read two ways. Outside the
   *  ranking until bound (plan A2): typed words compete only once something binds them. */
  free: boolean;
  /** Bound, and bound to no option here (`D<n> → (none)`): it ranks, rules nothing, and
   *  waits on the person (S0.5). */
  nothing?: true;
  /** Bound, and about OTHER questions only: it answers nothing here and never ranks here. */
  elsewhere?: true;
  relayedBy?: string;
  /** The reader's verdict, parsed by codemap from the reader's own `submit_verdict` call (plan B1, Q2.2). */
  reading?: {
    id: string; agree: boolean;
    knownReplacements: string[];
    reader: { agent: string; maps: Mapping[]; launchedAt: string };
    session: { reading: string; maps: Mapping[] };
    asks?: string;
    /** The reader could not tell which question the words answer, and why: nothing binds (H5). */
    unclear?: string;
  };
  /** Bound by the person's pick on a confirm of these words: `answer` is that pick. */
  confirmed?: { answer: string; at: string; maps: Mapping[] };
  /** Readings the person said were not what they meant — never offered again. */
  rejected?: Mapping[][];
  /** Accepted, but looks errant — shown, never silently applied as if ordinary (R19). */
  flags?: string[];
}

export interface FoldedDecision extends Decision {
  hash: string;
  /** When THIS decision was posted — not its round: a round can grow after it is posted, so
   *  "posted before the words" is judged per decision. Empty when the event carried no time. */
  postedAt: string;
  postingEvent: string;
  answers: FoldedAnswer[];
  /** A decision posted later that replaces this one. */
  replacedBy?: string;
  /** It was posted to replace a decision another had already replaced — two clones replacing
   *  at once. The first in log order replaces; this one stays a live question (H6.4). */
  replaceLost?: string;
  /** Decisions posted since, citing an answer here as their origin (C1, bulk items). */
  followUps?: string[];
  /** A confirm-this-reading question. `invalid` says why it is not one codemap could have
   *  written: then it has no authority to act (owner, 2026-09-24 Q3), and `never` says the words
   *  it names were never recorded at all (Q2.3 (4)). `picked` is the latest verified pick on it
   *  that carries a confirm's meaning: the request is answered (Q1.3). */
  confirms?: Confirms & { invalid?: string; never?: true; picked?: string };
  resolutionInvalid?: string;
}

export interface SharedDecisions {
  rounds: DecisionRound[];
  decisions: FoldedDecision[];
  questions: LoggedQuestion[];
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** A time as milliseconds, or undefined when it does not parse. An unknown time never satisfies
 *  an ordering claim in either direction: nothing is "before" it and nothing is "after" it. */
const ms = (s: string | undefined): number | undefined => { const t = Date.parse(s ?? ""); return Number.isNaN(t) ? undefined : t; };

/** What an answer binds to: the question as shown and every option's effects. */
export function decisionHash(d: Pick<Decision, "kind" | "payload" | "options">): string {
  return "d:sha256:" + createHash("sha256")
    .update(canonical({ kind: d.kind, payload: normalizeQuestion(d.payload), options: d.options })).digest("hex").slice(0, 24);
}

/** A posted decision the fold will hold, or why not. Shared with the posting ops, so an op
 *  refuses exactly what the fold would drop. */
export function checkDecision(d: Decision): string | null {
  // A fold drops garbage; it never throws on it, or one bad line blocks the whole scope.
  if (!d || typeof d !== "object" || !Array.isArray(d.options) || !d.options.every((o) => o && typeof o === "object" && typeof o.label === "string" && Array.isArray(o.effects))) {
    return "a decision needs options, each with a label and effects";
  }
  if (!d.payload || typeof d.payload !== "object" || !str(d.payload.question) || !Array.isArray(d.payload.options)
    || !d.payload.options.every((o) => o && typeof o === "object" && typeof o.label === "string")) {
    return "the payload is not an AskUserQuestion question";
  }
  if (!str(d.id) || !str(d.round) || !/^D\d+$/.test(typeof d.ref === "string" ? d.ref : "")) return "a decision needs an id, a round and a ref like D2";
  if (d.kind !== "options" && d.kind !== "words" && d.kind !== "bulk") return "kind must be options, words or bulk";
  const labels = d.payload.options.map((o) => o.label);
  // A pick is recorded by label, so two options sharing one could not be told apart (bulk 8).
  if (new Set(labels).size !== labels.length) return "two options share a label";
  if (d.options.length !== labels.length || d.options.some((o, i) => o.label !== labels[i])) {
    return "the options must be the payload's options, in order";
  }
  const multi = d.payload.multiSelect === true;
  if (d.kind === "bulk") {
    if (!multi) return "a bulk decision is a multi-select question";
    if (d.options.filter((o) => o.approveAll).length !== 1) return "a bulk decision carries exactly one approve-all option, because an empty multi-select cannot be submitted";
  } else if (d.options.some((o) => o.approveAll)) return "only a bulk decision has an approve-all option";
  for (const o of d.options) {
    if (d.kind === "words" && o.effects.length) return "a words decision has no effects";
    if (o.approveAll && o.effects.length) return "the approve-all option has no effects of its own";
    for (const e of o.effects as unknown[]) {
      if (!e || typeof e !== "object") return "an effect must be an object";
      const x = e as DecisionEffect;
      if ((x.on !== "settle" && x.on !== "unblock") || !Array.isArray(x.findings) || !x.findings.length || !x.findings.every((f) => str(f))) return "an effect needs findings and on: settle | unblock";
      // Refused rather than defaulted: a default would record "accepted, won't fix" as "the
      // finding was wrong" (owner, 2026-09-23).
      if (x.on === "settle" && x.as !== "refuted") return `a settle must say how it closes — as: "refuted" is the only state until finding states can say "accepted"`;
      if (x.on === "unblock" && x.as !== undefined) return "an unblock closes nothing, so it takes no `as`";
    }
    if (o.park !== undefined) {
      if (multi) return "a multi-select question cannot offer a park: picked with other options it means nothing (owner, 2026-09-23)";
      // A park with no date in the verified text is not a park (C23).
      if (typeof o.park !== "string" || !ISO_DATE.test(o.park) || !o.label.includes(o.park.slice(0, 10))) return `option "${o.label}" parks without its date in the label`;
    }
  }
  if (d.resolves) {
    const ids = d.resolves.answers;
    if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((id) => str(id)) || ids[0] === ids[1]
      || d.kind !== "options" || multi || d.options.length !== 2
      || d.options.some((o, i) => o.label !== `Preserve ${ids[i]}` || o.effects.length || o.park)
      || ids.some((id) => !d.payload.question.includes(id))) return "a resolution must show two answer ids and offer one effect-free Preserve option per answer";
  }
  if (d.options.filter((o) => o.recommended).length > 1) return "at most one option is recommended";
  // What the person is shown carries what it acts on, so words typed back can be bound to it
  // by what was said (owner, H2/H5: "the question should just say 'Close D13 (f_09deadcafef3)?'").
  if (!new RegExp(`\\b${d.ref}\\b`).test(d.payload.question)) return `the question text must name its ref ${d.ref}`;
  for (const o of d.options) for (const e of o.effects) for (const f of e.findings) {
    if (!d.payload.question.includes(f)) return `the question text must name ${f}, which option "${o.label}" acts on`;
  }
  return null;
}

// --- confirm-this-reading (owner, the impl-2 discussion; P2.1 (1), (2); P3.1–P3.5) ---------------
//
// A POSTED decision, in the words' own round: `confirm_reading` writes it with codemap's text,
// the person is asked it verbatim and it is logged like any question. The fold checks its
// STRUCTURE against the real answer and options (P3.4), never its wording, so a later build that
// rewords it strands no open confirm. One that fails that check stays visible but cannot act; one
// that fails `checkDecision`, like any posted question, is dropped (owner, Q2.3 (3)).

export const CONFIRM_YES = "Yes";
export const CONFIRM_NO = "No — ask me again";
export const NONE = "(none)";
const READING = /^Reading ([12])$/;

/** What a confirm asks about: the words (an answer id) and the one or two readings offered. */
export interface Confirms { answer: string; readings: Mapping[][]; knownReplacements?: string[] }

const effectText = (o: DecisionOption): string => o.effects.map((e) => e.on === "settle" ? `settles ${e.findings.join(", ")} as ${e.as}` : `unblocks ${e.findings.join(", ")}`).join("; ");

/** Groups a reading's lines by decision, in the order the reading names them. */
const byDecision = (maps: Mapping[]): Map<string, (string | null)[]> => {
  const out = new Map<string, (string | null)[]>();
  for (const m of maps) out.set(m.decision, [...(out.get(m.decision) ?? []), m.option]);
  return out;
};

/** A confirm line's `D<n> → <labels>` — the part the fold checks exactly. */
/** What a verified pick labelled `label` on a valid confirm offering `rs` says: the reading it
 *  binds, `null` for "No — ask me again", or undefined when it says nothing (P3.2). */
const meaning = (label: string | undefined, rs: Mapping[][]): Mapping[] | null | undefined => {
  const n = READING.exec(label ?? "")?.[1];
  return label === CONFIRM_YES && rs.length === 1 ? rs[0]! : n && rs.length === 2 ? rs[Number(n) - 1]! : label === CONFIRM_NO && rs.length === 1 ? null : undefined;
};

const lineHead = (t: Pick<Decision, "ref">, picks: (string | null)[]): string => `${t.ref} → ${picks.map((p) => p ?? NONE).join(", ")}`;

/**
 * Everything picking `picks` on `t` does, as the person reads it (owner, P2.1 (2)): what it
 * settles and unblocks, and every finding of `t` it releases or leaves held — a bulk decision's
 * approved items with their effects too. As of when the words were typed: whether that ruling
 * still stands is ranked, and this text cannot follow a later answer.
 */
function actionLine(t: Pick<Decision, "ref" | "kind" | "options">, picks: (string | null)[]): string {
  const fs = named(t);
  const held = (xs: string[]) => (xs.length ? `${xs.join(", ")} stay held` : "");
  const join = (...parts: string[]) => `${lineHead(t, picks)} (${parts.filter(Boolean).join("; ")})`;
  if (picks.every((p) => p === null)) return join(`rules nothing on ${t.ref}`, held(fs));
  const chosen = picks.filter((p): p is string => p !== null).map((p) => t.options.find((o) => o.label === p)!);
  if (t.kind === "bulk") {
    const checked = chosen.some((o) => o.approveAll) ? [] : chosen;
    const approved = t.options.filter((o) => !o.approveAll && !checked.includes(o));
    return join(
      checked.length ? `checked, ruled on separately: ${checked.map((o) => o.label).join(", ")}` : "",
      held([...new Set(checked.flatMap((o) => o.effects.flatMap((e) => e.findings)))]),
      approved.length ? `approves ${approved.map((o) => `${o.label}${o.effects.length ? ` (${effectText(o)})` : ""}`).join("; ")}` : "",
    );
  }
  const park = chosen.length === 1 ? chosen[0]!.park : undefined;
  if (park) return join(`parks until ${park.slice(0, 10)}`, held(fs));
  const touched = new Set(chosen.flatMap((o) => o.effects.flatMap((e) => e.findings)));
  return join(...chosen.map(effectText), fs.some((f) => !touched.has(f)) ? `releases ${fs.filter((f) => !touched.has(f)).join(", ")}` : "");
}

/**
 * The confirm question `ref` for words `a` on `d`: one reading (Yes / No — ask me again; Other is
 * the person's own words, read like any reply), or the two readings of a dispute as options.
 */
export function confirmPayload(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, readings: Mapping[][], ref: string): AskedQuestion {
  // Lines in one order whatever order the reading was given in, so one reading is one text. The
  // fold checks each line against the STORED reading's order, so a poster stores `canonicalMaps` too.
  const rendered = readings.map((r) => [...byDecision(canonicalMaps(r))].map(([id, picks]) => actionLine(decisions.get(id)!, picks)));
  // JSON-quoted, so words with a newline stay on one line and cannot pass for an action line.
  const words = `You typed at ${a.givenAt}:\n${JSON.stringify(a.words)}`;
  if (readings.length === 1) {
    return normalizeQuestion({
      question: `${ref}: confirm how your words on ${d.ref} (answer ${a.id}, round ${d.round}) are read. ${words}\n${rendered[0]!.join("\n")}\nAs of when you typed it, is that what you meant?`, header: "Confirm",
      options: [{ label: CONFIRM_YES, description: "Bind exactly the action above, as of when you typed it" }, { label: CONFIRM_NO, description: "Not what I meant: ask the question again" }],
    });
  }
  return normalizeQuestion({
    question: `${ref}: your words on ${d.ref} (answer ${a.id}, round ${d.round}) were read two ways. ${words}\n${rendered.map((r, i) => `Reading ${i + 1}:\n${r.join("\n")}`).join("\n")}\nWhich did you mean, as of when you typed it?`, header: "Confirm",
    options: rendered.map((r, i) => ({ label: `Reading ${i + 1}`, description: r.join("; ") })),
  });
}

/**
 * Why posted confirm `c` is not one codemap could have written for the log as folded, or null
 * (P3.4). It is kept either way — the fold never drops a posted question (P2.1 (4)) — but only
 * a confirm that passes carries a confirm's meaning. A ref two questions share is NOT checked
 * here: it is judged as the posting clone saw the round, which only `confirm_reading` can
 * (owner, Q2.1), so a later pull never voids a pick already given.
 */
function confirmRefusal(decisions: Map<string, FoldedDecision>, c: FoldedDecision, target: { a: FoldedAnswer; d: FoldedDecision } | undefined): string | null {
  const cf = c.confirms!;
  if (ms(c.postedAt) === undefined) return "it has no posting time";
  if (!target) return `the words it confirms (${cf.answer}) are not an answer here`;
  const { d, a } = target;
  if (d.round !== c.round) return "it is not in the round of the words it confirms";
  if (d.confirms) return "it confirms words on another confirm";
  if (!Array.isArray(cf.readings) || !cf.readings.length || cf.readings.length > 2) return "it offers no reading, or more than two";
  const labels = cf.readings.length === 1 ? [CONFIRM_YES, CONFIRM_NO] : ["Reading 1", "Reading 2"];
  if (c.kind !== "options" || c.payload.multiSelect || c.options.length !== 2 || c.options.some((o, i) => o.label !== labels[i] || o.effects.length || o.park)) return "its options are not the confirm's";
  const q = c.payload.question;
  if (!new RegExp(`\\b${d.ref}\\b`).test(q) || !q.includes(a.id)) return `its question does not name ${d.ref} and answer ${a.id}`;
  const sections = cf.readings.length === 1 ? [q.split("\n")] : q.split(/\nReading [12]:\n/).slice(1).map((s) => s.split("\n"));
  if (sections.length !== cf.readings.length) return "its question does not set out each reading";
  for (const [i, r] of cf.readings.entries()) {
    if (!validMaps(r)) return "a reading it offers is empty";
    const known = a.reading ? a.reading.knownReplacements : (cf.knownReplacements ?? a.knownReplacements);
    const why = bindRefusal(decisions, d, a, r, known);
    if (why) return `a reading it offers cannot bind: ${why}`;
    const heads = sections[i]!.filter((l) => /^D\d+ → /.test(l));
    const want = [...byDecision(r)];
    if (heads.length !== want.length) return "its action lines are not one per decision the reading maps";
    for (const [id, picks] of want) {
      const t = decisions.get(id)!, head = lineHead(t, picks);
      if (!heads.some((l) => l === head || l.startsWith(`${head} (`))) return `it has no action line ${head}`;
      const missing = named(t).find((f) => !q.includes(f));
      if (missing) return `its question does not name ${missing}, which ${t.ref} acts on`;
    }
  }
  return null;
}

// --- the reader's brief (owner, P1.4 + P3.4) -------------------------------------------------
//
// Codemap writes what the reader is told, so it cannot carry the agent's own reading. The op
// compares the reader's launch prompt with it exactly; the fold, which cannot read transcripts,
// checks the stored text's STRUCTURE — so a later build that rewords it strands nothing. The
// reader ends by calling `submit_verdict` itself (owner, Q2.2): see `ops/decisions.ts`.

const BRIEF_WORDS = "Their words, exactly as typed (JSON-quoted):";
const BRIEF_Q = /^(D\d+): (".*")$/, BRIEF_OPTS = /^ {2}options: (\[.*\])$/;
export interface BriefEntry { id: string; hash: string; ref: string }
export const briefManifest = (decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): BriefEntry[] =>
  readable(decisions, d, a).map((t) => ({ id: t.id, hash: t.hash, ref: t.ref }));

/** Questions these words could bind in their admission context. Current supersession can
 *  still refuse a NEW reading of an unread answer. */
export const readable = (decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): FoldedDecision[] =>
  [...decisions.values()].filter((t) => t.round === d.round && !bindRefusal(decisions, d, a, [{ decision: t.id, option: null }]));

/** The reader's exact prompt for words `a` on `d`: the words, the questions and the verdict
 *  format — nothing of anyone's reading of them. */
export function readerBrief(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): string {
  const qs = readable(decisions, d, a);
  const shared = [...new Set(qs.map((t) => t.ref).filter((r, i, all) => all.indexOf(r) !== i))];
  return [
    "A person was asked the questions below and typed a reply. Say which of the questions their words answer, and with which option. Read only the words: nobody has told you how anyone else reads them.",
    "",
    BRIEF_WORDS,
    JSON.stringify(a.words),
    "",
    `The questions (round ${d.round}), each with its exact option labels:`,
    ...qs.flatMap((t) => [`${t.ref}: ${JSON.stringify(t.payload.question)}`, `  options: ${JSON.stringify(t.options.map((o) => o.label))}`]),
    ...shared.map((r) => `Two questions share the ref ${r}: a line naming ${r} is refused as ambiguous.`),
    "",
    `When you have decided, call the codemap MCP tool \`submit_verdict\` yourself, once, with \`answer: "${a.id}"\` and \`verdict\`: one line per pick, \`D<n> → <exact option label>\`; \`D<n> → ${NONE}\` where the words answer that question with none of its options; or, if you cannot tell which question they answer, the single line \`unclear: <why>\`. That call is your answer; then stop.`,
  ].join("\n");
}

/** The questions a stored brief lists, or why it is not one codemap wrote for words `a` on `d`:
 *  it quotes the words exactly, and every question it lists is one the words may be read onto,
 *  with its exact labels. */
export function briefListing(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, brief: string, manifest?: BriefEntry[]): FoldedDecision[] | string {
  const lines = brief.split("\n");
  const w = lines.indexOf(BRIEF_WORDS);
  let words: unknown;
  try { words = w < 0 ? undefined : JSON.parse(lines[w + 1] ?? ""); } catch { /* not JSON */ }
  if (words !== a.words) return "the reader's brief does not quote the words exactly";
  const listed: FoldedDecision[] = [];
  const candidates = [...decisions.values()].filter((t) => t.round === d.round && t.kind !== "words"
    && !t.confirms?.invalid && ms(t.postedAt) !== undefined && ms(t.postedAt)! < ms(a.givenAt)!);
  const entries = manifest === undefined ? undefined : Array.isArray(manifest) && manifest.every((m) => m && typeof m.id === "string" && typeof m.hash === "string" && typeof m.ref === "string") ? manifest : null;
  if (entries === null) return "the reader's brief has a malformed manifest";
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = BRIEF_Q.exec(lines[i]!);
    if (!m) continue;
    let question: unknown, labels: unknown;
    try { question = JSON.parse(m[2]!); labels = JSON.parse(BRIEF_OPTS.exec(lines[i + 1] ?? "")?.[1] ?? ""); } catch { return `the reader's brief lists ${m[1]} unreadably`; }
    const matches = candidates.filter((x) => x.ref === m[1] && x.payload.question === question
      && Array.isArray(labels) && labels.length === x.options.length && x.options.every((o, j) => o.label === labels[j]));
    if (!matches.length) return `the reader's brief lists ${m[1]} as a question these words cannot be read onto, or with other labels`;
    if (entries) {
      const e = entries[at++], t = matches.find((x) => x.id === e?.id);
      if (!t || t.hash !== e!.hash || t.ref !== e!.ref) return `the reader's brief manifest does not identify ${m[1]} and its exact hash`;
      listed.push(t);
    } else listed.push(...matches);
  }
  if (entries && at !== entries.length) return "the reader's brief manifest has a different number of questions";
  const unique = [...new Map(listed.map((t) => [t.id, t])).values()];
  const shared = [...new Set(unique.map((t) => t.ref).filter((r, i, all) => all.indexOf(r) !== i))];
  for (const ref of shared) if (!lines.includes(`Two questions share the ref ${ref}: a line naming ${ref} is refused as ambiguous.`))
    return `the reader's brief omits its ambiguity warning for ${ref}`;
  return unique;
}

/** Why a stored brief is not one codemap wrote for words `a` on `d` with this verdict, or null:
 *  `briefListing`'s checks, every decision the verdict names is listed, and none is a ref two
 *  listed questions share. With no verdict, whether the brief itself still stands. */
export function briefRefusal(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, brief: string, verdict: Mapping[], manifest?: BriefEntry[]): string | null {
  const got = briefListing(decisions, d, a, brief, manifest);
  if (typeof got === "string") return got;
  const listed = new Set(got.map((t) => t.id));
  const missing = verdict.find((m) => !listed.has(m.decision));
  if (missing) return `the verdict names ${decisions.get(missing.decision)?.ref ?? missing.decision}, which the reader's brief did not list`;
  // Judged against the brief the reader read, never the round as folded now (owner, Q2.1): a
  // question pulled later cannot make an accepted line ambiguous.
  const refs = [...listed].map((id) => decisions.get(id)!.ref);
  const shared = verdict.find((m) => refs.filter((r) => r === decisions.get(m.decision)!.ref).length > 1);
  return shared ? `the verdict names ${decisions.get(shared.decision)!.ref}, which two questions in the reader's brief share: it is ambiguous` : null;
}

// --- the fold -------------------------------------------------------------------------

/** What an answer says, before it is applied. */
interface Resolved {
  verified: boolean;
  words: string;
  /** Options picked (for a bulk decision: the items CHECKED, or the approve-all option). */
  picked: DecisionOption[];
  park?: string;
  free: boolean;
  /** When given, if not when recorded. */
  givenAt?: string;
  once?: string;
}

/** Rule `picked` onto answer `a` — the one place an answer's picks become its facts. */
function rule(d: FoldedDecision, a: FoldedAnswer, r: Pick<Resolved, "picked" | "park">, verified: boolean): void {
  const park = r.park ?? (r.picked.length === 1 ? r.picked[0]!.park : undefined);
  if (park !== undefined) {
    // Principal-only and dated (C23): unverified, it applies nothing and waits for you.
    if (!verified) { a.parkWaits = park.slice(0, 10); return; }
    a.park = park.slice(0, 10);
    // A valid park is accepted; one that looks errant is flagged, not refused (R19).
    const offered = d.options.map((o) => o.park?.slice(0, 10)).filter(Boolean);
    a.flags = [
      ...(!offered.includes(a.park) ? [`park date ${a.park} is not one this decision offered${offered.length ? ` (${offered.join(", ")})` : ""}`] : []),
      ...(a.park < a.givenAt.slice(0, 10) ? [`park date ${a.park} had already passed when it was answered`] : []),
    ];
    if (!a.flags.length) delete a.flags;
    return;
  }
  let chosen = r.picked;
  if (d.kind === "bulk") {
    const all = r.picked.some((o) => o.approveAll);
    // "None — approve all" beside a checked item says two things at once: it is read, not guessed.
    if (all && r.picked.length > 1) { a.free = true; return; }
    const checked = new Set(r.picked.map((o) => o.label));
    a.separately = d.options.filter((o) => !o.approveAll && checked.has(o.label)).map((o) => o.label);
    chosen = d.options.filter((o) => !o.approveAll && !checked.has(o.label));
  }
  for (const o of chosen) {
    for (const eff of o.effects) {
      for (const f of eff.findings) {
        // An unverified answer only unblocks (C8): its settles wait for you.
        if (eff.on === "settle" && !verified) { if (!a.unruled.includes(f)) a.unruled.push(f); continue; }
        a.ruled.push({ finding: f, on: eff.on, ...(eff.as ? { as: eff.as } : {}) });
      }
    }
    a.options.push(o.label);
  }
}

/** A reading of words onto questions: at least one `{ decision, option | null }` (P2.1 (3)).
 *  Shared with the ops, so they refuse exactly what the fold drops. */
export const validMaps = (m: unknown): Mapping[] | null => Array.isArray(m) && m.length > 0 && m.every((x) => x && typeof x === "object" && str(x.decision) && (x.option === null || str(x.option)))
  ? (m as Mapping[]) : null;

/** A reader's verdict: a reading, or — only when it says unclear — nothing. */
export const validVerdict = (m: unknown, unclear: unknown): Mapping[] | null =>
  str(unclear) ? (Array.isArray(m) && !m.length ? [] : null) : validMaps(m);

/** A reading's lines in one order: the order a confirm renders and stores them in. */
export const canonicalMaps = (ms: Mapping[]): Mapping[] => [...ms].sort((x, y) => mapsKey([x]).localeCompare(mapsKey([y])));

/** Two readings are the same reading when they map the same lines, in any order. */
export const mapsKey = (ms: Mapping[]): string => ms.map((m) => `${m.decision}\0${m.option ?? ""}`).sort().join("\n");

/** `d`'s replacement, if it has one, and when it was posted (undefined if that time is unknown). */
const replacement = (d: FoldedDecision, decisions: Map<string, FoldedDecision>): { at: number | undefined } | undefined => {
  const r = d.replacedBy ? decisions.get(d.replacedBy) : undefined;
  return r ? { at: ms(r.postedAt) } : undefined;
};

export function foldDecisions(events: LogEvent[]): SharedDecisions {
  const rounds = new Map<string, DecisionRound>();
  const decisions = new Map<string, FoldedDecision>();
  const questions = new Map<string, LoggedQuestion>();
  const causal = causality(events);
  const answerEvents = new Map<string, LogEvent>();
  const answersById = new Map<string, { a: FoldedAnswer; d: FoldedDecision }>();
  // Position of each decision's posting, so an answer reaches only a decision posted before it.
  const postedPos = new Map<string, number>();
  /** Every well-formed reading, in log order. Which are accepted is decided after the log is
   *  read, so a reading that is not accepted claims nothing (owner, P1.2 "Not used"). */
  const readingEvents: { e: LogEvent; pos: number }[] = [];
  /** Verified picks on confirms — the only answers that carry a confirm's meaning (P3.2). */
  const picks: { a: FoldedAnswer; c: FoldedDecision }[] = [];

  // Questions first: a logged call is a fact about the transcript, and an answer event may
  // arrive from another writer before it in fold order.
  for (const e of events) {
    if (e.kind !== "decision.question.logged") continue;
    const q = e.data as any;
    // No round or no answer time: written by a build before either bound anything (H7.12).
    const asked = Array.isArray(q?.rounds) && q.rounds.length && q.rounds.every((r: unknown) => str(r)) ? q.rounds as string[] : str(q?.round) ? [q.round as string] : undefined;
    if (!str(q?.session) || !str(q?.toolUseId) || !asked || !str(q?.answeredAt) || !Array.isArray(q?.questions) || !q?.answers || typeof q.answers !== "object" || Array.isArray(q.answers)) continue;
    if (!q.questions.every((x: any) => x && typeof x === "object" && typeof x.question === "string" && Array.isArray(x.options)
      && x.options.every((o: any) => o && typeof o === "object" && typeof o.label === "string"))) continue;
    if (questions.has(e.id)) continue;
    // A call logged before per-question binding named one round for all of it (S0.7).
    const bound: Record<string, string> = q.bound && typeof q.bound === "object" && !Array.isArray(q.bound)
      ? Object.fromEntries(Object.entries(q.bound).filter(([, r]) => typeof r === "string" && asked.includes(r as string))) as Record<string, string>
      : Object.fromEntries((q.questions as AskedQuestion[]).map((x) => [x.question, asked[0]!]));
    questions.set(e.id, {
      id: e.id, session: q.session, toolUseId: q.toolUseId,
      questions: q.questions.map(normalizeQuestion), answers: q.answers, rounds: asked, bound, answeredAt: q.answeredAt,
      ...(str(q.transcript) ? { transcript: q.transcript } : {}),
      loggedBy: e.actor, at: e.at,
    });
  }

  events.forEach((e, pos) => {
    const data = e.data as any;
    switch (e.kind) {
      case "decision.round.posted": {
        const r = data?.round;
        if (!r || typeof r !== "object" || !str(r.id) || !str(r.source) || rounds.has(r.id) || !Array.isArray(data?.decisions)) break;
        const pv = r.prevalidated;
        const prevalidated = pv && typeof pv === "object" && str(pv.record) && str(pv.sortedBy) ? { record: pv.record as string, sortedBy: pv.sortedBy as string } : undefined;
        rounds.set(r.id, {
          id: r.id, source: r.source, universe: str(r.universe) ?? "",
          ...(str(r.pr) ? { pr: r.pr } : {}), ...(str(r.branch) ? { branch: r.branch } : {}),
          ...(Array.isArray(r.notes) ? { notes: r.notes.filter((n: unknown) => str(n)) } : {}),
          ...(prevalidated ? { prevalidated } : {}),
          postedBy: e.actor, at: e.at,
        });
        for (const raw of data.decisions as Decision[]) {
          // Immutable once posted: the hash binding means nothing if the text under it can
          // move. A second posting of an id is ignored, whatever it says.
          if (!raw || typeof raw !== "object" || decisions.has(raw.id) || raw.round !== r.id || checkDecision(raw)) continue;
          const d: FoldedDecision = {
            id: raw.id, round: raw.round, ref: raw.ref, kind: raw.kind,
            payload: normalizeQuestion(raw.payload),
            // A retired field on an old posting is ignored, never a reason to lose the question (S0.7).
            options: raw.options.map(({ closesOnAnswer: _c, ...o }: DecisionOption & { closesOnAnswer?: unknown }) => o),
            ...(str(raw.supersedes) ? { supersedes: raw.supersedes } : {}),
            ...(str(raw.origin?.answer) ? { origin: { answer: raw.origin!.answer } } : {}),
            ...(Array.isArray(raw.notes) ? { notes: raw.notes } : {}),
            ...(raw.resolves ? { resolves: raw.resolves } : {}),
            hash: decisionHash(raw), postedAt: typeof e.at === "string" ? e.at : "", postingEvent: e.id, answers: [],
          };
          decisions.set(d.id, d);
          postedPos.set(d.id, pos);
          // A confirm is never replaced: a pick on it already says what a replacement could.
          const old = d.supersedes ? decisions.get(d.supersedes) : undefined;
          if (old?.confirms) delete d.supersedes;
          else if (old && !old.replacedBy) old.replacedBy = d.id;
          else if (old) d.replaceLost = old.replacedBy;
        }
        break;
      }

      case "decision.confirm.posted": {
        // Its own kind, because a round is immutable once posted (above). Kept whatever its
        // `confirms` says — whether it is a confirm codemap could have written is judged below.
        const raw = data?.decision as (Decision & { confirms?: Confirms }) | undefined;
        const r = rounds.get(str(data?.round) ?? "");
        if (!r || !raw || typeof raw !== "object" || decisions.has(raw.id) || raw.round !== r.id || checkDecision(raw)) break;
        const cf = raw.confirms as unknown as Record<string, unknown> | undefined;
        decisions.set(raw.id, {
          id: raw.id, round: raw.round, ref: raw.ref, kind: raw.kind, payload: normalizeQuestion(raw.payload), options: raw.options,
          hash: decisionHash(raw), postedAt: typeof e.at === "string" ? e.at : "", postingEvent: e.id, answers: [],
          confirms: { answer: str(cf?.answer) ?? "", readings: Array.isArray(cf?.readings) ? cf.readings as Mapping[][] : [],
            ...(Array.isArray(cf?.knownReplacements) && cf.knownReplacements.every((x) => typeof x === "string") ? { knownReplacements: cf.knownReplacements as string[] } : {}) },
        });
        postedPos.set(raw.id, pos);
        break;
      }

      case "decision.answer.recorded": {
        const d = decisions.get(str(data?.decision) ?? "");
        if (!d || (postedPos.get(d.id) ?? Infinity) > pos) break;
        if (data.hash !== d.hash) break;
        const r = resolve(d, data.via as AnswerVia, e.actor, questions);
        if (!r) break;
        // Principal-only and dated: a park that is not a date is no answer at all.
        if (r.park !== undefined && !ISO_DATE.test(r.park)) break;
        // An answer whose time does not parse is dropped (owner, P2.1 (5)): it would rank above
        // nothing and below nothing, so whichever was recorded first would stand.
        const givenAt = r.givenAt ?? e.at;
        const given = ms(givenAt);
        if (given === undefined) break;
        // Bound only to a question posted before it was given, by the person's clock and the
        // poster's, with no allowance for skew (B1.4, H7.10). A page answer is ordered by its log
        // position instead, above.
        if (r.givenAt !== undefined) { const posted = ms(d.postedAt); if (posted === undefined || !(given > posted)) break; }
        // One call or message answers a decision once; a duplicate records nothing (H6.1).
        if (r.once && d.answers.some((x) => x.once === r.once)) break;
        const a: FoldedAnswer = {
          id: e.id, by: e.actor, at: e.at, via: (data.via as AnswerVia).kind, verified: r.verified, givenAt, seq: pos, knownReplacements: [],
          ...(r.once ? { once: r.once } : {}),
          words: r.words, options: [], ruled: [], unruled: [], free: r.free,
          ...(str(data.relayedBy) ? { relayedBy: data.relayedBy } : {}),
        };
        d.answers.push(a);
        answersById.set(e.id, { a, d });
        answerEvents.set(e.id, e);
        // A words decision's answer is the words: recorded, never read onto options (C17).
        if (d.kind === "words") { a.free = false; break; }
        if (!r.free) rule(d, a, r, r.verified);
        if (d.confirms && !r.free && r.verified) picks.push({ a, c: d });
        break;
      }

      case "decision.reading.recorded": {
        const answer = str(data?.answer), agent = str(data?.reader?.agent);
        // A reading without codemap's own parse of the reader's verdict is dropped (S0.7, H7.12):
        // its mapping is the session's, not the reader's, so it cannot bind.
        // Nor one without the brief the reader was launched with (P3.4), which a build before
        // codemap wrote the brief could not record: those words go back to unread.
        if (!answer || !agent || !validVerdict(data.reader.verdict, data.reader.unclear) || !str(data.reader.launchedAt) || !str(data.reader?.verified?.session) || !str(data.reader.brief)
          || !validMaps(data.session?.maps)) break;
        readingEvents.push({ e, pos });
        break;
      }
    }
  });

  // --- what the log says, applied to the set -------------------------------------------

  // Admission is fixed at the act, not recomputed from a later merged wall clock.
  // New writes carry the locally visible posting IDs; old writes use causal evidence.
  for (const { a } of answersById.values()) {
    const e = answerEvents.get(a.id)!;
    const explicit = (e.data as any)?.knownReplacements;
    a.knownReplacements = Array.isArray(explicit) && explicit.every((x) => typeof x === "string") ? explicit
      : [...decisions.values()].filter((x) => x.supersedes && causal.saw(e.id, x.postingEvent)).map((x) => x.id);
  }
  for (const d of decisions.values()) {
    const successor = d.replacedBy ? decisions.get(d.replacedBy) : undefined;
    if (!successor) continue;
    d.answers = d.answers.filter((a) => {
      const known = a.knownReplacements.includes(successor.id);
      const cut = ms(successor.postedAt);
      return !known || cut === undefined || ms(a.givenAt)! < cut;
    });
  }
  const kept = (id: string) => { const x = answersById.get(id); return x && x.d.answers.includes(x.a) ? x : undefined; };

  // Which confirms carry a confirm's meaning: judged once the cut is known, against the set.
  for (const c of decisions.values()) {
    if (!c.confirms) continue;
    const why = confirmRefusal(decisions, c, kept(c.confirms.answer));
    if (why) {
      c.confirms.invalid = why;
      if (!answersById.has(c.confirms.answer)) c.confirms.never = true;
      // Keep the question and verified words intact, but a malformed confirmation
      // cannot borrow authority from effect-bearing options (2026-09-24 round, Q3).
      for (const a of c.answers) { a.ruled = []; a.unruled = []; a.park = undefined; a.parkWaits = undefined; a.separately = undefined; }
      continue;
    }
    // The request is answered by any pick that carries its meaning; typed words never answer it (Q1.3).
    let latest: FoldedAnswer | undefined;
    for (const { a: p, c: on } of picks) if (on === c && meaning(p.options[0], c.confirms.readings) !== undefined && (!latest || outranksByTime(p, latest))) latest = p;
    if (latest) c.confirms.picked = latest.id;
  }

  // Which readings count: in log order, one per answer and one answer per reader (S0.8(c)),
  // and only an ACCEPTED reading claims either slot (owner, P1.2): a rejected one never counted.
  const readings = new Map<string, { e: LogEvent; pos: number; knownReplacements: string[] }>();
  const readerUsed = new Map<string, string>();
  for (const r of readingEvents) {
    const data = r.e.data as any, x = kept(data.answer), agent = data.reader.agent as string;
    if (!x || readings.has(data.answer) || readerUsed.has(agent)) continue;
    const knownReplacements: string[] = Array.isArray(data.knownReplacements) && data.knownReplacements.every((id: unknown) => typeof id === "string")
      ? data.knownReplacements : [...decisions.values()].filter((d) => d.supersedes && causal.saw(r.e.id, d.postingEvent)).map((d) => d.id);
    if (readingRefusal(decisions, x.d, x.a, { verdict: data.reader.verdict, unclear: data.reader.unclear, session: data.session.maps, launchedAt: data.reader.launchedAt, brief: data.reader.brief, manifest: data.reader.manifest, knownReplacements })) continue;
    readings.set(data.answer, { ...r, knownReplacements });
    readerUsed.set(agent, data.answer);
  }

  // Readings, then the person's picks on confirms, onto every answer still free — in log order
  // of the answers, and each binding decided from the answer and its own events alone.
  const byLog = [...answersById.values()].filter((x) => x.d.answers.includes(x.a) && x.a.free && x.d.kind !== "words").sort((x, y) => x.a.seq - y.a.seq);
  for (const { a, d } of byLog) {
    const r = readings.get(a.id);
    if (r) {
      const rd = (r.e.data as any).reader, ses = (r.e.data as any).session;
      const unclear = str(rd.unclear);
      const maps = validVerdict(rd.verdict, rd.unclear)!, sm = validMaps(ses.maps)!;
      a.reading = {
        id: r.e.id, agree: !unclear && mapsKey(maps) === mapsKey(sm), knownReplacements: r.knownReplacements,
        reader: { agent: rd.agent, maps, launchedAt: rd.launchedAt },
        session: { reading: str(ses.reading) ?? "", maps: sm },
        ...(str((r.e.data as any).asks) ? { asks: (r.e.data as any).asks } : {}),
        ...(unclear ? { unclear } : {}),
      };
    }
    // The person's own word on these words: the latest-given verified pick across every confirm
    // of them decides (owner, P3.2 "Latest pick decides"; S0.2's "the later confirmation wins").
    // Typed words on a confirm are read like any reply and never carry this meaning.
    let decided: { pick: FoldedAnswer; maps: Mapping[] | null } | undefined;
    for (const { a: p, c } of picks) {
      if (c.confirms!.answer !== a.id || c.confirms!.invalid) continue;
      const rs = c.confirms!.readings, maps = meaning(p.options[0], rs);
      if (maps === undefined) continue;
      if (maps === null) (a.rejected ??= []).push(rs[0]!);
      if (!decided || outranksByTime(p, decided.pick)) decided = { pick: p, maps };
    }
    if (decided?.maps) {
      // As of when the words were typed, from the pick that decided (S0.1): its id names the copies.
      a.confirmed = { answer: decided.pick.id, at: decided.pick.givenAt, maps: decided.maps };
      bind(decisions, answersById, d, a, decided.maps, decided.pick.id, decided.pick.seq);
    } else if (!decided && a.reading?.agree) {
      bind(decisions, answersById, d, a, a.reading.reader.maps, a.reading.id, readings.get(a.id)!.pos);
    }
  }

  // Candidate concurrency is derived from original answer events, including bound human
  // words copied to another question. A relayer's causal knowledge is not proof of what
  // the human knew when speaking; callers see that uncertainty in the candidate view.
  const human = [...decisions.values()].flatMap((d) => d.answers).filter((a) => a.verified);
  for (const a of human) {
    const source = a.sourceAnswer ?? a.id;
    const ea = answerEvents.get(source);
    if (!ea) continue;
    a.concurrentWith = human.filter((b) => {
      const other = b.sourceAnswer ?? b.id, eb = answerEvents.get(other);
      return eb && source !== other && !causal.saw(ea.id, eb.id) && !causal.saw(eb.id, ea.id);
    }).map((b) => b.sourceAnswer ?? b.id);
  }
  for (const d of decisions.values()) if (d.resolves) {
    const targets = d.resolves.answers.map((id) => answersById.get(id)?.a);
    if (targets.some((a) => !a?.verified) || targets[0]!.by.principal === targets[1]!.by.principal
      || targets.some((a) => !d.payload.question.includes(JSON.stringify(a!.words))))
      d.resolutionInvalid = "it does not show two different people's exact verified rulings";
  }

  for (const d of decisions.values()) if (d.resolves && !d.resolutionInvalid) {
    const choice = standing(d);
    if (!choice?.verified) continue;
    const selected = d.resolves.answers.find((id) => choice.options[0] === `Preserve ${id}`);
    // A person's Other words can be a new intent once a reader has verified that they rule
    // neither shown alternative. A mere unread Other answer cannot settle the conflict.
    const newIntent = choice.nothing && !!choice.reading?.agree && choice.words.length > 0;
    if (!selected && !newIntent) continue;
    for (const t of decisions.values()) for (const a of t.answers)
      if (d.resolves.answers.includes(a.sourceAnswer ?? a.id) && (newIntent || (a.sourceAnswer ?? a.id) !== selected)) a.resolvedOutBy = choice.id;
  }

  // Follow-ups last: a copy's id exists only once its binding is made (Q13).
  for (const d of decisions.values()) {
    const src = d.origin ? answersById.get(d.origin.answer) : undefined;
    if (src) (src.d.followUps ??= []).push(d.id);
  }

  return { rounds: [...rounds.values()], decisions: [...decisions.values()], questions: [...questions.values()] };
}

/** Why `maps` cannot bind words `a` on `d`, or null: every decision it names is in the same
 *  round, was posted before the words were given, takes options, and was not already replaced
 *  in the admission context — an unknown time satisfies neither — and each is picked once,
 *  or `(none)` alone, unless it is multi-select (R3). */
export function bindRefusal(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, maps: Mapping[], knownReplacements: string[] = a.knownReplacements): string | null {
  const given = ms(a.givenAt);
  if (given === undefined) return "the words have no time that parses";
  const picks = new Map<string, (string | null)[]>();
  for (const m of maps) {
    const t = decisions.get(m.decision);
    if (!t || t.round !== d.round) return `${m.decision} is not a question in round ${d.round}`;
    if (t.kind === "words") return `${t.ref} takes words, not options`;
    if (t.confirms?.invalid) return `${t.ref} is an invalid confirmation: ${t.confirms.invalid}`;
    if (m.option !== null && !t.options.some((o) => o.label === m.option)) return `"${m.option}" is not an option of ${t.ref} (${t.options.map((o) => o.label).join(" / ")})`;
    const posted = ms(t.postedAt);
    if (posted === undefined || !(posted < given)) return `${t.ref} was posted after the words were typed (${a.givenAt})`;
    const r = t.replacedBy && knownReplacements.includes(t.replacedBy) ? replacement(t, decisions) : undefined;
    if (r && !(r.at !== undefined && given < r.at)) return `${t.ref} was replaced before the words were typed`;
    picks.set(t.id, [...(picks.get(t.id) ?? []), m.option]);
  }
  for (const [id, p] of picks) {
    const t = decisions.get(id)!;
    if (p.includes(null) && p.length > 1) return `${t.ref} is read as ${NONE} and as a pick at once`;
    if (p.length > 1 && t.kind === "options" && t.payload.multiSelect !== true) return `${t.ref} takes one option, and the reading picks ${p.length}`;
  }
  return null;
}

const canBind = (decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, maps: Mapping[]): boolean => bindRefusal(decisions, d, a, maps) === null;

/**
 * Why a reading of words `a` on `d` would not be accepted, or null — one predicate for the op,
 * which asks it before writing, and the fold (plan P-b). Each end checks the slots (one reading
 * per answer, one answer per reader) against its own record. The reader's verdict must be able
 * to bind, and an unclear reading's session side. A disagreement whose session side cannot bind
 * still claims the slot — the first verdict counts (owner, Q2.2) — and its confirm offers the
 * reader's reading alone; `reader_brief` refuses such a session side, so only a hand-built
 * event reaches it.
 */
export function readingRefusal(decisions: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer,
  r: { verdict: unknown; unclear?: unknown; session: unknown; launchedAt: unknown; brief: unknown; manifest?: BriefEntry[]; knownReplacements?: string[] }): string | null {
  if (d.kind === "words") return `${d.ref} takes words: they are the answer, never read onto options`;
  if (d.replacedBy && r.knownReplacements?.includes(d.replacedBy) && !a.reading) return `${d.ref} was superseded before these words were read: ask a fresh question`;
  if (!a.free || a.elsewhere) return `answer ${a.id} is not words waiting for a reading`;
  const launched = ms(typeof r.launchedAt === "string" ? r.launchedAt : undefined);
  // Launched after the words were typed, or it cannot have read them (plan B2).
  if (launched === undefined || !(launched > Date.parse(a.givenAt))) return `the reader was launched at ${String(r.launchedAt)}, before the words were typed at ${a.givenAt}: it cannot have read them`;
  const verdict = validVerdict(r.verdict, r.unclear), session = validMaps(r.session);
  if (!verdict) return "the reader's verdict is empty, and it does not say unclear";
  if (!session) return "the session's reading is empty";
  const sides = str(r.unclear) ? [session] : [verdict];
  for (const side of sides) {
    const why = bindRefusal(decisions, d, a, side, r.knownReplacements ?? a.knownReplacements);
    if (why) return `${side === verdict ? "the reader's verdict" : "your reading"} cannot bind: ${why}`;
  }
  if (!str(r.brief)) return "the reading carries no brief";
  return briefRefusal(decisions, d, a, r.brief as string, verdict, r.manifest);
}

/**
 * Bind words `a` by `maps`: its own decision's lines onto `a`; every other decision's onto a
 * copy there, which is a verified answer on that decision like any other and ranks there by
 * the words' given time (owner, S0.3 "Admit, ranked"). `source` names the reading or call.
 */
function bind(decisions: Map<string, FoldedDecision>, answersById: Map<string, { a: FoldedAnswer; d: FoldedDecision }>,
  d: FoldedDecision, a: FoldedAnswer, maps: Mapping[], source: string, pos: number): void {
  const byDecision = new Map<string, (string | null)[]>();
  for (const m of maps) byDecision.set(m.decision, [...(byDecision.get(m.decision) ?? []), m.option]);
  a.free = false;
  if (!byDecision.has(d.id)) a.elsewhere = true;
  for (const [id, picks] of byDecision) {
    const t = decisions.get(id)!;
    const options = picks.filter((p): p is string => p !== null).map((p) => t.options.find((o) => o.label === p)!);
    let target = a;
    if (t !== d) {
      // The same message relayed to that question too answers it there already (B1.4).
      if (a.once && t.answers.some((x) => x.once === a.once)) continue;
      target = { ...a, id: `${source}/${t.id}`, sourceAnswer: a.sourceAnswer ?? a.id, seq: pos, options: [], ruled: [], unruled: [], free: false };
      delete target.park; delete target.parkWaits; delete target.separately; delete target.flags; delete target.nothing;
      delete target.elsewhere; delete target.reading; delete target.confirmed; delete target.rejected;
      t.answers.push(target);
      answersById.set(target.id, { a: target, d: t });
    }
    if (!options.length) { target.nothing = true; continue; }
    rule(t, target, { picked: options }, a.verified);
  }
}

/** An answer's words, its picks, and whether it is verified — or null when it binds to
 *  nothing this fold can check. */
function resolve(d: FoldedDecision, via: AnswerVia, actor: Actor, questions: Map<string, LoggedQuestion>): Resolved | null {
  if (!via || typeof via !== "object") return null;
  switch (via.kind) {
    case "question": {
      const q = questions.get(via.question);
      // The logged call bound this question to this decision's round, and carries its payload
      // exactly (B1.4, S0.8(d)).
      if (!q || q.bound[d.payload.question] !== d.round || !q.questions.some((x) => sameQuestion(x, d.payload))) return null;
      const v = q.answers[d.payload.question];
      // What a transcript records: a string, or a list of them for a multi-select.
      if (typeof v !== "string" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return null;
      const list = Array.isArray(v) ? v : [v];
      const picked = list.map((l) => d.options.find((o) => o.label === l));
      const words = list.join(", ");
      // The call is kept whatever its time says — it is a fact about the transcript — but an
      // answer through it needs a time to rank by (P2.1 (5)).
      if (ms(q.answeredAt) === undefined) return null;
      const call = { verified: true, givenAt: q.answeredAt, once: `q:${q.session}\0${q.toolUseId}`, words };
      if (d.kind !== "words" && picked.every(Boolean) && (list.length === 1 || d.payload.multiSelect)) {
        return { ...call, picked: picked as DecisionOption[], free: false };
      }
      // Other text, a label with words appended, or a multi-select element that is words: the
      // person's own, and read by the reader (C14).
      return { ...call, picked: [], free: true };
    }
    case "message":
      // Always the reader's to bind, never a parser's — "D13 A" included (owner, H5).
      if (!str(via.session) || !str(via.entryId) || !str(via.text) || !str(via.at) || Number.isNaN(Date.parse(via.at)) || via.round !== d.round) return null;
      return { verified: true, givenAt: via.at, once: `m:${via.session}\0${via.entryId}`, words: via.text, picked: [], free: true };
    case "unverified":
      if (!str(via.words)) return null;
      return { verified: false, words: via.words, picked: [], free: true };
    case "direct": {
      if (isAgentActor(actor)) return null;   // the page is a person's door, never an agent's
      const page = { verified: true };
      if (via.park !== undefined) return typeof via.park === "string" ? { ...page, words: `park ${via.park}`, picked: [], park: via.park, free: false } : null;
      if (d.kind === "bulk" && via.checked !== undefined) {
        if (!Array.isArray(via.checked) || !via.checked.every((c) => typeof c === "string")) return null;
        const picked = via.checked.map((c) => d.options.find((o) => o.label === c));
        if (!picked.length || !picked.every(Boolean)) return null;
        return { ...page, words: via.checked.join(", "), picked: picked as DecisionOption[], free: false };
      }
      const o = typeof via.option === "string" ? d.options.find((x) => x.label === via.option) : undefined;
      if (o) return { ...page, words: o.label, picked: [o], free: false };
      if (str(via.words)) return { ...page, words: via.words!, picked: [], free: true };
      return null;
    }
  }
  return null;
}

// --- the ranking (plan A2, S0.5) ---------------------------------------------------------

/** In the ranking: every answer something has bound — a pick, a park, a bulk answer, words
 *  read or confirmed, including words that rule nothing — and not one about other questions. */
const ranks = (a: FoldedAnswer): boolean => !a.free && !a.elsewhere && !a.resolvedOutBy;

/** `x` outranks `y`: verified first, then the later given, then the later in the log. */
const outranks = (x: FoldedAnswer, y: FoldedAnswer): boolean =>
  x.verified !== y.verified ? x.verified
    : Date.parse(x.givenAt) !== Date.parse(y.givenAt) ? Date.parse(x.givenAt) > Date.parse(y.givenAt) : x.seq > y.seq;

const best = (as: FoldedAnswer[]): FoldedAnswer | undefined => as.reduce<FoldedAnswer | undefined>((b, a) => (!b || outranks(a, b) ? a : b), undefined);

/** A decision's standing answer, derived from the whole set whenever it is read. */
export const standing = (d: FoldedDecision): FoldedAnswer | undefined => best(d.answers.filter(ranks));

/** Words still waiting for a binding on `d`: unread, read as unclear, or read two ways. */
const pending = (d: FoldedDecision): FoldedAnswer[] => d.answers.filter((a) => a.free && !a.elsewhere);

/** Whether the answer ruled — picked something — rather than parked, awaited or ruled nothing. */
const decides = (a: FoldedAnswer | undefined): boolean => !!a && !a.free && !a.nothing && a.park === undefined && a.parkWaits === undefined;

/** Words `a` on `d` down whose replacement chain something has since ruled (B2.4, P3.3): a
 *  verified ruling for verified words, as `successorOf` takes a ruling over. */
function chainRuled(byId: Map<string, FoldedDecision>, d: FoldedDecision, verified: boolean): boolean {
  const seen = new Set<string>([d.id]);
  for (let c = d.replacedBy ? byId.get(d.replacedBy) : undefined; c && !seen.has(c.id); c = c.replacedBy ? byId.get(c.replacedBy) : undefined) {
    seen.add(c.id);
    const b = standing(c);
    if (decides(b) && (b!.verified || !verified)) return true;
  }
  return false;
}

/**
 * Whether binding free words `a` on `d` could still change a standing answer (owner, Q1.2 "While
 * they could change something"): some question they may be read onto (`readable`, so the two
 * cannot drift) has nothing standing, or a standing answer a bound copy would outrank. A copy on
 * another question ranks at the binding's log position (`bind`), i.e. after everything standing.
 * A confirm with no effects is skipped — words bound onto it never answer the request (Q1.3) —
 * and a replaced question counts only until its chain rules, or while it still holds a ruling
 * nothing down the chain took over (Q3.3 (b)).
 */
function couldChange(byId: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): boolean {
  if (d.replacedBy && !a.reading) return false;
  return readable(byId, d, a).some((t) => {
    if (t.confirms && t.options.every((o) => !o.effects.length)) return false;
    const top = standing(t);
    if (top && !outranks(t === d ? a : { ...a, seq: Infinity }, top)) return false;
    return !t.replacedBy || !chainRuled(byId, t, a.verified) || stillHeld(byId, t).length > 0;
  });
}

/** Words that can no longer change anything (owner, P3.3 "Stop surfacing", with Q1.2's test):
 *  bound some way, unable to gain a reading after supersession, or no question they may be
 *  read onto would change. */
function moot(byId: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer): boolean {
  return !d.answers.includes(a) || !a.free || a.elsewhere === true || !couldChange(byId, d, a);
}

/** The words on `d` still worth showing: pending and not moot. */
const surfacing = (byId: Map<string, FoldedDecision>, d: FoldedDecision): FoldedAnswer[] =>
  pending(d).filter((p) => couldChange(byId, d, p));

/** The words a confirm asks about, if they are still an answer here. */
export function confirmedWords(byId: Map<string, FoldedDecision>, c: FoldedDecision): { d: FoldedDecision; a: FoldedAnswer } | undefined {
  if (!c.confirms) return undefined;
  for (const d of byId.values()) { const a = d.answers.find((x) => x.id === c.confirms!.answer); if (a) return { d, a }; }
  return undefined;
}

/**
 * Where a confirm's REQUEST stands (owner, Q1.3 "The request only"): `answered` once a pick
 * carries its meaning; `unverifiable` when it is not one codemap could have written, or names
 * words never recorded (it binds nothing and holds nothing); `no longer needed` when its words
 * were cut or are moot (it stops holding and waiting — P3.3); else `open` (it holds and waits on
 * you). Words typed on the confirm never enter it: they are read like any reply.
 */
export type ConfirmState = "open" | "answered" | "no longer needed" | "unverifiable";
export function confirmState(byId: Map<string, FoldedDecision>, c: FoldedDecision): ConfirmState | undefined {
  if (!c.confirms) return undefined;
  if (c.confirms.picked) return "answered";
  if (c.confirms.invalid && c.confirms.never) return "unverifiable";
  const t = confirmedWords(byId, c);
  if (!t || moot(byId, t.d, t.a)) return "no longer needed";
  return c.confirms.invalid ? "unverifiable" : "open";
}

export interface Superseding { answer: string; words: string; state: "unread" | "unclear" | "disputed"; rejected?: Mapping[][] }

/**
 * Verified words that would outrank the standing answer if something bound them, while they
 * are unread, unclear or in dispute (owner, P4.1 + plan A3): the ruling stands, and the
 * decision — and every finding it names — is marked possibly superseded until they are bound,
 * or a later verified answer rules.
 */
export function possiblySuperseded(d: FoldedDecision, byId: Map<string, FoldedDecision>): Superseding[] {
  const a = standing(d);
  // A confirm's own words are read like any reply, and there is no confirm of a confirm.
  if (!a || d.confirms) return [];
  // A replaced question's ruling still holds (B2.4), so words that may overturn it flag it —
  // until the replacement rules.
  const words = surfacing(byId, d);
  return words.filter((p) => p.verified).map((p) => ({
    answer: p.id, words: p.words,
    state: !p.reading ? "unread" as const : p.reading.unclear ? "unclear" as const : "disputed" as const,
    ...(p.rejected ? { rejected: p.rejected } : {}),
  }));
}

// --- the views --------------------------------------------------------------------------
//
// The three things the person asked to be able to see (owner, 2026-09-23). Each is a function
// of the folded record — plus, for the second, the finding record, which alone says whether a
// ruling has been carried out.

/**
 * Where a replaced decision's ruling on `finding` went (owner, B2.4 + H4 + H6.2/6.3): to the
 * first decision down its replacement chain that names the finding and has a standing answer
 * that rules — and, when the ruling was verified, only a verified answer takes it over.
 * Undefined while the ruling still holds. `blocker` is a later answer that would have taken it
 * over but is unverified: it waits for the person.
 */
function successorOf(byId: Map<string, FoldedDecision>, d: FoldedDecision, a: FoldedAnswer, finding: string): { taken?: FoldedDecision; blocker?: FoldedDecision } {
  let blocker: FoldedDecision | undefined;
  const seen = new Set<string>([d.id]);
  for (let c = d.replacedBy ? byId.get(d.replacedBy) : undefined; c && !seen.has(c.id); c = c.replacedBy ? byId.get(c.replacedBy) : undefined) {
    seen.add(c.id);
    if (!c.options.some((o) => o.effects.some((e) => e.findings.includes(finding)))) continue;
    const b = standing(c);
    if (!b || !decides(b)) continue;
    if (a.verified && !b.verified) { blocker ??= c; continue; }
    return { taken: c };
  }
  return blocker ? { blocker } : {};
}

/** The rulings a replaced decision still holds, per finding: those nothing down its chain took over. */
const stillHeld = (byId: Map<string, FoldedDecision>, d: FoldedDecision): Ruled[] => {
  const a = standing(d);
  return a ? a.ruled.filter((r) => !successorOf(byId, d, a, r.finding).taken) : [];
};

export interface IntentCandidate {
  answers: [string, string]; decisions: [string, string]; findings: string[];
  sources: [{ principal: string; via: string; words: string; options: string[] }, { principal: string; via: string; words: string; options: string[] }];
  evidence: "concurrent-writers";
  humanKnowledge: "not established";
}

/** Mechanical candidates only. Semantic conflict and original human knowledge still need review. */
export function intentCandidates(s: SharedDecisions): IntentCandidate[] {
  const all = s.decisions.flatMap((d) => d.answers.filter((a) => a.verified && !d.resolves && !d.confirms?.invalid).map((a) => ({ d, a })));
  const out: IntentCandidate[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const x = all[i]!, y = all[j]!;
    const sx = x.a.sourceAnswer ?? x.a.id, sy = y.a.sourceAnswer ?? y.a.id;
    const key = [sx, sy].sort().join("\0");
    if (seenPairs.has(key) || sx === sy || x.a.by.principal === y.a.by.principal || !x.a.concurrentWith?.includes(sy)) continue;
    const sameQuestion = x.d.id === y.d.id;
    const xf = new Set(named(x.d)), yf = new Set(named(y.d));
    const overlap = [...xf].filter((f) => yf.has(f));
    if (!sameQuestion && !overlap.length) continue;
    if (x.a.words === y.a.words && mapsKey(x.a.ruled.map((r) => ({ decision: r.finding, option: `${r.on}:${r.as ?? ""}` })))
      === mapsKey(y.a.ruled.map((r) => ({ decision: r.finding, option: `${r.on}:${r.as ?? "" }` })))) continue;
    const resolved = s.decisions.some((d) => {
      if (!d.resolves || d.resolutionInvalid || !d.resolves.answers.includes(sx) || !d.resolves.answers.includes(sy)) return false;
      const choice = standing(d);
      return !!choice?.verified && (d.options.some((o) => o.label === choice.options[0])
        || (!!choice.nothing && !!choice.reading?.agree && choice.words.length > 0));
    });
    if (resolved) continue;
    const findings = sameQuestion ? [...xf] : overlap;
    seenPairs.add(key);
    out.push({ answers: [sx, sy], decisions: [x.d.id, y.d.id], findings,
      sources: [{ principal: x.a.by.principal, via: x.a.via, words: x.a.words, options: x.a.options },
        { principal: y.a.by.principal, via: y.a.via, words: y.a.words, options: y.a.options }], evidence: "concurrent-writers", humanKnowledge: "not established" });
  }
  return out;
}

export interface WaitingItem { decision: string; round: string; ref: string; why: string }

/** Parked through the whole of its date, by UTC date (H6.6). */
const parkedOn = (a: FoldedAnswer | undefined, today: string): boolean => a?.park !== undefined && a.park >= today;

const fmt = (s: SharedDecisions, maps: Mapping[]): string => maps.map((m) => {
  const t = s.decisions.find((x) => x.id === m.decision);
  return t ? `${t.ref} → ${m.option ?? NONE}` : `${m.decision} → ${m.option ?? NONE}`;
}).join("; ");

/**
 * What waits on the person: unanswered questions, and answers that need them again. `today`
 * (UTC, YYYY-MM-DD) comes from the op, never a clock in here: a park holds through its date
 * and, once it has passed, the decision is theirs again (bulk 3).
 */
export function waitingOnMe(s: SharedDecisions, today: string): WaitingItem[] {
  const out: WaitingItem[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    if (d.confirms?.invalid) {
      out.push({ decision: d.id, round: d.round, ref: d.ref, why: `not a confirm codemap can verify (${d.confirms.invalid}) — answering it binds nothing; ask for a new confirm` });
      continue;
    }
    if (d.replacedBy) {
      // A replacement's unverified answer, where your ruling on the replaced question still
      // holds (H6.2) — listed on the replacement, the question still open to you.
      const a = standing(d);
      const listed = new Set<string>();
      for (const r of a?.ruled ?? []) {
        const b = successorOf(byId, d, a!, r.finding).blocker;
        if (b && !listed.has(b.id)) { listed.add(b.id); out.push({ decision: b.id, round: b.round, ref: b.ref, why: `an unconfirmed answer arrived after your ruling on ${d.ref} (${d.round})` }); }
      }
      // Residual findings remain visible even after the successor rules; visibility does
      // not revive an unread question or restore its former hold (2026-09-24, Q5/Q6).
      const covered = new Set<string>();
      const seen = new Set<string>([d.id]);
      for (let next = d.replacedBy ? byId.get(d.replacedBy) : undefined; next && !seen.has(next.id); next = next.replacedBy ? byId.get(next.replacedBy) : undefined) {
        seen.add(next.id);
        for (const f of named(next)) covered.add(f);
      }
      const omitted = named(d).filter((f) => !covered.has(f));
      if (omitted.length) out.push({ decision: d.id, round: d.round, ref: d.ref, why: `${d.ref} remains visible for ${omitted.join(", ")}, omitted by its replacement; an unread, unbound answer here needs a fresh question` });
      // Your words on it, given before it was replaced, still count on it (A4) — shown beside
      // the replacement until that rules (owner, P1.3).
      const by = byId.get(d.replacedBy)?.ref ?? d.replacedBy;
      for (const p of surfacing(byId, d)) {
        if (!p.reading) continue;
        const state = !p.reading ? "not read yet" : p.reading.unclear ? `the reader could not tell which question they answer: ${p.reading.unclear}` : p.reading.agree ? "" : "read two different ways";
        out.push({ decision: d.id, round: d.round, ref: d.ref, why: `your words on ${d.ref}, given before it was replaced by ${by}, are not bound yet ("${p.words}"${state ? `: ${state}` : ""})${p.rejected?.length ? " — you said a reading of them was not what you meant" : ""}` });
      }
      continue;
    }
    const a = standing(d);
    const item = (why: string) => out.push({ decision: d.id, round: d.round, ref: d.ref, why });
    const cs = confirmState(byId, d);
    if (d.replaceLost) {
      const was = s.decisions.find((x) => x.id === d.supersedes);
      item(`posted to replace ${was?.ref ?? d.supersedes}, which ${d.replaceLost} had already replaced: a conflicting replacement`);
    }
    // An agent's unconfirmed words after your ruling: never applied over it, and never read,
    // so it cannot be told apart from agreement (owner, P3.1 (2); H6.8).
    if (a?.verified) for (const x of d.answers) if (!x.verified && x !== a && outranksByTime(x, a)) item(`an unconfirmed answer arrived after your ruling: "${x.words}"`);
    for (const p of surfacing(byId, d)) {
      if (p.reading?.unclear) item(`the reader could not tell which question your words answer: ${p.reading.unclear}`);
      else if (p.reading && !p.reading.agree) item(`your words were read two different ways: "${p.words}"`);
      if (p.rejected?.length) item(`you said a reading of your words was not what you meant ("${p.words}": ${fmt(s, p.rejected.at(-1)!)}): answer ${d.ref} again`);
    }
    // A confirm's own standing answer is words on it, never a ruling: only the request waits on
    // you (Q1.3), and only while its words have not gone to a reader.
    if (d.confirms) {
      if (cs === "open" && !surfacing(byId, d).length) item(`confirm what your words on ${confirmedWords(byId, d)!.d.ref} meant`);
      continue;
    }
    if (!a) {
      // Unread words wait on an agent (`awaitingReading`), not on the person.
      if (!pending(d).length) item("not answered");
      continue;
    }
    if (parkedOn(a, today)) continue;   // under "parked", not here (H6.5)
    if (a.park !== undefined) item(`parked until ${a.park}, which has passed`);
    // Read, and ruled nothing: its findings are still undecided, so without this it would
    // wait on nobody (Q11, C20).
    if (d.resolves && a.nothing && a.reading?.agree)
      item(`your new intent \"${a.words}\" resolves the shown alternatives; ask a fresh valid question for the action it requires`);
    else if (a.nothing) item("your words were read, and they rule nothing here");
    if (a.parkWaits) item(`a park until ${a.parkWaits} that could not be verified as yours`);
    if (a.unruled.length) item(`settles that could not be verified as yours: ${a.unruled.join(", ")}`);
    for (const label of a.separately ?? []) {
      if (!(d.followUps ?? []).some((f) => byId.get(f)?.origin?.answer === a.id)) item(`you asked to rule on "${label}" separately, and it has not been asked yet`);
    }
  }
  for (const c of intentCandidates(s)) {
    const d = byId.get(c.decisions[0])!;
    out.push({ decision: d.id, round: d.round, ref: d.ref, why: `human rulings ${c.answers.join(" and ")} may conflict on intent; show both to the person and ask which to preserve before acting` });
  }
  return out;
}

/** Given later than `y` — the ranking's time order, ignoring verification. */
const outranksByTime = (x: FoldedAnswer, y: FoldedAnswer): boolean =>
  Date.parse(x.givenAt) !== Date.parse(y.givenAt) ? Date.parse(x.givenAt) > Date.parse(y.givenAt) : x.seq > y.seq;

export interface Parked { decision: string; round: string; ref: string; until: string; findings: string[] }

/** Decisions parked by the person, still within their date (owner, B3.1: "a separate park queue"). */
export function parked(s: SharedDecisions, today: string): Parked[] {
  const out: Parked[] = [];
  for (const d of s.decisions) {
    const a = standing(d);
    if (d.replacedBy || !parkedOn(a, today)) continue;
    out.push({ decision: d.id, round: d.round, ref: d.ref, until: a!.park!, findings: named(d) });
  }
  return out;
}

/** Every finding a decision's options act on. */
export const named = (d: Pick<Decision, "options"> & { confirms?: FoldedDecision["confirms"] }): string[] =>
  d.confirms?.invalid ? [] : [...new Set(d.options.flatMap((o) => o.effects.flatMap((e) => e.findings)))];

export interface Unread { decision: string; round: string; ref: string; answer: string; words: string }

/** Free text the reader has not read yet — waiting on an agent, not on the person. An agent's
 *  unconfirmed words after a verified ruling are never sent to the reader (H6.8). */
export function awaitingReading(s: SharedDecisions): Unread[] {
  const out: Unread[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    if (d.kind === "words") continue;
    for (const x of surfacing(byId, d)) {
      // H6.8, as `record_reading` refuses it: words that may still change another question are
      // not thereby readable.
      if (x.reading || d.replacedBy || (!x.verified && standing(d)?.verified)) continue;
      out.push({ decision: d.id, round: d.round, ref: d.ref, answer: x.id, words: x.words });
    }
  }
  return out;
}

export interface Disputed { decision: string; round: string; ref: string; answer: string; words: string; reader: string; session: string }

/** The person's words, read two different ways by the reader and the session. */
export function readingsInDispute(s: SharedDecisions): Disputed[] {
  const out: Disputed[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    for (const p of surfacing(byId, d)) {
      if (p.reading && !p.reading.agree && !p.reading.unclear) {
        out.push({ decision: d.id, round: d.round, ref: d.ref, answer: p.id, words: p.words, reader: fmt(s, p.reading.reader.maps), session: p.reading.session.reading || fmt(s, p.reading.session.maps) });
      }
    }
  }
  return out;
}

export interface Uncarried extends Ruled {
  decision: string; round: string; ref: string; answer: string; ruler: string;
  /** The ruling is on a question since replaced, and holds until the replacement rules (B2.4). */
  replacedBy?: string;
}

/**
 * Rulings not yet carried out: every effect a standing answer ruled whose finding is still
 * open. A settle waits for the verifier; an unblock is fix work. `isOpen` is the finding
 * record's answer — this record never stores it.
 */
export function ruledNotCarriedOut(s: SharedDecisions, isOpen: (finding: string) => boolean): Uncarried[] {
  const out: Uncarried[] = [];
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  const contested = new Set(intentCandidates(s).flatMap((c) => c.findings));
  for (const d of s.decisions) {
    const a = standing(d);
    // A replaced question is listed here, marked replaced, and nowhere else (B5.1).
    for (const r of d.replacedBy ? stillHeld(byId, d) : a?.ruled ?? []) {
      if (isOpen(r.finding) && !contested.has(r.finding)) out.push({ ...r, decision: d.id, round: d.round, ref: d.ref, answer: a!.id, ruler: a!.by.principal, ...(d.replacedBy ? { replacedBy: d.replacedBy } : {}) });
    }
  }
  return out;
}

export interface Hold {
  decision: string; why: "undecided" | "ruled";
  /** When this hold on the finding last began (owner, S0.4): a person's assignment keeps a
   *  held finding on the work queue only if made after it. */
  since: string;
}

/** Whether `d`, with `a` its standing answer so far, holds `finding` from open work. */
function holdsWith(d: FoldedDecision, a: FoldedAnswer | undefined, finding: string): boolean {
  if (!named(d).includes(finding)) return false;
  if (!decides(a)) return true;
  if (a!.ruled.some((r) => r.finding === finding && r.on === "settle")) return true;
  if (a!.unruled.includes(finding)) return true;
  return d.options.some((o) => a!.separately?.includes(o.label) && o.effects.some((e) => e.findings.includes(finding)));
}

/**
 * When `d`'s hold on `finding` last began: walked over the answers in the order they were
 * GIVEN, as the ranking reads them. A replacement inherits its predecessor's start if the
 * predecessor was holding the finding when it was replaced (the chain holds it continuously).
 */
function holdSince(s: SharedDecisions, byId: Map<string, FoldedDecision>, d: FoldedDecision, finding: string): string | undefined {
  const prev = d.supersedes ? byId.get(d.supersedes) : undefined;
  const inherited = prev && prev.replacedBy === d.id && holdsWith(prev, standing(prev), finding) ? holdSince(s, byId, prev, finding) : undefined;
  const given = d.answers.filter(ranks).sort((x, y) => (outranksByTime(x, y) ? 1 : -1));
  let since = holdsWith(d, undefined, finding) ? inherited ?? d.postedAt : undefined;
  // The standing answer of each prefix, kept as it grows: `best` is a left fold, so this is it.
  let top: FoldedAnswer | undefined;
  for (const g of given) {
    if (!top || outranks(g, top)) top = g;
    const now = holdsWith(d, top, finding);
    if (now && since === undefined) since = g.givenAt;
    else if (!now) since = undefined;
  }
  return since;
}

/**
 * Findings not to be offered as open work, and why: a decision on them is undecided, or a
 * standing settle ruling holds them for the verifier (owner: "Held for the verifier"). An
 * unblock ruling releases them. Derived, never stored — and the finding record decides whether
 * a ruled one has since closed.
 */
export function heldFindings(s: SharedDecisions, isOpen: (finding: string) => boolean): Map<string, Hold[]> {
  const out = new Map<string, Hold[]>();
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  const add = (d: FoldedDecision, f: string, why: Hold["why"]) => {
    // A closed finding is held by nothing (bulk item 1): the hold was on offering it as work.
    if (!isOpen(f)) return;
    const list = out.get(f) ?? [];
    if (list.some((x) => x.decision === d.id)) return;
    list.push({ decision: d.id, why, since: holdSince(s, byId, d, f) ?? d.postedAt });
    out.set(f, list);
  };
  for (const c of intentCandidates(s)) for (const f of c.findings) {
    const d = byId.get(c.decisions[0])!;
    add(d, f, "undecided");
  }
  for (const d of s.decisions) {
    // An open confirm holds every finding of every decision its readings map — `(none)` too, as
    // its text says (Q2.3 (2)) — beside the decision's own hold (the discussion: "two entries is
    // fine"), from its own posting (S0.4, P3.5).
    if (d.confirms) {
      if (confirmState(byId, d) !== "open") continue;
      for (const r of d.confirms.readings) for (const m of r) for (const f of named(byId.get(m.decision)!)) add(d, f, "undecided");
      continue;
    }
    if (d.replacedBy) {
      for (const r of stillHeld(byId, d)) if (r.on === "settle") add(d, r.finding, "ruled");
      // Undecided when replaced, it holds what it names until something down its chain rules —
      // the findings the replacement dropped included; nothing will ask about those again (Q1.4).
      const a = standing(d);
      if (!decides(a) && !chainRuled(byId, d, a?.verified ?? false)) for (const f of named(d)) add(d, f, "undecided");
      continue;
    }
    const a = standing(d);
    for (const r of a?.ruled ?? []) if (r.on === "settle") add(d, r.finding, "ruled");
    // Undecided while nothing rules it: no answer, a park, words not yet bound, or words that
    // rule nothing. A decided answer that picked an option with no effect on a finding releases it.
    if (!decides(a)) {
      const ruled = new Set((a?.ruled ?? []).map((r) => r.finding));
      for (const f of named(d)) if (!ruled.has(f)) add(d, f, "undecided");
      continue;
    }
    // Decided — but settles it could not rule wait for the person, and bulk items checked to be
    // ruled on separately wait for their own question.
    for (const f of a!.unruled) add(d, f, "undecided");
    for (const o of d.options) if (a!.separately?.includes(o.label)) for (const e of o.effects) for (const f of e.findings) add(d, f, "undecided");
  }
  return out;
}

/** Every finding a possibly-superseded decision names, whether it holds it or not — a mark
 *  on the queues and catalogues that never withholds (owner, S0.8(a)). */
export function supersededFindings(s: SharedDecisions): Map<string, { decision: string; words: string[] }[]> {
  const out = new Map<string, { decision: string; words: string[] }[]>();
  const byId = new Map(s.decisions.map((x) => [x.id, x]));
  for (const d of s.decisions) {
    const p = possiblySuperseded(d, byId);
    if (!p.length) continue;
    for (const f of named(d)) out.set(f, [...(out.get(f) ?? []), { decision: d.id, words: p.map((x) => x.words) }]);
  }
  return out;
}

// --- writing --------------------------------------------------------------------------

export const postRoundEvent = (logRoot: string, universe: string, actor: Actor, round: Omit<DecisionRound, "postedBy" | "at">, decisions: Decision[]) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.round.posted", round.id, { round, decisions });

export const postConfirmEvent = (logRoot: string, universe: string, actor: Actor, decision: Decision & { confirms: Confirms }) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.confirm.posted", decision.id, { round: decision.round, decision });

export const logQuestionEvent = (logRoot: string, universe: string, actor: Actor, q: Omit<LoggedQuestion, "id" | "loggedBy" | "at">) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.question.logged", q.toolUseId, q as unknown as Record<string, unknown>);

export const recordAnswerEvent = (logRoot: string, universe: string, actor: Actor, a: { decision: string; hash: string; via: AnswerVia; relayedBy?: string; knownReplacements?: string[] }) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.answer.recorded", a.decision, a as unknown as Record<string, unknown>);

export interface ReadingEvent {
  answer: string;
  knownReplacements?: string[];
  /** Codemap's parse of the reader's own `submit_verdict` call, never the session's copy of it
   *  (plan B1, Q2.2). `brief`: the prompt it was launched with, which is codemap's own (P1.4);
   *  `verified.toolUseId` its launch, `verified.call` its submit. */
  reader: { agent: string; verdict: Mapping[]; unclear?: string; launchedAt: string; brief: string; manifest?: BriefEntry[]; verified: { session: string; toolUseId: string; call?: string } };
  /** What the asking session requested — the mapping the reader is compared against. */
  session: { reading?: string; maps: Mapping[] };
  asks?: string;
}

export const recordReadingEvent = (logRoot: string, universe: string, actor: Actor, a: ReadingEvent) =>
  emitEvent(logRoot, decisionScope(universe), actor, "decision.reading.recorded", a.answer, a as unknown as Record<string, unknown>);
