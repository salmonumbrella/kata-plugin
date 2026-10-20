import { expect, test } from "bun:test";
import { matchDelegation, namedTask, taskTokens, type Status, type Task } from "../core/kata-core";

const task = (ref: string, content: string, status: Status = "pending", extra: Partial<Task> = {}): Task => ({ ref, content, phase: "Tasks", status, ...extra });
const pick = (tasks: Task[], text: string, unavailable: string[] = [], single = true) => matchDelegation(tasks, text, { unavailable: new Set(unavailable), single })?.ref;

// Spawn texts from the 2026-10-19 eval, where every binding went wrong.
const omp = [
  task("e#53ab", "Implement word_count and top_words in textstats", "in_progress"),
  task("e#3ke1", "Write unittest suite covering word_count, top_words, and empty input"),
  task("e#run1", "Run the test suite with python3 -m unittest"),
  task("e#cmt1", "Commit the work"),
];
const pi = [
  task("p#vd94", "Implement word_count and top_words", "in_progress"),
  task("p#4kwf", "Delegate: subagent writes unittest suite in tests/ for both functions"),
  task("p#run2", "Run python3 -m unittest"),
];

test("eval delegations bind the tests task, never the lead's active task", () => {
  expect(pick(omp, "WriteTests\nWrite the textstats unittest suite in tests/ per the contract above")).toBe("e#3ke1");
  expect(pick(pi, "You are a test writer. Write a unittest suite in tests/test_textstats.py covering word_count and top_words including empty input.")).toBe("p#4kwf");
  expect(pick(omp, "Reply with exactly: SUBAGENT-OK")).toBeUndefined();
});

// The 2026-10-20 re-eval: a long spec overlaps the run task too ("Do NOT run
// the suite ... repo root"); omp's short task name decides it.
const rerun = [
  task("r#4mpk", "Implement word_count and top_words in textstats/__init__.py", "in_progress"),
  task("r#t3st", "Write unittest suite in tests/ covering both functions incl. empty input (delegated to subagent)"),
  task("r#rvn2", "Run python3 -m unittest from repo root, all green"),
  task("r#cm7t", "Commit functions and tests"),
];
const rerunSpec = "# Target\nCreate `tests/__init__.py` (empty file) and `tests/test_textstats.py` in the current repo workspace. Do NOT create or modify anything else \u2014 in particular do NOT touch or create the `textstats/` package; its implementation lands in parallel and importing it now may fail.\n\n# Change\n1. `tests/__init__.py` \u2014 empty, so `python3 -m unittest` discovery from the repo root finds the suite.\n2. `tests/test_textstats.py` \u2014 unittest suite (e.g. TestWordCount, TestTopWords classes) covering: empty string and whitespace-only input for BOTH functions; basic multi-word counts; tabs/newlines/repeated spaces as separators; mixed-case collapsing to lowercase; tie-breaking alphabetical by word; `n == 0`; `n` greater than the number of distinct words; exact ordering of the returned list of tuples. Deterministic, stdlib only, no file/network I/O.\n\n# Acceptance\nBoth files exist and `python3 -m py_compile tests/test_textstats.py` succeeds. Do NOT run the suite against the package (implementation is mid-flight); a failing import at this stage is expected, not yours to fix.";
test("a long delegation spec binds by its task name", () => {
  expect(matchDelegation(rerun, rerunSpec, { label: "WriteTests" })?.ref).toBe("r#t3st");
  expect(matchDelegation(rerun, rerunSpec, { label: "RunUnittest" })?.ref).toBe("r#rvn2");
  expect(matchDelegation(rerun, rerunSpec)?.ref).toBeUndefined(); // too close to call without the name
});

test("exact titles, qualified refs and bare short ids bind directly", () => {
  expect(pick(omp, `Do "${omp[3].content}" now`)).toBe("e#cmt1");
  expect(pick(omp, "Work on e#run1")).toBe("e#run1");
  expect(pick([...pi, task("p#7x3g", "Write tests for textstats")], "read issue 7x3g and write tests/test_textstats.py")).toBe("p#7x3g");
});

test("a short title inside a longer one does not count as naming it", () => {
  const plan = [task("m#t1ab", "Write tests"), task("m#t2ab", "Write tests for parser edge cases"), task("m#t3ab", "Implement parser", "in_progress")];
  expect(pick(plan, "Write tests for the parser edge cases")).toBe("m#t2ab");
  expect(pick(plan, 'Complete "Write tests for parser edge cases"')).toBe("m#t2ab");
  expect(pick(plan, 'Do "Write tests" now')).toBe("m#t1ab");
});

test("a named task that is taken binds nothing else", () => {
  const plan = [task("x#aa11", "Write widget tests", "in_progress", { delegated: true }), task("x#bb22", "Write widget test docs")];
  expect(namedTask(plan, 'Complete "Write widget tests"')?.ref).toBe("x#aa11");
  expect(pick(plan, 'Complete "Write widget tests"')).toBeUndefined();
  expect(pick(plan, "continue task aa11 and write the widget test docs")).toBeUndefined();
  expect(pick([task("y#cc33", "Write gadget tests"), task("y#dd44", "Write gadget test docs")], 'Complete "Write gadget tests"', ["y#cc33"])).toBeUndefined();
});

test("the active task is a fallback only for an explicit current-task handoff", () => {
  const plan = [task("a#1", "Implement widget", "in_progress"), task("a#2", "Write widget tests")];
  expect(pick(plan, "Complete the current task and commit it.")).toBe("a#1");
  expect(pick(plan, "Complete the current task and commit it.", [], false)).toBeUndefined();
  expect(pick(plan, "Commit it.")).toBeUndefined();
});

test("ambiguous overlaps create a separate child instead of guessing", () => {
  expect(pick([task("c#1", "Write API tests"), task("c#2", "Write UI tests")], "Write the tests")).toBeUndefined();
  expect(pick([task("b#1", "Build alpha"), task("b#2", "Build beta")], "BuildBeta\ngo")).toBe("b#2");
});

test("tokens split camelCase, keep snake_case and count unittest as test", () => {
  expect(taskTokens("WriteTests for word_count")).toEqual(["write", "test", "word_count"]);
  expect(taskTokens("unittest suite")).toEqual(["unittest", "test", "suite"]);
});

// Property: whatever the text, the match is one available, open, unblocked,
// undelegated task. Seeded so a failure reproduces.
test("matches are always available open tasks", () => {
  let seed = 20261019;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const words = ["write", "tests", "implement", "widget", "run", "suite", "word_count", "commit", "docs", "current", "task", "build", "alpha"];
  const statuses: Status[] = ["pending", "in_progress", "blocked", "completed", "abandoned"];
  const phrase = (n: number) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(" ");
  for (let run = 0; run < 2000; run++) {
    const tasks = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, i) =>
      task(`r#t${i}`, phrase(1 + Math.floor(random() * 4)), statuses[Math.floor(random() * statuses.length)], { delegated: random() < 0.2 }));
    const unavailable = tasks.filter(() => random() < 0.2).map(t => t.ref);
    const ref = pick(tasks, phrase(Math.floor(random() * 6)), unavailable, random() < 0.7);
    if (!ref) continue;
    const chosen = tasks.find(t => t.ref === ref)!;
    expect(["pending", "in_progress"]).toContain(chosen.status);
    expect(chosen.delegated).toBe(false);
    expect(unavailable).not.toContain(ref);
  }
});
