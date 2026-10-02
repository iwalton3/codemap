/**
 * Every module that registers a family's vocabulary, door or fold, imported for that side effect.
 * Whatever classifies scopes without the ops layer above it — the damage scan, the migration —
 * imports this: a family missing from the registry classes its whole scope as newer, and that
 * blocks every push (round 3, I7). `families.test.ts` fails when a registering module is missing here.
 */
import "./materializer-log.js";
import "./shared-bugs.js";
import "./shared-decisions.js";
import "./shared-docs.js";
import "./shared-findings.js";
import "./shared-graph.js";
import "./shared-notes.js";
import "./shared-reviews.js";
import "./shared-standard.js";
import "./shared-topics.js";
import "./shared-triage.js";
import "./shared-walkthrough.js";
