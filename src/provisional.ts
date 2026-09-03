/**
 * Provisional audits: documents found by COMMIT, never folded.
 *
 * `docs/cross-universe-standard.md` § *Provisional audits* is normative; this implements
 * it. The hole it closes: a provisional audit stayed on the machine that took it, so a
 * teammate reviewing the branch could not see that it fails a rule, and only its author
 * could ever promote it.
 *
 * **Why a document and not an event.** An event gets folded, and a fold writes rows that
 * `conformance()` reads. Keeping a branch observation out of the team's conformance state
 * by FILTERING it there would be one predicate away from failing — the filter has to be
 * remembered on every surface, and this subsystem's most repeated defect is exactly a
 * guard that exists in one place and not the other. A record with no fold has no path to
 * `conformance()` at all, so the property is structural rather than maintained.
 *
 * `foldStandard` therefore keeps refusing an `audit.recorded` carrying `provisional`, and
 * that guard becomes MORE load-bearing here, not less: this module is not the only way a
 * client could put one in the log.
 *
 * **Keyed by the commit it was taken at**, because that is the question a reviewer asks —
 * *what does codemap know about the code I am looking at?* Promotion does not use the key:
 * it is decided on WITNESSES, the way it always was.
 *
 * **A dirty tree does not travel.** The witnesses come off the filesystem while `commit`
 * records an unchanged HEAD, so filing the document under that commit would attribute
 * uncommitted work to a commit that does not contain it — the dirty-snapshot confusion
 * (COD-3) with a directory name attached. It stays local, which is where it was already.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Audit } from "./schema.js";
import { auditClaimStands } from "./schema.js";
import { resolveSidecar, sidecarWriteDoor, type SidecarConfig } from "./sidecar-config.js";
import { ensureSidecar } from "./sidecar.js";
import { requireActor } from "./identity.js";

/** Under the sidecar root, beside `manifests/` and the scope directories. */
export const PROVISIONAL_DIR = "provisional";

/**
 * `provisional/<universe>/<commit>/<auditId>.json`.
 *
 * One file per audit, which is what makes this conflict-free without a merge driver: two
 * people auditing one commit write two names, and nobody ever rewrites somebody else's
 * file. The universe segments are split explicitly rather than handed to `join` as one
 * string, so `owner/repo` nests the same way on every platform.
 */
const universeDir = (cfg: SidecarConfig): string =>
  join(cfg.path, PROVISIONAL_DIR, ...cfg.universe.split("/").filter(Boolean));

const docPath = (cfg: SidecarConfig, commit: string, id: string): string =>
  join(universeDir(cfg), commit, id + ".json");

const isSha = (s: string): boolean => /^[0-9a-f]{7,64}$/.test(s);

/**
 * Does this directory name answer a caller's `commit`?
 *
 * PREFIX, because documents are filed under the full sha and callers type what git prints.
 * An exact match would answer a short sha with an empty list, and "no findings here" reads
 * as "nothing wrong" — the one wrong answer this whole path exists to stop giving.
 */
export const commitMatches = (asked: string, filed: string | null | undefined): boolean =>
  !!filed && (asked.length >= 40 ? filed === asked : filed.startsWith(asked));

export type Published =
  | { published: true; path: string }
  /** Nothing to publish to, or nothing that could honestly be published. */
  | { published: false; reason: string }
  | { published: false; error: string };

/**
 * Write a provisional audit where the team can find it.
 *
 * `dirty` is passed rather than re-derived: the caller tested the working tree at the
 * moment it took the witnesses, and asking git again here would answer about a tree that
 * may have moved since.
 */
export async function publishProvisionalAudit(
  root: string, audit: Audit, opts: { dirty: boolean },
): Promise<Published> {
  if (!audit.provisional) return { published: false, reason: "not a provisional audit" };
  // ERROR, not `reason`, on a bad binding. The two are different and this path is the one
  // that proves it: "no sidecar" is a store working alone and nothing is owed, while "the
  // configured one is not this store's" is an author who believes their team can see this
  // and is wrong. Routing the second through the quiet return turned a loud failure into a
  // silent one — caught by the test that exists for exactly that.
  const door = sidecarWriteDoor(root);
  if (!door.configured) return { published: false, reason: "no sidecar is configured" };
  if (!door.cfg) return { published: false, error: door.error! };
  const cfg = door.cfg;
  if (!audit.commit) return { published: false, reason: "no commit to file it under" };
  if (opts.dirty) {
    return {
      published: false,
      reason: `the tree was dirty, so ${audit.commit.slice(0, 12)} does not contain the code this witnessed`,
    };
  }
  const actor = requireActor(root);
  if ("error" in actor) return { published: false, error: actor.error };
  try {
    await ensureSidecar(cfg.path, actor);
    const file = docPath(cfg, audit.commit, audit.id);
    await mkdir(join(file, ".."), { recursive: true });
    // No lock. Every other sidecar write takes one because it appends to a file somebody
    // else may be appending to; this one owns its whole path, and a sync that commits it
    // half-written is not a case — `writeFile` replaces, and a torn file simply fails to
    // parse and is skipped by `readProvisionalAudits` until the next write.
    await writeFile(file, JSON.stringify(audit, null, 2) + "\n", "utf8");
    return { published: true, path: file };
  } catch (e: any) {
    return { published: false, error: `could not write the provisional audit: ${e?.message ?? e}` };
  }
}

