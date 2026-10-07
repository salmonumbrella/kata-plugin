import { test, expect } from "claude-code/testing";
import { harness, start, spawn, canonicalContract, command } from "./support.ts";

test("empty denied reason clears real message floor and failed close stays actionable",async($,on)=>{
 const h=harness(on);on("agent.spawn",()=>({deny:""}));h.control.throttleClose=5;await $.session.start(start);await $.agent.spawn(spawn({description:"D",prompt:"X"}));await h.clock.settle();
 const close=h.calls.find(a=>a[1]==="close")!;const message=close[close.indexOf("--message")+1]!;expect(message.replace(/\s+/g," ").trim().length).toBeGreaterThanOrEqual(60);
 expect(h.issues.get("c1")?.labels).toContain("needs-review");expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("denied-close-pending");
 const op=h.persisted.get("session/s1/op/spawn:tool-1:deny") as {ack?:boolean};expect(op.ack).not.toBe(true);
});

test("cold or busy parent and child creation completes before native spawn under its own budget",async($,on)=>{
 const h=harness(on,"");let prompt="";
 on("agent.spawn",(_$,e)=>{prompt=e.prompt;return {model:"sonnet",agentId:"a1"};});
 await $.session.start(start);h.control.processDelayMs=350;
 let done=false;const work=$.agent.spawn(spawn()).then(()=>{done=true;});
 await h.clock.advance(2900);expect(done).toBe(true);if(done)await work;
 expect(prompt.startsWith(canonicalContract+"\n\nKata: your work is tracked as fixture#c2 under fixture#c1.")).toBe(true);
 expect(h.persisted.get("session/s1/spawn/tool-1")).toMatchObject({ref:"fixture#c2",parent:"fixture#c1"});
});

test("configured spawn timeout bounds unavailable Kata while preserving pending intent",{options:{spawnCreateTimeoutMs:500}},async($,on)=>{
 const h=harness(on);let prompt="";on("agent.spawn",(_$,e)=>{prompt=e.prompt;return {model:"sonnet",agentId:"a1"};});
 await $.session.start(start);h.control.outage=true;
 let done=false;const work=$.agent.spawn(spawn()).then(()=>{done=true;});
 await h.clock.advance(600);expect(done).toBe(true);if(done)await work;
 expect(prompt).toContain("tracking is pending recovery");expect(h.persisted.has("session/s1/op/spawn:tool-1:create")).toBe(true);
});

test("spawn creates attributed child before native spawn and prepends identity", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", (_$, e) => {
    const create = h.calls.find(a => a[1] === "create")!;
    expect(create).toContain("--parent");
    expect(create).toContain("fixture#root");
    expect(create).toContain("--teammate");
    expect(create).toContain("claude-agent:s1:" + e.tool_use_id);
    expect(e.prompt).toContain("Kata: your work is tracked as fixture#c1 under fixture#root");
    expect(e.prompt).toContain("close fixture#c1 --done --message");
    return { model: "sonnet", agentId: "a1" };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn({prompt: "Original instruction", description: "Check parser"}));
});

test("nonproject session delegates with only a failed project read and no prompt changes", async ($, on) => {
  const h = harness(on, "");
  h.control.project = false;
  h.control.contractFailure = true;
  on("agent.spawn", (_$, e) => {
    expect(h.calls).toEqual([["kata", "list", "--limit", "1", "--json", "--workspace", "/tmp/test"]]);
    expect(e.prompt).toBe("Original");
    return { model: "sonnet", agentId: "a1" };
  });
  await $.session.start(start);
  expect((await $.agent.spawn(spawn())).agentId).toBe("a1");
});

test("denied spawn closes only its child as wontfix", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ deny: "permission rejected" }));
  await $.session.start(start);
  await $.agent.spawn(spawn({ prompt: "Try", description: "Denied" }));
  await h.clock.settle();
  expect(
    h.calls.some(
      (a) =>
        a[1] === "close" &&
        a.includes("--wontfix") &&
        a.some((v) => v.includes("permission rejected")),
    ),
  ).toBe(true);
});

test("parallel spawns preserve each child entry", async ($, on) => {
  const h = harness(on);
  let n = 0;
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a" + ++n }));
  await $.session.start(start);
  await Promise.all([
    $.agent.spawn(
      spawn({ prompt: "A", description: "Alpha", tool_use_id: "tool-alpha" }),
    ),
    $.agent.spawn(
      spawn({ prompt: "B", description: "Beta", tool_use_id: "tool-beta" }),
    ),
  ]);
  const r = await $.command.run(command());
  expect(r.text).toContain("c1");
  expect(r.text).toContain("c2");
  expect(h.issues.size).toBe(2);
});

test("native spawn waits for only the create round trip; identity writes run afterward", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  await $.session.start(start);
  await $.agent.spawn(spawn());
  expect(h.calls.filter(a=>a[1]!=="show").length).toBe(1);
  await h.clock.settle();
  expect(h.issues.get("c1")?.issue.metadata["claude.agent_id"]).toBe("a1");
});

