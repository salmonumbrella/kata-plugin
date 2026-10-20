// Run: KATA_TEST_EXECUTABLE=/absolute/path/to/kata-main node --test tests/real-kata.test.mjs
// The Claude plugin test sandbox forbids Node imports and native process nouns.
// This runner bundles the actual registered hooks and supplies a small host
// adapter; Kata commands and Bash verification execute as real subprocesses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const exec = promisify(execFile);
const binary = process.env.KATA_TEST_EXECUTABLE;
assert.ok(binary && path.isAbsolute(binary), "Set KATA_TEST_EXECUTABLE to an absolute real Kata binary path.");
const root = fileURLToPath(new URL("../", import.meta.url));
const clone = value => value === undefined ? undefined : structuredClone(value);

async function fixture({ bound = true, throttle = false, sdkDelayMs = 0, failChildCreateOnce = false, agents = [] } = {}) {
  const scratch = await mkdtemp(path.join(process.env.KATA_TEST_ROOT || os.tmpdir(), "kata-real-"));
  const cwd = path.join(scratch, "workspace"), home = path.join(scratch, "khome");
  await Promise.all([mkdir(cwd), mkdir(home)]);
  if (throttle) await writeFile(path.join(home, "config.toml"), '[close.throttle]\nenabled = true\nwindow = "10s"\n');
  const env = { ...process.env, KATA_HOME: home, KATA_AUTHOR: "integration-actor" };
  for (const key of ["KATA_SERVER", "KATA_DAEMON", "KATA_AUTH_TOKEN", "KATA_REF", "KATA_TEAMMATE", "KATA_INBOX_USER", "KATA_SESSION_ID"]) delete env[key];
  const calls = [], logs = [], stored = new Map(), state = new Map(), hooks = new Map(), timers = [];
  let active = 0, changes = 0, now = 0;
  const epoch=performance.now();
  const clockNow=()=>now+performance.now()-epoch;
  async function processRun(argv, init = {}) {
    active++;
    try {
      if (failChildCreateOnce && argv[1] === "create" && argv.some(arg => arg.startsWith("claude.tool_use_id="))) {
        failChildCreateOnce = false;
        return { exitCode: 1, stdout: "", stderr: "Injected transient child-create transport outage", isStdoutTruncated: false, isStderrTruncated: false };
      }
      const out = await exec(argv[0], argv.slice(1), { cwd: init.cwd || cwd, env, timeout: init.timeoutMs || 15000 });
      return { exitCode: 0, ...out, isStdoutTruncated: false, isStderrTruncated: false };
    } catch (err) {
      return { exitCode: typeof err.code === "number" ? err.code : 1, stdout: err.stdout || "", stderr: err.stderr || err.message, isStdoutTruncated: false, isStderrTruncated: false };
    } finally { active--; }
  }
  async function kata(args, success = true) {
    const result = await processRun([binary, ...args]);
    if (success) assert.equal(result.exitCode, 0, `${args.join(" ")}: ${result.stderr}`);
    return result;
  }
  async function json(args) { return JSON.parse((await kata([...args, "--json"])).stdout); }
  await kata(["init", "--project", "realtest"]);
  const parent = bound ? (await json(["create", "Explicit integration parent", "--force-new"])).issue.short_id : undefined;
  await writeFile(path.join(cwd, "test_proof.py"), 'import unittest\nclass Proof(unittest.TestCase):\n    def test_fixture(self):\n        self.assertEqual(2 + 2, 4)\n');

  // Match the SDK update contract: read state/version, CAS write, retry misses.
  // This adapter contains no Kata decision or close-validation logic.
  const compiled = await build({ entryPoints: [path.join(root, "hooks/register.ts")], bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "host-state-contract", setup(api) {
      api.onResolve({ filter: /^claude-code$/ }, () => ({ path: "claude-code", namespace: "host-adapter" }));
      api.onLoad({ filter: /.*/, namespace: "host-adapter" }, () => ({ contents: 'export async function update($,ref,change){for(;;){const old=await $.state.get(ref);const value=change(old.value);const written=await $.state.set(ref,value,{ifVersion:old.version});if(written.isSet)return value;}}', loader: "js" }));
    }}] });
  const modulePath = path.join(scratch, "registered-hooks.mjs");
  await writeFile(modulePath, compiled.outputFiles[0].text);
  const { register } = await import(pathToFileURL(modulePath).href);
  const stateKey = ref => JSON.stringify([ref.plugin, ref.key, ref.id]);
  const $ = {
    env: { get: async name => name === "KATA_REF" && parent ? `realtest#${parent}` : env[name] },
    session: { id: async () => "real-session", cwd: async () => cwd, root: async () => cwd, append: async () => undefined },
    store: {
      get: async key => clone(stored.get(key)),
      set: async (key, value) => { stored.set(key, clone(value)); changes++; },
      delete: async key => { stored.delete(key); changes++; },
      keys: async () => [...stored.keys()],
    },
    state: {
      get: async ref => clone(state.get(stateKey(ref)) || { value: undefined, version: 0 }),
      set: async (ref, value, options) => {
        const key = stateKey(ref), previous = state.get(key) || { version: 0 };
        if (options && options.ifVersion !== previous.version) return { isSet: false, version: previous.version };
        state.set(key, { value: clone(value), version: previous.version + 1 }); changes++;
        return { isSet: true, version: previous.version + 1 };
      },
    },
    clock: {
      now: async () => clockNow(),
      after(ms, callback) { const timer = { due: clockNow() + ms, callback, canceled: false }; timers.push(timer); return { cancel() { timer.canceled = true; } }; },
      sleep: async () => undefined,
    },
    process: { async run(argv, init) {
      const result = await processRun(argv, init); calls.push({ argv: [...argv], result }); return result;
    } },
    ui: { log: async (text, options) => logs.push({ text, ...options }), status: async () => undefined, toast: async () => undefined },
    command: { register: async () => ({ command: "kata" }) },
    agent: { list: async () => clone(agents) },
    fs: { stat: async file => {const st=await lstat(file);return {kind:st.isDirectory()?"directory":"file",size:st.size,mtimeMs:st.mtimeMs,isLink:st.isSymbolicLink(),realPath:await realpath(file)};} },
  };
  let keyScans = 0;
  if (sdkDelayMs) for (const [family, methods] of [["store",["get","set","keys","delete"]],["state",["get","set"]]]) {
    for (const method of methods) {
      const original=$[family][method];
      $[family][method]=async (...args)=>{if(method==="keys")keyScans++;await new Promise(r=>setTimeout(r,sdkDelayMs));return original(...args);};
    }
  }
  function reload(executable = binary) {
  hooks.clear();
  register((event, selector, handler) => {
    if (typeof selector === "function") { handler = selector; selector = undefined; }
    if (!hooks.has(event)) hooks.set(event, []);
    hooks.get(event).push({ selector, handler });
  }, { kataExecutable: executable });
  }
  reload();
  async function dispatch(event, input, native = async e => event === "turn.complete" ? { text: e.answer } : e) {
    const chain = (hooks.get(event) || []).filter(h => !h.selector || Object.entries(h.selector).every(([key, value]) => input[key] === value));
    const invoke = (index, e) => index === chain.length ? native(e) : chain[index].handler($, e, rewritten => invoke(index + 1, rewritten));
    return invoke(0, input);
  }
  async function settle(advance = 0) {
    const horizon = clockNow() + advance;
    const deadline = Date.now() + 10000;
    let stable = 0;
    while (Date.now() < deadline) {
      const before = changes;
      const nextDue = timers.filter(t => !t.canceled && t.due <= horizon).sort((a, b) => a.due - b.due)[0];
      if (nextDue) now += Math.max(0,nextDue.due-clockNow());
      const due = timers.filter(t => !t.canceled && t.due <= clockNow());
      for (const timer of due) { timer.canceled = true; await timer.callback(); }
      await new Promise(resolve => setTimeout(resolve, 10));
      stable = active === 0 && changes === before && !timers.some(t => !t.canceled && t.due <= clockNow()) ? stable + 1 : 0;
      if (stable >= 4) { now += Math.max(0,horizon-clockNow()); return; }
    }
    throw new Error("Registered hook effects did not settle: " + JSON.stringify(logs));
  }
  // Quiescence alone is not readiness: a durable operation may be asleep in
  // backoff. Pump the fixture clock while polling the state the test needs.
  async function waitFor(condition, description, timeoutMs = 20000) {
    const deadline = performance.now() + timeoutMs;
    do {
      await settle(1000);
      const value = await condition();
      if (value) return value;
    } while (performance.now() < deadline);
    throw new Error(`Timed out waiting for ${description}: ` + JSON.stringify({ logs, pending: [...stored.values()].filter(v => v?.kind && !v.ack) }));
  }
  async function ready(id) {
    return waitFor(() => entry(id)?.ref, `delegated issue for ${id}`);
  }
  async function closed(ref) {
    return waitFor(async () => (await json(["show", ref])).issue.status === "closed", `closed issue ${ref}`);
  }
  async function spawn(id, deny) {
    return dispatch("agent.spawn", {
      tool_use_id: id, prompt: `Implement and test ${id}`, description: `Integration ${id}`,
      subagentType: "general-purpose", provider: { plugin: "engine", tier: "core" }, parentModel: "sonnet", background: false, fork: false,
    }, async () => deny === undefined ? { model: "sonnet", agentId: id } : deny === null ? {} : { deny });
  }
  async function verify(id) {
    return dispatch("tool.call", { tool: "Bash", agentId: id, tool_use_id: `proof-${id}`, command: "python3 -m unittest -q test_proof" }, async e => {
      const result = await processRun(["/bin/sh", "-c", e.command]);
      return { result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, interrupted: false }, text: result.stdout };
    });
  }
  async function finish(id, answer = "Implemented the requested fixture and verified the actual Python test run successfully.") {
    await dispatch("turn.complete", { agentId: id, turnId: `final-${id}`, answer, reason: "answer", durationMs: 10, isAborted: false });
    await settle(2000);
    if (id) await waitFor(async () => {
      const ref = entry(id)?.ref;
      return ref && (await json(["show", ref])).issue.metadata["claude.status"] === "completed";
    }, `terminal metadata for ${id}`);
  }
  function entry(id) { return stored.get(`session/real-session/spawn/${id}`); }
  async function stop() { await kata(["daemon", "stop"]); }
  return { scratch, cwd, home, parent, stored, calls, logs, json, kata, dispatch, settle, waitFor, ready, closed, spawn, verify, finish, entry, stop, reload, keyScans:()=>keyScans };
}

