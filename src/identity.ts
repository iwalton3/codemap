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
    const r = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8" });
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
export function resolveActor(root: string, input: ActorInput = {}): Actor | null {
  const principal = input.principal?.trim() || resolvePrincipal(root);
  if (!principal) return null;
  const model = input.model?.trim() || process.env.CODEMAP_AGENT_MODEL?.trim();
  const harness = input.harness?.trim() || process.env.CODEMAP_AGENT_HARNESS?.trim();
  // Env presence alone marks the session as an agent's: an MCP server started by a
  // harness is never a person typing, and making every call site pass a flag is how
  // one of them ends up not passing it.
  const isAgent = input.agent ?? !!(model || harness);
  return {
    principal,
    ...(input.github?.trim() ? { github: input.github.trim() } : {}),
    ...(isAgent ? { via: { kind: "agent" as const, ...(model ? { model } : {}), ...(harness ? { harness } : {}) } } : {}),
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
 * A short human-readable form, for display and for the legacy string fields that
 * still exist alongside the structured actor.
 */
export function actorLabel(a: Actor): string {
  return a.via ? `${a.principal} (${a.via.model ?? "agent"})` : a.principal;
}
