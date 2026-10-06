import { test, expect } from "claude-code/testing";
import { harness, start, spawn } from "./support.ts";
import type { EngineCall } from "claude-code/testing";
import { receiveWorkflow } from "../hooks/register.ts";
import type { SessionAppendInput } from "claude-code";
import { workflowNotice, workflowDelivery, workflowSummary } from "../hooks/notifications.ts";

test("workflow first delegation creates auto parent and run child", async ($, on) => {
  const h = harness(on, "");
  on("tool.call", {tool:"Workflow"}, () => ({result:{status:"async_launched",taskType:"local_workflow",taskId:"wf1",workflowName:"review",summary:"Review"},text:"launched"}));
  await $.session.start(start);
  await ($.tool.call as EngineCall<"tool.call">)({tool:"Workflow",name:"review",tool_use_id:"w"});
  await h.clock.settle();
  expect(h.calls.filter(a => a[1] === "create").length).toBe(2);
  expect(h.calls.some(a => a[2] === "workflow: review" && a[a.indexOf("--parent") + 1] === "fixture#c1")).toBe(true);
});

test("first workflow persists a receipt boundary before native launch without waiting for parent setup", async ($, on) => {
 const h=harness(on, "");
 on("tool.call",{tool:"Workflow"},()=>{
  expect(h.issues.size).toBe(0);
  expect(h.persisted.has("session/s1/launch/fast-tool")).toBe(true);
  return {result:{status:"async_launched",taskType:"local_workflow",taskId:"fast",workflowName:"fast",summary:"Fast"},text:"launched"};
 });
 await $.session.start(start);await ($.tool.call as EngineCall<"tool.call">)({tool:"Workflow",tool_use_id:"fast-tool",name:"fast"});await h.clock.settle();
 expect(h.issues.size).toBe(2);
});

const receiptHost = (h: ReturnType<typeof harness>) => ({
 session: {id: async()=>h.control.sessionId},
 store: {get: async(key:string)=>h.persisted.get(key), keys: async()=>[...h.persisted.keys()],
  set: async(key:string,value:unknown)=>{h.persisted.set(key,value);}, delete: async(key:string)=>{h.persisted.delete(key);}},
} as unknown as import("claude-code").EngineInterface);

test("completion delivered during native workflow launch is replayed after run registration", async ($, on) => {
 const h=harness(on, "");
 on("tool.call",{tool:"Workflow"},async()=>{
  await receiveWorkflow(receiptHost(h),{taskId:"fast",status:"completed",summary:"Done",result:"FAST_WORKFLOW_OK"},"fast-delivery");
  return {result:{status:"async_launched",taskType:"local_workflow",taskId:"fast",workflowName:"fast",summary:"Fast"},text:"launched"};
 });
 await $.session.start(start);await ($.tool.call as EngineCall<"tool.call">)({tool:"Workflow",tool_use_id:"fast-tool",name:"fast"});await h.clock.settle();
 expect(h.issues.get("c2")?.issue.metadata["claude.status"]).toBe("completed");
 expect(h.issues.get("c2")?.comments.length).toBe(1);
});

test("unrelated workflow receipt outside a native launch is not buffered", async ($, on) => {
 const h=harness(on, "");await $.session.start(start);
 await receiveWorkflow(receiptHost(h),{taskId:"other",status:"completed",summary:"Unknown",result:""},"unknown-delivery");
 expect([...h.persisted.keys()].filter(key=>key.includes("workflow-notice/"))).toEqual([]);
 expect(h.calls).toEqual([]);
});

