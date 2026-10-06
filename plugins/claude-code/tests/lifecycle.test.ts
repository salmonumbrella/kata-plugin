import { test, expect } from "claude-code/testing";
import { resumedTurn, harness, start, spawn } from "./support.ts";
import type { TurnCompleteInput, AgentStatus } from "claude-code";

const agentTurn = (
  agentId = "a1",
  turnId = "turn-1",
  answer = "Final reply",
): TurnCompleteInput => ({
  agentId,
  turnId,
  answer,
  reason: "answer",
  durationMs: 100,
  isAborted: false,
});

test("idle turn stores reply but writes no terminal report", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  h.control.agents = [
    { id: "a1", description: "Task", type: "general-purpose", status: "idle" },
  ];
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  const before = h.calls.length;
  await $.turn.complete(agentTurn());
  await h.clock.settle();
  expect(h.calls.filter((a) => a[1] === "comment").length).toBe(0);
  expect(h.calls.slice(before).filter((a) => a[1] !== "show").length).toBe(0);
});

test("completed agent reports once per turn, labels review and resumes for later turns", async ($, on) => {
  const h = harness(on);
  let status: AgentStatus = "completed";
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  h.control.agents = [
    { id: "a1", description: "Task", type: "general-purpose", status },
  ];
  on("tool.call", { tool: "Bash" }, () => ({ result: {}, text: "ok" }));
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await $.turn.complete(agentTurn());
  await $.turn.complete(agentTurn());
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(1);
  expect(h.issues.get("c1")?.comments[0]?.body).toContain("Final reply");
  expect(h.issues.get("c1")?.labels).toContain("needs-review");
  status = "running";
  h.control.agents[0]!.status = status;
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Bash",
    command: "true",
    tool_use_id: "bash1",
    agentId: "a1",
  });
  await h.clock.settle();
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("running");
  status = "completed";
  h.control.agents[0]!.status = status;
  await $.turn.complete(agentTurn("a1", "turn-2", "Second reply"));
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(2);
});

for (const status of ["completed", "failed", "killed"] as const)
  test(`self-closed child records terminal ${status} without changing agent-owned metadata or closure`, async ($, on) => {
    const h = harness(on);
    on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
    on("tool.call", { tool: "Bash" }, () => ({ result: {}, text: "ok" }));
    h.control.agents = [{ id: "a1", description: "Task", type: "general-purpose", status }];
    await $.session.start(start);
    await $.agent.spawn(spawn());
    await h.clock.settle();
    const child = h.issues.get("c1")!;
    child.issue.status = "closed";
    child.issue.metadata["work.attention"] = "agent-owned";
    const n = h.calls.length;
    await $.turn.complete({ ...agentTurn(), reason: status === "failed" ? "error" : status === "killed" ? "aborted" : "answer" });
    await h.clock.settle();
    expect(child.issue.metadata["claude.status"]).toBe(status);
    expect(child.issue.status).toBe("closed");
    expect(child.issue.metadata["work.attention"]).toBe("agent-owned");
    expect(h.calls.slice(n).filter(a => a[1] !== "show").map(a => a.slice(1, 6))).toEqual([
      ["meta", "set", "fixture#c1", "claude.status", status],
    ]);
    // A later activity observation must not replace a closed terminal status with running.
    h.control.agents[0]!.status = "running";
    await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
      tool: "Bash", command: "true", tool_use_id: "late", agentId: "a1",
    });
    await h.clock.settle();
    expect(child.issue.metadata["claude.status"]).toBe(status);
  });

test("a stale completed report cannot overwrite a newer failed verdict on a self-closed child", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  h.control.agents = [{ id: "a1", description: "Task", type: "general-purpose", status: "completed" }];
  await $.session.start(start); await $.agent.spawn(spawn()); await h.clock.settle();
  const child = h.issues.get("c1")!;
  child.issue.status = "closed";
  await $.turn.complete(agentTurn("a1", "old"));
  h.control.agents[0]!.status = "failed";
  await $.turn.complete({ ...agentTurn("a1", "new"), reason: "error" });
  await h.clock.settle();
  expect(child.issue.metadata["claude.status"]).toBe("failed");
  expect(h.calls.filter(a => a[1] === "meta" && a[4] === "claude.status" && a[5] === "completed")).toEqual([]);
});

