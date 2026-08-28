/**
 * Who did this — the prerequisite for sharing anything.
 *
 * Nothing in the store carried an identity: reviews wrote `reviewer: "me"`,
 * annotations wrote `author: "agent"`, and the rest wrote `by: "human"`. That is
 * survivable while a store belongs to one person and unworkable the moment two
 * share one, because the review model's central claim is ABOUT identity — "the
 * session that created a node may not verify it" cannot be enforced against a
 * literal.
 *
 * An agent always acts ON BEHALF OF a person, so `via` hangs off a principal
 * rather than replacing it. That keeps every action attributable to someone, and
 * it is what lets the no-self-verify rule survive automation: an agent running as
 * izzie is not independent corroboration of izzie's own finding.
 */

import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { gitBin } from "./git.js";

/**
 * Resolved from git, not from `gh api user`.
 *
 * An email is local, instant, stable and unique, and every repo where somebody
 * commits already has one. `gh` would mean a network call on a path that runs on
 * every write; the GitHub login is a different fact, wanted only for correlating
 * with pull-request comments, and it rides along in `github` when a caller
 * already knows it.
 */
const principalCache = new Map<string, string | null>();

export function resolvePrincipal(root: string): string | null {
  const override = process.env.CODEMAP_PRINCIPAL?.trim();
  if (override) return override;
  let p = principalCache.get(root);
  if (p === undefined) {
    const r = spawnSync(gitBin(), ["config", "user.email"], { cwd: root, encoding: "utf8" });
    const email = r.status === 0 ? (r.stdout ?? "").trim() : "";
    p = email || null;
    principalCache.set(root, p);
  }
  return p;
}

export interface ActorInput {
  /** Override the resolved principal — a caller that already knows who it is. */
  principal?: string;
  /** This action is an agent's. Without it the actor is the person themselves. */
  agent?: boolean;
  /** Model id, e.g. "claude-opus-5". Free text on purpose: models churn faster than any enum. */
  model?: string;
  harness?: string;
  github?: string;
}

/**
 * The actor for a write, or null when there is no principal to attribute it to.
 *
 * Null rather than a placeholder: an unattributable action in a SHARED store is
 * worse than a rejected one, and inventing "unknown" would make the no-self-verify
 * check pass by collision — everyone would be the same person.
 *
 * A model id is never guessed. An agent does not reliably know which model it is,
 * so it arrives from the client (env or per-call) or not at all; `agent: true`
 * with no model is honest, `agent: true` with a guessed one is not.
 */
/**
 * This process is an agent's session, whatever the environment says.
 *
 * The MCP server calls this at startup. Nothing else should: a person does not
 * type newline-delimited JSON-RPC, so that surface is an agent by construction —
 * whereas the CLI and the web UI are a person unless a harness says otherwise.
 *
 * Without it the ratchet was inert exactly where it matters. `via` came only from
 * CODEMAP_AGENT_MODEL / _HARNESS, nothing in this repo sets either, so every write
 * an agent made through MCP was recorded as the PERSON — free to close findings,
 * and counted as independent corroboration of its own work.
 */
let agentSession = false;
export function markAgentSession(): void { agentSession = true; }

/**
 * The harness on the other end of the connection, as the TRANSPORT saw it.
 *
 * `via.harness` otherwise comes from the caller's own argument or an env var — a
 * self-report, and the one field corroboration depends on. `checked` is sold as
 * "a DIFFERENT session confirmed it", and cross-checking a finding across vendors
 * (one model finds, another verifies) is the practice that gives the tier meaning;
 * both are worthless if a caller can spell its own harness. MCP's `initialize`
 * carries `clientInfo`, sent by the host before the model has any say, so it is the
 * one identity a model cannot choose for itself. Observed beats self-reported here
 * for exactly that reason — a disagreement means the self-report was wrong.
 *
 * Normalised to a slug because it is compared, not displayed: "Claude Code" and
 * "claude-code" are one harness and must not read as independent corroboration.
 */
