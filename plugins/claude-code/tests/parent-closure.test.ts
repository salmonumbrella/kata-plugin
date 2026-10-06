import { test, expect } from "claude-code/testing";
import { harness, start, spawn } from "./support.ts";
import type { EngineCall } from "claude-code/testing";

const bash = (agentId = "a1", command = "pytest -q") => ({tool: "Bash" as const, tool_use_id: "bash-" + agentId, agentId, command});

const final = (agentId = "a1", turnId = "done") => ({agentId, turnId, answer: "Implemented the requested parser change and verified it with the project tests.", reason: "answer" as const, durationMs: 10, isAborted: false});

async function complete($: import("claude-code/testing").Engine, h: ReturnType<typeof harness>, id = "a1") {
  h.control.agents = [{id, description: "Task", type: "general-purpose", status: "completed"}];
  await $.turn.complete(final(id)); await h.clock.settle();
}

test("automatic parent closes after all closed children and the delegating turn finishes", async ($, on) => {
  const h = harness(on, ""); let n = 0;
  on("agent.spawn", () => ({model: "sonnet", agentId: "a" + ++n})); on("tool.call", {tool: "Bash"}, () => ({result: {}, text: "pass"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await ($.tool.call as EngineCall<"tool.call">)(bash()); await complete($, h);
  expect(h.issues.get("c1")?.issue.status).toBe("open");
  await $.agent.spawn(spawn({tool_use_id: "tool2", description: "Check another file"})); await ($.tool.call as EngineCall<"tool.call">)(bash("a2", "cargo test")); await complete($, h, "a2");
  await $.turn.complete({...final(), agentId: undefined, turnId: "main"}); await h.clock.settle();
  expect(h.issues.get("c1")?.issue.status).toBe("closed");
  const close = h.calls.filter(a => a[1] === "close").at(-1)!;
  expect(close[2]).toBe("fixture#c1"); expect(close).toContain("pytest -q"); expect(close).toContain("cargo test");
  expect(close[close.indexOf("--message") + 1]).toContain("2 child issues");
});

test("automatic parent with an unverified Q&A child stays open", async ($, on) => {
  const h = harness(on, ""); on("agent.spawn", () => ({model: "sonnet", agentId: "a1"}));
  await $.session.start(start); await $.agent.spawn(spawn()); await complete($, h);
  await $.turn.complete({...final(), agentId: undefined}); await h.clock.settle();
  expect(h.issues.get("c1")?.issue.status).toBe("open"); expect(h.issues.get("c2")?.issue.status).toBe("open");
  expect(h.issues.get("c2")?.labels).toContain("needs-review");
});

test("session start reconciles ended automatic parents only in the same folder", async ($, on) => {
  const proof = {commits: [], prs: [], tests: ["pytest -q"], written: []};
  const h = harness(on, "", {
    "session/old/binding/parent": {id: "old", parent: "old-parent", autoParent: "old-parent", cwd: "/tmp/test", ended: true},
    "session/old/spawn/t": {ref: "old-child", toolId: "t", teammate: "worker", parent: "old-parent", status: "completed", evidence: proof, verification:{evidence:proof,verified:true,failedChecks:[]}},
    "session/other/binding/parent": {id: "other", parent: "other-parent", autoParent: "other-parent", cwd: "/elsewhere", ended: true},
  });
  h.issues.set("old-parent", {issue: {short_id: "old-parent", status: "open", revision: 1, metadata: {"claude.auto_parent": true}}, comments: [], labels: []});
  h.issues.set("old-child", {issue: {short_id: "old-child", status: "closed", revision: 1, metadata: {}}, parent:"fixture#old-parent", comments: [], labels: []});h.recordClose("old-child");
  await $.session.start(start); await h.clock.settle();
  expect(h.calls.some(a => a[1] === "close" && a[2] === "old-parent")).toBe(true);
  expect(h.calls.some(a => a.includes("other-parent"))).toBe(false);
});

test("parent closure sees an externally open child and waits without dropping the effect", async ($, on) => {
  const proof={commits: [], prs: [], tests: ["pytest"], written: []};
  const h = harness(on, "", {"session/old/binding/parent": {id: "old", autoParent: "old-parent", parent: "old-parent", cwd: "/tmp/test", ended: true}, "session/old/spawn/t": {ref: "old-child", parent: "old-parent", toolId: "t", teammate: "worker", status: "completed", evidence: proof, verification:{evidence:proof,verified:true,failedChecks:[]}}});
  h.issues.set("old-parent", {issue: {short_id: "old-parent", status: "open", revision: 1, metadata: {"claude.auto_parent": true}}, comments: [], labels: []});
  h.issues.set("old-child", {issue: {short_id: "old-child", status: "open", revision: 1, metadata: {}}, parent:"fixture#old-parent", comments: [], labels: []});
  for (let i = 0; i < 4; i++) { await $.session.start(start); await h.clock.settle(); }
  expect(h.issues.get("old-parent")?.issue.status).toBe("open"); expect(h.control.logs.some(l => l.text.includes("dropped"))).toBe(false);
  h.recordClose("old-child");
  await $.session.start(start); await h.clock.settle();
  expect(h.issues.get("old-parent")?.issue.status).toBe("closed");
});

test("a later delegation reopens only its automatic parent and the larger cohort closes again", async ($,on)=>{
 const h=harness(on, ""); let n=0;
 on("agent.spawn",()=>({model:"sonnet",agentId:"a"+ ++n})); on("tool.call",{tool:"Bash"},()=>({result:{},text:"pass"}));
 await $.session.start(start); await $.agent.spawn(spawn()); await ($.tool.call as EngineCall<"tool.call">)(bash()); await complete($,h);
 await $.turn.complete({...final(),agentId:undefined}); await h.clock.settle(); expect(h.issues.get("c1")?.issue.status).toBe("closed");
 await $.agent.spawn(spawn({tool_use_id:"t2"})); await h.clock.settle(); expect(h.issues.get("c1")?.issue.status).toBe("open");
 await ($.tool.call as EngineCall<"tool.call">)(bash("a2", "go test ./...")); await complete($,h,"a2");
 await $.turn.complete({...final(),agentId:undefined,turnId:"main2"}); await h.clock.settle(); expect(h.issues.get("c1")?.issue.status).toBe("closed");
 expect(h.calls.filter(a=>a[1]==="close" && a[2]==="fixture#c1").length).toBe(2);
 expect(h.calls.filter(a=>a[1]==="close" && a[2]==="fixture#c1").at(-1)).toContain("go test ./...");
});

declare function setTimeout(callback: () => void, delay: number): unknown;

test("parent closure and a concurrent later spawn serialize before deciding to reopen",async($,on)=>{
 const h=harness(on, ""); let n=0;
 on("agent.spawn",()=>({model:"sonnet",agentId:"a"+ ++n})); on("tool.call",{tool:"Bash"},()=>({result:{},text:"pass"}));
 await $.session.start(start); await $.agent.spawn(spawn()); await ($.tool.call as EngineCall<"tool.call">)(bash()); await complete($,h);
 let releaseShow!:()=>void, releaseCreate!:()=>void, entered!:()=>void;
 const showGate=new Promise<void>(r=>{releaseShow=r}), createGate=new Promise<void>(r=>{releaseCreate=r}), ready=new Promise<void>(r=>{entered=r});
 let paused=false;
 h.control.beforeRun=async args=>{
  if(args[1]==="show" && args[2]==="fixture#c2" && !paused){paused=true;entered();await showGate;}
  if(args[1]==="create") await createGate;
 };
 const settling=$.turn.complete({...final(),agentId:undefined,turnId:"main"}).then(()=>h.clock.settle()); await ready;
 const spawning=$.agent.spawn(spawn({tool_use_id:"later",parentAgentId:"a1"}));
 await new Promise<void>(r=>setTimeout(r,100)); releaseShow(); await settling; releaseCreate(); await spawning; await h.clock.settle();
 expect(h.issues.get("c1")?.issue.status).toBe("open");
 await ($.tool.call as EngineCall<"tool.call">)(bash("a2","cargo test")); await complete($,h,"a2");
 await $.turn.complete({...final(),agentId:undefined,turnId:"main2"}); await h.clock.settle();
 expect(h.calls.filter(a=>a[1]==="close" && a[2]==="fixture#c1").at(-1)).toContain("cargo test");
});

const settlementTurn=(agentId?:string)=>({agentId,turnId:agentId??"lead",answer:"Finished and verified.",reason:"answer" as const,durationMs:1,isAborted:false});

test("terminal child notification invalidates prior lead settlement",async($,on)=>{
 const h=harness(on,"");let n=0;on("agent.spawn",()=>({model:"sonnet",agentId:"a"+ ++n}));on("tool.call",()=>({result:{exitCode:0},text:"passed"}));
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test1",agentId:"a1",command:"pytest -q"});
 await $.turn.complete(settlementTurn()); // lead paused awaiting the writer notification
 await $.turn.complete(settlementTurn("a1"));await h.clock.settle();
 expect(h.issues.get("c2")!.issue.status).toBe("closed");expect(h.issues.get("c1")!.issue.status).toBe("open");
 await $.agent.spawn(spawn({tool_use_id:"second"}));
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test2",agentId:"a2",command:"pytest -q"});
 await $.turn.complete(settlementTurn("a2"));await $.turn.complete(settlementTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe("closed");
 expect(h.calls.filter(a=>a[1]==="close"&&a[2]==="fixture#c1").length).toBe(1);
 expect(h.calls.filter(a=>a[1]==="reopen"&&a[2]==="fixture#c1").length).toBe(0);
});

const nativeStop=(busy=false)=>({session_id:"s1",transcript_path:"/tmp/transcript",cwd:"/tmp/test",hook_event_name:"Stop" as const,stop_hook_active:false,background_tasks:busy?[{id:"native-wf",type:"workflow",status:"running",description:"In flight"}]:[]});

for(const kind of ["native-background","native-agent"] as const)test(`settled local children still wait for ${kind}`,async($,on)=>{
 const h=harness(on,"");on("classic.Stop",()=>({}));on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{exitCode:0},text:"passed"}));
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a1",command:"pytest -q"});
 await $.turn.complete(settlementTurn("a1"));await h.clock.settle();
 if(kind==="native-background")await $.classic.Stop(nativeStop(true));
 else h.control.agents=[{id:"a1",status:"running",type:"general-purpose",description:"still delivering"}];
 await $.turn.complete(settlementTurn());await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("open");
 h.control.agents=kind==="native-agent"?[{id:"a1",status:"completed",type:"general-purpose",description:"finished"}]:[];await $.classic.Stop(nativeStop());if(kind==="native-agent")await $.turn.complete({...settlementTurn("a1"),turnId:"resumed"});await $.turn.complete(settlementTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe("closed");
});

test("verified named teammate receipt requires subsequent lead settlement",async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1",teammateId:"tester@session-s1"}));on("tool.call",()=>({result:{exitCode:0},text:"passed"}));on("session.receive",(_$,e)=>({text:e.text}));
 h.control.agents=[{id:"a1",name:"tester",teammateId:"tester@session-s1",status:"idle",description:"tester",type:"general-purpose"}];
 await $.session.start(start);await $.agent.spawn(spawn({name:"tester",background:true,isTeammate:true}));await h.clock.settle();
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a1",command:"pytest -q"});
 await $.turn.complete(settlementTurn("a1"));await $.turn.complete(settlementTurn());await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("open");
 await $.session.receive({origin:{kind:"peer",teammate:"tester",isVerified:true},text:JSON.stringify({type:"idle_notification",from:"tester",timestamp:"2026-10-06T01:09:39.493Z",idleReason:"available",result:settlementTurn().answer})});
 await h.clock.settle();expect(h.issues.get("c2")!.issue.status).toBe("closed");expect(h.issues.get("c1")!.issue.status).toBe("open");
 await $.turn.complete(settlementTurn());await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("closed");
});

test("a native busy update during parent reads aborts its close snapshot",async($,on)=>{
 const h=harness(on,"");on("classic.Stop",()=>({}));on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{exitCode:0},text:"passed"}));
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a1",command:"pytest -q"});await $.turn.complete(settlementTurn("a1"));await h.clock.settle();
 let injected=false;h.control.beforeRun=async args=>{if(!injected&&args[1]==="show"&&args[2]==="fixture#c1"){injected=true;await $.classic.Stop(nativeStop(true));}};
 await $.turn.complete(settlementTurn());await h.clock.settle();expect(injected).toBe(true);expect(h.issues.get("c1")!.issue.status).toBe("open");
 h.control.beforeRun=undefined;await $.classic.Stop(nativeStop());await $.turn.complete(settlementTurn());await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("closed");
});