test("real registered hooks close verified delegated work and its automatic parent", async () => {
  const h = await fixture({ bound: false });
  try {
    await h.dispatch("session.start", { cwd: h.cwd, surface: null, isInteractive: false });
    await h.spawn("verified-child"); await h.ready("verified-child");
    await h.verify("verified-child"); await h.finish("verified-child");
    const entry = h.entry("verified-child");
    assert.ok(entry?.ref);
    await h.closed(entry.ref);
    const child = (await h.json(["show", entry.ref])).issue;
    assert.equal(child.status, "closed", JSON.stringify({ entry, logs: h.logs, failures: h.calls.filter(c => c.result.exitCode).map(c => ({ argv: c.argv, stderr: c.result.stderr })) }, null, 2)); assert.equal(child.closed_reason, "done");
    await h.finish(undefined);
    const binding = h.stored.get("session/real-session/binding/parent");
    await h.closed(binding.autoParent);
    const parent = (await h.json(["show", binding.autoParent])).issue;
    assert.equal(parent.status, "closed"); assert.equal(parent.closed_reason, "done");
    assert.ok(h.calls.some(c => c.argv.includes("--test") && c.result.exitCode === 0));
  } finally { await h.stop(); }
});

test("real spawn naming an existing issue binds to it and creates no child or session issue", async () => {
  const h = await fixture({ bound: false });
  try {
    const named = (await h.json(["create", "Existing named work", "--force-new"])).issue.short_id;
    const other = (await h.json(["create", "Context-only parent", "--force-new"])).issue.short_id;
    const before = (await h.json(["list", "--status", "all", "--limit", "100"])).issues.length;
    await h.dispatch("session.start", { cwd: h.cwd, surface: null, isInteractive: false });
    let injected = "";
    await h.dispatch("agent.spawn", {
      tool_use_id: "named-child", prompt: `Kata issue: realtest#${named} (parent realtest#${other}). Implement and test it.`, description: "Named work",
      subagentType: "general-purpose", provider: { plugin: "engine", tier: "core" }, parentModel: "sonnet", background: false, fork: false,
    }, async e => { injected = e.prompt; return { model: "sonnet", agentId: "named-child" }; });
    assert.equal(h.entry("named-child")?.ref, `realtest#${named}`);
    // The binding line rides on the canonical contract; Kata builds without
    // `agent-contract-hook` output leave the prompt untouched (engine tests cover the line).
    if (/Kata is the system of record/.test(injected)) assert.ok(injected.includes(`tracked as realtest#${named} (the issue named in your task`), injected);
    else assert.ok(injected.startsWith("Kata issue: realtest#"), injected);
    await h.waitFor(async () => (await h.json(["show", named])).issue.metadata?.["claude.agent_id"] === "named-child", "bound agent id");
    await h.finish("named-child", "Implemented the named work; the lead closes it after review.");
    const after = (await h.json(["list", "--status", "all", "--limit", "100"])).issues;
    assert.equal(after.length, before, JSON.stringify(after.map(i => i.title)));
    const view = await h.json(["show", named]);
    assert.equal(view.issue.status, "open");
    assert.equal(view.issue.metadata["claude.status"], "completed");
    assert.equal(view.issue.metadata["claude.tool_use_id"], "named-child");
    assert.match(String(view.issue.metadata["claude.teammate"]), /^general-purpose-/);
    assert.ok(!Object.keys(view.issue.metadata).some(key => key.startsWith("work.")));
    assert.ok((view.comments ?? []).some(c => c.body.includes("Implemented the named work")));
    assert.equal(h.stored.get("session/real-session/binding/parent")?.autoParent, undefined);
  } finally { await h.stop(); }
});

