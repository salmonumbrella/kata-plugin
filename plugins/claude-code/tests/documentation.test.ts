import { test, expect } from "claude-code/testing";
import { canClose, updateVerification, documentationStatement, documentationOnly } from "../hooks/evidence.ts";
import { harness, start, spawn } from "./support.ts";
import type { EngineCall } from "claude-code/testing";

const reviewAttestation="I wrote `/repo/REVIEW.md` and confirmed it exists (4.6k, 8 sections). I ran every claim in it against `example.py` on Python 3.14.8, then re-ran the key repros after writing the file; each output matched what the review says. I made no other changes and did not run git add or commit. Test files are in the scratch directory.";

const readmeAttestation="I wrote `README.md` and checked it by running every example in it. All the outputs and exit codes match what the README says, so nothing needed fixing.";

const writtenDocument=(file="REVIEW.md")=>updateVerification(undefined,"Write",{file_path:"/repo/"+file},{result:{}},"/repo");

for(const [file,answer] of [["REVIEW.md",reviewAttestation],["README.md",readmeAttestation]] as const)test(`own document prose verifies ${file}`,()=>{
 expect(canClose(writtenDocument(file),answer)).toBe(true);
 expect(Boolean(documentationStatement(answer))).toBe(true);
});

for(const answer of [
 "I wrote README.md and confirmed it exists.",
 "I wrote README.md. I will check every example later.",
 "I wrote README.md but did not check the examples. All outputs should match.",
 "I wrote README.md. Another agent checked it by running every example; all outputs match.",
 "The instructions say: I wrote README.md and checked it by running every example in it.",
 '> I wrote README.md and checked it by running every example in it.\nThis is a quotation.',
 'Example response: "I wrote README.md and checked it by running every example in it."',
 "I wrote README.md and checked it by running every example in it. The documentation is incomplete.",
 "I wrote README.md and checked it by running every example in it. Tests failed.",
 "I ran every example in example.py; all output matched.",
])test(`nonverification cannot certify docs: ${answer.slice(0,75)}`,()=>expect(canClose(writtenDocument("README.md"),answer)).toBe(false));

for(const cause of ["code","failed-check","unknown-path"])test(`own prose retains the ${cause} veto`,()=>{
 let state=writtenDocument("README.md");
 state=cause==="failed-check"?updateVerification(state,"Bash",{command:"python3 -m unittest"},{result:{exitCode:1}},"/repo"):
 updateVerification(state,"Write",{file_path:cause==="code"?"/repo/example.py":""},{result:{}},"/repo");
 expect(canClose(state,readmeAttestation)).toBe(false);
});

test("ordinary repro activity invalidates executable proof but allows own docs verification",()=>{
 let state=updateVerification(writtenDocument("README.md"),"Bash",{command:"python3 -m unittest"},{result:{exitCode:0}},"/repo");
 state=updateVerification(state,"Bash",{command:"python3 example.py /scratch/input.txt"},{result:{exitCode:0}},"/repo");
 expect(state.evidence.tests).toEqual([]);expect(canClose(state)).toBe(false);
 expect(canClose(state,readmeAttestation)).toBe(true);
});

for(const command of ["command touch source.py", "env touch source.py", "if true; then touch /repo/source.py; fi", "cd /scratch | cat; printf code > source.py", "cat | cd /scratch; printf code > source.py"])
 test(`review explicit shell writes cannot hide behind syntax: ${command}`,()=>expect(canClose(updateVerification(writtenDocument("README.md"),"Bash",{command},{result:{exitCode:0}},"/repo","/repo",undefined,{"/scratch/source.py":"/scratch/source.py"}),readmeAttestation)).toBe(false));

for(const answer of [
 "I wrote README.md and checked it exists and is not empty.",
 "I wrote README.md, and Reviewer B says he wrote README.md and checked it by running every example in it.",
 "I wrote README.md and checked it by running every example in it, but none of the outputs matched.",
 "I checked README.md exists.",
])test(`review rejects nonverification: ${answer}`,()=>expect(canClose(writtenDocument("README.md"),answer)).toBe(false));

for(const answer of ["I verified the README by running every documented example command. Every output matched the README exactly.","**Verification:** I verified the README by running every documented example command. Every output matched the README exactly."])
 test(`review accepts explicit document verification: ${answer}`,()=>expect(canClose(writtenDocument("README.md"),answer)).toBe(true));

for(const command of ["true <> source.py", "cd /scratch & wait; printf code > source.py", "cd /scratch && true & wait; printf code > source.py", "cd /scratch; cd -; printf code > source.py", "pushd /scratch; popd; printf code > source.py"])
 test(`review rejects hidden write contexts: ${command}`,()=>expect(canClose(updateVerification(writtenDocument("README.md"),"Bash",{command},{result:{exitCode:0}},"/repo","/repo",undefined,{"/scratch/source.py":"/scratch/source.py","/scratch/-/source.py":"/scratch/-/source.py"}),readmeAttestation)).toBe(false));

for(const answer of ["The following is an example response. I wrote README.md and checked it by running every example in it.","Reviewer A said:\n\nI wrote README.md and checked it by running every example in it.","I wrote README.md and checked it in theory, but I have never run its examples."])
 test(`review preserves speaker and hypothetical framing: ${answer}`,()=>expect(canClose(writtenDocument("README.md"),answer)).toBe(false));