let observedClient: string | undefined;
export function markObservedClient(name: string | undefined): void {
  const slug = name?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  observedClient = slug || undefined;
}
/** For tests — the latch is process-wide and the suite runs in one process. */
export function clearObservedClient(): void { observedClient = undefined; }

/**
 * Give the process back. **For tests, and there is no production caller.**
 *
 * Nothing un-becomes an agent mid-session, so this is not a state the design has
 * — it exists because the flag is PROCESS-wide and the suite runs every file in
 * one process. Without it, the file that proves the latch works makes every later
 * file's writes an agent's: eight unrelated tests failed that way, all of them
 * about a person doing something an agent may not.
 */
export function clearAgentSession(): void { agentSession = false; }

export function resolveActor(root: string, input: ActorInput = {}): Actor | null {
  const principal = input.principal?.trim() || resolvePrincipal(root);
  if (!principal) return null;
  const model = input.model?.trim() || process.env.CODEMAP_AGENT_MODEL?.trim();
  // Observed first: see `markObservedClient`. The self-report is the fallback for
  // the CLI, where there is no handshake to observe.
  const harness = observedClient || input.harness?.trim() || process.env.CODEMAP_AGENT_HARNESS?.trim();
  // The SURFACE decides, not just the environment: `markAgentSession` covers MCP,
  // whose caller is an agent by construction, and the env vars cover a harness
  // driving the CLI. Making every call site pass a flag is how one ends up not
  // passing it — which is what happened to MCP before `markAgentSession` existed.
  //
  // And the latch is a RATCHET: `input.agent` cannot clear it. This was
  // `input.agent ?? (agentSession || …)`, so an explicit `agent: false` won — and no tool
  // declares that field, while the `additionalProperties: false` on every tool schema was
  // enforced nowhere. One undeclared boolean bought a principal: `ratify_spec` with
  // `{agent: false}` adopted a spec from an MCP session and stored `ratifiedBy` with no
  // `via`, recording an agent's act as a person's. `clearAgentSession` is the only way
  // back and has no production caller — same precedent as `ops/annotations.ts`: a
  // test-only export beats an input flag.
  const isAgent = agentSession || (input.agent ?? !!(model || harness));
  return {
    principal,
    ...(input.github?.trim() ? { github: input.github.trim() } : {}),
    ...(isAgent ? { via: { kind: "agent" as const, ...(model ? { model } : {}), ...(harness ? { harness } : {}) } } : {}),
  };
}

/**
 * The actor for a write that RECORDS ATTRIBUTION, or an error refusing it.
 *
 * Writes fail rather than degrade. An unattributed record is the one thing a
 * shared store cannot repair later — the person who made it is not recoverable
 * from anywhere — so the cost of stopping now is a config line, and the cost of
 * proceeding is a record nobody can ever stand behind.
 *
 * Not applied to `init`, `check` or any read: those record nothing about anyone,
 * and a map you cannot even LOOK at without configuring git would be a worse tool
 * for no gain.
 */
export function requireActor(root: string, input: ActorInput = {}): Actor | { error: string } {
  const a = resolveActor(root, input);
  if (a) return a;
  return {
    error:
      "no identity: this records who did it, and there is nobody to name. Set one with "
      + "`git config user.email you@example.com` (add --global to set it everywhere), "
      + "or set CODEMAP_PRINCIPAL. Reading the map needs none of this — only writes that "
      + "carry attribution do.",
  };
}

/** An agent's action, as opposed to a person's own. */
export const isAgentActor = (a: Actor | undefined): boolean => !!a?.via;

/**
 * Whether `b` is an independent witness of `a`'s work.
 *
 * Compares PRINCIPALS, not sessions and not models. Two agents run by the same
 * person are the same person's opinion twice, however different their models —
 * without this, "three models confirmed it" can mean one human's agent agreeing
 * with itself three times.
 */
