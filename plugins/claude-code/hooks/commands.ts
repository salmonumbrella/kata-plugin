/** Derive a valid unique Kata teammate before Claude allocates an agent id. */
export async function teammateHandle(
  base: string,
  id: string,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(id),
  );
  const suffix = Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "agent";
  return clean.slice(0, 57) + "-" + suffix;
}

/** Deliberately reject shell operators even inside quotes. Never interpret expansions. */
export function parseKata(command: string): string[] | undefined {
  if (/[;&|$`<>\n\r\\]/.test(command)) return;
  const args: string[] = [];
  let token = "",
    quote = "",
    active = false;
  for (const c of command.trim()) {
    if (quote) {
      if (c === quote) quote = "";
      else token += c;
      active = true;
    } else if (c === '"' || c === "'") {
      quote = c;
      active = true;
    } else if (/\s/.test(c)) {
      if (active) {
        args.push(token);
        token = "";
        active = false;
      }
    } else {
      token += c;
      active = true;
    }
  }
  if (quote) return;
  if (active) args.push(token);
  return args[0] === "kata" ? args : undefined;
}
export function claimedRef(args: readonly string[]): string | undefined {
  let project: string | undefined;
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (!flag.startsWith("-")) { positional.push(flag); continue; }
    if (["--json", "--agent", "--quiet", "-q", "--if-unowned"].includes(flag)) continue;
    const [name, inline] = flag.split("=", 2);
    if (!["--project", "--workspace", "--as", "--teammate", "--format", "--if-value"].includes(name!)) return;
    const value = inline ?? args[++i];
    if (!value) return;
    if (name === "--project") project = value;
  }
  const ref = positional[0] === "claim" ? positional[1] :
    positional[0] === "meta" && positional[1] === "set" && positional[3] === "work.attention" && positional[4] === "ok" ? positional[2] : undefined;
  if (!ref || !/^[A-Za-z0-9][A-Za-z0-9._#-]*$/.test(ref)) return;
  if (!project || ref.includes("#")) return ref;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project)) return;
  return `${project}#${ref}`;
}
/** Refs a successful compound script reports claiming. `kata claim $P` cannot
 * be resolved lexically, so read Kata's own claim lines from the output.
 * Impersonating scripts claim nothing for the lead, and `kata assign` prints
 * the same plain "X assigned to Y" line, so only `OK claim` lines count then. */
export function reportedClaims(command: string, output: string): string[] {
  if (!/\bkata\b[^\n]*\bclaim\b/.test(command) || /(?:^|\s)--as(?:[\s=]|$)/.test(command)) return [];
  const plain = !/\bkata\b[^\n]*\bassign\b/.test(command);
  const refs: string[] = [];
  for (const match of output.matchAll(plain ? /^(?:OK claim (\S+)|(\S+) assigned to \S+)\s*$/gm : /^OK claim (\S+)()\s*$/gm)) {
    const ref = match[1] || match[2]!;
    if (/^[A-Za-z0-9][A-Za-z0-9._#-]*$/.test(ref) && !refs.includes(ref)) refs.push(ref);
  }
  return refs;
}
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** One process for exit; only header fields before Metadata/Body are authoritative. */
export function endCommand(
  executable: string,
  refs: readonly string[],
  workspace?: string,
  project?: string,
): string {
  let script = "failed=0\n";
  for (const value of refs) {
    const bin = shellQuote(executable) + (workspace ? " --workspace " + shellQuote(workspace) : "") + (project ? " --project " + shellQuote(project) : ""),
      ref = shellQuote(value);
    script += `row=$(${bin} show ${ref} --agent) || { failed=1; row=''; }\n`;
    script += `header=$(printf '%s\\n' "$row" | sed '/^Metadata:/,$d; /^Body:/,$d; /^Comments:/,$d')\n`;
    script += `status=$(printf '%s\\n' "$header" | sed -n 's/^Status: //p' | head -n 1)\n`;
    script += `revision=$(printf '%s\\n' "$header" | sed -n 's/^Revision: \\([0-9][0-9]*\\)$/\\1/p' | head -n 1)\n`;
    script += `if [ "$status" = open ]; then [ -n "$revision" ] && ${bin} meta set ${ref} claude.status session-ended --if-match "$revision" >/dev/null || failed=1; fi\n`;
  }
  return script + 'exit "$failed"\n';
}

type ShellWord = { text: string; start: number; end: number; operator?: boolean; dynamic?: boolean; quoted?: boolean; heredoc?: boolean; expansions?: number[] };
/** Lex shell spelling without evaluating it; skip heredoc data at its newline. */
function shellWords(source: string): ShellWord[] {
  const words: ShellWord[] = [], docs: { delimiter: string; quoted: boolean; tabs: boolean }[] = [];
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i]!)) {
      if (source[i++] !== "\n") continue;
      words.push({ text: ";", start: i - 1, end: i, operator: true });
      for (const doc of docs.splice(0)) {
        const start = i;
        while (i < source.length) {
          const end = source.indexOf("\n", i), stop = end < 0 ? source.length : end;
          const row = source.slice(i, stop);
          if ((doc.tabs ? row.replace(/^\t+/, "") : row) === doc.delimiter) {
            words.push({ text: source.slice(start, i), start, end: i, heredoc: true, dynamic: !doc.quoted });
            i = end < 0 ? source.length : end + 1;
            break;
          }
          i = end < 0 ? source.length : end + 1;
          if (i === source.length) words.push({ text: source.slice(start), start, end: i, heredoc: true, dynamic: !doc.quoted });
        }
      }
      continue;
    }
    if (source[i] === "#") { while (i < source.length && source[i] !== "\n") i++; continue; }
    const start = i;
    const operator = source.slice(i).match(/^(?:<<<|<<-|<>|&>>|&>|&&|\|\||;;|<<|>>|>&|<&|[;&|(){}<>])/);
    if (operator) { i += operator[0].length; words.push({ text: operator[0], start, end: i, operator: true }); continue; }
    let text = "", quote = "", quoted = false, dynamic = false;
    const expansions: number[] = [];
    while (i < source.length) {
      const c = source[i]!;
      if (!quote && (/\s/.test(c) || /[;&|(){}<>]/.test(c))) break;
      if (c === "\\" && quote !== "'") {
        quoted = true;
        if (source[i + 1] !== "\n") text += source[i + 1] ?? "";
        i += 2; continue;
      }
      if (c === "'" || c === '"') {
        if (!quote) { quoted = true; quote = c; i++; continue; }
        if (quote === c) { quote = ""; i++; continue; }
      }
      if ((c === "$" || c === "`") && quote !== "'") { dynamic = true; if (c === "`" || source[i + 1] === "(") expansions.push(i); }
      text += c; i++;
    }
    const previous = words.at(-1);
    if (previous?.operator && ["<<", "<<-"].includes(previous.text)) docs.push({ delimiter: text, quoted, tabs: previous.text === "<<-" });
    words.push({ text, start, end: i, quoted, dynamic: dynamic || !!quote, expansions });
  }
  return words;
}
type ShellInvocation = { executable: ShellWord; args: ShellWord[]; scripts: string[]; wrapped?: boolean };
function shellInvocations(command: string): ShellInvocation[] {
  const words = shellWords(command), calls: ShellInvocation[] = [];
  let beginning = true, wrapper = "", current: ShellInvocation | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.heredoc) continue;
    if (word.operator) {
      if (/^[<>]|^&>/.test(word.text)) { i++; continue; }
      beginning = true; wrapper = ""; current = undefined; continue;
    }
    if (beginning) {
      const base = word.text.split("/").pop()!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text) || ["then", "else", "elif", "do", "if", "while", "until", "coproc", "!"].includes(word.text)) continue;
      if (["env", "command", "exec", "sudo", "time"].includes(base)) { wrapper = base; continue; }
      if (wrapper && word.text.startsWith("-")) {
        if (wrapper === "env" && (["-S", "--split-string"].includes(word.text) || word.text.startsWith("--split-string="))) {
          const script = word.text.includes("=") ? word.text.slice(15) : words[++i]?.text;
          if (script) calls.push({ executable: { text: "env", start: 0, end: 0 }, args: [], scripts: [script] });
        }
        else if (["-u", "--unset", "-C", "--chdir", "-g"].includes(word.text)) i++;
        continue;
      }
      if (/^\d+$/.test(word.text) && /^[<>]/.test(words[i + 1]?.text ?? "")) continue;
      beginning = false;
      if (!word.dynamic) { current = { executable: word, args: [], scripts: [], wrapped: !!wrapper }; calls.push(current); }
    } else if (current) {
      if (/^\d+$/.test(word.text) && /^[<>]/.test(words[i + 1]?.text ?? "")) continue;
      current.args.push(word);
    }
  }
  return calls;
}
function kataInvocations(command: string) {
  return shellInvocations(command).filter(c => c.executable.text.split("/").pop() === "kata");
}
/** Flags used as option values are data; -- terminates Cobra option parsing. */
function hasOption(args: readonly ShellWord[], option: string): boolean {
  const valueFlags = new Set(["--body", "-m", "--message", "--comment", "--project", "--format", "--teammate", "--as", "--parent", "--meta", "--title", "--idempotency-key", "--if-match", "--if-value", "--evidence", "--evidence-kind", "--to", "--file"]);
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (text === "--") break;
    if (text === option || text.startsWith(option + "=")) return true;
    if (valueFlags.has(text)) i++;
  }
  return false;
}
/** Known delegates must keep the actor, even in a compound shell command. */
export function kataImpersonation(command: string, depth = 0): boolean {
  if (depth > 32) return /--as(?:\W|$)/.test(command); // Fail closed on excessive executable nesting.
  if (kataInvocations(command).some(c => hasOption(c.args, "--as"))) return true;
  const words = shellWords(command);
  for (const call of shellInvocations(command)) {
    if (call.scripts.some(script => kataImpersonation(script, depth + 1))) return true;
    if (["sh", "bash", "zsh"].includes(call.executable.text.split("/").pop()!)) {
      const i = call.args.findIndex(w => /^-[^-]*c/.test(w.text) || w.text === "--command");
      if (i >= 0 && call.args[i + 1] && kataImpersonation(call.args[i + 1]!.text, depth + 1)) return true;
    }
  }
  for (const match of command.matchAll(/(?=\$\(([^]*?)\)|`([^`]*?)`)/g)) {
    if (words.some(w => w.expansions?.includes(match.index!) || (w.heredoc && w.dynamic && w.start <= match.index! && w.end > match.index! && command[match.index! - 1] !== "\\")) && kataImpersonation(match[1] ?? match[2]!, depth + 1)) return true;
  }
  return false;
}
/** Insert after each safely identified executable; preserve every original argument byte. */
export function rewriteKata(command: string, teammate: string): string {
  let result = command;
  for (const call of kataInvocations(command).reverse()) {
    if (hasOption(call.args, "--teammate")) continue;
    result = result.slice(0, call.executable.end) + ` --teammate ${teammate}` + result.slice(call.executable.end);
  }
  return result;
}

/** Evidence needs every matched command to have run successfully. Reject shell
 * control flow that can mask an earlier failure; allow only && and redirects. */
function proofCommands(command: string, recognizeFailures = false): string[][] {
  const words = shellWords(command);
  if (words.some(w => w.heredoc || (!recognizeFailures && w.dynamic) || (w.operator && !["&&", ">", ">>", ">&", "<", "<&", "&>"].includes(w.text)))) return [];
  // Availability queries do not execute their operand. Reject ambiguous exec
  // aliases rather than sharing the identity lexer's permissive wrapper rules.
  if (words.some((w, i) => ["command", "exec"].includes(w.text.split("/").pop()!) && words[i + 1]?.text.startsWith("-") &&
    (w.text.split("/").pop() === "exec" || /^-[^-]*[vV]/.test(words[i + 1]!.text)))) return [];
  const calls = shellInvocations(command);
  if (calls.some(c => c.scripts.length || c.executable.dynamic || ["!", "if", "while", "until", "then", "else", "do", "coproc"].includes(c.executable.text))) return [];
  // Keywords and wrappers skipped by the identity lexer are unsafe for proof.
  if (words.some(w => !w.quoted && ["!", "if", "while", "until", "then", "else", "do", "coproc", "time", "sudo"].includes(w.text))) return [];
  return calls.map(c => [c.executable.text, ...c.args.map(w => w.text)]);
}

/** Successful && segments are ordered observations, never independent later
 * process queries. Original argument spelling remains the check identity. */
export function evidenceSegments(command: string, recognizeFailures = false): {command: string; argv: string[]}[] {
  if (!proofCommands(command,recognizeFailures).length) return [];
  const parts: string[] = [], words = shellWords(command);
  let start = 0;
  for (const word of words) if (word.operator && word.text === "&&") {
    parts.push(command.slice(start, word.start).trim()); start = word.end;
  }
  parts.push(command.slice(start).trim());
  const result = parts.map(part => ({command: part, calls: proofCommands(part,recognizeFailures)}));
  if (result.some(part => part.calls.length !== 1)) return [];
  return result.map(part => ({command: part.command, argv: part.calls[0]!}));
}
/** Resolve only a whole TMPDIR pathname word from the captured environment.
 * No shell evaluation; quoted literals, reassignment and other expansions stay
 * unknown. This is for write classification, never executable rewriting. */
export function temporaryPaths(command: string, tmpdir?: string): string {
  if (!tmpdir?.startsWith("/") || /(?:^|[\s;])(?:export\s+)?TMPDIR\s*=/.test(command)) return command;
  const words = shellWords(command);
  let result = command;
  for (let i = words.length - 1; i > 0; i--) {
    const word = words[i]!, before = words[i - 1]!;
    if (!word.dynamic || !before.operator || ![">", ">>", "&>"].includes(before.text)) continue;
    const braced = command.slice(word.start).match(/^\$\{TMPDIR\}(\/[A-Za-z0-9_./-]*)(?=$|[\s;&|<>])/);
    const end = braced ? word.start + braced[0].length : word.end;
    const raw = command.slice(word.start, end);
    const plain = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    const match = plain.match(/^\$(?:TMPDIR|\{TMPDIR\})(\/[^$`"'\\\s]*)$/);
    if (match) result = result.slice(0, word.start) + shellQuote(tmpdir.replace(/\/$/, "") + match[1]) + result.slice(end);
  }
  return result;
}
/** A directory selection followed solely by Kata bookkeeping cannot change
 * repository artifacts, even when written on separate shell lines. */
