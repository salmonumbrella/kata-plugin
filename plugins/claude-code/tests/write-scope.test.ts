import { test, expect } from "claude-code/testing";
import { updateVerification, canClose, documentationOnly } from "../hooks/evidence.ts";

const writtenDocument=(file="REVIEW.md")=>updateVerification(undefined,"Write",{file_path:"/repo/"+file},{result:{}},"/repo");

const readmeAttestation="I wrote `README.md` and checked it by running every example in it. All the outputs and exit codes match what the README says, so nothing needed fixing.";

for(const prefix of ["S=/scratch; cd $S; ","cd /scratch; "])
 test(`external repro destinations follow literal shell scope: ${prefix}`,()=>{
  const state=updateVerification(writtenDocument("README.md"),"Bash",{command:prefix+"printf input > sample.txt; python3 /repo/example.py sample.txt"},{result:{exitCode:0}},"/repo","/repo",undefined,{"/scratch/sample.txt":"/scratch/sample.txt"});
  expect(state.evidence.written).toEqual(["README.md"]);expect(canClose(state,readmeAttestation)).toBe(true);
 });

for(const command of ["S=/repo; printf code > $S/source.py", "S=/scratch; printf code > $S/source.py", "cd /scratch; printf code > source.py"])
 test(`resolved repository aliases still veto a code write: ${command}`,()=>{
  const state=updateVerification(writtenDocument("README.md"),"Bash",{command},{result:{exitCode:0}},"/repo","/repo",undefined,{"/repo/source.py":"/repo/source.py","/scratch/source.py":"/repo/source.py"});
  expect(state.evidence.written).toEqual(["README.md","source.py"]);expect(canClose(state,readmeAttestation)).toBe(false);
 });

for(const command of ["printf x > $UNKNOWN", "S=$(pwd); printf x > $S/file.py", "cd $UNKNOWN; printf x > file.py", "S=/scratch; S=$UNKNOWN; printf x > $S/file.py", "eval 'printf x > file.py'", "sh -c 'printf x > file.py'"])
 test(`unresolved shell destinations remain a veto: ${command}`,()=>expect(canClose(updateVerification(writtenDocument("README.md"),"Bash",{command},{result:{exitCode:0}},"/repo"),readmeAttestation)).toBe(false));

for(const command of ['cd /scratch; cd ../repo; printf code > source.py', 'printf "%s" "$(printf code > /repo/source.py)"', 'printf "%s" "`printf code > /repo/source.py`"', 'cat <<EOF\n$(printf code > /repo/source.py)\nEOF'])
 test(`nested destinations cannot escape repository classification: ${command}`,()=>expect(canClose(updateVerification(writtenDocument("README.md"),"Bash",{command},{result:{exitCode:0}},"/repo"),readmeAttestation)).toBe(false));

test("readonly fixture loop preserves the surrounding external cwd",()=>{
 const state=updateVerification(writtenDocument("README.md"),"Bash",{command:'S=/scratch; cd $S; for f in one.txt two.txt; do echo "$f"; python3 /repo/example.py "$f"; done; printf x > sample.txt'},{result:{exitCode:0}},"/repo","/repo",undefined,{"/scratch/sample.txt":"/scratch/sample.txt"});
 expect(state.evidence.written).toEqual(["README.md"]);expect(canClose(state,readmeAttestation)).toBe(true);
});

const successfulResult={result:{exitCode:0}};

const reviewDocument=()=>updateVerification(undefined,"Write",{file_path:"/repo/REVIEW.md",content:"Reviewed."},successfulResult,"/repo");

test("exact CR repro scratch write preserves docs-only classification",()=>{
 const state=updateVerification(reviewDocument(),"Bash",{command:"printf 'a\\rb\\r' > /tmp/ws_cr"},successfulResult,"/repo");
 expect(state.evidence.written).toEqual(["REVIEW.md"]);
 expect(documentationOnly(state)).toBe(true);
 expect(canClose(state,'{"verified":true}')).toBe(true);
});

for(const file of ["/tmp/code.py","/elsewhere/docs/build.sh","../scratch.py","/repo-other/file.py"])
 test(`native outside write is excluded: ${file}`,()=>{
  const state=updateVerification(reviewDocument(),"Write",{file_path:file,content:"#!/bin/sh\ncode"},successfulResult,"/repo");
  expect(state.evidence.written).toEqual(["REVIEW.md"]);expect(canClose(state,'{"verified":true}')).toBe(true);
 });

test("scratch file then readonly repro execution permits verified docs",()=>{
 let state=updateVerification(reviewDocument(),"Bash",{command:"printf 'a\\rb\\r' > /tmp/ws_cr"},successfulResult,"/repo");
 state=updateVerification(state,"Bash",{command:"python3 example.py /tmp/ws_cr"},{...successfulResult,isReadOnly:true},"/repo");
 expect(canClose(state,'{"verified":true}')).toBe(true);
});