test("startup replays registered workflow receipts and clears abandoned launch state", async ($, on) => {
 const h=harness(on, "fixture#root", {
  'session/s1/binding/parent':{id:'s1',parent:'fixture#root'},
  'session/s1/run/fast':{ref:'c1',parent:'fixture#root',toolId:'fast',teammate:'wf-fast',workflowName:'fast',status:'running'},
  'session/s1/launch/abandoned':true,
  'session/s1/workflow-notice/fast':{notice:{taskId:'fast',status:'completed',summary:'Done',result:'RESTART_OK'},uuid:'saved-delivery'},
  'session/s1/workflow-notice/unknown':{notice:{taskId:'unknown',status:'completed',summary:'Orphan'},uuid:'orphan-delivery'},
 });
 h.issues.set('c1',{issue:{short_id:'c1',status:'open',revision:1,metadata:{'claude.status':'running'}},comments:[],labels:[]});
 await $.session.start(start);await h.clock.settle();
 expect(h.issues.get('c1')?.issue.metadata['claude.status']).toBe('completed');
 expect(h.issues.get('c1')?.comments.length).toBe(1);
 expect([...h.persisted.keys()].filter(key=>/\/(launch|workflow-notice)\//.test(key))).toEqual([]);
 await $.session.start(start);await h.clock.settle();
 expect(h.issues.get('c1')?.comments.length).toBe(1);
});

test("throwing native Workflow clears its in-flight buffer boundary", async ($, on) => {
 const h=harness(on, "fixture#root");
 on("tool.call",{tool:"Workflow"},()=>{throw new Error("Native launch failed");});
 await $.session.start(start);
 try { await ($.tool.call as EngineCall<"tool.call">)({tool:"Workflow",tool_use_id:"failed-tool",name:"failed"}); }
 catch {}
 expect([...h.persisted.keys()].filter(key=>key.includes('/launch/'))).toEqual([]);
 await receiveWorkflow(receiptHost(h),{taskId:"other",status:"completed",summary:"Unknown",result:""},"unknown-delivery");
 expect([...h.persisted.keys()].filter(key=>key.includes('/workflow-notice/'))).toEqual([]);
});

test("early workflow completion survives a failed automatic-parent preflight create",async($,on)=>{
 const h=harness(on, ""); h.control.failCreate=1;
 on("tool.call",{tool:"Workflow"},async()=>{
  await receiveWorkflow(receiptHost(h),{taskId:"fast",status:"completed",summary:"Finished",result:"README written"},"early");
  return {result:{status:"async_launched",taskType:"local_workflow",taskId:"fast",workflowName:"docs"},text:"launched"};
 });
 await $.session.start(start); await ($.tool.call as EngineCall<"tool.call">)({tool:"Workflow",tool_use_id:"wf",script:"return 1"}); await h.clock.settle();
 expect((h.persisted.get("session/s1/run/fast") as {status:string}).status).toBe("completed");
});

const readmeReport="I wrote README.md and checked it by running every example in it. All the outputs and exit codes match.";

const reviewReport="I wrote REVIEW.md and verified the documentation against the implementation.";

const completionCases: [string,unknown,boolean,string[]][]=[
 ["native review destination then own verification",["I wrote the review to `/tmp/test/REVIEW.md` and then verified it. It has 8 findings ordered by severity, each with a suggested fix. I did not edit `source.py` and did not commit anything.",readmeReport],true,["REVIEW.md","README.md"]],
 ["native then existence alone cannot verify",["I wrote the review to `/tmp/test/REVIEW.md` and then verified it exists.",readmeReport],false,[]],
 ["structured true cannot override did not check",{file:"README.md",verified:true,summary:"I did not check the documentation."},false,[]],
 ["nested prose writer cannot borrow envelope verification",{files:["README.md"],verified:true,result:"I wrote REVIEW.md. It exists."},false,[]],
 ["encoded nested verification cannot verify envelope writer",{files:["README.md"],result:JSON.stringify({file:"REVIEW.md",verified:true})},false,[]],
 ["review destination not reviewed source",["I wrote a review of source.py in REVIEW.md. I verified the documentation against the implementation."],true,["REVIEW.md"]],
 ["structured true cannot override explicit unverified",{file:"README.md",verified:true,summary:"The documentation is unverified."},false,[]],
 ["structured true cannot override did not verify",{file:"README.md",verified:true,summary:"I did not verify the documentation."},false,[]],
 ["structured true cannot override newline negation",{file:"README.md",verified:true,summary:"I did not\nverify the documentation."},false,[]],
 ["structured true cannot override tab negation",{file:"README.md",verified:true,summary:"I have not\tchecked the documentation."},false,[]],
 ["structured true cannot override encoded own-text negation",{file:"README.md",verified:true,summary:JSON.stringify("I have not\tchecked the documentation.")},false,[]],
 ["structured true cannot override nested line-break failure",{file:"README.md",verified:true,details:{checks:["Tests\r\nhave\tfailed."]}},false,[]],
 ["structured true cannot override failed review",{file:"README.md",verified:true,summary:"Review failed."},false,[]],
 ["structured true cannot override partial checks",{file:"README.md",verified:true,summary:"Not all checks passed."},false,[]],
 ["structured true cannot override never verified",{file:"README.md",verified:true,summary:"I never verified the docs."},false,[]],
 ["structured true cannot override punctuated negation",{file:"README.md",verified:true,summary:"I did not, in fact, verify the docs."},false,[]],
 ["absence of failed review retains verification",{file:"README.md",verified:true,summary:"I verified the docs; no review failed."},true,["README.md"]],
 ["absence of failed review cannot excuse failed tests",{file:"README.md",verified:true,summary:"No review failed. Tests failed."},false,[]],
 ["writer missing declared files",[{file:"README.md",verified:true},"I wrote the docs."],false,[]],
 ["markdown own writing",["**Written:** `README.md`. I verified the documentation."],true,["README.md"]],
 ["malformed writer paths",[{files:["README.md"],verified:true},{files:[42],verified:true}],false,[]],
 ["quoted writer is not own",["The reviewer said: I wrote REVIEW.md and verified the documentation."],false,[]],
 ["native labelled reviewer",["I tested source.py and wrote 10 findings to REVIEW.md.\n\nVERIFIED: I re-read REVIEW.md, confirmed it exists, and re-ran every repro command. Each output matched what REVIEW.md says.",readmeReport],true,["REVIEW.md","README.md"]],
 ["success false",{file:"README.md",verified:true,success:false},false,[]],
 ["error field",{file:"README.md",verified:true,error:"Test exited 1"},false,[]],
 ["nested encoded false",{file:"README.md",verified:true,result:JSON.stringify({verified:false})},false,[]],
 ["foreign file attribution",["I wrote REVIEW.md and verified the documentation. Another agent wrote README.md.",readmeReport],true,["REVIEW.md","README.md"]],
 ["structured writers",{reviewer:{file:"REVIEW.md",verified:true},writer:{files:["README.md"],verified:true}},true,["REVIEW.md","README.md"]],
 ["own prose writers",[reviewReport,readmeReport],true,["REVIEW.md","README.md"]],
 ["nested native results",{results:[{result:JSON.stringify({file:"REVIEW.md",verified:true})},{result:readmeReport}]},true,["REVIEW.md","README.md"]],
 ["reported source file",{file:"source.py",verified:true},true,["source.py"]],
 ["outside files excluded",{files:["/tmp/test/README.md","/tmp/outside.md","../outside.md"],verified:true},true,["README.md"]],
 ["one unverified contributor",[{files:["README.md"],verified:true},{files:["REVIEW.md"],summary:"Written."}],false,[]],
 ["blanket cannot verify contributors",{verified:true,contributors:[{files:["README.md"]},{files:["REVIEW.md"]}]},false,[]],
 ["false contributor",[{file:"README.md",verified:true},{file:"REVIEW.md",verified:false}],false,[]],
 ["failed contributor",[{file:"README.md",verified:true},{file:"REVIEW.md",verified:true,summary:"Tests failed."}],false,[]],
 ["incomplete contributor",[{file:"README.md",verified:true},{file:"REVIEW.md",verified:true,incomplete:true}],false,[]],
 ["no reported files",{verified:true,summary:"I verified the documentation."},false,[]],
 ["outside only",{file:"/outside/README.md",verified:true},false,[]],
 ["later unverified prose",[readmeReport,"I wrote REVIEW.md. It exists."],false,[]],
 ["failure beyond display cap",[{file:"README.md",verified:true,summary:"x".repeat(5000)},{file:"REVIEW.md",verified:true,summary:"Work is incomplete."}],false,[]],
];

for(const [name,result,closed,files] of completionCases)test(`workflow report authority: ${name}`,async($,on)=>{
 const h=harness(on);let reads=0;
 on("tool.call",{tool:"Workflow"},()=>({result:{status:"async_launched",taskType:"local_workflow",taskId:"wf",workflowName:"docs",transcriptDir:"/deleted/transcripts"},text:"launched"}));
 on("fs.list",()=>{reads++;throw new Error("Transcripts do not exist");});
 on("fs.read",()=>{reads++;throw new Error("Transcripts do not exist");});
 await $.session.start(start);await ($.tool.call as EngineCall<"tool.call">)({tool:"Workflow",tool_use_id:"launch",script:"return 1"});await h.clock.settle();
 h.persisted.set("session/s1/workflow-notice/wf",{notice:{taskId:"wf",status:"completed",summary:"Finished",result:JSON.stringify(result)},uuid:"final"});
 await $.session.start(start);await h.clock.settle();
 expect(h.issues.get("c1")!.issue.status).toBe(closed?"closed":"open");
 expect(reads).toBe(0);
 if(closed){const close=h.calls.find(a=>a[1]==="close"&&a[2]==="fixture#c1")!;expect(close.flatMap((x,i)=>x==="--reviewed"?[close[i+1]]:[])).toEqual(files);}
 else expect(h.issues.get("c1")!.labels).toContain("needs-review");
});

test("workflow launch survives parent setup outage with captured run intent",async($,on)=>{
 const h=harness(on,"");h.control.projectThrows=true;
 on("tool.call",{tool:"Workflow"},()=>({result:{status:"async_launched",taskType:"local_workflow",taskId:"wf1",workflowName:"review",transcriptDir:"/run"},text:"launched"}));
 await $.session.start(start);await ($.tool.call as EngineCall<"tool.call">)({tool:"Workflow",tool_use_id:"workflow-tool",script:"return 1"});await h.clock.settle();
 expect(h.persisted.has("session/s1/run/wf1")).toBe(true);
 h.control.projectThrows=false;await h.clock.advance(8000);await h.clock.settle();
 const entry=h.persisted.get("session/s1/run/wf1") as {ref?:string;parent?:string};
 expect(entry.ref).toBe("fixture#c2");expect(entry.parent).toBe("fixture#c1");
});

const workflow = {
  status: "async_launched",
  taskId: "w1",
  taskType: "local_workflow",
  workflowName: "check",
  runId: "run1",
  summary: "Check workflow",
  transcriptDir: "/tmp/run1",
};

test("workflow launch is idempotent", async ($, on) => {
  const h = harness(on);
  on("tool.call", { tool: "Workflow" }, () => ({
    result: workflow,
    text: "launched",
  }));
  await $.session.start(start);
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Workflow",
    tool_use_id: "wf1",
    script: 'return "done"',
  });
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Workflow",
    tool_use_id: "wf1",
    script: 'return "done"',
  });
  await h.clock.settle();
  expect(h.issues.size).toBe(1);
  expect(h.calls.filter((a) => a[1] === "create").length).toBe(1);
  expect(h.calls.find((a) => a[1] === "create")).toContain(
    "claude-workflow:s1:w1",
  );
});

