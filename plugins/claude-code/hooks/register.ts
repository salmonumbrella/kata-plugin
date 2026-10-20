import type { Register, EngineInterface } from "claude-code";
import { update } from "claude-code";
import {
  teammateHandle,
  parseKata,
  claimedRef,
  claimedWorkspace,
  reportedClaims,
  endCommand,
  kataImpersonation,
  rewriteKata,
} from "./commands.ts";
import { evidenceArgs, updateVerification, canClose, incompleteAnswer, documentationOnly, documentationStatement, observedWritePaths } from "./evidence.ts";
import type { Verification } from "./evidence.ts";
import { workflowCompletion, workflowEvidenceArgs, closeEvidenceArgs } from "./completion.ts";
import { sessionDescription, promptTitle } from "./session.ts";
import { namedIssue, definitelyMissing } from "./refs.ts";
import { workflowDelivery, teammateFinished, workflowSummary } from "./notifications.ts";
import type {
  KataEntry,
  KataOperation,
  KataReply,
  KataSession,
} from "../types/index.d.ts";

const CONTRACT = {plugin: "kata", key: "contract"} as const;
const SESSION = { plugin: "kata", key: "session" } as const;
const SPAWN = { plugin: "kata", key: "spawn" } as const;
const RUN = { plugin: "kata", key: "run" } as const;
const AGENT = { plugin: "kata", key: "agent" } as const;
const EARLY = { plugin: "kata", key: "early" } as const;

/** State writes and their durable snapshots share a short lock; native next never does. */
let tail: Promise<unknown> = Promise.resolve();
function lock<T>(fn: () => Promise<T>): Promise<T> {
  const p = tail.then(fn);
  tail = p.catch(() => {});
  return p;
}
async function executionScope($: EngineInterface) {
  return JSON.stringify([await $.env.get("KATA_HOME") ?? "", await $.env.get("KATA_SERVER") ?? "", await $.env.get("KATA_DAEMON") ?? ""]);
}
function compatibleScope(saved: string | undefined, current: string): boolean {
  if (!saved) return true;
  try { const parts = JSON.parse(saved); return JSON.stringify(Array.isArray(parts) && parts.length === 4 ? parts.slice(1) : parts) === current; }
  catch { return saved === current; }
}
// Admission and closure of one delegate share a lock; remote show runs outside it.
const transitions = new Map<string, Promise<unknown>>();
function transition<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (transitions.get(key) ?? Promise.resolve()).then(fn);
  transitions.set(key, next.catch(() => {}));
  return next;
}
function boundedReply(reply: KataReply, ownDocument = true): KataReply {
  return {...reply, documentationStatement: ownDocument ? reply.documentationStatement ?? documentationStatement(reply.answer) : undefined, incomplete: reply.incomplete || incompleteAnswer(reply.answer), answer: reply.answer.slice(0, 4000)};
}
const sessionCache = new Map<string, KataSession>();
const contractCache = new Map<string, {id: string; text?: string}>();
const contractRetry = new Set<string>();
let startupGeneration = 0;
async function refreshContract($: EngineInterface, captured?: {id: string; cwd?: string}, deadline?: number, timeoutLimit = 100) {
  const context = captured ?? {id: await $.session.id(), cwd: await $.session.cwd()};
  const id = context.id;
  if (captured && id !== await $.session.id()) return;
  const prior = contractCache.get(id) ?? (deadline === undefined ? (await $.state.get(CONTRACT)).value : undefined);
  let text = deadline === undefined && prior?.id === id ? prior.text : undefined;
  let recovered = false;
  try {
    const timeoutMs = Math.floor(deadline === undefined ? 1000 : Math.min(timeoutLimit, deadline - await $.clock.now()));
    if (timeoutMs <= 0) throw new Error("Contract foreground budget exhausted");
    const output = await $.process.run([kata, "agent-contract-hook", "--source", "kata-agent-contract-hook"], {timeoutMs, cwd: context.cwd});
    if (output.exitCode === 0) {
      const context = JSON.parse(output.stdout)?.hookSpecificOutput?.additionalContext;
      if (typeof context === "string" && context) { text = context; recovered = true; }
    }
  } catch { /* The canonical contract is optional when Kata is unavailable. */ }
  contractCache.set(id, {id, text});
  const publish = async () => {if (id === await $.session.id()) await update($, CONTRACT, () => contractCache.get(id)!);};
  if (deadline === undefined) await publish(); else $.clock.after(0, async () => safely($, publish));
  if (!recovered && !contractRetry.has(id)) {
    contractRetry.add(id);
    $.clock.after(1000, async () => {
      contractRetry.delete(id);
      await safely($, () => refreshContract($, context));
    });
  }
}
async function trimStore($: EngineInterface) {
  const id = await $.session.id();
  const rows = new Map<string, unknown>();
  const pinned = new Set([id]);
  const keys = await $.store.keys();
  const values = new Map<string, unknown>();
  for (let at = 0; at < keys.length; at += 64)
    await Promise.all(keys.slice(at, at + 64).map(async key => {values.set(key, await $.store.get(key));}));
  for (const key of keys) {
    let value = values.get(key);
    if (key.includes("/op/") && (value as KataOperation).ack) {
      const op = value as KataOperation;
      if (op.args || op.body || op.metadata) {
        value = {
          ...op,
          args: undefined,
          body: undefined,
          metadata: undefined,
        };
        await $.store.set(key, value);
      }
    }
    rows.set(key, value);
    if ((key.includes("/op/") && !(value as KataOperation).ack) ||
        ((key.includes("/spawn/") || key.includes("/run/")) && !(value as KataEntry).closedBy &&
          !((value as KataEntry).bound && ["completed", "failed", "killed", "denied", "session-ended"].includes((value as KataEntry).status))) ||
        (key.includes("/retained-parent/") && !(value as KataSession).autoParentClosed) ||
        (key.endsWith("/binding/parent") && ((value as KataSession).autoParent && !(value as KataSession).autoParentClosed || (value as KataSession).mainActive && !(value as KataSession).ended)))
      pinned.add(key.split("/")[1]!);
  }
  let size = new TextEncoder().encode(
    JSON.stringify(Object.fromEntries(rows)),
  ).length;
  if (size <= 2 * 1024 * 1024) return;
  const sessions = [
    ...new Set(
      [...rows.keys()]
        .filter((k) => k.startsWith("session/"))
        .map((k) => k.split("/")[1]!),
    ),
  ];
  for (const old of sessions) {
    if (pinned.has(old)) continue;
    for (const [key, value] of rows)
      if (key.startsWith(`session/${old}/`)) {
        await $.store.delete(key);
        size -= new TextEncoder().encode(
          JSON.stringify({ [key]: value }),
        ).length;
      }
    if (size <= 2 * 1024 * 1024) break;
  }
}
async function save(
  $: EngineInterface,
  family: string,
  id: string,
  value: unknown,
  sid?: string,
) {
  await $.store.set(`session/${sid ?? await $.session.id()}/${family}/${id}`, value);
}
let sessionTail: Promise<unknown> = Promise.resolve();
async function session($: EngineInterface, deadline?: number): Promise<KataSession> {
  const id = await $.session.id();
  const existing = sessionCache.get(id);
  if (existing) return existing;
  const init = sessionTail.then(async () => {
    if (sessionCache.has(id)) return sessionCache.get(id)!;
    const [saved, previous, cwd, parent, scope, repositoryRoot] = await Promise.all([
      $.store.get(`session/${id}/binding/parent`) as Promise<KataSession | undefined>,
      $.state.get(SESSION).then(value => value.value), $.session.cwd(), $.env.get("KATA_REF"), executionScope($),
      $.session.root().catch(() => undefined),
    ]);
    if (!contractCache.has(id)) await refreshContract($, {id, cwd}, deadline ?? await $.clock.now() + 200);
    if (previous?.id && previous.id !== id) {
      const old = await $.store.get(`session/${previous.id}/binding/parent`) as KataSession | undefined;
      if (old) {
        const ended = {...old, ended: true, mainActive: false};
        sessionCache.set(old.id, ended);
        await $.store.set(`session/${old.id}/binding/parent`, ended);
      }
    }
    if (saved) { sessionCache.set(id, saved); return saved; }
    const fresh: KataSession = {id, cwd, repositoryRoot: repositoryRoot ?? cwd, workspace: cwd, parent: parent || null, scope, project: parent?.includes("#") ? parent.split("#")[0] : undefined};
    await bind($, fresh);
    return fresh;
  });
  sessionTail = init.catch(() => {});
  return init;
}