test("real session whose first prompt names an issue parents children there without a session issue", async () => {
  const h = await fixture({ bound: false });
  try {
    const named = (await h.json(["create", "Session work named by the user", "--force-new"])).issue.short_id;
    await h.dispatch("session.start", { cwd: h.cwd, surface: null, isInteractive: false });
    await h.dispatch("prompt.submit", { text: `You own Kata issue realtest#${named}. Split the work across helpers.`, wait: false, origin: { kind: "composer" } });
    await h.spawn("helper"); const ref = await h.ready("helper");
    const child = await h.json(["show", ref]);
    const parent = await h.json(["show", named]);
    assert.ok((parent.children ?? []).some(c => c.short_id === child.issue.short_id), JSON.stringify(parent.children));
    const sessions = (await h.json(["list", "--status", "all", "--label", "claude-session", "--limit", "100"])).issues ?? [];
    assert.equal(sessions.length, 0);
  } finally { await h.stop(); }
});

for (const reason of ["No", null]) test(`real registered hooks close denied spawn (${reason ?? "no agent id"}) as wontfix with the canonical message floor`, async () => {
  const h = await fixture();
  try {
    await h.dispatch("session.start", { cwd: h.cwd, surface: null, isInteractive: false });
    await h.spawn("denied-child", reason); await h.ready("denied-child"); await h.closed(h.entry("denied-child").ref);
    const entry = h.entry("denied-child");
    assert.ok(entry?.ref);
    const child = (await h.json(["show", entry.ref])).issue;
    assert.equal(child.status, "closed", JSON.stringify({ entry, logs: h.logs, failures: h.calls.filter(c => c.result.exitCode).map(c => ({ argv: c.argv, stderr: c.result.stderr })) }, null, 2)); assert.equal(child.closed_reason, "wontfix");
    const close = h.calls.find(c => c.argv.includes("--wontfix"));
    assert.ok(close && close.result.exitCode === 0);
    assert.ok(close.argv[close.argv.indexOf("--message") + 1].replace(/\s+/g, " ").trim().length >= 60);
    assert.equal((await h.json(["show", h.parent])).issue.status, "open");
  } finally { await h.stop(); }
});

test("real automatic parent stays open until an external open child is closed", async () => {
  const h = await fixture({ bound: false });
  try {
    await h.dispatch("session.start", { cwd: h.cwd, surface: null, isInteractive: false });
    await h.spawn("verified-before-external"); await h.ready("verified-before-external");
    await h.verify("verified-before-external"); await h.finish("verified-before-external");
    const binding = h.stored.get("session/real-session/binding/parent");
    const external = (await h.json(["create", "External unfinished child", "--parent", binding.autoParent, "--force-new"])).issue.short_id;
    await h.finish(undefined);
    assert.equal((await h.json(["show", binding.autoParent])).issue.status, "open");
    assert.ok([...h.stored.values()].some(value => value?.kind === "parent-close" && !value?.ack));
    await h.kata(["close", external, "--done", "--message", "Finished the external isolated fixture after verifying the actual Python test command.", "--test", "python3 -m unittest -q test_proof"]);
    await h.finish(undefined);
    await h.closed(binding.autoParent);
    assert.equal((await h.json(["show", binding.autoParent])).issue.status, "closed");
  } finally { await h.stop(); }
});

test("real Kata enforces close floors, evidence, repeated messages, and open children", async () => {
  const h = await fixture({ throttle: true });
  try {
    const child = (await h.json(["create", "Direct close contract child", "--parent", h.parent, "--force-new"])).issue.short_id;
    const message = "Verified this isolated close contract fixture against the real Kata daemon.";
    for (const [args, pattern] of [
      [["close", child, "--done", "--message", "Too short", "--test", "python3 -m unittest -q test_proof"], /too short/i],
      [["close", child, "--wontfix", "--message", "Denied"], /too short/i],
      [["close", child, "--done", "--message", message], /evidence/i],
      [["close", h.parent, "--done", "--message", message, "--test", "python3 -m unittest -q test_proof"], /parent_has_open_children|open children/i],
    ]) {
      const result = await h.kata(args, false); assert.notEqual(result.exitCode, 0); assert.match(result.stderr + result.stdout, pattern);
    }
    await h.kata(["close", child, "--done", "--message", message, "--test", "python3 -m unittest -q test_proof"]);
    const alias = (await h.json(["create", "Reviewed alias contract child", "--force-new"])).issue.short_id;
    await h.kata(["close", alias, "--done", "--message", message + " Reviewed alias parity.", "--reviewed", "test_proof.py"]);
    assert.equal((await h.json(["show", alias])).issue.status, "closed");
    const other = (await h.json(["create", "Repeated message contract child", "--parent", h.parent, "--force-new"])).issue.short_id;
    const repeated = await h.kata(["close", other, "--done", "--message", message, "--test", "python3 -m unittest -q test_proof"], false);
    assert.notEqual(repeated.exitCode, 0); assert.match(repeated.stderr + repeated.stdout, /repeated_message|identical|repeated/i);
    assert.equal((await h.json(["show", other])).issue.status, "open");
  } finally { await h.stop(); }
});