test("remote workflow launch is tracked once and joins its terminal delivery", async ($, on) => {
  const h = harness(on);
  on("tool.call", { tool: "Workflow" }, () => ({
    result: { ...workflow, status: "remote_launched", taskType: "remote_agent", runId: undefined, sessionUrl: "https://example.com/session/remote" },
    text: "launched",
  }));
  await $.session.start(start);
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({
    tool: "Workflow",
    tool_use_id: "wf1",
    script: 'return "done"',
  });
  await h.clock.settle();
  expect(h.issues.size).toBe(1);
  expect(h.issues.get("c1")!.issue.metadata["claude.workflow_run_id"]).toBe("w1");
  expect(h.issues.get("c1")!.issue.metadata["claude.workflow_remote"]).toBe("true");
  // Remote paths do not certify the local checkout, even with a verified claim.
  const notice = delivery("remote-delivery");
  (notice.message.content[0] as {type:"text";text:string}).text = (notice.message.content[0] as {type:"text";text:string}).text.replace("WF_DONE", JSON.stringify({verified:true, files:["README.md"]}));
  h.persisted.set("session/s1/workflow-notice/w1", {notice:workflowDelivery(notice), uuid:notice.uuid});
  await $.session.start(start); await h.clock.settle();
  expect(h.issues.get("c1")!.issue.metadata["claude.status"]).toBe("completed");
  expect(h.issues.get("c1")!.issue.status).toBe("open");
  expect(h.issues.get("c1")!.labels).toContain("needs-review");
});

