import { test, expect } from "claude-code/testing";
import { resumedTurn, harness, canonicalContract, start, spawn, command } from "./support.ts";
import type { EngineCall } from "claude-code/testing";

const mainTurn = (turnId: string) => ({
  turnId,
  answer: "Main reply",
  reason: "answer" as const,
  durationMs: 10,
  isAborted: false,
});

test("failed synchronous create preserves canonical contract and retries on next turn", async ($, on) => {
  const h = harness(on);
  h.control.failCreate = 1;
  on("agent.spawn", ($, e) => {
    expect(e.prompt.startsWith(canonicalContract)).toBe(true);
    expect(e.prompt).toContain("tracking is pending recovery");
    return { model: "sonnet", agentId: "a1" };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  expect(h.issues.size).toBe(0);
  expect(h.control.timeouts).toContain(100);
  await $.turn.complete(mainTurn("retry1"));
  await h.clock.advance(1000);
  expect(h.issues.size).toBe(1);
  expect(h.issues.get("c1")?.issue.metadata["claude.agent_id"]).toBe("a1");
});

test("unreachable create remains pending after three attempts and logs only to debug", async ($, on) => {
  const h = harness(on);
  h.control.failCreate = 20;
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await $.turn.complete(mainTurn("retry1"));
  await $.turn.complete(mainTurn("retry2"));
  await $.turn.complete(mainTurn("retry3"));
  await h.clock.advance(3000);
  expect(h.calls.filter((a) => a[1] === "create").length).toBe(3);
  expect(h.control.toasts).toEqual([]);
  expect(h.control.hints).toEqual([]);
  expect(h.control.logs.some(l => l.text.includes("dropped"))).toBe(false);
  expect((h.persisted.get("session/s1/op/spawn:tool-1:create") as {ack?:boolean}).ack).not.toBe(true);
});

test("resume restores binding, child and pending operation from durable store", async ($, on) => {
  const stored = {
    "session/s1/binding/parent": { id: "s1", parent: "fixture#saved" },
    "session/s1/spawn/old-tool": {
      ref: "oldchild",
      parent: "fixture#saved",
      toolId: "old-tool",
      teammate: "saved-agent",
      status: "running",
      agentId: "a1",
    },
    "session/s1/agent/a1": "old-tool",
    "session/s1/op/spawn:old-tool:identity": {
      id: "spawn:old-tool:identity",
      kind: "meta",
      entry: "spawn",
      key: "old-tool",
      metadata: { "claude.agent_id": "a1" },
      attempts: 1,
    },
  };
  const h = harness(on, "fixture#different", stored);
  h.issues.set("oldchild", {
    issue: { short_id: "oldchild", status: "open", revision: 2, metadata: {} },
    comments: [],
    labels: [],
  });
  await $.session.start(start);
  await h.clock.settle();
  const r = await $.command.run(command());
  expect(r.text).toContain("fixture#saved");
  expect(r.text).toContain("oldchild");
  expect(h.issues.get("oldchild")?.issue.metadata["claude.agent_id"]).toBe(
    "a1",
  );
});

test("normal operation draws no status line", async ($, on) => {
  const h = harness(on);
  await $.session.start(start);
  expect(h.control.hints).toEqual([]);
});

test("a slow queued write does not delay the next native spawn return", async ($, on) => {
  const h = harness(on);
  let n = 0;
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a" + ++n }));
  await $.session.start(start);
  await $.agent.spawn(spawn());
  h.control.showDelayMs = 1000;
  await h.clock.settle();
  let returned = false;
  const p = $.agent.spawn(spawn({ tool_use_id: "tool2" })).then(() => {
    returned = true;
  });
  await h.clock.settle();
  const returnedBeforeDrain = returned;
  h.control.showDelayMs = 0;
  await h.clock.advance(1000);
  await p;
  expect(returnedBeforeDrain).toBe(true);
});

test("restored early reply survives crash between mapping and replay", async ($, on) => {
  const h = harness(on, "", {
    "session/s1/binding/parent": { id: "s1", parent: "fixture#root" },
    "session/s1/spawn/tool-1": {
      ref: "oldchild",
      parent: "fixture#root",
      toolId: "tool-1",
      teammate: "agent1",
      status: "running",
      agentId: "a1",
      background: false,
    },
    "session/s1/agent/a1": "tool-1",
    "session/s1/early/a1": [
      { turnId: "turn1", answer: "Exact early final", reason: "answer" },
    ],
  });
  h.issues.set("oldchild", {
    issue: { short_id: "oldchild", status: "open", revision: 2, metadata: {} },
    comments: [],
    labels: [],
  });
  await $.session.start(start);
  await h.clock.settle();
  await $.turn.complete({ ...resumedTurn(), agentId: undefined });
  await h.clock.settle();
  expect(h.issues.get("oldchild")?.comments[0]?.body).toBe(
    "Exact early final\n\n[claude:tool-1:completed:turn1]",
  );
});

test("acknowledged report payloads are compacted and inactive sessions are evicted within budget", async ($, on) => {
  const h = harness(on, "fixture#root", {
    "session/old/binding/parent": { id: "old", parent: "old#root" },
    "session/old/unknown/payload": "x".repeat(2200000),
  });
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  await $.turn.complete(resumedTurn("a1", "compact", "x".repeat(4000)));
  await h.clock.settle();
  expect(h.persisted.has("session/old/binding/parent")).toBe(false);
  const op = h.persisted.get(
    "session/s1/op/spawn:tool-1:completed:compact",
  ) as { ack: boolean; body?: string };
  expect(op.ack).toBe(true);
  expect(op.body).toBe(undefined);
  expect(
    (
      h.persisted.get("session/s1/spawn/tool-1") as {
        reply: { answer: string };
      }
    ).reply.answer,
  ).toBe("");
  expect(h.issues.get("c1")?.comments[0]?.body).toContain("x".repeat(4000));
});

test("session exit cannot mutate a foreign store's colliding issue",async($,on)=>{
 const h=harness(on,"fixture#root",{"session/s1/binding/parent":{id:"s1",parent:"fixture#root",cwd:"/tmp/test",scope:"other-store"},"session/s1/spawn/t":{ref:"fixture#same",parent:"fixture#root",toolId:"t",teammate:"worker",status:"running",scope:"other-store",workspace:"/tmp/test",project:"fixture"}});h.issues.set("same",{issue:{short_id:"same",status:"open",revision:1,metadata:{}},comments:[],labels:[]});await $.session.start(start);await $.session.end({sessionId:"s1",reason:"other",resume:{id:"s1"}});expect(h.calls.some(a=>a[0]==="/bin/sh")).toBe(false);
});

test("an old foreground fallback cannot complete a reused key after clear",async($,on)=>{
 const h=harness(on);let n=0;on("agent.spawn",()=>({model:"sonnet",agentId:"a"+ ++n}));
 on("tool.call",(_$,e)=>e.tool==="Agent"?{result:{status:"completed"},text:"Old task finished."}:{result:{exitCode:0},text:"passed"});
 await $.session.start(start);await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)({tool:"Agent",tool_use_id:"tool-1",subagent_type:"general-purpose",description:"Task",prompt:"Original"});
 h.control.sessionId="s2";await $.agent.spawn(spawn());await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"new-test",agentId:"a2",command:"pytest -q"});
 await h.clock.advance(250);await h.clock.settle();expect(h.issues.get("c2")?.issue.status).toBe("open");expect((h.persisted.get("session/s2/spawn/tool-1") as {status:string}).status).toBe("running");
});

