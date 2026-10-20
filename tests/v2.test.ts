import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { assertIsolated } from "./isolation";
import ompKata from "../kata";
assertIsolated();
const binary = process.env.KATA_TEST_EXECUTABLE!;
if (!binary || !path.isAbsolute(binary)) throw new Error("Set KATA_TEST_EXECUTABLE to the absolute Kata binary.");
const scratch = mkdtempSync(path.join(process.env.KATA_TEST_ROOT!, "v2-"));
const cwd = path.join(scratch, "workspace"), outside = path.join(scratch, "outside");
mkdirSync(cwd); mkdirSync(outside);
const env = { ...process.env, KATA_HOME: path.join(scratch, "home"), KATA_AUTHOR: "v2-builder" };
for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER"]) delete env[key];
const exec = promisify(execFile);
async function run(args: string[], workspace = cwd, timeout = 5000) {
  assertIsolated(env);
  try { const out = await exec(binary, args, { env, cwd: workspace, timeout }); return { ...out, code: 0, killed: false }; }
  catch (error: any) { return { stdout: error.stdout || "", stderr: error.stderr || error.message, code: error.code || 1, killed: !!error.killed }; }
}
async function kata(args: string[], workspace = cwd): Promise<any> {
  const out = await run(args, workspace);
  if (out.code) throw new Error(out.stderr);
  return JSON.parse(out.stdout);
}
const show = async (ref: string) => kata(["show", ref, "--json"]);
let sequence = 0;
async function issue(title = "Explicit parent") { return (await kata(["create", `${title} ${++sequence}`, "--force-new", "--json"])).issue.short_id; }
const evidence = ["test:bun test fixture"];
const message = "Implemented this isolated fixture and verified its behavior with the regression suite.";
function host(options: any = {}) {
  const sid = options.sid === null ? undefined : options.sid || `v2-${++sequence}`;
  let tool: any;
  const handlers = new Map<string, any>(), bus = new Map<string, any>();
  const entries: any[] = options.entries || [], calls: string[][] = [], notices: any[] = [], widgets: any[] = [];
  const schema: any = new Proxy(() => schema, { get: () => schema });
  const ctx: any = {
    cwd: options.cwd || cwd,
    agent: options.agent || { kind: "main", id: `main-${sid}` },
    sessionManager: { getSessionId: () => sid, getSessionFile: () => options.sessionFile || `${scratch}/${sid}.jsonl`, getBranch: () => entries },
    getAsyncJobSnapshot: () => options.snapshot?.() || { running: [], recent: [] },
    ui: { notify: (...args: any[]) => notices.push(args), setWidget: (...args: any[]) => widgets.push(args) },
  };
  ompKata({ zod: schema, registerTool: (value: any) => tool = value, appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
    on: (name: string, callback: any) => handlers.set(name, callback), events: { on: (name: string, callback: any) => bus.set(name, callback) },
    async exec(file: string, args: string[], opts: any) { calls.push(args); return await options.before?.(args, opts) ?? run(args, opts.cwd, opts.timeout); },
  });
  return { ctx, sid, entries, calls, notices, widgets,
    event: async (name: string, data: any = {}, context: any = ctx) => handlers.get(name)?.(data, context),
    emit: (name: string, data: any) => bus.get(name)?.(data),
    call: (params: any) => tool.execute("fixture", params, undefined, undefined, ctx),
    async init(items = ["Implement fixture", "Verify fixture"]) { const result = await tool.execute("fixture", { op: "init", items }, undefined, undefined, ctx); expect(result.isError).toBeUndefined(); return result.details.kata.parent; },
  };
}
beforeAll(async () => { const out = await run(["init", "--project", "v2test"]); if (out.code) throw new Error(out.stderr); });
beforeEach(() => { process.env.KATA_AUTHOR = "v2-builder"; for (const key of ["KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER"]) delete process.env[key]; });
afterAll(async () => { await run(["daemon", "stop"]); });