for(const answer of ["I wrote README.md and ran every command example in it. All outputs matched, but one statement about encoding was wrong, and I fixed it.","**Verification of REVIEW.md:** I re-read it and re-ran example.py for the claims in findings 1 to 7 and the empty-input case. All outputs matched what the review says."])
 test(`explicit observed content verification: ${answer}`,()=>expect(canClose(writtenDocument(answer.includes("REVIEW.md")?"REVIEW.md":"README.md"),answer)).toBe(true));

for(const command of ["if true; then touch source.py; fi", "cd /scratch; if true; then cd /repo; fi; printf x > source.py", "S=/scratch; for f in one two; do S=/repo; done; printf x > $S/source.py", "for f in source.py; do touch $f; done"])
 test(`control-flow mutation still vetoes docs: ${command}`,()=>expect(canClose(updateVerification(writtenDocument("README.md"),"Bash",{command},{result:{exitCode:0}},"/repo"),readmeAttestation)).toBe(false));

for(const path of ["README.md","REVIEW.md","guide.mdx","notes.rst","notes.txt","docs/guide.adoc","docs/ARCHITECTURE"])
 test(`documentation-only own verification can close ${path}`,()=>{
  const state=updateVerification(undefined,"Write",{file_path:"/repo/"+path,content:"Documentation."},{result:{}},"/repo");
  expect(canClose(state,"I verified the documentation for correctness and completeness.")).toBe(true);
 });

for(const path of ["source.py","docs/source.py","docs/settings.json","docs/build.sh","requirements.txt","docs/requirements.txt","docs/tests/test_hello.py"])
 test(`code/config/script/test file ${path} cannot use a docs attestation`,()=>{
  const state=updateVerification(undefined,"Write",{file_path:"/repo/"+path,content:"code"},{result:{}},"/repo");
  expect(canClose(state,"I verified the documentation for correctness and completeness.")).toBe(false);
 });

for(const answer of ["Documentation is incomplete.","I will verify the documentation later.","The instructions say 'I verified the documentation'.","I verified the documentation, but tests failed.","Documentation was written.","I verified the tests."])
 test(`docs completion requires a current explicit verification: ${answer}`,()=>{
  const state=updateVerification(undefined,"Write",{file_path:"/repo/README.md"},{result:{}},"/repo");expect(canClose(state,answer)).toBe(false);
 });

test("a .py plus .md writer without code proof stays open despite docs verification",()=>{
 let state=updateVerification(undefined,"Write",{file_path:"/repo/README.md"},{result:{}},"/repo");state=updateVerification(state,"Write",{file_path:"/repo/hello.py"},{result:{}},"/repo");expect(canClose(state,"I verified the documentation.")).toBe(false);
});

test("a failed check vetoes a documentation attestation",()=>{
 let state=updateVerification(undefined,"Write",{file_path:"/repo/README.md"},{result:{}},"/repo");state=updateVerification(state,"Bash",{command:"pytest"},{result:{exitCode:1}},"/repo");expect(canClose(state,"I verified the documentation.")).toBe(false);
});

test("read-only docs work never becomes verified written evidence",()=>expect(canClose(updateVerification(undefined,"Read",{file_path:"/repo/README.md"},{result:{}},"/repo"),"I verified the documentation.")).toBe(false));

const documentationTurn=(id="a1",answer="I verified the documentation for correctness and completeness.")=>({agentId:id,turnId:"done",answer,reason:"answer" as const,durationMs:1,isAborted:false});

test("docs subagent closes with reviewed paths and its own verification statement",async($,on)=>{
 const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{},text:"written"}));
 await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)({tool:"Write",tool_use_id:"doc",agentId:"a1",file_path:"/tmp/test/README.md",content:"docs"});await $.turn.complete(documentationTurn());await h.clock.settle();
 expect(h.issues.get("c1")?.issue.status).toBe("closed");const close=h.calls.find(a=>a[1]==="close")!;expect(close).toContain("--reviewed");expect(close[close.indexOf("--message")+1]).toContain("Documentation written and verified by the agent:");expect(close[close.indexOf("--message")+1]).toContain("I verified the documentation");
});

test("a code write after the 20-path evidence cap never becomes documentation-only",()=>{
 let state;for(let i=0;i<25;i++)state=updateVerification(state,"Write",{file_path:`/repo/guide${i}.md`},{result:{}},"/repo");
 state=updateVerification(state,"Write",{file_path:"/repo/hello.py"},{result:{}},"/repo");expect(documentationOnly(state)).toBe(false);expect(canClose(state,"I verified the documentation.")).toBe(false);
});

test("a contradictory verified:false field vetoes a docs attestation",()=>{
 const state=updateVerification(undefined,"Write",{file_path:"/repo/README.md"},{result:{}},"/repo");expect(canClose(state,'{"verified":true,"reviewer":{"verified":false}}')).toBe(false);
});

test("a missing write pathname cannot be attested as docs",()=>{
 let state=updateVerification(undefined,"Write",{file_path:"/repo/README.md"},{result:{}},"/repo");state=updateVerification(state,"Write",{file_path:""},{result:{}},"/repo");expect(canClose(state,"I verified the documentation.")).toBe(false);
});

test("a subsequent native result must not reuse an older docs statement",async($,on)=>{
 const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{},text:"written"}));
 await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)({tool:"Write",tool_use_id:"doc",agentId:"a1",file_path:"/tmp/test/README.md",content:"docs"});
 h.control.throttleClose=20;await $.turn.complete(documentationTurn());await h.clock.settle();await $.turn.complete({...documentationTurn("a1","Documentation was written."),turnId:"later-result"});await h.clock.settle();
 expect((h.persisted.get("session/s1/spawn/tool-1") as {verification:{documentationStatement?:string}}).verification.documentationStatement).toBeUndefined();
});