test("resume in another folder preserves original command workspace and project",async($,on)=>{
 const h=harness(on,"",{
  "session/s1/binding/parent":{id:"s1",parent:"alpha#root",cwd:"/alpha",project:"alpha"},
  "session/s1/spawn/t":{ref:"alpha#same",parent:"alpha#root",workspace:"/alpha",project:"alpha",toolId:"t",teammate:"worker",status:"running"},
  "session/s1/op/meta":{id:"meta",kind:"meta",entry:"spawn",key:"t",workspace:"/alpha",project:"alpha",metadata:{"claude.agent_id":"agent"},attempts:0},
 });h.control.cwd="/beta";
 h.issues.set("alpha#same",{issue:{short_id:"same",status:"open",revision:1,metadata:{}},comments:[],labels:[]});
 h.issues.set("beta#same",{issue:{short_id:"same",status:"open",revision:1,metadata:{}},comments:[],labels:[]});
 await $.session.start({...start,cwd:"/beta"});await h.clock.settle();
 expect((h.persisted.get("session/s1/binding/parent") as {cwd?:string}).cwd).toBe("/alpha");
 const writes=h.processContexts.filter(c=>c.args[1]==="meta" && c.args.includes("alpha#same"));expect(writes.length).toBe(1);expect(writes[0]!.cwd).toBe("/alpha");expect(writes[0]!.args).toContain("--project");expect(writes[0]!.args).toContain("alpha");
 expect(h.issues.get("beta#same")?.issue.metadata).toEqual({});
});