export function bookkeepingOnly(command: string): boolean {
  const words = shellWords(command), calls = shellInvocations(command);
  return !!calls.length && !words.some(w => w.dynamic || w.heredoc ||
    (w.operator && ![";", "&&"].includes(w.text))) &&
    calls.every(c => c.executable.text.split("/").pop() === "kata" ||
      (c.executable.text === "cd" && c.args.length === 1));
}
/** Literal metadata/read-only command lists may preserve prior verification,
 * but their combined exit status never establishes a new passing check. */
export function literalActivityCommands(command: string): string[][] {
  const words = shellWords(command), calls = shellInvocations(command);
  if (artifactRedirect(command) || words.some(w => w.dynamic ||
      (w.operator && ![";", "&&", "|", "<", "<<", "<<-", ">&", "<&"].includes(w.text))) ||
      calls.some(c => c.wrapped || c.scripts.length)) return [];
  return calls.map(c => [c.executable.text, ...c.args.map(w => w.text)]);
}
/** Split only literal file preparation from the final executable command.
 * A newline after a heredoc delimiter belongs to the preparation, not its data.
 * Earlier checks/control flow must never be hidden by a later successful tail. */
function preparationAndTail(command: string): {prefix: string; command: string} | undefined {
  const before = command.trimEnd(), words = shellWords(before);
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.heredoc) start = words[i + 1]?.start ?? before.length;
    else if (word.operator && word.text === ";") start = word.end;
  }
  const prefix = before.slice(0, start), checked = before.slice(start).trim();
  if (!checked || !evidenceSegments(checked).length) return;
  if (prefix.trim()) {
    const calls = shellInvocations(prefix), prep = shellWords(prefix);
    if (!calls.length || !shellWrittenPaths(prefix).length ||
      calls.some(c => c.wrapped || c.scripts.length || !["cat", "tee", "printf", "echo"].includes(c.executable.text)) ||
      prep.some(w => w.dynamic || (!w.quoted && ["!", "if", "while", "until", "then", "else", "do", "coproc"].includes(w.text)) ||
        (w.operator && !["&&", ">", ">>", "&>", "<", "<<", "<<-", ">&", "<&"].includes(w.text) &&
        !(w.text === ";" && prefix[w.start] === "\n")))) return;
  }
  return {prefix, command: checked};
}
/** A terminal check after literal writes has the native process outcome. */
export function preparedCommand(command: string): {prefix: string; command: string} | undefined {
  const tail = preparationAndTail(command);
  return tail?.prefix.trim() ? tail : undefined;
}
/** An explicit final status echo reports the preceding command's exit code,
 * unlike the shell's overall success. Only literal preparation may precede it. */
