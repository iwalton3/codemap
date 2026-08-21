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
import { existsSync } from "node:fs";
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
export function universeKey(root: string): string {
  const slug = originSlug(root);
  return slug ? `${slug.owner}/${slug.repo}`.toLowerCase() : basename(resolve(root)).toLowerCase();
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
