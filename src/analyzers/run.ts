/**
 * Analyzer coverage: registering an analyzer as "covering" a universe, and
 * re-running its emission when the code moved — so the generated graph stays
 * current without anyone remembering to `--emit`. `check` calls refreshAnalyzers.
 */

import { headCommit } from "../git.js";
import { readAnalyzers, writeAnalyzers } from "../store.js";
import { emitMartenGraph } from "./marten-emit.js";

type Emitter = (root: string) => Promise<Record<string, number>>;
const EMITTERS: Record<string, Emitter> = { marten: emitMartenGraph };

export const availableAnalyzers = (): string[] => Object.keys(EMITTERS);

/** Register an analyzer as covering this universe and emit its graph now. */
export async function enableAnalyzer(root: string, name: string): Promise<{ ok: boolean; error?: string; emitted?: Record<string, number> }> {
  const emit = EMITTERS[name];
  if (!emit) return { ok: false, error: `unknown analyzer "${name}" (available: ${availableAnalyzers().join(", ")})` };
  const cfg = await readAnalyzers(root);
  if (!cfg.enabled.includes(name)) cfg.enabled.push(name);
  const emitted = await emit(root);
  cfg.lastEmit[name] = headCommit(root) ?? "";
  await writeAnalyzers(root, cfg);
  return { ok: true, emitted };
}

/**
 * Re-emit enabled analyzers when the code moved. Triggers when the commit
 * advanced since the last emit, when the caller saw changes (uncommitted edits),
 * or when forced.
 */
export async function refreshAnalyzers(root: string, opts: { changed?: boolean; force?: boolean } = {}): Promise<{ name: string; emitted: Record<string, number> }[]> {
  const cfg = await readAnalyzers(root);
  if (!cfg.enabled.length) return [];
  const head = headCommit(root) ?? "";
  const out: { name: string; emitted: Record<string, number> }[] = [];
  for (const name of cfg.enabled) {
    const emit = EMITTERS[name];
    if (!emit) continue;
    if (opts.force || opts.changed || cfg.lastEmit[name] !== head) {
      out.push({ name, emitted: await emit(root) });
      cfg.lastEmit[name] = head;
    }
  }
  if (out.length) await writeAnalyzers(root, cfg);
  return out;
}
