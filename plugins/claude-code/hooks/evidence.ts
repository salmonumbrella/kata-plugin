import { artifactRedirect, evidenceSegments, shellWrittenPaths, literalFileWrite, stdoutRedirect, temporaryPaths, bookkeepingOnly, checkedCommand, preparedCommand, shellWriteScope, literalActivityCommands } from "./commands.ts";
import type { Evidence, Verification } from "../types/index.d.ts";
export type { Evidence, Verification } from "../types/index.d.ts";
const empty = (): Evidence => ({commits: [], prs: [], tests: [], written: []});
export function mergeEvidence(...items: (Evidence | undefined)[]): Evidence {
  const result = empty();
  for (const key of Object.keys(result) as (keyof Evidence)[])
    result[key] = [...new Set(items.flatMap(item => item?.[key] ?? []))].slice(0, 20);
  return result;
}
/** Lexically normalize paths, without relying on a Node API in the mod runtime. */
export function evidencePath(path: string, cwd: string): string {
  const normalize = (s: string) => {
    const parts: string[] = [];
    for (const p of s.split("/")) {
      if (!p || p === ".") continue;
      if (p === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
      else if (p !== ".." || !s.startsWith("/")) parts.push(p);
    }
    return (s.startsWith("/") ? "/" : "") + parts.join("/");
  };
  const root = normalize(cwd), full = normalize(path.startsWith("/") ? path : root + "/" + path);
  return full.startsWith(root + "/") ? full.slice(root.length + 1) : full;
}
const base = (s = "") => s.split("/").pop()!;
function verificationCommand(argv: string[]): string[] {
  const name = base(argv[0]), args = argv.slice(1);
  if (["npx", "bunx"].includes(name)) {
    while (args[0] && ["--yes", "-y", "--no-install", "--bun", "--"].includes(args[0])) args.shift();
    return args;
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(name) && args[0] === "exec") {
    const tail = args.slice(1); return tail[0] === "--" ? tail.slice(1) : tail;
  }
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(name) && args[0] === "-m" && ["pytest", "unittest"].includes(args[1] ?? "")) return args.slice(1);
  return argv;
}
function informational(argv: string[]) {
  const [exe, ...args] = verificationCommand(argv), name = base(exe);
  return args.some(a => /^(?:--help|--version|--dry-run|--collect-only|--collect|--co|--no-run|--listTests|--showConfig|--listFiles|--listFilesOnly|--init|--fixtures|--fixtures-per-test|--markers|--setup-plan|--filesOnly)(?:=|$)/.test(a) || a === "-h") ||
    (name === "tsc" && args.includes("-v")) ||
    (["pytest", "pytest-3"].includes(name) && args.includes("-V")) ||
    (name === "go" && args[0] === "test" && args.some(a => /^-(?:list|n|c|help)(?:=|$)/.test(a))) ||
    (name === "cargo" && args[0] === "test" && args.includes("--list")) ||
    (name === "make" && args.some(a => ["--just-print", "--recon"].includes(a) || /^-[^-]*n/.test(a))) ||
    (name === "vitest" && args[0] === "list");
}
function isTest(argv: string[]) {
  if (informational(argv)) return false;
  const [exe, ...args] = verificationCommand(argv), name = base(exe);
  if (["pytest", "pytest-3", "vitest", "jest", "tsc", "unittest"].includes(name)) return true;
  if (["npm", "pnpm", "yarn", "bun"].includes(name))
    return args[0] === "test" || (args[0] === "run" && /^test(?::[\w.-]+)?$/.test(args[1] ?? ""));
  if (["go", "cargo"].includes(name)) return args[0] === "test";
  if (name === "make") return ["test", "check"].includes(args[0] ?? "");
  return name === "claude" && args[0] === "plugin" && args[1] === "test";
}
/** Unknown shell activity is potentially mutating unless the SDK guarantees readonly. */
function safeActivity(argv: string[]) {
  const name = base(argv[0]);
  if (informational(argv) || isTest(argv) || gitCommand(argv)?.verb === "commit") return true;
  if (name === "gh" && argv[1] === "pr" && argv[2] === "create") return true;
  if (["kata", "cd", "pwd", "echo", "printf", "true"].includes(name)) return true;
  return name === "git" && ["add", "status", "diff", "show", "log", "rev-parse"].includes(gitCommand(argv)?.verb ?? "");
}
function directory(cwd: string, path: string): string {
  const relative = evidencePath(path, cwd);
  return relative.startsWith("/") ? relative : cwd.replace(/\/$/, "") + "/" + relative;
}
function gitCommand(argv: string[]): { verb: string; dir?: string } | undefined {
  if (base(argv[0]) !== "git") return;
  let i = 1, dir: string | undefined;
  while (argv[i]?.startsWith("-")) {
    if (argv[i] === "-C") { const next = argv[i + 1]; if (!next) return; dir = next.startsWith("/") ? next : dir ? dir + "/" + next : next; i += 2; }
    else if (argv[i] === "-c") i += 2;
    else return;
  }
  if(argv[i] === "commit" && argv.slice(i + 1).some(a => ["--dry-run", "--help", "--short", "--porcelain", "--branch", "--long", "-h"].includes(a))) return;
  return { verb: argv[i] ?? "", dir };
}
export function toolSucceeded(tool: string, output: Record<string, unknown>): boolean {
  const r = output.result && typeof output.result === "object" ? output.result as Record<string, unknown> : {};
  if (output.isError || output.deny || r.error) return false;
  return tool !== "Bash" || !(r.interrupted || r.backgroundTaskId || r.timedOutAfterMs || r.backgroundedByUser || r.backgroundedByTurnAbort || r.backgroundedToDeliverMessage || r.returnCodeInterpretation || (typeof r.exitCode === "number" && r.exitCode !== 0));
}
export type PathResolutions = Record<string, string | null>;
function repositoryPath(path: string, cwd: string, root: string, resolutions?: PathResolutions): string | undefined | null {
  const absolute = directory(cwd,path);
  const resolved = resolutions ? resolutions[absolute] : absolute;
  if (resolved == null) return null;
  const value = evidencePath(resolved,root);
  return value.startsWith("/") ? undefined : value;
}
type BashObservation = {proof: Evidence; checks: string[]; mutation: boolean; unknownWrites: boolean; unknownWritePaths: boolean; codeWrites: boolean; successful: boolean};
function bashObservation(command: string, output: Record<string, unknown>, cwd: string, root = cwd, tmpdir?: string, resolutions?: PathResolutions): BashObservation {
  command = temporaryPaths(command, tmpdir);
  let proof = empty(), effective = cwd, pendingCommit: string | undefined;
  const checks: string[] = [], successful = toolSucceeded("Bash", output);
  const r = output.result && typeof output.result === "object" ? output.result as Record<string, unknown> : {};
  const text = String(r.stdout ?? output.text ?? "");
  const statusChecked = checkedCommand(command), checked = statusChecked ?? preparedCommand(command);
  if (checked && evidenceSegments(checked.command).every(s => isTest(s.argv))) {
    const exit = text.trimEnd().match(/(?:^|\n)exit=(\d+)$/);
    if (!statusChecked || (exit && !r.isStdoutTruncated)) {
      const outcome = statusChecked ? {...output, isError: !successful, result: {...r, exitCode: Number(exit![1])}} : output;
      const observation = bashObservation(checked.command, outcome, cwd, root, tmpdir, resolutions);
      const scoped = shellWrittenPaths(checked.prefix).map(p => repositoryPath(p,cwd,root,resolutions));
      const paths = scoped.flatMap(p => p ?? []);
      return {...observation, mutation: observation.mutation || paths.length > 0 || scoped.includes(null),
        unknownWrites: observation.unknownWrites || scoped.includes(null),
        unknownWritePaths: observation.unknownWritePaths || scoped.includes(null),
        codeWrites: observation.codeWrites || paths.some(p=>!isDocumentationPath(p)),
        proof: mergeEvidence({ ...empty(), written: paths }, observation.proof)};
    }
  }
  const segments = evidenceSegments(command);
  const failureSegments = evidenceSegments(command,true);
  const isQuery = (argv: string[]) => {
    const git = gitCommand(argv), args = git ? argv.slice(argv.indexOf(git.verb)+1) : [];
    return (git?.verb === "rev-parse" && ((args.length === 1 && args[0] === "HEAD") ||
      (args.length === 2 && /^--short(?:=\d+)?$/.test(args[0]!) && args[1] === "HEAD"))) ||
      (git?.verb === "log" && args.length === 2 && args.includes("--oneline") && args.includes("-1")) ||
      (git?.verb === "log" && args.includes("-1") && args.some((a,i)=> a === "--format=%H" || a === "--format=%H%n%B" || a === "--format=%h %s" || (a === "--format" && ["%H","%H%n%B","%h %s"].includes(args[i+1] ?? ""))) &&
        args.every(a=>["-1","--format","%H","%H%n%B","%h %s","--format=%H","--format=%H%n%B","--format=%h %s"].includes(a)));
  };
  // Verbose commit headers can be forged by arbitrary printers. Keep their
  // sources restricted; a successful rev-parse has a separate uniqueness rule.
  const shaSourcesSafe = segments.every(s => {
    const git = gitCommand(s.argv), name = base(s.argv[0]);
    const statOnly = git?.verb === "show" && s.argv.slice(s.argv.indexOf("show")+1).length === 3 &&
      ["--stat", "--format=", "HEAD"].every(arg => s.argv.includes(arg));
    return ["cd","true"].includes(name) || (git && (["add","status","commit"].includes(git.verb) || isQuery(s.argv) || statOnly));
  });
  const queryCount = segments.filter(s=>isQuery(s.argv)).length;
  const verboseHashes = [...text.matchAll(/^\[[^\]\n]+\s([a-fA-F0-9]{7,40})\]\s/gm)].map(m => m[1]!);
  let verboseIndex = 0;
  let mutation = false, unknownWrites = false, unknownWritePaths = false, codeWrites = false;
  const reset = () => { mutation = true; proof = {...proof, commits: [], prs: [], tests: []}; pendingCommit = undefined; };
  if (!segments.length) {
    if (bookkeepingOnly(command)) return {proof, checks, mutation, unknownWrites, unknownWritePaths, codeWrites, successful};
    const activity = literalActivityCommands(command);
    if (successful && activity.length && activity.every(argv =>
        ["kata", "head", "tail", "pwd", "true"].includes(base(argv[0])) ||
        ["add", "commit", "status", "diff", "show", "log", "rev-parse"].includes(gitCommand(argv)?.verb ?? "")))
      return {proof, checks, mutation, unknownWrites, unknownWritePaths, codeWrites, successful};
    let checkCwd=cwd;
    for (const segment of failureSegments) {
      if (base(segment.argv[0]) === "cd" && segment.argv.length === 2) checkCwd=directory(checkCwd,segment.argv[1]!);
      if (isTest(segment.argv)) checks.push("test:"+checkCwd+":"+segment.command);
      const git=gitCommand(segment.argv);
      if (git?.verb === "commit") checks.push("commit:"+(git.dir?directory(checkCwd,git.dir):checkCwd));
    }
    const scope = shellWriteScope(command,cwd);
    const scoped = scope.paths.map(p => repositoryPath(p,cwd,root,resolutions));
    unknownWritePaths = scope.unresolved || scoped.includes(null);
    const written = scoped.flatMap(p => p ?? []);
    if (output.isReadOnly !== true && (!literalFileWrite(command) || written.length || scoped.includes(null))) {reset(); unknownWrites = !literalFileWrite(command) || scoped.includes(null);}
    if (successful) proof.written = written;
    return {proof, checks, mutation, unknownWrites, unknownWritePaths, codeWrites: written.some(p => !isDocumentationPath(p)), successful};
  }
  for (const segment of segments) {
    const argv = segment.argv, name = base(argv[0]), git = gitCommand(argv);
    if (name === "cd" && argv.length === 2) effective = directory(effective, argv[1]!);
    const scope = shellWriteScope(segment.command,effective), allWritten = scope.paths;
    const scoped = allWritten.map(p => repositoryPath(p,effective,root,resolutions));
    const written = scoped.flatMap(p => p ?? []);
    unknownWritePaths ||= scope.unresolved || scoped.includes(null);
    codeWrites ||= written.some(p => !isDocumentationPath(p));
    if (output.isReadOnly !== true && ((artifactRedirect(segment.command) && !allWritten.length) || written.length || scoped.includes(null) || (!safeActivity(argv) && !literalFileWrite(segment.command)))) {
      reset(); unknownWrites ||= scoped.includes(null) || (!literalFileWrite(segment.command) && !safeActivity(argv)) || (artifactRedirect(segment.command) && !allWritten.length);
    }
    if (successful) proof.written.push(...written);
    if (isTest(argv)) {
      checks.push("test:" + effective + ":" + segment.command);
      if (successful) proof.tests.push(segment.command.slice(0,200));
    }
    const gitDir = git?.dir ? directory(effective, git.dir) : effective;
    if (git?.verb === "commit") {
      checks.push("commit:" + gitDir);
      if (successful) {
        pendingCommit = gitDir;
        const quiet = argv.slice(argv.indexOf("commit") + 1).some(a => a === "--quiet" || /^-[^-]*q/.test(a));
        if (!quiet && shaSourcesSafe && !stdoutRedirect(segment.command) && verboseHashes.length === segments.filter(s=>gitCommand(s.argv)?.verb === "commit" && !s.argv.slice(s.argv.indexOf("commit")+1).some(a=>a === "--quiet" || /^-[^-]*q/.test(a))).length && verboseHashes[verboseIndex]) proof.commits.push(verboseHashes[verboseIndex++]!);
      }
    }
    // A quiet commit's SHA is usable only from a HEAD query inside this same
    // successful invocation, in the same repository after that commit.
    const short = argv.some(a => /^--short(?:=\d+)?$/.test(a));
    if (successful && pendingCommit === gitDir && isQuery(argv) && (shaSourcesSafe || (git?.verb === "rev-parse" && !short)) && queryCount === 1 && !stdoutRedirect(segment.command) && !r.isStdoutTruncated) {
      // Rev-parse appends a newline, not a leading one. Count SHA suffixes
      // even when earlier output left a partial line, so it cannot hide the
      // mandatory query token behind a prefix and promote an earlier fake.
      // Short queries retain restricted sources: a hex prefix is otherwise
      // indistinguishable from a legitimately longer Git abbreviation.
      const oneLine = git?.verb === "log" && argv.some(a => ["--oneline", "--format=%h %s", "%h %s"].includes(a));
      const hashes = [...text.matchAll(oneLine ? /^([a-fA-F0-9]{7,40}) [^\r\n]+\r?$/gm : short ? /([a-fA-F0-9]{7,40})\r?$/gm : /([a-fA-F0-9]{40})\r?$/gm)].map(m => m[1]!);
      if (hashes.length === 1 && (!short || text.split(/\r?\n/).includes(hashes[0]!))) proof.commits.push(hashes[0]!);
    }
    if (successful && name === "gh" && argv[1] === "pr" && argv[2] === "create")
      proof.prs.push(...(text.match(/https?:\/\/[^\s<>"']+\/pull\/\d+\b/g) ?? []));
  }
  return {proof: successful ? mergeEvidence(proof) : empty(), checks, mutation, unknownWrites, unknownWritePaths, codeWrites, successful};
}
export function collectToolEvidence(tool: string, input: Record<string, unknown>, output: Record<string, unknown>, cwd: string, root = cwd, resolutions?: PathResolutions): Evidence {
  const proof = empty();
  if (!toolSucceeded(tool, output)) return proof;
  if (tool === "Bash") return bashObservation(String(input.command ?? ""), output, cwd,root,undefined,resolutions).proof;
  if (["Write", "Edit", "NotebookEdit"].includes(tool)) {
    const path = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    if (typeof path === "string" && path.trim()) {
      const value = repositoryPath(path,cwd,root,resolutions);
      if (value != null) proof.written.push(value);
    }
  }
  return mergeEvidence(proof);
}
export function evidenceArgs(proof?: Evidence): string[] {
  if (!proof) return [];
  return [
    ...proof.commits.flatMap(s => ["--commit", s]), ...proof.prs.flatMap(s => ["--pr", s]),
    ...proof.tests.flatMap(s => ["--test", s]), ...proof.written.slice(0, 20).flatMap(s => ["--reviewed", s]),
  ];
}
export function incompleteAnswer(answer: string): boolean {
  return /\b(?:incomplete|unfinished|blocked)\b|\bnot (?:yet )?(?:complete|completed|finished|verified|done)\b|\b(?:tests?|checks?|build|work|implementation|verification) (?:has |have |still |are |is )?(?:failed|failing)\b|\b(?:could not|couldn't|unable to|failed to|did not|didn't) (?:finish|complete|verify)\b|\b(?:more work|work|implementation) remains\b|\b(?:stopped before|to finish|remaining (?:steps|work|checks)|partially complete)\b|(?:^|[_\W])not[_ -]ok(?:$|[_\W])/i.test(answer);
}
/** Conservative pathname contract: the approved text extensions, plus known
 * document formats/media and extensionless reference names beneath docs/.
 * Executable/config/test names cannot qualify even with a .txt suffix. */
export function isDocumentationPath(path: string): boolean {
  const name = base(path), lower = name.toLowerCase();
  if (/(?:^|\/)(?:__tests__|tests?|scripts?)(?:\/|$)/i.test(path) ||
      /(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(name) ||
      /^(?:\.|makefile$|dockerfile$|cmakelists\.txt$|requirements(?:[._-].*)?\.txt$|constraints(?:[._-].*)?\.txt$|pipfile$)/i.test(name)) return false;
  if (/\.(?:md|mdx|rst|txt)$/i.test(name)) return true;
  if (!/(?:^|\/)docs\//i.test(path)) return false;
  return /\.(?:adoc|asciidoc|org|tex|pdf|png|jpe?g|gif|webp|[1-9])$/i.test(name) ||
    /^(?:README|REVIEW|ARCHITECTURE|CONTRIBUTING|CHANGELOG|LICENSE|COPYING|AUTHORS|FAQ)$/i.test(lower);
}
export function documentationOnly(state: Verification | undefined): boolean {
  return !!state?.evidence.written.length && !(state.unknownWritePaths ?? state.unknownWrites) && !state.codeWrites && state.evidence.written.every(isDocumentationPath);
}
export function documentationStatement(answer: string): string | undefined {
  if (incompleteAnswer(answer) || /\b(?:unverified|not reviewed|not checked)\b/i.test(answer)) return;
  try {
    const value = JSON.parse(answer);
    if (value && !Array.isArray(value) && value.verified === true && structuredVerification(answer)) return answer.trim().slice(0,1000);
  } catch {}
  // Prose is the writer's own assertion, not a quoted example or a promise.
  const prose = answer.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/^\s*>.*$/gm, "")
    .replace(/"(?:\\.|[^"\\])*"/g, "").replace(/\*\*/g, "");
  if (/\b(?:did not|didn't|have not|haven't|could not|couldn't|not yet)\s+(?:\w+\s+){0,2}(?:check|verify|validate|test|run (?:the |any |all )?(?:tests?|checks?|examples?|repros?))\b/i.test(prose)) return;
  if (/\b(?:none|not all) of (?:the )?(?:outputs?|results?|examples?) (?:match|pass)|\b(?:outputs?|results?|examples?) (?:did not|didn't|do not|don't|never) match/i.test(prose)) return;
  if (/\b(?:example (?:response|answer)|in theory|hypothetically|have never (?:run|checked|verified))\b|\b(?:\w+|another agent|the reviewer|the writer) (?:said|says):/i.test(prose)) return;
  const document = "(?:the |this |my )?(?:documentation|documents?|README|REVIEW|[\\w./-]+\\.(?:md|mdx|rst|txt))";
  const boundary = "(?:^|[.!?]\\s+|\\n\\s*)(?:(?:Verification|VERIFIED):\\s*)?";
  const existenceOnly = (claim: string) => /\b(?:exists?|existence|not empty|nonempty|file size)\b/i.test(claim) &&
    !/\b(?:correctness|accuracy|completeness|examples?|claims?|repros?|commands?)\b/i.test(claim);
  const direct = prose.match(new RegExp(boundary + "(I (?:have )?(?:verified|checked|validated) `?" + document + "`?\\b[^\\n]*)", "i"));
  if (direct && !existenceOnly(direct[1]!)) return direct[1]!.trim().slice(0,1000);
  const outputsMatched = (claim: string) => /\b(?:each|all|every) (?:the )?(?:outputs?|results?|examples?)(?: and exit codes)? (?:match(?:ed)?|agreed|passed)\b/i.test(claim);
  const ownLabel = prose.match(new RegExp("(?:^|\\n)VERIFIED:\\s*(I (?:re-read|reread) `?" + document + "`?[^\\n]*\\b(?:re-ran|reran|ran)\\b[^\\n]*)", "i"));
  if (ownLabel && outputsMatched(ownLabel[1]!)) return ownLabel[1]!.trim().slice(0,1000);
  const labelled = prose.match(new RegExp("(?:^|\\n)Verification of `?" + document + "`?:\\s*(I (?:re-read|reread) it and (?:re-ran|reran|ran) [^\\n]*\\bclaims\\b[^\\n]*)", "i"));
  if (labelled && outputsMatched(labelled[1]!)) return labelled[0].trim().slice(0,1000);
  for (const paragraph of prose.split(/\n\s*\n/)) {
    const own = paragraph.match(new RegExp("(?:^|[.!?]\\s+)(I (?:have )?(?:wrote|written|updated|created) `?" + document + "`?[\\s\\S]*)", "i"))?.[1];
    if (!own) continue;
    const checked = new RegExp("^I (?:have )?(?:wrote|written|updated|created) (?:the (?:review|documentation|document) (?:to|in) )?`?" + document + "`?\\s+and (?:then )?(?:checked|verified|validated) (?:it|the (?:file|document|documentation))\\b", "i").test(own) && !existenceOnly(own);
    const exercised = /(?:^|[.!?]\s+)I (?:have )?(?:ran|re-ran|reran|tested) (?:every|all|each|the)(?: key)? (?:claims?|examples?|repros?|commands?)\b[\s\S]*\b(?:in it|in the (?:file|document)|after writing (?:it|the file))\b/i.test(own);
    const ranOwn = new RegExp("^I (?:have )?(?:wrote|written|updated|created) `?" + document + "`?\\s+and (?:ran|tested) (?:every|all|each) (?:command )?examples? in it\\b", "i").test(own);
    if (checked || ((exercised || ranOwn) && outputsMatched(own))) return own.trim().slice(0,1000);
  }
}
/** A subagent's structured docs attestation must not contradict itself. */
function structuredVerification(raw: string): boolean {
  let valid = true;
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12) {valid=false;return;}
    if (typeof value === "string") {try {walk(JSON.parse(value),depth+1);} catch {} return;}
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {for (const child of value) walk(child,depth+1);return;}
    const node=value as Record<string,unknown>;
    if (node.verified===false)valid=false;
    for(const child of Object.values(node))walk(child,depth+1);
  };
  try {walk(JSON.parse(raw),0);} catch {return false;}
  return valid;
}
export function updateVerification(old: Verification | undefined, tool: string, input: Record<string, unknown>, output: Record<string, unknown>, cwd: string, root = cwd, tmpdir?: string, resolutions?: PathResolutions): Verification {
  const state: Verification = {evidence: mergeEvidence(old?.evidence), verified: old?.verified ?? false, failedChecks: [...(old?.failedChecks ?? [])], incomplete: old?.incomplete, unknownWrites: old?.unknownWrites, unknownWritePaths: old?.unknownWritePaths ?? old?.unknownWrites ?? false, codeWrites: old?.codeWrites, documentationStatement: old?.documentationStatement};
  const observation = tool === "Bash" ? bashObservation(String(input.command ?? "").trim(), output, cwd,root,tmpdir,resolutions) : undefined;
  const successful = observation?.successful ?? toolSucceeded(tool, output);
  const proof = observation?.proof ?? collectToolEvidence(tool, input, output, cwd,root,resolutions);
  const writeTool = ["Write", "Edit", "NotebookEdit"].includes(tool);
  const pathname = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
  const repoWrite = writeTool && (typeof pathname !== "string" || !pathname.trim() || repositoryPath(pathname,cwd,root,resolutions) !== undefined);
  if (repoWrite || observation?.mutation) {
    state.verified = false;
    state.documentationStatement = undefined;
    state.evidence = {...state.evidence, commits: [], prs: [], tests: []};
  }
  state.codeWrites ||= observation?.codeWrites || (repoWrite && typeof pathname === "string" && !isDocumentationPath(evidencePath(directory(cwd,pathname),root)));
  state.unknownWrites ||= observation?.unknownWrites || (repoWrite && (tool === "NotebookEdit" || (typeof pathname === "string" && repositoryPath(pathname,cwd,root,resolutions) === null) ||
    typeof pathname !== "string" || !pathname.trim() || /^#!/.test(String(input.content ?? input.new_string ?? ""))));
  state.unknownWritePaths ||= observation?.unknownWritePaths || (repoWrite && (tool === "NotebookEdit" ||
    (typeof pathname === "string" && repositoryPath(pathname,cwd,root,resolutions) === null) ||
    typeof pathname !== "string" || !pathname.trim() || /^#!/.test(String(input.content ?? input.new_string ?? ""))));
  state.evidence = mergeEvidence(state.evidence, proof);
  if (observation) {
    if (!successful) state.failedChecks = [...new Set([...state.failedChecks, ...observation.checks])];
    else state.failedChecks = state.failedChecks.filter(key => !observation.checks.includes(key));
    if (successful && (proof.tests.length || proof.commits.length || proof.prs.length)) state.verified = true;
  }
  return state;
}
export function canClose(state: Verification | undefined, answer = ""): boolean {
  if (!state || state.failedChecks.length || state.incomplete || incompleteAnswer(answer)) return false;
  return (state.verified && !!(state.evidence.commits.length || state.evidence.prs.length || state.evidence.tests.length)) ||
    (documentationOnly(state) && !!(documentationStatement(answer) ?? state.documentationStatement));
}
/** Collect exactly the literal destinations understood by the verifier. */
export function observedWritePaths(tool: string, input: Record<string, unknown>, cwd: string, tmpdir?: string): string[] {
  if (["Write", "Edit", "NotebookEdit"].includes(tool)) {
    const path = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    return typeof path === "string" && path.trim() ? [directory(cwd,path)] : [];
  }
  if (tool !== "Bash") return [];
  return shellWriteScope(temporaryPaths(String(input.command ?? ""),tmpdir),cwd).paths.map(p=>directory(cwd,p));
}
