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
 * a question that only needs the changed files' bodies at head. `viewedTargetsFor`
 * reads exactly those.
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

function gh(args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 28, timeout: 120_000 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

export interface PrViewedSurvey { number: number; state: string; author: string; createdAt: string; viewed: number; dismissed: number; unviewed: number }

/**
 * Per-file viewed state for a page of PRs in one query, via GraphQL aliases.
 * One request per 20 PRs rather than per PR — the difference between a survey
 * that costs 30 requests and one that costs 600.
 */
export function surveyViewed(slug: string, numbers: number[]): Map<number, { viewed: number; dismissed: number; unviewed: number }> {
  const [owner, repo] = slug.split("/");
  const out = new Map<number, { viewed: number; dismissed: number; unviewed: number }>();
  for (let i = 0; i < numbers.length; i += 20) {
    const batch = numbers.slice(i, i + 20);
    const q = `query{repository(owner:"${owner}",name:"${repo}"){`
      + batch.map((n) => `p${n}: pullRequest(number:${n}){files(first:100){nodes{viewerViewedState}}}`).join(" ") + `}}`;
    const r = gh(["api", "graphql", "-f", `query=${q}`]);
    if (!r.ok) continue;
    try {
      const data = JSON.parse(r.out).data.repository;
      for (const n of batch) {
        const nodes = data[`p${n}`]?.files?.nodes ?? [];
        const c = { viewed: 0, dismissed: 0, unviewed: 0 };
        for (const x of nodes) {
          if (x.viewerViewedState === "VIEWED") c.viewed++;
          else if (x.viewerViewedState === "DISMISSED") c.dismissed++;
          else c.unviewed++;
        }
        out.set(n, c);
      }
    } catch { /* skip an unparseable batch rather than abort the survey */ }
  }
  return out;
}

/** Every VIEWED path for one PR, paginated. */
function viewedPaths(slug: string, number: number): Set<string> | { error: string } {
  const [owner, repo] = slug.split("/");
  const out = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const q = `query($after:String){repository(owner:"${owner}",name:"${repo}"){pullRequest(number:${number}){files(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}`;
    const args = ["api", "graphql", "-f", `query=${q}`];
    if (after) args.push("-f", `after=${after}`);
    const r = gh(args);
    if (!r.ok) return { error: r.err.slice(0, 200) };
    try {
      const f = JSON.parse(r.out).data.repository.pullRequest.files;
      for (const n of f.nodes) if (n.viewerViewedState === "VIEWED") out.add(n.path);
      if (!f.pageInfo.hasNextPage) break;
      after = f.pageInfo.endCursor;
    } catch (e) { return { error: (e as Error).message }; }
  }
  return out;
}

export interface BulkViewedResult {
  surveyed: number;
  withTicks: number;
  processed: number;
  skippedAlreadyImported: number;
  marked: number;
  leftSigned: number;
  errors: { pr: number; why: string }[];
}

