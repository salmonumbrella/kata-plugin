import { test, expect } from "claude-code/testing";
import { evidenceArgs, collectToolEvidence, mergeEvidence, updateVerification, canClose, incompleteAnswer } from "../hooks/evidence.ts";

const ok = (text = "", result: Record<string, unknown> = {}) => ({ result, text });

test("successful explicit test commands produce capped evidence, shell data and masked failures do not", () => {
  for (const command of ["pytest -q", "python -m unittest", "python3 -m unittest -v", "npm test", "pnpm test --run", "yarn test", "bun test", "go test ./...", "cargo test", "make test", "make check", "vitest run", "jest", "tsc -p .", "claude plugin test .", "cd /repo && python3 -m unittest 2>&1", "npm run test:unit", "npx vitest run"])
    expect(evidenceArgs(collectToolEvidence("Bash", { command }, ok(), "/repo"))).toContain("--test");
  for (const command of ["echo pytest", "cat pytest", "npm install", "go version", "make contest", "pytest || true", "pytest; true", "pytest | cat", "false && pytest || :", "if false; then pytest; fi", "python -c 'print(\"pytest\")'", "echo 'cargo test'", "pytest &", "! pytest"])
    expect(evidenceArgs(collectToolEvidence("Bash", { command }, ok(), "/repo"))).toEqual([]);
  for (const result of [{ isError: true, result: {} }, { deny: "denied" }, ok("", { interrupted: true }), ok("", { backgroundTaskId: "bg1" }), ok("", { returnCodeInterpretation: "special nonzero" }), ok("", { exitCode: 1 })])
    expect(evidenceArgs(collectToolEvidence("Bash", { command: "pytest" }, result, "/repo"))).toEqual([]);
  const long = "pytest " + "x".repeat(500);
  expect(evidenceArgs(collectToolEvidence("Bash", { command: long }, ok(), "/repo"))).toEqual(["--test", long.slice(0, 200)]);
});

test("commit and PR evidence require their own successful invocations", () => {
  expect(evidenceArgs(collectToolEvidence("Bash", { command: 'git add . && git commit -m "fix"' }, ok("[main abc1234] fix"), "/repo"))).toEqual(["--commit", "abc1234"]);
  expect(evidenceArgs(collectToolEvidence("Bash", { command: "gh pr create --title Fix" }, ok("https://github.com/acme/repo/pull/12"), "/repo"))).toEqual(["--pr", "https://github.com/acme/repo/pull/12"]);
  expect(evidenceArgs(collectToolEvidence("Bash", { command: "echo '[main abc1234]'" }, ok("[main abc1234]"), "/repo"))).toEqual([]);
  expect(evidenceArgs(collectToolEvidence("Bash", { command: "gh pr view" }, ok("https://github.com/acme/repo/pull/12"), "/repo"))).toEqual([]);
});

test("written paths replace reads, paths normalize and cap at twenty", () => {
  let evidence = collectToolEvidence("Read", { file_path: "/repo/src/check.ts" }, ok(), "/repo");
  evidence = mergeEvidence(evidence, collectToolEvidence("Glob", { pattern: "**/*.ts" }, ok("src/a.ts\nsrc/b.ts", { filenames: ["/repo/src/a.ts", "/repo/src/b.ts"] }), "/repo"));
  expect(evidenceArgs(evidence)).toEqual([]);
  for (const tool of ["Write", "Edit", "NotebookEdit"])
    evidence = mergeEvidence(evidence, collectToolEvidence(tool, { file_path: "/repo/src/new.ts", notebook_path: "/repo/book.ipynb" }, ok(), "/repo"));
  expect(evidenceArgs(evidence)).toEqual(["--reviewed", "src/new.ts", "--reviewed", "book.ipynb"]);
  for (let i = 0; i < 30; i++) evidence = mergeEvidence(evidence, collectToolEvidence("Write", { file_path: `/repo/f${i}` }, ok(), "/repo"));
  expect(evidenceArgs(evidence).filter(v => v === "--reviewed").length).toBe(20);
  expect(evidenceArgs(collectToolEvidence("Grep", { pattern: "x", path: "/repo" }, ok("", { filenames: [] }), "/repo"))).toEqual([]);
});