test("scratch cannot hide a failed check",()=>{
 let state=updateVerification(reviewDocument(),"Bash",{command:"pytest -q"},{result:{exitCode:1}},"/repo");
 state=updateVerification(state,"Bash",{command:"printf 'a\\rb\\r' > /tmp/ws_cr"},successfulResult,"/repo");
 expect(canClose(state,'{"verified":true}')).toBe(false);
});

for (const command of ["cat > /tmp/repro.py <<'EOF'\nprint('test')\nEOF", "printf x > /tmp/one > code.py", "printf x > /tmp/one > \"$UNKNOWN\""])
 test(`outside writes never hide mixed or unknown repository mutations: ${command}`,()=>{
  const state=updateVerification(reviewDocument(),"Bash",{command},successfulResult,"/repo");
  expect(canClose(state,'{"verified":true}')).toBe(command.startsWith("cat > /tmp"));
 });

for (const command of ["printf 'a\\rb\\r' > \"$TMPDIR/ws_cr\"", "printf 'a\\rb\\r' > ${TMPDIR}/ws_cr", "cat > \"$TMPDIR/repro.py\" <<'EOF'\nprint('hi')\nEOF"])
 test(`known TMPDIR scratch output: ${command}`,()=>{
  const state=updateVerification(reviewDocument(),"Bash",{command},successfulResult,"/repo","/repo","/tmp");
  expect(state.evidence.written).toEqual(["REVIEW.md"]);expect(canClose(state,'{"verified":true}')).toBe(true);
 });

test("TMPDIR may itself be inside the repository",()=>{
 const state=updateVerification(reviewDocument(),"Bash",{command:'printf code > "$TMPDIR/repro.py"'},successfulResult,"/repo","/repo","/repo/tmp");
 expect(canClose(state,'{"verified":true}')).toBe(false);
});

test("single-quoted TMPDIR is a literal repository path",()=>{
 const state=updateVerification(reviewDocument(),"Bash",{command:"printf code > '$TMPDIR/repro.py'"},successfulResult,"/repo","/repo","/tmp");
 expect(canClose(state,'{"verified":true}')).toBe(false);
});

test("scratch writes never forgive an incomplete result",()=>{
 const state=updateVerification(reviewDocument(),"Bash",{command:"printf x > /tmp/ws_cr"},successfulResult,"/repo");
 expect(canClose(state,'{"verified":true,"summary":"Implementation remains incomplete"}')).toBe(false);
});

for(const command of ["printf code > /tmp/out >& code.py","printf code > /tmp/out 1>&code.py"])
 test(`filename descriptor redirects remain repository writes: ${command}`,()=>{
  expect(canClose(updateVerification(reviewDocument(),"Bash",{command},successfulResult,"/repo"),'{"verified":true}')).toBe(false);
 });

for(const command of ["cat /dev/null > /tmp/repro.py","tee /tmp/repro.py < /dev/null"])
 test(`bounded external file copies preserve existing proof: ${command}`,()=>{
  let state=updateVerification(reviewDocument(),"Bash",{command:"pytest -q"},successfulResult,"/repo");
  state=updateVerification(state,"Bash",{command},successfulResult,"/repo");
  expect(state.evidence.written).toEqual(["REVIEW.md"]);expect(state.evidence.tests).toEqual(["pytest -q"]);
  expect(documentationOnly(state)).toBe(true);
 });

for(const tool of ["Write","Edit","NotebookEdit","Bash"])
 test(`canonical outside alias into repository is an artifact: ${tool}`,()=>{
  const input=tool==="Bash"?{command:"printf code > /tmp/repo/source.py"}:tool==="NotebookEdit"?{notebook_path:"/tmp/repo/source.py"}:{file_path:"/tmp/repo/source.py"};
  let state=updateVerification(undefined,"Write",{file_path:"/canonical/repo/README.md"},successfulResult,"/canonical/repo");
  state=updateVerification(state,tool,input,successfulResult,"/canonical/repo","/canonical/repo",undefined,{"/tmp/repo/source.py":"/canonical/repo/source.py"});
  expect(state.evidence.written).toEqual(["README.md","source.py"]);expect(canClose(state,'{"verified":true}')).toBe(false);
 });

test("unresolved outside paths cannot hide a possible repository alias",()=>{
 const state=updateVerification(reviewDocument(),"Write",{file_path:"/tmp/unknown.py"},successfulResult,"/repo","/repo",undefined,{"/tmp/unknown.py":null});
 expect(canClose(state,'{"verified":true}')).toBe(false);
});
