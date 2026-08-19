/**
 * A line scanner for the spec markdown a pull request ships.
 *
 * Both readers of that markdown — `splitSpec`, which cuts it into sections, and
 * the promotion summariser, which pulls a sentence out of one — used to be
 * independent regexes with no memory of the document. Every failure was silent and
 * of the same shape: a line was read as something it was not, and the section it
 * belonged to either vanished or was invented.
 *
 *   - a `#` inside a `~~~` block became a heading, because only ``` counted;
 *   - an inner ``` inside an outer ```` closed the outer fence, so every heading
 *     after it was swallowed into one section;
 *   - a heading inside `<!-- ... -->` became a real chapter, and its identifiers
 *     were reported to the human as spec shipped without code — a gap report about
 *     text the author had deliberately deleted;
 *   - a spec written with setext underlines (`Title` over `====`) had no headings
 *     at all, so the file collapsed into a single section named after itself;
 *   - and the summariser dropped fence DELIMITERS while keeping fence CONTENTS, so
 *     a line of SQL could become a promoted node's summary, reported as having come
 *     from the spec.
 *
 * One pass, one state, and each line comes out labelled. Deliberately small: this
 * is not a markdown parser, it is the subset that decides "is this line a heading,
 * and is this line prose".
 */

export type MdLine =
  /** An ATX (`## x`) or setext (`x` over `===`) heading. */
  | { kind: "heading"; level: number; text: string; line: number }
  /** A fence delimiter, or a line inside a fence — never prose, never a heading. */
  | { kind: "code"; text: string; line: number }
  /** Inside an HTML comment, or the delimiters of one. */
  | { kind: "comment"; text: string; line: number }
  /** Anything else: the body of a section. */
  | { kind: "text"; text: string; line: number };

/** Up to three leading spaces still counts as column zero in markdown. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT = /^ {0,3}(=+|-{2,})\s*$/;

/**
 * Split on newlines, tolerating CRLF. A spec committed with CRLF leaves `\r` on
 * every line; an unanchored heading regex can never match `$` past it, which used
 * to miss EVERY heading in the file. Blobs come from `git cat-file`, so
 * `core.autocrlf` never masks this.
 */
export const mdLines = (text: string): string[] => text.replace(/\r\n?/g, "\n").split("\n");

export function scanMarkdown(text: string): MdLine[] {
  const raw = mdLines(text);
  const out: MdLine[] = [];
  // The fence that is currently open, by delimiter char and length: a fence closes
  // only on the SAME character, at least as long. That is what lets a ```` block
  // quote a ``` sample without the inner one closing the outer.
  let fence: { char: string; len: number } | null = null;
  let inComment = false;

  // YAML front matter is not a setext heading, and `---` on line one is the only
  // place it can start — but ONLY when it actually closes. A spec that opens with a
  // horizontal rule would otherwise have its entire body swallowed as front matter,
  // reported as a file with no claims at all.
  let i = 0;
  if (raw[0]?.trim() === "---") {
    const close = raw.findIndex((l, n) => n > 0 && l.trim() === "---");
    if (close > 0) {
      for (i = 0; i <= close; i++) out.push({ kind: "comment", text: raw[i]!, line: i + 1 });
    }
  }

  for (; i < raw.length; i++) {
    const line = raw[i]!;
    const at = i + 1;

    if (fence) {
      out.push({ kind: "code", text: line, line: at });
      const m = FENCE.exec(line);
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len) fence = null;
      continue;
    }
    if (inComment) {
      out.push({ kind: "comment", text: line, line: at });
      if (line.includes("-->")) inComment = false;
      continue;
    }

    const f = FENCE.exec(line);
    if (f) {
      fence = { char: f[1]![0]!, len: f[1]!.length };
      out.push({ kind: "code", text: line, line: at });
      continue;
    }
    // Only a line that OPENS with the delimiter starts a comment block. Testing for
    // `<!--` anywhere meant a prose line merely mentioning it — in inline code, in an
    // HTML snippet — swallowed every heading and every section after it to EOF, and
    // `splitSpec` then discarded all of them as text the author had deleted.
    const opensComment = /^\s{0,3}<!--/.test(line);
    if (opensComment && !line.includes("-->")) {
      inComment = true;
      out.push({ kind: "comment", text: line, line: at });
      continue;
    }
    if (opensComment) { out.push({ kind: "comment", text: line, line: at }); continue; }

    // A 4-space indented block is code too. Without this a SQL statement written
    // that way (rather than fenced) still reached the summariser and became a
    // promoted node's description, reported as having come from the spec — which is
    // the failure this module's docstring claims to have closed.
    const prevLine = out[out.length - 1];
    const afterBlankOrCode = !prevLine || (prevLine.kind === "code")
      || (prevLine.kind === "text" && !prevLine.text.trim());
    if (/^ {4,}\S/.test(line) && afterBlankOrCode) { out.push({ kind: "code", text: line, line: at }); continue; }

    const atx = ATX.exec(line);
    if (atx) { out.push({ kind: "heading", level: atx[1]!.length, text: atx[2]!.trim(), line: at }); continue; }

    // Setext: an underline promotes the PARAGRAPH LINE above it, which must be
    // ordinary text. `---` under nothing is a thematic break, not a heading.
    const se = SETEXT.exec(line);
    const prev = out[out.length - 1];
    // A list item under a rule is a list plus a thematic break, not a heading.
    const isListItem = prev?.kind === "text" && /^\s{0,3}([-*+]|\d+[.)])\s/.test(prev.text);
    if (se && prev && prev.kind === "text" && prev.text.trim() && !isListItem) {
      out[out.length - 1] = { kind: "heading", level: se[1]![0] === "=" ? 1 : 2, text: prev.text.trim(), line: prev.line };
      out.push({ kind: "code", text: line, line: at });   // the underline itself is not body
      continue;
    }

    out.push({ kind: "text", text: line, line: at });
  }
  return out;
}

/** The lines of a document that are ordinary prose — no code, no comments, no headings. */
export const proseLines = (text: string): string[] =>
  scanMarkdown(text).filter((l) => l.kind === "text").map((l) => l.text);
