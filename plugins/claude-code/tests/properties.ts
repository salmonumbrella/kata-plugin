import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { workflowSummary } from "../hooks/notifications.ts";
import { teammateHandle, parseKata, kataImpersonation, rewriteKata, shellQuote } from "../hooks/commands.ts";

test("teammate handles obey the Kata identity contract for arbitrary names", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string(), fc.string(), async (base, id) => {
      assert.match(
        await teammateHandle(base, id),
        /^[a-z0-9][a-z0-9._-]{0,63}$/,
      );
    }),
    { numRuns: 1000 },
  );
});
test("quoted standalone arguments are recovered without executing shell syntax", () => {
  fc.assert(
    fc.property(
      fc.string().filter((s) => !/[;&|$`<>\n\r\\]/.test(s)),
      (arg) => {
        assert.deepEqual(
          parseKata("kata comment ref '" + arg.replace(/'/g, "'\"'\"'") + "'"),
          ["kata", "comment", "ref", arg],
        );
      },
    ),
    { numRuns: 1000 },
  );
});
test("compound or expanding shell commands are rejected", () => {
  fc.assert(
    fc.property(
      fc.string(),
      fc.constantFrom(";", "&", "|", "$(", "`", ">", "<", "\n", "\r"),
      (s, operator) => {
        assert.equal(parseKata("kata " + s + operator + "x"), undefined);
      },
    ),
    { numRuns: 1000 },
  );
});
test("empty quoted argument remains an argument", () => {
  assert.deepEqual(parseKata("kata comment ref ''"), [
    "kata",
    "comment",
    "ref",
    "",
  ]);
});

test("empty name and id shrink regression uses fallback with SHA256 suffix", async () => {
  assert.equal(await teammateHandle("", ""), "agent-e3b0c4");
});
test("same requested name is distinct for the probe tool ids", async () => {
  assert.notEqual(
    await teammateHandle("worker", "tool-1"),
    await teammateHandle("worker", "tool-2"),
  );
});
test("long hostile Unicode names still obey the teammate contract", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: 0x10ffff }), {
        minLength: 65,
        maxLength: 300,
      }),
      async (points) => {
        assert.match(
          await teammateHandle(
            points.map((p) => String.fromCodePoint(p)).join(""),
            "tool",
          ),
          /^[a-z0-9][a-z0-9._-]{0,63}$/,
        );
      },
    ),
    { numRuns: 1000 },
  );
});