test('review parent must reread in-flight workflow reservation after remote reads',async($,on)=>{
 const h=harness(on,'');on('agent.spawn',()=>({model:'sonnet',agentId:'a1'}));
 let resolveStarted!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>resolveStarted=r),gate=new Promise<void>(r=>release=r);
 on('tool.call',async(_$,e)=>{if(e.tool==='Workflow'){resolveStarted();await gate;return {result:{}};}return {result:{exitCode:0},text:'passed'};});
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await ($.tool.call as EngineCall<'tool.call'>)({tool:'Bash',tool_use_id:'test',agentId:'a1',command:'pytest -q'});
 await $.turn.complete(settlementTurn('a1'));await h.clock.settle();
 let injected=false,launch:Promise<unknown>|undefined;
 h.control.beforeRun=async args=>{if(!injected&&args[1]==='show'&&args[2]==='fixture#c1'){
  injected=true;launch=($.tool.call as EngineCall<'tool.call'>)({tool:'Workflow',tool_use_id:'pending-workflow',script:'return 1'});await started;
 }};
 await $.turn.complete(settlementTurn());await h.clock.settle();
 const pending=h.persisted.has('session/s1/launch/pending-workflow'),status=h.issues.get('c1')!.issue.status;
 release();await launch;
 expect(pending).toBe(true);expect(status).toBe('open');
});