test("real sibling throttle leaves the fourth registered close pending and retries after the window", async () => {
  const h = await fixture({ throttle: true });
  try {
    await h.dispatch("session.start", { cwd: h.cwd, surface: null, isInteractive: false });
    for (let i = 1; i <= 4; i++) {
      const id = `throttle-child-${i}`;
      await h.spawn(id); await h.ready(id); await h.verify(id); await h.finish(id);
      if (i < 4) await h.closed(h.entry(id).ref);
    }
    const fourth = h.entry("throttle-child-4");
    const refused = h.calls.filter(c => c.argv[1] === "close" && /sibling[_ -](?:close[_ -])?throttle/i.test(c.result.stderr + c.result.stdout));
    assert.ok(refused.length > 0, "The enabled real-daemon sibling throttle must refuse a registered close: " + JSON.stringify({ logs: h.logs, failures: h.calls.filter(c => c.result.exitCode).map(c => ({ argv: c.argv, stderr: c.result.stderr })) }));
    assert.equal((await h.json(["show", fourth.ref])).issue.status, "open");
    assert.ok([...h.stored.values()].some(value => value?.kind === "close" && value?.notBefore && !value?.ack));
    await h.closed(fourth.ref);
    assert.equal((await h.json(["show", fourth.ref])).issue.status, "closed");
    assert.ok(!h.logs.some(l => /dropped/.test(l.text)));
  } finally { await h.stop(); }
});

test("real compound claim script adopts the plan root it claimed", async () => {
  const h = await fixture({bound: false});
  try {
    const root = (await h.json(["create", "Compound plan root", "--force-new"])).issue.short_id;
    const child = (await h.json(["create", "Compound plan child", "--parent", root, "--force-new"])).issue.short_id;
    await h.dispatch("session.start", {cwd: h.cwd});
    const command = `set -e\nP=${root}; F=${child}\nkata claim $F --agent; kata claim $P --agent`;
    await h.dispatch("tool.call", {tool: "Bash", tool_use_id: "compound", command}, async () => {
      // The real output of the script's two claims, in order.
      const outputs = [(await h.kata(["claim", child, "--agent"])).stdout, (await h.kata(["claim", root, "--agent"])).stdout];
      return {result: {exitCode: 0}, text: outputs.join("")};
    });
    assert.equal(h.stored.get("session/real-session/binding/parent").parent, `realtest#${root}`);
  } finally {await h.stop();}
});

test("real workspace claim keeps selected workspace on every delegated effect", async () => {
  const h = await fixture({bound: false});
  try {
    const second = path.join(h.scratch, "second");
    await mkdir(second);
    await h.kata(["init", "--project", "second", "--workspace", second]);
    const parent = (await h.json(["create", "Second workspace parent", "--workspace", second, "--force-new"])).issue.short_id;
    await h.dispatch("session.start", {cwd: h.cwd});
    await h.dispatch("tool.call", {tool:"Bash",tool_use_id:"claim",command:`kata claim ${parent} --workspace '${second}'`}, async () => {
      const result = await h.kata(["claim",parent,"--workspace",second]);
      return {result:{exitCode:result.exitCode},text:result.stdout};
    });
    assert.equal(h.stored.get("session/real-session/binding/parent").parent, `second#${parent}`);
    await h.spawn("worker");
    await h.ready("worker");
    assert.equal(h.entry("worker").workspace,second);
    assert.equal(h.entry("worker").project,"second");
    await h.verify("worker"); await h.finish("worker");
    const effects=h.calls.filter(c => ["create","show","meta","comment","close","label"].includes(c.argv[1]) && c.argv.includes("second"));
    assert.ok(effects.length>=3);
    for(const {argv} of effects) assert.equal(argv[argv.indexOf("--workspace")+1],second);
    await h.spawn("exit-worker");await h.ready("exit-worker");
    await h.dispatch("session.end",{sessionId:"real-session",reason:"other",resume:{id:"real-session"}});
    assert.equal((await h.json(["show",h.entry("exit-worker").ref,"--workspace",second])).issue.metadata["claude.status"],"session-ended");
  } finally {await h.stop();}
});

test("real executable recovery retains launch intent in the same Kata store", async () => {
  const h=await fixture({bound:false});
  try {
    h.reload(path.join(h.scratch,"missing-kata"));
    const started=performance.now();
    await h.dispatch("session.start",{cwd:h.cwd});
    await h.spawn("recover");
    assert.ok(performance.now()-started<700,"Unavailable transport exceeded foreground budget");
    await h.verify("recover");
    await h.dispatch("turn.complete",{agentId:"recover",turnId:"done-recover",answer:"Implemented and verified the passing Python test.",reason:"answer",durationMs:1,isAborted:false});
    assert.ok(h.entry("recover"),"Delegation intent was lost during parent preparation");
    h.reload(binary);
    await h.dispatch("session.start",{cwd:h.cwd});
    await h.ready("recover");
    await h.closed(h.entry("recover").ref);
    assert.ok(h.entry("recover").ref,"Corrected executable stranded queued launch");
    assert.equal((await h.json(["show",h.entry("recover").ref])).issue.status,"closed");
    await h.spawn("next");await h.ready("next");
    assert.ok(h.entry("next").ref,"Corrected executable blocked new delegation");
  } finally {await h.stop();}
});

test("real SDK latency and global backlog stay outside foreground startup and spawn", async t => {
  const h=await fixture({sdkDelayMs:20});
  try {
    for(let i=0;i<1000;i++) h.stored.set(`unrelated/${i}`,{payload:"old"});
    let started=performance.now();
    await h.dispatch("session.start",{cwd:h.cwd});
    const startupMs=performance.now()-started;
    t.diagnostic(JSON.stringify({startupMs,sdkDelayMs:20,globalRows:1000}));
    assert.ok(startupMs<350,"Startup exceeded foreground host budget");
    assert.equal(h.keyScans(),0,"Startup scanned global storage before returning");
    let injected, admitted;
    started=performance.now();
    await h.dispatch("agent.spawn",{tool_use_id:"latency",prompt:"Implement latency check",description:"Latency check",subagentType:"general-purpose",provider:{plugin:"engine",tier:"core"},parentModel:"sonnet",background:false,fork:false},async e=>{admitted=performance.now()-started;injected=e.prompt;return {model:"sonnet",agentId:"latency"};});
    const spawnMs=performance.now()-started;
    t.diagnostic(JSON.stringify({startupMs,spawnAdmissionMs:admitted,spawnReturnMs:spawnMs,sdkDelayMs:20,globalRows:1000}));
    assert.ok(admitted<3100,"Spawn admission exceeded its configured 3-second create budget plus host overhead");
    assert.ok(spawnMs<3500,"Spawn exceeded configured create budget plus native join host overhead");
    assert.match(injected,/Kata is the system of record/);
    assert.equal(h.keyScans(),0,"Spawn scanned global storage before returning");
    assert.ok(h.entry("latency"),"Native spawn lacks durable intent");
    await h.ready("latency");
    assert.ok(h.entry("latency").ref);
  }finally{await h.stop();}
});

