import { test } from "node:test";
import assert from "node:assert/strict";
import { scanMarkdown, proseLines } from "./markdown.js";

const headings = (md: string) => scanMarkdown(md).filter((l) => l.kind === "heading").map((l) => `${l.level}:${(l as { text: string }).text}`);

test("a fence closes only on its own delimiter, at least as long", () => {
  // `~~~` was not a fence at all, so a `#` inside one became a heading; and an
  // inner ``` closed an outer ````, swallowing every heading after it.
  assert.deepEqual(headings("# Spec\n~~~csharp\n# not a heading\n~~~\n## Real\nbody"), ["1:Spec", "2:Real"]);
  assert.deepEqual(headings("# Spec\n````\n```\nexample\n````\n## After\nbody"), ["1:Spec", "2:After"]);
  assert.deepEqual(headings("# Spec\n```\n## inside\n```\n## After"), ["1:Spec", "2:After"]);
  // up to three leading spaces is still column zero in markdown
  assert.deepEqual(headings("# Spec\n   ```\n   ## inside\n   ```\n## After"), ["1:Spec", "2:After"]);
});

test("a heading inside an HTML comment is not a heading", () => {
  // A commented-out section became a chapter, and its identifiers were reported to
  // the human as spec shipped without code — a gap report about deleted text.
  const md = "# Spec\nintro\n<!--\n## Dropped: `LegacyRefund`\nthe old path\n-->\n## Refunds\nbody";
  assert.deepEqual(headings(md), ["1:Spec", "2:Refunds"]);
  assert.equal(proseLines(md).some((l) => l.includes("old path")), false, "its body is not prose either");

  // one that opens and closes on a single line hides nothing after it
  assert.deepEqual(headings("<!-- a note -->\n## Real"), ["2:Real"]);
});

test("setext headings are headings", () => {
  assert.deepEqual(headings("Domain model\n============\nprose\n\nRefunds\n-------\nmore"), ["1:Domain model", "2:Refunds"]);
  // a rule under nothing is a thematic break, and front matter is not a heading
  assert.deepEqual(headings("prose\n\n---\n\nmore prose"), []);
  assert.deepEqual(headings("---\ntitle: x\n---\n# Real"), ["1:Real"]);
});

test("prose excludes code, comments and headings — which is what a summary is drawn from", () => {
  // A fenced line of SQL could pass every summary check and be written into the map
  // as the node's description, reported as having come from the spec.
  const md = "## Ledger\nAdd the column:\n```sql\nSELECT * FROM orders WHERE settled = true\n```\nThe ledger is authoritative.";
  const prose = proseLines(md).join(" ");
  assert.equal(prose.includes("SELECT"), false, "fence CONTENTS are not prose");
  assert.equal(prose.includes("Ledger"), false, "nor is the heading");
  assert.ok(prose.includes("The ledger is authoritative."));
});

test("CRLF does not hide every heading in the file", () => {
  assert.deepEqual(headings("# Domain model\r\n## `RefundPolicy`\r\nThe policy.\r\n"), ["1:Domain model", "2:`RefundPolicy`"]);
});

test("a trailing-hash heading keeps its text, and deeper levels are still headings", () => {
  assert.deepEqual(headings("## Refunds ##\n#### detail"), ["2:Refunds", "4:detail"]);
});
