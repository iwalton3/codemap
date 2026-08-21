/**
 * Scenario fixtures: scripted multi-person review sessions over the sidecar.
 *
 * Built BEFORE contested detection rather than after, on purpose. The whole risk
 * in contested is the false-positive rate — the Marten pass is the precedent, 138
 * false positives before 4 genuine — and you cannot tune a detector against
 * traffic you do not have. This manufactures the traffic: real clones, a real
 * remote, real merges, and precise control over WHO saw WHAT before they wrote.
 *
 * That last part is the point. A scenario can produce genuinely concurrent
 * writes (two people who each pulled before the other pushed) and genuinely
 * sequential ones that merely look simultaneous, and no amount of wall-clock
 * timing distinguishes them. A detector tuned against anything less will call
 * ordinary collaboration a conflict, which is the failure mode that trains people
 * to clear the state without reading it.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Actor } from "./schema.js";
import { gitBin } from "./git.js";
import { ensureSidecar, sync } from "./sidecar.js";
import { readFindings, type SharedFinding } from "./shared-findings.js";
import { readScope, type LogEvent } from "./eventlog.js";
import { findingScope } from "./shared-findings.js";

const git = (root: string, ...args: string[]) =>
  spawnSync(gitBin(), ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

export interface Person {
  actor: Actor;
  /** This person's own sidecar clone — their machine. */
  sidecar: string;
}

export interface Scenario {
  origin: string;
  people: Map<string, Person>;
  /** Every person's clone, for assertions about convergence. */
  all: Person[];
  dispose(): void;
}

/**
 * A team with a shared remote and one clone each.
 *
 * Everyone starts synced, so a scenario's own steps are the only source of
 * divergence — otherwise the first write of every test is accidentally concurrent
 * and nothing measures what it meant to.
 */
export async function scenario(principals: string[]): Promise<Scenario> {
  const dirs: string[] = [];
  const mk = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `codemap-scn-${tag}-`)); dirs.push(d); return d; };

  const origin = mk("origin");
  git(origin, "init", "-q", "--bare", "-b", "main");

  const people = new Map<string, Person>();
  const all: Person[] = [];
  for (const principal of principals) {
    const sidecar = mk(principal.replace(/[^a-z0-9]/gi, ""));
    const actor: Actor = { principal };
    await ensureSidecar(sidecar, actor);
    git(sidecar, "config", "user.email", principal);
    git(sidecar, "config", "user.name", principal);
    git(sidecar, "remote", "add", "origin", origin);
    const p = { actor, sidecar };
    people.set(principal, p);
    all.push(p);
  }
  // Two passes so everyone ends up holding everyone's manifest, not just the
  // people who happened to sync after them.
  for (const p of all) await sync(p.sidecar, p.actor);
  for (const p of all) await sync(p.sidecar, p.actor);

  return { origin, people, all, dispose: () => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

/** An agent acting for a person — same principal, so not an independent witness. */
export const asAgent = (p: Person, model: string): Actor =>
  ({ ...p.actor, via: { kind: "agent", model } });

export const who = (s: Scenario, principal: string): Person => {
  const p = s.people.get(principal);
  if (!p) throw new Error(`no such person in this scenario: ${principal}`);
  return p;
};

/** Send and receive for one person. */
export const step = (s: Scenario, principal: string) => {
  const p = who(s, principal);
  return sync(p.sidecar, p.actor);
};

/** Everybody syncs twice, which is what it takes for a change to reach everyone. */
export async function settle(s: Scenario): Promise<void> {
  for (let round = 0; round < 2; round++) {
    for (const p of s.all) await sync(p.sidecar, p.actor);
  }
}

/**
 * Run `fn` for two people who have NOT seen each other's work — the concurrency
 * this exists to manufacture.
 *
 * Both are synced first, then both write, then both sync. Neither `after` names
 * the other's event, so they are concurrent by the log's own definition rather
 * than by anything as unreliable as a timestamp.
 */
export async function concurrently(
  s: Scenario,
  a: string, aWrite: (p: Person) => Promise<unknown>,
  b: string, bWrite: (p: Person) => Promise<unknown>,
): Promise<void> {
  await settle(s);
  await aWrite(who(s, a));
  await bWrite(who(s, b));
  await settle(s);
}

/**
 * The opposite: `b` writes having demonstrably seen `a`'s work. Sequential, even
 * if it happens in the same second — the case a detector must NOT flag.
 */
export async function inSequence(
  s: Scenario,
  a: string, aWrite: (p: Person) => Promise<unknown>,
  b: string, bWrite: (p: Person) => Promise<unknown>,
): Promise<void> {
  await settle(s);
  await aWrite(who(s, a));
  await settle(s);
  await bWrite(who(s, b));
  await settle(s);
}

/** Every person's view of a PR's findings — for asserting they converged. */
export async function views(s: Scenario, prKey: string | number): Promise<Map<string, Map<string, SharedFinding>>> {
  const out = new Map<string, Map<string, SharedFinding>>();
  for (const p of s.all) out.set(p.actor.principal, await readFindings(p.sidecar, prKey));
  return out;
}

/** The raw log as one person sees it, for asserting about ordering. */
export const eventsFor = (s: Scenario, principal: string, prKey: string | number): Promise<LogEvent[]> =>
  readScope(who(s, principal).sidecar, findingScope(prKey));

/**
 * Assert every clone folded to the same thing, and say precisely what differs
 * when they did not — a bare "not equal" on two Maps of findings is unreadable.
 */
export function assertConverged(all: Map<string, Map<string, SharedFinding>>, describe: (f: SharedFinding) => string): void {
  const shapes = [...all.entries()].map(([principal, m]) => [
    principal,
    [...m.values()].map(describe).sort().join("\n"),
  ] as const);
  const first = shapes[0]?.[1];
  const bad = shapes.find(([, shape]) => shape !== first);
  if (bad) {
    throw new Error(
      `clones diverged — every reader must fold to the same state\n`
      + `  ${shapes[0]![0]}:\n${first}\n`
      + `  ${bad[0]}:\n${bad[1]}`,
    );
  }
}

/** Write a file into a person's clone, for testing what non-event content does. */
export function stray(p: Person, rel: string, content: string): void {
  const abs = join(p.sidecar, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
