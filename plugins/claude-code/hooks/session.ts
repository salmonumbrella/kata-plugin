/** User prompt text is data; only its short title and bounded body are stored. */
export function sessionDescription(prompt: string, sessionId: string, sessionName = sessionId) {
  return {
    title: "Claude session: " + (promptTitle(prompt) ?? (sessionName.replace(/\s+/g, " ").trim() || sessionId).slice(0, TITLE_LIMIT)),
    body: prompt.slice(0, 1500) + "\n\nClaude session id: " + sessionId,
  };
}

const TITLE_LIMIT = 60;
const GENERIC_PATH = new Set(["releases", "release", "tag", "tags", "blob", "tree", "main", "master", "issues", "pull", "pulls", "commit", "commits", "wiki", "src", "edit", "latest", "download", "-"]);
const FILLER = /^(?:(?:please|pls|hey|hi|hello|ok(?:ay)?|so|now|then|also|claude)\b[\s,:;!.-]*|(?:can|could|would|will) you\s+|i (?:want|need|would like) you to\s+|help me(?: to)?\s+|let'?s\s+)/i;
const DANGLING = /\s+(?:and|or|but|the|a|an|to|of|for|with|in|on|at|by|from|this|that|these|those|it|its|we|our|is|are|was|be|so|then|also|just|as|into|via|if|when|while|because|which|who)$/i;

/** A compact, readable stand-in for a URL: the repository or page name plus a
 * version/number tail when present, else the host. */
function urlWords(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map(p => decodeURIComponent(p));
    const host = u.hostname.replace(/^www\./, "");
    if (/(^|\.)(github\.com|gitlab\.com|gitea|codeberg\.org|bitbucket\.org)/.test(host) && parts.length >= 2) {
      const tail = parts.slice(2).reverse().find(p => !GENERIC_PATH.has(p.toLowerCase()));
      return tail && /\d/.test(tail) ? `${parts[1]} ${tail}` : parts[1]!;
    }
    const last = [...parts].reverse().find(p => !GENERIC_PATH.has(p.toLowerCase()) && /[a-z]/i.test(p));
    return last ? last.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[-_]+/g, " ") : host;
  } catch { return ""; }
}

/** Deterministic short title: first meaningful sentence of the prompt, URLs
 * compacted, markdown and leading filler dropped, cut at a clause or word
 * boundary within 60 characters, never mid-word. Undefined when nothing
 * readable remains (the caller then uses the session name). */
export function promptTitle(prompt: string): string | undefined {
  const text = prompt
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/<[^>\n]{1,200}>/g, " ")
    .replace(/https?:\/\/[^\s)>\]]+/g, url => " " + urlWords(url.replace(/[.,;:!?]+$/, "")) + " ")
    .replace(/`+|\*\*|__/g, "")
    .replace(/^\s{0,3}(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "");
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  let sentence = sentences.find(s => (s.match(/[A-Za-z]{2,}/g) ?? []).length >= 2) ?? sentences[0];
  if (!sentence) return;
  for (let previous = ""; previous !== sentence;) { previous = sentence; sentence = sentence.replace(FILLER, ""); }
  sentence = sentence.replace(/[.!?:;,]+$/, "").trim();
  if (sentence.length > TITLE_LIMIT) {
    const window = sentence.slice(0, TITLE_LIMIT + 1);
    const clause = Math.max(...[", ", "; ", ": ", " - ", " — ", " – ", " ("].map(mark => window.lastIndexOf(mark)));
    const space = window.lastIndexOf(" ");
    sentence = clause >= 24 ? sentence.slice(0, clause) : space > 0 ? sentence.slice(0, space) : sentence.slice(0, TITLE_LIMIT);
  }
  for (let previous = ""; previous !== sentence;) { previous = sentence; sentence = sentence.replace(DANGLING, "").replace(/[\s,;:(\-–—]+$/, ""); }
  if (!/[A-Za-z0-9]{2,}/.test(sentence)) return;
  return sentence[0]!.toUpperCase() + sentence.slice(1);
}
