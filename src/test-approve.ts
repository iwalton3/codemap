/**
 * Sign off a proposal, then adopt it — the review loop, for fixtures that only need the
 * standard to have moved.
 *
 * **For tests. There is no production caller**, the same shape `clearAgentSession` has and
 * for a related reason: the loop this collapses is four deliberate acts on the real
 * surface (pull, read the diff, sign off, ratify) and collapsing them is exactly what a
 * person must not do. A fixture is the one caller for which the intermediate steps carry
 * no information — it wrote the text three lines ago.
 *
 * It exists because `ratifySpec` now refuses an unwitnessed adoption, which is the point,
 * and because the alternative was an exemption in the guard for specs whose author is the
 * ratifier. That exemption would have been sized to fit the test suite rather than to fit
 * the hazard, and the hazard is precisely that most specs are authored by an agent.
 *
 * Tests about the GATE itself do not use this — they call `signOff*` and `ratifySpec`
 * directly, because what they are asserting is which of those refuses and why.
 */
import { ratifySpec, signOffFraming, signOffOperation } from "./requirements.js";
import { readOperations } from "./store.js";
import type { ActorInput } from "./identity.js";

const isErr = (x: unknown): x is { error: string } =>
  !!x && typeof x === "object" && "error" in (x as object);

/** Sign off the framing and every live operation, as the acting principal. */
export async function signOffEverything(
  root: string, specId: string, input: ActorInput = {},
): Promise<{ ok: true } | { error: string }> {
  const framing = await signOffFraming(root, { specId, ...input });
  if (isErr(framing)) return framing;
  for (const op of await readOperations(root, { specId })) {
    const r = await signOffOperation(root, { operationId: op.id, ...input });
    if (isErr(r)) return r;
  }
  return { ok: true };
}

/**
 * The whole loop. Returns whatever `ratifySpec` returns, so a caller asserting on a
 * ratification refusal still sees that refusal rather than a sign-off's.
 */
export async function ratifyReviewed(root: string, specId: string, input: ActorInput = {}) {
  const signed = await signOffEverything(root, specId, input);
  if (isErr(signed)) return signed;
  return ratifySpec(root, specId, input);
}

/**
 * The same sign-offs, straight into a LOG — for fold tests that publish raw events rather
 * than driving the ops.
 *
 * `foldStandard` refuses a ratification its ratifier had not signed, so a fixture that
 * publishes `spec.ratified` by hand has to publish the readings that preceded it. That is
 * the rule being tested working, not a workaround for it: no clone applies an unwitnessed
 * adoption, including one assembled by a test.
 *
 * `reviewer` defaults to the ratifier and is separable on purpose. A test whose subject is
 * the AGENT gate publishes the reviews as the person and the ratification as the agent, so
 * the only thing left to refuse it is the gate under test — otherwise that test would pass
 * for two reasons and stop pinning either.
 */
export async function ratifyWithReview(
  logRoot: string, scope: string, actor: import("./schema.js").Actor, specId: string, at: string,
  witnesses: Record<string, import("./schema.js").BugWitness[]>, opIds: string[],
  reviewer?: import("./schema.js").Actor,
): Promise<void> {
  const { foldStandard, publishSpecRatified, publishSpecReviewed } = await import("./shared-standard.js");
  const { framingContent, operationContent } = await import("./schema.js");
  const { readScope } = await import("./eventlog.js");
  const who = reviewer ?? actor;
  const folded = foldStandard(await readScope(logRoot, scope));
  const spec = folded.specs.find((s) => s.id === specId);
  if (spec) {
    await publishSpecReviewed(logRoot, scope, who, {
      id: `rw_frame_${specId}_${who.principal}`, specId, reviewer: who,
      at, content: framingContent(spec),
    });
    for (const id of opIds) {
      const op = folded.operations.find((o) => o.id === id);
      if (!op) continue;
      await publishSpecReviewed(logRoot, scope, who, {
        id: `rw_${id}_${who.principal}`, specId, operationId: id, reviewer: who,
        at, content: operationContent(op),
      });
    }
  }
  await publishSpecRatified(logRoot, scope, actor, specId, at, witnesses, opIds);
}
