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
 * Configuration is an env var or a pointer file. Deliberately not a new config
 * format: `CODEMAP_ROOT` and `CODEMAP_HOST` set the precedent, and a pointer file
 * is one line that a person can read and delete.
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
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
  if (!existsSync(pointer)) return null;
  try {
    // A directory named `sidecar` IS the sidecar — the zero-configuration case,
    // for one person trying it out before there is a remote to point at.
    const stat = readFileSync(pointer, "utf8");
    const p = stat.trim().split("\n")[0]!.trim();
    if (!p) return null;
    return { path: isAbsolute(p) ? p : resolve(root, p), universe };
  } catch {
    // Unreadable as a file means it is a directory: use it directly.
    return { path: pointer, universe };
  }
}

/** Scope keys, universe-prefixed. The one place that layout is decided. */
export const scopeFor = (cfg: SidecarConfig, kind: string, key: string | number): string =>
  `${cfg.universe}/${kind}-${key}`;
