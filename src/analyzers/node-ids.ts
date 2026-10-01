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
 * Is this id in an analyzer's namespace? A person's node can still land here with an explicit
 * id; `document` no longer mints one (`personNodeId`).
 */
export const isAnalyzerNodeId = (id: string): boolean => PREFIXES.some((p) => id.startsWith(p));

/** A slug codemap mints for a PERSON's node, kept out of the analyzer namespace (owner, O27). */
export const personNodeId = (slugged: string): string => isAnalyzerNodeId(slugged) ? `doc-${slugged}` : slugged;
