/**
 * Importing a back catalogue of GitHub "viewed" ticks.
 *
 * A year of review leaves thousands of per-file ticks on GitHub and nothing in
 * the map. Pulling them in is the cheapest way to make codemap's ground state
 * resemble what someone has actually looked at — but only if it can be done
 * without paying the per-PR cost of a normal review session.
 *
 * So this never snapshots. `prTriage` caches a full anchor snapshot of both sides
 * (~2MB each); across hundreds of PRs that is over a gigabyte of cache to answer
 * a question that only needs the changed files' bodies at head.
 *
 * Progress is recorded per PR so a run that dies halfway resumes instead of
 * redoing hundreds of PRs' network calls.
 */

import { spawnSync } from "node:child_process";
import { changedFilesBetween, readBlobs, hasObject, prBaseCommit } from "./git.js";
import { indexBlob } from "./repo.js";
import { loadLanes, LANE_POLICY } from "./lanes.js";
import { markReviewedBatch, reviewStatesFor } from "./reviews.js";
import { readViewedImports, writeViewedImport } from "./store.js";
import { withLock } from "./lock.js";
import { sameBody } from "./normalize.js";

function gh(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 120_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

export interface PrViewedSurvey { number: number; state: string; author: string; createdAt: string; viewed: number; dismissed: number; unviewed: number }

/** `unknown` means the survey could not answer — NOT that there are no ticks. */
export interface SurveyCount { viewed: number; dismissed: number; unviewed: number; unknown?: boolean }

/**
 * Per-file viewed state for a page of PRs in one query, via GraphQL aliases.
 * One request per 20 PRs rather than per PR — the difference between a survey
 * that costs 30 requests and one that costs 600.
 *
 * It is a cheap GATE, not an answer: it reads only the first page of files, and a
 * batch can fail outright. Both cases now come back `unknown` so the caller checks
 * the pull request properly instead of reading silence as "nothing to import".
 * They used to be indistinguishable from zero ticks, which quietly dropped any PR
 * whose ticks were past file 100 — and, because `gh api graphql` exits non-zero if
 * ANY aliased PR in the batch is inaccessible, all 20 of a batch containing one
 * deleted pull request.
 */
export function surveyViewed(slug: string, numbers: number[], deps: { gh?: typeof gh } = {}): Map<number, SurveyCount> {
  const gh_ = deps.gh ?? gh;
  const [owner, repo] = slug.split("/");
  const out = new Map<number, SurveyCount>();
  const unknown = (batch: number[]) => { for (const n of batch) out.set(n, { viewed: 0, dismissed: 0, unviewed: 0, unknown: true }); };
  for (let i = 0; i < numbers.length; i += 20) {
    const batch = numbers.slice(i, i + 20);
    const q = `query{repository(owner:"${owner}",name:"${repo}"){`
      + batch.map((n) => `p${n}: pullRequest(number:${n}){files(first:100){pageInfo{hasNextPage} nodes{viewerViewedState}}}`).join(" ") + `}}`;
    const r = gh_(["api", "graphql", "-f", `query=${q}`]);
    if (!r.ok) { unknown(batch); continue; }
    try {
      const data = JSON.parse(r.out).data.repository;
      for (const n of batch) {
        const files = data[`p${n}`]?.files;
        if (!files) { out.set(n, { viewed: 0, dismissed: 0, unviewed: 0, unknown: true }); continue; }
        const c: SurveyCount = { viewed: 0, dismissed: 0, unviewed: 0 };
        for (const x of files.nodes ?? []) {
          if (x.viewerViewedState === "VIEWED") c.viewed++;
          else if (x.viewerViewedState === "DISMISSED") c.dismissed++;
          else c.unviewed++;
        }
        // More files than this page: the ticks may all be past it, so "0 viewed"
        // here proves nothing.
        if (files.pageInfo?.hasNextPage && !c.viewed) c.unknown = true;
        out.set(n, c);
      }
    } catch { unknown(batch); }
  }
  return out;
}

/** Every VIEWED path for one PR, paginated. */
export function viewedPaths(slug: string, number: number, deps: { gh?: typeof gh } = {}): Set<string> | { error: string } {
  const gh_ = deps.gh ?? gh;
  const [owner, repo] = slug.split("/");
  const out = new Set<string>();
  let after: string | null = null;
  const MAX_PAGES = 40;                       // 4,000 files is far past any reviewable PR
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = `query($after:String){repository(owner:"${owner}",name:"${repo}"){pullRequest(number:${number}){files(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`;
    const args = ["api", "graphql", "-f", `query=${q}`];
    if (after) args.push("-f", `after=${after}`);
    const r = gh_(args);
    if (!r.ok) return { error: r.err.slice(0, 200) };
    try {
      const f = JSON.parse(r.out).data.repository.pullRequest.files;
      for (const n of f.nodes) if (n.viewerViewedState === "VIEWED") out.add(n.path);
      if (!f.pageInfo.hasNextPage) return out;
      after = f.pageInfo.endCursor;
    } catch (e) { return { error: (e as Error).message }; }
  }
  // Falling out of the loop means pages remain. Returning the partial set as a
  // success let the caller write a COMPLETED import record for a PR it had only
  // half read, so the rest was never retried without --force.
  return { error: `more than ${MAX_PAGES * 100} files — the viewed list was not read to the end` };
}