test("informational and dry-run commands never count as executed verification", () => {
 for(const command of ["pytest --help", "pytest --version", "tsc --help", "npm test -- --help", "cargo test --help", "git commit --dry-run -m fix"])
  expect(evidenceArgs(collectToolEvidence("Bash",{command}, {result: {}, text: "[main abc1234]"}, "/repo"))).toEqual([]);
});

test("command availability queries are not successful test runs", () => {
 for(const command of ["command -v pytest", "command -V tsc", "command -v git commit", "command -v gh pr create", "env command -v pytest", "exec -a pytest true", "command -pv pytest"])
  expect(evidenceArgs(collectToolEvidence("Bash",{command},{result:{},text:"[main abc1234] https://github.com/acme/repo/pull/1"},"/repo"))).toEqual([]);
});

test("collection-only and no-run verification modes do not execute tests",()=>{
 for(const command of ["pytest --collect-only -q","pytest --co","cargo test --no-run","go test -c -o /dev/null","make -n test","make --just-print check","jest --listTests","vitest list"])
  expect(evidenceArgs(collectToolEvidence("Bash",{command},{result:{},text:""},"/repo"))).toEqual([]);
});

test("informational tsc, go and commit modes cannot manufacture proof",()=>{
 for(const command of ["tsc --showConfig","tsc --listFiles","tsc --listFilesOnly","go test -list .","go test -list=.","git commit --short","git commit --porcelain","git commit --dry-run","git commit -s --short"])
  expect(evidenceArgs(collectToolEvidence("Bash",{command},{result:{},text:"[main abc1234] subject"},"/repo"))).toEqual([]);
});

const passed=()=>updateVerification(undefined,"Bash",{command:"python3 -m unittest"},{result:{exitCode:0}},"/repo");

for(const command of ["git add hello.py && git commit -q -F - <<'EOF'\nAdd hello\nEOF", "git log -1 --format='%H%n%B'; git status --short", "kata close p#child --done --message 'Implemented and tested the delegated task' --test 'python3 -m unittest' 2>&1 | tail -2"])
 test(`literal metadata activity preserves own passing check: ${command}`,()=>{
  const state=updateVerification(passed(),"Bash",{command},{result:{exitCode:0}},"/repo");expect(canClose(state)).toBe(true);expect(state.evidence.tests).toEqual(["python3 -m unittest"]);
  expect(canClose(updateVerification(undefined,"Bash",{command},{result:{exitCode:0}},"/repo"))).toBe(false);
 });

for(const command of ["git status; python3 mutate.py", "git log -1 > source.py", "git reset --hard", "git commit -F - <<EOF\n$(touch source.py)\nEOF", "false; python3 -m unittest", "python3 -m unittest | tail -1"])
 test(`unobserved checks and possible mutations do not inherit proof: ${command}`,()=>expect(canClose(updateVerification(passed(),"Bash",{command},{result:{exitCode:0}},"/repo"))).toBe(false));

for(const command of ["git add source.py && git commit -q -m change && git log --oneline -1 && git status --short", "git commit -qm change && git log -1 --oneline"])
 test(`actual same-chain one-line HEAD query proves quiet commit: ${command}`,()=>expect(updateVerification(undefined,"Bash",{command},{result:{exitCode:0,stdout:"abc1234 Add source\n"}},"/repo").evidence.commits).toEqual(["abc1234"]));

for(const command of ["git log --oneline -1", "git commit -qm change; git log --oneline -1", "git commit -qm change && printf 'abc1234 fake\\n' && git log --oneline -1", "git commit -qm change && git log --oneline -2"])
 test(`one-line query cannot borrow/fake commit proof: ${command}`,()=>expect(updateVerification(undefined,"Bash",{command},{result:{exitCode:0,stdout:"abc1234 Add source\n"}},"/repo").evidence.commits).toEqual([]));

test("native short hash/subject plus stat-only display proves quiet commit",()=>{
 const state=updateVerification(undefined,"Bash",{command:"git add test_example.py && git commit -qm tests && git log -1 --format='%h %s' && git show --stat --format= HEAD"},{result:{exitCode:0,stdout:"8558e46 Add example tests\n test_example.py | 96 +++++++++++++++++++++\n 1 file changed, 96 insertions(+)\n"}},"/repo");
 expect(state.evidence.commits).toEqual(["8558e46"]);
});

