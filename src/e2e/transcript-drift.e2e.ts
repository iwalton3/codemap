/**
 * `readReader` against the newest real subagent transcript on this machine, so a harness that
 * changes its transcript shape fails here rather than as every verifier refused in production.
 * The fixtures are frozen measurements, so the unit suite stays green through exactly that
 * drift — a new entry type in the transcript refuses every reader, and only this notices.
 *
 * e2e, and skipping when there are no transcripts, for the same reason as the rest of this
 * directory: the transcripts are not this project's. `CODEMAP_TRANSCRIPT_ROOT` overrides the root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isUnverified, readReader } from "../transcript.js";

const ROOT = process.env.CODEMAP_TRANSCRIPT_ROOT ?? join(homedir(), ".claude", "projects");

const ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };

/** The newest top-level, non-fork subagent that made a tool call: the case `readReader` must pass. */
function newestReader(): { dir: string; agentId: string; callId: string; file: string } | undefined {
  const all: { dir: string; agentId: string; file: string; at: number }[] = [];
  for (const project of ls(ROOT)) for (const session of ls(join(ROOT, project))) {
    const sub = join(ROOT, project, session, "subagents");
    for (const name of ls(sub)) {
      const agentId = /^agent-(a[A-Za-z0-9]{6,63})\.jsonl$/.exec(name)?.[1];
      if (agentId) all.push({ dir: join(ROOT, project), agentId, file: join(sub, name), at: statSync(join(sub, name)).mtimeMs });
    }
  }
  for (const c of all.sort((a, b) => b.at - a.at)) {
    let meta: any;
    try { meta = JSON.parse(readFileSync(c.file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { continue; }
    // A fork refuses by design; a nested agent's launch is in its parent agent's file, not the session's.
    if (meta?.isFork === true || meta?.agentType === "fork" || (meta?.spawnDepth ?? 1) !== 1) continue;
    for (const line of readFileSync(c.file, "utf8").split("\n")) {
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      const use = e?.type === "assistant" && Array.isArray(e.message?.content) ? e.message.content.find((x: any) => x?.type === "tool_use") : undefined;
      if (use?.id) return { dir: c.dir, agentId: c.agentId, callId: use.id, file: c.file };
    }
  }
  return undefined;
}

test("readReader verifies the newest real subagent transcript (harness drift)", (t) => {
  const r = newestReader();
  if (!r) { t.skip(`no subagent transcripts under ${ROOT}`); return; }
  const got = readReader(r.agentId, r.callId, r.dir);
  // A message sent into it is a refusal the harness did not cause; anything else is drift.
  if (isUnverified(got) && /was sent a message/.test(got.unverified)) { t.skip(`${r.file}: ${got.unverified}`); return; }
  assert.ok(!isUnverified(got), `${r.file}: ${JSON.stringify(got)}`);
});