for(const variant of ["folder","scope"] as const)test(`background drain does not replay another ${variant}'s session`,async($,on)=>{
 const h=harness(on,"fixture#root",{
  "session/old/binding/parent":{id:"old",cwd:variant==="folder"?"/other":"/tmp/test",project:"foreign",parent:"foreign#root",ended:true,scope:"another-store"},
  "session/old/spawn/t":{ref:"foreign#same",parent:"foreign#root",project:"foreign",workspace:"/other",toolId:"t",teammate:"worker",status:"running"},
  "session/old/op/m":{id:"m",kind:"meta",sessionId:"old",entry:"spawn",key:"t",project:"foreign",workspace:"/other",metadata:{"claude.agent_id":"old"},attempts:0},
 });await $.session.start(start);await h.clock.settle();expect(h.calls.some(a=>a.includes("foreign#same"))).toBe(false);expect(h.persisted.has("session/old/op/m")).toBe(true);
});

test("clear drains old pending writes into their original entries even when keys are reused",async($,on)=>{
 const h=harness(on);let n=0;on("agent.spawn",()=>({model:"sonnet",agentId:"a"+ ++n}));await $.session.start(start);h.control.failMeta=1;await $.agent.spawn(spawn());await h.clock.settle();
 h.control.sessionId="s2";await $.agent.spawn(spawn());await h.clock.advance(1000);
 expect(h.issues.get("c1")?.issue.metadata["claude.agent_id"]).toBe("a1");expect(h.issues.get("c2")?.issue.metadata["claude.agent_id"]).toBe("a2");
 expect((h.persisted.get("session/s1/spawn/tool-1") as {ref:string}).ref).toBe("fixture#c1");expect((h.persisted.get("session/s2/spawn/tool-1") as {ref:string}).ref).toBe("fixture#c2");
});

test("SDK store latency with a large global history cannot consume the startup foreground",async($,on)=>{
 const history=Object.fromEntries(Array.from({length:1000},(_,i)=>[`session/old-${i}/unknown/history`,{text:"old"}]));
 const h=harness(on,"fixture#root",history);h.control.sdkDelayMs=20;
 let done=false;const work=$.session.start(start).then(()=>{done=true;});
 await h.clock.advance(300);expect(done).toBe(true);if(done)await work;
});

test("parent setup outage retains delegate intent and canonical contract then recovers without another spawn",async($,on)=>{
 const h=harness(on,"");h.control.projectThrows=true;
 on("agent.spawn",(_$,e)=>{expect(e.prompt.startsWith(canonicalContract)).toBe(true);return {model:"sonnet",agentId:"a1"};});
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 expect(h.persisted.has("session/s1/spawn/tool-1")).toBe(true);
 expect([...h.persisted.values()].some(v=>(v as {prepare?:boolean;ack?:boolean}).prepare && !(v as {ack?:boolean}).ack)).toBe(true);
 h.control.projectThrows=false;await h.clock.advance(8000);await h.clock.settle();
 const entry=h.persisted.get("session/s1/spawn/tool-1") as {ref?:string;parent?:string};
 expect(entry.ref).toBe("fixture#c2");expect(entry.parent).toBe("fixture#c1");
 expect(h.issues.get("c2")?.issue.metadata["claude.agent_id"]).toBe("a1");
});

test("one transport failure backs off a hundred queued writes together",async($,on)=>{
 const backlog=Object.fromEntries(Array.from({length:100},(_,i)=>[`session/s1/op/m${i}`,{id:`m${i}`,kind:"meta",entry:"spawn",key:"t",metadata:{["queued-"+i]:"applied"},attempts:0,project:"fixture",workspace:"/tmp/test"}]));
 const h=harness(on,"fixture#root",{...backlog,"session/s1/spawn/t":{ref:"fixture#old",parent:"fixture#root",toolId:"t",teammate:"w",status:"running",project:"fixture",workspace:"/tmp/test"}});
 await $.session.start(start);h.control.outage=true;
 const before=h.processContexts.length;await h.clock.advance(1100);
 expect(h.processContexts.length-before).toBeLessThanOrEqual(1);
 h.control.outage=false;await h.clock.advance(7000);await h.clock.settle();
 expect(Object.keys(backlog).every(key=>(h.persisted.get(key) as {ack?:boolean}).ack)).toBe(true);
});