for (const mode of ["writes", "failed", "incomplete", "running"]) test(`real parent uses Kata closure and native completion for ${mode}`, async () => {
  const h=await fixture({bound:false});
  try {
    await h.dispatch("session.start",{cwd:h.cwd,surface:null,isInteractive:false});
    const id="manual-"+mode;await h.spawn(id);await h.ready(id);
    if(mode === "writes") await h.dispatch("tool.call",{tool:"Write",agentId:id,tool_use_id:"write-"+id,file_path:path.join(h.cwd,"manual.py"),content:"VALUE=42"},async e=>{await writeFile(e.file_path,e.content);return {result:{},text:"File written"};});
    else {await h.verify(id);if(mode === "failed") {await writeFile(path.join(h.cwd,"test_proof.py"),"import unittest\nclass Proof(unittest.TestCase):\n    def test_fixture(self):\n        self.assertEqual(2 + 2, 5000)\n");const failed=await h.verify(id);assert.equal(failed.result.exitCode,1,"The native verification subprocess must actually fail");}}
    const entry=h.entry(id);
    await h.kata(["close",entry.ref,"--done","--message","Verified this task and recorded its own completion evidence for Kata-authoritative parent closure.",...(mode === "writes" ? ["--reviewed","manual.py"] : ["--test","python3 -m unittest -q test_proof"])]);
    if(mode !== "running") await h.finish(id,mode === "incomplete" ? "Tests failed; implementation remains incomplete." : "Completed the requested work.");
    await h.finish(undefined);
    const parent=h.stored.get("session/real-session/binding/parent").autoParent;
    assert.equal((await h.json(["show",entry.ref])).issue.status,"closed");
    if(mode!=="running")await h.closed(parent);
    assert.equal((await h.json(["show",parent])).issue.status,mode==="running"?"open":"closed",JSON.stringify({mode,entry:h.entry(id),logs:h.logs}));
    if(mode==="running")assert.ok([...h.stored.values()].some(v=>v?.kind === "parent-close" && !v.ack));
  } finally {await h.stop();}
});

for (const status of ["completed", "failed", "killed"]) test(`real self-closed child records terminal claude.status ${status}`, async () => {
  const h = await fixture();
  try {
    await h.dispatch("session.start", { cwd: h.cwd });
    const id = "self-closed-" + status;
    await h.spawn(id); await h.ready(id);
    const ref = h.entry(id).ref;
    assert.ok(ref, "Self-close requires the actual delegated issue");
    await h.verify(id);
    await h.kata(["meta", "set", ref, "work.attention_msg", "Agent-owned completion note"]);
    await h.kata(["close", ref, "--done", "--message", "The delegated agent verified the actual Python fixture and closed its own issue before its final native verdict.", "--test", "python3 -m unittest -q test_proof"]);
    const before = (await h.json(["show", ref])).issue;
    assert.equal(before.metadata["claude.status"], "running");
    const start = h.calls.length;
    await h.dispatch("turn.complete", { agentId: id, turnId: "self-close-final", answer: "Finished the requested fixture.", reason: status === "failed" ? "error" : status === "killed" ? "aborted" : "answer", durationMs: 10, isAborted: status === "killed" });
    await h.waitFor(async () => (await h.json(["show", ref])).issue.metadata["claude.status"] === status, `self-closed ${status} status`);
    const after = (await h.json(["show", ref])).issue;
    assert.equal(after.metadata["claude.status"], status);
    assert.equal(after.status, "closed");
    assert.equal(after.closed_reason, "done");
    assert.equal(after.metadata["work.attention_msg"], "Agent-owned completion note");
    assert.deepEqual(h.calls.slice(start).filter(c => c.argv[1] !== "show").map(c => c.argv.slice(1, 6)), [
      ["meta", "set", ref, "claude.status", status],
    ]);
  } finally { await h.stop(); }
});

test("real fixture waits for a retried child create before manual-close assertions", async () => {
  const h = await fixture({ failChildCreateOnce: true });
  try {
    await h.dispatch("session.start", { cwd: h.cwd });
    await h.spawn("delayed-child"); await h.ready("delayed-child");
    const ref = h.entry("delayed-child").ref;
    assert.ok(ref, JSON.stringify({ entry: h.entry("delayed-child"), logs: h.logs }));
    await h.kata(["close", ref, "--done", "--message", "Verified this real fixture resolves a durable child-create retry before attempting manual closure.", "--test", "python3 -m unittest -q test_proof"]);
    assert.equal((await h.json(["show", ref])).issue.status, "closed");
  } finally { await h.stop(); }
});

