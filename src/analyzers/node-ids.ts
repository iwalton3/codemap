/**
 * The id namespace analyzer nodes are minted in. A leaf, so the graph fold can recognise an
 * analyzer node from an event alone: an event carries only the id, and the node's
 * `generatedBy` lives in one machine's store. `marten-emit.ts` mints with these, so the
 * vocabulary cannot drift from the ids it describes.
 */
export const MARTEN_ID = {
  event: "mev-", aggregate: "magg-", projection: "mproj-", command: "mcmd-",
  handler: "mh-", state: "mst-", transition: "mtr-",
} as const;

const PREFIXES: readonly string[] = Object.values(MARTEN_ID);

/**
 * Is this id in an analyzer's namespace? A person's node CAN land here (`document` slugs a
 * title "MH …" to `mh-…`), and would then be refused publication like an analyzer node.
 */
export const isAnalyzerNodeId = (id: string): boolean => PREFIXES.some((p) => id.startsWith(p));
