/** A hand-built standard for the projection's golden test. Tests only. */
import type { Requirement } from "./schema.js";
import type { ProjectedRule } from "./rules-projection.js";

const base = { provenance: "owner, 2026-09-30", status: "ratified" as const, author: { principal: "o" }, createdAt: "2026-10-07T00:00:00.000Z", introducedBy: "sp_1" };
const rule = (id: string, over: Partial<Requirement>): Requirement => ({ id, title: id, section: "System-wide", statement: "s", ...base, ...over });

export const GOLDEN_RULES: ProjectedRule[] = [
  { rule: rule("r_title", { title: "Acme never holds title to the goods", statement: "\"Acme should never hold title.\" (owner's wording)\nBuilt on it: the card account.", level: 4, interim: true, authority: "the CEO, via the Business", lapsesWhen: "The business is declared MoR." }), appliesAt: [] },
  { rule: rule("r_json", { title: "Money values are strings in JSON", statement: "All money values are strings.", level: 3, authority: "IETF RFC 8259 §6", lapsesWhen: "Acme drops JSON.", provenance: "https://www.rfc-editor.org/rfc/rfc8259.txt" }), appliesAt: ["src/money.ts DecimalConverter", "acme/react: anchor a_1"], acceptedDeviations: ["the legacy converter still reads JSON numbers (revalidate by 2027-01-01)"] },
  { rule: rule("r_old", { title: "An unleveled rule", statement: "Predates the ladder." }), appliesAt: [] },
  { rule: rule("r_gal", { title: "US customary units are fixed definitions", section: "Quantities and units", statement: "4 quarts = 1 gallon.", level: 2, authority: "NIST Handbook 44", lapsesWhen: "the system stops using US customary units." }), appliesAt: ["src/units.ts Gallon"], restsOn: ['"A rule in a sub-section" (ratified)'] },
  { rule: rule("r_sub", { title: "A rule in a sub-section", section: "Quantities and units/Density", statement: "V = m / ρ.", level: 1, authority: "arithmetic", lapsesWhen: "no mass-to-volume conversion." }), appliesAt: [], restedOnBy: ['"US customary units are fixed definitions" (ratified)'] },
];