export function isIndependent(a: Actor | undefined, b: Actor | undefined): boolean {
  if (!a || !b) return false;
  return a.principal !== b.principal;
}

/**
 * Whether `b` is likely to make DIFFERENT MISTAKES than `a` — a distinct error
 * profile, not a distinct interest.
 *
 * `isIndependent` above answers "is this a second person who might disagree",
 * which is the right question for authority: three models run by one person are
 * that person's opinion three times. But it is the WRONG question for "is this
 * defect real", and on a team where the reviewer is also the one dispatching the
 * agents it is structurally always false — a field that cannot vary tells the
 * queue nothing.
 *
 * So this is the other half, recorded beside it rather than replacing it. The
 * practice it exists to score: one vendor's model finds, another's verifies.
 *
 * Conservative by construction — two agents whose harness and model are both
 * unknown are NOT independent here. Nothing establishes it, and claiming a
 * corroboration is error-independent when it may be the same model twice is the
 * direction with no recovery.
 */
export function isErrorIndependent(a: Actor | undefined, b: Actor | undefined): boolean {
  if (!a || !b) return false;
  const [va, vb] = [a.via, b.via];
  // A person and an agent read differently enough that this is the easy case.
  if (!va !== !vb) return true;
  // Two people: their error profiles differ exactly when they are different people.
  if (!va && !vb) return a.principal !== b.principal;
  // Two agents. `harness` is transport-observed (see `markObservedClient`) and is
  // the one an agent cannot spell for itself, so it is checked first; `model` is a
  // self-report and only ever ADDS evidence of difference, never removes it.
  //
  // BOTH sides must carry a field before it can separate them, and that is the
  // conservatism this rule exists for: an agent with nothing recorded MIGHT BE the
  // other one, and nothing here establishes otherwise. A `profile` KEY cannot say
  // that — an unknown has to equal everything, which no key does — which is why an
  // attempt to derive this from one produced 160 disagreements over 400 pairs, every
  // one of them over-claiming independence. See `errorProfiles`.
  if (va!.harness && vb!.harness && va!.harness !== vb!.harness) return true;
  if (va!.model && vb!.model && va!.model !== vb!.model) return true;
  return false;
}

/**
 * How many mutually error-independent looks a set of actors represents — a LOWER
 * BOUND, and deliberately.
 *
 * Not a set of keys. `isErrorIndependent` is not an equivalence relation: an agent
 * with nothing recorded is "cannot establish a difference" against every other
 * agent, so it merges with all of them and transitivity fails. Greedy accumulation
 * of a mutually-independent set is what that relation supports, and n here is the
 * number of marks on one level — small.
 *
 * Under-claiming is the safe direction: reporting one profile where there were two
 * costs a little credit, and reporting two where there was one manufactures
 * corroboration that nobody performed.
 */
export function errorProfiles(actors: (Actor | undefined)[]): number {
  const kept: Actor[] = [];
  for (const a of actors) {
    if (!a) continue;
    if (kept.every((k) => isErrorIndependent(k, a))) kept.push(a);
  }
  return kept.length;
}

/**
 * Who formed an opinion — the person, and if a model spoke for them, which one.
 *
 * NOT the person alone. A reviewer running two models produces two verdicts, and
 * they are two opinions rather than one revised one: collapsing them makes the
 * second silently overwrite the first, disagreement included. NOT the clone
 * either — a person re-reviewing from their desktop has changed their mind, and
 * that is a replacement, not a second voice. See PROPOSAL-provenance.md §4.
 */
export const reviewerKey = (a: Actor): string => `${a.principal}\0${a.via?.model ?? ""}`;

/**
 * A short human-readable form, for display and for the legacy string fields that
 * still exist alongside the structured actor.
 */
export function actorLabel(a: Actor): string {
  return a.via ? `${a.principal} (${a.via.model ?? "agent"})` : a.principal;
}