test("subagent start and shutdown never touch main attention or widget", async () => {
  const ref = await issue(); await kata(["claim", ref, "--json"]); await kata(["meta", "set", ref, "work.attention", "ok", "--json"]);
  process.env.KATA_REF = ref;
  const app = host({ agent: { kind: "sub", id: "child-a", parentId: "main" } });
  await app.event("session_start"); await app.event("session_shutdown");
  expect((await show(ref)).issue.metadata["work.attention"]).toBe("ok");
  expect(app.calls.filter(a => a[0] === "meta")).toEqual([]);
  expect(app.widgets).toEqual([]);
});

test("nonproject folders get a local plan without Kata mutations or prompt noise", async () => {
  const app = host({ cwd: outside }); await app.event("session_start");
  await app.init();
  expect((await app.call({ op: "done", task: "Implement fixture" })).isError).toBeUndefined();
  expect((await app.call({ op: "view" })).content[0].text).toContain("Session-local");
  expect(app.calls.some(a => ["create", "claim", "meta", "close"].includes(a[0]))).toBe(false);
  expect(app.notices).toEqual([]);
});

test("KATA_REF beats stored session binding and is qualified", async () => {
  const old = await issue(), next = await issue(); process.env.KATA_REF = next;
  const app = host({ entries: [{ type: "custom", customType: "io.kata.omp.parent", data: { parent: old } }] });
  await app.event("session_start"); const view = await app.call({ op: "view" });
  expect(view.details.kata.parent).toBe(`v2test#${next}`);
});