const existing = (h: ReturnType<typeof harness>, id: string, metadata: Record<string, string | boolean> = {}, status = "open") =>
  h.issues.set(id, {issue: {short_id: id, status, revision: 1, metadata}, comments: [], labels: []});
const finalTurn = {agentId: "a1", turnId: "final", answer: "Fixed the parser and ran the tests.", reason: "answer" as const, durationMs: 1, isAborted: false};

for (const [where, input] of [
  ["prompt", {prompt: "Kata issue: fixture#ab12 (parent fixture#root). Fix the parser; then close fixture#cd34 --duplicate-of fixture#ab12.", description: "Fix parser"}],
  ["description", {prompt: "Fix the parser.", description: "Own fixture#ab12"}],
] as const) test(`spawn whose ${where} names an existing issue binds to it and creates no child`, async ($, on) => {
  const h = harness(on, ""); existing(h, "ab12");
  let prompt = "";
  on("agent.spawn", (_$, e) => { prompt = e.prompt; return {model: "sonnet", agentId: "a1"}; });
  await $.session.start(start);
  await $.agent.spawn(spawn(input));
  await h.clock.settle();
  expect(h.calls.filter(a => a[1] === "create")).toEqual([]);
  expect(prompt).toContain("Kata: your work is tracked as fixture#ab12 (the issue named in your task; no child issue was created)");
  expect(prompt).toContain("close fixture#ab12 --done");
  const meta = h.issues.get("ab12")!.issue.metadata;
  expect(meta).toMatchObject({"claude.agent_id": "a1", "claude.tool_use_id": "tool-1", "claude.session_id": "s1", "claude.status": "running", "claude.agent_type": "general-purpose"});
  expect(String(meta["claude.teammate"])).toMatch(/^general-purpose-/);
  expect(h.calls.some(a => a[1] === "meta" && a.some(v => v.startsWith("work.")))).toBe(false);
  await $.turn.complete(finalTurn); await h.clock.advance(1000); await h.clock.settle();
  const issue = h.issues.get("ab12")!;
  expect(issue.issue.status).toBe("open");
  expect(issue.issue.metadata["claude.status"]).toBe("completed");
  expect(issue.comments.some(c => c.body.includes("Fixed the parser and ran the tests."))).toBe(true);
  expect(issue.labels).toEqual([]);
  expect(h.calls.some(a => a[1] === "close")).toBe(false);
});

test("spawn naming no issue still creates an attributed child", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  await $.session.start(start); await $.agent.spawn(spawn({prompt: "Fix the parser", description: "Fix parser"}));
  const create = h.calls.find(a => a[1] === "create")!;
  expect(create[create.indexOf("--parent") + 1]).toBe("fixture#root");
  expect(create.some(a => a.startsWith("claude.binding_note="))).toBe(false);
});

for (const [why, setup, note] of [
  ["missing", (h: ReturnType<typeof harness>) => { h.control.missing = ["ab12"]; }, "named fixture#ab12 does not exist in Kata"],
  ["closed", (h: ReturnType<typeof harness>) => existing(h, "ab12", {}, "closed"), "named fixture#ab12 is closed"],
  ["busy", (h: ReturnType<typeof harness>) => existing(h, "ab12", {"claude.status": "running", "claude.tool_use_id": "other-tool"}), "named fixture#ab12 already tracks running agent other-tool"],
  ["ambiguous", () => {}, "several issues named (fixture#ab12, fixture#cd34) and none marked as owned"],
] as const) test(`spawn naming a ${why} issue falls back to a child and records why`, async ($, on) => {
  const h = harness(on); setup(h);
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  await $.session.start(start);
  await $.agent.spawn(spawn({prompt: why === "ambiguous" ? "Compare fixture#ab12 with fixture#cd34" : "Kata issue: fixture#ab12. Fix it."}));
  const create = h.calls.find(a => a[1] === "create")!;
  expect(create[create.indexOf("--parent") + 1]).toBe("fixture#root");
  expect(create).toContain("claude.binding_note=" + note);
  if (h.issues.get("ab12")) expect(h.issues.get("ab12")!.issue.metadata["claude.agent_id"]).toBeUndefined();
});

test("denied spawn bound to a named issue records the denial and never closes it", async ($, on) => {
  const h = harness(on); existing(h, "ab12");
  on("agent.spawn", () => ({deny: "permission rejected"}));
  await $.session.start(start); await $.agent.spawn(spawn({prompt: "You own fixture#ab12"})); await h.clock.settle();
  const issue = h.issues.get("ab12")!;
  expect(issue.issue.status).toBe("open");
  expect(issue.issue.metadata["claude.status"]).toBe("denied");
  expect(issue.comments.some(c => c.body.includes("permission rejected") && c.body.includes("left as it was"))).toBe(true);
  expect(h.calls.some(a => a[1] === "close" || a[1] === "create")).toBe(false);
});
