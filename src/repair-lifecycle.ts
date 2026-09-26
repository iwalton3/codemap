import { spawnSync } from "node:child_process";
import { gitBin, isAncestor, originSlug, revParse, trunkRef } from "./git.js";
import { landingOf, prIsMerged } from "./pr.js";
import { readCachedSnapshot } from "./store.js";
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

/** File movement is conservative: unrelated edits in a touched file also need attention. */
export async function repairCodeLifecycle(root: string, finding: SharedFinding, evidence: RepairEvidenceInput,
  outcome: "fixed" | "factually-refuted"): Promise<RepairCodeLifecycle> {
  const checkedCommit = outcome === "fixed" ? evidence.fixCommit : evidence.witnessCommit;
  const trunk = trunkRef(root);
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
  if (result.files.length) {
    const live = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet", checkedCommit, "--", ...result.files]);
    const untracked = git(root, ["ls-files", "--others", "-z", "--", ...result.files]);
    result.source = live.status === 1 || untracked.status === 0 && untracked.stdout.length > 0 ? "moved"
      : live.status === 0 && untracked.status === 0 ? "unchanged" : "unknown";
    if (result.source === "moved") result.reasons.push("verified source moved in a checked file since the exact checked commit; historical success remains");
  } else result.reasons.push("no comparable repair file boundary is available");
  if (!trunk) { result.reasons.push("default branch commit is unavailable"); return result; }
  const descended = lineage(root, checkedCommit, trunk.sha);
  // Comparing all touched files also detects cherry-picks and squash merges. An empty
  // diff has no body proof; it must use ancestry instead of vacuous equality.
  const same = result.files.length ? git(root, ["diff", "--no-ext-diff", "--no-textconv", "--quiet", checkedCommit, trunk.sha, "--", ...result.files]) : undefined;
  if (same?.status === 0) result.landing = "landed";
  else {
    const slug = finding.sourceRef === checkedCommit ? originSlug(root) : null;
    result.landing = landingOf(descended, finding.sourceRef === checkedCommit ? finding.pr : undefined,
      n => slug ? prIsMerged(`${slug.owner}/${slug.repo}`, n) : null);
  }
  if (result.landing === "landed") {
    result.defaultSource = same?.status === 0 ? "unchanged" : same?.status === 1 ? "moved" : "unknown";
    if (result.defaultSource === "moved") result.reasons.push("default branch source moved after the verified repair landed; historical landing remains");
  }
  return result;
}