/**
 * The symbols a pull request actually CHANGED in the files it touched — not every
 * symbol those files happen to contain.
 *
 * A tick on a 30-symbol file where the PR touched one method must not record
 * exposure to the other 29: GitHub never rendered them, and those marks would then
 * satisfy `pr-push`'s vetting gate. This was inline and untested while a `pr-push`
 * helper that did the WRONG thing — every anchor in the file, and a tip-based
 * merge-base rather than the PR's recorded one — carried the test asserting the
 * property. That helper is gone; this is the path that runs.
 */
export async function changedSymbolsIn(
  headBlobs: Map<string, string>,
  baseBlobs: Map<string, string>,
  index: (src: string, path: string) => Promise<{ id: string; bodyHash: string }[]>,
): Promise<{ ids: string[]; hashes: Map<string, string> }> {
  const ids: string[] = [];
  const hashes = new Map<string, string>();
  for (const [path, src] of headBlobs) {
    const before = new Map((await index(baseBlobs.get(path) ?? "", path)).map((a) => [a.id, a.bodyHash]));
    for (const a of await index(src, path)) {
      if (sameBody(before.get(a.id) ?? "", a.bodyHash)) continue;   // unchanged by this PR
      ids.push(a.id);
      hashes.set(a.id, a.bodyHash);
    }
  }
  return { ids, hashes };
}

export interface BulkViewedResult {
  surveyed: number;
  withTicks: number;
  processed: number;
  skippedAlreadyImported: number;
  marked: number;
  leftSigned: number;
  errors: { pr: number; why: string }[];
  /** The PR listing hit its cap — older pull requests were never surveyed. */
  listTruncated: boolean;
  /** PRs the cheap survey could not settle, so they were checked in full. */
  unresolvedBySurvey: number;
}

