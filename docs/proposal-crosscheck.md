# Proposal: `crosscheck` — a second model as a reviewer, without a human courier

Status: **draft.** Written from six rounds of running this by hand, where a person
pasted every question and every answer between two models.

## Why bother

The rounds were worth the friction, and it is worth being precise about *what*
they caught, because it determines what the tool has to be good at.

None of the high-value findings were knowledge gaps. Every one was a **claim I had
verified badly**:

- An ordering property "confirmed" by 4,000 random trials whose generator could not
  produce the falsifying shape — and which I had mutation-tested, seen survive two
  mutations, and read as robustness rather than as the test measuring nothing.
- A cache-key field I proposed, defended, and then had to withdraw entirely.
- A parser I made strict in one direction and left a second spelling open in the
  other, under a comment claiming it was canonical.
- A trade of correctness for fixture readability, where a five-line helper made the
  trade imaginary.

These are hard to self-catch because the defence is *coherent*. More effort from
one vantage point does not find them; a second one does.

Equally worth recording: **prose iteration has a floor.** By round 5 the highest-
value items were the ones checkable against code (`grep`, a probe, `git ls-tree`),
and the lowest were design opinion. In round 6 the entire question dissolved when
somebody checked whether the constrained population existed — it did not.

So the tool's job is not "exchange opinions faster". It is **to make claims
checkable, and to make checking cheap.**

## Shape

A CLI utility, with an MCP wrapper over the same core so an agent can call it
mid-task. Not the other way round: the CLI has to be usable by a person watching a
transcript, because the first thing anyone will want is to see what was actually
asked.

```
codemap crosscheck ask     <prompt> [--at <rev>] [--files <glob>...]
codemap crosscheck review  <path>   [--at <rev>]
codemap crosscheck thread  <id> [--reply <text>]
codemap crosscheck list
```

### The two things that made the manual version work

**1. Both sides pinned to the same commit.** Every round in the transcript opened
with "reviewed against `<sha>`", and it is why claims could be confirmed or refuted
instead of talked around. So `--at` defaults to `HEAD` and the sha is recorded on
the thread; a reply that arrives after the tree moved says so.

**2. Findings cite `file:line`.** That is what let each side check the other rather
than defer. The response schema should require it for anything asserted about the
code, and the tool should resolve each citation at the pinned sha and attach the
lines — an assertion about `store.ts:155` should arrive with `store.ts:155` in it.

## Response schema

Free prose was fine for design argument and bad for anything else. The one shape
worth enforcing:

```ts
interface CrosscheckFinding {
  claim: string;                     // one sentence, falsifiable
  severity: "blocking" | "important" | "note";
  cites: { file: string; line: number }[];
  /** A command that would show the reader the same thing. Optional but wanted. */
  check?: string;
  recommendation?: string;
}
```

`check` is the interesting field and the one I would not have thought to ask for
before doing this by hand. Several rounds got *sharper* when a claim was tested
rather than read — and one got refuted-by-extension: the reviewer said a field was
"necessary but insufficient", and running it showed it was not necessary either.
A reviewer that can say `node -e '...'` or `git ls-tree main -- src/` alongside a
claim is doing something a prose reviewer cannot.

The tool should run `check` in a sandbox and attach the output to the finding.
Both sides then argue about a result rather than a prediction.

## Deliberately not

- **Not automatic.** It costs tokens and latency, and the manual version was
  valuable partly *because* invoking it was a decision. A flag, not a hook.
- **Not consensus-seeking.** Agreement rate is a bad health metric. Two of the most
  productive exchanges were disagreements held with evidence, and a tool that
  nudges toward converging would have suppressed both. No "resolve differences"
  step, and no summarizer that flattens a live disagreement into a recommendation.
- **Not a reviewer of its own suggestions.** If it proposes a change, the change
  gets checked the same way anything else does.
- **No new runtime dependency.** Same rule as the rest of this repo. The transport
  is whatever CLI the other model already ships, reached through
  `node:child_process` — the same way `gh` and `git` are.

## Storage

Threads under `.codemap/crosscheck/<id>.json`, gitignored by default. They are a
working artifact, not shared state, and the sidecar already exists for things that
are.

An `--export` that writes a thread to markdown is worth having: several of these
rounds ended up quoted in a proposal, and doing that by hand loses the sha and the
citations, which are the parts that made them checkable.

## Open

- **Who runs `check`?** Running a command a model wrote is exactly the sandboxing
  question every agent has. The conservative version: print it and let a person or
  the calling agent run it. The useful version runs it read-only in a temp
  worktree. Probably start conservative.
- **Cost signal.** Six rounds was productive and a seventh would probably not have
  been. Whether the tool should say anything about diminishing returns, or leave
  that to judgement, is unresolved — a wrong nudge would end rounds that were still
  finding things.
- **Whether `review <path>` should send the file or the diff.** The static review
  in this repo worked from a whole branch; the sharper rounds worked from one
  document. Different jobs, and probably different subcommands rather than a flag.
