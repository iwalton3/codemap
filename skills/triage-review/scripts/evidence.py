#!/usr/bin/env python3
"""The evidence pack for /triage-review's diagnosis: what the record says about a window.

Read-only. Runs in seconds to a minute on a normal window and writes
`<run dir>/evidence/`. It answers four questions and refuses to answer any of
them with a number it did not measure.

    commits.md      what landed in the window, and what it was built on top of
    selffix.md      how much of the window repairs the same window, by more than
                    one instrument, with the blind zone stated; and the lines one
                    commit took out that a later one put back
    surface.md      what the window did to the named criteria and to docs
    prior.md        round records, review reports and plan documents it can find;
                    with --skip-prior, a note that this window does not search

## The three results that are not failures

`MEASURED NOTHING` -- an instrument found no lines to attribute. It is never to
be relayed as health. A postmortem once published a credible 0.0% that was a
`git blame --no-color` ambiguous-option error, which is the same shape as gating
on a marker instead of a value.

`NO PRIOR RECORDS FOUND` -- no record was found, which is not the same as a
clean history and not the same as a fault. A first run in a repository will
always find none. A silent version of this once cost a review its entire prior
reconciliation. A window run with `--skip-prior` says `SKIPPED` instead: on a
run spanning repositories only the primary window searches, and "found none" from
the others would be relayed as a finding.

`NO COMMITS IN WINDOW` -- nothing landed in the window, or only bot noise. Valid
where the repository belongs for its specs or tests; otherwise the base may be
wrong. Every file is still written, prior records included, and the self-fix
instruments and the put-back list say `MEASURED NOTHING` once, for that reason.

## What it cannot see

Attribution here is deletion-based: a commit is a self-fix when it deletes or
edits a line the window itself wrote. A fix that supersedes by *adding* a guard
deletes nothing and scores zero, and that is the normal shape of a correctness
fix -- roughly a 40% undercount where it could be checked directly. Every rate
printed is therefore a floor. `--additions` lists the commits in the blind zone
so it is at least visible.

Three instruments are printed, not one, because they answer in different units
and are distorted in different directions. Never quote one as "the" rate.
"""

import argparse
import collections
import functools
import os
import re
import struct
import subprocess
import sys

CODE_EXT = {
    ".py", ".lua", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".go", ".rs",
    ".java", ".kt", ".cs", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp",
    ".m", ".mm", ".swift", ".scala", ".sh", ".sql", ".vue", ".svelte",
}
DOC_EXT = {".md", ".rst", ".txt", ".adoc"}
SPECISH = re.compile(
    r"(spec|requirement|acceptance|criteri|plan|design|rfc|adr|ticket|story)",
    re.I)
BOTISH = re.compile(r"^(Translated using Weblate|Merge |Bump |chore\(deps\)|"
                    r"\[bot\]|Update .* to v)", re.I)
PRIOR_GLOBS = ("round-", "review", "postmortem", "handoff", "audit", "findings")
# A run directory: `<date>-<slug>` in a records directory somebody named -- the defaults under a
# repository's `triage/` and `plan/`, or a destination this project's CLAUDE.md chose for either
# skill -- and `triage-<date>-<slug>` or `plan-<date>-<slug>` where nobody named it, which is only
# the current directory of a Claude Artifact run outside git. **The declaration is the discriminator, not the directory's name.**
# The caller says which with --records-undeclared, because a name cannot carry it once a project
# can choose the name: `~/notes/triage/` holding a meeting folder `2026-01-15-meeting/plan.md` is
# the case the prefix rule exists for, and it is
# undeclared, not badly named.
RUN_DIR = re.compile(r"^\d{4}-\d{2}-\d{2}-")
RUN_DIR_OUTSIDE_GIT = re.compile(r"^(triage|plan)-\d{4}-\d{2}-\d{2}-")
# The owner's words and the deliverables. The readings (findings.md, sort-a/b, arbitration.md,
# lens-*) are left out.
RUN_FILES = ("sort.md", "owner.md", "owner-late.md", "plan.md", "deposition.md")
SPEC_ROWS = 40   # per --spec path; past this the listing hands over to `git log -p`
# Shorter lines (`return x`, `}`) recur without anything being undone. Measured on the
# field windows: 20 keeps a real rule reversal and cuts a large refactor's noise.
PUT_BACK_MIN = 20
PUT_BACK_ROWS = 10
PUNCTUATION = re.compile(r"^[\W_]*$")


