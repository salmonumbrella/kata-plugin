import { test, expect } from "claude-code/testing";
import { harness, start, spawn, command, canonicalContract } from "./support.ts";
import type { EngineCall } from "claude-code/testing";
import { claimedRef, parseKata } from "../hooks/commands.ts";

const userPrompt = async ($: import("claude-code/testing").Engine, text: string) =>
  ($.prompt.submit as EngineCall<"prompt.submit">)({ text, wait: false, origin: { kind: "composer" } });

test("first delegation creates labeled session parent from first prompt and typed boolean", async ($, on) => {
  const h = harness(on, "");
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  await $.session.start(start);
  await userPrompt($, "Build example\nwith tests " + "x".repeat(1600));
  await userPrompt($, "Later prompt must not replace it");
  expect(h.calls).toEqual([]);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  const creates = h.calls.filter(a => a[1] === "create");
  expect(creates.length).toBe(2);
  expect(creates[0]![2]).toBe("Claude session: Build example");
  expect(creates[0]).toContain("claude-session");
  expect(creates[0]).toContain("claude-session:s1");
  expect(creates[0]![creates[0]!.indexOf("--body") + 1]).toBe(("Build example\nwith tests " + "x".repeat(1600)).slice(0,1500) + "\n\nClaude session id: s1");
  expect(creates[1]![creates[1]!.indexOf("--parent") + 1]).toBe("fixture#c1");
  expect(h.calls.some(a => a[1] === "meta" && a[4] === "claude.auto_parent" && a[5] === "true" && a.includes("--json-value"))).toBe(true);
  expect(h.control.hints).toEqual([]);
  expect(h.control.toasts).toEqual([]);
});

test("parallel first delegates share one automatic parent", async ($, on) => {
  const h = harness(on, ""); let n = 0;
  on("agent.spawn", () => ({model: "sonnet", agentId: "a" + ++n}));
  await $.session.start(start);
  await Promise.all([$.agent.spawn(spawn()), $.agent.spawn(spawn({tool_use_id: "t2"}))]);
  await h.clock.settle();
  expect(h.calls.filter(a => a.includes("claude-session:s1")).length).toBe(1);
  expect(h.calls.filter(a => a.includes("--parent") && a.includes("fixture#c1")).length).toBe(2);
});

const bindingTurn = { turnId: "retry", answer: "ok", reason: "answer" as const, durationMs: 1, isAborted: false };

test("session without delegation creates nothing and displays nothing", async ($, on) => {
  const h = harness(on, "");
  await $.session.start(start); await userPrompt($, "Answer hello"); await $.turn.complete(bindingTurn);
  expect(h.calls).toEqual([]); expect(h.control.hints).toEqual([]);
});

test("no Kata project disables automatic tracking for rest of session", async ($, on) => {
  const h = harness(on, ""); h.control.project = false;
  on("agent.spawn", ($, e) => { expect(e.prompt).toBe("Original"); return {model:"sonnet",agentId:"a1"}; });
  await $.session.start(start); await $.agent.spawn(spawn()); h.control.project = true;
  await $.agent.spawn(spawn({tool_use_id:"t2"})); await $.turn.complete(bindingTurn);
  expect(h.calls.filter(a => a[1] === "list").length).toBe(1);
  expect(h.calls.filter(a => a[1] !== "list")).toEqual([]);
  expect(h.control.hints).toEqual([]);
});

test("resume preserves automatic parent and clear creates a separate parent", async ($, on) => {
  const h = harness(on, ""); on("agent.spawn", () => ({model:"sonnet",agentId:"a1"}));
  await $.session.start(start); await userPrompt($, "Original session"); await $.agent.spawn(spawn());
  await $.session.start(start); await userPrompt($, "Resumed"); await $.agent.spawn(spawn({tool_use_id:"t2"}));
  expect(h.calls.filter(a => a.includes("claude-session:s1")).length).toBe(1);
  h.control.sessionId = "s2"; await userPrompt($, "New session"); await $.agent.spawn(spawn({tool_use_id:"t3"}));
  expect(h.calls.some(a => a.includes("claude-session:s2") && a[2] === "Claude session: New session")).toBe(true);
});

const claim = async ($: import("claude-code/testing").Engine, cmd: string) =>
  ($.tool.call as EngineCall<"tool.call">)({tool: "Bash", command: cmd, tool_use_id: cmd});

