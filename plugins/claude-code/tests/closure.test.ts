import { test, expect } from "claude-code/testing";
import { harness, start, spawn } from "./support.ts";
import type { EngineCall } from "claude-code/testing";

const bash = (agentId = "a1", command = "pytest -q") => ({tool: "Bash" as const, tool_use_id: "bash-" + agentId, agentId, command});

const final = (agentId = "a1", turnId = "done") => ({agentId, turnId, answer: "Implemented the requested parser change and verified it with the project tests.", reason: "answer" as const, durationMs: 10, isAborted: false});

async function complete($: import("claude-code/testing").Engine, h: ReturnType<typeof harness>, id = "a1") {
  h.control.agents = [{id, description: "Task", type: "general-purpose", status: "completed"}];
  await $.turn.complete(final(id)); await h.clock.settle();
}

test("verified agent is reported then closed done with its own evidence and no review label", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  on("tool.call", {tool: "Bash"}, () => ({result: {stdout: "4 passed", stderr: "", interrupted: false}, text: "4 passed"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await h.clock.settle();
  h.issues.get("c1")!.labels.push("needs-review");
  await ($.tool.call as EngineCall<"tool.call">)(bash());
  await complete($, h);
  const close = h.calls.find(a => a[1] === "close")!;
  expect(close).toContain("--done"); expect(close).toContain("--test"); expect(close).toContain("pytest -q");
  expect(close[close.indexOf("--message") + 1]!.length).toBeGreaterThanOrEqual(40);
  expect(close).toContain("--teammate");
  expect(h.issues.get("c1")?.issue.status).toBe("closed");
  expect(h.issues.get("c1")?.labels).not.toContain("needs-review");
  expect(h.issues.get("c1")?.comments.length).toBe(1);
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("completed");
  expect(h.calls.findIndex(a => a[1] === "comment")).toBeLessThan(h.calls.findIndex(a => a[1] === "close"));
});

test("a sibling cannot inherit another agent's tests and Q&A stays open", async ($, on) => {
  const h = harness(on); let n = 0;
  on("agent.spawn", () => ({model: "sonnet", agentId: "a" + ++n}));
  on("tool.call", {tool: "Bash"}, () => ({result: {}, text: "pass"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await $.agent.spawn(spawn({tool_use_id: "tool-2", description: "Answer question"}));
  await ($.tool.call as EngineCall<"tool.call">)(bash());
  await complete($, h); await complete($, h, "a2");
  expect(h.issues.get("c1")?.issue.status).toBe("closed");
  expect(h.issues.get("c2")?.issue.status).toBe("open");
  expect(h.issues.get("c2")?.labels).toContain("needs-review");
});

test("tool evidence before spawn resolves persists through registration and restart", async ($, on) => {
  const h = harness(on);
  on("tool.call", {tool: "Bash"}, () => ({result: {}, text: "[main abc1234] parser fix"}));
  on("agent.spawn", async () => {
    await ($.tool.call as EngineCall<"tool.call">)(bash("a1", "git commit -m fix"));
    return {model: "sonnet", agentId: "a1"};
  });
  await $.session.start(start); await $.agent.spawn(spawn());
  await $.session.start(start); await complete($, h);
  const close = h.calls.find(a => a[1] === "close")!;
  expect(close).toContain("--commit"); expect(close).toContain("abc1234");
});

test("agent self-close is recorded without another report, label or close", async ($, on) => {
  const h = harness(on); on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await h.clock.settle();
  h.issues.get("c1")!.issue.status = "closed";
  await complete($, h);
  expect(h.issues.get("c1")?.comments.length).toBe(0);
  expect(h.calls.filter(a => a[1] === "close").length).toBe(0);
  expect((h.persisted.get("session/s1/spawn/tool-1") as {closedBy?: string}).closedBy).toBe("agent");
});

test("failed work has review label but never closes even with earlier evidence", async ($, on) => {
  const h = harness(on); on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  on("tool.call", {tool: "Bash"}, () => ({result: {}, text: "pass"}));
  await $.session.start(start); await $.agent.spawn(spawn());
  await ($.tool.call as EngineCall<"tool.call">)(bash());
  h.control.agents = [{id: "a1", description: "Task", type: "general-purpose", status: "failed"}];
  await $.turn.complete({...final(), reason: "error", answer: "Build failed"}); await h.clock.settle();
  expect(h.calls.filter(a => a[1] === "close").length).toBe(0);
  expect(h.issues.get("c1")?.labels).toContain("needs-review");
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("failed");
});

test("ambiguous successful close retries by reading the issue and never repeats the close", async ($, on) => {
  const h = harness(on); h.control.failCloseOnce = true;
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"})); on("tool.call", {tool: "Bash"}, () => ({result: {}, text: "pass"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await ($.tool.call as EngineCall<"tool.call">)(bash());
  await complete($, h); await $.turn.complete({...final(), agentId: undefined, turnId: "main"}); await h.clock.advance(1000);
  expect(h.calls.filter(a => a[1] === "close").length).toBe(1);
  expect(h.issues.get("c1")?.comments.length).toBe(1);
  expect((h.persisted.get("session/s1/spawn/tool-1") as {closedBy?: string}).closedBy).toBe("mod");
});

test("sibling throttle survives more than three windows and retries after sixty seconds", async ($, on) => {
  const h = harness(on); h.control.throttleClose = 4;
  on("agent.spawn", () => ({model: "sonnet", agentId: "a1"})); on("tool.call", {tool: "Bash"}, () => ({result: {}, text: "pass"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await ($.tool.call as EngineCall<"tool.call">)(bash());
  h.control.agents = [{id: "a1", description: "Task", type: "general-purpose", status: "completed"}];
  await $.turn.complete(final()); await h.clock.advance(0);
  expect(h.calls.filter(a => a[1] === "close").length).toBe(1);
  await h.clock.advance(59999); expect(h.calls.filter(a => a[1] === "close").length).toBe(1);
  for (let i = 0; i < 4; i++) await h.clock.advance(i === 0 ? 1 : 60000);
  expect(h.calls.filter(a => a[1] === "close").length).toBe(5);
  expect(h.issues.get("c1")?.issue.status).toBe("closed");
  expect(h.control.logs.some(l => l.text.includes("dropped"))).toBe(false);
});

test("unsuccessful Bash outcomes never supply commit proof",async($,on)=>{
 const h=harness(on); let n=0; let outcome:Record<string,unknown>={};
 on("agent.spawn",()=>({model:"sonnet",agentId:"a"+ ++n})); on("tool.call",{tool:"Bash"},()=>({result:outcome,text:"no SHA"}));
 await $.session.start(start);
 for(const value of [{exitCode:1},{timedOutAfterMs:5},{backgroundedByUser:true},{backgroundedByTurnAbort:true},{backgroundedToDeliverMessage:true},{error:"commit failed"},{interrupted:true},{backgroundTaskId:"b"},{returnCodeInterpretation:"nonzero"}]){
  outcome=value; await $.agent.spawn(spawn({tool_use_id:"t"+ (n+1)})); await ($.tool.call as EngineCall<"tool.call">)(bash("a"+n,"git commit -m fix")); await complete($,h,"a"+n);
 }
 expect(h.calls.filter(a=>a[1]==="close")).toEqual([]);
 expect(h.calls.filter(a=>a[0]==="git")).toEqual([]);
});

test("restored throttled close re-arms its deadline without any later turns", async($,on)=>{
 const reportId="spawn:t:completed:done";
 const h=harness(on,"fixture#root", {
  "session/s1/binding/parent": {id:"s1",parent:"fixture#root"},
  "session/s1/spawn/t": {ref:"c1",parent:"fixture#root",toolId:"t",teammate:"worker",status:"completed",statusEffect:reportId,evidence:{commits:[],prs:[],tests:["pytest -q"],written:[]},verification:{verified:true,failedChecks:[],evidence:{commits:[],prs:[],tests:["pytest -q"],written:[]}}},
  ["session/s1/op/"+reportId+":close"]: {id:reportId+":close",kind:"close",entry:"spawn",key:"t",attempts:0,notBefore:60000,body:"Completed parser work and verified all tests successfully.",marker:"[claude:t:close:done]"},
 });
 h.issues.set("c1",{issue:{short_id:"c1",status:"open",revision:1,metadata:{}},comments:[],labels:[]});
 await $.session.start(start); await h.clock.settle(); expect(h.calls.some(a=>a[1]==="close")).toBe(false);
 await h.clock.advance(60000); expect(h.issues.get("c1")?.issue.status).toBe("closed");
});

test("concurrent workers retain only their own original commit output",async($,on)=>{
 const h=harness(on); let n=0;
 on("tool.call",{tool:"Bash"},($,e)=>({result:{stdout:e.agentId==="a1"?"[main abc1234] own work":"[main def5678] other work",stderr:"",interrupted:false},text:""}));
 on("agent.spawn",async()=>{const agentId="a"+ ++n;await ($.tool.call as EngineCall<"tool.call">)(bash(agentId,"git commit -m change"));return {model:"sonnet",agentId};});
 await $.session.start(start);await $.agent.spawn(spawn());await $.agent.spawn(spawn({tool_use_id:"t2"}));
 await complete($,h);await complete($,h,"a2");
 const closes=h.calls.filter(a=>a[1]==="close");expect(closes[0]).toContain("abc1234");expect(closes[0]).not.toContain("def5678");expect(closes[1]).toContain("def5678");expect(closes[1]).not.toContain("abc1234");expect(h.calls.filter(a=>a[0]==="git")).toEqual([]);
});

const toolCall=(tool:string,fields:Record<string,unknown>)=>({tool,tool_use_id:"obs",agentId:"a1",...fields});

const resultTurn=(answer="Implemented parser and verified all required checks.")=>({agentId:"a1",turnId:"done",answer,reason:"answer" as const,durationMs:10,isAborted:false});

async function finish($:import("claude-code/testing").Engine,h:ReturnType<typeof harness>, answer?:string){h.control.agents=[{id:"a1",description:"Task",type:"general-purpose",status:"completed"}];await $.turn.complete(resultTurn(answer));await h.clock.settle();}

for(const tool of ["Read","Write","Edit","NotebookEdit","Glob","Grep"]){
 test(`${tool} activity alone cannot verify completion`,async($,on)=>{
  const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
  on("tool.call",()=>({result:{filenames:["/tmp/test/source.py"]},text:"ok"}));
  await $.session.start(start);await $.agent.spawn(spawn());
  await ($.tool.call as EngineCall<"tool.call">)(toolCall(tool,{file_path:"/tmp/test/source.py",notebook_path:"/tmp/test/book.ipynb",pattern:"*"}) as Parameters<EngineCall<"tool.call">>[0]);await finish($,h);
  expect(h.issues.get("c1")?.issue.status).toBe("open");expect(h.issues.get("c1")?.labels).toContain("needs-review");
 });
}

test("read followed by failed verification and incomplete final answer stays open",async($,on)=>{
 const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 on("tool.call",{tool:"Read"},()=>({result:{},text:"source"}));
 on("tool.call",{tool:"Bash"},()=>({isError:true,result:{exitCode:1},text:"tests failed"}));
 await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)(toolCall("Read",{file_path:"/tmp/test/source.py"}) as Parameters<EngineCall<"tool.call">>[0]);
 await ($.tool.call as EngineCall<"tool.call">)(toolCall("Bash",{command:"pytest -q"}) as Parameters<EngineCall<"tool.call">>[0]);await finish($,h,"Tests failed; implementation remains incomplete.");
 expect(h.issues.get("c1")?.issue.status).toBe("open");expect(h.issues.get("c1")?.labels).toContain("needs-review");
});

test("passing test before the last write does not verify the changed artifact",async($,on)=>{
 const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{},text:"ok"}));
 await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)(toolCall("Bash",{command:"pytest -q"}) as Parameters<EngineCall<"tool.call">>[0]);await ($.tool.call as EngineCall<"tool.call">)(toolCall("Write",{file_path:"/tmp/test/source.py"}) as Parameters<EngineCall<"tool.call">>[0]);await finish($,h);
 expect(h.issues.get("c1")?.issue.status).toBe("open");
});

for(const repair of [undefined,"cargo test","pytest -q"]){
 test(`failed check veto persists until the same check passes (${repair??"none"})`,async($,on)=>{
  const h=harness(on);let failed=false;on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>failed?({isError:true as const,result:{exitCode:1},text:"output"}):({result:{exitCode:0},text:"output"}));
  await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)(toolCall("Bash",{command:"pytest -q"}) as Parameters<EngineCall<"tool.call">>[0]);failed=true;await ($.tool.call as EngineCall<"tool.call">)(toolCall("Bash",{command:"pytest -q"}) as Parameters<EngineCall<"tool.call">>[0]);failed=false;
  if(repair)await ($.tool.call as EngineCall<"tool.call">)(toolCall("Bash",{command:repair}) as Parameters<EngineCall<"tool.call">>[0]);await finish($,h);
  expect(h.issues.get("c1")?.issue.status).toBe(repair==="pytest -q"?"closed":"open");
 });
}

for(const answer of ["Tests failed; implementation remains incomplete.","Work is not complete yet.","The build failed and more work remains.","I could not finish the requested implementation."]){
 test(`failed or incomplete final result vetoes earlier proof: ${answer}`,async($,on)=>{
  const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{},text:"ok"}));await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)(toolCall("Bash",{command:"pytest"}) as Parameters<EngineCall<"tool.call">>[0]);await finish($,h,answer);expect(h.issues.get("c1")?.issue.status).toBe("open");
 });
}

