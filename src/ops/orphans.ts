import { type Annotation } from "../schema.js";
import { indexCommit } from "../repo.js";
import { revParse } from "../git.js";
import { citedAnchors } from "../shared-bugs.js";
import { readAnchorStore, readBugs, readAnnotations, readFindings, readReviews, findAnchorsOutsideWork, readOrphans } from "../store.js";

/**
 * What is pointing at code the working tree no longer has — "what did that refactor
 * break?", which there was previously no way to ask.
 *
 * Four outcomes, and the difference is the whole point of asking:
 *   `offTree`   the symbol exists in a cached commit snapshot — a PR branch, most
 *               likely. Nothing is lost; the tree is just on a different branch.
 *   `retained`  gone from the tree and from every snapshot, but its last known
 *               state was kept because work pointed at it. Readable, re-anchorable.
 *   `located`   no copy here, but the record's OWN commit still produces the id, so
 *               this build read that commit and can say what the id named. Only
 *               with `locate` — see below.
 *   `lost`      no copy here, and nothing to ask or nothing found when asked.
 *
 * **`lost` used to mean "no record anywhere", which it never did.** It was raw id
 * membership in two local tables, presented as a claim about the CODE — the same
 * shape `resolveAnchor` exists to stop. A record usually carries its own address
 * (an annotation's `sourceRef`, a bug's `createdCommit`, a review's
 * `reviewedCommit`), and indexing that commit answers what the id named.
 *
 * That answer costs an index of a whole commit, so it is an ACT rather than a page
 * load: without `locate` this reports how many records could be asked about and how
 * many commits that would open, and asserts nothing it has not checked.
 */