export function checkedCommand(command: string): {prefix: string; command: string} | undefined {
  const suffix = command.match(/;\s*echo\s+(?:exit=\$\?|"exit=\$\?")\s*$/);
  if (!suffix || suffix.index === undefined) return;
  if (!shellWords(command).some(w=>w.operator && w.text === ";" && w.start === suffix.index)) return;
  return preparationAndTail(command.slice(0, suffix.index));
}
/** Only literal output paths are evidence. Unknown/dynamic mutations are
 * still invalidating activity in the verifier, even without a known path. */
export function shellWrittenPaths(command: string): string[] {
  const words = shellWords(command), paths: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!, next = words[i + 1];
    if (word.operator && ([">", ">>", "&>", "&>>"].includes(word.text) || (word.text === ">&" && next && !/^(?:\d+-?|-)$/.test(next.text))) && next && !next.dynamic && !next.operator && next.text !== "/dev/null") paths.push(next.text);
  }
  for (const call of shellInvocations(command)) if (call.executable.text.split("/").pop() === "tee") {
    let options = true;
    for (const word of call.args) {
      if (options && word.text === "--") {options = false; continue;}
      if (word.dynamic || (options && word.text.startsWith("-"))) continue;
      if (word.text !== "/dev/null") paths.push(word.text);
    }
  }
  return [...new Set(paths)];
}
export function literalFileWrite(command: string): boolean {
  const calls = shellInvocations(command), words = shellWords(command);
  return calls.length === 1 && ["cat", "tee", "printf", "echo"].includes(calls[0]!.executable.text.split("/").pop()!) &&
    shellWrittenPaths(command).length > 0 && !words.some(w => (!w.heredoc && w.dynamic) || (w.heredoc && w.dynamic) ||
      (w.operator && ![">", ">>", "&>", "<", "<<", "<<-", ">&", "<&"].includes(w.text) && !(w.text === ";" && command[w.start] === "\n")));
}