test("arbitrary git-show content cannot supply a short query hash",()=>{
 const state=updateVerification(undefined,"Bash",{command:"git commit -qm tests && git log -1 --format='%h %s' && git show HEAD:spoof"},{result:{exitCode:0,stdout:"8558e46 Add example tests\n"}},"/repo");
 expect(state.evidence.commits).toEqual([]);
});

const checkResult=(failed=false)=>({isError:failed,result:{stdout:"",exitCode:failed?1:0}});

for(const command of ["npx vitest list","npm exec vitest list","bunx vitest list","tsc -v","go test -n","go test -x -n ./...","cargo test -- --list","pytest --fixtures","python3 -m pytest --fixtures","pytest --fixtures-per-test","pytest --markers","jest --showConfig"])
 test(`informational ${command} never verifies`,()=>expect(collectToolEvidence("Bash",{command},checkResult(),"/repo").tests).toEqual([]));

const passingCheck=()=>updateVerification(undefined,"Bash",{command:"pytest -q"},checkResult(),"/repo");

test("failed compound test plus commit is not repaired by an unrelated commit",()=>{
 let state=updateVerification(passingCheck(),"Bash",{command:"pytest && git commit -m change"},checkResult(true),"/repo");state=updateVerification(state,"Bash",{command:"git commit -m repair"},{result:{stdout:"[main abc1234] repair"}},"/repo");expect(canClose(state)).toBe(false);
});

test("successful commit in another -C repository cannot repair a failure",()=>{
 let state=updateVerification(passingCheck(),"Bash",{command:"git -C one commit -m change"},checkResult(true),"/repo");state=updateVerification(state,"Bash",{command:"git -C two commit -m repair"},{result:{stdout:"[main abc1234] repair"}},"/repo");expect(canClose(state)).toBe(false);
});

for(const command of ["printf broken > source.py","sed -i s/good/broken/ source.py","python3 rewrite_source.py","pytest && printf broken > source.py"])
 test(`post-proof Bash mutation ${command} requires new verification`,()=>expect(canClose(updateVerification(passingCheck(),"Bash",{command},checkResult(),"/repo"))).toBe(false));

for(const tool of ["Write","Edit","NotebookEdit"])
 test(`failed partial ${tool} invalidates earlier proof`,()=>expect(canClose(updateVerification(passingCheck(),tool,{file_path:"source.py",notebook_path:"book.ipynb"},checkResult(true),"/repo"))).toBe(false));

for(const answer of ["Tests are failing. Failed to complete the implementation.","WRITER_NOT_OK. I finished steps 1 to 3 but stopped before steps 4 and 5.","Partially complete; to finish run the remaining checks."])
 test(`incomplete verdict ${answer} vetoes closure`,()=>expect(incompleteAnswer(answer)).toBe(true));

test("an earlier compound proof cannot verify a mutation followed by a quiet commit",()=>{
 const state=updateVerification(undefined,"Bash",{command:"git commit -m first && sed -i s/good/broken/ source.py && git commit -qm second"},{result:{stdout:"[main abc1234] first",exitCode:0}},"/repo");
 expect(canClose(state)).toBe(false);
});

const shellResult=(stdout="")=>({result:{stdout,exitCode:0}});

const commitChain="git add hello.py test_hello.py && git commit -q -m 'Implement hello' && git log -1 --format='%H%n%B' && git status --short";

const commitSha="67f6b570123456789abcdef0123456789abcdef0";

test("exact lead heredoc, unittest and quiet commit chain verifies the changed files",()=>{
 let state=updateVerification(undefined,"Bash",{command:"cat > hello.py <<'EOF'\ndef hello(): return 'hello'\nEOF"},shellResult(),"/repo");
 state=updateVerification(state,"Bash",{command:"cat > test_hello.py <<'EOF'\nimport unittest\nEOF"},shellResult(),"/repo");
 state=updateVerification(state,"Bash",{command:"python3 -m unittest"},shellResult("Ran 1 test\nOK"),"/repo");
 state=updateVerification(state,"Bash",{command:commitChain},shellResult(commitSha+"\nImplement hello\n"),"/repo");
 expect(canClose(state,"Implemented and verified hello.")).toBe(true);
 expect(state.evidence.commits).toEqual([commitSha]);expect(state.evidence.tests).toEqual(["python3 -m unittest"]);
 expect(state.evidence.written).toEqual(["hello.py","test_hello.py"]);
});

