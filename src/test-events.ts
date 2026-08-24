/**
 * A well-formed protocol-1 envelope, for tests.
 *
 * Lives here rather than being repeated in each test file because the envelope is
 * now mandatory in full — `writer`, `writerPrev`, `after`, and both version numbers —
 * and eight test files had grown their own `ev` builder. One place to change when the
 * protocol moves, and `wellFormed` rejects anything these forget.
 *
 * Test-only, like `scenario.ts`. Nothing in production imports it.
 *
 * The defaults are deliberately BORING: a single writer whose chain is `GENESIS` and
 * nothing seen. A test that cares about causality or forks states the interesting
 * part and inherits the rest — and one that means to build a malformed event should
 * spell that out rather than getting it by omission.
 */

import { GENESIS, SIDECAR_PROTOCOL, EVENT_SCHEMA, type LogEvent } from "./eventlog.js";
import type { Actor } from "./schema.js";
import type { SharedBug } from "./shared-bugs.js";

const ANYONE: Actor = { principal: "someone@x.com" };

export function testEvent(over: Partial<LogEvent> & Pick<LogEvent, "id">): LogEvent {
  return {
    kind: "noted",
    subject: "s_1",
    actor: ANYONE,
    at: "2026-08-21T00:00:00Z",
    writer: "w_test",
    writerPrev: GENESIS,
    after: [],
    sidecarProtocol: SIDECAR_PROTOCOL,
    eventSchema: EVENT_SCHEMA,
    ...over,
  };
}

/**
 * A linear chain by one writer, each event naming the previous.
 *
 * The common shape, and the one easiest to get wrong by hand: an honest writer's
 * events form a chain, and a test that leaves every `writerPrev` at `GENESIS` is
 * describing a fork whether it meant to or not.
 */
export function testChain(writer: string, events: (Partial<LogEvent> & Pick<LogEvent, "id">)[]): LogEvent[] {
  let prev = GENESIS;
  return events.map((e) => {
    const built = testEvent({ writer, writerPrev: prev, ...e });
    prev = built.id;
    return built;
  });
}

/**
 * A local `SharedBug`, for tests that need a bug in the store without a sidecar.
 *
 * The same reason `testEvent` exists: the entity grew fields that every fixture has to
 * get right (`tracking` is read unguarded, an anchor carries its own witness), and six
 * test files were each half-building one with `as never`.
 */
export function testBug(
  over: Partial<SharedBug> & Pick<SharedBug, "id" | "title">
    & { cites?: { anchorId: string; bodyHash: string }[] },
): SharedBug {
  const at = over.createdAt ?? "2026-08-21T00:00:00Z";
  const author = over.author ?? ANYONE;
  const { cites, ...rest } = over;
  return {
    text: "",
    severity: "medium",
    anchors: (cites ?? []).map((c) => ({ ...c, by: author, at })),
    author,
    createdAt: at,
    state: "created",
    corroboration: [],
    thread: [],
    tracking: [],
    revisions: [],
    ...rest,
  };
}
