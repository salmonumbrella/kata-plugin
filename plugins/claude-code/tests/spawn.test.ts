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
