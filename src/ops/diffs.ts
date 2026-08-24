import { computeDiff, anchorCodeDiff, docDiff as computeDocDiff } from "../diff.js";
import { reviewTriageFor } from "../triage.js";

/**
 * Diff two anchor snapshots — added/removed/changed symbols plus the impact on
 * the nodes, flows, and reviews that cite them. `base` is a cached snapshot; omit
 * `head` to diff against a fresh index of the current working tree (the PR-review
 * path), or pass a second cached ref for a pure historical set-op.
 */
export async function diff(root: string, base: string, head?: string) {
  await materializeDocs(root);
  return computeDiff(root, base, head);
}

/**
 * Fold the docs scope before a read that goes STRAIGHT to `diff.ts`.
 *
 * Swapping `loadNodes` for `loadNodesShared` inside `src/ops/` did not cover these:
 * they call into `diff.ts`, which reads the store directly. So on a store whose docs
 * scope had not been folded by some unrelated read, `diff` and `docDiff` omitted
 * teammate docs entirely — which is precisely the attribution the diff surfaces were
 * just taught to show. Materialize at the public boundary instead.
 */
async function materializeDocs(root: string): Promise<void> {
  await import("../ops-shared.js").then((m) => m.docsVerdict(root)).catch(() => null);
}

/** Diff a doc's prose between the versions that win on base vs head (grounds the code diff). */
export async function docDiff(root: string, base: string, head: string | undefined, id: string) {
  await materializeDocs(root);
  return computeDocDiff(root, base, head, id);
}

/** Before/after source for one anchor between two refs (the code drill-down) + its review state. */
export async function diffCode(root: string, base: string, head: string | undefined, id: string, file: string) {
  const code = await anchorCodeDiff(root, base, head, id, file);
  let e: Awaited<ReturnType<typeof reviewTriageFor>> extends Map<string, infer V> ? V | undefined : never;
  try {
    e = (await reviewTriageFor(root, [{ kind: "anchor", id }])).get(`anchor:${id}`);
  } catch { /* review state best-effort */ }
  const rp = e?.review;
  return {
    ...code,
    review: { logical: rp?.logical.state ?? "unreviewed", code: rp?.code.state ?? "unreviewed" },
    reviewBy: { logical: rp?.logical.actor ?? null, code: rp?.code.actor ?? null },
    // `via` travels with every mark a surface can DRAW, or that surface renders an
    // unverifiable sign-off as an ordinary green tick and clears it on click.
    reviewVia: { logical: rp?.logical.via, code: rp?.code.via },
    viewed: { logical: e?.viewed.logical.state ?? "unreviewed", code: e?.viewed.code.state ?? "unreviewed" },
    triage: e?.triage,
    severity: e?.triage.severity ?? "untriaged",
  };
}

