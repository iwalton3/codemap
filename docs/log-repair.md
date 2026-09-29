# Repairing a damaged shared log

> **Kind: current reference, normative.** How a person repairs the sidecar when codemap
> locks on a damaged entry. There is no tool for this on purpose (owner, 2026-09-28:
> "Documented manual rewrite assisted by an agent and manually approved by a human for now,
> if it actually happens regularly we come up with a more streamlined solution").

## What locked, and why

The decisions and standard logs are a durable event store and are intended to be immutable.
An entry no conforming build could have written — bytes that are not JSON, a wrong shape, a
dev-era shape of a live kind, or a well-formed act the writer's own build would have refused
(an agent's questionnaire submission, a sign-off by an agent) — is **damage**. It came from a
bug or a broken build, not from two people racing; races are conflict handling and never lock.

Damage anywhere this machine can see locks the whole application: every read and every op, in
every universe on every sidecar this process serves, answers one diagnostic, and `sync` refuses
to commit or merge. Unreadable bytes lock in any scope; shapes and impossible acts are checked
in `decisions/`, `standard/` and `law/`. The lock is not acknowledgeable. The diagnostic names:

- the sidecar path,
- the entry: its id and kind, and the shard and line (`sed -n <line>p <shard>` shows it),
- what is wrong with it.

The flag is `<sidecar>/.git/codemap-lockout.json` — in the git dir, never committed. Deleting
it by hand only hides the damage until the next scan finds it again.

## Who does what

An agent may investigate and prepare every step. **A person approves each step before it
runs**, reading the exact command and, for step 3, the exact diff. Nothing here is done on an
agent's own authority, and nothing is "cleaned up" beyond the one entry.

## Which repair

Read the diagnostic's `why`. It is one of three:

- **Bytes that are not JSON** (`kind` is `(unreadable bytes)`). Nothing can have been read from
  the line and nothing names it. Delete the line in the working tree of the clone whose shard it
  is, then `codemap sync`: a locked sync re-checks and clears, and the deletion travels like any
  commit — a pull never restores a line no build can read.
- **A wrong shape** (`its data is not the shape a … is written in`). The same: no pull restores a
  wrong-shaped line either. But later events may name it (its writer's next line names it as
  `writerPrev`), so **tombstone it in place** (step 2) rather than delete it, in the working tree,
  then `codemap sync`.
- **An act no conforming build writes** (well-formed, refused by the fold over what its own
  writer saw: an agent's sign-off, a withdrawal nobody was asked for). This is the one that needs
  the history rewritten: a pull restores a well-formed event a merge removed — that is what keeps
  the log append-only — so an edit in a new commit comes straight back on every teammate's next
  pull. Steps 1–6.

## The history rewrite

### 1. Tell the team, and stop

Everyone who shares the sidecar stops syncing until step 5. A teammate who has not pulled the
damage is not locked yet; their next pull would either refuse it (a wrong shape is checked on
the way in) or merge it and lock right after (an impossible act needs the fold to see).

### 2. Decide what the entry becomes

Read the line (`sed -n <line>p <shard>`). Almost always the answer is that the act should not
exist: it is **tombstoned in place** — the line is replaced by an event with the SAME `id`, `writer`, `writerPrev`, `after`,
`actor` and `at`, whose `kind` is `log.repaired` and whose data records what it was:

```json
{"kind":"log.repaired","data":{"kind":"<the old kind>","reason":"<why, in the person's words>","approvedBy":"<the person>"}}
```

In place, not deleted, because later events name this one: its writer's next line names it as
`writerPrev`, and any event may name it in `after`. Deleting it would break the chain those
depend on; `log.repaired` is a kind no fold knows, so every fold skips it and every link holds.

If the entry was a real act written wrongly (a field missing that the writer meant), the person
may instead approve a corrected event under the same envelope. Say which in the reason.

### 3. Rewrite the history, on one clone

In the sidecar clone of the person doing the repair. `<shard>` and `<id>` are from the
diagnostic; `<line.json>` is the replacement line from step 2, written to a file outside the
sidecar.

```sh
cd <sidecar>
git branch codemap-pre-repair            # the old history, kept until step 6
git filter-branch --tree-filter '
  if [ -f "<shard>" ]; then
    node -e "
      const fs = require(\"fs\"), [shard, id, file] = process.argv.slice(1);
      const rep = fs.readFileSync(file, \"utf8\").trim();
      const out = fs.readFileSync(shard, \"utf8\").split(\"\n\")
        .map((l) => { try { return JSON.parse(l).id === id ? rep : l; } catch { return l; } });
      fs.writeFileSync(shard, out.join(\"\n\"));
    " "<shard>" "<id>" "<line.json>"
  fi' -- --all
git diff codemap-pre-repair HEAD         # exactly one line changed, in <shard>
```

Every commit is rewritten, not just the tip: a later commit that merely edited the line would be
a deletion in every teammate's history, and the pull restores deleted events — which would put
the damaged line straight back.

Before going on, run codemap's own check, which folds every scope the way a read does:
`node <codemap>/dist/cli.js sidecar check <sidecar>` must report nothing damaged.

### 4. Publish it

```sh
git push --force-with-lease origin HEAD
```

### 5. Every other clone takes the rewritten history

A merge is the wrong tool: the rewritten history is unrelated to the old one, and merging it
would bring the damaged line back. In each teammate's sidecar clone:

```sh
cd <sidecar>
git fetch origin
git branch codemap-pre-repair
git reset --hard origin/<branch>
```

A teammate with unpushed events has them only in their own shards (a shard has one writer).
Before the reset, list them — `git diff --name-only origin/<branch>...codemap-pre-repair` — and
after it, copy each of their OWN shards back from `codemap-pre-repair`
(`git checkout codemap-pre-repair -- <their shard>`). If the damaged entry was in one of their
own shards, apply step 2's replacement to it again. Commit.

Then run `codemap sync`. A locked sync still fetches and re-checks: it looks for damage here and
on the fetched tip, without merging, and **the lock clears once neither has any**. No re-clone.

### 6. Afterwards

Once every clone has synced clean, delete `codemap-pre-repair` everywhere. Keep the reason in
the `log.repaired` entry; it is the record that the log was rewritten, and by whom.
