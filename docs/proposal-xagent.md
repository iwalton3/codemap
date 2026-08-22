# Proposal: `xagent` — external-model subagents

Status: **draft.** Transport verified against  — see §6.

Not a codemap feature. A general utility: spin up an agent from a *different*
model vendor in the current directory and talk to it the way a Claude Code
subagent is talked to — spawn with a task, send follow-ups, read replies, end it.

An earlier draft of this file specced a codemap-specific review command. That was
the wrong shape: the review workflow is one use of the capability, not the
capability. What is worth keeping from it is in §5, as defaults rather than as
design.

## 1. The interface

Modelled on Agent + SendMessage, because that shape is already proven and already
familiar to the caller:

```
xagent spawn  <prompt> [--cwd <dir>] [--model <id>] [--label <name>]   -> session id
xagent send   <id> <message>                                           -> reply
xagent read   <id> [--since <n>]                                       -> transcript
xagent list
xagent end    <id>
```

An MCP server wraps the same core so an agent can reach it mid-task. **CLI first,
MCP second** — the first thing anyone wants when this misbehaves is to see exactly
what was sent, and a CLI transcript is that.

Sessions are stateful: `send` continues a conversation, it does not restart one.
That is the whole difference between this and piping a prompt to a binary, and it
is the part most likely to be hard (§6).

## 2. Where the boundary is

```
xagent core          session store, transcript, lifecycle       (vendor-neutral)
  |
  +-- adapter/<vendor>   spawn, send, parse                     (one small file each)
```

The adapter is the only vendor-specific part and it is deliberately small:
turn a prompt into a subprocess invocation, turn output into a message. Everything
else — session ids, transcripts, concurrency, timeouts — is shared.

That seam is not speculative generality; it is because **the transport is the part
I cannot currently verify** and it should be replaceable without touching
anything else.

## 3. Isolation and permissions

Spawning an agent with write access to the working directory is a real decision,
not a detail.

- **Default read-only.** The subagent gets the directory and may not write it.
  Enough for review, cross-checking, and "what does this code do", which is most
  of the value.
- `--write` opts into mutation, and should be refused unless the tree is clean or
  the caller passes `--dirty-ok`. A second agent editing over uncommitted work is
  the failure that produces "who changed this?".
- `--worktree` runs it in a throwaway git worktree, which is the right default for
  anything that writes. Cheap here — the repo already does this.
- Whatever the backend's own approval mode is, it is set explicitly by the
  adapter, never inherited from the user's interactive config. An agent spawned
  by a script must not silently pick up the permissions a human granted their
  own session.

## 4. State

Sessions under `~/.xagent/sessions/<id>/` — transcript as line-delimited JSON, one
message per line, plus a small `meta.json` (cwd, model, label, pinned sha, start
time). Append-only, so a crashed session is still readable and a live one can be
tailed.

Not in the repo, not gitignored-into-the-repo: this is a working artifact of a
person's machine, and putting it in the tree makes it somebody's diff.

## 5. Defaults, learned from doing it by hand

Six rounds of this ran through a human courier before it was a tool. The findings
were consistently of one kind, and it shapes what the defaults should be.

None of the high-value catches were knowledge gaps. Every one was a **claim
verified badly**: an ordering property "confirmed" by 4,000 trials whose generator
could not produce the falsifying shape; a field proposed, defended, then withdrawn
entirely; a parser made strict in one direction under a comment claiming it was
canonical. These are hard to self-catch because the defence is coherent — more
effort from one vantage point does not find them.

And **prose iteration has a floor.** The best late-round items were the ones
checkable against code; one whole question dissolved when somebody ran
`git ls-tree main` and found the population it constrained did not exist.

So, as defaults rather than as schema:

- **Pin a revision.** `spawn` records `HEAD`, and a reply that arrives after the
  tree moved says so. Every productive round in the transcript opened with
  "reviewed against `<sha>`", and that is why claims could be checked rather than
  talked around.
