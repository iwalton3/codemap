# Repairing a damaged shared log

> **Kind: current reference, normative.** How a person repairs the sidecar when codemap
> locks on a damaged entry. There is no tool for this on purpose (owner, 2026-09-28:
> "Documented manual rewrite assisted by an agent and manually approved by a human for now,
> if it actually happens regularly we come up with a more streamlined solution").

## What locked, and why

The shared log is a durable event store and is intended to be immutable. Every event on the
remote was checked against the log before it by the build that pushed it
(docs/sidecar-architecture.md), so an entry this build cannot read that way is **damage**. It
came from a bug or a broken build, not from two people racing, because a race is refused at
replay and never reaches the log. Damage is either:

- bytes that are not JSON, in any scope, or
- an event carrying a `seq` that its scope's fold refuses: its precondition, or a reference into
  the shared log.

A shape this build does not write is **not** damage. It reads as *newer*: reads carry on without
it and pushes block until an upgrade (plan 3.2).

Damage anywhere this machine can see locks the whole application: every read and every op, in
every universe on every sidecar this process serves, answers one diagnostic, and `sync` refuses
to commit or push. The lock is not acknowledgeable. The diagnostic names:

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

Read the diagnostic's `why`. Every repair is **one ordinary commit, pushed with git**. Nothing
rewrites history. The remote is the serializer and every pull is a fast-forward to its tip, so a
commit that changes a line stays changed on every clone. A pull never merges anything back.

- **Bytes that are not JSON** (`kind` is `(unreadable bytes)`). Nothing can have been read from
  the line and nothing names it: **delete the line.**
- **Anything else**: a wrong shape, or an act the fold refuses against the log before it (an
  agent's sign-off, a withdrawal nobody was asked for). Later events may name it, so **tombstone
  it in place** (step 2) rather than deleting it.

`codemap sync` will not carry the edit, and that is deliberate. A sync moves the clone to the
remote tip, so it refuses a hand-edited shard ("edited by hand, not appended to") and refuses a
local commit whose lines differ from the remote's. Otherwise it would throw the repair away
without a word.

## The repair

### 1. Tell the team

A teammate who has pulled the damage is locked already. One who has not will be locked by their
next sync. Nobody needs to do anything until step 4.

### 2. Decide what the entry becomes

Read the line (`sed -n <line>p <shard>`). Almost always the act should not exist. It is
**tombstoned in place**: the line is replaced by an event with the SAME `id`, `seq`, `writer`,
`writerPrev`, `after`, `actor` and `at`. Its `kind` is `log.repaired`, and its data records what
the event was:

```json
{"kind":"log.repaired","data":{"kind":"<the old kind>","reason":"<why, in the person's words>","approvedBy":"<the person>"}}
```

It is replaced in place rather than deleted because later events may name it in `after`, and
`seq` orders the log. No fold knows the kind `log.repaired`, so every fold skips it: it is neither
damage nor "newer" data, so it neither locks nor blocks a push.

If the entry was a real act written wrongly (the writer meant a field that is missing), the person
may approve a corrected event under the same envelope instead. The reason says which.

### 3. Commit and push, from one clone

In the sidecar clone of the person doing the repair:

```sh
cd <sidecar>
git fetch origin && git reset --hard origin/<branch>   # start from the tip; a locked clone has nothing unpushed
# edit <shard>: delete the line, or replace it with step 2's line
git diff                                                # exactly one line changed, in <shard>
node <codemap>/dist/cli.js sidecar check <sidecar>      # must report nothing damaged
git commit -am "codemap: repair <id> (<reason>)"
git push origin HEAD:<branch>
```

If the push is rejected, someone pushed in between. Run the same steps again from the fetch.

### 4. Every clone releases on its next sync

`codemap sync`, on every clone, the repairer's included. A locked sync still fetches. It checks
the fetched tip, moves to it if the tip is clean, and folds again, and **the lock clears once
nothing is damaged**. No re-clone, and nothing to copy between clones: staged writes live in the
queue, not the tree.

The `log.repaired` entry and the commit are the record that the log was repaired, and by whom.
