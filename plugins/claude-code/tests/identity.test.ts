import { test, expect } from "claude-code/testing";
import { harness, start, spawn } from "./support.ts";
import type { EngineCall } from "claude-code/testing";

const missed = `kata comment nwsb --as tester-90d5e5 -m "Wrote test_example.py (14 unittest tests: count() empty/no-trailing-newline/trailing-newline/spaces+tabs/whitespace-only/unicode/unicode-whitespace; main() file arg, file ignores stdin, unicode file, stdin, empty stdin, missing file rc=1 + stderr, output format). python3 -m unittest: Ran 14 tests, OK. example.py unchanged." 2>&1; kata comment --help 2>&1 | grep -i teammate`;

test("known subagent Bash refuses the exact compound impersonation before native execution", async ($, on) => {
  const h = harness(on);
  let executed = 0;
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Bash" }, () => { executed++; return { result: {}, text: "ok" }; });
  await $.session.start(start);
  await $.agent.spawn(spawn());
  const result = await ($.tool.call as EngineCall<"tool.call">)({ tool: "Bash", agentId: "a1", tool_use_id: "forbidden", command: missed });
  expect(executed).toBe(0);
  expect("deny" in result ? result.deny : "").toContain("--teammate");
  await h.clock.settle();
});

test("compound redirected Kata calls get attribution without changing argument spelling", async ($, on) => {
  const h = harness(on);
  let command = "";
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Bash" }, (_$, e) => { command = e.command; return { result: {}, text: "ok" }; });
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await ($.tool.call as EngineCall<"tool.call">)({ tool: "Bash", agentId: "a1", tool_use_id: "safe", command: `cd /tmp && kata comment c1 -m "Tests; all OK" 2>&1; kata comment --help 2>&1 | head -10` });
  const create = h.calls.find(a => a[1] === "create")!;
  const handle = create[create.indexOf("--teammate") + 1];
  expect(command).toBe(`cd /tmp && kata --teammate ${handle} comment c1 -m "Tests; all OK" 2>&1; kata --teammate ${handle} comment --help 2>&1 | head -10`);
});

test("quoted standalone Kata executables receive the same teammate attribution", async ($, on) => {
  const h = harness(on);
  let observed = "";
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Bash" }, ($, e) => {
    observed = e.command;
    return { result: {}, text: "ok" };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Bash",
    command: "'kata' comment c1 --body ok",
    agentId: "a1",
    tool_use_id: "quote",
  });
  expect(observed).toContain("--teammate general-purpose-");
});

test("teammate injection preserves the original shell argument spelling", async ($, on) => {
  const h = harness(on);
  let observed = "";
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Bash" }, ($, e) => {
    observed = e.command;
    return { result: {}, text: "ok" };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Bash",
    command: "ka'ta' comment c1 --body *",
    agentId: "a1",
    tool_use_id: "spelling",
  });
  expect(observed).toMatch(
    /^ka'ta' --teammate general-purpose-[a-f0-9]{6} comment c1 --body \*$/,
  );
});

test("known agent Kata commands inherit teammate while ordinary commands pass through", async ($, on) => {
  harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  const seen: string[] = [];
  on("tool.call", { tool: "Bash" }, ($, e) => {
    seen.push(e.command);
    return { result: {}, text: "ok", isReadOnly: true };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn({ prompt: "A", subagentType: "general-purpose" }));
  for (const command of [
    "kata comment c1 hello",
    "cd x && kata show c1",
    "echo kata",
    "kata --teammate explicit show c1",
  ])
    await (
      $.tool.call as import("claude-code/testing").EngineCall<"tool.call">
    )({ tool: "Bash", command, agentId: "a1", tool_use_id: "bash-" + command });
  expect(seen[0]).toMatch(
    /^kata --teammate general-purpose-[a-f0-9]{6} comment/,
  );
  expect(seen.slice(1)).toEqual([
    seen[0]!.split(" comment")[0]!.replace("kata", "cd x && kata") + " show c1",
    "echo kata",
    "kata --teammate explicit show c1",
  ]);
});