for(const command of ["pytest -q && git status --short","printf changed > source.py && pytest -q","tee source.py < input && pytest -q"])
 test(`successful && test segment supplies fresh proof: ${command}`,()=>{
  const state=updateVerification(undefined,"Bash",{command},shellResult(),"/repo");expect(canClose(state)).toBe(true);expect(state.evidence.tests).toEqual(["pytest -q"]);
 });

for(const command of ["pytest -q && printf changed > source.py","pytest -q && tee source.py","pytest -q && python3 rewrite.py","pytest -q; true","pytest -q || true","pytest -q | cat","(pytest -q)"])
 test(`later mutations and unsafe shell flow cannot prove completion: ${command}`,()=>expect(canClose(updateVerification(undefined,"Bash",{command},shellResult(),"/repo"))).toBe(false));

for(const lookup of ["git log -1 --format=%H","git rev-parse HEAD"])
 test(`quiet commit can use its same-chain ${lookup} stdout`,()=>expect(collectToolEvidence("Bash",{command:`git add . && git commit -qm change && ${lookup} && git status --short`},shellResult(commitSha+"\n"),"/repo").commits).toEqual([commitSha]));

for(const command of ["git log -1 --format=%H","git commit -qm change && cd /other && git rev-parse HEAD","git commit -qm change && git -C /other log -1 --format=%H","git commit -qm change && echo "+commitSha,"git commit -qm change; git rev-parse HEAD"])
 test(`foreign or unbound SHA lookup is not commit proof: ${command}`,()=>expect(collectToolEvidence("Bash",{command},shellResult(commitSha+"\n"),"/repo").commits).toEqual([]));

test("nonzero && chain vetoes each contained test until that exact segment passes",()=>{
 let state=updateVerification(undefined,"Bash",{command:"pytest -q && cargo test"},{result:{exitCode:1}},"/repo");
 expect(state.failedChecks.length).toBe(2);
 state=updateVerification(state,"Bash",{command:"pytest -q"},shellResult(),"/repo");expect(canClose(state)).toBe(false);
 state=updateVerification(state,"Bash",{command:"cargo test"},shellResult(),"/repo");expect(canClose(state)).toBe(true);
});

test("a Bash write after a prior passing test invalidates it and records its path",()=>{
 let state=updateVerification(undefined,"Bash",{command:"pytest -q"},shellResult(),"/repo");
 state=updateVerification(state,"Bash",{command:"printf changed > docs/README.md"},shellResult(),"/repo");
 expect(canClose(state)).toBe(false);expect(state.evidence.written).toEqual(["docs/README.md"]);
});

for(const command of ['pytest -k "$FILTER"','pytest "$FILES" && cargo test'])test(`a failed dynamic test retains its veto: ${command}`,()=>{
 let state=updateVerification(undefined,"Bash",{command},{result:{exitCode:1}},"/repo");state=updateVerification(state,"Bash",{command:"cargo test"},shellResult(),"/repo");expect(canClose(state)).toBe(false);
});

for(const command of [`git commit -qm change && git rev-parse HEAD >/dev/null && echo ${commitSha}`,`echo ${commitSha} && git commit -qm change && git log -1 --format=%H >/dev/null`,`git commit -m change && printf '[main 1234567] fake'`,`git commit -qm change && git rev-parse HEAD && git -C /other log -1 --format=%H`])test(`SHA cannot be attributed through misleading output: ${command}`,()=>expect(collectToolEvidence("Bash",{command},shellResult(commitSha+"\n[main 1234567] fake\n"),"/repo").commits).toEqual([]));

for(const [command,path] of [["cd docs && printf changed > guide.md","docs/guide.md"],["cd docs && cd deep && printf changed > ../../README.md","README.md"],["cd docs && printf changed > /repo/docs/ARCHITECTURE","docs/ARCHITECTURE"]])test(`Bash written path uses original observation workspace: ${command}`,()=>expect(updateVerification(undefined,"Bash",{command},shellResult(),"/repo").evidence.written).toEqual([path]));

