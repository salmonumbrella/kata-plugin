/** Which existing Kata issue a piece of task text names as its own work.
 *
 * Rule, applied to the texts in the order given (spawn: description, then
 * prompt; session: the first user prompt):
 *  1. Candidates are qualified refs `project#id` (id = 4–8 Kata short-id
 *     characters), plus bare short ids the session already knows. A ref inside
 *     a URL path or after `--flag` is ignored.
 *  2. An occurrence introduced by an ownership marker ("Kata issue: X",
 *     "issue X", "you own [Kata] X", "owns X", "tracked as X", "working on X",
 *     "Kata X", "Kata ref X") is OWNED. The first owned occurrence wins.
 *  3. An occurrence introduced by a context marker ("parent X", "child of X",
 *     "under X", "related X", "see X", "blocked by X", "duplicate of X",
 *     "superseded by X") is context, never the work itself.
 *  4. Without an owned occurrence, exactly one distinct non-context ref wins.
 *  5. Several distinct non-context refs and no owned one: nothing is chosen,
 *     and `reason` says why; the caller must not guess.
 */
export type NamedIssue = {ref?: string; candidates: string[]; reason?: string};

const SHORT = "[0-9a-hjkmnp-tv-z]{4,8}";
const QUALIFIED = new RegExp(`(?<![\\w./:@#-])([A-Za-z][\\w.-]*)#(${SHORT})(?![\\w#-])`, "g");
const OWNED = /(?:\bkata\s+(?:issue|ref|item)|\bissue|\bown(?:s|ing)?(?:\s+kata)?(?:\s+issue)?|\btracked\s+as|\bwork(?:ing|s)?\s+on|\bkata)\s*[:=]?\s*[`"'(]?$/i;
const CONTEXT = /(?:\bsee\s+(?:kata\s+)?issue|\bparent|\bchild(?:ren)?\s+of|\bunder|\brelated(?:\s+to)?|\bsee|\bblocked[\s-]+by|\bblocks|\bduplicate(?:[\s-]+of)?|\bsuperseded(?:[\s-]+by)?|\bsupersedes|--[\w-]+)\s*[:=]?\s*[`"'(]?$/i;

function occurrences(text: string, known: ReadonlyMap<string, string>) {
  const found: {ref: string; at: number}[] = [];
  for (const match of text.matchAll(QUALIFIED))
    found.push({ref: `${match[1]}#${match[2]!.toLowerCase()}`, at: match.index!});
  if (known.size) {
    const bare = new RegExp(`(?<![\\w./:@#-])(${SHORT})(?![\\w#-])`, "gi");
    for (const match of text.matchAll(bare)) {
      const ref = known.get(match[1]!.toLowerCase());
      if (ref && !found.some(f => f.at <= match.index! && match.index! < f.at + f.ref.length)) found.push({ref, at: match.index!});
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

export function namedIssue(texts: readonly string[], knownRefs: readonly string[] = []): NamedIssue {
  const known = new Map<string, string>();
  for (const ref of knownRefs) if (ref.includes("#")) known.set(ref.split("#").pop()!.toLowerCase(), ref);
  const owned: string[] = [], plain: string[] = [], all: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const {ref, at} of occurrences(text, known)) {
      const before = text.slice(Math.max(0, at - 40), at);
      if (!all.includes(ref)) all.push(ref);
      if (OWNED.test(before) && !CONTEXT.test(before)) owned.push(ref);
      else if (!CONTEXT.test(before) && !plain.includes(ref)) plain.push(ref);
    }
  }
  if (owned.length) return {ref: owned[0], candidates: all};
  if (plain.length === 1) return {ref: plain[0], candidates: all};
  if (plain.length > 1) return {candidates: all, reason: `several issues named (${plain.slice(0, 5).join(", ")}) and none marked as owned`};
  return {candidates: all};
}

/** Kata says the issue or project does not exist (a definite answer, not an outage). */
export function definitelyMissing(error: unknown): boolean {
  return /not_found|issue not found|project_(?:unavailable|not_found)|no kata project|no project/i.test(String(error));
}