/**
 * Everything a document claims that this reader will not simply take its word for.
 *
 * A document is written by whatever client the author was running, so the reader is the
 * only end that binds it — the same reason every write gate in this subsystem is repeated
 * in the fold. Two of these are the ones that matter: the audit must say it is
 * `provisional` (a document is not a way to reach `conformance()` by another route), and
 * its `commit` and `universe` must be the ones the PATH claims, or a finding could be
 * filed against an unrelated commit or another repository.
 */
function usable(a: unknown, universe: string, commit: string, file: string): a is Audit {
  const x = a as Audit | null;
  return !!x && typeof x === "object"
    && typeof x.id === "string" && !!x.id && file === x.id + ".json"
    && x.provisional === true
    && x.universe === universe
    && x.commit === commit
    && typeof x.requirementId === "string" && !!x.requirementId
    && typeof x.at === "string"
    && !!x.auditor && typeof x.auditor.principal === "string"
    && Array.isArray(x.witnesses)
    && x.witnesses.every((w) => !!w && typeof w.anchorId === "string" && typeof w.bodyHash === "string")
    // …and the audit has to stand up AS AN AUDIT, which this end did not ask.
    //
    // A file saying `{outcome: "conformant", witnesses: [], evidence: {}, finding: ""}`
    // was read, and `conformance({about:"branch"})` reported the rule conformant — for
    // ever, because a claim with no witnesses can never be superseded. The shape checks
    // above are about the PATH matching the content; this is the same predicate the fold
    // applies to an arriving event, and the reason it is shared rather than copied.
    && auditClaimStands(x);
}

/**
 * Every provisional audit this sidecar holds for THIS universe, oldest first.
 *
 * `commit` narrows it to the code somebody is looking at. Without it the answer is the
 * whole set, which is what `promotableAudits` wants: promotion is decided on witnesses,
 * and a finding taken on a branch that has since merged is filed under a commit nobody
 * will think to ask about.
 *
 * **Unbounded, and measured rather than assumed.** Nothing prunes: an abandoned branch
 * leaves its documents behind, and a promoted finding leaves the one it was promoted from.
 * Measured on this machine at ~28 µs a document, so the whole-set read that
 * `standardStatus` performs costs 33 ms at 500 documents and 170 ms at 5,000 — years of a
 * busy team. Not worth a prune yet; when it is, deleting on PROMOTION is the sound half
 * (a definite terminal state), and drift is not — a superseded finding can come back with
 * a revert.
 *
 * Deletion here is ordinary, deliberately. `erasedByMerge` audits `*.ndjson` only, so the
 * append-only guarantee that protects the log does not cover these — widening that
 * pathspec would make the prune above impossible and buy nothing, because the author's
 * local row survives a document that goes missing.
 */
export async function readProvisionalAudits(
  root: string, opts: { commit?: string } = {},
): Promise<Audit[]> {
  // A READ: `resolveSidecar`, not the write door. Reading documents off a sidecar whose
  // binding is wrong answers with what is on disk, which is the same degradation every
  // other read here makes.
  const cfg = resolveSidecar(root);
  if (!cfg) return [];
  const base = universeDir(cfg);
  let commits: string[];
  if (opts.commit && !isSha(opts.commit)) return [];
  try {
    commits = (await readdir(base, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && isSha(d.name)).map((d) => d.name);
  } catch { return []; }
  if (opts.commit) commits = commits.filter((c) => commitMatches(opts.commit!, c));
  const out: Audit[] = [];
  for (const commit of commits) {
    let files: string[];
    try { files = (await readdir(join(base, commit))).filter((f) => f.endsWith(".json")); } catch { continue; }
    for (const f of files) {
      try {
        const parsed = JSON.parse(await readFile(join(base, commit, f), "utf8")) as unknown;
        if (usable(parsed, cfg.universe, commit, f)) out.push(parsed);
      } catch { /* somebody's client wrote something odd, or a write is in flight */ }
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}
