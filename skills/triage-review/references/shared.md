# The shared contract

The rules `triage-review` and `ez-plan` both follow. **This file is byte-identical in both skills**;
change it in both or neither. Each skill's own `references/contract.md`
holds its procedure. Where a skill's contract or step file disagrees with this file, this file is
right.

## Purpose, and the standing duty

The owner holds the top levels and the session holds the lower ones; these skills are the glue. They
exist to stop invalid findings and unadjudicated design changes from reaching the artifact, because
the owner has no time to read every item and will defer the work to an agent. The skill developer's words for
what that costs when it goes wrong:

> a week later when their app silently does something else, it's too late and now they have *more
> findings* to apply, now at the human level, and everything rots and decays to chaos in the system

Every guard follows from that: the groups keep an assumption from being applied as a defect, the
gate keeps anything from landing unseen, and the plan keeps a design change the owner's rather than
a side effect of a fix.

**The standing duty.** The owner decides from the frame the session gives them, often with none of
the detail in hand, so the session carries the detail and says when something conflicts, does not
add up, or is missing from what the owner is holding. It binds everywhere, a discussion included:

- **Say what *is* before asking what *should be*.**
- **Where the owner cannot answer, that is the finding**: say what would settle it — the real
  system, a reference, a measurement, whoever holds it.
- **Never fill the gap with your own reading.**

**What they run on.** Code, and prose artifacts exported from Claude Code — plans of action and
skills — in a git repository; and versioned Artifacts, which are versioned but not in git. Anything
else outside git stops the skill: "not a git repository".

## The unit

- **U.** The work is one or more git repositories treated as a unit, established when the run starts
  and stated: each member's absolute path and why it belongs. The owner may correct it; it is not a
  question.
  - **A member is one repository at its one checked-out branch**, with its own working tree and
    `HEAD` — never two branches of one repository. It is labelled by its basename, with a suffix
    where two share one (`app`, `app-2`), and always listed with its absolute path.
  - **Anything unusual that plain `git status` shows for a member stops the skill** — in the skill
    developer's words, "is there uncommitted or an otherwise abnormal disposition on a branch that would stop a
    reasonable person committing more work there?": a detached `HEAD`; a merge, rebase, `am`,
    cherry-pick, revert or bisect underway; unmerged paths; and the like — not a closed list. What
    `git status` says of the branch's upstream is never unusual: "Unpushed commits aren't a 'dirty'
    branch". The stop names the repository and what `git status` said, with the `HEAD` sha where it
    is detached.
  - **The skill runs from one primary member**: `RECORD` lives there.
  - **Each `--spec` path goes only to the members that hold it.** A path no member holds is told to
    the owner and passed nowhere.
  - **A versioned Artifact round** is a unit of one: the replay, a git repository in a temporary
    directory (`triage-review` builds it). On a resumed run, where the replay path `sort.md` names
    is gone, stop and tell the owner that the replay is gone and that this is expected after a
    restart. That is not `G2`. Where `ez-plan`'s work items name an Artifact the session already
    holds, it is a member as it stands: no replay and no tree, and `RECORD` goes where `K1` puts an
    Artifact run outside git.

## Tree and git

- **G1.** Nothing runs on an uncommitted tree, in any member of the unit.
  1. Survey every member with plain `git status`, untracked files included, before committing
     anything.
  2. **Anything unusual** in any member (`U`) aborts at once as `G2`: nothing is committed in any
     repository.
  3. Otherwise, where something objects in any member — another agent's work, temporary files, an
     earlier report left in the working tree, anything unexpected — ask the owner once, naming every
     repository, before committing anything. An earlier report is theirs to decide on; the question
     says such reports are generally committed before another run.
  4. If any tree is then still dirty and cannot be committed, stop before committing anything.
  5. Otherwise commit each member's in-flight work by path — `git add <paths>` (which an untracked
     path needs), then commit those paths — tell the owner, and record the in-flight commit per
     member. A commit that fails is `G2`'s.
- **G2.** Anything unexpected in git — a command that fails, a hook that rejects, a tree that
  changes under the run — stops the skill. Tell the owner exactly what happened: which members were
  committed or tagged, with the shas; anything left staged; the command's output; and any agent
  still in flight. While stopped, repair nothing of your own accord: no undo, no unstaging, no
  retry, no survey to find out more. When the owner has cleaned up and says to resume, continue what
  was stopped. A reply that arrived from an in-flight agent during the stop is not used; relaunch
  that agent, because its reading was taken against a tree that has since moved.

## Agents

