import { test } from "node:test";
import assert from "node:assert/strict";
import { readScope } from "./eventlog.js";
import { MATERIALIZER_SCOPE } from "./materializer-log.js";
import { MATERIALIZER_VERSION } from "./materializer-version.js";
import { readManifests, sync } from "./sidecar.js";
import { scenario, who } from "./scenario.js";

test("the first sync on a materializer version logs it once, for the whole team", async () => {
  const s = await scenario(["ana@x.com", "ben@x.com"]);
  try {
    for (const p of s.all) await sync(p.sidecar, p.actor);
    const ana = who(s, "ana@x.com"), ben = who(s, "ben@x.com");
    for (const p of [ana, ben]) {
      const logged = await readScope(p.sidecar, MATERIALIZER_SCOPE);
      assert.equal(logged.length, 1, "one event, though both clones synced on this version");
      assert.equal((logged[0]!.data as { version: number }).version, MATERIALIZER_VERSION);
      assert.equal(logged[0]!.actor.principal, "ana@x.com", "an act: the first to sync carries it");
    }
    assert.ok((await readManifests(ben.sidecar)).every((m) => m.materializerVersion === MATERIALIZER_VERSION));
  } finally { s.dispose(); }
});