test("successful real claim adopts automatic parent and routes subsequent children", async ($, on) => {
  const h = harness(on, ""); on("agent.spawn", () => ({model:"sonnet",agentId:"a1"}));
  on("tool.call", {tool:"Bash"}, () => ({result:{},text:"meta set real work.attention rev-2"}));
  await $.session.start(start); await $.agent.spawn(spawn());
  await claim($, "kata --project fixture meta set real work.attention ok");
  await $.agent.spawn(spawn({tool_use_id:"t2"})); await h.clock.settle();
  expect(h.calls.some(a => a[1] === "edit" && a[2] === "fixture#c1" && a[a.indexOf("--parent")+1] === "fixture#real")).toBe(true);
  expect(h.calls.some(a => a[1] === "create" && a[a.indexOf("--parent")+1] === "fixture#real")).toBe(true);
  expect((await $.command.run(command())).text).toContain("fixture#real");
});

test("failed adoption is retried and later claim is not accepted over explicit binding", async ($, on) => {
  const h = harness(on, ""); h.control.failEdit=1;
  on("agent.spawn", () => ({model:"sonnet",agentId:"a1"}));
  on("tool.call", {tool:"Bash"}, () => ({result:{},text:"claim real other"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await claim($,"kata claim real"); await h.clock.settle();
  await claim($,"kata claim other"); await $.turn.complete(bindingTurn); await h.clock.advance(1000);
  expect(h.calls.filter(a => a[1] === "edit").length).toBe(2);
  expect((await $.command.run(command())).text).toContain("Kata parent: fixture#real");
});

test("failed parent create retries idempotently on next delegation without orphan child", async ($, on) => {
  const h=harness(on, ""); h.control.failCreate=1;
  on("agent.spawn", () => ({model:"sonnet",agentId:"a1"}));
  await $.session.start(start); await $.agent.spawn(spawn()); expect(h.issues.size).toBe(0);
  await $.agent.spawn(spawn({tool_use_id:"t2"})); await h.clock.advance(1000); await h.clock.settle();
  expect(h.issues.size).toBe(3);
  expect(h.calls.filter(a => a.includes("claude-session:s1")).length).toBe(2);
});

test("explicit unbind suppresses lazy creation across resume", async ($, on) => {
  const h=harness(on, ""); on("agent.spawn", () => ({model:"sonnet",agentId:"a1"}));
  await $.session.start(start); await $.command.run(command("unbind")); await $.session.start(start); await $.agent.spawn(spawn());
  expect(h.calls).toEqual([]);
});

test("missing user prompt falls back to native session title", async ($, on) => {
  const h = harness(on, ""); on("agent.spawn", () => ({model:"sonnet",agentId:"a1"}));
  on("classic.SessionStart", () => ({}));
  await $.session.start(start);
  await $.classic.SessionStart({source:"startup",session_title:"Named session"});
  await $.agent.spawn(spawn());
  expect(h.calls.some(a => a[1] === "create" && a[2] === "Claude session: Named session")).toBe(true);
});

for (const kind of ["sdk", "bridge"] as const) test(`first ${kind} user prompt supplies automatic parent title`, async ($, on) => {
  const h=harness(on, ""); on("agent.spawn", () => ({model:"sonnet",agentId:"a1"}));
  await $.session.start(start);
  await ($.prompt.submit as EngineCall<"prompt.submit">)({text:"Task from " + kind,wait:false,origin:{kind}});
  await $.agent.spawn(spawn());
  expect(h.calls.some(a => a[1] === "create" && a[2] === "Claude session: Task from " + kind)).toBe(true);
});

test("transient failed project process allows a later recovery attempt", async ($, on) => {
 const h=harness(on, "");h.control.projectThrows=true;
 on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 await $.session.start(start);await $.agent.spawn(spawn());h.control.projectThrows=false;await $.agent.spawn(spawn({tool_use_id:"t2"}));await h.clock.advance(1000);await h.clock.settle();
 expect(h.calls.filter(a=>a[1]==="list").length).toBe(2);
 expect(h.issues.size).toBe(3);
});

test("old failed reparent cannot overwrite newer explicit bind", async ($,on)=>{
 const h=harness(on, "");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 h.control.failEdit=1;await $.command.run(command("bind real"));await h.clock.settle();
 await $.command.run(command("bind newer"));await h.clock.settle();
 await $.turn.complete(bindingTurn);await h.clock.advance(1000);await h.clock.settle();
 const edits=h.calls.filter(a=>a[1]==="edit");
 expect(edits.at(-1)![edits.at(-1)!.indexOf("--parent")+1]).toBe("fixture#newer");
});

test("title normalization precedes body truncation for long leading whitespace", async ($, on) => {
 const h=harness(on, "");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 await $.session.start(start);await userPrompt($,"\n".repeat(1600)+"Build actual task");await $.agent.spawn(spawn());
 expect(h.calls.some(a=>a[1]==="create"&&a[2]==="Claude session: Build actual task")).toBe(true);
});

test("main successful standalone claim binds and compound commands never bind", async ($, on) => {
  harness(on, "");
  on("tool.call", { tool: "Bash" }, () => ({
    result: {},
    text: "meta set issue1 work.attention rev-2",
  }));
  await $.session.start(start);
  for (const cmd of [
    "cd x && kata meta set issue1 work.attention ok",
    "echo kata claim issue1",
  ]) {
    await (
      $.tool.call as import("claude-code/testing").EngineCall<"tool.call">
    )({ tool: "Bash", command: cmd, tool_use_id: cmd });
    expect((await $.command.run(command())).text).toContain("unbound");
  }
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Bash",
    command: "kata meta set issue1 work.attention ok",
    tool_use_id: "binding",
  });
  expect((await $.command.run(command())).text).toContain("issue1");
});

test("explicit unbind prevents later environment rebinding on restart", async ($, on) => {
  harness(on);
  await $.session.start(start);
  await $.command.run(command("unbind"));
  await $.session.start(start);
  expect((await $.command.run(command())).text).toContain("unbound");
});

test("binding retains the explicit project of a successful claim", async ($, on) => {
  const h = harness(on, "");
  on("tool.call", { tool: "Bash" }, () => ({
    result: {},
    text: "claimed c123 by owner",
  }));
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  await $.session.start(start);
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Bash",
    command: "kata --project other claim c123",
    tool_use_id: "claim1",
  });
  await $.agent.spawn(spawn());
  const c = h.calls.find((a) => a[1] === "create")!;
  expect(c[c.indexOf("--parent") + 1]).toBe("other#c123");
});