- **A.** Every agent either skill launches gets its brief as a launch block with every bracket
  substituted, and uses the Delegate Model (each skill's `SKILL.md` defines it), never a fork: a fork
  inherits the session's context and silently ignores the model override. Where that model is not
  available it is an outage: tell the owner the session is waiting on an outage, end the turn, and
  resume from that launch when the owner says so. An agent interrupted by an outage is resumed with
  `SendMessage`, not relaunched. Never downgrade.

## The ladder

- **L.** A decision's level is who can change it and what that costs — the skill developer's solidity
  ladder, condensed. The agent infers the level (the skill developer: *"counterintuitively the agent can
  usually infer the level and can be generally trusted to do so"*), and who acts follows from it:
  - **1-3, natural law, law, industry rule** — cited in `docs/rules/`. They do not move: a finding
    or a plan that conflicts with one is wrong.
  - **4, business rule** — in `docs/rules/`, human-written with its reason. A conflict goes up the
    chain of command; no agent settles it.
  - **5, design rule** — a commitment a design direction made, costly to change. **Mostly written
    nowhere**: the code and docs show it, in how much depends on it and what reversing it would
    take (the skill developer: *"most level 5 items are unwritten and implicit based on code or
    docs"*). A change to one goes through a plan, with its cost.
  - **6, principle** — `CLAUDE.md`'s `## PRINCIPLES`, the owner's words. The agent decides within
    it, citing it, and escalates where it cannot be upheld.
  - **7, approved decision** — the agent may change it, and says so.
  - **8, implementation detail** — the agent decides.

  A rule a finding refutes, or whose falsifier a finding trips, goes to the owner, never sorted
  away.

## The groups

- **S1. Purpose.** On a document, purpose is one or two sentences, used only to call findings that
  push the document toward a different purpose invalid or suggestions. Where it cannot be stated,
  write `not stated` and ask nobody. *Out of scope* is a valid verdict only for a document with a
  stated purpose: never on code, and never where the purpose is `not stated`. Purpose is for
  artifacts; for code, the equivalent anchor is its requirements.

"Findings" below means the numbered input items, whatever their source: a review, an issue tracker,
a todo list.

The first four definitions are the skill developer's, verbatim. The two `pin-defs` regions are kept
byte-identical to `triage-review`'s `prompts/sorter.md`, so every sort uses
the same categories. The defect-pattern rule between the regions is outside the pin: the two files
state it differently, and converging them is not the pin's job.

<!--pin-defs-->
1. **Implementation defect:** "We know what we're doing, we know where and why it's wrong, there is
   one correct, obvious, and isolated way fix it." It is for "the mechanical stuff like 'we forgot
   a tenant check on this endpoint' or 'we don't check the file exists before trying to rename
   it'". Two kinds:
   - **Isolated defect** — one site.<!--/pin-defs-->
   - **Defect pattern** — the same mechanical defect at several sites. Count the sites before
     sorting: grep the pattern, not the site. **It never lands before the plan**: the plan settles
     it, so its fix goes through the coherence check (the skill developer: *"fixing patterns early
     means the pattern fix doesn't go through a coherence check, which catches a surprising number
     of issues"*). It is settled there without the owner **unless fixing it forks the design** (`L`,
     level 5) — a sorter names a higher-order fix (the skill developer: *"a lot of defect clusters I
     think can be auto-settled unless there is a major level 5 fork for how to deal with them"*). A
     pattern is *evidence* that a design rule may be missing, not proof of one — often, but not
     always. **A pattern whose fix forks the design is put to the owner as its fork**: each fix,
     fixing every site among them, with what it costs and what depends on it, and no option the
     default (the skill developer, agreeing to exactly that; it supersedes fixing every site as the
     default). The skill developer's examples, verbatim: "we can keep fixing sql injection, or we can switch
     to prepared statements" and *"sql injection because someone is using
     `mysql_real_escape_string` instead of PDO … another would be tenant isolation failing because
     the check happens per-module and not in a database repository helper"*. The second is the shape
     the first does not show: not a wrong call repeated, but a correct check placed at the wrong
     level. **In both, the higher-order fix is a change to the code's design**, with fixing each
     site the same way as the standing alternative. Where the higher-order fix would be a change to
     *process* rather than to the code, the cluster is **not** a defect pattern: its sites resemble
     each other without sharing a defect, and the plan has no design fork to put.<!--pin-defs-->
2. **Design defect:** "We designed something. It causes a problem downstream. A proposal is
   needed."
3. **Assumption:** "Past code made an assumption documented nowhere. The assumption either broke
   or doesn't hold up elsewhere. A proposal is needed."
4. **Design suggestion:** "The design is questionable and might deserve a change." Only that —
   might be worth doing.<!--/pin-defs-->
5. **Invalid**, naming *why* it is refuted:
   - **wrong** — contradicted, with the command or line that shows it;
   - **assumed** — the finding assumed X; Y is true. A finding standing on the reviewer's own
     unstated assumption;
   - **out of scope** — true, but it does not serve what the document is for (`S1`). State it as
     what *the reviewer wanted*: "wanted to turn an elicitation document into a system-state
     report."

**Not an implementation defect**, isolated or pattern, if any of these hold:
- the fix needs a rule nobody wrote down, or picks between two behaviours someone could want;
- the only "why" is the reviewer's say-so — it needs a requirement, the owner's words, the real
  system or a reference;
- the fix changes behaviour something else relies on.

On a document, the design is what it is for and how it is organised. Findings that add precision or
qualifications the reader does not need are suggestions where they are harmless, and *out of scope*
where they work against the purpose.

**Clustering** puts findings together by cause. It is ordering and addition only: every finding is
in at least one cluster, a finding making two claims may be in two, and nothing is judged, merged
away or dropped. `triage-review` clusters before anything sorts, so the sorters sort causes, not
findings (the skill developer: *"clustering should probably happen first and be ordering/additive
only so one agent can do it and findings don't get lost"*). A sorter that reads a cluster as two
causes splits it, naming the findings each part covers.

**Carried sentences.** While sorting, a sentence about the work itself — a fix that was already
wrong once, a rule at more sites than named, growth against a stated limit — goes into the sort
verbatim.

## The sort

- **S2. `findings.md` and `sort.md`** are the interface between the skills: `triage-review` writes
  them from a review, `ez-plan` writes them from a todo list or a session's items, and both read
  them.
  - `findings.md` — the input, numbered F1..Fn in the order received, under a heading per source,
    each under its own heading `### F<n>` with the source's own id and its full text. Where the
    input was diffuse — a discussion, items mentioned in passing — the session itemizes it and says
    so at the head.
  - `sort.md` holds: **who sorted it** — two sorters and an arbitrator, or one sorter with the owner
    reading every item — and so **which categories**: the groups below, or `ez-plan`'s work-item
    categories (its contract, `Z2`); purpose (documents only, `S1`); each item's group, kind and
    sites with the command, the findings it covers, what settles it and the level its fix decides at
    (`L`), both readings where they differed with any arbitration and its outcome, and **"don't fix
    early"** where it applies; related items clustered; **rules to raise first** — a rule a finding
    refuted or whose falsifier it tripped, or `none`, where `triage-review` wrote the sort; the
    round, with the walls it found; the route and why, where `triage-review` routed it; **what
    landed** before planning, per fix one line, its commit (or Artifact version), what settled it,
    and its check — the command that fails without the fix, what it did without the fix and what it
    does with it, or `no check: <why>`; **one choice line per `ez-plan` session** (its contract says
    what it holds); one sentence of counts; carried sentences; and last, `Uncovered:` — `none`, or
    the numbered findings no item covers.
  - **The round** is the unit — per member its label, absolute path, why it belongs, in-flight
    commit or `none`, and the range the input covered there — and where the input was a review,
    which review, at which commit, which findings were fixes on fixes. A commit made when a later
    session resumes the run is appended under its member and says it is a resume-time commit no
    review covered. For a versioned Artifact, the unit line is its title and URL, the replay's
    temporary path, in-flight commit `none`, and the range v1..live, with the per-version calls.
  - A prior run's `sort.md` may be appended to with a marked errata, where a later run or a ruling
    corrects something a reader would otherwise act on; neither sorter's words are rewritten. This
    holds after that run's plan is finalised (`K3`) too.

## Questions

These bind every question either skill puts to the owner, on every route and in every phase, a
discussion included. How questions are drafted and batched is each skill's own.

- **Q1. Self-containment.** Every question is self-contained in the session's own message: the full
  question and every item it refers to written out, never introduced as an agent's ("the
  drafter's", "the triager's"), and never sending the owner to an agent's output or a file. Opening
  an agent's output discards the pending batch of questions.
- **Q2. The claim check** is a principle, not a rule: where you are enumerating scripted edge
  cases — what a command shows, what a file says, what the machinery does — ask how the owner would
  approach or describe it, and put it that way. Two instances follow from it: a claim a question
  rests on is checked in the form the owner would run or read it, and a question says whether a
  behaviour is the agent's or a script's. A wrong premise is ruled on case by case.
- **Q3. Altitude.** A question does not require the owner to dig up context that was not presented
  to them; if including that context makes it long, it may be too specific, so consider asking about
  a general rule or principle instead. Give examples where possible. Verify each option's premise
  holds before offering it, and drop the ones that don't. The owner rules on requirements or
  intuition, not on implementation details that could conflict downstream, so pitch questions at
  that altitude, and do not put an edge case in a form whose answer will later be read as an
  invariant.

## Records

- **K1. `RECORD`** is the run's directory in the primary: `$(git rev-parse
  --git-common-dir)/triage/<YYYY-MM-DD>-<slug>/` for a `triage-review` run, and `.../plan/...` for a
  run `ez-plan` starts — never `--git-dir` and never a literal `.git/`, both per-worktree. A run
  `ez-plan` continues from `triage-review` uses that run's `RECORD`. **A `CLAUDE.md` in scope naming
  a destination for a skill by name supersedes that skill's default**, and only that skill's. Any
  `CLAUDE.md` the session was given counts, the user's global one included; a relative path is
  relative to the primary's working tree root. For a versioned Artifact run outside git, `RECORD` is
  `./triage-<YYYY-MM-DD>-<slug>/` or `./plan-<YYYY-MM-DD>-<slug>/` in the current directory, never
  in the replay.
  For git runs, resolve the returned absolute path once with `scripts/run_record.py --repo REPO --skill
  <skill> --slug <date-slug>`, adding `--record <override>` only for a skill-specific destination.
  Store its run-identity manifest. Resume with the retained absolute `--record` and `--resume`;
  compare repository identity before using any prior ID. A linked worktree shares the common
  directory; an unrelated repository with the same basename does not.
- **K2.** A record in the working tree is committed as it is written; a record git ignores is not.
  Which applies is decided by `git check-ignore -q <RECORD>`. Either way the tree is clean at every
  step boundary, so the skill never trips its own `G1` on files it wrote. Where it is committed,
  each step commits what it wrote before it ends, and those commits are never fixes.
- **K3. `owner.md`** holds every question the skill puts to the owner about the artifact, and their
  answer, verbatim, wherever it was asked. A process question goes there only where a later agent
  reads the answer. It is **sealed when the plan is finalised** — the planning session ending, or
  the owner executing the plan; a ruling taken while the plan is applied is quoted at the site it
  changes instead. It may be appended to with a marked errata on the same terms as `sort.md`; the
  owner's words are never rewritten. A superseded ruling is marked superseded, points to the ruling
  that replaces it, and says which part of it still stands.
- **K4. `handoff.md`** goes in `RECORD`, beside the `plan.md` it exists to produce, and is deleted
  once that plan is implemented, by whoever implements it. It says so at its head. Advisory: where
  the work is done without a plan ever being written, the handoff file should be cleaned up too.
- **K5. Prior records** are searched in both skills' stores: `triage/` and `plan/` under the
  primary's common directory, and every directory a `CLAUDE.md` names for either skill, deduplicated
  by real path. The defaults are derived, not passed. A run directory is `<date>-<slug>` where
  somebody named its parent — a default or a `CLAUDE.md`'s choice — and `triage-<date>-<slug>` or
  `plan-<date>-<slug>` in the one place nobody did, the current directory of an Artifact run outside
  git. From each prior run: `sort.md`, `owner.md`, `owner-late.md`, `plan.md` and `deposition.md` —
  never `findings.md`, `clusters.md`, `sort-a.md`, `sort-b.md`, `arbitration.md` or `lens-*.md`. A
  plan holds the owner's intent, which is what turns an apparent assumption into a ruling.

## Commits

- **C.** Work a run lands says so. A commit carries `Review-round: <RECORD's directory name>` where
  the run came from `triage-review` — directly or through its handoff — and `Work-plan: <RECORD's
  directory name>` otherwise, and its message says what was done, why, and which run. On a Claude
  Artifact the published version's label says it instead. The trailer marks the commit, not lines,
  so a commit carrying it holds only work attributable to the run; the message is not a second
  marker to be policed.
  1. a commit implementing a run's plan carries the trailer, by default;
  2. an unrelated commit carries no trailer, and its message does not claim to belong to a run;
  3. a run's work and unrelated work are not combined into one commit.

  `plan.md` names its run — the record slug and path — at its head.

## Under Codex

Where the session is a Codex agent rather than Claude Code, everything above binds except:

- **X1. Models.** Every launch uses the Delegate Model as `SKILL.md` defines it for Codex. `A`'s
  outage rule applies: never downgrade.
- **X2. Questions.** Codex has no `AskUserQuestion`, and its own question feature drops a question
  when the turn ends, so it is no substitute. **A fork question** — the opening's choice of route, or
  any question whose answer decides which step runs next — ends the turn: write it out with its
  options and take the owner's free-form reply. **Every other question** goes through codemap where
  it is open (`references/codemap-workflow.md`, *Asking*), and otherwise into
  `RECORD/questions-<n>.md`: each question in the step's order, its options as `[ ]` boxes carrying
  what the step says an option carries (the recommendation first and marked), and a blank line for
  the owner's own words. End the turn saying the file is ready, and read it when the owner says they
  have marked it with `[X]` or filled it in. Never skip a question or continue past one unanswered:
  a later batch waits for the earlier one's answers, written to `owner.md` as `K3` says.

