import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * An `<a>` that wraps block children must be given a block display.
 *
 * The one class of front-end defect neither check we have can see. `tsc -p web`
 * reads a template slot as opaque text, and the vdx template lint checks the
 * BINDINGS, not what the CSS then does with the element — so a card that renders
 * as a collapsed inline run is invisible to both and to the test suite.
 *
 * It has shipped once. `920ea8a` swept `<div on-click>` to `<a href>` across the
 * app, which is right — a link should be a link — but an `<a>` is `display: inline`
 * and a `<div>` is not, and `.flow-card` was styled as a block card with no
 * `display` of its own. The flows listing was broken from that commit until it was
 * noticed by eye, because nothing here could notice it.
 */

/** Every `<a class="…">` in the app, with what it wraps. */
function anchors(src: string): { classes: string[]; wrapsBlock: boolean; at: number }[] {
  const out: { classes: string[]; wrapsBlock: boolean; at: number }[] = [];
  const open = /<a[\s>]/g;
  for (let m = open.exec(src); m; m = open.exec(src)) {
    // Naive, and deliberately so: to the FIRST `</a>`. Anchors here never nest, and
    // stopping short can only under-report — it never invents a wrapped block.
    const end = src.indexOf("</a>", m.index);
    if (end === -1) continue;
    // Children begin at the first `<` after the tag name, so everything before it is
    // the opening tag. Reading `class` from the whole slice instead would pick up a
    // CHILD's class on an anchor that has none — and then report it as styled.
    const slice = src.slice(m.index + 2, end);
    const childAt = slice.indexOf("<");
    const openTag = childAt === -1 ? slice : slice.slice(0, childAt);
    const cls = /class="([^"]*)"/.exec(openTag);
    out.push({
      classes: (cls?.[1] ?? "").trim().split(/\s+/).filter(Boolean),
      wrapsBlock: /<(?:div|p|ul|ol|li|table|section|h[1-6])\b/.test(childAt === -1 ? "" : slice.slice(childAt)),
      at: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/**
 * Classes the stylesheet gives a block-ish display TO THEMSELVES.
 *
 * The subtlety that made the first version of this test useless: `.flow-card .ft
 * { display: flex }` mentions `.flow-card` and says nothing about it. So a
 * selector counts only when its LAST compound — the element actually selected —
 * carries the class.
 */
function blockClasses(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/display:\s*(?:block|flex|grid|inline-block|inline-flex)/.test(m[2]!)) continue;
    for (const sel of m[1]!.split(",")) {
      const last = sel.trim().split(/[\s>+~]+/).pop() ?? "";
      for (const c of last.matchAll(/\.([A-Za-z0-9_-]+)/g)) out.add(c[1]!);
    }
  }
  return out;
}

test("an <a> wrapping block content is styled as a block", () => {
  const app = readFileSync("web/app.js", "utf8");
  const block = blockClasses(readFileSync("web/index.html", "utf8"));

  const all = anchors(app);
  const wrapping = all.filter((a) => a.wrapsBlock);
  // Two separate ways this goes quietly green: the parse stops finding anchors at
  // all, or it finds them and none takes the shape being guarded. Only ONE anchor in
  // the app wraps block content today (the flow card) — so the population assertion
  // is deliberately `>= 1` and the parse is asserted apart from it, rather than
  // guessing a bigger number that would fail for a reason nobody wants reported.
  assert.ok(all.length > 20, `the anchor parse found only ${all.length} — it has stopped matching the templates`);
  assert.ok(wrapping.length >= 1, "no block-wrapping anchor found — the shape this guards has vanished, or the parse has");

  const bad = wrapping.filter((a) => !a.classes.some((c) => block.has(c)));
  assert.deepEqual(
    bad.map((a) => `web/app.js:${a.at} <a class="${a.classes.join(" ")}">`), [],
    "an inline <a> wrapping block children collapses the layout. Give the class "
    + "`display: block` in web/index.html — this is what broke the flows listing.",
  );
});

test("…and the check could have failed: .flow-card without its display is caught", () => {
  // Mutation, inline. Four of the oracle's six invariants were vacuous when
  // written, and a test whose subject is "nothing is wrong" is the shape that goes
  // quietly green when its matcher stops matching.
  const app = readFileSync("web/app.js", "utf8");
  const css = readFileSync("web/index.html", "utf8")
    .replace(".flow-card { display: block;", ".flow-card {");
  const block = blockClasses(css);
  const bad = anchors(app).filter((a) => a.wrapsBlock && !a.classes.some((c) => block.has(c)));
  assert.ok(bad.some((a) => a.classes.includes("flow-card")), "the guard no longer detects the defect it was written for");
});