test("clear does not reuse a previous session manual binding", async ($, on) => {
  const h = harness(on, "");
  await $.session.start(start);
  await $.command.run(command("bind fixture#old"));
  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: { id: "s1" },
  });
  h.control.sessionId = "s2";
  expect((await $.command.run(command())).text).toContain("unbound");
});

test("clear isolates reused entry and agent ids, including nested early replies", async ($, on) => {
  const h = harness(on);
  let n = 0;
  h.control.agents = [
    { id: "a1", description: "Task", type: "general-purpose", status: "idle" },
  ];
  on("agent.spawn", async () => {
    if (++n === 2) {
      h.control.agents[0]!.status = "completed";
      await $.turn.complete({
        agentId: "a1",
        turnId: "new-turn",
        answer: "New session reply",
        reason: "answer",
        durationMs: 10,
        isAborted: false,
      });
    }
    return { model: "sonnet", agentId: "a1" };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await $.session.end({
    reason: "clear",
    sessionId: "s1",
    resume: { id: "s1" },
  });
  h.control.sessionId = "s2";
  await $.agent.spawn(spawn());
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(0);
  expect(h.issues.get("c2")?.comments[0]?.body).toBe(
    "New session reply\n\n[claude:tool-1:completed:new-turn]",
  );
});

const verifiedTurn=(agentId?:string)=>({agentId,turnId:"done",answer:"All verification passed.",reason:"answer" as const,durationMs:1,isAborted:false});

test("clear without session.start refreshes canonical contract and closes a new automatic parent",async($,on)=>{
 const h=harness(on,"");let n=0;const prompts:string[]=[];
 on("agent.spawn",(_$,e)=>{prompts.push(e.prompt);return {model:"sonnet",agentId:"a"+ ++n};});on("tool.call",()=>({result:{},text:"passed"}));
 await $.session.start(start);
 for(const id of ["s1","s2"]){
  h.control.sessionId=id;await $.agent.spawn(spawn({tool_use_id:id}));await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a"+n,command:"pytest -q"});h.control.agents=[{id:"a"+n,type:"general-purpose",description:"Task",status:"completed"}];await $.turn.complete(verifiedTurn("a"+n));await $.turn.complete(verifiedTurn());await h.clock.settle();
 }
 expect(prompts[1]!.startsWith(canonicalContract)).toBe(true);expect(h.contractCalls.length).toBe(2);expect(h.issues.get("c3")?.issue.status).toBe("closed");
 expect((h.persisted.get("session/s2/binding/parent") as {cwd?:string}).cwd).toBe("/tmp/test");
});

test("global project flags after claim or metadata verbs bind their qualified issue",()=>{
 for(const command of ["kata claim abcd --project other","kata claim --project=other abcd","kata meta set abcd work.attention ok --project other"])
  expect(claimedRef(parseKata(command)!)).toBe("other#abcd");
});

test("new entries and pending operations retain qualified ref and original workspace",async($,on)=>{
 const h=harness(on,"fixture#root");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 const entry=h.persisted.get("session/s1/spawn/tool-1") as {ref:string;project:string;workspace:string};expect(entry.ref).toBe("fixture#c1");expect(entry.project).toBe("fixture");expect(entry.workspace).toBe("/tmp/test");
 const ops=[...h.persisted.entries()].filter(([k])=>k.includes("/op/")).map(([,v])=>v as {project?:string;workspace?:string});expect(ops.every(o=>o.project==="fixture"&&o.workspace==="/tmp/test")).toBe(true);
});

const named = (h: ReturnType<typeof harness>, id: string, metadata: Record<string, string | boolean> = {}, status = "open") =>
  h.issues.set(id, {issue: {short_id: id, status, revision: 1, metadata}, comments: [], labels: []});

test("first prompt naming an existing issue parents delegates there and creates no session issue", async ($, on) => {
  const h = harness(on, ""); named(h, "ab12");
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  await $.session.start(start);
  await userPrompt($, "You own Kata issue fixture#ab12 (parent fixture#root). Ship the parser fix.");
  await $.agent.spawn(spawn({prompt: "Write the parser tests", description: "Parser tests"}));
  await h.clock.settle();
  const creates = h.calls.filter(a => a[1] === "create");
  expect(creates.length).toBe(1);
  expect(creates[0]![creates[0]!.indexOf("--parent") + 1]).toBe("fixture#ab12");
  expect(h.calls.some(a => a.includes("claude-session"))).toBe(false);
  expect((await $.command.run(command())).text).toContain("Kata parent: fixture#ab12");
});

for (const [why, setup, note] of [
  ["missing", (h: ReturnType<typeof harness>) => { h.control.missing = ["zz99"]; }, "first prompt named fixture#zz99, but Kata has no such issue"],
  ["closed", (h: ReturnType<typeof harness>) => { named(h, "zz99", {}, "closed"); }, "first prompt named fixture#zz99, but it is closed"],
] as const) test(`first prompt naming a ${why} issue falls back to a session issue that says why`, async ($, on) => {
  const h = harness(on, ""); setup(h);
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  await $.session.start(start);
  await userPrompt($, "Kata issue: fixture#zz99. Ship the parser fix.");
  await $.agent.spawn(spawn());
  await h.clock.settle();
  const session = h.calls.find(a => a[1] === "create" && a.includes("claude-session"))!;
  expect(session[2]).toBe("Claude session: Kata issue: fixture#zz99");
  expect(session).toContain("claude.binding_note=" + note);
  expect(session[session.indexOf("--body") + 1]).toContain("Named issue not used: " + note);
});

test("session issue title is a short whole-word summary and the body keeps the prompt", async ($, on) => {
  const h = harness(on, ""); on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  const prompt = "https://github.com/Orange-County-AI/herdr-mcp/releases/tag/v0.5.0 this has release tags now, we have a modified verison of this on umbrle with executor, we can now replace it with the offiical nad update our n8n flow for this.";
  await $.session.start(start); await userPrompt($, prompt); await $.agent.spawn(spawn());
  const session = h.calls.find(a => a[1] === "create" && a.includes("claude-session"))!;
  expect(session[2]).toBe("Claude session: Herdr-mcp v0.5.0 this has release tags now");
  expect(session[session.indexOf("--body") + 1]).toBe(prompt + "\n\nClaude session id: s1");
});

test("long first sentence is cut at a clause or word boundary, never mid-word", async ($, on) => {
  const h = harness(on, ""); on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  await $.session.start(start);
  await userPrompt($, "Please can you refactor the evidence collector so that shell chains with heredocs are parsed once and cached");
  await $.agent.spawn(spawn());
  const title = h.calls.find(a => a[1] === "create" && a.includes("claude-session"))![2]!;
  expect(title).toBe("Claude session: Refactor the evidence collector so that shell chains");
});

// The 2026-10-19 eval: the lead made and claimed its own plan in one script,
// then named a plan child as the delegate's issue by bare short id.
test("a plan the lead claims in a compound script is adopted and its children bind spawns", async ($, on) => {
  const h = harness(on, "");
  for (const [id, parent] of [["kk4d", undefined], ["gfzd", "fixture#kk4d"], ["erjg", "fixture#kk4d"]] as const)
    h.issues.set(id, {issue: {short_id: id, qualified_id: `fixture#${id}`, status: "open", revision: 1, metadata: {}}, parent, comments: [], labels: []} as any);
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  on("tool.call", {tool: "Bash"}, () => ({result: {}, text: "P=kk4d F=gfzd T=erjg\nOK claim gfzd\nIssue: gfzd \"Implement\"\nOK claim kk4d\nIssue: kk4d \"Plan\""}));
  await $.session.start(start);
  await claim($, "set -e\nP=$(kata create plan --json | jq -r .issue.short_id)\nkata claim $F --agent; kata claim $P --agent");
  expect((await $.command.run(command())).text).toContain("fixture#kk4d");
  await $.agent.spawn(spawn({prompt: "Write the tests; this work is kata issue erjg (project fixture).", description: "Write tests"}));
  await h.clock.settle();
  expect(h.calls.some(a => a[1] === "create")).toBe(false);
  expect(h.calls.some(a => a.includes("claude-session"))).toBe(false);
});