test("session end batches running child observations in one process with short timeout", async ($, on) => {
  const h = harness(on);
  on("agent.spawn", () => ({ model: "sonnet", agentId: "a1" }));
  await $.session.start(start);
  await $.agent.spawn(spawn());
  await h.clock.settle();
  const before = h.calls.length;
  await $.session.end({
    reason: "other",
    sessionId: "s1",
    resume: { id: "s1" },
  });
  expect(h.calls.slice(before).length).toBe(1);
  expect(h.calls[before]?.[0]).toBe("/bin/sh");
  expect(h.calls[before]?.join(" ")).toContain("session-ended");
});

const delivery = (
  uuid = "delivery-1",
  id = "w1",
  status = "completed",
): SessionAppendInput => ({
  uuid,
  door: "delivery",
  origin: { kind: "task-notification" },
  message: {
    type: "attachment",
    name: "queued_command",
    role: "user",
    content: [
      {
        type: "text",
        text: `<system-reminder>\n<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Workflow finished</summary>\n<result>WF_DONE</result>\n</task-notification>\n</system-reminder>`,
      },
    ],
  },
});

test("workflow envelope preserves task identity and outcome", () => {
  const text = (delivery().message.content[0] as { type: "text"; text: string })
    .text;
  expect(workflowNotice(text)).toEqual({
    taskId: "w1",
    status: "completed",
    summary: "Workflow finished",
    result: "WF_DONE",
  });
  expect(workflowNotice(text + text)).toBeUndefined();
  expect(
    workflowNotice(text.replace("</task-notification>", "")),
  ).toBeUndefined();
  expect(workflowNotice(text.replace("completed", "idle"))).toBeUndefined();
});