test("quiet git commit cannot acquire another worker's later HEAD",async($,on)=>{
 const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{stdout:"",exitCode:0},text:""}));await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)(toolCall("Bash",{command:"git commit -qm change"}) as Parameters<EngineCall<"tool.call">>[0]);await finish($,h);expect(h.calls.filter(a=>a[0]==="git")).toEqual([]);expect(h.issues.get("c1")?.issue.status).toBe("open");
});

const reportedTurn=(answer:string)=>({agentId:"a1",turnId:"done",answer,reason:"answer" as const,durationMs:1,isAborted:false});

test("final failure beyond report length cap cannot disappear",async($,on)=>{
 const h=harness(on);on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{},text:"pass"}));await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a1",command:"pytest -q"});h.control.agents=[{id:"a1",type:"general-purpose",description:"Task",status:"completed"}];await $.turn.complete(reportedTurn("Details. ".repeat(700)+"Tests failed; implementation remains incomplete."));await h.clock.settle();expect(h.issues.get("c1")?.issue.status).toBe("open");expect(h.issues.get("c1")?.labels).toContain("needs-review");
});

test("activity during delayed queued close invalidates its stale completion",async($,on)=>{
 const h=harness(on);let fail=false;on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>fail?{isError:true as const,result:{exitCode:1},text:"failed"}:{result:{exitCode:0},text:"passed"});await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a1",command:"pytest -q"});h.control.agents=[{id:"a1",type:"general-purpose",description:"Task",status:"completed"}];await $.turn.complete(reportedTurn("Done and verified."));
 let injected=false;h.control.beforeRun=async args=>{if(args[1]==="show" && args[2]==="fixture#c1" && [...h.persisted.values()].some(v=>(v as {kind?:string;attempts?:number}).kind==="close" && ((v as {attempts?:number}).attempts ?? 0)>0) && !injected){injected=true;fail=true;h.control.agents=[{id:"a1",type:"general-purpose",description:"Task",status:"running"}];await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"failed",agentId:"a1",command:"pytest -q"});}};
 await h.clock.settle();expect(injected).toBe(true);expect(h.issues.get("c1")?.issue.status).toBe("open");
});