def git(repo, *args, check=True):
    # utf-8 explicitly: the locale default on Windows is cp1252.
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        sys.exit("git %s failed: %s" % (" ".join(args[:3]), p.stderr.strip()))
    return p.stdout


def is_code(path):
    return os.path.splitext(path)[1].lower() in CODE_EXT


def commits_in(repo, base, head):
    """Non-merge commits in the window, oldest first."""
    fmt = "%H\x1f%an\x1f%aI\x1f%s"
    out = git(repo, "log", "--no-merges", "--reverse", "--format=" + fmt,
              "%s..%s" % (base, head))
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        sha, author, date, subject = line.split("\x1f", 3)
        rows.append(dict(sha=sha, author=author, date=date, subject=subject))
    return rows


@functools.lru_cache(maxsize=None)
def numstat(repo, sha):
    out = git(repo, "show", "--numstat", "--format=", sha)
    files = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        add, dele, path = parts
        files.append((path, 0 if add == "-" else int(add),
                      0 if dele == "-" else int(dele)))
    return files


@functools.lru_cache(maxsize=None)
def name_status(repo, sha):
    """{path: status letter} for one commit: A added, M modified, D deleted."""
    status = {}
    for line in git(repo, "show", "--name-status", "--format=", sha).splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            status[parts[-1]] = parts[0][:1]
    return status


def first_changed_lines(repo, sha, path):
    """The first non-blank line this commit removed from `path`, and the first it added."""
    gone = came = ""
    in_hunk = False
    for line in git(repo, "show", "-U0", "--format=", sha, "--", path,
                    check=False).splitlines():
        if line.startswith("@@"):
            in_hunk = True
            continue
        if not in_hunk:
            continue
        text = line[1:].strip()
        if line.startswith("-") and text and not gone:
            gone = text
        elif line.startswith("+") and text and not came:
            came = text
        if gone and came:
            break
    return gone, came


def excerpt(gone, came, width=100):
    """Both lines cut to `width`, starting just before where they differ: a table row
    whose change sits past its first hundred characters otherwise prints twice
    identically."""
    k = 0
    while k < min(len(gone), len(came)) and gone[k] == came[k]:
        k += 1
    if k > 40:
        gone, came = "..." + gone[k - 20:], "..." + came[k - 20:]
    return gone[:width], came[:width]


def deleted_ranges(repo, sha, path):
    """Line ranges in the PARENT that this commit deleted or modified."""
    out = git(repo, "show", "-U0", "--format=", "-w", sha, "--", path,
              check=False)
    ranges = []
    for line in out.splitlines():
        if not line.startswith("@@"):
            continue
        m = re.match(r"@@ -(\d+)(?:,(\d+))? ", line)
        if not m:
            continue
        start = int(m.group(1))
        count = 1 if m.group(2) is None else int(m.group(2))
        if count:
            ranges.append((start, start + count - 1))
    return ranges


def blame_shas(repo, parent, path, ranges):
    """Which commits wrote the lines this commit removed."""
    shas = []
    for start, end in ranges:
        # -w: a whitespace or line-ending renormalisation inside the window
        # otherwise steals blame for old content and manufactures self-fixes.
        out = git(repo, "blame", "-w", "--porcelain",
                  "-L", "%d,%d" % (start, end), parent, "--", path,
                  check=False)
        for line in out.splitlines():
            m = re.match(r"^([0-9a-f]{40}) \d+ \d+", line)
            if m:
                shas.append(m.group(1))
    return shas


def classify(repo, rows, window):
    """Tag each commit with what it was built on. Deletion-based, so a floor."""
    for r in rows:
        parent = r["sha"] + "^"
        blamed = []
        touched_existing = False
        for path, _add, dele in numstat(repo, r["sha"]):
            if not is_code(path) or dele == 0:
                continue
            ranges = deleted_ranges(repo, r["sha"], path)
            if not ranges:
                continue
            touched_existing = True
            blamed += blame_shas(repo, parent, path, ranges)
        r["blamed_total"] = len(blamed)
        r["blamed_in_window"] = sum(1 for s in blamed if s in window)
        r["touched_existing"] = touched_existing
        r["self_any"] = touched_existing and r["blamed_in_window"] > 0
        r["self_majority"] = (touched_existing and
                              r["blamed_in_window"] * 2 > len(blamed) > 0)
        # distinct commits, not lines: one commit repairing another counts once,
        # or a single large rewrite outranks ten separate repairs.
        r["generators"] = {s for s in blamed if s in window}
    return rows