test("pending parent preparation retains its original workspace after a new explicit claim",async($,on)=>{
 const h=harness(on,"");h.control.projectThrows=true;
 let n=0;on("agent.spawn",()=>({model:"sonnet",agentId:"a"+ ++n}));
 on("tool.call",{tool:"Bash"},()=>({result:{},text:"claimed fixture#newer"}));
 await $.session.start(start);await $.agent.spawn(spawn());
 await ($.tool.call as EngineCall<"tool.call">)({tool:"Bash",tool_use_id:"claim",command:"kata --workspace /tmp/other claim fixture#newer"});
 h.control.projectThrows=false;await h.clock.advance(8000);await h.clock.settle();
 const entry=h.persisted.get("session/s1/spawn/tool-1") as {workspace?:string;parent?:string};
 expect(entry.workspace).toBe("/tmp/test");expect(entry.parent).toBe("fixture#c1");
 expect((h.persisted.get("session/s1/binding/parent") as {parent?:string;workspace?:string}).parent).toBe("fixture#newer");
 expect((h.persisted.get("session/s1/binding/parent") as {workspace?:string}).workspace).toBe("/tmp/other");
 const child=h.processContexts.find(p=>p.args.includes("claude-agent:s1:tool-1"));
 expect(child?.cwd).toBe("/tmp/test");
});

test("native spawn returning after clear records its link only in its captured session",async($,on)=>{
 const h=harness(on);
 on("agent.spawn",()=>{h.control.sessionId="s2";return {model:"sonnet",agentId:"a1"};});
 await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 expect((h.persisted.get("session/s1/spawn/tool-1") as {agentId?:string}).agentId).toBe("a1");
 expect(h.persisted.get("session/s1/agent/a1")).toBe("tool-1");
 expect(h.persisted.has("session/s2/spawn/tool-1")).toBe(false);
 expect(h.persisted.has("session/s2/agent/a1")).toBe(false);
});

const mainTurnEvent={turnId:"main",answer:"Okay",reason:"answer" as const,durationMs:1,isAborted:false};

for(const hook of ["start","turn","spawn"] as const)test(`dead Kata respects ${hook === "spawn" ? "3100ms spawn" : "300ms foreground"} budget for ${hook}`,async($,on)=>{
 const stored=Object.fromEntries(Array.from({length:8},(_,i)=>[`session/s1/op/m${i}`,{id:`m${i}`,kind:"meta",entry:"spawn",key:"t",metadata:{"claude.agent_id":"a"},attempts:0,project:"fixture",workspace:"/tmp/test"}]));
 const h=harness(on,"fixture#root",{...stored,"session/s1/spawn/t":{ref:"fixture#old",parent:"fixture#root",toolId:"t",teammate:"w",status:"running",project:"fixture",workspace:"/tmp/test"}});
 on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));
 if(hook!=="start"){await $.session.start(start);for(const [key,value] of Object.entries(stored))h.persisted.set(key,value);}
 h.control.outage=true;
 let done=false; const work=(hook==="start" ? $.session.start(start) : hook==="turn" ? $.turn.complete(mainTurnEvent) : $.agent.spawn(spawn())).then(()=>{done=true;});
 await h.clock.advance(hook === "spawn" ? 3100 : 300);expect(done).toBe(true);if(done)await work;
});

test("outage effects persist with exponential backoff and recover without another turn",async($,on)=>{
 const h=harness(on);h.control.failCreate=20;on("agent.spawn",()=>({model:"sonnet",agentId:"a1"}));await $.session.start(start);await $.agent.spawn(spawn());await h.clock.settle();
 for(const wait of [1000,2000,4000])await h.clock.advance(wait);
 const op=h.persisted.get("session/s1/op/spawn:tool-1:create") as {ack?:boolean;attempts:number;notBefore?:number};expect(op.ack).not.toBe(true);expect(op.attempts).toBeGreaterThanOrEqual(3);expect(op.notBefore).toBeGreaterThan(7000);
 h.control.failCreate=0;await h.clock.advance(8000);await h.clock.settle();expect(h.issues.get("c1")?.issue.metadata["claude.agent_id"]).toBe("a1");expect(h.control.logs.some(l=>l.text.includes("dropped"))).toBe(false);
});

for(const kind of ["running-child","unclosed-parent"] as const)test(`storage pressure cannot evict ${kind}`,async($,on)=>{
 const old:Record<string,unknown>={"session/old/binding/parent":{id:"old",parent:"fixture#root",cwd:"/tmp/test",ended:true},"session/old/unknown/payload":"x".repeat(2200000)};
 if(kind==="running-child")old["session/old/spawn/t"]={ref:"fixture#old",parent:"fixture#root",toolId:"t",teammate:"worker",status:"running"};else old["session/old/binding/parent"]={id:"old",parent:"fixture#oldparent",autoParent:"fixture#oldparent",cwd:"/tmp/test",ended:true};
 const h=harness(on,"fixture#root",old);await $.session.start(start);expect(h.persisted.has("session/old/binding/parent")).toBe(true);
});

test("startup identity resolution shares one 250ms foreground budget",async($,on)=>{
 const h=harness(on,"root");h.control.processDelayMs=100;let done=false;
 const work=$.session.start(start).then(()=>{done=true;});await h.clock.advance(250);expect(done).toBe(true);if(done)await work;
});
