import { spawnSync } from "node:child_process";
import { gitBin, isAncestor, originSlug, revParse, trunkRef } from "./git.js";
import { prsLinkedTo, readCachedSnapshot } from "./store.js";
import type { SharedFinding } from "./shared-findings.js";
import type { RepairEvidenceInput } from "./repair-records.js";

export interface RepairCodeLifecycle {
  checkedCommit: string;
  defaultCommit?: string;
  landing: "landed" | "open" | "unknown";
  source: "unchanged" | "moved" | "unknown";
  defaultSource?: "unchanged" | "moved" | "unknown";
  files: string[];
  reasons: string[];
}
const ancestry = new Map<string, boolean>();
function lineage(root: string, commit: string, trunk: string): boolean | null {
  if (revParse(root, commit) !== commit) return null;
  const key = `${root}\0${commit}\0${trunk}`;
  const cached = ancestry.get(key);
  if (cached !== undefined) return cached;
  const yes = isAncestor(root, commit, trunk);
  const shallow = spawnSync(gitBin(), ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8" });
  if (!yes && (shallow.status !== 0 || shallow.stdout.trim() !== "false")) return null;
  ancestry.set(key, yes);
  return yes;
}
function git(root: string, args: string[]) {
  return spawnSync(gitBin(), ["--literal-pathspecs", ...args], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
const prLanding = new Map<string, { at: number; landed: boolean }>();
function linkedRepairLanded(root: string, finding: SharedFinding, checked: string, trunk: string, files: string[]): boolean {
  const slug = originSlug(root);
  if (!slug || !files.length) return false;
  const candidates = finding.pr?.startsWith("branch:")
    ? prsLinkedTo(root, finding.pr.slice("branch:".length)) : finding.pr ? [finding.pr] : [];
  for (const pr of candidates) {
    if (!/^[1-9]\d*$/.test(pr)) continue;
    const key = `${root}\0${slug.owner}/${slug.repo}\0${pr}\0${checked}\0${trunk}\0${JSON.stringify(files)}`;
    const cached = prLanding.get(key);
    if (cached && Date.now() - cached.at < 60_000) { if (cached.landed) return true; continue; }
    const reply = spawnSync("gh", ["pr", "view", pr, "--repo", `${slug.owner}/${slug.repo}`, "--json", "state,headRefOid,mergeCommit"],
      { encoding: "utf8", timeout: 8_000, maxBuffer: 1024 * 1024 });
    let landed = false;
    try {
      const meta = reply.status === 0 ? JSON.parse(reply.stdout) : null;
      // A branch link is only a candidate. Its PR must contain this exact repair,
      // and its merge must reach the resolved default, including stacked PRs.
      if (meta?.state === "MERGED" && typeof meta.headRefOid === "string" && typeof meta.mergeCommit?.oid === "string"
        && lineage(root, checked, meta.headRefOid) === true && lineage(root, meta.mergeCommit.oid, trunk) === true) {
        landed = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet", checked, meta.headRefOid, "--", ...files]).status === 0;
      }
    } catch { /* An unavailable PR record cannot establish landing. */ }
    prLanding.set(key, { at: Date.now(), landed });
    if (landed) return true;
  }
  return false;
}

/** Finished lifecycles, keyed on every SHA they read (F26): this runs on every findings read. */
const lifecycles = new Map<string, RepairCodeLifecycle>();

/** File movement is conservative: unrelated edits in a touched file also need attention. */
export async function repairCodeLifecycle(root: string, finding: SharedFinding, evidence: RepairEvidenceInput,
  outcome: "fixed" | "factually-refuted" | "invalid"): Promise<RepairCodeLifecycle> {
  const checkedCommit = outcome === "fixed" ? evidence.fixCommit : evidence.witnessCommit;
  const trunk = trunkRef(root);
  // What the repair is compared against: the finding's own branch while it has one, else the
  // default branch — a COMMIT either way, never the working tree (F29), so the answer does not
  // depend on what happens to be checked out.
  const branchSha = finding.branch ? revParse(root, `origin/${finding.branch}`) ?? revParse(root, finding.branch) : null;
  const key = JSON.stringify([root, finding.id, finding.target, checkedCommit, evidence.baseCommit, trunk?.sha ?? null, branchSha,
    evidence.attribution.map((a) => a.file), evidence.inspected.map((i) => i.source)]);
  const memo = lifecycles.get(key);
  if (memo) return structuredClone(memo);
  const done = await computeLifecycle(root, finding, evidence, checkedCommit, trunk, branchSha);
  // Only a LANDED answer is final for these SHAs: an open repair can still land through a merged
  // pull request, which only GitHub can say, and an unknown one can be proven by deepening history.
  if (done.landing === "landed") lifecycles.set(key, structuredClone(done));
  return done;
}

async function computeLifecycle(root: string, finding: SharedFinding, evidence: RepairEvidenceInput, checkedCommit: string,
  trunk: { name: string; sha: string } | null, branchSha: string | null): Promise<RepairCodeLifecycle> {
  const result: RepairCodeLifecycle = { checkedCommit, defaultCommit: trunk?.sha, landing: "unknown", source: "unknown", files: [], reasons: [] };
  if (revParse(root, checkedCommit) !== checkedCommit || revParse(root, evidence.baseCommit) !== evidence.baseCommit) {
    result.reasons.push("exact checked or base commit is unavailable");
    return result;
  }
  const changed = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", evidence.baseCommit, checkedCommit, "--"]);
  if (changed.status !== 0) { result.reasons.push("repair files cannot be compared"); return result; }
  result.files = [...new Set(changed.stdout.split("\0").filter(Boolean))];
  // Refutation may change no code. Its target still supplies the relevant source boundary.
  if (!result.files.length && finding.target.kind === "anchor") {
    const snapshot = await readCachedSnapshot(root, checkedCommit).catch(() => null);
    const target = snapshot?.find(a => a.id === finding.target.id);
    if (target) result.files = [target.file];
  }
  const declared = [...evidence.attribution.map(a => a.file), ...evidence.inspected.map(i => i.source)];
  for (const file of declared) {
    if (!file || file.includes("\0")) continue;
    const exists = git(root, ["ls-tree", "--name-only", "-z", checkedCommit, "--", file]);
    if (exists.status === 0 && exists.stdout.split("\0").includes(file)) result.files.push(file);
  }
  result.files = [...new Set(result.files)];
  if (!result.files.length) result.reasons.push("no comparable repair file boundary is available");
  // Source is judged where the repair LIVES, as a commit (F29): the finding's branch when it
  // names one, the default branch once the repair has landed, and otherwise nothing to judge.
  const judgeSource = () => {
    const against = branchSha ?? (result.landing === "landed" ? trunk?.sha : undefined);
    if (!result.files.length) return;
    if (!against) { result.reasons.push("the repair has not landed and names no branch to compare it against"); return; }
    const moved = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet", checkedCommit, against, "--", ...result.files]);
    result.source = moved.status === 1 ? "moved" : moved.status === 0 ? "unchanged" : "unknown";
    if (result.source === "moved") result.reasons.push("verified source moved in a checked file since the exact checked commit; historical success remains");
  };
  if (!trunk) { judgeSource(); result.reasons.push("default branch commit is unavailable"); return result; }
  const descended = lineage(root, checkedCommit, trunk.sha);
  // Comparing all touched files also detects cherry-picks and squash merges. An empty
  // diff has no body proof; it must use ancestry instead of vacuous equality.
  const same = result.files.length ? git(root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet", checkedCommit, trunk.sha, "--", ...result.files]) : undefined;
  if (same?.status === 0) result.landing = "landed";
  else {
    result.landing = descended === null ? "unknown" : descended || linkedRepairLanded(root, finding, checkedCommit, trunk.sha, result.files) ? "landed" : "open";
  }
  if (result.landing === "landed") {
    result.defaultSource = same?.status === 0 ? "unchanged" : same?.status === 1 ? "moved" : "unknown";
    if (result.defaultSource === "moved") result.reasons.push("default branch source moved after the verified repair landed; historical landing remains");
  }
  judgeSource();
  return result;
}