for(const selfClose of [false,true])test(`real cold-daemon normal shell writer ${selfClose?"closes itself":"uses safety-net chain proof"}`,async t=>{
 const h=await fixture({bound:false});
 try {
  for(const args of [["init","-q"],["config","user.name","salmonumbrella"],["config","user.email","integration@example.invalid"]])await exec("git",args,{cwd:h.cwd});
  await h.dispatch("session.start",{cwd:h.cwd});await h.kata(["daemon","stop"]);
  let injected="";const begin=performance.now();
  await h.dispatch("agent.spawn",{tool_use_id:"shell",prompt:"Implement hello",description:"Normal shell writer",subagentType:"general-purpose",provider:{plugin:"engine",tier:"core"},parentModel:"sonnet",background:false,fork:false},async e=>{injected=e.prompt;return {model:"sonnet",agentId:"shell"};});
  const entry=h.entry("shell");assert.ok(entry.ref,"Cold daemon spawn must bind before native launch: "+JSON.stringify({entry,calls:h.calls,logs:h.logs,pending:[...h.stored.values()].filter(v=>v?.kind&&!v.ack)}));assert.ok(injected.includes(`tracked as ${entry.ref}`));assert.ok(!injected.includes("pending recovery"));
  t.diagnostic(JSON.stringify({coldSpawnMs:performance.now()-begin,ref:entry.ref,home:h.home}));
  async function bash(command){return h.dispatch("tool.call",{tool:"Bash",agentId:"shell",tool_use_id:"bash-"+h.calls.length,command},async e=>{const out=await exec("/bin/sh",["-c",e.command],{cwd:h.cwd,env:{...process.env,KATA_HOME:h.home}});return {result:{...out,exitCode:0},text:out.stdout};});}
  await bash("cat > hello.py <<'EOF'\ndef hello(): return 'hello'\nEOF");
  await bash("cat > test_hello.py <<'EOF'\nimport unittest\nfrom hello import hello\nclass Hello(unittest.TestCase):\n    def test_hello(self): self.assertEqual(hello(), 'hello')\nEOF");
  await bash("python3 -m unittest -q");
  const commit=await bash("git add hello.py test_hello.py && git commit -q -m 'Implement hello' && git log -1 --format='%H%n%B' && git status --short");
  const sha=commit.result.stdout.split("\n")[0];assert.match(sha,/^[0-9a-f]{40}$/);
  if(selfClose)await h.kata(["--teammate",entry.teammate,"close",entry.ref,"--done","--message","Implemented hello with a real Python unittest passing and committed the verified implementation.","--commit",sha,"--test","python3 -m unittest -q"]);
  await h.finish("shell");await h.closed(entry.ref);await h.finish();await h.closed(entry.parent);
  const stored=h.entry("shell");assert.deepEqual(stored.verification.evidence.commits,[sha]);assert.deepEqual(stored.verification.evidence.tests,["python3 -m unittest -q"]);
  if(!selfClose){const close=h.calls.find(c=>c.argv[1]==="close"&&c.argv[2]===entry.ref);assert.ok(close);assert.ok(close.argv.includes(sha));assert.ok(close.argv.includes("python3 -m unittest -q"));}
 }finally{await h.stop();}
});
test("real docs-only verified writers close both children and automatic parent",async()=>{
 const h=await fixture({bound:false});
 try {
  await h.dispatch("session.start",{cwd:h.cwd});
  for(const [id,file] of [["review","REVIEW.md"],["docs","README.md"]]){
   await h.spawn(id);await h.ready(id);
   await h.dispatch("tool.call",{tool:"Write",agentId:id,tool_use_id:"write-"+id,file_path:path.join(h.cwd,file),content:"Reviewed documentation.\n"},async e=>{await writeFile(e.file_path,e.content);return {result:{},text:"Written"};});
   await h.finish(id,"I verified the documentation for correctness and completeness.");await h.closed(h.entry(id).ref);
  }
  await h.finish();await h.closed(h.entry("docs").parent);
  for(const id of ["review","docs"]){const close=h.calls.find(c=>c.argv[1]==="close"&&c.argv[2]===h.entry(id).ref);assert.ok(close.argv.includes("--reviewed"));assert.ok(close.argv[close.argv.indexOf("--message")+1].includes("Documentation written and verified by the agent"));assert.ok(!close.argv.includes("--test"));}
 }finally{await h.stop();}
});

test("every child self-closes through its own tool and parent closes in the live session",async()=>{
 const h=await fixture({bound:false});
 try {
  await h.dispatch("session.start",{cwd:h.cwd,surface:null,isInteractive:true});
  for(const id of ["own-close-a","own-close-b"]){
   await h.spawn(id);await h.ready(id);await h.verify(id);
   const entry=h.entry(id);
   await h.dispatch("tool.call",{tool:"Bash",agentId:id,tool_use_id:"self-close-"+id,command:`cd ${h.cwd}\nkata close ${entry.ref} --done --message 'Completed ${id} after running the actual Python unittest fixture successfully.' --test 'python3 -m unittest -q test_proof'`},async e=>{
    const args=e.command.slice(e.command.indexOf("kata ")).match(/'(?:[^']*)'|\S+/g).map(s=>s.startsWith("'")?s.slice(1,-1):s).slice(1);
    const out=await h.kata(args);return {result:{...out},text:out.stdout};
   });
   await h.finish(id);await h.closed(entry.ref);
  }
  await h.finish();
  await h.closed(h.entry("own-close-b").parent);
  assert.ok(h.calls.some(c=>c.argv[1]==="close"&&c.argv[2]===h.entry("own-close-b").parent&&c.argv.includes("python3 -m unittest -q test_proof")));
 }finally{await h.stop();}
});

for (const tool of ["Write", "Bash"]) test(`physical external alias into repository vetoes docs-only close: ${tool}`, async () => {
 const h=await fixture({bound:false});
 try {
  await h.dispatch("session.start",{cwd:h.cwd});await h.spawn("alias");await h.ready("alias");
  await h.dispatch("tool.call",{tool:"Write",agentId:"alias",tool_use_id:"docs",file_path:path.join(h.cwd,"README.md"),content:"Reviewed."},async e=>{await writeFile(e.file_path,e.content);return {result:{}};});
  const alias=path.join(h.scratch,"outside-link");await symlink(h.cwd,alias);
  const file=path.join(alias,"source.py");
  const input=tool==="Write"?{file_path:file,content:"print(1)"}:{command:`printf code > '${file}'`};
  await h.dispatch("tool.call",{tool,agentId:"alias",tool_use_id:"code",...input},async()=>{await writeFile(file,"print(1)");return {result:{exitCode:0}};});
  await h.finish("alias",'{"verified":true}');
  assert.equal((await h.json(["show",h.entry("alias").ref])).issue.status,"open");
  assert.deepEqual(h.entry("alias").verification.evidence.written,["README.md","source.py"]);
  assert.equal(h.entry("alias").verification.codeWrites,true);
 } finally {await h.stop();}
});

