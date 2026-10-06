import { test, expect } from "claude-code/testing";
import { harness, start, spawn } from "./support.ts";
import type { SessionReceiveInput } from "claude-code";
import type { EngineCall } from "claude-code/testing";

const notice = (result = "FINAL_SIGNAL_456", timestamp = "2026-10-06T01:09:39.493Z"): SessionReceiveInput => ({
  origin: { kind: "peer", teammate: "tester", isVerified: true },
  text: JSON.stringify({ type: "idle_notification", from: "tester", timestamp, idleReason: "available", result }),
});

const turn = (answer = "FINAL_SIGNAL_456", turnId = "final-turn") => ({ agentId: "a1", turnId, answer, reason: "answer" as const, durationMs: 10, isAborted: false });

for (const order of ["turn-first", "notice-first"]) {
  test(`verified finished delivery joins the final idle turn exactly once (${order})`, async ($, on) => {
    const h = harness(on);
    h.control.agents = [{ id: "a1", name: "tester", teammateId: "tester@session-s1", description: "Task", type: "general-purpose", status: "idle" }];
    on("agent.spawn", () => ({ model: "sonnet", agentId: "a1", teammateId: "tester@session-s1" }));
    on("session.receive", (_$, e) => ({ text: e.text }));
    await $.session.start(start);
    await $.agent.spawn(spawn({ name: "tester", background: true, isTeammate: true }));
    await h.clock.settle();
    if (order === "notice-first") await $.session.receive(notice());
    await $.turn.complete(turn());
    await $.session.receive(notice());
    await $.session.receive(notice());
    await $.turn.complete(turn());
    await h.clock.settle();
    expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("completed");
    expect(h.issues.get("c1")?.comments.map(c => c.body)).toEqual(["FINAL_SIGNAL_456\n\n[claude:tool-1:completed:final-turn]"]);
    expect(h.issues.get("c1")?.labels).toContain("needs-review");
  });
}

test("SendMessage-driven idle turns stay running even with a result-bearing idle notification", async ($, on) => {
  const h = harness(on);
  h.control.agents = [{ id: "a1", name: "tester", description: "Task", type: "general-purpose", status: "idle" }];
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1", teammateId: "tester@session-s1" }));
  on("session.receive", (_$, e) => ({ text: e.text }));
  on("tool.call", { tool: "SendMessage" }, () => ({ result: {}, text: "sent" }));
  await $.session.start(start);
  await $.agent.spawn(spawn({ name: "tester", background: true, isTeammate: true }));
  await ($.tool.call as EngineCall<"tool.call">)({ tool: "SendMessage", agentId: "a1", tool_use_id: "message", to: "team-lead", message: "progress" });
  await $.turn.complete(turn("Waiting for more instructions"));
  await $.session.receive(notice("Waiting for more instructions"));
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(0);
  expect(h.issues.get("c1")?.issue.metadata["claude.status"]).toBe("running");
});

test("plain idle, unverified, mismatched sender and mismatched result never finish work", async ($, on) => {
  const h = harness(on);
  h.control.agents = [{ id: "a1", name: "tester", description: "Task", type: "general-purpose", status: "idle" }];
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1", teammateId: "tester@session-s1" }));
  on("session.receive", (_$, e) => ({ text: e.text }));
  await $.session.start(start);
  await $.agent.spawn(spawn({ background: true, isTeammate: true }));
  await $.turn.complete(turn());
  for (const e of [notice(""), { ...notice(), origin: { kind: "peer" as const, teammate: "tester", isVerified: false } }, { ...notice(), origin: { kind: "peer" as const, teammate: "other", isVerified: true } }, notice("old unrelated result"), { ...notice(), agentId: "a1" }]) await $.session.receive(e);
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(0);
});

test("a new finished turn after resume reports once without replaying the prior delivery", async ($, on) => {
  const h = harness(on);
  h.control.agents = [{ id: "a1", name: "tester", description: "Task", type: "general-purpose", status: "idle" }];
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1", teammateId: "tester@session-s1" }));
  on("session.receive", (_$, e) => ({ text: e.text }));
  on("tool.call", { tool: "Bash" }, () => ({ result: {}, text: "ok" }));
  await $.session.start(start);
  await $.agent.spawn(spawn({ background: true, isTeammate: true }));
  await $.turn.complete(turn());
  await $.session.receive(notice());
  await h.clock.settle();
  h.control.agents[0]!.status = "running";
  await ($.tool.call as EngineCall<"tool.call">)({ tool: "Bash", agentId: "a1", tool_use_id: "resume", command: "true" });
  await $.session.receive(notice());
  h.control.agents[0]!.status = "idle";
  await $.turn.complete(turn("SECOND_TURN", "second-turn"));
  await $.session.receive(notice("SECOND_TURN", "2026-10-06T01:10:00.000Z"));
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(2);
  expect(h.issues.get("c1")?.comments[1]?.body).toContain("SECOND_TURN");
});

test("early finished delivery survives the spawn-to-agent join", async ($, on) => {
  const h = harness(on);
  h.control.agents = [{ id: "a1", name: "tester", description: "Task", type: "general-purpose", status: "idle" }];
  on("session.receive", (_$, e) => ({ text: e.text }));
  on("agent.spawn", async () => {
    await $.turn.complete(turn());
    await $.session.receive(notice());
    return { model: "sonnet", agentId: "a1", teammateId: "tester@session-s1" };
  });
  await $.session.start(start);
  await $.agent.spawn(spawn({ background: true, isTeammate: true }));
  await h.clock.settle();
  expect(h.issues.get("c1")?.comments.length).toBe(1);
});

const receiptTurn = (answer: string, turnId='t1') => ({agentId:'a1',turnId,answer,reason:'answer' as const,durationMs:10,isAborted:false});

