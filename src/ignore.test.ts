import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIgnore } from "./ignore.js";

test("bare basename matches a file at any depth, exact", () => {
  const ig = compileIgnore("framework.js");
  assert.equal(ig.ignores("static/lib/framework.js", false), true);
  assert.equal(ig.ignores("framework.js", false), true);
  assert.equal(ig.ignores("framework.jsx", false), false);
  assert.equal(ig.ignores("lib/framework.ts", false), false);
});

test("dir pattern excludes the dir and everything under it, anywhere", () => {
  const ig = compileIgnore("vdx/");
  assert.equal(ig.ignores("wwwroot/console/vdx", true), true);
  assert.equal(ig.ignores("wwwroot/console/vdx/lib/framework.js", false), true);
  assert.equal(ig.ignores("wwwroot/console/vdxx", true), false); // not a segment match
  assert.equal(ig.ignores("src/vdx-utils.js", false), false);
});

test("anchored path only matches from the repo root", () => {
  const ig = compileIgnore("wwwroot/console/vdx/");
  assert.equal(ig.ignores("wwwroot/console/vdx/lib/a.js", false), true);
  assert.equal(ig.ignores("app/wwwroot/console/vdx/lib/a.js", false), false);
});

test("globstar spans segments", () => {
  const ig = compileIgnore("**/generated/**");
  assert.equal(ig.ignores("a/b/generated/c/d.cs", false), true);
  assert.equal(ig.ignores("generated/x.cs", false), true);
  assert.equal(ig.ignores("a/regenerated/x.cs", false), false);
});

test("single star stays within a segment", () => {
  const ig = compileIgnore("*.min.js");
  assert.equal(ig.ignores("static/vendor/marked.min.js", false), true);
  assert.equal(ig.ignores("static/app.js", false), false);
});

test("negation re-includes (last match wins)", () => {
  const ig = compileIgnore("lib/*.js\n!lib/keep.js");
  assert.equal(ig.ignores("lib/a.js", false), true);
  assert.equal(ig.ignores("lib/keep.js", false), false);
});

test("comments and blank lines are ignored", () => {
  const ig = compileIgnore("# a comment\n\nvendor/\n");
  assert.equal(ig.ignores("vendor/x.js", false), true);
  assert.equal(ig.ignores("src/x.js", false), false);
});