for(const variant of ["separate preparation","exact script baseline","joined preparation"]) test(`real self-close and parent proof: ${variant}`,async()=>{
 const h=await fixture({bound:false});
 try {
  for(const args of [["init","-q"],["config","user.name","salmonumbrella"],["config","user.email","integration@example.invalid"]])await exec("git",args,{cwd:h.cwd});
  await h.dispatch("session.start",{cwd:h.cwd});await h.spawn("shell-writer");await h.ready("shell-writer");
  async function bash(command){return h.dispatch("tool.call",{tool:"Bash",agentId:"shell-writer",tool_use_id:"command-"+h.calls.length,command},async e=>{const out=await exec("/bin/sh",["-c",e.command],{cwd:h.cwd,env:{...process.env,KATA_HOME:h.home}});return {result:{...out,interrupted:false},text:out.stdout};});}
  const prep="cat > hello.py <<'EOF'\ndef main():\n    print('hello')\nif __name__ == '__main__':\n    main()\nEOF\ncat > test_hello.py <<'EOF'\nimport io, unittest\nfrom contextlib import redirect_stdout\nimport hello\nclass TestHello(unittest.TestCase):\n    def test_prints_hello(self):\n        buf = io.StringIO()\n        with redirect_stdout(buf): hello.main()\n        self.assertEqual(buf.getvalue(), 'hello\\n')\nEOF\n";
  let commit;
  if(variant!=="exact script baseline"){
   const literal=variant==="joined preparation" ? "printf 'def main(): print(\"hello\")\\nif __name__ == \"__main__\": main()\\n' > hello.py && "+prep.slice(prep.indexOf("cat > test_hello.py")) : prep;
   await bash(literal+"python3 -m unittest 2>&1"+(variant==="joined preparation"?'; echo "exit=$?"':""));
   assert.deepEqual(h.entry("shell-writer").verification.evidence.tests,["python3 -m unittest 2>&1"]);
   commit=await bash("git add hello.py test_hello.py && git commit -q -m 'Add hello.py with unittest' && "+(variant==="joined preparation"?"git log -1 --format='%H %s'":"git rev-parse --short HEAD")+" && git status --short");
  }else{
   await bash(prep);
   commit=await bash("python3 -m unittest 2>&1 && python3 hello.py && git add hello.py test_hello.py && git commit -q -m 'Add hello script and unittest' && git rev-parse HEAD && git status --short");
  }
  const hash=commit.result.stdout.split("\n").map(s=>s.split(" ")[0]).find(s=>/^[0-9a-f]{7,40}$/.test(s));assert.ok(hash);
  assert.deepEqual(h.entry("shell-writer").verification.evidence.commits,variant==="joined preparation"?[]:[hash]);
  const child=h.entry("shell-writer");
  await h.dispatch("tool.call",{tool:"Bash",agentId:"shell-writer",tool_use_id:"self-close",command:`kata close ${child.ref} --done --message 'Created hello and verified the real unittest and commit.' --commit ${hash} --test 'python3 -m unittest'`},async()=>({result:await h.kata(["--teammate",child.teammate,"close",child.ref,"--done","--message","Created hello and verified the real unittest and commit.","--commit",hash,"--test","python3 -m unittest"])}));
  await h.finish("shell-writer");await h.finish();await h.closed(child.parent);
  assert.equal((await h.json(["show",child.parent])).issue.closed_reason,"done");
 }finally{await h.stop();}
});

test("real own prose closes docs after external compound repro writes",async()=>{
 const h=await fixture({bound:false});
 try {
  await h.dispatch("session.start",{cwd:h.cwd});await h.spawn("docs-prose");await h.ready("docs-prose");
  await h.dispatch("tool.call",{tool:"Write",agentId:"docs-prose",tool_use_id:"doc",file_path:path.join(h.cwd,"README.md"),content:"Example verified.\n"},async e=>{await writeFile(e.file_path,e.content);return {result:{}};});
  const scratch=path.join(h.home,"repros");await mkdir(scratch);
  await h.dispatch("tool.call",{tool:"Bash",agentId:"docs-prose",tool_use_id:"repro",command:`S=${scratch}; cd $S; printf example > input.txt; for f in input.txt; do cat "$f"; done; printf checked > checked.txt`},async e=>({result:{...await exec("/bin/sh",["-c",e.command],{cwd:h.cwd}),exitCode:0}}));
  await h.finish("docs-prose","I wrote README.md and checked it by running every example in it. All the outputs and exit codes match what the README says.");
  await h.closed(h.entry("docs-prose").ref);await h.finish();await h.closed(h.entry("docs-prose").parent);
  assert.deepEqual(h.entry("docs-prose").verification.evidence.written,["README.md"]);
 }finally{await h.stop();}
});

test("real terminal notification gap never closes or reopens the parent",async()=>{
 const h=await fixture({bound:false});
 try {
  await h.dispatch("session.start",{cwd:h.cwd});await h.spawn("writer");await h.ready("writer");await h.verify("writer");
  await h.finish();await h.finish("writer");await h.closed(h.entry("writer").ref);
  const parent=h.entry("writer").parent;
  assert.equal((await h.json(["show",parent])).issue.status,"open");
  await h.spawn("tester");await h.ready("tester");await h.verify("tester");await h.finish("tester");await h.finish();await h.closed(parent);
  assert.equal(h.calls.filter(c=>c.argv[1]==="close"&&c.argv[2]===parent).length,1);
  assert.equal(h.calls.filter(c=>c.argv[1]==="reopen"&&c.argv[2]===parent).length,0);
 }finally{await h.stop();}
});

for(const structured of [false,true])test(`real reported workflow waits for a later lead settlement (structured=${structured})`,async()=>{
 const h=await fixture({bound:false});
 try {
  await h.dispatch("session.start",{cwd:h.cwd});
  const dir=path.join(h.scratch,"missing-transcripts");
  for(const file of ["README.md","REVIEW.md"])await writeFile(path.join(h.cwd,file),"Verified document.\n");
  await h.dispatch("tool.call",{tool:"Workflow",tool_use_id:"launch",script:"return 1"},async()=>({result:{status:"async_launched",taskType:"local_workflow",taskId:"workflow-1",workflowName:"docs",transcriptDir:dir}}));
  await h.settle(2000);const entry=h.stored.get("session/real-session/run/workflow-1");assert.ok(entry.ref);
  await h.finish();assert.equal((await h.json(["show",entry.parent])).issue.status,"open");
  const result=structured?JSON.stringify(["README.md","REVIEW.md"].map(file=>({file:path.join(h.cwd,file),verified:true}))):JSON.stringify(["README.md","REVIEW.md"].map(file=>`I wrote ${file} and checked it by running every example in it. All outputs match.`));
  await h.dispatch("session.append",{uuid:"wf-delivery",door:"delivery",origin:{kind:"task-notification"},message:{role:"user",content:[{type:"text",text:`<task-notification><task-id>workflow-1</task-id><status>completed</status><summary>Docs done</summary><result>${result}</result></task-notification>`}]}});
  await h.closed(entry.ref);assert.equal((await h.json(["show",entry.parent])).issue.status,"open");
  await h.finish();await h.closed(entry.parent);
  assert.equal(h.calls.filter(c=>c.argv[1]==="close"&&c.argv[2]===entry.parent).length,1);
 }finally{await h.stop();}
});