for(const extra of [false,true])test(`coarse teammate task needs the complete idle roster (extra=${extra})`,async($,on)=>{
 const h=harness(on,"");on("classic.Stop",()=>({}));on("agent.spawn",()=>({model:"sonnet",agentId:"a1",teammateId:"tester@session-s1"}));on("tool.call",()=>({result:{exitCode:0},text:"passed"}));on("session.receive",(_$,e)=>({text:e.text}));
 h.control.agents=[{id:"a1",name:"tester",teammateId:"tester@session-s1",status:"idle",description:"tester",type:"general-purpose"}];
 await $.session.start(start);await $.agent.spawn(spawn({name:"tester",background:true,isTeammate:true}));await h.clock.settle();
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a1",command:"pytest -q"});await $.turn.complete(settlementTurn("a1"));
 await $.session.receive({origin:{kind:"peer",teammate:"tester",isVerified:true},text:JSON.stringify({type:"idle_notification",from:"tester",timestamp:"2026-10-06T01:09:39.493Z",idleReason:"available",result:settlementTurn().answer})});await h.clock.settle();
 const tasks=[{id:"opaque-task-1",type:"teammate",status:"running",description:"tester"}];if(extra)tasks.push({id:"unknown-task",type:"teammate",status:"pending",description:"unjoined"});
 await $.classic.Stop({...nativeStop(),background_tasks:tasks});await $.turn.complete(settlementTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe(extra?"open":"closed");
});

const closeMessage="Verified this child's work and recorded its specific completion evidence in Kata.";

const kataClosedTurn=(agentId?:string,answer="Finished.")=>({agentId,turnId:agentId??"lead",answer,reason:"answer" as const,durationMs:1,isAborted:false});

for(const localFailure of [false,true])test(`parent trusts Kata close despite local proof failure=${localFailure}`,async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{exitCode:1},text:"Tests failed"}));
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 if(localFailure)await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",agentId:"a1",tool_use_id:"bad",command:"pytest"});
 await h.kata(["kata","close","c2","--done","--message",closeMessage,"--commit","abcdef1","--pr","https://example.com/pr/1","--test","python3 -m unittest","--reviewed","source.py","--evidence","external:human verification"]);
 await $.turn.complete(kataClosedTurn("a1",localFailure?"Tests failed.":"Finished."));await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("open");
 await $.turn.complete(kataClosedTurn());await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("closed");
 const close=h.calls.find(a=>a[1]==="close"&&a[2]==="fixture#c1")!;
 for(const v of ["abcdef1","https://example.com/pr/1","python3 -m unittest","source.py","external:human verification"])expect(close).toContain(v);
 expect(h.calls.filter(a=>a[1]==="close"&&a[2]==="fixture#c1").length).toBe(1);
});