export async function bulkPullViewed(
  root: string,
  slug: string,
  opts: { force?: boolean; limit?: number; onProgress?: (msg: string) => void } = {},
): Promise<BulkViewedResult | { error: string }> {
  const log = opts.onProgress ?? (() => {});
  const listed = gh(["pr", "list", "--repo", slug, "--state", "all", "--limit", "400", "--json", "number,state,author,createdAt"]);
  if (!listed.ok) return { error: `gh pr list failed: ${listed.err.slice(0, 200)}` };
  const prs: { number: number; state: string; author: { login: string } | null; createdAt: string }[] = JSON.parse(listed.out);
  // OLDEST first. An accepted set is documented "oldest first" and `resolveAcceptance`
  // treats the last entry on the ancestry as the current one; importing newest-first
  // appends them backwards, so every earlier body reads as something the code was
  // reverted to.
  prs.sort((a, b) => a.number - b.number);

  log(`surveying ${prs.length} pull requests…`);
  const survey = surveyViewed(slug, prs.map((p) => p.number));
  const withTicks = prs.filter((p) => (survey.get(p.number)?.viewed ?? 0) > 0);
  log(`${withTicks.length} carry viewed ticks`);

  const already = (await readViewedImports(root)).imported;
  const lanes = await loadLanes(root);
  const res: BulkViewedResult = { surveyed: prs.length, withTicks: withTicks.length, processed: 0, skippedAlreadyImported: 0, marked: 0, leftSigned: 0, errors: [] };

  const targets = opts.limit ? withTicks.slice(0, opts.limit) : withTicks;
  for (const p of targets) {
    if (!opts.force && already[String(p.number)]) { res.skippedAlreadyImported++; continue; }
    try {
      const meta = gh(["pr", "view", String(p.number), "--repo", slug, "--json", "baseRefName,headRefOid,baseRefOid"]);
      if (!meta.ok) { res.errors.push({ pr: p.number, why: "gh pr view failed" }); continue; }
      const { baseRefName, headRefOid, baseRefOid } = JSON.parse(meta.out);
      // The head must already be local — a bulk run fetches every PR head once up
      // front rather than paying a round trip per PR.
      if (!hasObject(root, headRefOid)) { res.errors.push({ pr: p.number, why: "head object not fetched" }); continue; }

      const paths = viewedPaths(slug, p.number);
      if ("error" in paths) { res.errors.push({ pr: p.number, why: paths.error }); continue; }
      if (!paths.size) { await writeViewedImport(root, String(p.number), 0); res.processed++; continue; }

      // GitHub's recorded base sha, not the branch tip: a merged PR's head is an
      // ancestor of the tip, so that merge-base is the head and the diff is empty.
      // This is a back catalogue — most of it is merged.
      const mb = prBaseCommit(root, { recordedBase: baseRefOid, baseRef: baseRefName, headSha: headRefOid });
      if (!mb || mb === headRefOid) { res.errors.push({ pr: p.number, why: `could not locate a base for ${baseRefName}` }); continue; }

      const files = changedFilesBetween(root, mb, headRefOid)
        .filter((f) => paths.has(f) && LANE_POLICY[lanes.classify(f)]?.review === "queue");
      if (!files.length) { await writeViewedImport(root, String(p.number), 0); res.processed++; continue; }

      const blobs = readBlobs(root, headRefOid, files);
      const ids: string[] = [];
      const hashes = new Map<string, string>();
      for (const [path, src] of blobs) {
        for (const a of await indexBlob(src, path)) { ids.push(a.id); hashes.set(a.id, a.bodyHash); }
      }
      if (!ids.length) { await writeViewedImport(root, String(p.number), 0); res.processed++; continue; }

      // A sign-off already outranks a tick; never overwrite one with weaker evidence.
      const st = await reviewStatesFor(root, ids.map((id) => ({ kind: "anchor" as const, id })));
      const fresh = ids.filter((id) => st.get(`anchor:${id}`)?.code.state !== "reviewed");
      res.leftSigned += ids.length - fresh.length;

      // `ref` is the PR's head, and it is the acceptance's provenance. Without it the
      // commit falls back to whatever the working tree is on, so every acceptance
      // across a year of PRs records the same commit — which makes the ancestry test
      // in `resolveAcceptance` meaningless and reads most of them back as reverts.
      const m = await markReviewedBatch(root, fresh, { level: "code", actor: "human", attestation: "viewed", reviewer: "github-import", ref: headRefOid, hashes });
      await writeViewedImport(root, String(p.number), m.marked);
      res.marked += m.marked;
      res.processed++;
      log(`#${p.number} (${p.author?.login ?? "?"}, ${p.createdAt.slice(0, 10)}) → ${m.marked} symbol(s)`);
    } catch (e) {
      res.errors.push({ pr: p.number, why: String(e).slice(0, 160) });
    }
  }
  return res;
}
