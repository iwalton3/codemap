// Runs an owner page's <script> against a minimal fake DOM and a fake `db` whose writes resolve only
// when the test says so, then plays a scenario named on the command line. Prints one JSON result.
//   node page_harness.js <page.html> <data.json-url-name> <scenario>
"use strict";
const fs = require("fs");
const [page, dataName, scenario] = process.argv.slice(2);
const html = fs.readFileSync(page, "utf8");
const script = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
function matchesCompound(el, sel){
  const m = sel.match(/^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!m) throw new Error("selector not supported: " + sel);
  if (m[1] && el.tag !== m[1]) return false;
  for (const c of m[2].split(".").filter(Boolean)) if (!el.className.split(/\s+/).includes(c)) return false;
  for (const a of m[3].match(/\[[^\]]+\]/g) || []){
    const [, k, v] = a.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (!k.startsWith("data-")) throw new Error("attribute not supported: " + a);
    const got = el.dataset[camel(k.slice(5))];
    if (got === undefined || (v !== undefined && got !== v)) return false;
  }
  return true;
}
function matches(el, root, sel){
  const parts = sel.trim().split(/\s+/);
  if (!matchesCompound(el, parts.pop())) return false;
  let p = el.parent;
  while (parts.length && p && p !== root){ if (matchesCompound(p, parts[parts.length - 1])) parts.pop(); p = p.parent; }
  return parts.length === 0;
}
class El {
  constructor(tag){ this.tag = tag; this.children = []; this.parent = null; this.dataset = {}; this.style = {};
    this.className = ""; this.id = ""; this.hidden = false; this.value = ""; this._text = ""; this.listeners = {}; this.attrs = {};
    const self = this; this.classList = { contains: c => self.className.split(/\s+/).includes(c), add: c => { self.className += " " + c; } }; }
  set textContent(t){ this._text = String(t); this.children = []; }
  get textContent(){ return this._text; }
  append(...ns){ for (const n of ns){ if (n instanceof El){ n.parent = this; this.children.push(n); } } }
  appendChild(n){ this.append(n); return n; }
  insertBefore(n, ref){ n.parent = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, n); }
  after(n){ if (this.parent) this.parent.append(n); }
  setAttribute(k, v){ this.attrs[k] = String(v); }
  getAttribute(k){ return this.attrs[k]; }
  addEventListener(t, f){ (this.listeners[t] ||= []).push(f); }
  fire(t){ for (const f of this.listeners[t] || []) f({target: this}); }
  *walk(){ for (const c of this.children){ yield c; yield* c.walk(); } }
  querySelectorAll(sel){ const out = []; for (const e of this.walk()) if (sel.split(",").some(s => matches(e, this, s))) out.push(e); return out; }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
}
const body = new El("body");
for (const id of ["h1", "lede", "tally", "status", "stats", "main"]){ const e = new El("div"); e.id = id; body.append(e); }
const document = {
  activeElement: null,
  createElement: t => new El(t),
  createTextNode: () => new El("#text"),
  getElementById: id => { for (const e of body.walk()) if (e.id === id) return e; return null; },
};

// Timers run only when the test advances them.
let timers = [], tid = 0;
const setTimeout = (f, ms) => { timers.push({id: ++tid, f}); return tid; };
const clearTimeout = id => { timers = timers.filter(t => t.id !== id); };
const flushTimers = () => { const ts = timers; timers = []; ts.forEach(t => t.f()); };

// Writes stay pending until released; the snapshot listener is driven by hand.
const pending = [], written = [];
let onSnap = null;
const db = {
  doc: path => ({ set: body => new Promise(res => pending.push({path, body: JSON.parse(JSON.stringify(body)), res})) }),
  collection: () => ({ onSnapshot: f => { onSnap = f; } }),
};
// A page chains its writes, so the next one is only sent after a tick.
const releaseAll = async () => { await tick(); while (pending.length){ const w = pending.shift(); written.push(w); w.res(); await tick(); } };
const tick = () => new Promise(r => setImmediate(r));
const snapshot = docs => onSnap({ docs: docs.map(([id, b]) => ({ id, data: () => b })) });

const DATA = {
  "decisions.json": { round: 1, decisions: [{ id: "D1", level: "5", title: "t", options: [{key: "a", label: "A"}] }] },
  "clusters.json": { clusters: [{ id: "C1", title: "t", set: "principle" }] },
};
const window = { claude: { use: async k => k === "db" ? db : { id: async () => "me" } } };
const fetch = async name => ({ ok: true, json: async () => DATA[name] });

new Function("document", "window", "fetch", "setTimeout", "clearTimeout", script)(document, window, fetch, setTimeout, clearTimeout);

const card = id => document.getElementById("card-" + id);
const type = (t, text) => { document.activeElement = t; t.value = text; t.fire("input"); };
const blur = t => { document.activeElement = null; t.fire("blur"); };

(async () => {
  for (let i = 0; i < 10 && !onSnap; i++) await tick();
  if (!onSnap) throw new Error("page never subscribed to snapshots");
  const id = dataName === "decisions.json" ? "D1" : "C1";
  const pickField = dataName === "decisions.json" ? "pick" : "mark";
  const words = card(id).querySelector("textarea");
  const button = card(id).querySelectorAll("button").find(b => b.dataset.field === pickField);
  const lastFor = () => written.filter(w => w.path === "marks/" + id).pop()?.body || {};
  const out = {};

  // An earlier answer, saved and echoed back.
  snapshot([[id, { words: "old", at: "t0" }]]);
  if (scenario === "stale-after-blur"){
    // Typed and left the box: the write is in flight when a snapshot of the older value arrives.
    type(words, "new"); blur(words);
    snapshot([[id, { words: "old", at: "t0" }]]);
    out.shown = words.value;
    button.fire("click");   // a second field written from the page's state
    await releaseAll();
    out.saved = lastFor().words;
  } else if (scenario === "stale-while-typing"){
    // Still typing, the debounced write not yet sent, when a stale snapshot arrives.
    type(words, "new");
    snapshot([[id, { words: "old", at: "t0" }]]);
    blur(words); button.fire("click");
    await releaseAll();
    out.shown = words.value;
    out.saved = lastFor().words;
  } else if (scenario === "remote-change-lands"){
    // Nothing being edited here: a change from elsewhere still repaints.
    snapshot([[id, { words: "theirs", at: "t1" }]]);
    out.shown = words.value;
  } else if (scenario === "own-write-then-remote"){
    // After this page's own write resolves, the field takes later remote changes again.
    type(words, "new"); blur(words);
    await releaseAll();
    snapshot([[id, { words: "new", at: "t1" }]]);
    snapshot([[id, { words: "theirs", at: "t2" }]]);
    out.shown = words.value;
  } else throw new Error("unknown scenario " + scenario);
  flushTimers();
  console.log(JSON.stringify(out));
})().catch(e => { console.error(e.stack || e); process.exit(2); });