test("parent includes human-created children and accepts wontfix",async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await h.kata(["kata","close","c2","--wontfix","--message",closeMessage]);
 await h.kata(["kata","create","Human task","--parent","fixture#c1"]);
 await h.kata(["kata","close","c3","--done","--message",closeMessage+" Human-owned follow-up task.","--evidence","external:review performed by human"]);
 await $.turn.complete(kataClosedTurn("a1"));await $.turn.complete(kataClosedTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe("closed");expect(h.calls.find(a=>a[1]==="close"&&a[2]==="fixture#c1")!).toContain("external:review performed by human");
});

test("empty close evidence union needs review",async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await h.kata(["kata","close","c2","--wontfix","--message",closeMessage]);await $.turn.complete(kataClosedTurn("a1"));await $.turn.complete(kataClosedTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe("open");expect(h.issues.get("c1")!.labels).toContain("needs-review");
});

test("only the current child close contributes evidence",async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await h.kata(["kata","close","c2","--done","--message",closeMessage,"--commit","abcdef1"]);await h.kata(["kata","reopen","c2"]);
 await h.kata(["kata","close","c2","--done","--message",closeMessage,"--test","current test command"]);
 await $.turn.complete(kataClosedTurn("a1"));await $.turn.complete(kataClosedTurn());await h.clock.settle();
 const close=h.calls.find(a=>a[1]==="close"&&a[2]==="fixture#c1")!;expect(close).toBeDefined();expect(close).toContain("current test command");expect(close).not.toContain("abcdef1");
});