async function bind($: EngineInterface, value: KataSession) {
  sessionCache.set(value.id, value);
  return lock(async () => {
    if (value.id === await $.session.id()) await update($, SESSION, () => value);
    await save($, "binding", "parent", value, value.id);
  });
}
// Separate from state/queue locks; never held across native next().
let parentTail: Promise<unknown> = Promise.resolve();
function parentLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = parentTail.then(fn);
  parentTail = p.catch(() => {});
  return p;
}
async function parentEffects($: EngineInterface, s: KataSession) {
  if (!s.autoParent) return;
  const workspace = s.autoParentWorkspace ?? s.cwd, project = s.autoParentProject ?? s.autoParent.split("#")[0];
  await enqueue($, { id: "session:auto-meta", kind: "auto-meta", entry: "run", key: "session",
    ref: s.autoParent, sessionId: s.id, scope: s.scope, workspace, project, attempts: 0 });
  if (s.parent && s.parent !== s.autoParent)
    await enqueue($, { id: `session:reparent:${s.bindingVersion ?? 0}:${s.parent}`, kind: "reparent", entry: "run", key: "session",
      ref: s.autoParent, parent: s.parent, sessionId: s.id, scope: s.scope, workspace, project, attempts: 0 });
}
async function delegationParent($: EngineInterface, deadline?: number, captured?: KataSession, timeoutMs = 100) {
  const initial = captured ?? await session($);
  const persist = async (value: KataSession) => {
    const live = sessionCache.get(initial.id);
    if (!live || ((live.bindingVersion ?? 0) === (initial.bindingVersion ?? 0) && (live.workspace ?? live.cwd) === (initial.workspace ?? initial.cwd))) await bind($, value);
    else if (value.autoParent) {
      const key = `session/${value.id}/retained-parent/${encodeURIComponent(value.autoParent)}`;
      await $.store.set(key, {...value, mainActive: false, ended: true});
    }
  };
  if (initial.autoParent) await persist({...initial, mainActive: true});
  return parentLock(async () => {
    const live = captured ? sessionCache.get(captured.id) : undefined;
    const sameBinding = live && (live.bindingVersion ?? 0) === (captured?.bindingVersion ?? 0) && (live.workspace ?? live.cwd) === (captured?.workspace ?? captured?.cwd);
    let s = captured ? (sameBinding ? live! : captured) : await session($);
    if (!compatibleScope(s.scope, await executionScope($))) throw new Error("Kata binding belongs to another execution scope");
    if (s.parent) {
      s.parent = await resolveRef($, s.parent, {...s, deadline}, timeoutMs);
      s.project = s.parent.split("#")[0];
      if (s.parent === s.autoParent) {
        const parent = await show($, s.parent, {...s, deadline}, timeoutMs);
        if (parent.issue.status === "closed") {
          if (parent.issue.metadata?.["claude.auto_parent"] !== true) throw new Error("Closed parent is not automatic");
          await run($, ["reopen", s.parent], timeoutMs, {...s, deadline});
        }
        s = {...s, mainActive: true, autoParentClosed: false, parentGeneration: (s.parentGeneration ?? 0) + 1};
        await persist(s);
      }
      return s.parent;
    }
    if (s.autoDisabled || s.unbound) return s.parent;
    if (s.promptRef) {
      // The first prompt named the issue this session works under: use it as
      // the parent instead of creating a claude-session issue. Outages retry.
      const ref = s.promptRef;
      try {
        const view = await show($, ref, {...s, project: ref.split("#")[0], deadline}, timeoutMs);
        if (view.issue.status !== "closed" && view.issue.metadata?.["claude.auto_parent"] !== true) {
          s = {...s, parent: ref, project: ref.split("#")[0], promptRef: undefined, mainActive: true};
          await persist(s);
          return ref;
        }
        s = {...s, promptRef: undefined, promptRefNote: `first prompt named ${ref}, but it is ${view.issue.status === "closed" ? "closed" : "an automatic session issue"}`};
      } catch (error) {
        if (!definitelyMissing(error)) throw error;
        s = {...s, promptRef: undefined, promptRefNote: `first prompt named ${ref}, but Kata has no such issue`};
      }
      await persist(s);
    }
    let projectAvailable = false;
    try {
      const probe = await run($, ["list", "--limit", "1", "--json"], timeoutMs, {...s, deadline});
      projectAvailable = !!probe;
    } catch (error) {
      if (!/no project|project_(?:unavailable|not_found)|no kata project/i.test(String(error))) throw error;
    }
    if (!projectAvailable) {
      await persist({ ...s, autoDisabled: true });
      await $.ui.log("Kata project unavailable; automatic tracking disabled for this session", { to: "debug" });
      return null;
    }
    const description = sessionDescription(s.firstPrompt ?? "", s.id, s.sessionName);
    if (s.firstPromptTitle) description.title = s.firstPromptTitle;
    if (s.promptRefNote) description.body += `\n\nNamed issue not used: ${s.promptRefNote}.`;
    const d: IssueView = JSON.parse(await run($, ["create", description.title, "--body", description.body,
      "--label", "claude-session", "--meta", `claude.session_id=${s.id}`,
      ...(s.promptRefNote ? ["--meta", `claude.binding_note=${s.promptRefNote}`] : []),
      "--meta", `claude.workspace=${s.cwd}`,
      "--idempotency-key", `claude-session:${s.id}`, "--force-new", "--json"], timeoutMs, {...s, deadline}));
    if (!d.issue?.short_id) throw new Error("No Kata session parent ref");
    const ref = qualified(d, s.project);
    s = { ...s, project: ref.split("#")[0], parent: ref, autoParent: ref, autoParentWorkspace: s.workspace ?? s.cwd, autoParentProject: ref.split("#")[0], mainActive: true, parentGeneration: 1 };
    await persist(s);
    await parentEffects($, s);
    return s.parent;
  });
}
/** The claimed issue whose parent was not also claimed (the plan root). */
async function claimedRoot($: EngineInterface, refs: string[]): Promise<string | undefined> {
  const views: {ref: string; view: IssueView}[] = [];
  for (const ref of refs.slice(0, 5)) {
    try { views.push({ref, view: await show($, ref)}); } catch { /* An unreadable claim is not adopted. */ }
  }
  const claimed = new Set(views.flatMap(({view}) => [view.issue.qualified_id, view.issue.short_id]));
  const open = views.filter(({view}) => view.issue.status === "open");
  return (open.find(({view}) => !view.parent?.qualified_id || !claimed.has(view.parent.qualified_id)) ?? open[0])?.ref;
}
async function adoptParent($: EngineInterface, ref: string, workspace?: string) {
  return parentLock(async () => {
    const s = await session($);
    ref = await resolveRef($, ref, {workspace, cwd: await $.session.cwd(), project: ref.includes("#") ? ref.split("#")[0] : undefined});
    const bound = { ...s, workspace: workspace ?? s.workspace ?? s.cwd, scope: await executionScope($), project: ref.split("#")[0], parent: ref, unbound: false, bindingVersion: (s.bindingVersion ?? 0) + 1 };
    await bind($, bound);
    await parentEffects($, bound);
  });
}
async function getEntry(
  $: EngineInterface,
  family: "spawn" | "run",
  id: string,
  sid?: string,
) {
  const saved = (await $.store.get(
    `session/${sid ?? await $.session.id()}/${family}/${id}`,
  )) as KataEntry | undefined;
  return saved;
}
async function putEntry(
  $: EngineInterface, family: "spawn" | "run", id: string,
  fn: (old: KataEntry | undefined) => KataEntry, sid?: string, deferState = false,
) {
  sid ??= await $.session.id();
  return lock(async () => {
    const value = fn(await getEntry($, family, id, sid));
    if (!deferState && sid === await $.session.id()) {
      if (family === "spawn") await update($, {...SPAWN, id}, () => value);
      else await update($, {...RUN, id}, () => value);
    }
    await save($, family, id, value, sid);
    if (deferState) $.clock.after(0, async () => safely($, async () => {
      if (sid !== await $.session.id()) return;
      const latest = await getEntry($, family, id, sid);
      if (latest) {
        if (family === "spawn") await update($, {...SPAWN, id}, () => latest);
        else await update($, {...RUN, id}, () => latest);
      }
    }));
    return value;
  });
}
async function agentKey($: EngineInterface, id: string) {
  return (await $.store.get(`session/${await $.session.id()}/agent/${id}`)) as
    string | undefined;
}
async function mapAgent($: EngineInterface, id: string, toolId: string, sid?: string) {
  sid ??= await $.session.id();
  return lock(async () => {
    if (sid === await $.session.id()) await update($, { ...AGENT, id }, () => toolId);
    await save($, "agent", id, toolId, sid);
  });
}
async function buffer($: EngineInterface, id: string, reply: KataReply) {
  return lock(async () => {
    reply = boundedReply(reply);
    const replies = await early($, id);
    let value: KataReply[] = [];
    await update($, { ...EARLY, id }, () => {
      value = [...replies.filter((r) => r.turnId !== reply.turnId), reply];
      return value;
    });
    await save($, "early", id, value);
  });
}
async function early($: EngineInterface, id: string) {
  return (
    ((await $.store.get(`session/${await $.session.id()}/early/${id}`)) as
      KataReply[] | undefined) ?? []
  );
}
async function entries($: EngineInterface) {
  const prefix = `session/${await $.session.id()}/`;
  const result: { family: "spawn" | "run"; key: string; value: KataEntry }[] =
    [];
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length),
      slash = suffix.indexOf("/"),
      family = suffix.slice(0, slash);
    if (family === "spawn" || family === "run")
      result.push({
        family,
        key: suffix.slice(slash + 1),
        value: (await $.store.get(key)) as KataEntry,
      });
  }
  return result;
}
/** Upgrade legacy records using their saved binding, never the resumed folder. */
async function migrate($: EngineInterface, s: KataSession) {
  if (!s.project || !s.cwd) return;
  const prefix = `session/${s.id}/`;
  const qualify = (ref: string) => ref.includes("#") ? ref : s.project + "#" + ref;
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (key.startsWith(prefix + "spawn/") || key.startsWith(prefix + "run/")) {
      const e = await $.store.get(key) as KataEntry;
      const project = e.project ?? (e.ref?.includes("#") ? e.ref.split("#")[0] : s.project);
      await $.store.set(key, {...e, ref: e.ref ? qualify(e.ref) : undefined,
        parent: qualify(e.parent), scope: e.scope ?? s.scope, project, workspace: e.workspace ?? s.cwd});
    } else if (key.startsWith(prefix + "op/")) {
      const op = await $.store.get(key) as KataOperation;
      await $.store.set(key, {...op, ref: op.ref ? qualify(op.ref) : undefined,
        parent: op.parent ? qualify(op.parent) : undefined, scope: op.scope ?? s.scope, project: op.project ?? s.project, workspace: op.workspace ?? s.cwd});
    }
  }
}
async function restore($: EngineInterface) {
  const awaitedId = await $.session.id(), prefix = `session/${awaitedId}/`;
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length),
      slash = suffix.indexOf("/"),
      id = suffix.slice(slash + 1),
      value = await $.store.get(key);
    switch (suffix.slice(0, slash)) {
      case "binding":
        await update($, SESSION, () => sessionCache.get(awaitedId) ?? value as KataSession);
        break;
      case "spawn":
        await update($, { ...SPAWN, id }, () => value as KataEntry);
        break;
      case "run":
        await update($, { ...RUN, id }, () => value as KataEntry);
        break;
      case "agent":
        await update($, { ...AGENT, id }, () => value as string);
        break;
      case "early":
        await update($, { ...EARLY, id }, () => value as KataReply[]);
        break;
    }
  }
}

type IssueView = {
  event?: {project_name?: string};
  issue: { qualified_id?: string; short_id: string; uid?: string; status: string; revision: number; closed_at?: string; closed_reason?: string; metadata?: Record<string, unknown> };
  children?: IssueView["issue"][];
  parent?: { qualified_id?: string } | null;
  comments?: { body: string }[];
  labels?: { label: string }[];
};
let kata = "kata";

let queueTail: Promise<unknown> = Promise.resolve();
const queueLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = queueTail.then(fn);
  queueTail = p.catch(() => {});
  return p;
};
const opPrefix = async ($: EngineInterface, sid?: string) =>
  `session/${sid ?? await $.session.id()}/op/`;