test("real heredoc commit and metadata lists preserve earlier unittest proof",async()=>{
 const h=await fixture({bound:false});
 try {
  for(const args of [["init","-q"],["config","user.name","salmonumbrella"],["config","user.email","integration@example.invalid"]])await exec("git",args,{cwd:h.cwd});
  await h.dispatch("session.start",{cwd:h.cwd});await h.spawn("heredoc");await h.ready("heredoc");await h.verify("heredoc");
  for(const command of ["git add test_proof.py && git commit -q -F - <<'EOF'\nAdd proof test\nEOF", "git log -1 --format='%H%n%B'; git status --short"])
   await h.dispatch("tool.call",{tool:"Bash",agentId:"heredoc",tool_use_id:"meta-"+h.calls.length,command},async e=>({result:{...await exec("/bin/sh",["-c",e.command],{cwd:h.cwd}),exitCode:0}}));
  assert.deepEqual(h.entry("heredoc").verification.evidence.tests,["python3 -m unittest -q test_proof"]);
  await h.finish("heredoc");await h.closed(h.entry("heredoc").ref);await h.finish();await h.closed(h.entry("heredoc").parent);
 }finally{await h.stop();}
});

test("real failing test and failure report leave child and parent open",async()=>{
 const h=await fixture({bound:false});
 try {
  await h.dispatch("session.start",{cwd:h.cwd});await h.spawn("failed-reader");await h.ready("failed-reader");
  await writeFile(path.join(h.cwd,"test_proof.py"),"import unittest\nclass Proof(unittest.TestCase):\n    def test_failure(self):\n        self.fail('Deliberate failing-test regression')\n");
  await h.dispatch("tool.call",{tool:"Read",agentId:"failed-reader",tool_use_id:"read",file_path:path.join(h.cwd,"test_proof.py")},async e=>({result:{content:await readFile(e.file_path,"utf8")}}));
  assert.equal((await h.verify("failed-reader")).result.exitCode,1);
  await h.finish("failed-reader","Tests failed. Work is incomplete.");await h.finish();
  const child=h.entry("failed-reader"),view=await h.json(["show",child.ref]);
  assert.equal(view.issue.status,"open");assert.ok(view.labels.some(l=>l.label==="needs-review"));
  const parent=await h.json(["show",child.parent]);assert.equal(parent.issue.status,"open");
  assert.ok(parent.labels.some(l=>l.label==="needs-review"));
  assert.equal(h.calls.filter(c=>c.argv[1]==="close").length,0);
 }finally{await h.stop();}
});

test("real parent preserves all Kata close evidence and accepts wontfix",async()=>{
 const h=await fixture({bound:false});
 try {
  for(const args of [["init","-q"],["config","user.name","salmonumbrella"],["config","user.email","integration@example.invalid"],["add","test_proof.py"],["commit","-qm","Add proof fixture"]])await exec("git",args,{cwd:h.cwd});
  const sha=(await exec("git",["rev-parse","HEAD"],{cwd:h.cwd})).stdout.trim();
  await h.dispatch("session.start",{cwd:h.cwd});await h.spawn("own-close");await h.ready("own-close");
  const child=h.entry("own-close");
  const human=(await h.json(["create","Human-owned optional task","--parent",child.parent,"--force-new"])).issue.short_id;
  await h.kata(["close",human,"--wontfix","--message","The owner reviewed this optional task and decided it is unnecessary for this completed change."]);
  await h.kata(["close",child.ref,"--done","--message","Implemented and verified the isolated proof fixture; this child records all supported evidence categories.","--commit",sha,"--pr","https://example.com/pull/11","--test","python3 -m unittest","--reviewed","test_proof.py","--evidence","external:owner checked the delivered result"]);
  await h.finish("own-close");await h.finish();await h.closed(child.parent);
  const events=(await h.json(["events","--limit","1000"])).events.filter(e=>e.type==="issue.closed"&&e.issue_short_id===child.parent.split("#").at(-1));
  assert.equal(events.length,1);
  assert.deepEqual(new Set(events[0].payload.evidence.map(e=>e.type)),new Set(["commit","pr","test","reviewed-paths","external"]));
  assert.ok(events[0].payload.evidence.some(e=>e.type==="commit"&&e.sha===sha));
  assert.ok(events[0].payload.evidence.some(e=>e.type==="external"&&e.account==="owner checked the delivered result"));
 }finally{await h.stop();}
});

test("real self-closed messaging teammate permits a settled parent while native idle",async()=>{
 const h=await fixture({bound:false,agents:[{id:"tester",name:"tester",teammateId:"tester@session-real",status:"idle",description:"tester",type:"general-purpose"}]});
 try {
  await h.dispatch("session.start",{cwd:h.cwd});
  await h.dispatch("agent.spawn",{tool_use_id:"tester",prompt:"Implement and test the fixture",description:"Messaging test owner",subagentType:"general-purpose",provider:{plugin:"engine",tier:"core"},parentModel:"sonnet",name:"tester",isTeammate:true,background:true,fork:false},async()=>({model:"sonnet",agentId:"tester",teammateId:"tester@session-real"}));
  await h.ready("tester");await h.verify("tester");const child=h.entry("tester");
  await h.kata(["close",child.ref,"--done","--message","Implemented the fixture and ran the actual Python unittest successfully before reporting completion.","--test","python3 -m unittest -q test_proof"]);
  const answer="Finished the fixture, verified its tests and closed my Kata issue.";
  await h.dispatch("tool.call",{tool:"SendMessage",tool_use_id:"send",agentId:"tester",to:"team-lead",message:answer},async()=>({result:{},text:"Sent"}));
  await h.dispatch("turn.complete",{agentId:"tester",turnId:"tester-final",answer,reason:"answer",durationMs:10,isAborted:false});await h.finish();
  await h.dispatch("session.receive",{origin:{kind:"peer",teammate:"tester",isVerified:true},text:JSON.stringify({type:"idle_notification",from:"tester",timestamp:"2026-10-06T17:34:56.258Z",idleReason:"available",result:answer})},async e=>({text:e.text}));await h.settle(2000);
  assert.equal((await h.json(["show",child.parent])).issue.status,"open");
  await h.dispatch("classic.Stop",{session_id:"real-session",transcript_path:"/tmp/transcript",cwd:h.cwd,hook_event_name:"Stop",stop_hook_active:false,background_tasks:[{id:"tester-task",type:"teammate",status:"running",description:"tester"}]},async()=>({}));
  await h.finish();await h.closed(child.parent);
  assert.equal((await h.json(["show",child.ref])).issue.metadata["claude.status"],"completed");
  assert.equal(h.calls.filter(c=>c.argv[1]==="close"&&c.argv[2]===child.parent).length,1);
  assert.equal(h.calls.filter(c=>c.argv[1]==="reopen"&&c.argv[2]===child.parent).length,0);
 }finally{await h.stop();}
});