test("refused parent close is left open with needs-review",async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"})); h.control.rejectParentClose=true;
await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await h.kata(["kata","close","c2","--done","--message",closeMessage,"--test","own test"]);
 await $.turn.complete(kataClosedTurn("a1"));await $.turn.complete(kataClosedTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe("open");expect(h.issues.get("c1")!.labels).toContain("needs-review");
});

for(const equal of [true,false])test(`current close timestamps compare instants (equal=${equal})`,async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await h.kata(["kata","close","c2","--done","--message",closeMessage,"--test","current test"]);
 h.issues.get("c2")!.issue.closed_at="1970-01-01T00:00:00.1Z";
 h.events[0]!.payload.closed_at=equal?"1970-01-01T00:00:00.100Z":"1970-01-01T00:00:00.200Z";
 await $.turn.complete(kataClosedTurn("a1"));await $.turn.complete(kataClosedTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe(equal?"closed":"open");
});

for(const change of ["reopen","new-child"])test(`child membership changed during event reads blocks closure: ${change}`,async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await h.kata(["kata","close","c2","--done","--message",closeMessage,"--test","current proof"]);
 let injected=false;h.control.beforeRun=async args=>{if(!injected && args[1]==="events"){
  injected=true;
  if(change==="reopen")await h.kata(["kata","reopen","c2"]);
  else await h.kata(["kata","create","New human-owned child","--parent","fixture#c1"]);
 }};
 await $.turn.complete(kataClosedTurn("a1"));await $.turn.complete(kataClosedTurn());await h.clock.settle();
 expect(injected).toBe(true);expect(h.issues.get("c1")!.issue.status).toBe("open");
 expect(h.calls.filter(a=>a[1]==="close"&&a[2]==="fixture#c1").length).toBe(0);
 h.control.beforeRun=undefined;
 await h.kata(["kata","close",change==="reopen"?"c2":"c3","--done","--message",closeMessage+" Updated after the concurrent change.","--test","fresh proof"]);
 await $.turn.complete(kataClosedTurn());await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("closed");
});