test("failed agent reports error and stays open", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  h.control.agents = [
    {
      id: "a1",
      description: "Task",
      type: "general-purpose",
      status: "failed",
    },
  ];
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await $.turn.complete({ ...agentTurn(), reason: "error", answer: "API failed" });
  await h.clock.settle();
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("failed");
  expect(h.issues.get("c1")?.comments[0]?.body).toContain("API failed");
  expect(h.issues.get("c1")?.issue.status).toBe("open");
});

test("ambiguous comment success is deduplicated by marker on retry", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  h.control.agents = [
    {
      id: "a1",
      description: "Task",
      type: "general-purpose",
      status: "completed",
    },
  ];
  h.control.failCommentOnce = true;
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.advance(1000);
  await $.turn.complete(agentTurn());
  await h.clock.advance(1000);
  await $.turn.complete({ ...agentTurn("a1", "main-retry"), agentId: undefined });
  await h.clock.advance(1000);
  expect(h.issues.get("c1")?.comments.length).toBe(1);
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("completed");
});

test("foreground final reply remains attributed when native agent list has already removed it", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await $.turn.complete(agentTurn());
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments[0]?.body).toBe(
    "Final reply\n\n[claude:tool-1:completed:turn-1]",
  );
});

test("foreground tool fallback waits for the concurrently delivered real final turn", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Agent" }, async () => {
    await $.agent.spawn(spawn());
    return { result: { status: "completed" }, text: "Wrapped fallback reply" };
  });
  await $.session.start(start);
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Agent",
    tool_use_id: "tool-1",
    description: "Task",
    prompt: "Original",
    subagent_type: "general-purpose",
  });
  await $.turn.complete(agentTurn("a1", "real-final", "Exact reply"));
  await h.clock.advance(250);
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.map((c) => c.body)).toEqual([
    "Exact reply\n\n[claude:tool-1:completed:real-final]",
  ]);
});

test("foreground fallback remains available and a late final turn does not duplicate it", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Agent" }, async () => {
    await $.agent.spawn(spawn());
    return { result: { status: "completed" }, text: "Fallback reply" };
  });
  await $.session.start(start);
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Agent",
    tool_use_id: "tool-1",
    description: "Task",
    prompt: "Original",
    subagent_type: "general-purpose",
  });
  await h.clock.advance(250);
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(1);
  await $.turn.complete(agentTurn("a1", "late-final", "Exact reply"));
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(1);
});

test("fallback does not reuse an earlier idle answer when the final turn is delayed", async ($, on) => {
  const h = harness(on);
  h.control.agents = [
    { id: "a1", description: "Task", type: "general-purpose", status: "idle" },
  ];
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Agent" }, async () => {
    await $.agent.spawn(spawn());
    await $.turn.complete(agentTurn("a1", "idle-turn", "Earlier idle reply"));
    return { result: { status: "completed" }, text: "Actual final fallback" };
  });
  await $.session.start(start);
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Agent",
    tool_use_id: "tool-1",
    description: "Task",
    prompt: "Original",
    subagent_type: "general-purpose",
  });
  await h.clock.advance(250);
  await h.clock.settle();
  h.control.agents = [];
  await $.turn.complete(agentTurn("a1", "late-real-final", "Actual final reply"));
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.map((c) => c.body)).toEqual([
    "Actual final fallback\n\n[claude:tool-1:completed:tool-1]",
  ]);
});

test("early nested reply preserves its content and original turn id", async ($, on) => {
  const h = harness(on);
  h.control.agents = [
    {
      id: "a1",
      description: "Task",
      type: "general-purpose",
      status: "completed",
    },
  ];
  on("agent.spawn", async () => {
    await $.turn.complete(resumedTurn());
    return { model: "sonnet", agentId: "a1" };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.map(c => c.body)).toEqual([
    "Exact early final\n\n[claude:tool-1:completed:turn1]",
  ]);
  expect(h.calls.find(a => a[1] === "comment")?.[3]).toBe("--body");
});

test("an old failed report cannot overwrite a successful later resume", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  on("tool.call", { tool: "Bash" }, () => ({ result: {}, text: "ok" }));
  h.control.agents = [
    {
      id: "a1",
      description: "Task",
      type: "general-purpose",
      status: "completed",
    },
  ];
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  h.control.failMeta = 1;
  await $.turn.complete(resumedTurn());
  await h.clock.settle();
  h.control.agents[0]!.status = "running";
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Bash",
    command: "true",
    agentId: "a1",
    tool_use_id: "resume1",
  });
  await h.clock.settle();
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("running");
  h.control.agents[0]!.status = "idle";
  await $.turn.complete({ ...resumedTurn(), agentId: undefined });
  await h.clock.settle();
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("running");
});
