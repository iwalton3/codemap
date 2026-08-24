/**
 * Workspaces: several "universes" (each a repo with its own `.codemap/`) served
 * together, with cross-universe references at API boundaries.
 *
 * A reference is a string. Bare (`refunds-flow`) means "this universe"; qualified
 * (`api::submit-refund-handler`) reaches another universe. Existing single-repo
 * data is all bare ids — this is backward compatible.
 */

import { resolve, dirname, isAbsolute, basename } from "node:path";
import { stat, readFile } from "node:fs/promises";

export interface Universe {
  id: string;
  path: string;
  primary: boolean;
  /**
   * Analyzers this universe EXPECTS to have been run, e.g. `["marten"]`.
   *
   * A default rather than an instruction: nothing runs it for you, and a store that has
   * not is not broken. What it buys is a teammate knowing what to run, which stops
   * being cosmetic once the graph syncs — a human edge can cite an analyzer-generated
   * node, and analyzer output deliberately never travels because every clone can
   * regenerate it. Measured on the primary target: 84 of 279 shareable edges (30%)
   * point at analyzer-derived nodes, so a clone that has not run them sees a third of
   * the team's wiring unresolved and no reason why.
   *
   * Per universe rather than per workspace: one repo is Marten/C#, another is React,
   * and telling the React clone to run Marten would be noise.
   */
  analyzers?: string[];
}

export interface Workspace {
  universes: Universe[];
  primary: Universe;
  byId: Map<string, Universe>;
  manifestPath?: string;
  /**
   * The shared review sidecar for every universe here (see `sidecar-config.ts`).
   * One repo serves them all, so it belongs to the workspace rather than being
   * configured once per universe — which is the setup a team actually has.
   */
  sidecar?: string;
}

/** A manifest's analyzer list, or undefined. Junk is dropped rather than thrown on. */
function analyzerList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim());
  return out.length ? out : undefined;
}

export function parseRef(ref: string): { universe?: string; id: string } {
  const i = ref.indexOf("::");
  return i === -1 ? { id: ref } : { universe: ref.slice(0, i), id: ref.slice(i + 2) };
}

export function qualify(universe: string, id: string): string {
  return `${universe}::${id}`;
}

/**
 * Load a workspace. `arg` may be a `codemap.workspace.json` manifest (multi
 * universe) or a plain repo directory (a single-universe workspace, so the MCP
 * server's single-repo launch keeps working unchanged).
 */
export async function loadWorkspace(arg: string): Promise<Workspace> {
  const abs = resolve(arg);
  const st = await stat(abs);
  let universes: Universe[];
  let manifestPath: string | undefined;
  let sidecar: string | undefined;

  if (st.isFile()) {
    manifestPath = abs;
    const manifest = JSON.parse(await readFile(abs, "utf8"));
    const baseDir = dirname(abs);
    sidecar = typeof manifest.sidecar === "string" && manifest.sidecar.trim()
      ? (isAbsolute(manifest.sidecar) ? manifest.sidecar : resolve(baseDir, manifest.sidecar))
      : undefined;
    // A workspace-level `analyzers` is the default for every universe; a universe may
    // override it. Two repos in one workspace are rarely the same stack, so the
    // per-universe value is the one that matters and the default is a convenience.
    const wsAnalyzers = analyzerList(manifest.analyzers);
    universes = (manifest.universes ?? []).map((u: any, i: number) => ({
      id: String(u.id ?? `u${i}`),
      path: isAbsolute(u.path) ? u.path : resolve(baseDir, u.path),
      primary: Boolean(u.primary),
      ...(analyzerList(u.analyzers) ?? wsAnalyzers ? { analyzers: analyzerList(u.analyzers) ?? wsAnalyzers } : {}),
    }));
    if (!universes.length) throw new Error("workspace manifest has no universes");
    const ids = new Set<string>();
    for (const u of universes) {
      if (ids.has(u.id)) throw new Error(`duplicate universe id "${u.id}"`);
      ids.add(u.id);
    }
    if (!universes.some((u) => u.primary)) universes[0]!.primary = true;
  } else {
    universes = [{ id: basename(abs) || "default", path: abs, primary: true }];
  }

  const byId = new Map(universes.map((u) => [u.id, u]));
  const primary = universes.find((u) => u.primary)!;
  return { universes, primary, byId, manifestPath, sidecar };
}