const receipt = (result: string, timestamp='2026-10-06T01:09:39.493Z') => ({origin:{kind:'peer' as const,teammate:'tester',isVerified:true},text:JSON.stringify({type:'idle_notification',from:'tester',timestamp,result})});

test('early SendMessage before spawn join must suppress idle completion', async ($, on) => {
 const h=harness(on);
 h.control.agents=[{id:'a1',name:'tester',description:'Task',type:'general-purpose',status:'idle'}];
 on('session.receive',(_$,e)=>({text:e.text}));
 on('tool.call',{tool:'SendMessage'},()=>({result:{},text:'sent'}));
 on('agent.spawn',async()=>{
  await ($.tool.call as EngineCall<'tool.call'>)({tool:'SendMessage',agentId:'a1',tool_use_id:'message',to:'team-lead',message:'progress'});
  await $.turn.complete(receiptTurn('Waiting'));
  await $.session.receive(receipt('Waiting'));
  return {model:'sonnet',agentId:'a1',teammateId:'tester@session-s1'};
 });
 await $.session.start(start);
 await $.agent.spawn(spawn({background:true,isTeammate:true}));
 await h.clock.settle();
 expect(h.issues.get('c1')?.comments.length).toBe(0);
});

test('receipt from prior turn must not complete an already resumed agent',async($,on)=>{
 const h=harness(on);
 h.control.agents=[{id:'a1',name:'tester',description:'Task',type:'general-purpose',status:'idle'}];
 on('session.receive',(_$,e)=>({text:e.text}));
 on('agent.spawn',()=>({model:'sonnet',agentId:'a1',teammateId:'tester@session-s1'}));
 on('tool.call',{tool:'Bash'},()=>({result:{},text:'ok'}));
 await $.session.start(start);
 await $.agent.spawn(spawn({background:true,isTeammate:true}));
 await $.turn.complete(receiptTurn('First'));
 h.control.agents[0]!.status='running';
 await ($.tool.call as EngineCall<'tool.call'>)({tool:'Bash',agentId:'a1',tool_use_id:'resume',command:'true'});
 await $.session.receive(receipt('First'));
 await h.clock.settle();
 expect(h.issues.get('c1')?.issue.metadata['claude.status']).toBe('running');
 expect(h.issues.get('c1')?.comments.length).toBe(1);
 expect(h.issues.get('c1')?.comments[0]?.body).toContain('First');
});

test('stale unmatched receipt must not overwrite newer pending finish',async($,on)=>{
 const h=harness(on);
 h.control.agents=[{id:'a1',name:'tester',description:'Task',type:'general-purpose',status:'idle'}];
 on('session.receive',(_$,e)=>({text:e.text}));
 on('agent.spawn',()=>({model:'sonnet',agentId:'a1',teammateId:'tester@session-s1'}));
 on('tool.call',{tool:'SendMessage'},()=>({result:{},text:'sent'}));
 await $.session.start(start);
 await $.agent.spawn(spawn({background:true,isTeammate:true}));
 await ($.tool.call as EngineCall<'tool.call'>)({tool:'SendMessage',agentId:'a1',tool_use_id:'message',to:'team-lead',message:'progress'});
 await $.turn.complete(receiptTurn('Waiting'));
 await $.session.receive(receipt('Waiting'));
 await $.session.receive(receipt('Final','2026-10-06T01:10:00.000Z'));
 await $.session.receive(receipt('Waiting'));
 await $.turn.complete(receiptTurn('Final','t2'));
 await h.clock.settle();
 expect(h.issues.get('c1')?.comments.length).toBe(1);
});

test('early duplicate cannot overwrite a newer finished receipt', async ($, on) => {
 const h=harness(on);
 h.control.agents=[{id:'a1',name:'tester',description:'Task',type:'general-purpose',status:'idle'}];
 on('session.receive',(_$,e)=>({text:e.text}));
 on('agent.spawn',async()=>{
  await $.turn.complete(receiptTurn('Final','t2'));
  await $.session.receive(receipt('Final','2026-10-06T01:10:00.000Z'));
  await $.session.receive(receipt('Waiting'));
  return {model:'sonnet',agentId:'a1',teammateId:'tester@session-s1'};
 });
 await $.session.start(start);
 await $.agent.spawn(spawn({background:true,isTeammate:true}));
 await h.clock.settle();
 expect(h.issues.get('c1')?.comments.length).toBe(1);
});

test('startup replay cannot replace a newer mapped finish with an old early receipt', async ($,on)=>{
 const h=harness(on,'fixture#root',{
  'session/s1/binding/parent':{id:'s1',parent:'fixture#root'},
  'session/s1/spawn/old-tool':{ref:'c1',parent:'fixture#root',toolId:'old-tool',teammate:'tester-unique',agentId:'a1',teammateId:'tester@session-s1',background:true,status:'running',reply:{turnId:'t2',answer:'Final',reason:'answer'},finished:{from:'tester',timestamp:'2026-10-06T01:10:00.000Z',result:'Final'}},
  'session/s1/agent/a1':'old-tool',
  'session/s1/finished/tester':{from:'tester',timestamp:'2026-10-06T01:09:39.493Z',result:'Waiting'},
 });
 h.control.agents=[{id:'a1',name:'tester',description:'Task',type:'general-purpose',status:'idle'}];
 h.issues.set('c1',{issue:{short_id:'c1',status:'open',revision:1,metadata:{'claude.status':'running'}},comments:[],labels:[]});
 await $.session.start(start);await h.clock.settle();
 expect(h.issues.get('c1')?.comments.length).toBe(1);
 expect(h.issues.get('c1')?.comments[0]?.body).toContain('Final');
});