type Target = {workspace?: string; cwd?: string; project?: string; deadline?: number};
function qualified(d: IssueView, project?: string): string {
  if (d.issue.qualified_id?.includes("#")) return d.issue.qualified_id;
  const name = d.event?.project_name ?? project;
  if (!name) throw new Error("Kata project identity missing");
  return name + "#" + d.issue.short_id;
}
async function run($: EngineInterface, args: string[], timeoutMs = 1000, target?: Target) {
  const s: Target = target ?? await session($);
  const workspace = s.workspace ?? s.cwd ?? await $.session.cwd();
  const project = args.find(a => /^[\w.-]+#[\w.-]+$/.test(a))?.split("#")[0] ?? s.project;
  const flags = [...(project && !args.some(a => a === "--project" || a.startsWith("--project=")) ? ["--project", project] : []),
    ...(!args.includes("--workspace") ? ["--workspace", workspace] : [])];
  if (s.deadline !== undefined) {
    timeoutMs = Math.min(timeoutMs, s.deadline - await $.clock.now());
    if (timeoutMs <= 0) throw new Error("Kata foreground budget exhausted");
  }
  timeoutMs = Math.floor(timeoutMs);
  if (timeoutMs <= 0) throw new Error("Kata foreground budget exhausted");
  const r = await $.process.run([kata, ...args, ...flags], {timeoutMs, cwd: workspace});
  if (r.exitCode !== 0) throw new Error("Kata command failed: " + r.stderr + " " + r.stdout);
  return r.stdout;
}
async function resolveRef($: EngineInterface, ref: string, target: Target, timeoutMs = 100): Promise<string> {
  if (ref.includes("#")) return ref;
  if (target.project) return target.project + "#" + ref;
  const data = JSON.parse(await run($, ["list", "--status", "all", "--limit", "1", "--json"], timeoutMs, target));
  const project = data.issues?.[0]?.qualified_id?.split("#")[0];
  if (!project) throw new Error("Kata project identity unavailable");
  return project + "#" + ref;
}
async function show($: EngineInterface, ref: string, target?: Target, timeout = 1000): Promise<IssueView> {
  return JSON.parse(await run($, ["show", ref, "--json"], timeout, target));
}
async function meta($: EngineInterface, ref: string, key: string, value: string, target?: Target) {
  const d = await show($, ref, target);
  if (d.issue.status === "closed" &&
      !(key === "claude.status" && ["completed", "failed", "killed"].includes(value))) return;
  await run($, ["meta", "set", ref, key, value, "--if-match", String(d.issue.revision)], 1000, target);
}

/** Resolve physical destinations before granting the external-write exemption.
 * Missing/deleted historical files remain unknown, never confidently external. */
async function canonicalScope($: EngineInterface, root: string, paths: string[]) {
  const resolutions: Record<string,string|null> = {};
  if (!paths.length) return {root,resolutions};
  const physicalRoot = (await $.fs.stat(root,{resolve:true}).catch(()=>undefined))?.realPath;
  for (const [index,path] of [...new Set(paths)].entries()) {
    resolutions[path] = physicalRoot && index < 100
      ? (await $.fs.stat(path,{resolve:true}).catch(()=>undefined))?.realPath ?? null : null;
  }
  return {root:physicalRoot ?? root,resolutions};
}

/** Find automatic parents in Kata using retained session ownership and lifecycle.
 * Discovery is background-only and pinned to the current folder/store. */
async function discoverParents($: EngineInterface) {
  const current = await session($), scope = await executionScope($);
  if (!compatibleScope(current.scope, scope)) return;
  const keys = await $.store.keys();
  // Retained lifecycle state identifies owned sessions. Avoid probing unrelated
  // workspaces; completion proof itself comes from Kata close events.
  let recoverable = false;
  for (const key of keys) if (/^session\/[^/]+\/(spawn|run)\//.test(key)) {
    if (key.startsWith(`session/${current.id}/`) && (current.parent || current.unbound)) continue;
    const child = await $.store.get(key) as KataEntry;
    if (child.parent && !child.bound && child.workspace === current.cwd && compatibleScope(child.scope,scope)) {recoverable = true; break;}
  }
  if (!recoverable) return;
  const result = JSON.parse(await run($, ["list", "--label", "claude-session", "--status", "open", "--limit", "1000", "--json"], 1000, current));
  if (!Array.isArray(result.issues)) return;
  for (const issue of result.issues as IssueView["issue"][]) {
    const metadata = issue.metadata, sid = metadata?.["claude.session_id"];
    if (metadata?.["claude.auto_parent"] !== true || typeof sid !== "string" || !issue.qualified_id) continue;
    const key = `session/${sid}/binding/parent`, saved = await $.store.get(key) as KataSession | undefined;
    if (saved?.parent || saved?.autoParent || saved?.unbound) {
      if (saved.cwd === current.cwd && compatibleScope(saved.scope, scope) && saved.autoParent === issue.qualified_id && !saved.mainActive && !saved.ended)
        await $.store.set(key, {...saved, ended: true});
      continue;
    }
    if (metadata?.["claude.workspace"] !== current.cwd) continue;
    const children: KataEntry[] = [];
    for (const k of keys) if (k.startsWith(`session/${sid}/spawn/`) || k.startsWith(`session/${sid}/run/`)) {
      const child = await $.store.get(k) as KataEntry;
      if (!child.bound) children.push(child);
    }
    if (!children.length || children.some(c=>c.parent !== issue.qualified_id || c.workspace !== current.cwd || !compatibleScope(c.scope,scope))) continue;
    let generation = 0;
    for (const k of keys) if (k.startsWith(`session/${sid}/op/`)) {
      const op = await $.store.get(k) as KataOperation;
      if (op.kind === "parent-close" && op.ref === issue.qualified_id) generation = Math.max(generation, Number(op.id.split(":").at(-1)) || 0);
    }
    const recovered: KataSession = {...saved, id:sid, parent:issue.qualified_id, autoParent:issue.qualified_id, cwd:current.cwd, workspace:current.cwd,
      project:issue.qualified_id.split("#")[0], scope, parentGeneration:generation+1, ended:sid !== current.id, mainActive:sid === current.id && current.mainActive};
    if (sid === current.id) await bind($, recovered); else await $.store.set(key, recovered);
  }
}
/** Queue reconciliation after a child closes, or the lead settles. Keep it
 * pending while the lead can still be launching additional work this turn. */
async function reconcileParents($: EngineInterface) {
  const current = await $.session.id(), cwd = (await session($)).cwd;
  for (const key of await $.store.keys()) {
    if (!key.endsWith("/binding/parent") && !key.includes("/retained-parent/")) continue;
    const s = await $.store.get(key) as KataSession;
    if (!s.autoParent || s.autoParentClosed || s.cwd !== cwd || (s.id !== current && !s.ended)) continue;
    const primaryKey = `session/${s.id}/binding/parent`;
    const primary = key === primaryKey ? s : await $.store.get(primaryKey) as KataSession | undefined;
    // A detached cohort has its own original workspace and lifetime. The
    // current lead binding must neither suppress nor duplicate its closure.
    if (key === primaryKey && s.parent !== s.autoParent && await $.store.get(`session/${s.id}/retained-parent/${encodeURIComponent(s.autoParent)}`)) continue;
    if (key !== primaryKey && primary?.parent === s.autoParent) continue;
    await enqueue($, {id: `session:${s.id}:parent-close:${s.autoParent}:${s.parentGeneration ?? 0}`, kind: "parent-close", entry: "run", key: "session",
      ref: s.autoParent, ownerSessionId: s.id, ownerBindingKey: key, scope: s.scope, project: s.autoParentProject ?? s.autoParent.split("#")[0], workspace: s.autoParentWorkspace ?? s.workspace ?? s.cwd, attempts: 0, marker: `[claude:${s.id}:parent-close]`});
  }
}
type LeadSettlement = {epoch: number; settled: boolean; nativeBusy?: boolean};
async function leadSettlement($: EngineInterface, change: "invalidate" | "settle" | "native", nativeBusy?: boolean) {
  await lock(async () => {
    const key = `session/${await $.session.id()}/lead-settlement`;
    const old = await $.store.get(key) as LeadSettlement | undefined;
    await $.store.set(key, {epoch: (old?.epoch ?? 0) + 1,
      settled: change === "settle" ? true : change === "invalidate" ? false : old?.settled ?? false,
      nativeBusy: change === "native" ? nativeBusy : old?.nativeBusy});
  });
}
async function closeParent($: EngineInterface, op: KataOperation) {
  return parentLock(async () => {
    const primaryKey = `session/${op.ownerSessionId}/binding/parent`;
    let ownerKey = op.ownerBindingKey ?? primaryKey;
    let s = await $.store.get(ownerKey) as KataSession | undefined;
    if (ownerKey === primaryKey && s?.autoParent && s.parent !== s.autoParent) {
      const retainedKey = `session/${s.id}/retained-parent/${encodeURIComponent(s.autoParent)}`;
      const retained = await $.store.get(retainedKey) as KataSession | undefined;
      if (retained && retained.parentGeneration === s.parentGeneration) {ownerKey = retainedKey; s = retained;}
    }
    if (!s || s.autoParent !== op.ref || (s.autoParentWorkspace ?? s.workspace ?? s.cwd) !== op.workspace) return;
    if (op.id !== `session:${s.id}:parent-close:${s.autoParent}:${s.parentGeneration ?? 0}`) return;
    if (s.mainActive && !s.ended) throw new Error("Kata deferred parent closure");
    const prefix = `session/${s.id}/`;
    const settlement = await $.store.get(prefix + "lead-settlement") as LeadSettlement | undefined;
    const assertSettlement = async () => {
      const live = await $.store.get(prefix + "lead-settlement") as LeadSettlement | undefined;
      if (live?.epoch !== settlement?.epoch || (!s.ended && live && (!live.settled || live.nativeBusy))) throw new Error("Kata deferred parent closure");
    };
    await assertSettlement();
    const assertPrepared = async () => {
      for (const key of await $.store.keys()) if (key.startsWith(prefix + "op/")) {
        const pending = await $.store.get(key) as KataOperation;
        const context = pending.context;
        if (!pending.ack && pending.kind === "create" && pending.prepare && context &&
            (context.workspace ?? context.cwd) === op.workspace && context.scope === s.scope &&
            (context.bindingVersion ?? 0) === (s.bindingVersion ?? 0)) throw new Error("Kata deferred parent closure");
      }
    };
    await assertPrepared();
    const markClosed = async (value: KataSession) => {
      await $.store.set(ownerKey, {...value, autoParentClosed: true});
      const primaryKey = `session/${s.id}/binding/parent`;
      if (ownerKey !== primaryKey) {
        const primary = await $.store.get(primaryKey) as KataSession | undefined;
        if (primary && primary.autoParent === s.autoParent && primary.parent !== s.autoParent) {
          const updated = {...primary, autoParentClosed: true};
          await $.store.set(primaryKey, updated);
          if (sessionCache.has(s.id)) sessionCache.set(s.id, updated);
        }
      }
    };
    const assertReservations = async () => {
      const keys = await $.store.keys();
      if (keys.some(k => k.startsWith(prefix + "launch/") || k.startsWith(prefix + "workflow-notice/"))) throw new Error("Kata deferred parent closure");
      for (const key of keys) if (key.startsWith(prefix + "spawn/") || key.startsWith(prefix + "run/")) {
        const child = await $.store.get(key) as KataEntry;
        if (child.parent === s.autoParent && (!child.ref || !["completed", "failed", "killed", "denied", "session-ended"].includes(child.status))) throw new Error("Kata deferred parent closure");
      }
    };
    await assertReservations();
    const keys = await $.store.keys();
    const children: KataEntry[] = [];
    for (const key of keys) if (key.startsWith(prefix + "spawn/") || key.startsWith(prefix + "run/")) {
      const child = await $.store.get(key) as KataEntry;
      if (child.parent === s.autoParent) children.push(child);
    }
    if (!children.length || children.some(e => !e.ref || !["completed", "failed", "killed", "denied", "session-ended"].includes(e.status))) throw new Error("Kata deferred parent closure");
    const assertNative = async () => {
      if (s.id !== await $.session.id()) return;
      const agents = await $.agent.list();
      const stop = await $.store.get(prefix + "native-stop/latest") as {backgroundTasks: {type: string; status: string}[] | null} | undefined;
      const teammateTasks = stop?.backgroundTasks?.filter(t => t.type === "teammate") ?? [];
      // Stop reports a teammate task as running for its whole lifetime, even
      // while AgentInfo reports idle. AgentInfo is the complete session roster;
      // require every live teammate slot, plus its own joined finish receipt.
      if (teammateTasks.length && (teammateTasks.some(t => t.status === "pending") ||
          teammateTasks.length !== agents.filter(a => a.teammateId && !["completed", "failed", "killed"].includes(a.status)).length)) throw new Error("Kata deferred parent closure");
      for (const agent of agents) {
        if (["completed", "failed", "killed"].includes(agent.status)) continue;
        const child = children.find(c => c.agentId === agent.id);
        if (agent.status === "idle" && child && ["completed", "failed", "killed"].includes(child.status) && child.finishedThrough && (!child.reply?.messageDriven || child.closedBy)) continue;
        throw new Error("Kata deferred parent closure");
      }
    };
    await assertNative();
    const parent = await show($, op.ref!, op, 100);
    if (parent.issue.status === "closed") {
      await markClosed(s);
      return;
    }
    const stillIdle = async () => {
      const live = await $.store.get(ownerKey) as KataSession;
      if (live.mainActive && !live.ended) throw new Error("Kata deferred parent closure");
      await assertPrepared();
      await assertReservations();
      await assertSettlement();
      await assertNative();
    };
    await stillIdle();
    // Typed marker proves this is our auto-created parent, never a claimed one.
    if (parent.issue.metadata?.["claude.auto_parent"] !== true) throw new Error("Kata deferred parent closure");
    const needsReview = async () => {
      const live = await show($,op.ref!,op,100);
      if (live.issue.status !== "closed" && !live.labels?.some(l=>l.label==="needs-review"))
        await run($,["label","add",op.ref!,"needs-review"],100,op);
    };
    if (!parent.children?.length || parent.children.some(e => e.status !== "closed")) {
      await needsReview();throw new Error("Kata deferred parent closure");
    }
    const evidence: unknown[] = [], snapshots: IssueView["issue"][] = [];
    const audits = new Map<string,{issue:string;event_id:number}[]>();
    for (const child of parent.children) {
      const ref=child.qualified_id ?? (s.project ?? op.project) + "#" + child.short_id;
      const target={workspace:op.workspace,project:ref.split("#")[0]!,deadline:op.deadline};
      const view=await show($,ref,target,100);await stillIdle();
      if(view.issue.status!=="closed")throw new Error("Kata deferred parent closure");
      snapshots.push(view.issue);
      if(view.issue.closed_reason==="wontfix")continue;
      if(!audits.has(target.project)) {
        const audit=JSON.parse(await run($,["audit","closes","--json"],100,target));
        if(!Array.isArray(audit.rows))throw new Error("Kata close audit unavailable");
        audits.set(target.project,audit.rows);
      }
      const latest=audits.get(target.project)!.filter(row=>row.issue===view.issue.short_id).sort((a,b)=>b.event_id-a.event_id)[0];
      if(!latest || !Number.isSafeInteger(latest.event_id) || latest.event_id<=0)throw new Error("Kata close event unavailable");
      const page=JSON.parse(await run($,["events","--after",String(latest.event_id-1),"--limit","1","--json"],100,target));
      const event=page.events?.[0];
      if(page.reset_required || event?.event_id!==latest.event_id || event.type!=="issue.closed" ||
          event.issue_short_id!==view.issue.short_id || (view.issue.uid && event.issue_uid!==view.issue.uid) ||
          (view.issue.closed_at && Date.parse(event.payload?.closed_at)!==Date.parse(view.issue.closed_at)) || !Array.isArray(event.payload?.evidence))
        throw new Error("Kata current child close evidence unavailable");
      evidence.push(...event.payload.evidence);
      await stillIdle();
    }
    const proofArgs=closeEvidenceArgs(evidence);
    if(!proofArgs.length){await needsReview();throw new Error("Kata deferred parent closure");}
    // Membership and revisions can change while retrieving the close events.
    const current=await show($,op.ref!,op,100);await stillIdle();
    if(current.issue.status==="closed"){await markClosed(s);return;}
    if(!current.children || current.children.length!==snapshots.length || current.children.some(child=>
        child.status!=="closed" || !snapshots.some(old=>old.short_id===child.short_id && old.revision===child.revision && old.uid===child.uid)))
      throw new Error("Kata deferred parent closure");
    const fresh = await $.store.get(ownerKey) as KataSession | undefined;
    if (!fresh || fresh.parentGeneration !== s.parentGeneration || (fresh.mainActive && !fresh.ended)) throw new Error("Kata deferred parent closure");
    await stillIdle();
    try {
      if(current.labels?.some(l=>l.label==="needs-review"))await run($,["label","rm",op.ref!,"needs-review"],100,op);
      await stillIdle();
      await run($, ["close", op.ref!, "--done", "--message", `Claude session ${s.id}: all ${snapshots.length} child issues are closed in Kata and the lead and delegates have settled. Completion evidence is the union of their current Kata-validated close events. ${op.marker}`,
        ...proofArgs, "--teammate", "claude-session"], 100, op);
    } catch(error) {await needsReview();throw error;}
    await markClosed(fresh);
  });
}

async function apply($: EngineInterface, op: KataOperation, timeoutMs = 1000) {
  if (op.kind === "parent-close") { await closeParent($, op); return; }
  if (op.kind === "auto-meta" || op.kind === "reparent") {
    if (op.kind === "reparent") {
      const s = await $.store.get(`session/${op.sessionId}/binding/parent`) as KataSession;
      if (op.id !== `session:reparent:${s.bindingVersion ?? 0}:${s.parent}`) return;
    }
    const d = await show($, op.ref!, op);
    if (d.issue.status === "closed") return;
    if (op.kind === "auto-meta")
      await run($, ["meta", "set", op.ref!, "claude.auto_parent", "true", "--json-value", "--if-match", String(d.issue.revision)], timeoutMs, op);
    else await run($, ["edit", op.ref!, "--parent", op.parent!], timeoutMs, op);
    return;
  }
  if (op.kind === "create") {
    const d: IssueView = JSON.parse(await run($, op.args!, timeoutMs, op));
    if (!d.issue?.short_id) throw new Error("No Kata issue ref");
    await putEntry($, op.entry, op.key, (old) => ({
      ...old!,
      ref: qualified(d, op.project),
      project: qualified(d, op.project).split("#")[0],
      workspace: op.workspace,
    }), op.sessionId, true);
    return;
  }
  const entry = await getEntry($, op.entry, op.key, op.sessionId);
  if (!entry?.ref) throw new Error("Child create still pending");
  const ref = entry.ref,
    d = await show($, ref, op, timeoutMs);
  if (d.issue.status === "closed") {
    const status = op.kind === "report" ? op.status : op.kind === "meta" ? op.metadata?.["claude.status"] : undefined;
    if (status && ["completed", "failed", "killed"].includes(status))
      await transition(`${op.sessionId}:spawn:${op.key}`, async () => {
        if ((await getEntry($, op.entry, op.key, op.sessionId))?.statusEffect === op.id)
          await meta($, ref, "claude.status", status, op);
      });
    if (op.kind === "report" || op.kind === "close" || op.kind === "deny" || op.kind === "observe" || op.kind === "meta") {
      await putEntry($, op.entry, op.key, old => ({...old!, closedBy: old?.closedBy ?? (op.closeAttempted ? "mod" : "agent")}), op.sessionId);
      await reconcileParents($);
    }
    return;
  }
  if (op.kind === "observe") return;
  if (op.kind === "close") {
    await transition(`${op.sessionId}:spawn:${op.key}`, async () => {
      const live = await getEntry($, op.entry, op.key, op.sessionId);
      if (!live || live.statusEffect !== op.id.replace(/:close$/, "") || live.status !== "completed") return;
      if (!(op.entry === "run" ? live.workflowCompletion?.verified : canClose(live.verification, live.reply?.answer ?? op.body)) || live.reply?.incomplete) {
        if (!d.labels?.some(l => l.label === "needs-review")) await run($, ["label", "add", ref, "needs-review"], timeoutMs, op);
        return;
      }
      const proofArgs = op.entry === "run" ? workflowEvidenceArgs(live.workflowCompletion) : evidenceArgs(live.evidence);
      if (!proofArgs.length) return;
      await $.store.set((await opPrefix($, op.sessionId)) + op.id, {...op, closeAttempted: true});
      await run($, ["close", ref, "--done", "--message", op.body! + "\n\n" + op.marker,
        ...proofArgs, "--teammate", live.teammate, "--if-match", String(d.issue.revision)], Math.min(timeoutMs,100), op);
      await putEntry($, op.entry, op.key, old => ({...old!, closedBy: "mod"}), op.sessionId);
    });
    await reconcileParents($);
    return;
  }
  if (op.kind === "meta") {
    for (const [key, value] of Object.entries(op.metadata!)) {
      if (
        key === "claude.status" &&
        (await getEntry($, op.entry, op.key, op.sessionId))?.statusEffect !== op.id
      )
        continue;
      await meta($, ref, key, value, op);
    }
  } else if (op.kind === "deny" && entry.bound) {
    // A bound issue predates this spawn: record the denial, never close it.
    if (!d.comments?.some(c => c.body.includes(op.body!)))
      await run($, ["comment", ref, "--body", op.body!, "--teammate", entry.teammate], timeoutMs, op);
    await meta($, ref, "claude.status", "denied", op);
  } else if (op.kind === "deny") {
    await meta($, ref, "claude.status", "denied-close-pending", op);
    if (!d.labels?.some(l => l.label === "needs-review")) await run($, ["label", "add", ref, "needs-review"], timeoutMs, op);
    if ((await show($, ref, op, timeoutMs)).issue.status !== "closed") {
      await $.store.set((await opPrefix($, op.sessionId)) + op.id, {...op, closeAttempted: true});
      await run($, [
        "close",
        ref,
        "--wontfix",
        "--message",
        op.body!,
        "--teammate",
        entry.teammate,
      ], timeoutMs, op);
    }
    await putEntry($, op.entry, op.key, old => ({...old!, closedBy: "mod"}), op.sessionId);
    await reconcileParents($);
  } else {
    const observed = entry.bound ? evidenceArgs(entry.evidence).filter(v => !v.startsWith("--")) : [];
    if (!d.comments?.some((c) => c.body.includes(op.marker!)))
      await run($, [
        "comment",
        ref,
        "--body",
        op.body! + (observed.length ? "\n\nObserved verification: " + observed.join("; ") : "") + "\n\n" + op.marker,
        "--teammate",
        entry.teammate,
      ], timeoutMs, op);
    if (entry.bound) {
      // The named issue belongs to the delegate (and its lead): it closes the
      // issue itself with its own evidence. The mod reports, never closes.
    } else if (op.status === "completed" && (op.entry === "run" ? entry.workflowCompletion?.verified && !entry.reply?.incomplete : canClose(entry.verification, op.body)) && entry.statusEffect === op.id) {
      const fresh = await show($, ref, op, timeoutMs);
      if (fresh.issue.status !== "closed" && fresh.labels?.some(l => l.label === "needs-review"))
        await run($, ["label", "rm", ref, "needs-review"], timeoutMs, op);
      await enqueue($, {id: op.id + ":close", kind: "close", sessionId: op.sessionId, scope: op.scope, project: op.project, workspace: op.workspace, entry: op.entry, key: op.key, attempts: 0,
        marker: `[claude:${entry.toolId}:close:${op.id}]`,
        body: op.entry === "run" ? `Workflow ${entry.workflowName} completed with each writing contributor reporting verification: ${entry.workflowCompletion!.statements.join("; ").slice(0,2000)}. Files: ${entry.workflowCompletion!.files.join(", ")}.` : documentationOnly(entry.verification) && entry.verification?.documentationStatement
          ? `Documentation written and verified by the agent: ${entry.verification.documentationStatement}. Files: ${entry.evidence?.written.join(", ")}. Final result: ${op.body!.trim().slice(0,1400)}`
          : `Completed ${entry.title ?? entry.workflowName ?? entry.toolId} (${ref}). Observed verification: ${evidenceArgs(entry.evidence).filter(v => !v.startsWith("--")).join("; ")}. Final result: ${op.body!.trim().slice(0, 1400)}`});
    } else {
      const fresh = await show($, ref, op, timeoutMs);
      if (
        fresh.issue.status !== "closed" &&
        !fresh.labels?.some((l) => l.label === "needs-review")
      )
        await run($, ["label", "add", ref, "needs-review"], timeoutMs, op);
    }
    if ((await getEntry($, op.entry, op.key, op.sessionId))?.statusEffect === op.id)
      await meta($, ref, "claude.status", op.status!, op);
  }
}
const queueKeys = new Set<string>();
let queueLoaded = false;
let queueTimer: {due: number; cancel?: () => void} | undefined;
const transportPause = new Map<string, {until: number; failures: number}>();
async function prepare($: EngineInterface, op: KataOperation, deadline?: number, timeoutMs = 100) {
  const context = op.context ?? sessionCache.get(op.sessionId!) ?? await $.store.get(`session/${op.sessionId}/binding/parent`) as KataSession;
  if (!context) throw new Error("Kata preparation binding unavailable");
  const parent = await delegationParent($, deadline, context, timeoutMs);
  if (!parent) return false;
  op.parent = parent; op.project = parent.split("#")[0];
  op.workspace ??= context.workspace ?? context.cwd;
  op.args = [...op.args!, "--parent", parent];
  op.prepare = false;
  await putEntry($, op.entry, op.key, old => ({...old!, parent, project: op.project, workspace: op.workspace}), op.sessionId);
  await $.store.set((await opPrefix($, op.sessionId)) + op.id, op);
  return true;
}
async function attempt($: EngineInterface, op: KataOperation, timeout = 1000, deadline?: number) {
  op.sessionId ??= await $.session.id();
  return transition(`operation:${op.sessionId}:${op.id}`, () => attemptUnlocked($, op, timeout, deadline));
}
async function attemptUnlocked($: EngineInterface, op: KataOperation, timeout = 1000, deadline?: number) {
  op.sessionId ??= await $.session.id();
  const context = sessionCache.get(op.sessionId) ?? await $.store.get(`session/${op.sessionId}/binding/parent`) as KataSession;
  op = {...op, scope: op.scope ?? context?.scope, project: op.project ?? context?.project, workspace: op.workspace ?? context?.workspace ?? context?.cwd};
  const key = (await opPrefix($, op.sessionId)) + op.id;
  const existing = await $.store.get(key) as KataOperation | undefined;
  if (existing?.ack) {queueKeys.delete(key); return true;}
  const now = await $.clock.now(), pause = transportPause.get(op.scope ?? "");
  const wait = Math.max(existing?.notBefore ?? 0, pause?.until ?? 0) - now;
  if (wait > 0) {scheduleDrain($, wait); return false;}
  const pending = {...(existing ?? op), ...op, closeAttempted: existing?.closeAttempted ?? op.closeAttempted, attempts: (existing?.attempts ?? 0) + 1};
  await $.store.set(key, pending); queueKeys.add(key);
  try {
    if (pending.prepare && !(await prepare($, pending, deadline, timeout))) {
      await $.store.set(key, {...pending, ack: true, args: undefined, context: undefined}); queueKeys.delete(key); return true;
    }
    const remaining = deadline === undefined ? timeout : deadline - await $.clock.now() - 80;
    if (remaining <= 0) throw new Error("Kata foreground budget exhausted");
    await apply($, {...pending, deadline}, Math.min(timeout, remaining));
    transportPause.delete(op.scope ?? "");
    await $.store.set(key, {...pending, args: undefined, body: undefined, metadata: undefined, context: undefined, ack: true});
    queueKeys.delete(key);
    if (op.kind === "report") {
      const entry = await getEntry($, op.entry, op.key, op.sessionId);
      if (entry?.statusEffect === op.id && entry.reply) await putEntry($, op.entry, op.key, old => ({...old!, reply: {...old!.reply!, answer: ""}}), op.sessionId);
    }
    return true;
  } catch (error) {
    pending.closeAttempted ||= (await $.store.get(key) as KataOperation)?.closeAttempted;
    if (op.kind === "parent-close" && /deferred parent closure/.test(String(error))) {
      await $.store.set(key, {...pending, attempts: 0}); return false;
    }
    if ((op.kind === "close" || op.kind === "parent-close" || op.kind === "deny") && /sibling_throttle|sibling.*(?:throttl|60.*second)/i.test(String(error))) {
      await $.store.set(key, {...pending, notBefore: await $.clock.now() + 60000, closeAttempted: true, attempts: 0});
      scheduleDrain($, 60000); return false;
    }
    await $.ui.log(`Kata write failed: ${op.id}, attempt ${pending.attempts}: ${String(error)}`, {to: "debug"});
    const transport = !/Child create still pending|revision|conflict|if.match/i.test(String(error));
    const failures = transport ? (transportPause.get(op.scope ?? "")?.failures ?? 0) + 1 : pending.attempts;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
    const until = await $.clock.now() + delay;
    if (transport) transportPause.set(op.scope ?? "", {until, failures});
    await $.store.set(key, {...pending, notBefore: until}); scheduleDrain($, delay); return false;
  }
}
async function create($: EngineInterface, op: KataOperation, deadline?: number) {
  await enqueue($, op);
  const remaining = deadline === undefined ? 100 : deadline - await $.clock.now();
  if (remaining < 160) return false;
  if (op.prepare && op.context?.parent && !op.context.autoParent) {
    op = {...op, prepare: false, args: [...op.args!, "--parent", op.context.parent]};
  }
  return attempt($, op, remaining, deadline);
}
async function enqueue($: EngineInterface, op: KataOperation) {
  op.sessionId ??= await $.session.id();
  const context = sessionCache.get(op.sessionId) ?? await $.store.get(`session/${op.sessionId}/binding/parent`) as KataSession ?? await session($);
  const entry = op.key !== "session" && !op.scope ? await getEntry($, op.entry, op.key, op.sessionId) : undefined;
  const owner = op.ownerSessionId ? await $.store.get(op.ownerBindingKey ?? `session/${op.ownerSessionId}/binding/parent`) as KataSession | undefined : undefined;
  op = {...op, scope: op.scope ?? entry?.scope ?? owner?.scope ?? context.scope, project: op.project ?? op.ref?.split("#")[0] ?? entry?.project ?? owner?.project ?? context.project, workspace: op.workspace ?? entry?.workspace ?? owner?.workspace ?? owner?.cwd ?? context.workspace ?? context.cwd};
  await lock(async () => {
    const key = (await opPrefix($, op.sessionId)) + op.id;
    if (!(await $.store.get(key))) await $.store.set(key, op);
    queueKeys.add(key);
  });
  scheduleDrain($, 0);
}
function scheduleDrain($: EngineInterface, delay: number) {
  void $.clock.now().then(now => {
    const due = now + delay;
    if (queueTimer && queueTimer.due <= due) return;
    queueTimer?.cancel?.();
    const timer = {due, cancel: undefined as (() => void) | undefined}; queueTimer = timer;
    const handle = $.clock.after(delay, async () => {
      if (queueTimer !== timer) return;
      queueTimer = undefined; await safely($, () => drain($));
    });
    if (typeof handle === "function") timer.cancel = handle;
  });
}
async function drain($: EngineInterface) {
  return queueLock(async () => {
    const current = await session($), runtimeScope = await executionScope($);
    if (!queueLoaded) {
      for (const key of await $.store.keys()) if (/^session\/[^/]+\/op\//.test(key)) queueKeys.add(key);
      queueLoaded = true;
    }
    let used = 0, more = false;
    for (const key of [...queueKeys]) {
      const op = await $.store.get(key) as KataOperation | undefined;
      if (!op || op.ack) {queueKeys.delete(key); continue;}
      const sid = key.split("/")[1]!;
      const bound = sessionCache.get(sid) ?? await $.store.get(`session/${sid}/binding/parent`) as KataSession | undefined;
      const scope = op.scope ?? bound?.scope;
      if (!compatibleScope(scope, runtimeScope) || (sid !== current.id && (!bound?.ended || bound.cwd !== current.cwd || !scope))) continue;
      const pause = transportPause.get(scope ?? "");
      if (pause && pause.until > await $.clock.now()) {scheduleDrain($, pause.until - await $.clock.now()); break;}
      if (op.notBefore && op.notBefore > await $.clock.now()) {scheduleDrain($, op.notBefore - await $.clock.now()); continue;}
      if (used++ >= 8) {more = true; break;}
      await attempt($, {...op, sessionId: sid});
      if ((transportPause.get(scope ?? "")?.until ?? 0) > await $.clock.now()) break;
    }
    if (more) scheduleDrain($, 0);
  });
}

async function safely($: EngineInterface, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    await $.ui.log("Kata observation failed", { to: "debug" });
  }
}
async function metadata(
  $: EngineInterface,
  family: "spawn" | "run",
  key: string,
  data: Record<string, string>,
  id = "identity",
) {
  const opId = `${family}:${key}:${id}`;
  if (data["claude.status"])
    await putEntry($, family, key, (old) => ({ ...old!, statusEffect: opId }));
  await enqueue($, {
    id: opId,
    kind: "meta",
    entry: family,
    key,
    metadata: data,
    attempts: 0,
  });
}

async function report(
  $: EngineInterface,
  family: "spawn" | "run",
  key: string,
  reply: KataReply,
  status: import("../types/index.d.ts").KataStatus,
  historical = false,
) {
  const entry = await getEntry($, family, key);
  if (!entry) return;
  const opId = `${family}:${key}:${status}:${reply.turnId}`;
  if (await $.store.get((await opPrefix($)) + opId)) return;
  if (
    !historical && family === "spawn" &&
    status === "completed" &&
    !entry.fallbackJoined &&
    entry.statusEffect === `spawn:${key}:completed:${entry.toolId}` &&
    reply.turnId !== entry.toolId
  ) {
    await putEntry($, family, key, (old) => ({
      ...old!,
      fallbackJoined: true,
    }));
    await enqueue($, {
      id: opId,
      kind: "report",
      entry: family,
      key,
      attempts: 0,
      ack: true,
    });
    return;
  }
  await leadSettlement($, "invalidate");
  reply = boundedReply(reply, family === "spawn");
  const marker = `[claude:${entry.toolId}:${status}:${reply.turnId}]`;
  if (!historical) await transition(`${await $.session.id()}:spawn:${key}`, () => putEntry($, family, key, (old) => ({
    ...old!, status, reply, statusEffect: opId,
    ...(family === "run" ? {workflowCompletion: reply.workflowCompletion} : {
      verification: {
        ...(old?.verification ?? {evidence: old?.evidence ?? {commits:[], prs:[], tests:[], written:[]}, verified: false, failedChecks: []}),
        documentationStatement: reply.documentationStatement, incomplete: reply.incomplete,
      },
    }),
  })));
  await enqueue($, {
    id: opId,
    kind: "report",
    entry: family,
    key,
    marker,
    body:
      reply.answer.slice(0, 4000) ||
      `Claude Code agent ${status} (${reply.reason}).`,
    status,
    attempts: 0,
  });
}
async function foregroundFallback(
  $: EngineInterface,
  key: string,
  text: string,
) {
  const sid = await $.session.id();
  $.clock.after(250, async () => {
    if (sid !== await $.session.id()) return;
    await safely($, async () => {
      const item = await getEntry($, "spawn", key);
      if (!item || ["completed", "failed", "killed"].includes(item.status))
        return;
      await report(
        $,
        "spawn",
        key,
        { turnId: key, answer: text, reason: "answer" },
        "completed",
      );
    });
  });
}
async function replayFinished($: EngineInterface, key: string) {
  const item = await getEntry($, "spawn", key), name = item?.teammateId?.split("@")[0];
  if (!name) return;
  const storeKey = `session/${await $.session.id()}/finished/${name}`;
  const notice = await $.store.get(storeKey) as import("./notifications.ts").TeammateFinished | undefined;
  if (!notice) return;
  await putEntry($, "spawn", key, old => {
    if ((old?.finishedThrough && notice.timestamp <= old.finishedThrough) ||
        (old?.finished && notice.timestamp <= old.finished.timestamp)) return old!;
    return { ...old!, finished: notice };
  });
  await lock(async () => {
    const latest = await $.store.get(storeKey) as import("./notifications.ts").TeammateFinished | undefined;
    if (latest?.timestamp === notice.timestamp) await $.store.delete(storeKey);
  });
}
async function joinFinished($: EngineInterface, key: string) {
  const item = await getEntry($, "spawn", key);
  if (!item?.finished) return;
  const notice = item.finished;
  const current = item.reply?.answer === notice.result ? item.reply : undefined;
  const prior = item.priorReplies?.find(reply => reply.answer === notice.result);
  const reply = current ?? prior;
  if (!reply) return;
  // Messaging alone is not completion. A joined own result plus an accepted
  // Kata closure is; no shell proof may overrule that authoritative close.
  const closed = reply.messageDriven && item.ref
    ? (await show($,item.ref,{workspace:item.workspace,project:item.project},100)).issue.status === "closed" : false;
  const latest = await getEntry($,"spawn",key);
  if (!reply.messageDriven || closed) await report($, "spawn", key, reply, "completed", !current || latest?.reply?.turnId !== reply.turnId);
  await putEntry($, "spawn", key, old => ({ ...old!, finished: undefined,
    finishedThrough: [old!.finishedThrough ?? "", notice.timestamp].sort().at(-1),
    priorReplies: old!.priorReplies?.filter(r => r.turnId !== reply.turnId),
  }));
}
async function observeActivity($: EngineInterface, agentId: string, messaging = false) {
  const key = await agentKey($, agentId);
  return transition(`${await $.session.id()}:spawn:${key}`, () => observeActivityInner($, agentId, messaging));
}
async function observeActivityInner($: EngineInterface, agentId: string, messaging = false) {
  const key = await agentKey($, agentId), entry = key ? await getEntry($, "spawn", key) : undefined;
  if (!entry) {
    if (messaging && (await entries($)).some(item => item.family === "spawn" && !item.value.agentId))
      await save($, "messaging", agentId, true);
    return;
  }
  await putEntry($, "spawn", key!, old => ({ ...old!,
    status: "running", messagingTurn: messaging || old!.messagingTurn,
    priorReplies: old!.reply?.answer ? [...(old!.priorReplies ?? []), old!.reply].slice(-8) : old!.priorReplies,
    reply: undefined,
  }));
  if (entry.status !== "running") await metadata($, "spawn", key!, { "claude.status": "running" }, "resume:" + entry.reply?.turnId);
}
async function observeEvidence($: EngineInterface, agentId: string, tool: string, input: Record<string, unknown>, result: Record<string, unknown>) {
  const key = await agentKey($, agentId);
  return transition(`${await $.session.id()}:spawn:${key}`, () => observeEvidenceInner($, agentId, tool, input, result));
}
async function observeEvidenceInner($: EngineInterface, agentId: string, tool: string, input: Record<string, unknown>, result: Record<string, unknown>) {
  const key = await agentKey($, agentId);
  if (!key && !(await entries($)).some(e => e.family === "spawn" && !e.value.agentId)) return;
  const cwd = await $.session.cwd(), root = (await session($)).repositoryRoot ?? (await session($)).cwd ?? cwd, tmpdir = await $.env.get("TMPDIR");
  const scope = await canonicalScope($,root,observedWritePaths(tool,input,cwd,tmpdir));
  await lock(async () => {
    const mapped = await agentKey($, agentId);
    if (mapped) {
      const old = await getEntry($, "spawn", mapped);
      const verification = updateVerification(old?.verification, tool, input, result, cwd, scope.root, tmpdir, scope.resolutions);
      const value = {...old!, evidence: verification.evidence, verification};
      await update($, {...SPAWN, id: mapped}, () => value);
      await save($, "spawn", mapped, value);
    } else {
      const path = `session/${await $.session.id()}/evidence/${agentId}`;
      await $.store.set(path, updateVerification(await $.store.get(path) as Verification | undefined, tool, input, result, cwd, scope.root, tmpdir, scope.resolutions));
    }
  });
}
async function replayEvidence($: EngineInterface, agentId: string, key: string) {
  await lock(async () => {
    const path = `session/${await $.session.id()}/evidence/${agentId}`;
    const verification = await $.store.get(path) as Verification | undefined;
    if (!verification?.evidence) return;
    const old = await getEntry($, "spawn", key);
    const value = {...old!, evidence: verification.evidence, verification};
    await update($, {...SPAWN, id: key}, () => value);
    await save($, "spawn", key, value);
    await $.store.delete(path);
  });
}

async function finishAgent(
  $: EngineInterface,
  agentId: string,
  reply: KataReply,
) {
  const key = await agentKey($, agentId);
  if (!key) {
    if (
      (await entries($)).some((e) => e.family === "spawn" && !e.value.agentId)
    )
      {
        const messaging = await $.store.get(`session/${await $.session.id()}/messaging/${agentId}`);
        await buffer($, agentId, { ...reply, messageDriven: !!messaging });
        await $.store.delete(`session/${await $.session.id()}/messaging/${agentId}`);
      }
    return;
  }
  const current = await getEntry($, "spawn", key);
  reply = { ...boundedReply(reply),
    messageDriven: current?.reply?.turnId === reply.turnId ? current.reply.messageDriven : current?.messagingTurn || reply.messageDriven };
  await transition(`${await $.session.id()}:spawn:${key}`, () => putEntry($, "spawn", key, (old) => ({ ...old!, reply, messagingTurn: false })));
  await joinFinished($, key);
  const native = (await $.agent.list()).find((a) => a.id === agentId);
  if (native?.status === "idle" || native?.status === "waiting") return;
  const tracked = await getEntry($, "spawn", key);
  if (
    native?.status === "completed" ||
    (!native && !tracked?.background && reply.reason === "answer")
  )
    await report($, "spawn", key, reply, "completed");
  else if (
    native?.status === "failed" ||
    reply.reason === "error" ||
    reply.reason === "refusal"
  )
    await report($, "spawn", key, reply, "failed");
  else if (native?.status === "killed" || reply.reason === "aborted")
    await report($, "spawn", key, reply, "killed");
}
async function replayAgent($: EngineInterface, id: string) {
  for (const reply of await early($, id)) await finishAgent($, id, reply);
  await lock(async () => {
    await update($, { ...EARLY, id }, () => []);
    await save($, "early", id, []);
  });
}
async function replayEarly($: EngineInterface) {
  for (const item of await entries($))
    if (item.family === "spawn" && item.value.agentId)
      { await replayEvidence($, item.value.agentId, item.key); await replayFinished($, item.key); await replayAgent($, item.value.agentId); await joinFinished($, item.key); }
}
async function reconcileAgents($: EngineInterface) {
  const agents = await $.agent.list();
  for (const item of await entries($)) {
    if (item.value.ref) await enqueue($, {id:`${item.family}:${item.key}:observe:${await $.clock.now()}`, kind:"observe", entry:item.family, key:item.key, attempts:0});
    if (item.family !== "spawn" || !item.value.agentId) continue;
    const native = agents.find((a) => a.id === item.value.agentId);
    if (!native) continue;
    if (["completed", "failed", "killed"].includes(native.status)) {
      await report(
        $,
        "spawn",
        item.key,
        item.value.reply ?? {
          turnId: "status-" + native.status,
          answer: `Claude Code agent ${native.status}.`,
          reason: native.status,
        },
        native.status as "completed" | "failed" | "killed",
      );
    } else if (native.status === "running" && item.value.status !== "running") {
      await putEntry($, "spawn", item.key, (old) => ({
        ...old!,
        status: "running",
      }));
      await metadata(
        $,
        "spawn",
        item.key,
        { "claude.status": "running" },
        "resume:" + item.value.reply?.turnId,
      );
    }
  }
}

/** Bind a spawn to the existing issue its description/prompt names (see
 * refs.ts for the rule). The issue must exist, be open, not be this mod's
 * automatic session issue, and not be tracking another running agent;
 * otherwise a child is created as before and `note` says why. */
async function spawnBinding($: EngineInterface, e: {description?: string; prompt: string}, context: KataSession, key: string, deadline: number): Promise<{ref?: string; note?: string}> {
  if (context.unbound || context.autoDisabled || !compatibleScope(context.scope, await executionScope($))) return {};
  const known = [context.parent, context.autoParent, context.promptRef].filter((r): r is string => !!r);
  let named = namedIssue([e.description ?? "", e.prompt], known);
  // The lead's own plan children may be named by bare short id ("kata issue
  // erjg"); look them up only when nothing qualified matched.
  if (!named.ref && context.parent && context.parent !== context.autoParent && /\b(?:issue|kata|ref)\s*[:=]?\s*[`"'(]?[0-9a-hjkmnp-tv-z]{4,8}\b/i.test(`${e.description ?? ""} ${e.prompt}`)) {
    try {
      const project = context.parent.split("#")[0];
      for (const child of (await show($, context.parent, {workspace: context.workspace ?? context.cwd, project, deadline}, 1000)).children ?? [])
        if (child.status === "open") known.push(child.qualified_id ?? `${project}#${child.short_id}`);
      named = namedIssue([e.description ?? "", e.prompt], known);
    } catch { /* Without the children, only qualified refs bind. */ }
  }
  if (!named.ref) return {note: named.reason};
  const project = named.ref.split("#")[0];
  try {
    const view = await show($, named.ref, {workspace: context.workspace ?? context.cwd, project, deadline}, 1000);
    const m = view.issue.metadata ?? {}, ref = qualified(view, project);
    if (view.issue.status === "closed") return {note: `named ${ref} is closed`};
    if (ref === context.autoParent || m["claude.auto_parent"] === true) return {note: `named ${ref} is an automatic session issue`};
    if (m["claude.status"] === "running" && typeof m["claude.tool_use_id"] === "string" && m["claude.tool_use_id"] !== key)
      return {note: `named ${ref} already tracks running agent ${m["claude.tool_use_id"]}`};
    return {ref};
  } catch (error) {
    return {note: definitelyMissing(error) ? `named ${named.ref} does not exist in Kata` : `could not verify named ${named.ref} (Kata unavailable)`};
  }
}
async function launchWorkflow($: EngineInterface, value: unknown, captured?: KataSession) {
  if (!value || typeof value !== "object") return;
  const r = value as Record<string, unknown>;
  if (
    !((r.status === "async_launched" && r.taskType === "local_workflow") ||
      (r.status === "remote_launched" && r.taskType === "remote_agent")) ||
    typeof r.taskId !== "string" ||
    typeof r.workflowName !== "string"
  )
    return;
  const context = captured ?? await session($);
  const parent = context.parent ?? "";
  const key = r.taskId,
    sid = context.id,
    teammate = await teammateHandle("wf-" + r.workflowName, key);
  await putEntry(
    $,
    "run",
    key,
    (old) =>
      old ?? { parent, scope: context.scope, project: context.project, workspace: context.workspace ?? context.cwd, repositoryRoot: context.repositoryRoot ?? context.cwd, toolId: key, teammate, workflowName: r.workflowName as string, workflowRemote: r.status === "remote_launched", status: "running" },
    sid,
  );
  const args = [
    "create",
    "workflow: " + r.workflowName,
    "--body",
    String(r.summary ?? ""),
    "--teammate",
    teammate,
    "--idempotency-key",
    `claude-workflow:${sid}:${key}`,
    "--force-new",
    "--json",
    "--meta",
    `claude.workflow_run_id=${String(r.runId ?? r.taskId)}`,
    "--meta",
    `claude.workflow_remote=${r.status === "remote_launched"}`,
    "--meta",
    `claude.task_id=${key}`,
    "--meta",
    `claude.teammate=${teammate}`,
    "--meta",
    `claude.workflow_name=${r.workflowName}`,
    "--meta",
    `claude.session_id=${sid}`,
    "--meta",
    "claude.status=running",
  ];
  await enqueue($, {
    id: `run:${key}:create`,
    kind: "create", prepare: true, context, sessionId: sid, scope: context.scope, workspace: context.workspace ?? context.cwd, project: context.project,
    entry: "run",
    key,
    args,
    attempts: 0,
  });
}
/** Called only after workflowDelivery has verified the harness envelope. */
export async function receiveWorkflow($: EngineInterface, notice: NonNullable<ReturnType<typeof workflowDelivery>>, uuid: string) {
  let entry = await getEntry($, "run", notice.taskId);
  if (!entry) {
    const registered = await lock(async () => {
      if (await getEntry($, "run", notice.taskId)) return true;
      const prefix = `session/${await $.session.id()}/`;
      const keys = await $.store.keys();
      if (!keys.some(key => key.startsWith(prefix + "launch/"))) return false;
      const inbox = prefix + "workflow-notice/";
      if (keys.filter(key => key.startsWith(inbox)).length >= 32) {
        await $.ui.log("Kata workflow receipt buffer full", { to: "debug" });
        return false;
      }
      if (!(await $.store.get(inbox + notice.taskId)))
        await save($, "workflow-notice", notice.taskId, { notice, uuid });
      return false;
    });
    if (!registered) return;
    entry = await getEntry($, "run", notice.taskId);
    if (!entry) return;
  }
  const deliveryKey = `session/${await $.session.id()}/delivery/${uuid}`;
  if (await $.store.get(deliveryKey)) return;
  const completion = entry.workflowRemote ? { verified: false, files: [], statements: [] } : workflowCompletion(notice.result, entry.repositoryRoot ?? entry.workspace ?? (await session($)).cwd ?? await $.session.cwd());
  await report($, "run", notice.taskId, {
    turnId: notice.taskId,
    answer: workflowSummary(entry.workflowName ?? "workflow", notice),
    reason: notice.status,
    incomplete: incompleteAnswer(JSON.stringify(notice)),
    workflowCompletion: completion,
  }, notice.status);
  await $.store.set(deliveryKey, true);
}
async function replayWorkflowInbox($: EngineInterface) {
  const prefix = `session/${await $.session.id()}/`, inbox = prefix + "workflow-notice/";
  for (const key of await $.store.keys()) {
    if (!key.startsWith(inbox)) continue;
    const item = await $.store.get(key) as {notice: NonNullable<ReturnType<typeof workflowDelivery>>; uuid: string};
    if (await getEntry($, "run", item.notice.taskId)) {
      await receiveWorkflow($, item.notice, item.uuid);
      await $.store.delete(key);
    } else if (!(await $.store.keys()).some(key => key.startsWith(prefix + "launch/")))
      await $.store.delete(key);
  }
}
async function finishWorkflowLaunch($: EngineInterface, toolId: string, sid?: string) {
  sid ??= await $.session.id();
  await lock(async () => {
    await $.store.delete(`session/${sid}/launch/${toolId}`);
  });
  if (sid === await $.session.id()) await replayWorkflowInbox($);
}
async function endBatch($: EngineInterface) {
  const scope = await executionScope($), context = await session($);
  if (!compatibleScope(context.scope, scope)) return;
  const active = (await entries($)).filter(e => e.value.status === "running" && e.value.ref && compatibleScope(e.value.scope, scope));
  if (!active.length) return;
  const script = "failed=0\n" + active.map(item => "(\n" + endCommand(kata, [item.value.ref!], item.value.workspace ?? context.workspace ?? context.cwd, item.value.project) + ") || failed=1").join("\n") + '\nexit "$failed"\n';
  const r = await $.process.run(["/bin/sh", "-c", script], {timeoutMs: 1000, cwd: context.cwd});
  if (r.exitCode !== 0) return;
  for (const item of active) await putEntry($, item.family, item.key, old => ({...old!, status: "session-ended", statusEffect: "session-ended"}));
}

export const register: Register = (on, options) => {
  kata = String(options.kataExecutable ?? "kata");
  const configuredSpawnBudget = Number(options.spawnCreateTimeoutMs ?? 3000);
  const spawnCreateTimeoutMs = Number.isFinite(configuredSpawnBudget) && configuredSpawnBudget > 0
    ? Math.min(30000, Math.max(250, configuredSpawnBudget)) : 3000;
  on("session.start", async ($, e, next) => {
    const deadline = await $.clock.now() + 250;
    await safely($, async () => {
      const id = await $.session.id(), generation = ++startupGeneration;
      sessionCache.delete(id); contractCache.delete(id); queueLoaded = false;
      await refreshContract($, {id, cwd: e.cwd}, deadline);
      const s = await session($, deadline);
      const bound = {...s, scope: s.scope ?? await executionScope($), cwd: s.cwd ?? e.cwd, mainActive: true, ended: false};
      if (bound.parent && compatibleScope(bound.scope, await executionScope($))) {
        try {
          bound.parent = await resolveRef($, bound.parent, {...bound, deadline: deadline - 60});
          bound.project = bound.parent.split("#")[0];
          await show($, bound.parent, {...bound, deadline: deadline - 60}, 100);
        } catch { /* Binding validation is retried by queued operations. */ }
      }
      await bind($, bound);
      await $.command.register({name: "kata", description: "Show or bind Kata session work: /kata [bind <ref>|unbind]"});
      $.clock.after(0, async () => safely($, async () => {
        if (id !== await $.session.id()) return;
        await restore($); await migrate($, bound); await parentEffects($, bound); await replayEarly($);
        const prefix = `session/${id}/launch/`;
        for (const key of await $.store.keys()) if (key.startsWith(prefix) && (await $.store.get(key) as {generation?: number})?.generation !== generation) await $.store.delete(key);
        await replayWorkflowInbox($); await safely($,()=>discoverParents($)); await reconcileParents($); scheduleDrain($, 0);
        $.clock.after(0, async () => safely($, () => trimStore($)));
      }));
      scheduleDrain($, 0);
    });
    return next(e);
  });
  on("classic.SessionStart", async ($, e, next) => {
    if (e.session_title) await safely($, async () => {
      await parentLock(async () => {
        const s = await session($);
        await bind($, { ...s, sessionName: e.session_title });
      });
    });
    return next(e);
  });
  on("prompt.submit", async ($, e, next) => {
    if (["composer", "bridge", "sdk"].includes(e.origin.kind)) await safely($, async () => {
      await parentLock(async () => {
        const s = await session($);
        const named = s.firstPrompt === undefined ? namedIssue([e.text]) : undefined;
        await bind($, { ...s, mainActive: true, ...(s.firstPrompt === undefined ? {firstPrompt: e.text.slice(0, 1500),
          firstPromptTitle: promptTitle(e.text) !== undefined ? sessionDescription(e.text, s.id).title : undefined,
          promptRef: named?.ref, promptRefNote: named?.reason ? `first prompt: ${named.reason}` : undefined} : {}) });
      });
    });
    return next(e);
  });
  on("agent.spawn", async ($, e, next) => {
    const deadline = await $.clock.now() + spawnCreateTimeoutMs;
    let entry: KataEntry | undefined, capturedSid: string | undefined,
      noted = e;
    await safely($, async () => {
      const context = await session($, deadline);
      const parent = context.parent ?? "";
      const sid = context.id,
        key = e.tool_use_id;
      capturedSid = sid;
      if (!contractCache.get(sid)?.text) await refreshContract($,{id:sid,cwd:context.cwd},deadline,spawnCreateTimeoutMs);
      const teammate = await teammateHandle(e.name ?? e.subagentType, key);
      const binding = await spawnBinding($, e, context, key, deadline);
      if (binding.ref) {
        const ref = binding.ref;
        entry = await putEntry($, "spawn", key, old => old ?? {
          parent: ref, ref, bound: true, project: ref.split("#")[0], scope: context.scope,
          workspace: context.workspace ?? context.cwd, title: e.description || "Agent work",
          teammate, toolId: key, status: "running", background: e.background,
        }, sid, true);
        if (entry.bound) await metadata($, "spawn", key, {
          "claude.tool_use_id": key, "claude.agent_type": e.subagentType, "claude.session_id": sid,
          "claude.teammate": teammate, "claude.status": "running",
        }, "bind");
      } else
      entry = await putEntry(
        $,
        "spawn",
        key,
        (old) =>
          old ?? {
            parent,
            project: context.project,
            scope: context.scope,
            workspace: context.workspace ?? context.cwd,
            title: e.description || "Agent work",
            teammate,
            toolId: key,
            status: "running",
            background: e.background,
            bindingNote: binding.note,
          },
        sid, true,
      );

      const args = [
        "create",
        e.description || "Agent work",
        "--body",
        e.prompt.slice(0, 2000) + "\n\nAgent type: " + e.subagentType,
        "--teammate",
        teammate,
        "--idempotency-key",
        `claude-agent:${sid}:${key}`,
        "--force-new",
        "--json",
        "--meta",
        `claude.tool_use_id=${key}`,
        "--meta",
        `claude.agent_type=${e.subagentType}`,
        "--meta",
        `claude.session_id=${sid}`,
        "--meta",
        `claude.teammate=${teammate}`,
        "--meta",
        "claude.status=running",
        ...(binding.note ? ["--meta", `claude.binding_note=${binding.note}`] : []),
      ];
      if (!entry.ref)
        await create($, {
          id: `spawn:${key}:create`,
          kind: "create", prepare: true, context, sessionId: sid, scope: context.scope, workspace: context.workspace ?? context.cwd, project: context.project,
          entry: "spawn",
          key,
          args,
          attempts: 0,
        }, deadline);
      entry = await getEntry($, "spawn", key);
      if (sessionCache.get(sid)?.autoDisabled || sessionCache.get(sid)?.unbound) {entry = undefined; return;}
      const cached = contractCache.get(sid);
      if (cached?.text)
        noted = {...e, prompt: cached.text + (entry?.ref ? `\n\nKata: your work is tracked as ${entry.ref} ${entry.bound ? "(the issue named in your task; no child issue was created)" : "under " + entry.parent}. Use \`kata --teammate ${teammate}\` for any Kata command and do not create another issue for it. When you finish and have verified the work, close it yourself: \`kata --teammate ${teammate} close ${entry.ref} --done --message "<what you did and how you verified it>" --commit <sha> --test "<command>"\` (use only the evidence you actually have). If you could not verify it, do not close it; comment what remains.\n\n` : `\n\nKata tracking is pending recovery; use teammate ${teammate} and do not create another issue.\n\n`) + e.prompt};

    });
    const result = await next(noted);
    if (entry)
      await safely($, async () => {
        const key = e.tool_use_id;
        if (result.agentId) {
          await putEntry($, "spawn", key, (old) => ({
            ...old!,
            agentId: result.agentId,
            teammateId: result.teammateId,
          }), capturedSid);
          await mapAgent($, result.agentId, key, capturedSid);
          const data: Record<string, string> = {"claude.agent_id": result.agentId};
          if (result.teammateId) data["claude.teammate_id"] = result.teammateId;
          if (e.parentAgentId) data["claude.parent_agent_id"] = e.parentAgentId;
          $.clock.after(0, async () => safely($, async () => {
            await enqueue($, {id: `spawn:${key}:identity`, kind: "meta", entry: "spawn", key, metadata: data, sessionId: capturedSid, attempts: 0});
            if (capturedSid !== await $.session.id()) return;
            await replayEvidence($, result.agentId!, key); await replayFinished($, key);
            await replayAgent($, result.agentId!); await joinFinished($, key);
          }));
        } else {
          await putEntry($, "spawn", key, (old) => ({
            ...old!,
            status: "denied",
          }), capturedSid);
          await enqueue($, {
            id: `spawn:${key}:deny`, sessionId: capturedSid,
            kind: "deny",
            entry: "spawn",
            key,
            body:
              `Claude Code denied task "${entry!.title ?? e.description ?? "Agent work"}" (tool ${key}). The delegated agent did not start, so ${entry!.bound ? "this issue is left as it was" : "this child is cancelled"}. Reason: ${result.deny?.trim() || "No agent id was returned."}. [claude:${await $.session.id()}:${key}:deny]`,
            attempts: 0,
          });
        }
      });
    return result;
  });
  on("tool.call", async ($, e, next) => {
    let rewritten = e;
    let workflowContext: KataSession | undefined;
    let denied: string | undefined;
    await safely($, async () => {
      if (e.tool === "Workflow") {
        await leadSettlement($, "invalidate");
        workflowContext = await session($);
        await save($, "launch", e.tool_use_id, {generation: startupGeneration}, workflowContext.id);
      }
      if (e.agentId) await observeActivity($, e.agentId, e.tool === "SendMessage");
      if (e.tool !== "Bash" || !e.agentId) return;
      const key = await agentKey($, e.agentId),
        entry = key ? await getEntry($, "spawn", key) : undefined;
      if (!entry) return;
      if (kataImpersonation(e.command)) {
        denied = `Kata actor impersonation is forbidden: never --as. Use --teammate ${entry.teammate} to keep the actor.`;
        return;
      }
      rewritten = { ...e, command: rewriteKata(e.command, entry.teammate) };
    });
    if (denied) return { deny: denied };
    let result;
    try { result = await next(rewritten); }
    catch (error) {
      if (e.tool === "Workflow") await safely($, () => finishWorkflowLaunch($, e.tool_use_id, workflowContext?.id));
      throw error;
    }
    await safely($, async () => {
      if (e.agentId) await observeEvidence($, e.agentId, e.tool, e as unknown as Record<string, unknown>, result as unknown as Record<string, unknown>);
      if (e.agentId && e.tool === "Bash" && !result.isError && /\bkata\b/.test(e.command) && /\bclose\b/.test(e.command)) {
        const key = await agentKey($,e.agentId);
        if (key) await enqueue($,{id:`spawn:${key}:observe:${e.tool_use_id}`,kind:"observe",entry:"spawn",key,attempts:0});
      }
      if (e.tool === "Workflow") {
        try { if (!result.isError) await launchWorkflow($, result.result, workflowContext); }
        finally { await finishWorkflowLaunch($, e.tool_use_id, workflowContext?.id); }
      }
      if (e.tool === "Agent") {
        const item = await getEntry($, "spawn", e.tool_use_id);
        if (item) {
          const data = result.result as Record<string, unknown> | undefined;
          if (result.isError)
            await report(
              $,
              "spawn",
              e.tool_use_id,
              {
                turnId: item.reply?.turnId ?? e.tool_use_id,
                answer: result.text ?? "Agent tool failed",
                reason: "error",
              },
              "failed",
            );
          else if (data?.status === "completed")
            await foregroundFallback($, e.tool_use_id, result.text ?? "");
        }
      }
      if (
        e.tool === "Bash" &&
        !e.agentId &&
        !result.isError &&
        (!(await session($)).parent || (await session($)).parent === (await session($)).autoParent)
      ) {
        const ref = claimedRef(parseKata(e.command) ?? []);
        if (ref) {
          const short = ref.split("#").pop()!;
          // Confirm the successful CLI output identifies exactly this issue.
          const tokens = (result.text ?? "").split(/[^A-Za-z0-9._#-]+/);
          if (tokens.includes(ref) || tokens.includes(short)) {
            await adoptParent($, ref, claimedWorkspace(parseKata(e.command) ?? []));
                }
        } else if (!parseKata(e.command)) {
          // A compound script (the lead creating and claiming its own plan):
          // adopt the topmost issue Kata reports it claimed.
          const root = await claimedRoot($, reportedClaims(e.command, result.text ?? ""));
          if (root) await adoptParent($, root);
        }
      }
    });
    return result;
  });
  on("turn.start", async ($, e, next) => {
    await safely($, () => leadSettlement($, "invalidate"));
    return next(e);
  });
  on("classic.Stop", async ($, e, next) => {
    await safely($, async () => {
      await save($, "native-stop", "latest", {backgroundTasks: e.background_tasks?.map(t => ({type:t.type,status:t.status})) ?? null});
      await leadSettlement($, "native", e.background_tasks === undefined || e.background_tasks.some(t => t.type !== "teammate"));
    });
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    await safely($, async () => {
      scheduleDrain($, 0);
      if (e.agentId)
        await finishAgent($, e.agentId, {
          turnId: e.turnId,
          answer: e.answer,
          reason: e.reason,
        });
      if (!e.agentId) {
        const s = await session($);
        await reconcileAgents($);
        await leadSettlement($, "settle");
        await bind($, {...s, mainActive: false});
        $.clock.after(0, async () => safely($, async () => {await reconcileAgents($); await reconcileParents($); scheduleDrain($, 0);}));
      }
    });
    return result;
  });
  on("session.receive", async ($, e, next) => {
    await safely($, async () => {
      if (e.agentId && e.origin.kind === "coordinator" && "isVerified" in e.origin && e.origin.isVerified)
        await observeActivity($, e.agentId);
    });
    const result = await next(e);
    await safely($, async () => {
      if ("consumed" in result) return;
      const notice = teammateFinished(e);
      if (!notice) return;
      const candidates = (await entries($)).filter(item => item.family === "spawn" &&
        item.value.teammateId?.split("@")[0] === notice.from);
      if (candidates.length !== 1) {
        if ((await entries($)).some(item => item.family === "spawn" && !item.value.agentId)) {
          await lock(async () => {
            const previous = await $.store.get(`session/${await $.session.id()}/finished/${notice.from}`) as import("./notifications.ts").TeammateFinished | undefined;
            if (!previous || notice.timestamp > previous.timestamp) await save($, "finished", notice.from, notice);
          });
        }
        return;
      }
      const item = candidates[0]!;
      if (item.value.finishedThrough && notice.timestamp <= item.value.finishedThrough) return;
      if (item.value.finished && notice.timestamp <= item.value.finished.timestamp) return;
      await putEntry($, "spawn", item.key, old => ({ ...old!, finished: notice }));
      await joinFinished($, item.key);
    });
    return result;
  });
  on("session.append", async ($, e, next) => {
    const result = await next(e);
    await safely($, async () => {
      const notice = workflowDelivery(e);
      if (!notice) return;
      await receiveWorkflow($, notice, e.uuid);
    });
    return result;
  });
  on("session.end", async ($, e, next) => {
    const deadline = await $.clock.now() + 1500;
    await safely($, async () => {
      await endBatch($);
      const s = await session($);
      await bind($, {...s, ended: true, mainActive: false});
      await reconcileParents($);
      // Print-mode shutdown discards timers. Attempt only already prepared
      // parent closes here; retain failed effects for ordinary durable recovery.
      const prefix = `session/${s.id}/op/`;
      for (const key of await $.store.keys()) {
        if (!key.startsWith(prefix) || deadline - await $.clock.now() < 160) continue;
        const op = await $.store.get(key) as KataOperation;
        if (!op.ack && op.kind === "parent-close") await attempt($,op,100,deadline);
      }
    });
    return next(e);
  });
  on("command.run", { command: "kata" }, async ($, e) => {
    try {
      const args = e.args.trim().split(/\s+/);
      if (args[0] === "bind") {
        if (
          args.length !== 2 ||
          !/^[A-Za-z0-9][A-Za-z0-9._#-]*$/.test(args[1]!)
        )
          return { text: "Usage: /kata bind <ref>" };
        const d = await show($, args[1]!);
        if (d.issue.status === "closed")
          return { text: "Kata parent is closed." };
        await adoptParent($, args[1]!);
      } else if (args[0] === "unbind")
        await parentLock(async () => {
          const s = await session($);
          await bind($, { ...s, parent: null, unbound: true });
        });
      else if (args[0]) return { text: "Usage: /kata [bind <ref>|unbind]" };
      const parent = (await session($))?.parent,
        list = await entries($);
      const native = await $.agent.list();
      return {
        text: [
          parent ? `Kata parent: ${parent}` : "kata: unbound",
          ...list.map(
            ({ value }) =>
              `${value.ref ?? "(pending)"} · ${value.teammate} · ${native.find((a) => a.id === value.agentId)?.status ?? value.status}`,
          ),
        ].join("\n"),
      };
    } catch {
      return { text: "kata: unreachable; binding unchanged" };
    }
  });
};