test("auto parents carry typed identity, pinned refs and close exactly once from child evidence", async () => {
  const app = host(); const ref = await app.init();
  expect(ref).toMatch(/^v2test#/);
  expect((await show(ref)).issue.metadata["omp.auto_parent"]).toBe(true);
  expect((await show(ref)).issue.metadata["omp.session_id"]).toBe(app.sid);
  for (const task of ["Implement fixture", "Verify fixture"]) expect((await app.call({ op: "done", task, message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
  await app.call({ op: "view" }); await app.event("session_stop");
  const rows = (await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === ref.split("#")[1]);
  expect(rows).toHaveLength(1);
  const evt = (await kata(["events", "--after", String(rows[0].event_id - 1), "--limit", "1", "--json"])).events[0];
  expect(evt.payload.evidence).toEqual([{ type: "test", command: "bun test fixture" }]);
  expect(app.calls.every(a => a.includes("--workspace"))).toBe(true);
});

test("explicit parent is never auto-closed and rejected close leaves status active", async () => {
  const ref = await issue(); process.env.KATA_REF = ref;
  let deny = true;
  const app = host({ before: (a: string[]) => a[0] === "close" && deny ? { code: 1, stderr: "evidence denied", stdout: "" } : undefined });
  await app.event("session_start"); await app.init(["A guarded task"]);
  expect((await app.call({ op: "done", message, evidence })).isError).toBe(true);
  expect((await show(ref)).children[0].metadata["todo.status"]).toBe("in_progress");
  deny = false; expect((await app.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open");
});

test("wontfix floors and slash sibling messages pass real Kata guards", async () => {
  const app = host(); const ref = await app.init(["x", "y", "z"]);
  expect((await app.call({ op: "drop", task: "x", message: "no" })).isError).toBeUndefined();
  await app.event("input", { text: "/todo done", source: "interactive" });
  await app.event("input", { text: "/todo done", source: "interactive" });
  expect((await show(ref)).children.every((c: any) => c.status === "closed")).toBe(true);
});

test("id-less session never creates an unknown automatic parent", async () => {
  const app = host({ sid: null });
  expect((await app.call({ op: "init", items: ["No session identity"] })).isError).toBe(true);
  expect(app.calls.some(a => a[0] === "create")).toBe(false);
});

test("successful standalone main claim adopts an existing auto parent", async () => {
  const app = host(); const auto = await app.init(); const explicit = await issue();
  await kata(["claim", explicit, "--json"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata claim ${explicit}` }, isError: false, details: { exitCode: 0 } });
  expect((await app.call({ op: "view" })).details.kata.parent).toBe(`v2test#${explicit}`);
  expect((await show(explicit)).children.some((c: any) => c.short_id === auto.split("#")[1])).toBe(true);
});

test("contract is cached verbatim, inbox cached, slow hooks bounded and failures quiet", async () => {
  process.env.KATA_INBOX_USER = "v2-builder";
  const app = host(); await app.event("session_start");
  const first = await app.event("before_agent_start", { systemPrompt: ["base"] });
  const second = await app.event("before_agent_start", { systemPrompt: ["base"] });
  const contract = JSON.parse((await run(["agent-contract-hook", "--source", "kata-agent-contract-hook"])).stdout).hookSpecificOutput.additionalContext;
  expect(first.systemPrompt.join("\n")).toContain(contract);
  expect(second.systemPrompt.join("\n")).toContain(contract);
  expect(app.calls.filter(a => a[0] === "agent-contract-hook")).toHaveLength(1);
  expect(app.calls.filter(a => a[0] === "inbox")).toHaveLength(1);
  const slow = host({ before: async () => { await Bun.sleep(600); return { code: 1, stderr: "offline", stdout: "" }; } });
  const start = performance.now(); await slow.event("session_start"); await slow.event("before_agent_start", { systemPrompt: ["base"] });
  expect(performance.now() - start).toBeLessThan(600);
  expect(slow.notices).toEqual([]);
});

test("external closes reconcile an auto parent, including non-todo children", async () => {
  const app = host(); const ref = await app.init(["External task"]);
  const extra = (await kata(["create", "External verification child", "--parent", ref, "--force-new", "--json"])).issue.short_id;
  expect((await app.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open");
  await kata(["close", extra, "--done", "--message", "Externally verified this additional child with an independent test run.", "--test", "external verifier", "--json"]);
  await app.call({ op: "view" }); expect((await show(ref)).issue.status).toBe("closed");
});

test("spawn creates a teammate child; subagent gets verbatim contract and closes itself", async () => {
  const parent = host(); await parent.event("session_start"); const ref = await parent.init(["Await delegated work"]);
  const sessionFile = `${scratch}/delegate-one.jsonl`;
  await parent.event("before_subagent_spawn", { agent: "task", invocationKind: "task" });
  parent.emit("task:subagent:lifecycle", { id: "Build.Widget", agent: "task", status: "started", sessionFile });
  const child = host({ agent: { kind: "sub", id: "Build.Widget", parentId: parent.ctx.agent.id }, sessionFile });
  await child.event("session_start");
  const prompt = await child.event("before_agent_start", { systemPrompt: ["child base"] });
  await parent.call({ op: "view" });
  const tracked = (await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "Build.Widget");
  expect(tracked).toBeDefined();
  const teammate = tracked.metadata.teammate;
  expect(teammate).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  expect(prompt.systemPrompt.join("\n")).toContain(`v2test#${tracked.short_id}`);
  const contract = JSON.parse((await run(["agent-contract-hook", "--source", "kata-agent-contract-hook"])).stdout).hookSpecificOutput.additionalContext;
  expect(prompt.systemPrompt.join("\n")).toContain(contract);
  const rewritten = await child.event("tool_call", { toolName: "bash", input: { command: `kata close v2test#${tracked.short_id} --done --message '${message}' --test 'subagent verification'` } });
  expect(rewritten.input.command).toContain(`--teammate '${teammate}'`);
  // Execute the actual rewritten child command, not a parent-generated close.
  await exec("/bin/sh", ["-c", rewritten.input.command.replace(/^kata /, `'${binary}' `)], { env, cwd });
  expect((await show(`v2test#${tracked.short_id}`)).issue.status).toBe("closed");
  await child.event("session_shutdown");
  expect((await parent.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("open"); // Native agent still running.
  parent.emit("task:subagent:lifecycle", { id: "Build.Widget", status: "completed", sessionFile });
  await parent.call({ op: "view" }); expect((await show(ref)).issue.status).toBe("closed");
  expect(child.widgets).toEqual([]);
  expect(child.calls.some(a => a[0] === "meta" && a[3]?.startsWith("work."))).toBe(false);
});

test("finished unclosed delegates remain open needs-review, with no parent proof fallback", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Await unverified delegate"]);
  const sessionFile = `${scratch}/delegate-unclosed.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "unclosed", agent: "task", status: "started", sessionFile });
  await app.call({ op: "view" });
  app.emit("task:subagent:lifecycle", { id: "unclosed", status: "completed", sessionFile });
  await app.call({ op: "done", message, evidence });
  const child = (await show(parent)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "unclosed");
  expect(child.status).toBe("open");
  const view = await show(`v2test#${child.short_id}`);
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect((await show(parent)).issue.status).toBe("open");
});

test("subagent bash attribution ignores quoted data, replaces teammates and refuses --as", async () => {
  const child = host({ agent: { kind: "sub", id: "Quoted-Agent", parentId: "parent" } });
  for (const command of ["kata --as actor-b list", "kata claim abc --as=actor-b", "echo hi && '/usr/bin/kata' --as actor-b list"]) {
    expect((await child.event("tool_call", { toolName: "bash", input: { command } })).block).toBe(true);
  }
  const data = "echo 'kata --as actor-b'; printf '%s' 'kata claim abc'";
  expect(await child.event("tool_call", { toolName: "bash", input: { command: data } })).toBeUndefined();
  const command = "kata comment abc --body '--as is just prose' --teammate other && kata list";
  const result = await child.event("tool_call", { toolName: "bash", input: { command } });
  expect(result.block).toBeUndefined();
  expect(result.input.command).toContain("--body '--as is just prose'");
  expect(result.input.command).not.toContain("--teammate other");
  expect(result.input.command.match(/--teammate/g)).toHaveLength(2);
});

test("pinned plan survives cwd changes and ignores another session's saved binding", async () => {
  const app = host(); const parent = await app.init(["Pinned task"]);
  app.ctx.cwd = outside;
  expect((await app.call({ op: "append", items: ["Another pinned task"] })).isError).toBeUndefined();
  expect((await show(parent)).children).toHaveLength(2);
  const next = host({ entries: app.entries }); await next.event("session_start");
  expect((await next.call({ op: "view" })).details.kata.parent).toBeUndefined();
});

test("new work reopens an auto parent; all-wontfix parents require review", async () => {
  const app = host(); const parent = await app.init(["Initial work"]);
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
  await app.call({ op: "append", items: ["Additional work"] });
  expect((await show(parent)).issue.status).toBe("open");
  const dropped = host(); const retired = await dropped.init(["x"]);
  await dropped.call({ op: "drop", message: "no" });
  const view = await show(retired);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("sibling throttle retries the pinned close and does not falsely complete metadata", async () => {
  let throttled = false;
  const app = host({ before: (a: string[]) => {
    if (!throttled && a[0] === "close") { throttled = true; return { code: 1, stdout: "", stderr: "sibling close throttle; retry after 60s" }; }
  } });
  const parent = await app.init(["Throttled task"]);
  const result = await app.call({ op: "done", message, evidence });
  expect(result.isError).toBeUndefined();
  expect(result.content[0].text).toContain("retry");
  expect((await show(parent)).children[0].metadata["todo.status"]).toBe("in_progress");
  app.ctx.cwd = outside;
  const actualNow = Date.now;
  Date.now = () => actualNow() + 61_000;
  try { await app.event("session_stop"); await app.call({ op: "view" }); }
  finally { Date.now = actualNow; }
  expect((await show(parent)).issue.status).toBe("closed");
});

test("membership changes during evidence retrieval prevent auto-parent close", async () => {
  let mutate = false;
  let parent: string;
  const app = host({ before: async (a: string[]) => {
    if (mutate && a[0] === "events") { mutate = false; await kata(["create", "Concurrent child", "--parent", parent, "--force-new", "--json"]); }
  } });
  parent = await app.init(["Initial closed child"]); mutate = true;
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("open");
});

test("cross-project adoption pins new children to the claimed project", async () => {
  const other = path.join(scratch, `other-${++sequence}`); mkdirSync(other);
  await kata(["init", "--project", "v2other", "--json"], other);
  const foreign = (await kata(["create", "Cross-project claimed issue", "--owner", "v2-builder", "--force-new", "--json"], other)).issue.short_id;
  const app = host(); const original = await app.init(["Original task"]);
  await app.event("tool_result", { toolName: "bash", input: { command: `kata --workspace '${other}' claim ${foreign}` }, isError: false });
  const current = await app.call({ op: "view" });
  expect(current.details.kata.parent).toBe(`v2other#${foreign}`);
  expect((await app.call({ op: "append", items: ["Claimed-project task"] })).isError).toBeUndefined();
  const view = await show(`v2other#${foreign}`);
  const child = view.children.find((c: any) => c.title === "Claimed-project task");
  expect(child.project_id).toBe(view.issue.project_id);
  expect((await show(original)).issue.status).toBe("open");
});

test("typed automatic parent can be recovered after losing the session entry", async () => {
  const app = host(); const parent = await app.init(["Durable existing task"]);
  const recovered = host({ sid: app.sid }); await recovered.event("session_start");
  expect((await recovered.call({ op: "view" })).details.kata.parent).toBe(parent);
});

test("async snapshot settles a delegate when terminal lifecycle delivery is missing", async () => {
  let recent: any[] = [];
  const app = host({ snapshot: () => ({ running: [], recent }) });
  await app.event("session_start"); const parent = await app.init(["Wait for snapshot"]);
  app.emit("task:subagent:lifecycle", { id: "snapshot-child", agent: "task", status: "started", sessionFile: `${scratch}/snapshot-child.jsonl` });
  await app.call({ op: "view" });
  recent = [{ id: "snapshot-child", type: "task", status: "completed" }];
  await app.event("session_stop"); await app.call({ op: "view" });
  const child = (await show(parent)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "snapshot-child");
  expect((await show(`v2test#${child.short_id}`)).labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("relative lifecycle session paths join the child's absolute session path", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Relative child path"]);
  app.emit("task:subagent:lifecycle", { id: "relative-child", agent: "task", status: "started", sessionFile: "../relative-session.jsonl" });
  const child = host({ agent: { kind: "sub", id: "relative-child", parentId: app.ctx.agent.id }, sessionFile: path.join(scratch, "relative-session.jsonl") });
  await child.event("session_start");
  const result = await child.event("before_agent_start", { systemPrompt: ["base"] });
  expect(result.systemPrompt.join("\n")).toContain("<kata_binding>");
  expect(result.systemPrompt.join("\n")).toContain("relative-child");
});

test("explicitly adopting the auto issue revokes and persists automatic close authority", async () => {
  const app = host(); const parent = await app.init(["Explicitly retained task"]);
  await app.call({ op: "init", ref: parent, items: ["Explicitly retained task"] });
  expect(app.entries.filter(e => e.customType === "io.kata.omp.parent").at(-1).data.auto).toBe(false);
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("open");
  const restored = host({ sid: app.sid, entries: app.entries }); await restored.event("session_start"); await restored.call({ op: "view" });
  expect((await show(parent)).issue.status).toBe("open");
});

test("Kata rejects incompatible parent evidence without dropping it from the union", async () => {
  const app = host(); const parent = await app.init(["Typed union task"]);
  const audit = (await kata(["create", "No-change verification", "--parent", parent, "--force-new", "--json"])).issue.short_id;
  await kata(["close", audit, "--audit-no-change", "--message", "Audited the current implementation and verified no additional changes were required.", "--reviewed", "README.md", "--evidence", "no-change-audit:Existing behavior already satisfies the specification", "--json"]);
  await app.call({ op: "done", message, evidence });
  expect(app.calls.some(a => a[0] === "close" && a[1] === parent && a.includes("no-change-audit:Existing behavior already satisfies the specification"))).toBe(true);
  const view = await show(parent);
  expect(view.issue.status).toBe("open");
  expect(view.labels.some((l: any) => l.label === "needs-review")).toBe(true);
});

test("advisor tool calls cannot steal the main session's spawn coordinator", async () => {
  const app = host(); await app.event("session_start"); const parent = await app.init(["Advisor-safe delegation"]);
  await app.event("tool_call", { toolName: "bash", input: { command: "echo advisor" } }, { ...app.ctx, agent: { kind: "sub", id: "advisor" } });
  app.emit("task:subagent:lifecycle", { id: "after-advisor", agent: "task", status: "started", sessionFile: `${scratch}/after-advisor.jsonl` });
  await app.call({ op: "view" });
  expect((await show(parent)).children.some((c: any) => c.metadata?.["omp.subagent_id"] === "after-advisor")).toBe(true);
});

test("auto-parent evidence resolves cross-project children in their own projects", async () => {
  const other = path.join(scratch, `evidence-${++sequence}`); mkdirSync(other);
  await kata(["init", "--project", "v2evidence", "--json"], other);
  const app = host(); const parent = await app.init(["Local evidence task"]);
  const extra = (await kata(["create", "Cross-project evidence", "--parent", parent, "--force-new", "--json"], other)).issue.short_id;
  await kata(["close", `v2evidence#${extra}`, "--done", "--message", "Verified this cross-project component with its own independent test evidence.", "--test", "cross-project validation", "--json"], other);
  await app.call({ op: "done", message, evidence });
  expect((await show(parent)).issue.status).toBe("closed");
});

test("missing agent identity never grants main-session attention authority", async () => {
  const ref = await issue(); await kata(["claim", ref, "--json"]);
  process.env.KATA_REF = ref;
  const app = host({ agent: {} });
  await app.event("session_start"); await app.event("session_shutdown");
  expect(app.calls.some(a => a[0] === "meta" && a[3]?.startsWith("work."))).toBe(false);
  expect(app.widgets).toEqual([]);
});

for (const entry of ["lazy", "titled", "subagent-first"]) test(`${entry} auto parent is typed before a failed attention claim and recoverable`, async () => {
  let rejectClaim = true;
  const app = host({ before: (a: string[]) => a[0] === "claim" && rejectClaim ? { code: 1, stderr: "temporary claim failure", stdout: "" } : undefined });
  await app.event("session_start");
  if (entry === "subagent-first") await app.event("before_subagent_spawn", { agent: "task" });
  else await app.call({ op: "init", items: ["Recovered task"], ...(entry === "titled" ? { message: "A titled plan parent" } : {}) });
  await app.call({ op: "view" }); // drain the bounded spawn hook
  const list = (await kata(["list", "--status", "all", "--meta", `omp.session_id=${app.sid}`, "--json"])).issues;
  const parent = list.find((i: any) => !i.metadata?.["todo.phase"]);
  expect(parent.metadata["omp.auto_parent"]).toBe(true);
  expect(parent.metadata["omp.session_id"]).toBe(app.sid);
  expect(parent.metadata["omp.workspace"]).toBe(cwd);
  rejectClaim = false;
  const resumed = host({ sid: app.sid }); await resumed.event("session_start");
  const ref = await resumed.init(["Recovered task"]);
  expect(ref).toBe(`v2test#${parent.short_id}`);
  expect((await resumed.call({ op: "done", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
});

for (const match of ["active", "named"]) test(`delegation reuses the ${match} plan task with child-owned closure`, async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  expect((await app.call({ op: "start", task: "Implement widget" })).isError).toBeUndefined();
  const expected = (await show(ref)).children.find((c: any) => c.title === (match === "active" ? "Implement widget" : "Write widget tests"));
  await app.event("tool_call", { toolName: "task", toolCallId: `call-${match}`, input: { agent: "task", task: match === "named" ? 'Complete plan task "Write widget tests" and commit it.' : "Complete the current task and commit it." } });
  const sessionFile = `${scratch}/reuse-${match}.jsonl`;
  app.emit("task:subagent:lifecycle", { id: `reuse-${match}`, status: "started", sessionFile, parentToolCallId: `call-${match}`, index: 0 });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  const delegated = children.find((c: any) => c.metadata?.["omp.subagent_id"] === `reuse-${match}`);
  expect(delegated.short_id).toBe(expected.short_id);
  const child = host({ agent: { kind: "sub", id: `reuse-${match}`, parentId: app.ctx.agent.id }, sessionFile });
  await child.event("session_start");
  const prompt = (await child.event("before_agent_start", { systemPrompt: [] })).systemPrompt.join("\n");
  expect(prompt).toContain(`Your Kata issue is v2test#${expected.short_id};`);
  expect(prompt).toContain(`close 'v2test#${expected.short_id}'`);
  // The main cannot close the delegated issue on behalf of a running worker.
  expect((await app.call({ op: "done", task: expected.title, message, evidence })).isError).toBe(true);
  await kata(["close", expected.short_id, "--teammate", delegated.metadata.teammate, "--done", "--message", message, "--test", `delegate-${match}`, "--json"]);
  app.emit("task:subagent:lifecycle", { id: `reuse-${match}`, status: "completed", sessionFile });
  await app.call({ op: "view" });
  expect((await app.call({ op: "done", task: match === "active" ? "Write widget tests" : "Implement widget", message, evidence })).isError).toBeUndefined();
  expect((await show(ref)).issue.status).toBe("closed");
  expect(app.calls.some(a => a[0] === "close" && a[1] === `v2test#${expected.short_id}`)).toBe(false);
});

test("batch delegates bind named plan tasks by spawn index without duplicates", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Build alpha", "Build beta"]);
  const tasks = (await show(ref)).children;
  await app.event("tool_call", { toolName: "task", toolCallId: "batch-binding", input: { tasks: [{ task: "Finish Build beta" }, { task: "Finish Build alpha" }] } });
  for (const [index, id] of ["batch-beta", "batch-alpha"].entries()) app.emit("task:subagent:lifecycle", { id, status: "started", sessionFile: `${scratch}/${id}.jsonl`, parentToolCallId: "batch-binding", index });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(2);
  for (const [title, id] of [["Build alpha", "batch-alpha"], ["Build beta", "batch-beta"]]) {
    const child = children.find((c: any) => c.title === title);
    expect(child.short_id).toBe(tasks.find((c: any) => c.title === title).short_id);
    expect(child.metadata["omp.subagent_id"]).toBe(id);
  }
});

test("a delegated plan task cannot be assigned to a second subagent", async () => {
  const app = host(); await app.event("session_start"); await app.init(["One worker only"]);
  const input = { task: 'Complete "One worker only"' };
  await app.event("tool_call", { toolName: "task", toolCallId: "first-worker", input });
  expect(await app.event("tool_call", { toolName: "task", toolCallId: "second-worker", input })).toMatchObject({ block: true });
});

test("local plan and blockers survive extension recreation through session entries", async () => {
  const app = host({ cwd: outside }); await app.event("session_start");
  await app.init(["Durable local first", "Durable local second"]);
  await app.call({ op: "block", reason: "Waiting on a durable dependency" });
  const entries = JSON.parse(JSON.stringify(app.entries));
  const resumed = host({ cwd: outside, sid: app.sid, entries }); await resumed.event("session_start");
  const view = await resumed.call({ op: "view" });
  expect(view.content[0].text).toContain("Waiting on a durable dependency");
  expect(view.details.phases[0].tasks.map((t: any) => t.status)).toEqual(["blocked", "in_progress"]);
  const other = host({ cwd: outside, entries }); await other.event("session_start");
  expect((await other.call({ op: "view" })).content[0].text).toContain("No todo plan");
});

test("queued close survives extension recreation and retries only after its deadline", async () => {
  const app = host({ before: (a: string[]) => a[0] === "close" ? { code: 1, stdout: "", stderr: "sibling close throttle" } : undefined });
  const parent = await app.init(["Durable queued close"]);
  await app.call({ op: "done", message, evidence });
  const entries = JSON.parse(JSON.stringify(app.entries));
  const resumed = host({ sid: app.sid, entries }); await resumed.event("session_start");
  expect(resumed.calls.some(a => a[0] === "close")).toBe(false);
  const now = Date.now; Date.now = () => now() + 61_000;
  try {
    const restarted = host({ sid: app.sid, entries }); await restarted.event("session_start");
    await restarted.call({ op: "view" });
    expect((await show(parent)).issue.status).toBe("closed");
    expect((await kata(["audit", "closes", "--json"])).rows.filter((r: any) => r.issue === parent.split("#")[1])).toHaveLength(1);
  } finally { Date.now = now; }
});

// The 2026-10-19 eval: omp sent todo init and the tests delegation in one batch.
const evalPlan = ["Implement word_count and top_words in textstats", "Write unittest suite covering word_count, top_words, and empty input", "Run the suite with python3 -m unittest", "Commit the work"];
test("a delegation spawned in the same batch as todo init binds its plan task", async () => {
  const app = host(); await app.event("session_start");
  const hook = app.event("tool_call", { toolName: "task", toolCallId: "eval-batch", input: { context: "Add word_count and top_words to textstats.",
    tasks: [{ name: "WriteTests", agent: "task", task: "Write the textstats unittest suite in tests/ per the contract above" }] } });
  const ref = await app.init(evalPlan);
  await hook;
  app.emit("task:subagent:lifecycle", { id: "WriteTests", agent: "task", status: "started", sessionFile: `${scratch}/eval-batch.jsonl`, parentToolCallId: "eval-batch", index: 0 });
  await app.call({ op: "view" });
  let children = (await show(ref)).children;
  expect(children).toHaveLength(4);
  expect(children.find((c: any) => c.title === evalPlan[1]).metadata["omp.subagent_id"]).toBe("WriteTests");
  expect(children.find((c: any) => c.title === evalPlan[0]).metadata["omp.subagent_id"]).toBeUndefined();
  // The delegated task never occupies the lead's slot: finishing its own task starts the next one.
  expect((await app.call({ op: "done", task: evalPlan[0], message, evidence })).isError).toBeUndefined();
  children = (await show(ref)).children;
  expect(children.find((c: any) => c.title === evalPlan[2]).metadata["todo.status"]).toBe("in_progress");
});

test("an unrelated delegation never takes the lead's active task", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "probe", input: { task: "Reply with exactly: SUBAGENT-OK" } });
  app.emit("task:subagent:lifecycle", { id: "probe-agent", status: "started", sessionFile: `${scratch}/probe-agent.jsonl`, parentToolCallId: "probe", index: 0 });
  await app.call({ op: "view" });
  const children = (await show(ref)).children;
  expect(children).toHaveLength(3);
  expect(children.find((c: any) => c.title === "Implement widget").metadata["omp.subagent_id"]).toBeUndefined();
  expect(children.find((c: any) => c.metadata?.["omp.subagent_id"] === "probe-agent").title).toBe("Subagent probe-agent");
});

test("a finished delegate that leaves its plan task open hands it back for review", async () => {
  const app = host(); await app.event("session_start");
  const ref = await app.init(["Implement widget", "Write widget tests"]);
  await app.event("tool_call", { toolName: "task", toolCallId: "handback", input: { name: "WriteTests", task: "Write the widget tests" } });
  const sessionFile = `${scratch}/handback.jsonl`;
  app.emit("task:subagent:lifecycle", { id: "handback", status: "started", sessionFile, parentToolCallId: "handback", index: 0 });
  await app.call({ op: "view" });
  const task = (await show(ref)).children.find((c: any) => c.title === "Write widget tests");
  expect(task.metadata["omp.subagent_id"]).toBe("handback");
  expect((await app.call({ op: "done", task: "Write widget tests", message, evidence })).isError).toBe(true);
  app.emit("task:subagent:lifecycle", { id: "handback", status: "completed", sessionFile });
  await app.call({ op: "view" });
  const settled = await show(`v2test#${task.short_id}`);
  expect(settled.labels.some((l: any) => l.label === "needs-review")).toBe(true);
  expect(settled.issue.metadata.teammate).toBeUndefined();
  expect(Object.keys(settled.issue.metadata).some(key => key.startsWith("notify."))).toBe(true);
  expect((await app.call({ op: "done", task: "Write widget tests", message, evidence })).isError).toBeUndefined();
  const closed = await show(`v2test#${task.short_id}`);
  expect(closed.issue.status).toBe("closed");
  expect(closed.labels.some((l: any) => l.label === "needs-review")).toBe(false);
});

test("delegate teammates differ across sessions that reuse an agent name", async () => {
  const teammates: string[] = [];
  for (const n of [1, 2]) {
    const app = host(); await app.event("session_start"); const ref = await app.init([`Reused agent name ${n}`]);
    app.emit("task:subagent:lifecycle", { id: "WriteTests", status: "started", sessionFile: `${scratch}/reused-name-${n}.jsonl` });
    await app.call({ op: "view" });
    teammates.push((await show(ref)).children.find((c: any) => c.metadata?.["omp.subagent_id"] === "WriteTests").metadata.teammate);
  }
  expect(teammates[0]).not.toBe(teammates[1]);
});