def changed_lines(repo, sha):
    """{path: (added, removed)} for one commit, each a list of whitespace-normalised
    lines long enough to mean something on their own."""
    out, cur = {}, None
    for line in git(repo, "show", "-U0", "--format=", "--no-renames", sha).splitlines():
        if line.startswith("diff --git"):
            cur = out.setdefault(line.split(" b/", 1)[-1], ([], []))
        elif cur is not None and line[:1] in "+-" and not line.startswith(("+++ ", "--- ")):
            text = " ".join(line[1:].split())
            if len(text) >= PUT_BACK_MIN and not PUNCTUATION.match(text):
                cur[0 if line[0] == "+" else 1].append(text)
    return out


@functools.lru_cache(maxsize=None)
def line_counts(repo, rev, path):
    return collections.Counter(" ".join(l.split()) for l in
                               git(repo, "show", "%s:%s" % (rev, path), check=False).splitlines())


def skill_own(repo, records, run_dir):
    # `records` is the list from record_dirs(): every declared store and both defaults.
    """Repo-relative prefixes holding this skill's own record, which the pack does not measure.

    A record committed in the working tree is inside the window by construction (`diagnose.md`
    D6 concedes it), so without this the run's own `sort.md`, `owner.md` and `plan.md` are read
    as the artifact's documentation. The whole declared store is excluded, not just this run:
    prior rounds' records are tracked too under an override. The report is not here because it
    is never committed. Returns nothing for a record under `.git/`, which git does not report.
    """
    out = []
    for d in list(records or []) + [run_dir]:
        if not d:
            continue
        rel = os.path.relpath(os.path.abspath(d), os.path.abspath(repo))
        if rel != os.pardir and not rel.startswith(os.pardir + os.sep):
            out.append(rel.replace(os.sep, "/").rstrip("/") + "/")
    return out


def is_skill_own(path, own):
    return any(path.startswith(p) for p in own)


def put_back(repo, rows, own=()):
    """{path: Counter((taking-out row, putting-back row) -> lines)}. Counted per file, so
    one of two identical assertions restored still shows, while a line moved inside one
    commit nets to nothing."""
    removed = collections.defaultdict(dict)   # path -> line -> (row, count before removal)
    pairs = collections.defaultdict(collections.Counter)
    for i, r in enumerate(rows):
        for path, (added, gone) in changed_lines(repo, r["sha"]).items():
            if os.path.splitext(path)[1].lower() not in CODE_EXT | DOC_EXT:
                continue
            if is_skill_own(path, own):
                continue
            net = collections.Counter(added)
            net.subtract(gone)
            back = [l for l, n in net.items()
                    if n > 0 and l in removed[path] and removed[path][l][0] != i]
            out = [l for l, n in net.items() if n < 0]
            before = line_counts(repo, r["sha"] + "^", path) if back or out else None
            for l in back:
                j, had = removed[path][l]
                if before[l] < had:
                    pairs[path][(j, i)] += 1
            for l in out:
                removed[path][l] = (i, before[l])
    return pairs


def pct(n, d):
    return "n/a" if not d else "%.1f%%" % (100.0 * n / d)