export async function bulkPullViewed(
  root: string,
  slug: string,
  opts: { force?: boolean; limit?: number; maxPrs?: number; dryRun?: boolean; onProgress?: (msg: string) => void } = {},
): Promise<BulkViewedResult | { error: string }> {
  const log = opts.onProgress ?? (() => {});
  // `gh pr list` returns NEWEST first, and the sort to oldest-first below happens
  // after this cap — so a hardcoded 400 silently truncated exactly the back
  // catalogue this module exists to import. The cap is now explicit and, when it
  // bites, reported rather than presented as the whole repository.
  const maxPrs = opts.maxPrs ?? 2000;
  const listed = gh(["pr", "list", "--repo", slug, "--state", "all", "--limit", String(maxPrs), "--json", "number,state,author,createdAt"]);
  if (!listed.ok) return { error: `gh pr list failed: ${listed.err.slice(0, 200)}` };
  const prs: { number: number; state: string; author: { login: string } | null; createdAt: string }[] = JSON.parse(listed.out);
  const listTruncated = prs.length >= maxPrs;
  // Oldest first, so an accepted set reads chronologically. This used to be load
  // bearing — `resolveAcceptance` inferred supersession from array position, and a
  // newest-first import made every earlier body look reverted-to. It now derives
  // that from git ancestry instead, so this is presentation, not correctness.
  prs.sort((a, b) => a.number - b.number);
  if (listTruncated) {
    log(`! only the newest ${maxPrs} pull requests were listed; anything older than #${prs[0]!.number} was not surveyed (raise --max-prs)`);
  }

  log(`surveying ${prs.length} pull requests…`);
  const survey = surveyViewed(slug, prs.map((p) => p.number));
  // `unknown` is a survey that could not answer — a PR whose files ran past the
  // first page, or a batch that failed. Checking it properly costs one paginated
  // request; reading it as "no ticks" cost the whole import silently.
  const unresolved = prs.filter((p) => survey.get(p.number)?.unknown).length;
  const withTicks = prs.filter((p) => { const c = survey.get(p.number); return !!c && (c.viewed > 0 || !!c.unknown); });
  log(`${withTicks.length} to check${unresolved ? ` (${unresolved} the survey could not settle — checked in full)` : ""}`);

  const already = (await readViewedImports(root)).imported;
  const lanes = await loadLanes(root);
  const res: BulkViewedResult = {
    surveyed: prs.length, withTicks: withTicks.length, processed: 0, skippedAlreadyImported: 0,
    marked: 0, leftSigned: 0, errors: [], listTruncated, unresolvedBySurvey: unresolved,
  };

  const targets = opts.limit ? withTicks.slice(0, opts.limit) : withTicks;
  for (const p of targets) {
    // "nothing to import for this PR" is still a store write, and still has to be
    // atomic against the user's own server.
    const recordEmpty = () => withLock(root, () => writeViewedImport(root, String(p.number), 0));
    if (!opts.force && already[String(p.number)]) { res.skippedAlreadyImported++; continue; }
    try {
      const meta = gh(["pr", "view", String(p.number), "--repo", slug, "--json", "baseRefName,headRefOid,baseRefOid"]);
      if (!meta.ok) { res.errors.push({ pr: p.number, why: "gh pr view failed" }); continue; }
      const { baseRefName, headRefOid, baseRefOid } = JSON.parse(meta.out);
      // The head must already be local. Nothing here fetches: a back-catalogue run
      // is for a clone that already has the PR refs (`git fetch origin
      // "+refs/pull/*/head:refs/remotes/origin/pr/*"`), because paying a round trip
      // per pull request across hundreds of them is the cost this module exists to
      // avoid. A PR whose head is missing is reported, not silently skipped.
      if (!hasObject(root, headRefOid)) { res.errors.push({ pr: p.number, why: "head object not fetched" }); continue; }

      const paths = viewedPaths(slug, p.number);
      if ("error" in paths) { res.errors.push({ pr: p.number, why: paths.error }); continue; }
      if (!paths.size) { if (!opts.dryRun) await recordEmpty(); res.processed++; continue; }

      // GitHub's recorded base sha, not the branch tip: a merged PR's head is an
      // ancestor of the tip, so that merge-base is the head and the diff is empty.
      // This is a back catalogue — most of it is merged.
      const mb = prBaseCommit(root, { recordedBase: baseRefOid, baseRef: baseRefName, headSha: headRefOid });
      if (!mb || mb === headRefOid) { res.errors.push({ pr: p.number, why: `could not locate a base for ${baseRefName}` }); continue; }

      const files = changedFilesBetween(root, mb, headRefOid)
        .filter((f) => paths.has(f) && LANE_POLICY[lanes.classify(f)]?.review === "queue");
      if (!files.length) { if (!opts.dryRun) await recordEmpty(); res.processed++; continue; }

      // Only the symbols the PR actually CHANGED in a ticked file — not every symbol
      // the file happens to contain. A tick on a 30-symbol file where the PR touched
      // one method must not record exposure to the other 29: GitHub never rendered
      // them, and those marks would then satisfy `pr-push`'s reviewed-only gate.
      // The single-PR path maps ticks onto the worklist for exactly this reason.
      const { ids, hashes } = await changedSymbolsIn(
        readBlobs(root, headRefOid, files), readBlobs(root, mb, files), indexBlob);
      if (!ids.length) { if (!opts.dryRun) await recordEmpty(); res.processed++; continue; }

      // Everything above is read-only (gh, blob reads, parsing) and deliberately
      // outside the lock: a back-catalogue run takes minutes, and holding one lock
      // across it would block the user's own server for the whole import. What has
      // to be atomic is this tail — the "is it already signed?" read has to see the
      // same store its write lands in, and reviews and the import record are
      // whole-blob rewrites, so an interleaved writer loses UNRELATED marks.
      const apply = async () => {
        // A sign-off already outranks a tick; never overwrite one with weaker evidence.
        const st = await reviewStatesFor(root, ids.map((id) => ({ kind: "anchor" as const, id })));
        const fresh = ids.filter((id) => st.get(`anchor:${id}`)?.code.state !== "reviewed");
        res.leftSigned += ids.length - fresh.length;
        if (opts.dryRun) return { marked: fresh.length };
        // `ref` is the PR's head, and it is the acceptance's provenance. Without it the
        // commit falls back to whatever the working tree is on, so every acceptance
        // across a year of PRs records the same commit — which makes the ancestry test
        // in `resolveAcceptance` meaningless and reads most of them back as reverts.
        const r = await markReviewedBatch(root, fresh, { level: "code", actor: "human", attestation: "viewed", reviewer: "github-import", ref: headRefOid, hashes });
        await writeViewedImport(root, String(p.number), r.marked);
        return r;
      };
      const m = opts.dryRun ? await apply() : await withLock(root, apply);
      res.marked += m.marked;
      res.processed++;
      log(`#${p.number} (${p.author?.login ?? "?"}, ${p.createdAt.slice(0, 10)}) → ${m.marked} symbol(s)`);
    } catch (e) {
      res.errors.push({ pr: p.number, why: String(e).slice(0, 160) });
    }
  }
  return res;
}
