/**
 * DAMAGE in a folded log: an entry "from a bug or a broken build" (owner, 2026-09-28) halts,
 * names the entry, and waits for a person-approved repair (docs/log-repair.md). What counts as
 * damage is decided in one place for every scope family, `validation.ts judge`.
 */

export interface DamagedEntry {
  id: string;
  kind: string;
  why: string;
  /** Where it sits, once a reader that knows the scope has filled it in. */
  scope?: string;
  shard?: string;
  line?: number;
}

export class LogDamage extends Error {
  readonly entry: DamagedEntry;
  constructor(entry: DamagedEntry) {
    super(`damaged log entry ${entry.id} (${entry.kind}${entry.scope ? ` in ${entry.scope}` : ""}): ${entry.why}`);
    this.name = "LogDamage";
    this.entry = entry;
  }
}

export const isLogDamage = (e: unknown): e is LogDamage => e instanceof LogDamage;
