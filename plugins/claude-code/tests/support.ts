import type { On, AgentSpawnInput, CommandRunInput } from "claude-code";
import { mock } from "claude-code/testing";
export const canonicalContract = "Kata is the system of record for intent.\nUse your own teammate; never --as.\nClose verified work with evidence.";
export const output = (stdout = "{}", exitCode = 0) => ({
  value: {
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});
export function harness(
  on: On,
  parent: string | undefined = "fixture#root",
  stored: Record<string, unknown> = {},
) {
  const clock = mock.clock(on);
  mock.env(on, parent ? { KATA_REF: parent } : {});
  const persisted = new Map(Object.entries(stored));
  on("store.get", async ($, e) => { control.storeReads++; if(control.sdkDelayMs) await clock.sleep(control.sdkDelayMs); return { value: persisted.get(e.key) }; });
  on("store.set", async ($, e) => {
    if(control.sdkDelayMs) await clock.sleep(control.sdkDelayMs);
    persisted.set(e.key, JSON.parse(JSON.stringify(e.value)));
    return { value: undefined };
  });
  on("store.delete", ($, e) => {
    persisted.delete(e.key);
    return { value: undefined };
  });
  on("store.keys", async () => { control.storeScans++; if(control.sdkDelayMs) await clock.sleep(control.sdkDelayMs); return { value: [...persisted.keys()] }; });
  const contractCalls: string[][] = [];
  const processContexts: {args: string[]; cwd?: string}[] = [];
  const calls: string[][] = [],
    issues = new class extends Map<
      string,
      {
        issue: {
          short_id: string;
          status: string;
          revision: number;
          closed_reason?: string;
          closed_at?: string;
          metadata: Record<string, string | boolean>;
        };
        parent?: string;
        comments: { body: string }[];
        labels: string[];
      }
    > {
      override get(key: string) { return super.get(key) ?? (key.startsWith("fixture#") ? super.get(key.slice(8)) : undefined); }
    }();
  const control: {
    agents: import("claude-code").AgentInfo[];
    sessionId: string;
    sdkDelayMs: number;
    storeReads: number;
    storeScans: number;
    cwd: string;
    showDelayMs: number;
    outage: boolean;
    processDelayMs: number;
    failCommentOnce: boolean;
    beforeRun?: (args: string[]) => Promise<void>;
    contract: string;
    contractFailure: boolean;
    failCloseOnce: boolean;
    rejectParentClose: boolean;
    throttleClose: number;
    failCreate: number;
    failMeta: number;
    project: boolean;
    projectThrows: boolean;
    failEdit: number;
    missing: string[];
    hints: string[];
    toasts: string[];
    logs: {text: string; to: string}[];
    timeouts: number[];
  } = {
    agents: [],
    sessionId: "s1",
    sdkDelayMs: 0,
    storeReads: 0,
    storeScans: 0,
    cwd: "/tmp/test",
    showDelayMs: 0,
    outage: false,
    processDelayMs: 0,
    failCommentOnce: false,
    contract: canonicalContract,
    contractFailure: false,
    failCloseOnce: false,
    rejectParentClose: false,
    throttleClose: 0,
    failCreate: 0,
    failMeta: 0,
    project: true,
    projectThrows: false,
    failEdit: 0,
    missing: [],
    hints: [],
    toasts: [],
    logs: [],
    timeouts: [],
  };
  const events: {event_id:number;type:string;issue_short_id:string;payload:Record<string,unknown>}[] = [];
  const closes: {parent: string; ref: string; actor: string; reason: string; message: string; time: number}[] = [];
  const qualify = (ref: string, project = "fixture") => ref.includes("#") ? ref : project + "#" + ref;
  const normalized = (message: string) => message.trim().replace(/\s+/gu, " ").toLowerCase().replace(/[.?!]+$/, "");
  const refusal = (code: string) => ({...output("", 1), value: {...output("", 1).value, stderr: code}});
  let seq = 0;
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("session.cwd", () => ({value: control.cwd}));
  on("session.root", () => ({value: control.cwd}));
  on("fs.stat", ($, e) => ({value:{kind:"file",size:0,mtimeMs:0,isLink:false,realPath:e.path}}));
  on("session.id", () => ({ value: control.sessionId }));
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("command.register", () => ({ value: { command: "kata" } }));
  on("ui.status", ($, e) => {
    control.hints.push(String(e.text));
    return { value: undefined };
  });
  on("ui.log", ($, e) => {
    control.logs.push({ text: e.text, to: e.to });
    return { value: undefined };
  });
  on("ui.toast", ($, e) => {
    control.toasts.push(e.text);
    return { value: undefined };
  });
  on("turn.complete", ($, e) => ({ text: e.answer }));
  on("session.append", async ($, e, next) => {
    try {
      return await next(e);
    } catch {
      return { uuid: e.uuid, message: e.message };
    }
  });
  on("agent.list", () => ({ value: control.agents }));
  async function fakeRun(args: string[], init?: {cwd?: string; timeoutMs?: number}) {
    processContexts.push({args, cwd: init?.cwd});
    if (control.processDelayMs) {await clock.sleep(Math.min(control.processDelayMs, init?.timeoutMs ?? 15000)); if (control.processDelayMs > (init?.timeoutMs ?? 15000)) return output("", 1);}
    if (control.outage) { await clock.sleep(init?.timeoutMs ?? 15000); return output("", 1); }
    if(args[1] === "agent-contract-hook") {contractCalls.push(args); return output(JSON.stringify({hookSpecificOutput: {additionalContext: control.contract}}), control.contractFailure ? 1 : 0);}
    calls.push(args);
    await control.beforeRun?.(args);
    control.timeouts.push(init?.timeoutMs ?? 0);
    const verb = args[1];
    if (verb === "list" && control.projectThrows) throw new Error("process unavailable");
    if (verb === "list") return control.project ? output(JSON.stringify({issues: args.includes("--label")
      ? [...issues.values()].filter(v=>v.issue.metadata["claude.auto_parent"] === true && v.issue.status === "open").map(v=>({...v.issue, qualified_id: qualify(v.issue.short_id)}))
      : [{qualified_id: "fixture#fixture"}]})) : {...output("", 1), value: {...output("", 1).value, stderr: "no project"}};
    if (verb === "audit") return output(JSON.stringify({rows:events.filter(e=>e.type==="issue.closed").map(e=>({issue:e.issue_short_id,event_id:e.event_id,reason:e.payload.reason}))}));
    if (verb === "events") {const after=Number(args[args.indexOf("--after")+1]??0);return output(JSON.stringify({events:events.filter(e=>e.event_id>after).slice(0,Number(args[args.indexOf("--limit")+1]??100)),reset_required:false}));}
    if (verb === "edit" && control.failEdit-- > 0) return output("", 1);
    if (verb === "show" && control.missing.includes(args[2]!.split("#").pop()!))
      return {...output("", 4), value: {...output("", 4).value, stderr: '{"error":{"kind":"not_found","code":"issue_not_found","message":"issue not found","exit_code":4}}'}};
    if (verb === "show" && control.showDelayMs)
      await clock.sleep(control.showDelayMs);
    if (verb === "create" && control.failCreate-- > 0) return output("", 1);
    if (verb === "meta" && control.failMeta-- > 0) return output("", 1);
    if (verb === "create") {
      const ref = "c" + ++seq;
      const d = {
        issue: { short_id: ref, status: "open", revision: 1, metadata: Object.fromEntries(args.flatMap((a, i) => a === "--meta" ? [args[i + 1]!.split(/=(.*)/s).slice(0, 2)] : [])) },
        parent: args.includes("--parent") ? qualify(args[args.indexOf("--parent") + 1]!) : undefined,
        comments: [],
        labels: [],
      } as ReturnType<typeof issues.get> & {};
      issues.set(ref, d);
      return output(JSON.stringify({...d, event: {project_name: args.includes("--project") ? args[args.indexOf("--project") + 1] : "fixture"}}));
    }
    if (verb === "close" && control.throttleClose-- > 0) return {...output("", 1), value: {...output("", 1).value, stderr: "HTTP 429 sibling_throttle: recent sibling closes; retry after 60 seconds"}};
    if (verb === "show")
      return output(
        JSON.stringify(
          (issues.get(args[2]!) ? {...issues.get(args[2]!)!, parent: issues.get(args[2]!)!.parent ? {qualified_id: issues.get(args[2]!)!.parent} : null, labels: issues.get(args[2]!)!.labels.map(label => ({label})), children: [...issues.values()].filter(d => d.parent === qualify(args[2]!)).map(d => ({...d.issue,qualified_id:qualify(d.issue.short_id,d.parent?.split("#")[0] ?? "fixture")}))} : undefined) ?? {
            issue: {
              short_id: args[2]!.split("#").pop(),
              status: "open",
              revision: 1,
            },
            comments: [],
            labels: [],
          },
        ),
      );
    const ref = verb === "meta" || verb === "label" ? args[3] : args[2],
      d = issues.get(ref!);
    if (d) {
      if (verb === "close") {
        if (d.issue.status === "closed") return output(JSON.stringify(d));
        if(control.rejectParentClose && d.issue.metadata["claude.auto_parent"]===true)return refusal("validation refused");
        const reason = args.includes("--wontfix") ? "wontfix" : "done";
        const message = normalized(args[args.indexOf("--message") + 1] ?? "");
        const proofFlags = ["--commit", "--pr", "--test", "--reviewed-paths", "--reviewed", "--external", "--evidence"];
        const proof = args.flatMap((arg, i) => proofFlags.includes(arg) ? [{flag: arg, value: args[i + 1] ?? ""}] : []);
        if (new TextEncoder().encode(message).length < (reason === "wontfix" ? 60 : 40)) return refusal("validation: message too short");
        if (reason === "done" && !proof.length) return refusal("validation: evidence required");
        if (reason === "wontfix" && proof.length) return refusal("validation: evidence not allowed for wontfix");
        if (proof.some(p => !p.value.trim() || (p.flag === "--commit" && !/^[a-f0-9]{7,40}$/i.test(p.value)) || (["--reviewed-paths", "--reviewed"].includes(p.flag) && p.value.split(",").some(v => !v.trim())))) return refusal("validation: malformed evidence");
        const canonical = qualify(ref!);
        if ([...issues.values()].some(child => child.parent === canonical && child.issue.status !== "closed")) return refusal("parent_has_open_children");
        const now = clock.now(), actor = args.includes("--as") ? args[args.indexOf("--as") + 1]! : "actor";
        const siblings = closes.filter(c => c.parent === d.parent && c.ref !== canonical && c.actor === actor);
        // Enable the opt-in real guards by default: fixtures exercise the strict contract.
        if (d.parent && siblings.filter(c => now - c.time < 60000).length >= 3) return refusal("sibling_throttle");
        if (d.parent && reason === "done" && siblings.some(c => now - c.time < 1800000 && c.message === message)) return refusal("duplicate_message");
        if (d.parent) closes.push({parent: d.parent, ref: canonical, actor, reason, message, time: now});
      }
      if (verb === "meta") d.issue.metadata[args[4]!] = args.includes("--json-value") ? JSON.parse(args[5]!) : args[5]!;
      if (verb === "comment")
        d.comments.push({ body: args[args.indexOf("--body") + 1]! });
      if (verb === "label" && args[2] === "add") d.labels.push(args[4]!);
      if (verb === "label" && args[2] === "rm") d.labels = d.labels.filter(l => l !== args[4]);
      if (verb === "close") {
        d.issue.status = "closed";d.issue.closed_reason=args.includes("--wontfix")?"wontfix":"done";
        const evidence:Record<string,unknown>[]=[];
        for (let i=0;i<args.length;i++) {
          const value=args[i+1]!;
          if(args[i]==="--commit")evidence.push({type:"commit",sha:value});
          if(args[i]==="--pr")evidence.push({type:"pr",url:value});
          if(args[i]==="--test")evidence.push({type:"test",command:value});
          if(["--reviewed","--reviewed-paths"].includes(args[i]!))evidence.push({type:"reviewed-paths",paths:[value]});
          if(args[i]==="--external")evidence.push({type:"external",account:value});
          if(args[i]==="--evidence"&&value.startsWith("external:"))evidence.push({type:"external",account:value.slice(9)});
        }
        d.issue.closed_at=new Date(events.length+1).toISOString();
        events.push({event_id:events.length+1,type:"issue.closed",issue_short_id:d.issue.short_id,payload:{reason:d.issue.closed_reason,closed_at:d.issue.closed_at,evidence}});
      }
      if (verb === "reopen") d.issue.status = "open";
      d.issue.revision++;
    }
    if (verb === "close" && control.failCloseOnce) {control.failCloseOnce = false; return output("", 1);}
    if (verb === "comment" && control.failCommentOnce) {
      control.failCommentOnce = false;
      return output("", 1);
    }
    return output("{}");
  }
  on("process.run", (_$, e) => fakeRun([...e.argv], e.init));
  const kata = async (args: string[]) => (await fakeRun(args)).value;
  const recordClose=(ref:string,evidence:Record<string,unknown>[]=[{type:"test",command:"pytest -q"}])=>{
    const d=issues.get(ref)!;d.issue.status="closed";d.issue.closed_at=new Date(events.length+1).toISOString();
    events.push({event_id:events.length+1,type:"issue.closed",issue_short_id:d.issue.short_id,payload:{reason:"done",closed_at:d.issue.closed_at,evidence}});
  };
  return { kata, events, recordClose, processContexts, contractCalls, calls, issues, control, clock, persisted };
}
export const start = {
  cwd: "/tmp/test",
  surface: null,
  isInteractive: false,
} as const;

export const spawn = (
  overrides: Partial<AgentSpawnInput> = {},
): AgentSpawnInput => ({
  tool_use_id: "tool-1",
  prompt: "Original",
  description: "Check parser",
  subagentType: "general-purpose",
  provider: { plugin: "engine", tier: "core" },
  parentModel: "sonnet",
  background: false,
  fork: false,
  ...overrides,
});
export const command = (args = ""): CommandRunInput => ({
  command: "kata",
  args,
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 80 },
});

export const resumedTurn = (
  agentId: string | undefined = "a1",
  turnId = "turn1",
  answer = "Exact early final",
) => ({
  agentId,
  turnId,
  answer,
  reason: "answer" as const,
  durationMs: 10,
  isAborted: false,
});