test("idle-session workflow notification uses prompt door with harness origin", () => {
  const event = {
    ...delivery(),
    door: "prompt" as const,
    message: { ...delivery().message, type: "user" as const },
  };
  expect(workflowDelivery(event)?.taskId).toBe("w1");
  expect(
    workflowDelivery({ ...event, origin: { kind: "composer" } }),
  ).toBeUndefined();
  expect(
    workflowDelivery({ ...event, agentId: "workflow-fork" }),
  ).toBeUndefined();
});

test("delivery parser rejects duplicate fields and malformed partial tags", () => {
  const text = (delivery().message.content[0] as { type: "text"; text: string }).text;
  expect(
    workflowDelivery({
      ...delivery(),
      message: {
        ...delivery().message,
        content: [
          {
            type: "text",
            text: text.replace(
              "<status>completed</status>",
              "<status>completed</status><status>failed</status>",
            ),
          },
        ],
      },
    }),
  ).toBeUndefined();
});

test("workflow result becomes a readable name, status and section summary", () => {
  const notice = { taskId: "w1", status: "completed" as const, summary: "Finished", result: JSON.stringify({ review: { findings: [{ severity: "high", issue: "CRLF loses characters", suggestion: "Preserve newlines" }] }, docs: { summary: "README.md written", answer: "Usage documented" } }) };
  const result = workflowSummary("review-and-readme", notice);
  expect(result).toContain("Workflow review-and-readme — completed");
  expect(result).toContain("review");
  expect(result).toContain("CRLF loses characters");
  expect(result).toContain("README.md written");
  expect(result).toContain("Usage documented");
  expect(result).not.toContain('{"review"');
});

test("large first workflow section cannot crowd out the other agent's result", () => {
  const result = workflowSummary("check", { taskId: "w", status: "completed", summary: "done", result: JSON.stringify({ review: "x".repeat(20000), docs: "README_READY" }) });
  expect(result.length).toBeLessThanOrEqual(4000);
  expect(result).toContain("README_READY");
});

test("workflow text and malformed JSON fall back to trimmed readable text", () => {
  for (const result of ["  Completed checks.  ", '{"partial":']) {
    expect(workflowSummary("check", { taskId: "w", status: "failed", summary: "failed", result })).toBe(`Workflow check — failed\n\n${result.trim()}`);
  }
});

test("workflow runs use a sanitized named teammate with the hash suffix", async ($, on) => {
  const h = harness(on);
  on("tool.call", { tool: "Workflow" }, () => ({ result: { ...workflow, workflowName: "Review / README" }, text: "launched" }));
  await $.session.start(start);
  await ($.tool.call as import("claude-code/testing").EngineCall<"tool.call">)({ tool: "Workflow", tool_use_id: "wf1", script: 'return "done"' });
  await h.clock.settle();
  const call = h.calls.find(a => a[1] === "create")!;
  expect(call[call.indexOf("--teammate") + 1]).toMatch(/^wf-review---readme-[a-f0-9]{6}$/);
  expect(h.issues.get("c1")?.issue.metadata["claude.teammate"]).toMatch(/^wf-review---readme-[a-f0-9]{6}$/);
});

test("blank result falls back to the useful workflow summary", () => {
  expect(workflowSummary("check", { taskId: "w", status: "completed", summary: "Checks passed", result: "   " })).toBe("Workflow check — completed\n\nChecks passed");
});