const statusEchoCommand="cat > hello.py <<'EOF'\nprint('hello')\nEOF\ncat > test_hello.py <<'EOF'\nimport unittest\nEOF\npython3 -m unittest 2>&1; echo exit=$?";

for(const code of [0,1])test(`lead's exact heredoc test/status shape exit ${code}`,()=>{
 const state=updateVerification(undefined,"Bash",{command:statusEchoCommand},{result:{exitCode:0,stdout:`Ran 1 test\n${code===0?'OK':'FAILED (failures=1)'}\nexit=${code}\n`}},"/repo");
 expect(canClose(state)).toBe(code===0);
 if(code)expect(state.failedChecks.length).toBe(1);
});

for(const suffix of ["; echo exit=0","; echo 'exit=$?'","; echo exit=$?; true"," | tail -1"])test(`unproven status suffix stays unverified: ${suffix}`,()=>{
 expect(canClose(updateVerification(undefined,"Bash",{command:"pytest -q"+suffix},{result:{exitCode:0,stdout:"exit=0"}},"/repo"))).toBe(false);
});

const preparation=`cat > hello.py <<'EOF'
def main():
    print("hello")

if __name__ == "__main__":
    main()
EOF
cat > test_hello.py <<'EOF'
import io
import unittest
from contextlib import redirect_stdout

import hello

class TestHello(unittest.TestCase):
    def test_prints_hello(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            hello.main()
        self.assertEqual(buf.getvalue(), "hello\\n")

if __name__ == "__main__":
    unittest.main()
EOF
`;

const preparedTest=preparation+"python3 -m unittest 2>&1";

const nativeResult=(stdout="")=>({result:{stdout,interrupted:false}});

const repository="/repo", fullCommitSha="a5da8e10f6a9259f31009369aa0c9a6b684c8863";

test("literal preparation and terminal test provide own proof",()=>{
 const state=updateVerification(undefined,"Bash",{command:preparedTest},nativeResult(".\nRan 1 test\nOK"),repository);
 expect(state.evidence.tests).toEqual(["python3 -m unittest 2>&1"]);
 expect(state.evidence.written).toEqual(["hello.py","test_hello.py"]);expect(canClose(state)).toBe(true);
});

const shortCommitQuery='git add hello.py test_hello.py && git commit -q -m "Add hello.py with unittest\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git rev-parse --short HEAD && git status --short';

test("short HEAD is bound to its successful quiet commit",()=>{
 const proof=collectToolEvidence("Bash",{command:shortCommitQuery},nativeResult("12d4911\n?? .gitignore\n?? .kata.toml"),repository);
 expect(proof.commits).toEqual(["12d4911"]);
});

const programAndCommit='python3 -m unittest 2>&1 && python3 hello.py && git add hello.py test_hello.py && git commit -q -m "Add hello script and unittest\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git rev-parse HEAD && git status --short';

test("exact-script test/program/commit/query chain regains proof at the commit",()=>{
 const state=updateVerification(undefined,"Bash",{command:programAndCommit},nativeResult("Ran 1 test\nOK\nhello\n"+fullCommitSha+"\n?? .kata.toml"),repository);
 expect(state.evidence.tests).toEqual([]);expect(state.evidence.commits).toEqual([fullCommitSha]);expect(canClose(state)).toBe(true);
});

for(const output of [{isError:true,result:{stdout:"FAILED"}},{result:{exitCode:1}},{result:{interrupted:true}},{result:{backgroundTaskId:"t"}}])
 test(`failed or unfinished preparation/check never verifies: ${JSON.stringify(output)}`,()=>{
  const state=updateVerification(undefined,"Bash",{command:preparedTest},output,repository);expect(canClose(state)).toBe(false);
  expect(canClose(updateVerification(state,"Bash",{command:"cargo test"},nativeResult(),repository))).toBe(false);
 });

for(const command of [preparation+"python3 -m unittest; true","pytest fail\n"+preparedTest,"python3 rewrite.py\n"+preparedTest,preparation+"pytest -q | cat",preparation+"pytest -q || true",preparation+"pytest -q\nprintf changed > source.py"])
 test(`preparation cannot mask failures or later activity: ${command.slice(-65)}`,()=>expect(canClose(updateVerification(undefined,"Bash",{command},nativeResult(),repository))).toBe(false));