def write(path, text):
    # Without an encoding, Windows writes cp1252 and every em-dash becomes a
    # byte the triager's utf-8 read shows as a replacement character.
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def project_slug(path):
    """The directory name Claude Code gives a session started in `path`, under
    `~/.claude/projects/`, as 2.1.x computes it: every UTF-16 unit outside
    [A-Za-z0-9] becomes '-', and a name over 200 characters is cut and
    suffixed with a base-36 hash of the path. Replacing only '/' misses '.',
    '_' and every Windows path, and a missed directory is skipped silently."""
    raw = path.encode("utf-16-le", "surrogatepass")
    units = struct.unpack("<%dH" % (len(raw) // 2), raw)
    slug = "".join(chr(c) if chr(c).isascii() and chr(c).isalnum() else "-"
                   for c in units)
    if len(slug) <= 200:
        return slug
    h = 0
    for c in units:                       # JS: h = (h << 5) - h + c | 0
        h = (h * 31 + c) & 0xFFFFFFFF
    h = abs(h - (1 << 32) if h >= 1 << 31 else h)
    digits, b36 = "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while True:
        h, rem = divmod(h, 36)
        b36 = digits[rem] + b36
        if not h:
            break
    return "%s-%s" % (slug[:200], b36)


def project_dirs(paths):
    """The Claude Code project directories of sessions started in each path."""
    base = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    return [os.path.join(base, project_slug(os.path.normpath(p))) for p in paths]


def record_dirs(records, reports):
    """Every directory that may hold this project's run directories, most specific first.

    `records` is every declared store: triage-review's, and ez-plan's where a CLAUDE.md names one.
    A plan holds the owner's intent, so a later diagnosis that missed ez-plan's store would read a
    ruling as an assumption (references/shared.md K5).

    Both the overrides and the defaults, because a project that moves the destination cannot
    migrate its existing runs in the same act -- the CLAUDE.md line lands in a pull request and
    the old runs are still in the common dir behind it. Searching only the
    declared one would report no history, which is the failure this whole rule exists to stop.
    Deduplicated by realpath, so the ordinary case searches once.
    """
    if isinstance(records, str):
        records = [records]
    out = []
    for d in list(records or []) + default_records(reports):
        if not d:
            continue
        real = os.path.realpath(d)
        if real not in [os.path.realpath(x) for x in out]:
            out.append(os.path.abspath(d))
    return out


def default_records(reports):
    """Where both skills put runs when nobody names a destination: the primary's common dir."""
    if not reports:
        return []
    common = git(reports, "rev-parse", "--git-common-dir", check=False).strip()
    if not common:
        return []
    if not os.path.isabs(common):
        common = os.path.join(os.path.abspath(reports), common)
    return [os.path.join(common, "triage"), os.path.join(common, "plan")]


def prior_records(records, reports, run_dir, undeclared=False):
    """Write prior.md; return the files it lists.

    The older roots come from `reports`, never the window's repository: on a Claude Artifact run
    that is the replay, where neither exists.
    """
    reports = os.path.abspath(reports)
    common = git(reports, "rev-parse", "--git-common-dir", check=False).strip()
    if common and not os.path.isabs(common):
        common = os.path.join(reports, common)
    postmortems = os.path.join(reports, "docs", "postmortems")

    def roots_for(path, c):
        heads = [path]
        c = c and os.path.normpath(c)
        if c and os.path.basename(c) == ".git" and os.path.dirname(c) != path:
            heads.append(os.path.dirname(c))      # the main worktree of a linked one
        return (([os.path.join(c, "review")] if c else []) + [os.path.join(reports, "docs")]
                + [os.path.join(d, "artifacts") for d in project_dirs(heads)])

    groups = [("this repository", roots_for(reports, common))]

    found, body, searched = [], [], []
    run_dir_re = RUN_DIR_OUTSIDE_GIT if undeclared else RUN_DIR
    current = os.path.realpath(run_dir)
    hits = []
    for records in record_dirs(records, None if undeclared else reports):
        searched.append("- earlier runs: `%s`%s" % (records, "" if os.path.isdir(records)
                                                     else "  (does not exist)"))
        if not os.path.isdir(records):
            continue
        for name in sorted(os.listdir(records)):
            run = os.path.join(records, name)
            if not run_dir_re.match(name) or not os.path.isdir(run):
                continue
            # On a spanned run the pack writes into RECORD/<label>, inside the current run.
            real = os.path.realpath(run)
            if current == real or current.startswith(real + os.sep):
                continue
            for f in RUN_FILES:
                full = os.path.join(run, f)
                if os.path.isfile(full):
                    hits.append((os.path.getmtime(full), full))
    hits.sort(reverse=True)
    found += hits
    if hits:
        body += ["## From earlier runs", ""] + ["- `%s`" % full for _m, full in hits] + [""]

    # Reports are few and each is a whole earlier diagnosis: never capped.
    hits = []
    searched.append("- earlier reports: `%s`" % os.path.join(reports, "POSTMORTEM-*.md"))
    searched.append("- earlier reports: `%s`%s" % (os.path.join(postmortems, "*.md"), ""
                                                   if os.path.isdir(postmortems)
                                                   else "  (does not exist)"))
    for folder, is_report in ((reports, lambda f: f.startswith("POSTMORTEM-")),
                              (postmortems, lambda f: True)):
        if not os.path.isdir(folder):
            continue
        for f in os.listdir(folder):
            full = os.path.join(folder, f)
            if is_report(f) and f.endswith(".md") and os.path.isfile(full):
                hits.append((os.path.getmtime(full), full))
    hits.sort(reverse=True)
    found += hits
    if hits:
        body += ["## Earlier reports", ""] + ["- `%s`" % full for _m, full in hits] + [""]

    for label, roots in groups:
        hits = []
        for root in roots:
            # Every root is listed, missing ones marked: a wrong search root is
            # otherwise indistinguishable from an empty one.
            searched.append("- %s: `%s`%s" % (label, root, "" if os.path.isdir(root)
                                               else "  (does not exist)"))
            if not os.path.isdir(root):
                continue
            for dirpath, dirs, files in os.walk(root):
                if os.path.join(dirpath, "postmortems") == postmortems:
                    dirs[:] = [d for d in dirs if d != "postmortems"]   # listed above, uncapped
                for f in files:
                    low = f.lower()
                    if not low.endswith((".md", ".json")):
                        continue
                    if any(g in low or g in dirpath.lower() for g in PRIOR_GLOBS):
                        full = os.path.join(dirpath, f)
                        hits.append((os.path.getmtime(full), full))
        hits.sort(reverse=True)
        found += hits
        if hits:
            body += ["## From %s" % label, ""] + ["- `%s`" % full for _m, full in hits[:40]] + [""]
    v = ["# Prior records", ""]
    if not found:
        v += ["**NO PRIOR RECORDS FOUND.**", "",
              "Searched:", ""] + searched + [
              "", "This is not the same as a clean history, and it is not a "
              "fault: a first run here will always find none. What it does mean "
              "is that any account of earlier rounds is the deposition's memory "
              "and nothing else. Report it as that, and do not let it price "
              "revert against keep.", ""]
    else:
        v += ["Most recently modified first, per source. These are the accounts earlier "
              "rounds wrote of themselves: read them as claims.", ""] + body
        v += ["Searched:", ""] + searched + [""]
    write(os.path.join(run_dir, "evidence", "prior.md"), "\n".join(v))
    return found


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--run-dir", required=True)
    ap.add_argument("--since", required=True, help="the last-known-good ref")
    ap.add_argument("--until", default="HEAD")
    ap.add_argument("--spec", action="append", default=[],
                    help="a path holding the criterion this work is judged by")
    ap.add_argument("--records", action="append", default=[],
                    help="a directory holding run directories -- RECORD's parent, wherever "
                         "references/shared.md K1 puts it: a repository's triage/, a destination "
                         "this project's CLAUDE.md named for either skill, or the current "
                         "directory outside git. Repeat it for ez-plan's store where a CLAUDE.md "
                         "names one; both default locations are derived from --reports and "
                         "searched as well, so an override does not lose the runs behind it")
    ap.add_argument("--records-undeclared", action="store_true",
                    help="nobody named --records; it is the current directory of a Claude "
                         "Artifact run outside git, so only triage-<date>-<slug> or "
                         "plan-<date>-<slug> counts as a "
                         "run inside it. Omit it wherever the directory was named, which is "
                         "every run in a git repository")
    ap.add_argument("--reports",
                    help="the working tree the report is written into, or the current "
                         "directory outside git; the older roots (review/, the session "
                         "artifacts/) are searched from here, never from --repo")
    ap.add_argument("--skip-prior", action="store_true",
                    help="a window other than the primary one on a run spanning repositories: "
                         "search no prior records, and say so")
    ap.add_argument("--additions", action="store_true",
                    help="also list the commits attribution is blind to")
    args = ap.parse_args(argv)
    if not args.skip_prior and not (args.records and args.reports):
        ap.error("--records and --reports are required unless --skip-prior")

    repo = os.path.abspath(args.repo)
    if git(repo, "rev-parse", "--is-inside-work-tree", check=False).strip() != "true":
        hint = ""
        if git(repo, "rev-parse", "--is-bare-repository", check=False).strip() == "true":
            wt = [l.split()[0] for l in
                  git(repo, "worktree", "list", check=False).splitlines()
                  if "(bare)" not in l]
            hint = ("\nThis is a BARE repository. Point --repo at a worktree"
                    + (": " + ", ".join(wt) if wt else
                       "; `git worktree list` shows none, so add one first."))
        sys.exit("no work tree at %s%s" % (repo, hint))
    out_dir = os.path.join(args.run_dir, "evidence")
    os.makedirs(out_dir, exist_ok=True)

    base = git(repo, "rev-parse", args.since).strip()
    head = git(repo, "rev-parse", args.until).strip()
    rows = commits_in(repo, base, head)
    window = {r["sha"] for r in rows}
    bot = [r for r in rows if BOTISH.match(r["subject"])]
    rows = [r for r in rows if not BOTISH.match(r["subject"])]

    summary = []
    summary.append("window     : %s..%s" % (base[:12], head[:12]))
    # An empty window is valid: every file below
    # is still written, prior.md included.
    no_commits = "NO COMMITS IN WINDOW%s -- valid where this repository belongs for its specs " \
                 "or tests; otherwise the base may be wrong" % (
                     " (%d excluded as bot/noise)" % len(bot) if bot else "")
    nothing = "MEASURED NOTHING -- no commits in the window"
    if rows:
        summary.append("commits    : %d non-merge (%d excluded as bot/noise)"
                       % (len(rows), len(bot)))
    else:
        summary.append("commits    : " + no_commits)

    classify(repo, rows, window)

    # ---- commits.md
    lines = ["# Commits in the window", "",
             "`%s..%s`, oldest first. `self` is deletion-based and is a floor: a "
             "fix that only ADDS a guard scores nothing here." % (base[:12], head[:12]),
             "", "| # | sha | date | self | blamed in-window / total | subject |",
             "|---|-----|------|------|--------------------------|---------|"]
    for i, r in enumerate(rows, 1):
        # majority implies any, so test the stronger one first or it never shows.
        mark = "maj" if r["self_majority"] else ("yes" if r["self_any"] else "")
        lines.append("| %d | `%s` | %s | %s | %d / %d | %s |" % (
            i, r["sha"][:12], r["date"][:10], mark,
            r["blamed_in_window"], r["blamed_total"], r["subject"][:80]))
    if not rows:
        lines = lines[:2] + ["`%s..%s`: **%s.**" % (base[:12], head[:12], no_commits)]
    write(os.path.join(out_dir, "commits.md"), "\n".join(lines) + "\n")

    # ---- selffix.md
    modifying = [r for r in rows if r["touched_existing"]]
    any_n = sum(1 for r in modifying if r["self_any"])
    maj_n = sum(1 for r in modifying if r["self_majority"])
    blind = [r for r in rows if not r["touched_existing"]]
    total_blamed = sum(r["blamed_total"] for r in rows)

    by_day = collections.OrderedDict()
    for r in modifying:
        d = r["date"][:10]
        slot = by_day.setdefault(d, [0, 0])
        slot[0] += 1
        slot[1] += 1 if r["self_any"] else 0

    s = ["# How much of this window repairs this window", ""]
    if total_blamed == 0:
        s += ["**MEASURED NOTHING.** No line in this window was attributed to any "
              "commit: every commit is purely additive, or attribution failed.",
              "This is not a clean result and must not be reported as health. "
              "Check by hand:", "",
              "    git -C \"%s\" log --numstat --no-merges %s..%s | head -40"
              % (repo, base[:12], head[:12]), ""]
    # A percentage over a handful of code commits gets quoted without its
    # denominator. Below a floor, say what the window is made of instead: a window
    # that is mostly prose is not a window with a low repair rate, it is one this
    # instrument cannot speak about.
    docsy = sum(1 for r in rows if not r["touched_existing"]
                and not any(is_code(p2) for p2, _a, _d in numstat(repo, r["sha"])))
    thin = len(modifying) < 5 or len(modifying) * 5 < len(rows) * 2
    if thin:
        s += ["**NO RATE REPORTED.** Only %d of %d commits modify existing code, "
              "too small a share to carry a percentage." % (len(modifying), len(rows)),
              "", "| commits | kind |", "|---|---|",
              "| %d | modify existing code, and can be attributed |" % len(modifying),
              "| %d | add code without changing any: attribution is blind to these |"
              % (len(rows) - len(modifying) - docsy),
              "| %d | touch no code file at all: docs, spec, config |" % docsy,
              "| %d | total, merges and bots already excluded |" % len(rows), "",
              "Report the composition, not a rate. The two say different things and "
              "only one of them is measured here.", ""]

    if not thin:
        s += ["Three instruments, three units. Never quote one as *the* rate.", "",
              "| instrument | unit | figure |",
              "|---|---|---|",
              "| A | commits that modify existing code and touch a line this window "
              "wrote | %d / %d = %s |" % (any_n, len(modifying), pct(any_n, len(modifying))),
              "| B | the same, but a majority of the blamed lines are in-window | "
              "%d / %d = %s |" % (maj_n, len(modifying), pct(maj_n, len(modifying))),
              "| A' | the same as A, over every commit in the window | %d / %d = %s |"
              % (any_n, len(rows), pct(any_n, len(rows))),
              "",
              "**Blind zone:** %d commit(s) deleted no code line at all, so attribution "
              "scores them zero whatever they did. Adding a guard is the normal shape "
              "of a correctness fix, so the figures above are a floor." % len(blind), ""]

    if by_day:
        s += ["## By day", "",
              "This is a workload description, not a trigger or a diagnosis. It "
              "cannot tell staged refactoring from repair, a coherent migration "
              "from churn, or a missing concept from a fast hand -- and it cannot "
              "see an additive fix at all. No direction of it is health.",
              "", "| date | commits touching existing code | self-fixes | rate |",
              "|---|---|---|---|"]
        for d, (n, sf) in by_day.items():
            s.append("| %s | %d | %d | %s |" % (d, n, sf, pct(sf, n)))
        s.append("")
        days = list(by_day)
        # Two days and seven commits is not a trend, and a trend sentence on a
        # page gets quoted as one. Five days or nothing.
        if len(days) >= 5:
            first = by_day[days[0]]
            last3 = [by_day[d] for d in days[-3:]]
            ln, lsf = sum(x[0] for x in last3), sum(x[1] for x in last3)
            s += ["Opening day %s, trailing three days %s."
                  % (pct(first[1], first[0]), pct(lsf, ln)), ""]

    gens = collections.Counter()
    for r in rows:
        gens.update(r["generators"])          # a set: +1 per later commit
    if gens:
        subj = {r["sha"]: r["subject"] for r in rows}
        s += ["## Most repaired by later commits in the same window", "",
              "| later fixes | sha | subject |", "|---|---|---|"]
        # Ties in window order: iterating the per-commit sets is not stable
        # between runs, so most_common() reorders equal counts.
        order = {r["sha"]: i for i, r in enumerate(rows)}
        for sha, n in sorted(gens.items(), key=lambda kv: (-kv[1], order.get(kv[0], 0)))[:10]:
            s.append("| %d | `%s` | %s |" % (n, sha[:12], subj.get(sha, "?")[:80]))
        s += ["", "A repair commit appearing here is the pattern naming itself: a "
              "cross-cutting repair is not automatically the safer choice, it is a "
              "bigger guess and it fails wider.", ""]

    own = skill_own(repo, record_dirs(args.records, args.reports) if args.records else [],
                    args.run_dir)
    back = put_back(repo, rows, own)
    s += ["## Lines taken out and later put back", "",
          "A line one commit removed from a code or doc file and a later, different commit "
          "put back (lines of %d characters or more). Churn that undoes itself is a place to "
          "read: a behaviour decided one way and then the other, or a revert. It is where to "
          "look, not a measure of anything." % PUT_BACK_MIN, ""]
    if not back:
        s += ["None found.", ""]
    else:
        ranked = sorted(back.items(), key=lambda kv: (-sum(kv[1].values()), kv[0]))
        s += ["| file | taken out by | put back by | lines |", "|---|---|---|---|"]
        for path, c in ranked[:PUT_BACK_ROWS]:
            (j, i), _n = c.most_common(1)[0]
            more = " (+%d more pairs)" % (len(c) - 1) if len(c) > 1 else ""
            s.append("| `%s` | `%s` %s | `%s` %s | %d%s |" % (
                path, rows[j]["sha"][:12], rows[j]["subject"][:40].replace("|", "/"),
                rows[i]["sha"][:12], rows[i]["subject"][:40].replace("|", "/"),
                sum(c.values()), more))
        if len(ranked) > PUT_BACK_ROWS:
            s += ["", "%d more file(s)." % (len(ranked) - PUT_BACK_ROWS)]
        s.append("")

    if args.additions and blind:
        s += ["## The blind zone, listed", ""]
        for r in blind:
            s.append("- `%s` %s" % (r["sha"][:12], r["subject"][:90]))
        s.append("")
    if not rows:
        s = s[:2] + ["**%s.** Neither the self-fix instruments nor the put-back list had "
                     "anything to read." % nothing, ""]
    write(os.path.join(out_dir, "selffix.md"), "\n".join(s))

    # ---- surface.md: what the window did to the named criteria and to docs
    churn = collections.Counter()
    edits = collections.Counter()
    for r in rows:
        for path, add, dele in numstat(repo, r["sha"]):
            if is_skill_own(path, own):
                continue
            if os.path.splitext(path)[1].lower() in DOC_EXT or SPECISH.search(path):
                churn[path] += add + dele
                edits[path] += 1
    u = ["# What the window did to the named criteria and to docs", ""]
    named = [p.rstrip("/") for p in args.spec]
    touches_code = [any(is_code(p3) for p3, _a, _d in numstat(repo, r["sha"])) for r in rows]

    def under(path, p):
        # --spec may name a directory
        return path == p or path.startswith(p + "/")

    if named:
        u += ["## The criteria named at launch, and the commits that changed them", "",
              "Listed, not judged. A rule edited, or a new rule added, while the rounds were "
              "judging against it is where contract drift shows. Whether a change conflicts "
              "with another rule, or with what the code already does, is for whoever reads "
              "it: a round log appended to by the work it describes looks the same here as "
              "a rulebook gaining rules nobody ratified. `code commits before it` counts the "
              "earlier commits in this window that touched a code file.", ""]
        for p in named:
            items = []
            for i, r in enumerate(rows):
                here = [(path, a, d) for path, a, d in numstat(repo, r["sha"]) if under(path, p)]
                if not here:
                    continue
                status = name_status(repo, r["sha"])
                tail = " · code commits before it: %d · %s" % (sum(touches_code[:i]),
                                                               r["subject"][:70])
                lead = "- `%s` %s · " % (r["sha"][:12], r["date"][:10])
                # A commit that creates several files is one row, or a cluster
                # written before any code fills the listing with its own birth.
                new = [(path, a) for path, a, _d in here if status.get(path) == "A"]
                if new:
                    items.append([lead + "created " + ", ".join(
                        "`%s` +%d" % n for n in new[:5])
                        + (" and %d more" % (len(new) - 5) if len(new) > 5 else "") + tail])
                for path, a, d in here:
                    if status.get(path) == "A":
                        continue
                    kind = ("deleted" if status.get(path) == "D"
                            else "replaced text" if d else "added text")
                    item = [lead + "`%s` %s, +%d -%d" % (path, kind, a, d) + tail]
                    if kind != "deleted":
                        gone, came = excerpt(*first_changed_lines(repo, r["sha"], path))
                        if kind == "replaced text":
                            item.append("      - %s" % gone)
                        item.append("      + %s" % (came or "(nothing added)"))
                    items.append(item)
            u += ["### `%s`" % p, ""]
            if not items:
                u += ["Not changed inside the window.", ""]
                continue
            for item in items[:SPEC_ROWS]:
                u += item
            if len(items) > SPEC_ROWS:
                u.append("- ... %d more: `git -C \"%s\" log -p %s..%s -- %s`"
                         % (len(items) - SPEC_ROWS, repo, base[:12], head[:12], p))
            u.append("")
    else:
        u += ["## No criterion was named at launch", "",
              "Nothing was passed with `--spec`. Either the work has no stated "
              "acceptance criterion, or nobody in this session knew where it is. "
              "Both are findings; they are different findings.", ""]
    if churn:
        u += ["## Spec-ish and doc files the window touched", "",
              "| edits | lines | path |", "|---|---|---|"]
        for p, c in churn.most_common(20):
            u.append("| %d | %d | `%s` |" % (edits[p], c, p))
        u.append("")
    write(os.path.join(out_dir, "surface.md"), "\n".join(u))

    # ---- prior.md: round records and reports that already exist
    found = []
    if args.skip_prior:
        write(os.path.join(out_dir, "prior.md"), "\n".join([
            "# Prior records", "",
            "**SKIPPED.** This window is not the primary one on a run spanning repositories. "
            "Earlier runs and reports live only in the primary repository, and its window's "
            "pack lists them; this repository's own `review/` and `docs/` notes are not "
            "searched. Nothing here says whether any exist.", ""]))
    else:
        found = prior_records(args.records, args.reports, args.run_dir,
                              args.records_undeclared)

    summary += [
        ("self-fix   : " + nothing) if not rows else
        ("self-fix   : NO RATE -- only %d of %d commits modify code"
         % (len(modifying), len(rows))) if thin else
        ("self-fix   : A %s of %d modifying commits, B %s  (floor; %d blind)"
         % (pct(any_n, len(modifying)), len(modifying), pct(maj_n, len(modifying)),
            len(blind))),
        ("attributed : " + nothing) if not rows else
        "attributed : %d lines%s" % (total_blamed,
                                     "  <-- MEASURED NOTHING" if total_blamed == 0 else ""),
        ("put back   : " + nothing) if not rows else "put back   : %d file(s)" % len(back),
        "prior      : %s" % ("SKIPPED -- not the primary window" if args.skip_prior
                             else "NO PRIOR RECORDS FOUND" if not found
                             else "%d files" % len(found)),
        "spec       : %s" % (", ".join(named) if named else "none named at launch"),
        "written to : %s" % out_dir,
    ]
    write(os.path.join(out_dir, "summary.md"),
          "# Evidence pack summary\n\n```\n" + "\n".join(summary) + "\n```\n")
    print("\n".join(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
