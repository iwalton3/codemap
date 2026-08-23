/**
 * Two people setting the same scalar without having seen each other.
 *
 * Everything else in the shared design is append-only or a latch, and cannot
 * conflict. A revision is the exception: it rewrites a value, so two concurrent
 * ones genuinely disagree and the fold must not silently pick.
 *
 * "Concurrent" means the later writer's causal history does not include the
 * earlier write — NOT that the timestamps are close. Two people editing the same
 * thing an hour apart, where the second pulled first, is ordinary collaboration
 * and is flagged by no wall-clock rule that would also catch the real case.
 * Getting this wrong in the eager direction is the failure that trains people to
 * clear the state without reading it, so the test is deliberately narrow: same
 * field, different value, neither saw the other, different WRITERS — one person's
 * two machines included, because those are two sequential writers and the fold has
 * no more right to pick between them than between two people.
 *
 * Lives here rather than in `shared-findings.ts` because notes need the same rule
 * and a second copy is how two copies drift. The entity only has to have an `id`
 * and somewhere to put the residue.
 */

import type { Actor } from "./schema.js";
import { isAgentActor } from "./identity.js";
import type { Causality, LogEvent } from "./eventlog.js";

export interface Contested {
  field: string;
  held: ContestSide;
  incoming: ContestSide;
}

export interface ContestSide {
  value: unknown;
  /** The PERSON. Attribution and independence want the human, and always did. */
  by: string;
  at: string;
  /**
   * The CLONE. Present so a reader can tell the two sides apart when `by` cannot:
   * one person's laptop and desktop genuinely disagreeing shows the same name
   * twice, and a disagreement whose sides look identical is one nobody acts on.
   */
  writer?: string;
}

/** Anything that can carry the residue. */
export interface Contestable {
  id: string;
  contested?: Contested[];
}

/** Who currently holds a scalar, and which two writes each open contest is between. */
export interface ContestState {
  owned: Map<string, { value: unknown; by: Actor; at: string; id: string; writer?: string }>;
  raisedAt: Map<string, { held: string; incoming: string }>;
}

export const newContestState = (): ContestState => ({ owned: new Map(), raisedAt: new Map() });

/**
 * Whether these two writes came from one sequential writer.
 *
 * The principal is the FALLBACK, not the rule: events written before writer ids
 * existed carry none, and comparing an absent writer to a present one would call
 * an old event of yours somebody else's — turning every pre-upgrade revision into
 * a contest with its own author on the first read after upgrading.
 */
const sameWriter = (held: { by: Actor; writer?: string }, e: LogEvent): boolean =>
  held.writer !== undefined && e.writer !== undefined
    ? held.writer === e.writer
    : held.by.principal === e.actor.principal;

/**
 * Apply one revision to the contest state, raising or clearing as it goes.
 *
 * `fields` is the entity's contestable scalars — the ones a single person owns.
 * Grow-only sets and latches are not passed here, because they cannot conflict.
 */
export function applyRevision(
  entity: Contestable, e: LogEvent, now: Record<string, unknown>,
  fields: readonly string[], st: ContestState, causal: Causality,
): void {
  const saw = (target: string) => causal.saw(e.id, target);
  for (const k of fields) {
    const incoming = now[k];
    if (incoming === undefined) continue;
    const key = `${entity.id}\0${k}`;
    const held = st.owned.get(key);
    st.owned.set(key, { value: incoming, by: e.actor, at: e.at, id: e.id, writer: e.writer });

    // Settling is decided BEFORE the tests below, because every one of them asks
    // whether this write STARTS a conflict and none of them bear on ending one.
    // While they gated it, the only settlement that cleared anything was one
    // naming a value neither participant had written, by somebody who was not the
    // last writer — and the browser offers exactly the two values the participants
    // wrote, so no button in the UI could settle anything.
    //
    // BOTH writes, not the moment the fold happened to notice them: a contest is
    // between two people, and somebody who saw only one of them has not been shown
    // the choice they would be deciding.
    const raised = st.raisedAt.get(key);
    if (raised && saw(raised.held) && saw(raised.incoming)) {
      // Restating any value for a field you have seen contested settles it — the
      // fold replays history on every read, so without this the disagreement is
      // re-detected forever and nobody can ever clear it. An agent may not settle
      // one (a disagreement between two people is the thing it must leave alone),
      // but writing with the full picture does not raise a new one either.
      if (!isAgentActor(e.actor)) {
        entity.contested = entity.contested?.filter((c) => c.field !== k);
        if (!entity.contested?.length) entity.contested = undefined;
        st.raisedAt.delete(key);
      }
      continue;
    }

    if (!held) continue;
    if (held.value === incoming) continue;                          // agreeing is not conflict
    // Revising your OWN write is not conflict — but "your own" is the CLONE's, not
    // the person's. One person on two machines produces two genuinely concurrent
    // writes, and the principal test suppressed the disagreement between them: the
    // fold picked last-writer-wins and the person was never told a value had been
    // dropped. That is the residue this module exists to make loud.
    //
    // For a single clone the test is subsumed by `saw` below — a writer's own
    // history is always in its own causal vector — so this line's only live effect
    // was ever the two-machine case. See PROPOSAL-provenance.md §4.
    if (sameWriter(held, e)) continue;
    if (saw(held.id)) continue;                                     // written with the full picture
    (entity.contested ??= []).push({
      field: k,
      held: { value: held.value, by: held.by.principal, at: held.at, ...(held.writer ? { writer: held.writer } : {}) },
      incoming: { value: incoming, by: e.actor.principal, at: e.at, ...(e.writer ? { writer: e.writer } : {}) },
    });
    st.raisedAt.set(key, { held: held.id, incoming: e.id });
  }
}