- **Ask for citations and commands.** A prompt template for review-shaped tasks
  that asks for `file:line` and, where possible, a command that would show the
  reader the same thing. Several claims got sharper when run rather than read, and
  one was refuted-by-extension — "necessary but insufficient" turned out not to be
  necessary either.
- **Do not add a consensus step.** No summarizer that flattens a live disagreement
  into a recommendation. Agreement rate is a bad health metric; two of the most
  productive exchanges were disagreements held with evidence, and a tool that
  nudged toward converging would have suppressed both.
- **Manual invocation.** Not a hook. It costs tokens and latency, and it was
  valuable partly *because* invoking it was a decision.

## 6. Transport — verified

`codex-cli 0.149.0`, checked against the installed binary rather than assumed.
Every question §6 used to ask is answered, and most of what §1–§3 specced already
exists.

### `codex exec` — the one to build on

```
codex exec [PROMPT] --json -C <dir> -s read-only -m <model> --output-last-message <file>
codex exec resume <session-uuid> [PROMPT] --json
codex exec fork   <session-uuid> [PROMPT]
```

| §1–§3 asked for | `codex exec` already has |
|---|---|
| headless | yes, that is what it is |
| working directory | `-C, --cd <DIR>`, plus `--add-dir` for extra writable roots |
| stateful follow-ups | `exec resume <uuid> <prompt>`, and `exec fork` to branch |
| structured output | `--json` (JSONL events), `--output-last-message <FILE>` |
| read-only by default | `-s read-only \| workspace-write \| danger-full-access` |
| not inheriting interactive permissions | `--ignore-user-config`, `--ignore-rules` |
| model selection | `-m, --model` |

Two things it has that the spec did not think to ask for and should now use:

- **`--output-schema <FILE>`** — a JSON Schema for the model's final response. The
  §5 "ask for citations and commands" default stops being prompt-wrangling and
  becomes a contract the CLI enforces.
- **`--ephemeral`** — run without persisting session files. The right default for a
  one-shot question; the wrong one for anything resumable.

So the adapter is genuinely thin, and §3's isolation section largely collapses into
passing the right flags rather than building anything. What is left for `xagent` is
session bookkeeping, transcripts, concurrency, and the MCP wrapper.

### `codex mcp-server` — works today, deprecated

It exposes exactly the interface §1 describes:

```
codex        args: prompt, cwd, model, sandbox, approval-policy, config,
                   base-instructions, developer-instructions, compact-prompt
codex-reply  args: threadId, conversationId, prompt
```

`codex` = spawn, `codex-reply` = send. Two tools, no code at all — add it to a
client's MCP config and the capability exists.

But it prints `codex mcp-server is deprecated and will be removed in a future
release` on startup. **Use it now, do not build on it.** It is the fastest way to
try the workflow — including having this session talk to Codex directly instead of
a person carrying messages — and a bad foundation for a tool meant to last.

### `codex app-server` — the successor, not yet

The replacement, and explicitly `[experimental]`: `daemon`, `proxy`,
`generate-ts`, `generate-json-schema`. Shipping schema generators for your own
protocol is a fair sign it is still moving. Building against an experimental
protocol is worse than building against a stable-but-deprecated one, and worse
again than `codex exec`, which is neither.

### Recommendation

1. **Today:** wire `codex mcp-server` into the client's MCP config. Zero code,
   immediate, and it ends the message-shuttling now.
2. **When it earns it:** build `xagent` on `codex exec` — stable, and it already
   provides isolation, structure and session continuation. The adapter is a
   subprocess call and a JSONL reader.
3. **Watch:** `app-server` maturing. If it stabilises before `xagent` is written,
   it is the better long-term adapter and §2's seam is where it goes.

One caveat worth carrying: nothing above ran a model. The interfaces are read from
`--help` and from an MCP handshake, so shapes are confirmed and *behaviour* is not
— what `--json` actually emits per event, and whether `resume` preserves what a
caller expects, are the first things to check when an adapter gets written.
