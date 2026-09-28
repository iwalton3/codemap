/** Imports nothing, so any module can use it without joining an import cycle. */

/**
 * A key-sorted serialisation, so equal values compare and hash equal whatever the key order —
 * the ONE canonical form: every cross-clone hash uses it (plan Phase 3.6).
 */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Order by UTF-16 code unit. For anything hashed or compared across clones: `localeCompare`
 *  depends on the machine's locale, so two clones could order the same ids differently. */
export const codeUnitOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
