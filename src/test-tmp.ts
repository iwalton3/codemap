/**
 * Throwaway-directory teardown for the test tree.
 *
 * Every test in this repo that touches a store builds one under `os.tmpdir()` and
 * removes it in a `finally`. Two things went wrong with doing that by hand, and
 * this fixes both at once:
 *
 * 1. **`rmSync` alone cannot remove a store on Windows.** The `.codemap/codemap.db`
 *    handle is cached for the life of the process, POSIX unlinks an open file
 *    happily, and Windows refuses with `EPERM`. That was 398 of 454 Windows
 *    failures — all of them tests that had already PASSED, failing in teardown.
 * 2. **A `finally` is easy to leave out, and nothing notices.** Five tests in
 *    `pr-loop.test.ts` never had one, so every run of that file stranded five
 *    fixtures; 2,375 of them had accumulated in one `/tmp` before anyone looked.
 *    A leak leaves no failing test to point at it — the suite is green either way.
 *
 * Deliberately not a `t.after()` registration: the call sites are `finally` blocks
 * and a straight swap keeps the diff mechanical and reviewable. Closing is a no-op
 * for a root that never held a store, which most sidecar and fixture dirs are, so
 * this is safe for every temp directory the suite makes.
 */

import { rmSync } from "node:fs";
import { closeDbUnder } from "./db.js";

/**
 * Close every store at or beneath this root, then remove the directory.
 *
 * `closeDbUnder`, not `closeDb`: a temp directory is as often a PARENT of stores as
 * a store itself — `oracle.ts` puts a whole team under one — and closing only an
 * exact match would leave the handles that actually block the delete.
 */
export function discard(root: string): void {
  closeDbUnder(root);
  rmSync(root, { recursive: true, force: true });
}

/** Several at once — for helpers that hand out a whole team of universes. */
export function discardAll(roots: Iterable<string>): void {
  for (const r of roots) discard(r);
}
