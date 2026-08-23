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
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
 * A backstop under the stamp below, not a substitute for it.
 *
 * `.git/config` is what `git remote add/set-url` writes, so the stamp catches the
 * ordinary case the instant it happens. It does NOT catch every way the effective
 * origin can move: `url.*.insteadOf` rewrites it from global or system config,
 * `include.path`/`includeIf` can put `remote.origin.url` in another file entirely,
 * and a coarse-resolution filesystem can hide a same-size rewrite inside one tick.
 * Re-resolving once a minute costs one spawn and makes all of those self-heal.
 */
const KEY_TTL_MS = 60_000;
const keyCache = new Map<string, { stamp: string; at: number; key: string }>();

/**
 * `.git/config` as a change signal — the file `git remote` writes.
 *
 * Null when there is no ordinary `.git` directory: a gitless universe (there is
 * one in the guinea-pig set) or a worktree, where `.git` is a FILE pointing at a
 * shared common dir. Resolving that needs another spawn, which is the cost being
 * avoided, so those roots simply do not cache — the behaviour they had before.
 * Nanosecond mtime for the same reason `scopeFingerprint` uses it: millisecond
 * resolution collapses a write that lands in the same tick as the read.
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

/** Scope keys, universe-prefixed. The one place that layout is decided. */
export const scopeFor = (cfg: SidecarConfig, kind: string, key: string | number): string =>
  `${cfg.universe}/${kind}-${key}`;