export async function orphanedWork(root: string, opts: { locate?: boolean; maxCommits?: number } = {}) {
  const [annStore, bugStore, reviewStore, store] = await Promise.all([
    readAnnotations(root), readBugs(root), readReviews(root), readAnchorStore(root),
  ]);
  const live = new Set(store.anchors.map((a) => a.id));

  // The record's own address, when it has one. `@work` and `@orphan` are not
  // commits, so they are no address at all — `whereWere` says so rather than
  // answering a question nobody asked.
  const addressOf = (v: string | null | undefined): string | undefined =>
    v && v !== "@work" && v !== "@orphan" ? v : undefined;

  const refs: { id: string; kind: "annotation" | "bug" | "review" | "finding"; ref: string; label: string; posted?: Annotation["postedRef"]; sourceRef?: string }[] = [];
  for (const a of annStore.annotations) {
    if (a.target.kind !== "anchor" || live.has(a.target.id)) continue;
    refs.push({
      id: a.target.id, kind: "annotation", ref: a.id,
      label: (a.comment || a.text || "").split("\n")[0]?.slice(0, 120) ?? "",
      ...(a.postedRef ? { posted: a.postedRef } : {}),
      // `sourceRef` is the ref the anchor was RESOLVED and witnessed at, which is
      // the address; `createdCommit` is only ever the tree's HEAD at filing time and
      // says nothing about what was read.
      ...(addressOf(a.sourceRef) ?? addressOf(a.createdCommit)
        ? { sourceRef: (addressOf(a.sourceRef) ?? addressOf(a.createdCommit))! } : {}),
    });
  }
  for (const b of bugStore.bugs) {
    for (const id of citedAnchors(b)) {
      if (live.has(id)) continue;
      refs.push({ id, kind: "bug", ref: b.id, label: b.title, ...(addressOf(b.createdCommit) ? { sourceRef: b.createdCommit! } : {}) });
    }
  }
  // Findings, since they are rows rather than annotations. Left out, a finding whose
  // symbol a refactor removed was invisible to the one report that exists to ask "what
  // did that break?" — and after the migration that is where most of them live.
  for (const f of (await readFindings(root)).findings) {
    if (f.target.kind !== "anchor" || live.has(f.target.id)) continue;
    refs.push({
      id: f.target.id, kind: "finding", ref: f.id,
      label: (f.comment || f.text).split("\n")[0]!.slice(0, 120),
      ...(f.posted ? { posted: { pr: 0, at: f.posted.at, placement: "inline" as const, ...(f.posted.url ? { url: f.posted.url } : {}) } } : {}),
      ...(addressOf(f.sourceRef) ? { sourceRef: f.sourceRef! } : {}),
    });
  }
  // Reviews too: a stranded sign-off is a lost attestation, and retention protects
  // them, so leaving them out of the sweep would report less than was kept.
  for (const r of reviewStore.reviews) {
    if (r.target.kind !== "anchor" || live.has(r.target.id)) continue;
    refs.push({
      id: r.target.id, kind: "review", ref: r.target.id,
      label: `${r.level} ${r.attestation ?? (r.actor === "agent" ? "checked" : "signed")} by ${r.reviewer || r.actor || "?"}`,
      ...(addressOf(r.reviewedCommit) ? { sourceRef: r.reviewedCommit! } : {}),
    });
  }
  const empty = {
    total: 0, offTree: [] as any[], retained: [] as any[], located: [] as any[], lost: [] as any[],
    byKind: {} as Record<string, OrphanCounts>,
    // Present-and-absent rather than missing, so the two return shapes are one type
    // and a reader does not have to narrow a union to ask what was not checked.
    locatable: undefined as undefined | { records: number; commits: number; notAsked?: number; cap?: number },
  };
  if (!refs.length) return empty;

  const ids = [...new Set(refs.map((r) => r.id))];
  const inSnapshots = findAnchorsOutsideWork(root, ids);
  const kept = readOrphans(root, ids);

  const where = (id: string) => {
    const s = inSnapshots.get(id);
    if (s) return { bucket: "offTree" as const, at: s.ref, anchor: s.anchor };
    const k = kept.get(id);
    if (k) return { bucket: "retained" as const, at: "@orphan", anchor: k };
    return { bucket: "lost" as const, at: null, anchor: null };
  };

  const out = {
    total: refs.length,
    offTree: [] as any[], retained: [] as any[], located: [] as any[], lost: [] as any[],
    /**
     * Counts per bucket per kind, because the buckets do not mean the same thing for
     * every kind. A stranded FINDING is work somebody did that is now unreachable. A
     * stranded historical `viewed` mark is the expected residue of importing years of
     * pull requests — code gets deleted and renamed, and those marks were true when
     * they were made. Reporting one total would bury six real losses under nine
     * hundred routine ones.
     */
    byKind: {} as Record<string, OrphanCounts>,
  };
  const strays: typeof refs = [];
  for (const r of refs) {
    const w = where(r.id);
    const row = {
      ...r, at: w.at,
      ...(w.anchor ? { file: w.anchor.file, symbol: w.anchor.symbolPath.join(" › "), line: w.anchor.loc?.startLine } : {}),
    };
    if (w.bucket === "lost") { strays.push(row); continue; }   // bucketed below
    out[w.bucket].push(row);
    (out.byKind[r.kind] ??= { offTree: 0, retained: 0, located: 0, lost: 0 })[w.bucket]++;
  }

  // Everything with no copy here. Grouped BY COMMIT because the expensive part is
  // reading a tree, and several records routinely share one address.
  const byCommit = new Map<string, typeof strays>();
  for (const r of strays) if (r.sourceRef) (byCommit.get(r.sourceRef) ?? byCommit.set(r.sourceRef, []).get(r.sourceRef)!).push(r);

  const cap = Math.max(0, Math.floor(opts.maxCommits ?? 25));
  const asking = opts.locate ? [...byCommit.keys()].slice(0, cap) : [];
  const answers = new Map<string, WhereWas>();
  for (const commit of asking) {
    const ids = [...new Set(byCommit.get(commit)!.map((r) => r.id))];
    for (const [id, w] of await whereWere(root, ids, commit).catch(() => new Map<string, WhereWas>())) {
      answers.set(`${commit}\0${id}`, w);
    }
  }

  for (const r of strays) {
    const w = r.sourceRef ? answers.get(`${r.sourceRef}\0${r.id}`) : undefined;
    const bucket = w?.at === "found" ? "located" as const : "lost" as const;
    out[bucket].push(w?.at === "found"
      ? { ...r, at: w.ref, file: w.file, symbol: w.symbol, line: w.startLine }
      // WHY it is lost, never a bare "lost". Not asked / asked and it was not there /
      // asked and this build mints that id for two symbols there are four different
      // situations, and only the first is fixable by asking again.
      : { ...r, why: !r.sourceRef ? "no address to ask" : !opts.locate ? "not asked — pass `locate`" : w?.at ?? "not asked — over the commit cap" });
    (out.byKind[r.kind] ??= { offTree: 0, retained: 0, located: 0, lost: 0 })[bucket]++;
  }

  // Only what the CAP refused. Not asking at all is a different thing, and reporting
  // it as `notAsked` beside a `cap` would read as "the limit stopped us" when
  // nothing was attempted — `records` and `commits` are what say the question is
  // available.
  const truncated = opts.locate ? byCommit.size - asking.length : 0;
  return {
    ...out,
    // What has NOT been checked, always, so a `lost` count is never read as a
    // finding. Silent truncation here would read as "we looked" when we did not.
    locatable: truncated || (!opts.locate && byCommit.size)
      ? {
        records: strays.filter((r) => r.sourceRef).length,
        commits: byCommit.size,
        ...(truncated ? { notAsked: truncated, cap } : {}),
      }
      : undefined,
  };
}

