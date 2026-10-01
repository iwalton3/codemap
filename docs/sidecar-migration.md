# Migrating a sidecar to the linear log

> **Kind: operator procedure.** Run once per team sidecar, by a person, when the build with the
> linear log (docs/PROPOSAL-online-only-sync.md) is ready to deploy. Every step is a person's;
> nothing here runs on its own.

A sidecar from before the linear log keeps one shard per scope *and writer*, merged by git. The
linear build keeps one `events.ndjson` per scope, appended in push order, and it refuses to sync
over — or fold — the old layout ("holds per-writer shards from before the linear log"). The
migration rewrites the sidecar once, in one commit, and plants two markers no old build gets
past: a tripwire (`linear-log/UPGRADE-CODEMAP.ndjson`) that an existing clone's pull refuses, and a
sentinel manifest (`manifests/UPGRADE-CODEMAP.json`, an anchor scheme no build writes) that stops a
FRESH clone, which never pulls the tripwire in, from pulling or pushing.

## Before you start

1. **Every machine syncs with the build it has now**, so nothing is left only on one clone. The
   migration refuses a clone with uncommitted changes or unpushed commits, but it cannot see
   another machine's.
2. **Tell the team to stop writing** until they have upgraded: after the migration commit is
   pushed, an old build can still read what it has, and can no longer sync.

## Steps

1. **Land the build** (merge to `main`) — but do not update machines yet.
2. **Clone the team's sidecar** somewhere scratch, and build e40e9e3 (the last build with the old
   ordering) into a scratch worktree: `git worktree add --detach /tmp/e40 e40e9e3`,
   `ln -s <repo>/node_modules /tmp/e40/node_modules`, `(cd /tmp/e40 && npx tsc)`.
3. **Dry run**, and read the report:

   ```sh
   node scripts/migrate-sidecar.mjs <clone> --old-build /tmp/e40/dist --report migrate.json
   ```

   It lists every event it drops and why: analyzer-node wiring (owner's ruling), and anything the
   new folds refuse in the migrated order. Each should be something the old folds already
   ignored; anything else is a question before going on.
4. **Compare what the team sees**, before and after: apply the migration to a SECOND clone
   (`--apply` on a copy), then `node scripts/migration-diff.mjs <clone> <migrated copy>
   --old-build /tmp/e40/dist` folds every scope with both builds and prints each difference. Every one must trace to a dropped event from step 3, or to a
   concurrency hold the linear log deleted (named in the plan's phase-1 inventory).
5. **Apply**: the same command with `--apply`. It rewrites the clone and commits locally.
6. **Push** the migration commit: `git -C <clone> push origin HEAD:main`.
7. **Upgrade every machine.** On first sync each takes the migrated sidecar; its projections refold
   (the build bumps `MATERIALIZER_VERSION`). A clone whose old per-writer shards hold only events
   that reached the team's sidecar moves to the migrated tip and the old shards go with it.

## If something goes wrong

- **An old build says "UPGRADE-CODEMAP … is writing under ANCHOR_SCHEME 0"**, or "refusing to
  merge … upgrade codemap": that is the sentinel or the tripwire working. Upgrade that machine. Do
  not "repair" either file (docs/log-repair.md is not for this).
- **A new build says the team's sidecar holds per-writer shards**: the migration was not pushed, or
  an old build pushed before the tripwire existed. Re-run from step 2 on a fresh clone.
- **A new build says this clone holds events "that never reached the team's sidecar before it was
  migrated"**: that machine wrote after its last sync and before upgrading. Migrating again does
  not help — the remote is already migrated. Copy the sidecar clone aside (the events are in its
  `w_*.ndjson` files), redo those acts with the new build, then delete the per-writer shards and
  sync.
- **The migration refused**: it names the uncommitted change or the unpushed commit. Sync that
  clone with its current build, and start again.