for(const mode of ["closed-idle","open-idle","closed-running","closed-pending","closed-resumed"] as const)test(`joined messaging completion follows Kata closure and native lifecycle: ${mode}`,async($,on)=>{
 const h=harness(on,"");on("classic.Stop",()=>({}));on("agent.spawn",()=>({model:"sonnet",agentId:"a1",teammateId:"tester@session-s1"}));on("tool.call",()=>({result:{},text:"Sent"}));on("session.receive",(_$,e)=>({text:e.text}));
 h.control.agents=[{id:"a1",name:"tester",teammateId:"tester@session-s1",status:"idle",description:"tester",type:"general-purpose"}];
 await $.session.start(start);await $.agent.spawn(spawn({name:"tester",background:true,isTeammate:true}));await h.clock.settle();
 if(mode!=="open-idle")await h.kata(["kata","close","c2","--done","--message",closeMessage,"--test","actual child test"]);
 await ($.tool.call as EngineCall<"tool.call">)({tool:"SendMessage",tool_use_id:"sent",agentId:"a1",to:"team-lead",message:"Finished and self-closed."});
 await $.turn.complete(kataClosedTurn("a1","Finished and self-closed."));await $.turn.complete(kataClosedTurn());await h.clock.settle();
 await $.session.receive({origin:{kind:"peer",teammate:"tester",isVerified:true},text:JSON.stringify({type:"idle_notification",from:"tester",timestamp:"2026-10-06T17:34:56.258Z",idleReason:"available",result:"Finished and self-closed."})});await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe("open");
 if(mode==="closed-running"||mode==="closed-pending")h.control.agents[0]!.status=mode==="closed-running"?"running":"pending";
 if(mode==="closed-resumed")await ($.tool.call as EngineCall<"tool.call">)({tool:"Read",tool_use_id:"more-work",agentId:"a1",file_path:"/tmp/test/source.py"});
 await $.classic.Stop({session_id:"s1",transcript_path:"/tmp/transcript",cwd:"/tmp/test",stop_hook_active:false,background_tasks:[{id:"native-tester",type:"teammate",status:"running",description:"tester"}]});
 await $.turn.complete(kataClosedTurn());await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe(mode==="closed-idle"?"closed":"open");
 expect(h.calls.filter(a=>a[1]==="close"&&a[2]==="fixture#c1").length).toBe(mode==="closed-idle"?1:0);
});

for (const mode of ["normal","pending","queued","running"]) test(mode === "running" ? "automatic parent waits for the native child verdict after a manual close" : mode === "queued" ? "a queued primary closure follows its detached retained owner" : mode === "pending" ? "unprepared siblings prevent closure of a detached automatic parent" : "recovered isolated parent closes in its original workspace without changing the newer binding",async($,on)=>{
 const evidence={commits:[],prs:[],tests:["pytest -q"],written:[]};
 const h=harness(on,"",{
  "session/s1/binding/parent":{id:"s1",parent:"beta#real",cwd:"/tmp/test",workspace:"/new",project:"beta",autoParent:"alpha#auto",autoParentWorkspace:"/original",autoParentProject:"alpha",parentGeneration:1},
  "session/s1/retained-parent/alpha%23auto":{id:"s1",parent:"alpha#auto",autoParent:"alpha#auto",cwd:"/tmp/test",workspace:"/original",project:"alpha",mainActive:false,ended:true,parentGeneration:1},
  "session/s1/spawn/t":{ref:"alpha#child",parent:"alpha#auto",toolId:"t",teammate:"worker",status:"completed",closedBy:"agent",project:"alpha",workspace:"/original",evidence,verification:{evidence,verified:true,failedChecks:[]}},
 });
 h.issues.set("alpha#auto",{issue:{short_id:"auto",status:"open",revision:1,metadata:{"claude.auto_parent":true}},comments:[],labels:[]});
 h.issues.set("alpha#child",{issue:{short_id:"child",status:"closed",revision:1,metadata:{}},parent:"alpha#auto",comments:[],labels:[]});h.recordClose("alpha#child");
 if (mode === "queued") h.persisted.set("session/s1/op/session:s1:parent-close:alpha#auto:1",{id:"session:s1:parent-close:alpha#auto:1",kind:"parent-close",entry:"run",key:"session",ref:"alpha#auto",ownerSessionId:"s1",ownerBindingKey:"session/s1/binding/parent",workspace:"/original",project:"alpha",attempts:0,marker:"[claude:s1:parent-close]"});
 if (mode === "pending") h.persisted.set("session/s1/op/create:pending",{id:"create:pending",kind:"create",entry:"spawn",key:"pending",prepare:true,context:{id:"s1",cwd:"/tmp/test",workspace:"/original",project:"alpha"},workspace:"/original",attempts:0,notBefore:10000000000000});
 if (mode === "running") {
  const child=h.persisted.get("session/s1/spawn/t") as Record<string,unknown>;
  h.persisted.set("session/s1/spawn/t",{...child,status:"pending"});
 }
 await $.session.start(start);await h.clock.settle();
 if (["pending","running"].includes(mode)) {expect(h.issues.get("alpha#auto")?.issue.status).toBe("open");return;}
 expect(h.issues.get("alpha#auto")?.issue.status).toBe("closed");
 expect((h.persisted.get("session/s1/binding/parent") as {parent:string}).parent).toBe("beta#real");
 expect((h.persisted.get("session/s1/binding/parent") as {autoParentClosed?:boolean}).autoParentClosed).toBe(true);
 expect((h.persisted.get("session/s1/retained-parent/alpha%23auto") as {autoParentClosed?:boolean}).autoParentClosed).toBe(true);
 const close=h.processContexts.find(c=>c.args[1]==="close"&&c.args.includes("alpha#auto"));expect(close?.cwd).toBe("/original");expect(close?.args).toContain("alpha");
});

