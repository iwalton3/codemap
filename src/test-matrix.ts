/**
 * One representative cell of a combinatorial matrix, for a platform run.
 *
 * Some tests are a cross-product: N principals × M values, every cell running the
 * SAME plumbing and differing only in which value somebody picks. The cross-product
 * is what proves the fold picks the right winner, and the fold is deterministic and
 * platform-independent — so proving it once, on Linux, proves it everywhere.
 *
 * What a second platform adds is coverage of the *plumbing*: paths, temp dirs,
 * process spawns, file handles, 8.3 short names. One cell exercises all of that
 * exactly as well as nine.
 *
 * **The criterion is plumbing versus semantics, not subsystem.** A naive "run fewer
 * sidecar tests on Windows" would have missed two of the five Windows-only defects
 * found on 2026-08-26 — the `oracle-race` ESM-scheme failure and the `oracle.ts`
 * separator pair both surfaced in oracle tests. So: keep one instance of every
 * SHAPE, drop only repetition of one code path. Every Windows-only bug this project
 * has hit was plumbing; none was in fold semantics.
 *
 * Why it is worth a mechanism at all: `contest-settle.test.ts` alone was 8,416 git
 * spawns, 30% of the whole suite, and Windows pays ~40ms per spawn against Linux's
 * ~4ms. See COD-14 for the measurements, including the two things that did NOT work
 * (Defender exclusions, and memoizing monotonic git probes).
 *
 * Deliberately opt-IN per call site. A blanket "run less on Windows" switch would
 * decay into nobody knowing what the second platform still covers; a named helper at
 * each matrix is greppable, and the reviewer sees it in the diff that adds it.
 */

/** Every cell, or just the first when `CODEMAP_ONE_CELL` is set. */
export function matrix<T>(cells: readonly T[]): readonly T[] {
  return process.env.CODEMAP_ONE_CELL ? cells.slice(0, 1) : cells;
}

/** True when this run is covering the platform rather than the cross-product. */
export const oneCell = (): boolean => !!process.env.CODEMAP_ONE_CELL;
