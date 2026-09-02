/**
 * Where the sidecar is, and which universe's corner of it to use.
 *
 * One sidecar repo holds several universes, because a team reviews several repos
 * and cloning a sidecar per repo multiplies the setup cost for no benefit. Scopes
 * are therefore prefixed with a universe key, so `Acme.API`'s findings for PR 264
 * and `Acme.Settlement`'s cannot collide — which matters more than it looks,
 * because those two share a submodule and its anchor ids are IDENTICAL across
 * them (see PROPOSAL-shared-review-state.md).
 *
 * Configured, in precedence order, by `CODEMAP_SIDECAR`, a `.codemap/sidecar`
 * pointer file, or `sidecar` in the workspace manifest. The manifest is where it
 * belongs for a TEAM — one repo serves every universe, and the manifest already
 * sits above them — while the env var and pointer stay for one person trying it
 * out on a single repo. Deliberately not a new config format.
 */

import { readFileSync } from "node:fs";
import { existsSync, statSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { readStoreMeta, writeStoreMeta, hasFoldedFromSidecar, SIDECAR_LINEAGE, type SidecarMark } from "./store.js";
import { sidecarLineage, isSameSidecar } from "./sidecar.js";
import { CODEMAP_DIR } from "./schema.js";
import { originSlug } from "./git.js";

/** `.codemap/sidecar` — a file holding the sidecar's path, or a directory that IS it. */
export const POINTER = "sidecar";

export interface SidecarConfig {
  /** The sidecar repo's root. */
  path: string;
  /** This universe's prefix inside it. */
  universe: string;
}

/**
 * A stable, human-legible key for a universe.
 *
 * `owner/repo` when git knows it, because that is the thing two people will
 * actually agree on — a directory name is whatever each of them happened to clone
 * into. The slash becomes a separator in the scope path, which is fine and reads
 * well: `acme/api/findings/pr-264`.
 */
/**
 * Cached briefly, because deriving it spawns `git remote get-url` and
 * `resolveSidecar` is now on a per-ANCHOR read path (`getAnchor`), not only on the
 * shared ops. Measured at ~0.97ms a call, essentially all of it the spawn; a burst
 * of reads pays it once.
 *
 * A TTL rather than process lifetime, and the `db()` connection cache is NOT the
 * precedent to copy: a root's database is a fixed relationship, while the origin
 * is mutable configuration that decides the NAMESPACE everything shared is written
 * under. `git init`, then `git remote add origin`, then keep using the running
 * `serve.js` is an ordinary morning — and a permanent memo would keep writing that
 * universe's scopes under the directory name while teammates read `owner/repo`,
 * silently, until a restart. Same shape as `fetchPrMeta`'s TTL and for the same
 * reason: the field genuinely moves.
 */
/**
 * Cached, because deriving this spawns `git remote get-url` and `resolveSidecar` is
 * on a per-ANCHOR read path. Two invalidations, and both are needed:
 *
 * - `.git/config`'s stamp, the file `git remote add/set-url` writes, so the
 *   ordinary case is caught the instant it happens.
 * - A TTL under it, for the ways the effective origin moves without that file:
 *   `url.*.insteadOf` from global or system config, `include.path`/`includeIf`
 *   putting the remote elsewhere, a coarse-resolution filesystem hiding a same-size
 *   rewrite inside one tick.
 *
 * NOT process-lifetime like `db()`'s connection: the origin decides the NAMESPACE
 * everything shared is written under, and `git init` then `git remote add` then
 * carrying on with the running server is an ordinary morning.
 */
const KEY_TTL_MS = 60_000;
const keyCache = new Map<string, { stamp: string; at: number; key: string }>();

/**
 * Null where there is no ordinary `.git` directory — a gitless universe, or a
 * worktree where `.git` is a FILE pointing at a shared common dir. Resolving that
 * needs the spawn this exists to avoid, so those roots do not cache at all.
 * Nanosecond mtime for `scopeFingerprint`'s reason: milliseconds collapse a write
 * that lands in the same tick as the read.
 */
function configStamp(root: string): string | null {
  try {
    const st = statSync(join(root, ".git", "config"), { bigint: true });
    return `${st.mtimeNs}:${st.size}`;
  } catch { return null; }
}

export function universeKey(root: string): string {
  const stamp = configStamp(root);
  const hit = keyCache.get(root);
  if (hit && stamp !== null && hit.stamp === stamp && Date.now() - hit.at < KEY_TTL_MS) return hit.key;
  const slug = originSlug(root);
  const key = slug ? `${slug.owner}/${slug.repo}`.toLowerCase() : basename(resolve(root)).toLowerCase();
  if (stamp !== null) keyCache.set(root, { stamp, at: Date.now(), key });
  return key;
}

/**
 * Resolve the sidecar for a universe, or null when none is configured.
 *
 * Null is not an error anywhere: a store with no sidecar is exactly what codemap
 * has always been, and every shared feature is additive on top of it.
 */
export function resolveSidecar(root: string): SidecarConfig | null {
  const universe = universeKey(root);
  const env = process.env.CODEMAP_SIDECAR?.trim();
  if (env) return { path: resolve(env), universe };

  const pointer = join(root, CODEMAP_DIR, POINTER);
  if (existsSync(pointer)) {
    try {
      const p = readFileSync(pointer, "utf8").trim().split("\n")[0]!.trim();
      if (p) return { path: isAbsolute(p) ? p : resolve(root, p), universe };
    } catch {
      // Unreadable as a file means it is a directory named `sidecar`, which IS the
      // sidecar — the zero-configuration case, for one person trying it out.
      return { path: pointer, universe };
    }
  }

  // The workspace manifest is the place this belongs for a team: one sidecar
  // serves every universe, and the manifest already sits above them. Found by
  // walking up rather than passed in, so no caller has to thread it through.
  const fromWorkspace = workspaceSidecar(root);
  return fromWorkspace ? { path: fromWorkspace, universe } : null;
}

/** `sidecar` from the nearest `codemap.workspace.json` at or above `root`. */
export function workspaceSidecar(root: string): string | null {
  let dir = resolve(root);
  // Bounded: a universe sits just under its workspace, and an unbounded walk would
  // happily read a manifest belonging to somebody else's project further up.
  for (let i = 0; i < 4; i++) {
    const manifest = join(dir, "codemap.workspace.json");
    if (existsSync(manifest)) {
      try {
        const m = JSON.parse(readFileSync(manifest, "utf8")) as { sidecar?: string };
        const p = m.sidecar?.trim();
        if (p) return isAbsolute(p) ? p : resolve(dir, p);
      } catch { /* a malformed manifest is the loader's problem to report, not ours */ }
      return null;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The cache key's identity half — WHICH sidecar a scope's rows came from.
 *
 * Lives here because `ops-shared.ts` and `triage-publish.ts` both need it and one may
 * not import the other (see the note at the top of `triage-publish.ts`). Two copies
 * that drift would key one universe's scopes two ways: every read a miss, and two rows
 * for one scope racing to overwrite each other.
 *
 * `realpath` so two paths to one sidecar are one identity — and the raw path when it
 * does not exist yet, which is an ordinary state before the first `ensureSidecar`.
 */
export const sidecarIdentity = (cfg: { path: string }): string => {
  try { return realpathSync(cfg.path); } catch { return cfg.path; }
};

/** Scope keys, universe-prefixed. The one place that layout is decided. */
export const scopeFor = (cfg: SidecarConfig, kind: string, key: string | number): string =>
  `${cfg.universe}/${kind}-${key}`;

/**
 * Is this scope part of the given universe? One sidecar can carry several.
 *
 * The inverse of `scopeFor`, and it lives beside it so the two cannot drift: a scope is
 * `<kind>/<universe>/<key>`, so the first segment is the kind and everything after it is
 * what `scopeFor` produced.
 */
export function inUniverse(scope: string, universe: string): boolean {
  const rest = scope.slice(scope.indexOf("/") + 1);
  return rest === universe || rest.startsWith(universe + "/");
}

/**
 * May this store bind to the sidecar it is configured with — for a WRITE?
 *
 * The reads have their own halves (`logRootMissing` / `wrongSidecar` in `materialize.ts`,
 * which decline to fold and keep serving) and the transport has its refusals in
 * `ops-shared.ts`. This is the third end, and leaving it out was a hole the other two
 * disguised: `bugLog` and `bind` resolve the config and hand it straight to
 * `ensureSidecar`, so after a repoint `report_bug` appended its event to the STRANGER's
 * log, the read then correctly declined to fold it, and the op answered `ok` with an id
 * for a bug that was in no table on any machine. Measured, not reasoned about.
 *
 * Same two conditions as the transport, in the same order and for the same reasons:
 * an absent path this store has used before, then a path whose history is not the one
 * this store's rows came from. Recorded on first sight, which grandfathers every
 * existing store — see `checkSidecarIdentity`, which this is the write-side twin of.
 */
export function checkSidecarBinding(root: string, cfg: SidecarConfig): { error: string } | null {
  if (!existsSync(cfg.path)) {
    if (!hasFoldedFromSidecar(root)) return null;   // a first sync legitimately creates it
    return { error:
      `the sidecar this store has been using is not at ${cfg.path}, so there is nowhere to write. `
      + `Writing would create a NEW, empty sidecar there and put you on a team of one, silently. `
      + `Check .codemap/sidecar for a typo, mount the drive, or clone the sidecar to that path — `
      + `nothing has been lost.` };
  }
  const mark = readStoreMeta<SidecarMark>(root, SIDECAR_LINEAGE);
  const here = sidecarLineage(cfg.path);
  if (!mark?.lineage) {
    if (here) writeStoreMeta(root, SIDECAR_LINEAGE, { lineage: here, path: cfg.path } satisfies SidecarMark);
    return null;
  }
  if (here && isSameSidecar(cfg.path, mark.lineage)) return null;
  return { error:
    `${cfg.path} is a different sidecar from the one this store has been using `
    + `(${mark.lineage.slice(0, 12)}, last seen at ${mark.path}). Refusing to write: the event would `
    + `land in that sidecar's log while this store's rows still describe the old one, so it would be `
    + `in no table on any machine. Fix the path, or run \`codemap sidecar adopt\` if the move is `
    + `deliberate.` };
}

/**
 * The sidecar a WRITE may use, or null.
 *
 * The single door every mirror goes through, and it exists because guarding two of them
 * was worse than guarding none: `bind` and `bugLog` refused a bad binding while
 * `mirrorNote`, `mirrorWiring`, `mirrorTriage*`, `standard-publish`, `provisional`,
 * `promote-annotation` and `findings-unify` each resolved the config themselves and handed
 * it straight to `ensureSidecar`. So `report_bug` refused and `annotate` — an ordinary
 * daily verb — answered `shared: true` while its event went into a stranger's log, or, at
 * a typo'd path, MADE a sidecar there: `.git`, `.gitattributes`, `manifests`, `notes`, and
 * a team of one. The comment on `bind` claimed every write came through it. It did not.
 *
 * Null rather than an error, because that is what these callers already do with "no
 * sidecar configured" — they report `shared: false` and the local write stands. The
 * person is told by the next thing that speaks: a bug, a sync or a status, all of which
 * refuse with the reason.
 */
export function sidecarForWrite(root: string): SidecarConfig | null {
  const cfg = resolveSidecar(root);
  if (!cfg) return null;
  return checkSidecarBinding(root, cfg) ? null : cfg;
}