interface OrphanCounts { offTree: number; retained: number; located: number; lost: number }


/**
 * What an anchor id NAMED, at a commit that record points at.
 *
 * Step 1 of `docs/anchor-id-provenance.md` § Recovery, and the only half of it that
 * can ever be verified: the answer is an anchor THIS build minted, from source at
 * that commit, whose own id is the one being asked about. Nothing is trusted and
 * nothing is guessed.
 *
 * Indexed FRESH rather than read from a cached snapshot, and the difference is not
 * pedantry. A snapshot's rows may have been minted by another build; it is searched
 * across every ref and answers with the newest occurrence rather than the one at the
 * commit asked for; and it is keyed by id, so it has already collapsed any pair of
 * symbols that collide on one — which is exactly the case this must not answer.
 *
 * The four shapes are the point. `ambiguous` and `absent` are different answers and
 * so is having no commit to ask about, and a caller told only "no" cannot tell which
 * of the three it got.
 */
export type WhereWas =
  | { at: "found"; ref: string; file: string; symbol: string; symbolPath: string[]; disambiguator?: string; kind: string; startLine?: number }
  /** That commit, indexed by this build, does not produce the id. */
  | { at: "absent"; ref: string; indexed: number }
  /** This build mints that id for more than one symbol there — see `collidingAnchors`. */
  | { at: "ambiguous"; ref: string; candidates: { file: string; symbol: string }[] }
  /** No commit to ask about, or the repo cannot answer for one. */
  | { at: "unaddressed"; why: string };

export async function whereWas(root: string, anchorId: string, ref?: string): Promise<WhereWas> {
  return (await whereWere(root, [anchorId], ref)).get(anchorId)!;
}

/**
 * The same question for several ids at once, because the expensive part — indexing
 * the commit — is per COMMIT and not per id. Asking one at a time re-reads the whole
 * tree for each.
 */
export async function whereWere(root: string, anchorIds: string[], ref?: string): Promise<Map<string, WhereWas>> {
  const ids = [...new Set(anchorIds)];
  const all = (answer: WhereWas) => new Map(ids.map((id) => [id, answer]));

  const wanted = (ref ?? "").trim();
  // `@work` is the live index, not a commit — a record witnessed there recorded no
  // historical address at all, and saying "absent" about it would be an answer to a
  // question nobody asked.
  if (!wanted || wanted === "@work" || wanted === "@orphan") {
    return all({ at: "unaddressed", why: `no commit to ask about — the record names "${wanted || "nothing"}", which is not one` });
  }
  const sha = revParse(root, wanted);
  if (!sha) return all({ at: "unaddressed", why: `cannot resolve "${wanted}" in this repo — fetch it first?` });
  const anchors = await indexCommit(root, sha);
  if (!anchors) return all({ at: "unaddressed", why: `could not read the tree at ${sha.slice(0, 12)} — fetch it first?` });

  // Grouped, not found-first: an id this build mints for two symbols there is the
  // one answer that must never come back as a single confident location.
  const byId = new Map<string, typeof anchors>();
  for (const a of anchors) (byId.get(a.id) ?? byId.set(a.id, []).get(a.id)!).push(a);

  const out = new Map<string, WhereWas>();
  for (const id of ids) {
    const hits = byId.get(id) ?? [];
    if (!hits.length) { out.set(id, { at: "absent", ref: sha, indexed: anchors.length }); continue; }
    if (hits.length > 1) {
      out.set(id, { at: "ambiguous", ref: sha, candidates: hits.map((a) => ({ file: a.file, symbol: a.symbolPath.join(" › ") })) });
      continue;
    }
    const a = hits[0]!;
    out.set(id, {
      at: "found", ref: sha, file: a.file, symbol: a.symbolPath.join(" › "),
      symbolPath: a.symbolPath, ...(a.disambiguator !== undefined ? { disambiguator: a.disambiguator } : {}),
      kind: a.kind, ...(a.loc ? { startLine: a.loc.startLine } : {}),
    });
  }
  return out;
}