test("a recovered isolated automatic parent stays pinned after its child closes and session ends",async($,on)=>{
 const h=harness(on,"");h.control.projectThrows=true;
 on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 on("tool.call",{tool:"Bash"},()=>({result:{},text:"claimed fixture#newer"}));
 await $.session.start(start);await $.agent.spawn(spawn());
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"claim",command:"kata --workspace /tmp/other claim fixture#newer"});
 h.control.projectThrows=false;await h.clock.advance(8000);await h.clock.settle();
 h.issues.get("c2")!.issue.status="closed";
 const entry=h.persisted.get("session/s1/spawn/tool-1") as Record<string,unknown>;
 h.persisted.set("session/s1/spawn/tool-1",{...entry,closedBy:"agent",status:"completed"});
 h.issues.set("external",{issue:{short_id:"external",status:"open",revision:1,metadata:{}},parent:"fixture#c1",comments:[],labels:[]});
 for(let i=0;i<13;i++)h.persisted.set(`session/history-${i}/unknown/history`,{text:"x".repeat(250000)});
 h.control.sessionId="s2";await $.session.start(start);await h.clock.settle();
 expect(h.persisted.has("session/s1/spawn/tool-1")).toBe(true);
 const retained=h.persisted.get("session/s1/retained-parent/fixture%23c1") as {workspace?:string;autoParent?:string;autoParentClosed?:boolean};
 expect(retained?.autoParent).toBe("fixture#c1");expect(retained?.workspace).toBe("/tmp/test");expect(retained?.autoParentClosed).not.toBe(true);
 expect((h.persisted.get("session/s1/binding/parent") as {parent?:string;workspace?:string}).parent).toBe("fixture#newer");
});

const documentationTurn=(id="a1",answer="I verified the documentation for correctness and completeness.")=>({agentId:id,turnId:"done",answer,reason:"answer" as const,durationMs:1,isAborted:false});

test("session end closes a ready automatic parent before timers are discarded",async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));on("tool.call",()=>({result:{},text:"written"}));
 await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)({tool:"Write",tool_use_id:"doc",agentId:"a1",file_path:"/tmp/test/README.md",content:"docs"});await $.turn.complete(documentationTurn());await h.clock.settle();
 expect(h.issues.get("c2")?.issue.status).toBe("closed");expect(h.issues.get("c1")?.issue.status).toBe("open");
 await $.session.end({reason:"other",sessionId:"s1",resume:{id:"s1"}});
 expect(h.issues.get("c1")?.issue.status).toBe("closed");
});

const settledLead={turnId:"lead",answer:"Finished and verified.",reason:"answer" as const,durationMs:1,isAborted:false};