for(const query of ["git rev-parse --short HEAD","git rev-parse --short=12 HEAD"])
 test(`common short SHA lookup shape: ${query}`,()=>expect(collectToolEvidence("Bash",{command:`git commit -qm change && ${query}`},nativeResult(fullCommitSha.slice(0,query.includes("=12")?12:7)+"\n"),repository).commits).toEqual([fullCommitSha.slice(0,query.includes("=12")?12:7)]));

for(const command of ["git rev-parse --short HEAD","git commit -qm change && git -C /other rev-parse --short HEAD","git commit -qm change && git rev-parse --short HEAD > /dev/null && echo 1234567","git commit -qm change; git rev-parse --short HEAD"])
 test(`short hashes require unredirected same-invocation own repository: ${command}`,()=>expect(collectToolEvidence("Bash",{command},nativeResult("1234567\n"),repository).commits).toEqual([]));

for(const stdout of [fullCommitSha+"\n"+fullCommitSha+"\n","1234567\n"+fullCommitSha+"\n","no SHA\n"])
 test(`ambiguous or missing short-query output cannot prove a commit: ${stdout.slice(0,14)}`,()=>expect(collectToolEvidence("Bash",{command:"python3 hello.py && git commit -qm change && git rev-parse --short HEAD"},nativeResult(stdout),repository).commits).toEqual([]));

test("truncated query output cannot supply a commit hash",()=>{
 expect(collectToolEvidence("Bash",{command:"python3 hello.py && git commit -qm change && git rev-parse HEAD"},{result:{stdout:fullCommitSha+"\n",isStdoutTruncated:true}},repository).commits).toEqual([]);
});

test("program execution after the commit still invalidates proof",()=>{
 expect(canClose(updateVerification(undefined,"Bash",{command:`git commit -qm change && git rev-parse HEAD && python3 rewrite.py`},nativeResult(fullCommitSha+"\n"),repository))).toBe(false);
});

for(const suffix of ["",'; echo "exit=$?"'])test(`native exec preparation never executes the claimed tail: ${suffix}`,()=>{
 const command="exec printf prepared > source.py\npython3 -m unittest"+suffix;
 let state=updateVerification(undefined,"Bash",{command:"python3 -m unittest"},{result:{exitCode:1}},repository);
 state=updateVerification(state,"Bash",{command},nativeResult("exit=0\n"),repository);
 expect(state.evidence.tests).toEqual([]);expect(canClose(state)).toBe(false);expect(state.failedChecks.length).toBe(1);
});

for(const query of ["HEAD","--short HEAD","--short=12 HEAD"])test(`a prefixed mandatory query line cannot hide an earlier fake SHA: ${query}`,()=>{
 const fake="0".repeat(query==="HEAD"?40:7),actual=fullCommitSha.slice(0,query==="HEAD"?40:query.includes("=12")?12:7);
 const command=`printf '${fake}\\nprefix' && git commit -qm change && git rev-parse ${query}`;
 expect(collectToolEvidence("Bash",{command},nativeResult(fake+"\nprefix"+actual+"\n"),repository).commits).toEqual([]);
});

test("full query can identify its mandatory SHA suffix after partial output",()=>{
 const command="printf prefix && git commit -qm change && git rev-parse HEAD";
 expect(collectToolEvidence("Bash",{command},nativeResult("prefix"+fullCommitSha+"\n"),repository).commits).toEqual([fullCommitSha]);
});

test("short query after arbitrary hex output is not framed reliably",()=>{
 const command="printf a && git commit -qm change && git rev-parse --short HEAD";
 expect(collectToolEvidence("Bash",{command},nativeResult("a"+fullCommitSha.slice(0,7)+"\n"),repository).commits).toEqual([]);
});

for(const code of [0,1])test(`unchanged script's joined literal preparation and status echo: ${code}`,()=>{
 const command="printf 'print(\"hello\")\\n' > hello.py && cat > test_hello.py <<'EOF'\nimport unittest\nEOF\npython3 -m unittest 2>&1; echo \"exit=$?\"";
 const state=updateVerification(undefined,"Bash",{command},nativeResult(`Ran 1 test\n${code?"FAILED":"OK"}\nexit=${code}\n`),repository);
 expect(canClose(state)).toBe(code===0);expect(state.failedChecks.length).toBe(code?1:0);
});