/** A file redirection can mutate an artifact after a check. FD duplication is safe. */
export function artifactRedirect(command: string): boolean {
  const words = shellWords(command);
  return words.some((w, i) => w.operator && ([">", ">>", "&>", "&>>"].includes(w.text) ||
    (w.text === ">&" && !/^(?:\d+-?|-)$/.test(words[i+1]?.text ?? ""))) && words[i + 1]?.text !== "/dev/null");
}
export function claimedWorkspace(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--workspace") return args[i + 1];
    if (args[i]?.startsWith("--workspace=")) return args[i]!.slice(12);
  }
}

/** Whether this segment moves stdout away from its captured native result. */
export function stdoutRedirect(command: string): boolean {
  const words = shellWords(command);
  return words.some((w,i) => {
    if (!w.operator || ![">",">>",">&","&>"].includes(w.text)) return false;
    const previous = words[i-1];
    const fd = previous && previous.end === w.start && /^\d+$/.test(previous.text) ? Number(previous.text) : 1;
    return w.text === "&>" || fd === 1;
  });
}

/** Observe shell write destinations without turning compound command success
 * into test/commit proof. Only literal path assignments and whole variable
 * references are resolved; unknown destinations remain a separate veto. */
export function shellWriteScope(command: string, cwd: string): {paths: string[]; unresolved: boolean} {
  const paths: string[] = [], words = shellWords(command);
  let current: string | undefined = cwd, variables = new Map<string,string>(), unresolved = false;
  const stack: {cwd: string | undefined; variables: Map<string,string>}[] = [];
  let call: ShellWord[] = [];
  let controlDepth = 0;
  let listStart = {cwd: current as string | undefined, variables: new Map(variables)};
  let pipeline: {cwd: string | undefined; variables: Map<string,string>} | undefined;
  const resolve = (word: ShellWord): string | undefined => {
    if (!word.dynamic) return word.text;
    const match = word.text.match(/^\$([A-Za-z_][A-Za-z0-9_]*)(\/[^$`]*|)$/);
    if (!match || !variables.has(match[1]!)) return;
    const value = variables.get(match[1]!)! + match[2];
    if (!word.quoted && /[\s*?\[\]]/.test(value)) return;
    return value;
  };
  const target = (word: ShellWord) => {
    const value = resolve(word);
    if (value === "/dev/null") return;
    if (!value || (!value.startsWith("/") && !current) || (!word.quoted && /[*?\[\]]/.test(value))) {unresolved = true; return;}
    paths.push(value.startsWith("/") ? value : current + "/" + value);
  };
  const finish = () => {
    if (!call.length) return;
    const assignment = (word: ShellWord) => word.text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    while (["then", "do", "else", "fi", "done"].includes(call[0]?.text ?? "")) {
      const keyword = call.shift()!.text;
      if (["fi", "done"].includes(keyword)) controlDepth = Math.max(0,controlDepth-1);
    }
    if (!call.length) return;
    if (call[0]!.text === "for") {
      controlDepth++;
      if (call[1]) variables.delete(call[1].text);
      call=[];return;
    }
    if (["if", "while", "until"].includes(call[0]!.text)) {controlDepth++;call.shift();}
    if (!call.length) return;
    if (call.every(w => assignment(w))) {
      for (const word of call) {
        const [,name,value] = assignment(word)!;
        const resolved = resolve({...word,text:value!});
        if (!controlDepth && resolved?.startsWith("/")) variables.set(name!,resolved); else variables.delete(name!);
      }
      call=[];return;
    }
    while (call[0] && assignment(call[0])) call.shift();
    while (["command", "builtin", "env", "time", "nohup", "exec"].includes(call[0]?.text.split("/").pop() ?? "")) {
      const wrapper = call.shift()!.text.split("/").pop();
      while (call[0] && (assignment(call[0]) || call[0].text.startsWith("-"))) {
        const option = call.shift()!;
        if (option.text.startsWith("-") && !["--", "-p", "-l", "-i"].includes(option.text)) unresolved = true;
      }
      if (wrapper === "env" && call[0]?.dynamic) unresolved = true;
    }
    const first = call[0], name = first?.text.split("/").pop(), args = call.slice(1);
    if (first?.dynamic || ["eval","source",".","sh","bash","zsh","fish","xargs","sudo"].includes(name ?? "")) unresolved = true;
    if (name === "cd") {
      const destination = args.length === 1 && !args[0]!.text.startsWith("-") ? resolve(args[0]!) : undefined;
      current = controlDepth ? undefined : destination?.startsWith("/") ? destination : destination && current ? current + "/" + destination : undefined;
    }
    const operands = args.filter(w => !w.text.startsWith("-"));
    if (["tee","touch","mkdir","rmdir","rm","mkfifo","unlink"].includes(name ?? "")) operands.forEach(target);
    if (["chmod","chown","chgrp"].includes(name ?? "")) operands.slice(1).forEach(target);
    if (["cp","install"].includes(name ?? "")) {
      if (args.some(w=>/^-(?:t|T)|^--target-directory/.test(w.text))) unresolved=true;
      else if (operands.length) target(operands.at(-1)!); else unresolved=true;
    }
    if (name === "mv") operands.forEach(target);
    if ((name === "sed" && args.some(w=>/^--in-place|^-[^-]*i/.test(w.text))) ||
        (name === "find" && args.some(w=>["-delete","-exec","-execdir"].includes(w.text)))) unresolved=true;
    if (["case","function","export","readonly","unset","pushd","popd","elif","select","!"].includes(name ?? "")) {
      // Unsupported control flow cannot establish a later relative/variable destination.
      unresolved=true;current=undefined;variables.clear();
    }
    call=[];
  };
  for (let i=0;i<words.length;i++) {
    const word=words[i]!;
    // Substitution bodies execute even inside double quotes and expanding
    // heredocs. Recursively observe simple bodies; reject unparsed nesting.
    if (word.expansions?.length || (word.heredoc && word.dynamic)) {
      const source = command.slice(word.start, word.end);
      const matches = [...source.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)];
      for (const match of matches) {
        const nested = shellWriteScope(match[1] ?? match[2]!, current ?? "/");
        paths.push(...nested.paths); unresolved ||= nested.unresolved || (!current && nested.paths.length > 0);
      }
      const remainder = source.replace(/\$\(([^()]*)\)|`([^`]*)`/g, "");
      if (/\$\(|`/.test(remainder)) unresolved = true;
    }
    if (word.heredoc) continue;
    if (word.operator) {
      if (/^[<>]|^&>/.test(word.text)) {
        const next=words[++i];
        if ([">",">>","&>","&>>","<>"].includes(word.text) || (word.text === ">&" && next && !/^(?:\d+-?|-)$/.test(next.text))) {
          if(next)target(next);else unresolved=true;
        }
        continue;
      }
      const before = {cwd:current,variables:new Map(variables)};
      finish();
      if (word.text === "|") {
        pipeline ??= before;
        current=pipeline.cwd;variables=new Map(pipeline.variables);
      } else if (pipeline) {
        current=pipeline.cwd;variables=new Map(pipeline.variables);pipeline=undefined;
      }
      if (word.text === "&") {current=listStart.cwd;variables=new Map(listStart.variables);}
      if ([";", "&", "(", ")"].includes(word.text)) listStart={cwd:current,variables:new Map(variables)};
      if (word.text === "(") stack.push({cwd:current,variables:new Map(variables)});
      if (word.text === ")") {const saved=stack.pop();if(saved){current=saved.cwd;variables=saved.variables;}else unresolved=true;}
      if (word.text === "||") {current=undefined;variables.clear();}
      continue;
    }
    if (/^\d+$/.test(word.text) && word.end===words[i+1]?.start && /^[<>]/.test(words[i+1]?.text ?? "")) continue;
    call.push(word);
  }
  finish();
  return {paths:[...new Set(paths)],unresolved};
}