for(const trigger of ["lead-settle","shutdown","next-session"] as const)
 test(`reconciles actual closed children at ${trigger}`,async($,on)=>{
  const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
  on("tool.call",(_$,e)=>{if(e.tool==="Bash"&&e.command.includes("kata")&&e.command.includes("close"))h.recordClose("c2");return {result:{exitCode:0},text:"Success"};});
  await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
  await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"test",agentId:"a1",command:"pytest -q"});
  await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"close",agentId:"a1",command:"cd /tmp/test\nkata close fixture#c2 --done --message 'Verified delegated work and closed the actual child.' --test 'pytest -q'"});
  await h.clock.settle();
  expect(h.issues.get("c1")!.issue.status).toBe("open");
  await $.turn.complete({...settledLead,agentId:"a1",turnId:"child"});
  if(trigger==="lead-settle")await $.turn.complete(settledLead);
  if(trigger==="shutdown")await $.session.end({reason:"other",sessionId:"s1",resume:{id:"s1"}});
  if(trigger==="next-session"){h.control.sessionId="s2";await $.session.start(start);}
  await h.clock.settle();expect(h.issues.get("c1")!.issue.status).toBe("closed");
  const close=h.calls.find(a=>a[1]==="close"&&a[2]==="fixture#c1");expect(close).toContain("pytest -q");
 });

test("learns an agent's own close from the tool result before the final verdict",async($,on)=>{
 const h=harness(on,"");on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 on("tool.call",(_$,e)=>{if(e.tool==="Bash"&&e.command.includes("kata")&&e.command.includes(" close "))h.recordClose("c2");return {result:{exitCode:0},text:"closed"};});
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",agentId:"a1",tool_use_id:"own-close",command:"kata close fixture#c2 --done --message 'Own completed issue with evidence for the observer.' --test pytest"});
 await h.clock.settle();
 expect(h.issues.get("c2")!.issue.status).toBe("closed");
 expect((h.persisted.get("session/s1/spawn/tool-1") as {closedBy?:string}).closedBy).toBe("agent");
 expect(h.issues.get("c1")!.issue.status).toBe("open");
});

test("startup discovers a Kata automatic parent when its local binding is missing",async($,on)=>{
 const proof={commits:[],prs:[],tests:["pytest -q"],written:[]};
 const h=harness(on,"",{"session/old/spawn/t":{ref:"fixture#child",parent:"fixture#auto",toolId:"t",teammate:"worker",status:"completed",workspace:"/tmp/test",project:"fixture",evidence:proof,verification:{evidence:proof,verified:true,failedChecks:[]}}});
 const issue={short_id:"auto",qualified_id:"fixture#auto",status:"open",revision:1,metadata:{"claude.auto_parent":true,"claude.session_id":"old","claude.workspace":"/tmp/test"}};
 h.issues.set("auto",{issue,comments:[],labels:[]});h.issues.set("child",{issue:{short_id:"child",status:"closed",revision:1,metadata:{}},parent:"fixture#auto",comments:[],labels:[]});h.recordClose("child");
 await $.session.start(start);await h.clock.settle();
 expect(h.issues.get("auto")!.issue.status).toBe("closed");
});

test("same-ID resume recovers a missing binding and waits for lead settlement",async($,on)=>{
 const proof={commits:[],prs:[],tests:["pytest -q"],written:[]};
 const h=harness(on,"",{"session/s1/spawn/t":{ref:"fixture#child",parent:"fixture#auto",toolId:"t",teammate:"worker",status:"completed",workspace:"/tmp/test",project:"fixture",evidence:proof,verification:{evidence:proof,verified:true,failedChecks:[]}}});
 h.issues.set("auto",{issue:{short_id:"auto",status:"open",revision:1,metadata:{"claude.auto_parent":true,"claude.session_id":"s1","claude.workspace":"/tmp/test"}},comments:[],labels:[]});
 h.issues.set("child",{issue:{short_id:"child",status:"closed",revision:1,metadata:{}},parent:"fixture#auto",comments:[],labels:[]});h.recordClose("child");
 await $.session.start(start);await h.clock.settle();
 expect((h.persisted.get("session/s1/binding/parent") as {parent?:string}).parent).toBe("fixture#auto");
 expect(h.issues.get("auto")!.issue.status).toBe("open");
 await $.turn.complete(settledLead);await h.clock.settle();expect(h.issues.get("auto")!.issue.status).toBe("closed");
});