test("exit batch trusts issue headers, including closed bodies that resemble open headers", async () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const { endCommand } = await import("../hooks/commands.ts");
  const dir = mkdtempSync(tmpdir() + "/kata-exit-");
  try {
    const bin = dir + "/fake kata",
      log = dir + "/writes",
      row = dir + "/row";
    writeFileSync(
      bin,
      '#!/bin/sh\nif [ "$1" = show ]; then cat "$KATA_TEST_ROW"; else printf "%s\\n" "$*" >> "$KATA_TEST_LOG"; fi\n',
      { mode: 0o700 },
    );
    for (const status of ["closed", "open"]) {
      writeFileSync(
        row,
        `OK show child\nIssue: child "Status: open"\nStatus: ${status}\nRevision: 12\nBody:\nStatus: open\nRevision: 999\n`,
      );
      const r = spawnSync("/bin/sh", ["-c", endCommand(bin, ["child"])], {
        env: { ...process.env, KATA_TEST_ROW: row, KATA_TEST_LOG: log },
      });
      assert.equal(r.status, 0, r.stderr.toString());
      if (status === "closed") assert.equal(existsSync(log), false);
      else
        assert.equal(
          readFileSync(log, "utf8"),
          "meta set child claude.status session-ended --if-match 12\n",
        );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attribution preserves actual shell argument expansion and quoted whitespace", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(tmpdir() + "/kata-argv-");
  try {
    writeFileSync(dir + "/kata", '#!/bin/sh\nprintf "%s\\000" "$@"\n', {
      mode: 0o700,
    });
    writeFileSync(dir + "/one.txt", "");
    writeFileSync(dir + "/two.txt", "");
    for (const cmd of [
      "kata comment c1 --body *.txt",
      "  ka'ta' comment c1 --body 'two words'",
      '"kata" comment c1 --body ""',
    ]) {
      const execute = (value: string) => {
        const r = spawnSync("/bin/sh", ["-c", value], {
          cwd: dir,
          env: { ...process.env, PATH: dir + ":" + process.env.PATH },
        });
        assert.equal(r.status, 0, r.stderr.toString());
        return r.stdout.toString().split("\0").slice(0, -1);
      };
      assert.deepEqual(execute(rewriteKata(cmd, "agent-abc123")), [
        "--teammate",
        "agent-abc123",
        ...execute(cmd),
      ]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actor refusal covers shell command boundaries and executable spellings", () => {
  fc.assert(fc.property(fc.string(), fc.constantFrom("kata", "/tmp/kata", "'kata'", "ka'ta'"), fc.constantFrom(";", "&&", "||", "|", "\n"), (actor, executable, separator) => {
    assert.equal(kataImpersonation(`printf ok ${separator} ${executable} comment c1 --as=${shellQuote(actor)} 2>&1`), true);
  }), {numRuns: 1000});
});
test("quoted command-looking literals never impersonate", () => {
  fc.assert(fc.property(fc.string(), value => {
    const literal = shellQuote("kata --as " + value);
    assert.equal(kataImpersonation("echo " + literal), false);
    assert.equal(rewriteKata("echo " + literal, "tester-123abc"), "echo " + literal);
  }), {numRuns: 1000});
});
test("shell scripts and substitutions cannot hide actor impersonation", () => {
  for (const source of ["sh -c 'kata comment c1 --as bad'", 'echo "$(kata --as bad show c1)"', "echo `kata --as bad show c1`", "env -i kata --as bad show c1", "kata show c1 2>&1 --as bad"])
    assert.equal(kataImpersonation(source), true, source);
  assert.equal(kataImpersonation("echo sh -c 'kata --as bad show c1'"), false);
});

test("workflow summaries stay bounded for arbitrary structured results and names", () => {
  fc.assert(fc.property(fc.string(), fc.jsonValue(), (name, result) => {
    const text = workflowSummary(name, {taskId: "w", status: "completed", summary: "done", result: JSON.stringify(result)});
    assert.ok(text.length <= 4000);
  }), {numRuns: 1000});
});
test("each top-level workflow agent keeps its short result beside a huge sibling", () => {
  fc.assert(fc.property(fc.string(), value => {
    const text = workflowSummary("check", {taskId: "w", status: "completed", summary: "done", result: JSON.stringify({review: value.repeat(1000), docs: "README_READY"})});
    assert.ok(text.includes("docs:\n- README_READY"));
  }), {numRuns: 1000});
});

test("ordinary shell branches, wrappers and redirections cannot hide --as", () => {
  for (const source of [
    "if false; then :; else kata --as bad show c1; fi",
    "/usr/bin/env kata --as bad show c1",
    "bash -lc 'kata --as bad show c1'",
    "<<< 'data' kata --as bad show c1",
    "kata show c1 &>/tmp/out --as bad",
  ]) assert.equal(kataImpersonation(source), true, source);
});
test("body option values are data, including an exact --as literal", () => {
  assert.equal(kataImpersonation("kata comment c1 --body '--as'"), false);
  assert.equal(rewriteKata("kata comment c1 --body '--teammate'", "tester-123abc"), "kata --teammate tester-123abc comment c1 --body '--teammate'");
});
test("heredoc command-looking text remains literal", () => {
  const text = "cat <<'EOF'\nkata --as bad show c1\nkata show c1\nEOF\nkata show c2";
  assert.equal(kataImpersonation(text), false);
  assert.equal(rewriteKata(text, "tester-123abc"), "cat <<'EOF'\nkata --as bad show c1\nkata show c1\nEOF\nkata --teammate tester-123abc show c2");
});

test("compound attribution preserves real Bash argv and literal heredoc output", async () => {
  const {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} = await import("node:fs");
  const {tmpdir} = await import("node:os");
  const {spawnSync} = await import("node:child_process");
  const dir = mkdtempSync(tmpdir() + "/kata-compound-argv-");
  try {
    writeFileSync(dir + "/kata", '#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["KATA_TEST_LOG"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n', {mode: 0o700});
    const sources = [
      "kata comment c1 --body '--as' 2>&1; kata show c1 | cat",
      `if false; then :; else ${dir}/kata comment c1 --body 'Tests; all passed'; fi`,
      "cat <<'EOF'\nkata --as bad show c1\nEOF\nkata show c1",
    ];
    for (const source of sources) {
      const execute = (command: string, name: string) => {
        const log = dir + "/" + name;
        const r = spawnSync("/bin/bash", ["-c", command], {env: {...process.env, PATH: dir + ":" + process.env.PATH, KATA_TEST_LOG: log}});
        assert.equal(r.status, 0, r.stderr.toString());
        return {text: r.stdout.toString(), args: existsSync(log) ? readFileSync(log,"utf8").trim().split("\n").map(row => JSON.parse(row)) : []};
      };
      const before = execute(source, "before"), after = execute(rewriteKata(source,"tester-123abc"), "after");
      assert.deepEqual(after, {text: before.text, args: before.args.map(args => ["--teammate", "tester-123abc", ...args])});
      for (const name of ["before", "after"]) rmSync(dir + "/" + name, {force:true});
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("compound split-string wrappers and nested substitutions are inspected as code", () => {
  assert.equal(kataImpersonation("env -S 'kata --as bad show c1'; true"), true);
  assert.equal(kataImpersonation('echo "$(echo "$(kata --as bad show c1)")"'), true);
  assert.equal(kataImpersonation("./else kata --as bad show c1"), false);
  assert.equal(kataImpersonation(`echo "$(printf ok)"'$(kata --as bad show c1)'`), false);
});

test("timing and coprocess keywords cannot hide Kata impersonation", () => {
  for (const source of ["time kata comment c1 --as bad", "time -p kata show c1 --as bad", "coproc kata show c1 --as bad"]) assert.equal(kataImpersonation(source), true, source);
  assert.equal(rewriteKata("./do kata show c1", "tester-123abc"), "./do kata show c1");
});

test("session titles are one bounded line for arbitrary Unicode data", async () => {
  const { sessionDescription } = await import("../hooks/session.ts");
  fc.assert(fc.property(fc.string({unit: "binary"}), fc.string({unit: "binary"}), (prompt, id) => {
    const result = sessionDescription(prompt, id);
    assert.ok(result.title.startsWith("Claude session: "));
    assert.ok(result.title.length <= "Claude session: ".length + 60, result.title);
    assert.equal(result.title, sessionDescription(prompt, id).title);
  }), {numRuns:1000});
});
test("plain-word session titles end on a whole word of the prompt's first sentence", async () => {
  const { promptTitle } = await import("../hooks/session.ts");
  const word = fc.stringMatching(/^[a-z]{2,12}$/).filter(w => !["please","pls","hey","hi","hello","ok","okay","so","now","then","also","claude","can","could","would","will","help","lets","i"].includes(w));
  fc.assert(fc.property(fc.array(word, {minLength: 2, maxLength: 40}), (words) => {
    const prompt = words.join(" ");
    const title = promptTitle(prompt);
    if (title === undefined) return;
    assert.ok(title.length <= 60, title);
    const lower = title.toLowerCase();
    assert.ok(prompt.startsWith(lower), title);
    assert.ok(prompt.length === lower.length || prompt[lower.length] === " ", "cut mid-word: " + title);
  }), {numRuns:1000});
});
test("the first ownership-marked Kata ref wins over context and later refs", async () => {
  const { namedIssue } = await import("../hooks/refs.ts");
  const id = fc.stringMatching(/^[0-9a-hjkmnp-tv-z]{4}$/), project = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
  const filler = fc.string().map(s => s.replace(/[#\w]/g, " "));
  fc.assert(fc.property(project, id, project, id, filler, filler, (p1, i1, p2, i2, before, after) => {
    const owned = `${p1}#${i1}`, other = `${p2}#${i2}`;
    const prompt = `${before} (parent ${other}) Kata issue: ${owned} ${after} also ${other}`;
    assert.equal(namedIssue(["", prompt]).ref, owned);
    const chosen = namedIssue([before, after]).ref;
    assert.equal(chosen, undefined);
  }), {numRuns:1000});
});
test("session bodies preserve bounded original prompt data and session identity", async () => {
  const { sessionDescription } = await import("../hooks/session.ts");
  fc.assert(fc.property(fc.string({unit: "binary"}), fc.string(), fc.boolean(), (text, id, long) => {
    const prompt = long ? text.repeat(1601) : text;
    assert.equal(sessionDescription(prompt, id).body, prompt.slice(0,1500) + "\n\nClaude session id: " + id);
  }), {numRuns:1000});
});

import { collectToolEvidence, evidenceArgs } from "../hooks/evidence.ts";
test("failed tool calls never yield close evidence for arbitrary input and output", () => {
  fc.assert(fc.property(fc.string(), fc.string(), fc.constantFrom("Bash", "Read", "Write", "Edit", "NotebookEdit", "Grep", "Glob"), (command, text, tool) => {
    assert.deepEqual(evidenceArgs(collectToolEvidence(tool, {command, file_path: command, notebook_path: command}, {isError: true, result: {}, text}, "/repo")), []);
  }), {numRuns: 1000});
});

import {updateVerification,canClose} from "../hooks/evidence.ts";
import type {Verification} from "../types/index.d.ts";
test("accumulated activity closes exactly with fresh proof and no unresolved failed checks",()=>{
 fc.assert(fc.property(fc.array(fc.record({kind:fc.constantFrom("read","write","pass","fail","commit","commit-fail","pr"),id:fc.integer()})),events=>{
  let state:Verification|undefined, fresh=false;
  const unresolved=new Set<string>();
  for(const e of events){
   const command=e.kind==="pr"?"gh pr create --title change --body proof":e.kind.startsWith("commit")?"git commit -m change":`pytest test_${e.id}.py`;
   const key=e.kind.startsWith("commit")?"commit":command;
   if(e.kind==="write")fresh=false;
   if(e.kind==="pr")fresh=true;
   if(e.kind==="fail"||e.kind==="commit-fail")unresolved.add(key);
   if(e.kind==="pass"||e.kind==="commit"){unresolved.delete(key);fresh=true;}
   const tool=e.kind==="read"?"Read":e.kind==="write"?"Write":"Bash";
   state=updateVerification(state,tool,{command,file_path:`/repo/f_${e.id}.py`},{isError:e.kind==="fail"||e.kind==="commit-fail",result:{stdout:e.kind==="pr"?"https://github.com/org/repo/pull/42":e.kind==="commit"?"[main abc1234] own change":""}},"/repo");
   assert.equal(canClose(state,"All required verification passed."),fresh&&unresolved.size===0);
  }
 }),{numRuns:1000});
});

// Round 7: the independent oracle models shell execution ordering, not parser
// internals. Materialize at most 50 segments so unbounded arrays stay cheap.
test("successful && chains retain exactly the checks after the last artifact write",()=>{
 fc.assert(fc.property(fc.array(fc.record({kind:fc.constantFrom("test","write","read","unknown"),id:fc.integer()})),all=>{
  const events=all.slice(0,50);if(!events.length)return;
  const expected:string[]=[];
  const segments=events.map(e=>{
   if(e.kind==="write"||e.kind==="unknown")expected.length=0;
   if(e.kind==="test"){const cmd=`pytest test_${e.id}.py`;if(!expected.includes(cmd))expected.push(cmd);return cmd;}
   return e.kind==="write"?`printf changed > file_${e.id}.py`:e.kind==="unknown"?`python3 rewrite_${e.id}.py`:"git status --short";
  });
  const state=updateVerification(undefined,"Bash",{command:segments.join(" && ")},{result:{exitCode:0}},"/repo");
  assert.deepEqual(state.evidence.tests,expected.slice(0,20));
  assert.equal(canClose(state),expected.length>0);
 }),{numRuns:2000});
});
test("a nonzero && chain vetoes every contained check until each has passed",()=>{
 fc.assert(fc.property(fc.array(fc.integer(),{minLength:1}),fc.integer({min:1,max:255}), (all,exitCode)=>{
  const commands=[...new Set(all.slice(0,50).map(id=>`pytest test_${id}.py`))];
  let state=updateVerification(undefined,"Bash",{command:commands.join(" && ")},{result:{exitCode}},"/repo");
  assert.equal(canClose(state),false);
  for(let i=0;i<commands.length;i++){
   state=updateVerification(state,"Bash",{command:commands[i]},{result:{exitCode:0}},"/repo");
   assert.equal(canClose(state),i===commands.length-1);
  }
 }),{numRuns:1000});
});
test("unsafe shell flow cannot turn arbitrary successful test output into proof",()=>{
 fc.assert(fc.property(fc.string(),fc.constantFrom(";","||","|","subshell"), (text,op)=>{
  const command=op==="subshell"?`(pytest ${shellQuote(text)})`:`pytest ${shellQuote(text)} ${op} true`;
  assert.equal(canClose(updateVerification(undefined,"Bash",{command},{result:{exitCode:0,stdout:text}},"/repo")),false);
 }),{numRuns:1000});
});
const fullSha=fc.array(fc.constantFrom(..."0123456789abcdef"),{minLength:40,maxLength:40}).map(chars=>chars.join(""));
test("quiet commit SHA lookup is bound to its own successful invocation and repository",()=>{
 fc.assert(fc.property(fullSha,fc.boolean(),fc.boolean(),fc.boolean(),fc.boolean(),fc.constantFrom("git log -1 --format=%H","git log -1 --format='%H%n%B'","git rev-parse HEAD"),(sha,sameRepo,succeeded,redirected,printer,query)=>{
  const command=`git add . && git commit -qm change && ${sameRepo?"":"cd /other && "}${query}${redirected?" >/dev/null":""}${printer?` && echo ${sha}`:""}`;
  assert.deepEqual(collectToolEvidence("Bash",{command},{result:{exitCode:succeeded?0:1,stdout:(redirected?"":sha+"\n")+(printer?sha+"\n":"")}},"/repo").commits,sameRepo&&succeeded&&!redirected&&!printer?[sha]:[]);
 }),{numRuns:1000});
});
test("a code write can never hide behind arbitrarily many documented paths",()=>{
 fc.assert(fc.property(fc.nat(),fc.integer(),fc.constantFrom(".py",".ts",".json",".sh"),(size,id,ext)=>{
  let state:Verification|undefined;
  for(let i=0;i<Math.min(size,100);i++)state=updateVerification(state,"Write",{file_path:`/repo/docs/guide_${i}.md`},{result:{}},"/repo");
  state=updateVerification(state,"Write",{file_path:`/repo/docs/source_${id}${ext}`},{result:{}},"/repo");
  assert.equal(canClose(state,"I verified the documentation."),false);
 }),{numRuns:1000});
});

test("dynamic failed test identities survive unrelated success throughout && chains",()=>{
 fc.assert(fc.property(fc.integer(),fc.constantFrom('$FILTER','${FILES}'),fc.constantFrom("cargo test","git commit -m unrelated"),(id,variable,later)=>{
  const command=`pytest test_${id}.py -k "${variable}" && git status --short`;
  let state=updateVerification(undefined,"Bash",{command},{result:{exitCode:1}},"/repo");
  state=updateVerification(state,"Bash",{command:later},{result:{exitCode:0,stdout:"[main abc1234] unrelated"}},"/repo");
  assert.equal(canClose(state),false);
 }),{numRuns:1000});
});

test("Bash reviewed paths resolve every generated cd against the original workspace",async()=>{
 const {resolve}=await import("node:path");
 fc.assert(fc.property(fc.array(fc.oneof(fc.integer().map(id=>`dir_${id}`),fc.constantFrom("..","docs","/repo/docs"))),changes=>{
  const dirs=changes.slice(0,50);let cwd="/repo";
  for(const dir of dirs)cwd=resolve(cwd,dir);
  const absolute=resolve(cwd,"guide.md"),expected=absolute.startsWith("/repo/")?absolute.slice(6):absolute;
  const command=[...dirs.map(dir=>`cd ${shellQuote(dir)}`),"printf changed > guide.md"].join(" && ");
  assert.deepEqual(updateVerification(undefined,"Bash",{command},{result:{exitCode:0}},"/repo").evidence.written,absolute.startsWith("/repo/")?[expected]:[]);
 }),{numRuns:1000});
});

// Round 8: Node's path resolver is an independent oracle for repository scope.
test("only repository writes change document classification across native and shell surfaces",async()=>{
 const {resolve}=await import("node:path");
 fc.assert(fc.property(fc.array(fc.constantFrom("..","docs","nested","/tmp","/repo","/repo-other")),fc.integer(),fc.constantFrom("Write","Edit","NotebookEdit","Bash"),(parts,id,tool)=>{
  const pathname=parts.slice(0,30).concat(`scratch_${id}.py`).join("/");
  const absolute=resolve("/repo",pathname),inside=absolute.startsWith("/repo/");
  let state=updateVerification(undefined,"Write",{file_path:"/repo/REVIEW.md"},{result:{}},"/repo");
  const input=tool==="Bash"?{command:`printf changed > ${shellQuote(pathname)}`} : tool==="NotebookEdit"?{notebook_path:pathname}:{file_path:pathname};
  state=updateVerification(state,tool,input,{result:{exitCode:0}},"/repo");
  assert.deepEqual(state.evidence.written,inside?["REVIEW.md",absolute.slice(6)]:["REVIEW.md"]);
  assert.equal(canClose(state,'{"verified":true}'),!inside);
 }),{numRuns:1000});
});

// Round 9: the shell's final check result remains authoritative after only
// literal file preparation; arbitrary preceding commands are not equivalent.
test("literal preparation contents cannot obscure a terminal check",()=>{
 fc.assert(fc.property(fc.string(),fc.boolean(),fc.oneof(fc.constant(0),fc.integer()),(raw,heredoc,exit)=>{
  const content=raw.slice(0,1000);let delimiter="ROUND9_END";while(content.split("\n").includes(delimiter))delimiter+="_";
  const preparation=heredoc?`cat > source.py <<'${delimiter}'\n${content}\n${delimiter}\n`:`printf %s ${shellQuote(content)} > source.py\n`;
  const state=updateVerification(undefined,"Bash",{command:preparation+"python3 -m unittest"},{result:{exitCode:exit}},"/repo");
  assert.equal(canClose(state),exit===0);assert.equal(state.failedChecks.length,exit===0?0:1);
 }),{numRuns:1000});
});
test("mixed-output commit queries require a full unambiguous SHA",()=>{
 fc.assert(fc.property(fc.uint8Array({minLength:20,maxLength:20}),fc.string(),fc.constantFrom("HEAD","--short HEAD","--short=12 HEAD"),(bytes,noise,query)=>{
  const full=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");const sha=full.slice(0,query==="HEAD"?40:query.includes("=12")?12:7);
  const command=`python3 hello.py && git commit -qm change && git rev-parse ${query}`;
  const proof=collectToolEvidence("Bash",{command},{result:{exitCode:0,stdout:JSON.stringify(noise)+"\n"+sha+"\n"}},"/repo");
  assert.deepEqual(proof.commits,query==="HEAD"?[sha]:[]);
 }),{numRuns:1000});
});
test("a second short-query hash candidate is always ambiguous",()=>{
 fc.assert(fc.property(fc.uint8Array({minLength:20,maxLength:20}),fc.boolean(),(bytes,duplicate)=>{
  const sha=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("").slice(0,7);
  const proof=collectToolEvidence("Bash",{command:"python3 hello.py && git commit -qm change && git rev-parse --short HEAD"},{result:{exitCode:0,stdout:sha+"\n"+(duplicate?sha:"1234567")+"\n"}},"/repo");
  assert.deepEqual(proof.commits,[]);
 }),{numRuns:1000});
});

test("raw earlier stdout never replaces the actual query SHA",()=>{
 const hash=fc.uint8Array({minLength:20,maxLength:20}).map(bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join(""));
 fc.assert(fc.property(hash,fc.oneof(fc.string(),hash.map(fake=>fake+"\nprefix")),fc.constantFrom("HEAD","--short HEAD"),(full,noise,query)=>{
  const actual=query==="HEAD"?full:full.slice(0,7),command=`python3 hello.py && git commit -qm change && git rev-parse ${query}`;
  const proof=collectToolEvidence("Bash",{command},{result:{exitCode:0,stdout:noise+actual+"\n"}},"/repo");
  assert.ok(proof.commits.length<=1);for(const inferred of proof.commits)assert.equal(inferred,actual);
 }),{numRuns:1000});
});

test("docs attestation admits external literal repro paths but rejects repository code",()=>{
 fc.assert(fc.property(fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"),{minLength:1,maxLength:20}).map(x=>x.join("")),fc.boolean(),fc.constantFrom("; "," && ","\n"),(name,inside,separator)=>{
  let state=updateVerification(undefined,"Write",{file_path:"/repo/README.md"},{result:{}},"/repo");
  const root=inside?"/repo":"/scratch",target=`${root}/${name}.py`;
  state=updateVerification(state,"Bash",{command:`S=${root}${separator}printf x > $S/${name}.py`},{result:{exitCode:0}},"/repo","/repo",undefined,{[target]:target});
  assert.equal(canClose(state,"I wrote README.md and checked it by running every example in it. All outputs match."),!inside);
 }),{numRuns:500});
});

import {workflowCompletion,workflowEvidenceArgs,closeEvidenceArgs} from "../hooks/completion.ts";
test("structured workflow verification rejects the newline and tab regressions",()=>{
 for(const summary of ["I did not\nverify the documentation.","I have not\tchecked the documentation."]){
  const proof=workflowCompletion(JSON.stringify({file:"README.md",verified:true,summary}),"/repo");
  assert.equal(proof.verified,false,summary);
  assert.deepEqual(workflowEvidenceArgs(proof),[]);
 }
});

// Unicode whitespace and line terminators, including JSON-escaped controls and BOM.
const reportWhitespace=fc.array(fc.constantFrom(" ","\t","\n","\r","\v","\f","\u0085","\u00a0","\u1680","\u2000","\u2001","\u2002","\u2003","\u2004","\u2005","\u2006","\u2007","\u2008","\u2009","\u200a","\u2028","\u2029","\u202f","\u205f","\u3000","\ufeff"),{minLength:1}).map(parts=>parts.join(""));
const reportLocation=fc.array(fc.constantFrom("object","array","encoded"));
const negativeReport=fc.oneof(
 fc.record({subject:fc.constantFrom("Tests","Checks","Build","Work","Implementation","Verification","Validation","Review","The test suite"),predicate:fc.constantFrom("failed","has failed","is failing","did not pass")}).map(({subject,predicate})=>`${subject} ${predicate}.`),
 fc.record({prefix:fc.constantFrom("I did not","I didn't","I could not","I couldn't","I cannot","I can't"),aside:fc.constantFrom(" ",", in fact, "),action:fc.constantFrom("verify the documentation","check the documentation","validate the documentation","test the documentation","review the documentation","run tests","run the checks")}).map(({prefix,aside,action})=>`${prefix}${aside}${action}.`),
 fc.record({prefix:fc.constantFrom("I have not","I haven't","I never"),action:fc.constantFrom("checked","verified","validated","tested","reviewed")}).map(({prefix,action})=>`${prefix} ${action} the documentation.`),
 fc.constantFrom("The documentation is not reviewed.","The work is not yet complete.","I failed to verify the documentation.","Not all checks passed.","Not all outputs match.")
);
function nestedReport(value: unknown, wrappers: string[]): unknown {
 // Stay within the parser's depth budget; draw the whole domain, bound construction.
 for(const kind of wrappers.slice(0,6))value=kind==="array"?[value]:kind==="encoded"?JSON.stringify(value):{detail:value};
 return value;
}
test("negative and failure statements veto verified workflow reports across whitespace and nesting",()=>{
 fc.assert(fc.property(
  negativeReport,
  fc.array(reportWhitespace,{minLength:1}),reportLocation,fc.string(),fc.boolean(),fc.boolean(),fc.boolean(),
  (statement,separators,wrappers,key,reverse,prose,ownText)=>{
   const text=statement.split(" ").map((word,i)=>(i?separators[(i-1)%separators.length]:"")+word).join("");
   const contradiction=nestedReport(text,wrappers);
   const writer=prose?{report:"I wrote README.md and verified the documentation.",notes:{[key]:contradiction}}:
    {file:"README.md",verified:true,summary:ownText?contradiction:"I verified the documentation.",notes:ownText?undefined:{[key]:contradiction}};
   const contributors=[writer,{file:"REVIEW.md",verified:true}];
   if(reverse)contributors.reverse();
   const proof=workflowCompletion(JSON.stringify({contributors}),"/repo");
   assert.equal(proof.verified,false);
   assert.deepEqual(workflowEvidenceArgs(proof),[]);
  }),{numRuns:2000});
});
test("verified workflow reports retain their paths with positive nested whitespace reports",()=>{
 fc.assert(fc.property(fc.constantFrom("All checks passed.","No review failed.","No validation failed.","No test suite failed."),reportWhitespace,reportLocation,fc.boolean(),(statement,separator,wrappers,reverse)=>{
  const details=nestedReport(statement.split(" ").join(separator),wrappers);
  const contributors=[{file:"README.md",verified:true,details},{file:"REVIEW.md",verified:true}];
  if(reverse)contributors.reverse();
  const proof=workflowCompletion(JSON.stringify({contributors}),"/repo");
  assert.equal(proof.verified,true);
  assert.deepEqual(workflowEvidenceArgs(proof),contributors.flatMap(({file})=>["--reviewed",file]));
 }),{numRuns:1000});
});
test("any unverified contributor vetoes independently of order",()=>{
 fc.assert(fc.property(fc.array(fc.boolean(),{minLength:1}),fc.boolean(),(drawn,reverse)=>{
  const verified=drawn.slice(0,60);
  const contributors=verified.map((value,i)=>({file:`docs/file_${i}.md`,verified:value}));
  if(reverse)contributors.reverse();
  const proof=workflowCompletion(JSON.stringify({results:contributors}),"/repo");
  assert.equal(proof.verified,verified.every(Boolean));
  assert.deepEqual(new Set(proof.files),new Set(verified.map((_,i)=>`docs/file_${i}.md`)));
 }),{numRuns:1000});
});
test("reported path scope follows Node normalization for arbitrary names",async()=>{
 const {resolve}=await import("node:path");
 fc.assert(fc.property(fc.string(),fc.array(fc.constantFrom("..","docs","/repo","/outside",".")),(name,drawn)=>{
  const parts=drawn.slice(0,20);
  const file=parts.concat(name+".md").join("/"),full=resolve("/repo",file),inside=full.startsWith("/repo/");
  const proof=workflowCompletion(JSON.stringify({files:[file],verified:true}),"/repo");
  if(/[\x00-\x1f]/.test(file))assert.equal(proof.verified,false);
  else {assert.equal(proof.verified,inside);assert.deepEqual(proof.files,inside?[full.slice(6)]:[]);}
 }),{numRuns:1000});
});
test("close event evidence union preserves all supported types and arbitrary values",()=>{
 fc.assert(fc.property(fc.string(),fc.string(),fc.boolean(),(value,other,reverse)=>{
  const rows=[{type:"external",account:"account:"+value},{type:"test",command:"test "+value},{type:"commit",sha:"sha"+other},{type:"pr",url:"https://host/"+other},{type:"reviewed-paths",paths:["path/"+value,"other/"+other]}];
  const ordered=reverse?[...rows].reverse():rows;
  const args=closeEvidenceArgs([...ordered,...ordered]),pairs=[];for(let i=0;i<args.length;i+=2)pairs.push(JSON.stringify(args.slice(i,i+2)));
  const expected=[["--evidence","external:account:"+value],["--test","test "+value],["--commit","sha"+other],["--pr","https://host/"+other],["--reviewed","path/"+value],["--reviewed","other/"+other]];
  assert.deepEqual(new Set(pairs),new Set(expected.map(pair=>JSON.stringify(pair))));
  assert.equal(args.length,12);
 }),{numRuns:1000});
});
test("nested result verification never lends proof across envelope boundaries",()=>{
 fc.assert(fc.property(fc.boolean(),fc.boolean(),fc.boolean(),(outer,inner,encoded)=>{
  const contributor={file:"REVIEW.md",verified:inner};
  const proof=workflowCompletion(JSON.stringify({file:"README.md",verified:outer,result:encoded?JSON.stringify(contributor):contributor}),"/repo");
  assert.equal(proof.verified,outer&&inner);
  assert.deepEqual(new Set(proof.files),new Set(["README.md","REVIEW.md"]));
 }),{numRuns:1000});
});
