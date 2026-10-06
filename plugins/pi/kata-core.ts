import { createHash } from "node:crypto";
import path from "node:path";
import { appendFileSync, realpathSync } from "node:fs";

// Canonical shared source. scripts/vendor-core.ts copies this file into each
// self-contained plugin; host adapters own their event/schema/identity APIs.

export interface CoreHost {
	exec(file: string, args: string[], options: { cwd: string; timeout: number }): Promise<{ code: number; stdout: string; stderr?: string; killed?: boolean }>;
	appendEntry(type: string, data: unknown): void;
	getSessionName?(): string | undefined;
	isMain?(ctx: any): boolean;
	allowUI?(ctx: any): boolean;
	isDelegated?(ref: string): boolean;
	beforeReconcile?(): Promise<void>;
	delegatedRunning?(): boolean;
}
export interface CoreOptions {
	namespace: string;
	executable: string;
	debugFile?: string;
	explicitRef?(): string | undefined;
}

export type Status = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export type Task = { ref: string; content: string; phase: string; status: Status; blocker?: string; delegated?: boolean };
export type Binding = { parent: string; workspace: string; sessionId?: string; auto?: boolean };
export type Plan = Partial<Binding> & { tasks: Task[]; local?: boolean };
export type Change = { message?: string; evidence?: string[]; reason?: string; many?: boolean; remove?: boolean };
export function sessionKey(file: string, cwd: string): string {
	const absolute = path.resolve(cwd, file);
	try { return realpathSync(absolute); }
	catch { try { return path.join(realpathSync(path.dirname(absolute)), path.basename(absolute)); } catch { return absolute; } }
}

export function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

export const OPEN: ReadonlySet<Status> = new Set(["pending", "in_progress", "blocked"]);
const MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[/]", completed: "[x]", abandoned: "[~]", blocked: "[!]" };

export const DESCRIPTION = `Track multi-step work as a todo list stored in Kata. Tasks are identified by verbatim content (or Kata ref), NEVER generated IDs. Unique, stable task/phase names; lost text: view, NEVER guess.
Before work, init for 3+ steps, requested task sets, or new instructions. MUST list EVERY user item separately; NEVER omit or remember leftovers.
After each change: with no active task the earliest pending starts (phase order). Blocked NEVER starts automatically; unblock returns pending. Mark done immediately; follow phase order.
External waits (user/agent/service): block with a reason; it suppresses the stop reminder and starts the next pending task.
NEVER call todo alone: init with first work; done/start with next action.

Kata specifics:
- Each task is a Kata child issue of one parent issue. On init pass \`ref\` with the Kata issue this plan serves (search first: kata search "<terms>" --agent); otherwise KATA_REF, the session's existing parent, or a new parent titled by \`message\` is used.
- done closes the issue. Kata requires \`evidence\` (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a \`message\` of 40+ characters saying what changed and how it was verified. Unverified work: block it instead.
- drop/rm take the reason in \`message\`.
- drop and rm close as wontfix (Kata never deletes). Automatic session parents close from their children’s Kata-recorded evidence once all work has settled. Explicit/claimed parents remain yours to close. Outside Kata projects, todo keeps a session-local plan.`;

export function digest(...parts: string[]): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

type ShellWord = { value: string; start: number; end: number };
// Inspect command positions only. Quoted arguments and heredoc bodies are data;
// this lexer never infers whether a test/commit command proves completion.
export function kataCommands(command: string, configuredExecutable = "kata"): { executable: ShellWord; words: ShellWord[] }[] {
	const segments: ShellWord[][] = [[]];
	let i = 0, heredoc: string | undefined, wantDelimiter = false;
	while (i < command.length) {
		if (command[i] === "\n" && heredoc) {
			const end = command.indexOf(`\n${heredoc}`, i);
			if (end < 0) break;
			i = command.indexOf("\n", end + 1);
			if (i < 0) break;
			heredoc = undefined;
		}
		if (/\s/.test(command[i])) { if (command[i] === "\n") segments.push([]); i++; continue; }
		if (command[i] === "#") { const end = command.indexOf("\n", i); if (end < 0) break; i = end; continue; }
		if (";&|()".includes(command[i])) { segments.push([]); i++; continue; }
		if (command.slice(i, i + 2) === "<<") { i += command[i + 2] === "-" ? 3 : 2; wantDelimiter = true; continue; }
		const start = i;
		let value = "", quote = "";
		while (i < command.length) {
			const char = command[i];
			if (!quote && /[\s;&|()]/.test(char)) break;
			if (char === "\\" && quote !== "'") { value += command[i + 1] || ""; i += 2; continue; }
			if (char === quote) { quote = ""; i++; continue; }
			if (!quote && (char === "'" || char === '"')) { quote = char; i++; continue; }
			value += char; i++;
		}
		if (wantDelimiter) { heredoc = value; wantDelimiter = false; continue; }
		segments.at(-1)!.push({ value, start, end: i });
	}
	const commands: { executable: ShellWord; words: ShellWord[] }[] = [];
	for (const segment of segments) {
		let j = 0;
		while (j < segment.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[j].value) || ["if", "then", "elif", "do", "else", "!", "command", "env", "time"].includes(segment[j].value))) j++;
		const executable = segment[j];
		if (executable && (path.basename(executable.value) === "kata" || executable.value === configuredExecutable || ["$KATA_OMP_EXECUTABLE", "${KATA_OMP_EXECUTABLE}", "$KATA_PI_EXECUTABLE", "${KATA_PI_EXECUTABLE}"].includes(executable.value))) commands.push({ executable, words: segment.slice(j + 1) });
	}
	return commands;
}

const VALUE_OPTIONS = new Set(["--body", "--body-file", "--message", "-m", "--comment", "--evidence", "--test", "--commit", "--pr", "--reviewed", "--reason", "--idempotency-key", "--parent", "--related", "--blocked-by", "--blocks", "--meta", "--owner", "--label", "--priority", "--if-match", "--if-value", "--workspace", "--project", "--teammate", "--as", "--for", "--format", "--daemon"]);
export function shellOptions(words: ShellWord[]) {
	const options = new Map<string, ShellWord[]>(), occurrences = new Map<string, ShellWord[][]>(), args: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		if (word.value === "--") { args.push(...words.slice(i + 1).map(w => w.value)); break; }
		const flag = word.value.split("=")[0];
		if (word.value.startsWith("-")) {
			if (VALUE_OPTIONS.has(flag) && !word.value.includes("=") && words[i + 1]) options.set(flag, [word, words[++i]]);
			else options.set(flag, [word]);
			occurrences.set(flag, [...(occurrences.get(flag) || []), options.get(flag)!]);
		} else args.push(word.value);
	}
	const value = (key: string) => { const pair = options.get(key); return pair?.[1]?.value ?? pair?.[0]?.value.slice(key.length + 1); };
	return { options, occurrences, args, value };
}


export function teammateFor(id: string): string {
	const base = id.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "") || "agent";
	return `${base.slice(0, 57)}-${digest(id).slice(0, 6)}`;
}

export function delegateCommand(command: string, executable: string, teammate: string, binding?: Binding): string {
	const edits: { start: number; end: number; value: string }[] = [];
	for (const invocation of kataCommands(command, executable)) {
		const parsed = shellOptions(invocation.words);
		if (parsed.options.has("--as")) throw new Error("Kata subagents keep the current actor. Use your assigned --teammate; --as is not permitted.");
		for (const previous of parsed.occurrences.get("--teammate") ?? []) edits.push({ start: previous[0].start, end: previous.at(-1)!.end, value: "" });
		let flags = ` --teammate ${quote(teammate)}`;
		if (binding) {
			if (!parsed.options.has("--workspace")) flags += ` --workspace ${quote(binding.workspace)}`;
			if (!parsed.options.has("--project")) flags += ` --project ${quote(binding.parent.split("#")[0])}`;
		}
		edits.push({ start: invocation.executable.end, end: invocation.executable.end, value: flags });
	}
	for (const edit of edits.sort((a, b) => b.start - a.start)) command = command.slice(0, edit.start) + edit.value + command.slice(edit.end);
	return command;
}

export function delegateContext(executable: string, id: string, ref: string, teammate: string, binding: Binding): string {
	const command = `${quote(executable)} --workspace ${quote(binding.workspace)} --project ${quote(binding.parent.split("#")[0])} --teammate ${quote(teammate)}`;
	return `You are subagent ${id}. Your Kata issue is ${ref}; your teammate is ${teammate}. Keep the existing actor and use this issue instead of inherited KATA_REF. Track attention on your own issue. When verified, YOU must run: ${command} close ${quote(ref)} --done --message '<describe this task and its verification in at least 40 characters>' --evidence '<typed evidence for your actual verification>'. If unfinished, leave it open and explain what remains.`;
}

export function phasesOf(tasks: Task[]): { name: string; tasks: Task[] }[] {
	const phases: { name: string; tasks: Task[] }[] = [];
	for (const task of tasks) {
		let phase = phases.find(p => p.name === task.phase);
		if (!phase) phases.push((phase = { name: task.phase, tasks: [] }));
		phase.tasks.push(task);
	}
	return phases;
}

export function render(plan: Plan): string {
	if (!plan.parent && !plan.local) return "No todo plan. Use todo op=init.";
	if (plan.tasks.length === 0) return `Kata parent ${plan.parent}: no tasks.`;
	const done = plan.tasks.filter(t => t.status === "completed").length;
	const lines = [`${plan.local ? "Session-local plan" : `Kata parent ${plan.parent}`}: ${done}/${plan.tasks.length} done`];
	for (const phase of phasesOf(plan.tasks)) {
		lines.push(`${phase.name}:`);
		for (const t of phase.tasks) lines.push(`  ${MARK[t.status]} ${t.content} (${t.ref})${t.blocker ? ` — blocked: ${t.blocker}` : ""}`);
	}
	return lines.join("\n");
}

export function createKataCore(host: CoreHost, options: CoreOptions) {
	const namespace = options.namespace;
	const STATE_ENTRY = `io.kata.${namespace}.parent`;
	const SNAPSHOT_ENTRY = `io.kata.${namespace}.state`;
	const WIDGET = `${namespace}-kata`;
	const MAX_REMINDERS = 3;
	const main = (ctx: any) => host.isMain?.(ctx) ?? true;
	let plan: Plan = { tasks: [] };
	let queue: Promise<unknown> = Promise.resolve();
	let scope: "unknown" | "bound" | "local" = "unknown";
	let currentId: string | undefined;
	let currentCtx: any;
	let reminders = 0;
	let progressed = true;
	let cache: { id?: string; contract?: string; inbox?: string; pending?: Promise<void> } = {};
	const autoParents = new Map<string, Binding>();
	const retries = new Map<string, { task: Task; to: Status; change: Change; cwd: string; at: number }>();
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSnapshot: string | undefined;
	function persist() {
		if (!currentId || !main(currentCtx)) return;
		const data = { version: 1, sessionId: currentId,
			plan: structuredClone(plan), autoParents: [...autoParents.values()], retries: [...retries.entries()] };
		const encoded = JSON.stringify(data);
		if (encoded === lastSnapshot) return;
		host.appendEntry(SNAPSHOT_ENTRY, data);
		lastSnapshot = encoded;
	}
	function debug(error: unknown) {
		if (!options.debugFile) return;
		try { appendFileSync(options.debugFile, `${new Date().toISOString()} ${String(error)}\n`); } catch { /* Debugging must never interrupt work. */ }
	}
	async function bounded<T>(promise: Promise<T>, ms = 250): Promise<T | undefined> {
		let timer: ReturnType<typeof setTimeout>;
			try { return await Promise.race([promise.catch(error => { debug(error); return undefined; }), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
		finally { clearTimeout(timer!); }
	}

	async function kata(args: string[], cwd: string, timeout = 1000): Promise<string> {
		const result = await host.exec(options.executable, [...args, "--workspace", path.resolve(cwd)], { cwd, timeout });
		if (result.code !== 0 || result.killed) {
			const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
			throw new Error(`kata ${args[0]} failed${detail ? `: ${detail}` : ""}`);
		}
		return result.stdout;
	}

	// Serialize every plan mutation: tool calls, /todo, and session reloads.
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn);
		queue = run.catch(() => undefined);
		return run;
	}

	async function actor(cwd: string): Promise<string> {
		if (process.env.KATA_AUTHOR || process.env.USER) return (process.env.KATA_AUTHOR || process.env.USER)!;
		const result = await host.exec("git", ["config", "user.name"], { cwd, timeout: 1000 });
		return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : "anonymous";
	}

	// A successful claim is required for unowned tasks. Already-owned tasks
	// require both the actor and teammate, since delegates share an actor.
	async function owned(ref: string, cwd: string, mayClaim = false, allowClosed = false): Promise<any> {
		let issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
		const currentActor = await actor(cwd);
		const teammate = process.env.KATA_TEAMMATE || "";
		if (issue?.status !== "open" && !(allowClosed && issue?.status === "closed")) throw new Error(`Kata issue ${ref} is closed or unavailable; no work metadata was written.`);
		const assignedTeammate = issue.metadata?.teammate || "";
		if (assignedTeammate !== teammate && (issue.owner || assignedTeammate)) {
			throw new Error(`Kata issue ${ref} belongs to teammate ${assignedTeammate || "(none)"}, not ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!issue.owner && mayClaim) {
			// Never swallow a claim failure, including an ownership race.
			await kata(["claim", ref, "--if-unowned"], cwd);
			issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
			if (issue.status !== "open" || issue.owner !== currentActor) throw new Error(`Kata issue ${ref} is no longer owned by ${currentActor}; no work metadata was written.`);
			if (teammate && !issue.metadata?.teammate) {
				await kata(["meta", "set", ref, "teammate", teammate, "--if-absent", "--if-match", String(issue.revision)], cwd);
				issue = JSON.parse(await kata(["show", ref, "--json"], cwd)).issue;
			}
		}
		if ((issue.status !== "open" && !(allowClosed && issue.status === "closed")) || issue.owner !== currentActor || (issue.metadata?.teammate || "") !== teammate) {
			throw new Error(`Kata issue ${ref} is not owned by actor ${currentActor} and teammate ${teammate || "(none)"}; no work metadata was written.`);
		}
		if (!Number.isInteger(issue.revision) || issue.revision < 0) throw new Error(`Kata issue ${ref} has no valid metadata revision; no work metadata was written.`);
		return issue;
	}

	// Keep the decision snapshot through every key write. A fresh lookup may
	// validate it, but must not rebase the intended transition onto new state.
	async function work(ref: string, key: string, value: string | undefined, cwd: string, expected: any, session?: string): Promise<any> {
		const issue = await owned(ref, cwd);
		const meta = expected.metadata ?? {};
		if (issue.revision !== expected.revision || Object.hasOwn(issue.metadata ?? {}, key) !== Object.hasOwn(meta, key) || issue.metadata?.[key] !== meta[key]) {
			throw new Error(`Kata metadata changed for ${ref}; no further work metadata was written.`);
		}
		if (session && meta["work.attention_session"] !== session) throw new Error(`Kata attention session changed for ${ref}; no work metadata was written.`);
		const exists = Object.hasOwn(meta, key);
		if ((!exists && value === undefined) || meta[key] === value) return expected;
		const args = value === undefined ? ["meta", "unset", ref, key] : ["meta", "set", ref, key, JSON.stringify(value)];
		args.push("--if-match", String(expected.revision));
		if (exists) args.push("--if-value", JSON.stringify(meta[key]), "--json-value");
		else args.push("--if-absent", "--json-value");
		await kata(args, cwd);
		const changed = { ...meta };
		if (value === undefined) delete changed[key];
		else changed[key] = value;
		return { ...expected, revision: expected.revision + 1, metadata: changed };
	}

	// -------------------------------------------------------------- plan state

	async function load(cwd: string): Promise<void> {
		if (plan.local) return;
		if (!plan.parent) {
			plan.tasks = [];
			return;
		}
		const shown = JSON.parse(await kata(["show", plan.parent, "--json"], cwd));
		const children = (shown.children ?? []) as any[];
		plan.tasks = children
			.filter(c => typeof c?.metadata?.["todo.phase"] === "string" && c.metadata["todo.removed"] !== true)
			.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
			.map(c => {
				const meta = c.metadata;
				let status: Status;
				if (c.status === "closed") status = c.closed_reason === "wontfix" || meta["todo.status"] === "abandoned" ? "abandoned" : "completed";
				else status = ["in_progress", "blocked"].includes(meta["todo.status"]) ? meta["todo.status"] : "pending";
				return {
					ref: c.qualified_id || `${plan.parent!.split("#")[0]}#${c.short_id}`,
					content: c.title,
					phase: meta["todo.phase"],
					delegated: !!(meta["omp.subagent_id"] || meta["pi.subagent_id"]) && (meta.teammate || "") !== (process.env.KATA_TEAMMATE || ""),
					status,
					blocker: status === "blocked" ? meta["work.attention_msg"] : undefined,
				};
			});
	}

	function refresh(ctx: any) {
		if (!main(ctx) || host.allowUI?.(ctx) === false) return;
		const ui = ctx?.ui;
		if (!ui?.setWidget) return;
		if (!plan.parent || plan.tasks.length === 0) {
			ui.setWidget(WIDGET, undefined);
			return;
		}
		const done = plan.tasks.filter(t => t.status === "completed").length;
		const active = plan.tasks.find(t => t.status === "in_progress");
		const blocked = plan.tasks.filter(t => t.status === "blocked").length;
		const line = `Kata ${plan.parent} · ${done}/${plan.tasks.length} done${blocked ? ` · ${blocked} blocked` : ""}${active ? ` · ▶ ${active.content}` : ""}`;
		ui.setWidget(WIDGET, [line]);
	}

	async function probe(cwd: string): Promise<boolean> {
		if (scope !== "unknown") return scope === "bound";
		try { await kata(["list", "--limit", "1", "--json"], cwd); scope = "bound"; return true; }
		catch (error) {
			if (/project_not_initialized|no \.kata\.toml|no project|not bound|not.*kata project|project.*not.*(found|resolved)|could not resolve project/i.test(String(error))) { scope = "local"; return false; }
			throw error;
		}
	}

	async function pin(ref: string, cwd: string): Promise<string> {
		const shown = JSON.parse(await kata(["show", ref, "--json"], cwd));
		if (ref.includes("#")) return ref;
		const projects = JSON.parse(await kata(["projects", "list", "--json"], cwd)).projects;
		const project = projects.find((p: any) => p.id === shown.issue.project_id);
		if (!project) throw new Error("Kata issue project could not be pinned.");
		return `${project.name}#${shown.issue.short_id}`;
	}

	async function sessionBinding(ctx: any): Promise<Binding | undefined> {
		const id = ctx.sessionManager?.getSessionId?.();
		if (!id) return;
		const list = JSON.parse(await kata(["list", "--status", "all", "--meta", `${namespace}.session_id=${id}`, "--label", `${namespace}-session`, "--limit", "2", "--json"], ctx.cwd)).issues ?? [];
		const candidates = list.filter((issue: any) => issue.metadata?.[`${namespace}.auto_parent`] === true && issue.metadata?.[`${namespace}.session_id`] === id && sessionKey(issue.metadata?.[`${namespace}.workspace`] || ".", ctx.cwd) === sessionKey(ctx.cwd, ctx.cwd));
		if (candidates.length === 1) return { parent: candidates[0].qualified_id, workspace: candidates[0].metadata[`${namespace}.workspace`], sessionId: id, auto: true };
	}

	async function bind(ctx: any, explicit = options.explicitRef?.() ?? process.env.KATA_REF) {
		if (!main(ctx)) return;
		const id = ctx.sessionManager?.getSessionId?.();
		currentId = id;
		lastSnapshot = undefined;
		currentCtx = ctx;
		plan = { tasks: [] };
		scope = "unknown";
		retries.clear(); autoParents.clear();
		if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
		let snapshot: any;
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
			if (entry?.type === "custom" && entry.customType === SNAPSHOT_ENTRY && entry.data?.version === 1 && entry.data.sessionId === id) snapshot = entry.data;
		}
		if (snapshot) {
			for (const binding of snapshot.autoParents ?? []) autoParents.set(binding.parent, binding);
			for (const [ref, pending] of snapshot.retries ?? []) retries.set(ref, pending);
			if (retries.size) scheduleRetry();
			if (snapshot.plan?.local && !explicit) plan = structuredClone(snapshot.plan);
		}
		if (!await probe(ctx.cwd)) { await drainRetries(); refresh(ctx); return; }
		let stored: any = snapshot?.plan?.parent ? snapshot.plan : undefined;
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
			if (entry?.type === "custom" && entry.customType === STATE_ENTRY && typeof entry.data?.parent === "string" && (!entry.data.sessionId || entry.data.sessionId === id)) stored = entry.data;
		}
		if (!explicit && !stored && id) stored = await sessionBinding(ctx);
		const parent = explicit || stored?.parent;
		if (parent) {
			const workspace = explicit ? path.resolve(ctx.cwd) : stored.workspace || path.resolve(ctx.cwd);
			const qualified = await pin(parent, workspace);
			const issue = JSON.parse(await kata(["show", qualified, "--json"], workspace)).issue;
			const auto = !explicit && stored?.auto !== false && issue.metadata?.[`${namespace}.auto_parent`] === true && issue.metadata?.[`${namespace}.session_id`] === id;
			setParent({ parent: qualified, workspace, sessionId: id, auto });
			await load(workspace);
		}
		await drainRetries();
		refresh(ctx);
	}

	function setParent(binding: Binding) {
		if (!binding.auto) autoParents.delete(binding.parent);
		if (plan.parent === binding.parent && plan.workspace === binding.workspace && plan.auto === binding.auto) return;
		plan = { ...binding, tasks: plan.parent === binding.parent ? plan.tasks : [] };
		if (binding.auto) autoParents.set(binding.parent, binding);
		host.appendEntry(STATE_ENTRY, binding);
	}

	async function adopt(ref: string, ctx: any, workspace = ctx.cwd) {
		const parent = await pin(ref, workspace);
		if (plan.auto && plan.parent && plan.parent !== parent) {
			await kata(["edit", plan.parent, "--parent", parent], plan.workspace!);
		}
		if (plan.parent === parent) autoParents.delete(parent);
		setParent({ parent, workspace: path.resolve(workspace), sessionId: ctx.sessionManager?.getSessionId?.(), auto: false });
		await load(workspace);
	}

	// ------------------------------------------------------------- transitions

	async function create(phase: string, content: string, cwd: string): Promise<void> {
		const out = JSON.parse(
			await kata(
				[
					"create", content,
					"--parent", plan.parent!,
					"--project", plan.parent!.split("#")[0],
					"--body", `Todo task in phase "${phase}".`,
					"--meta", `todo.phase=${phase}`,
					"--meta", "todo.status=pending",
					"--idempotency-key", `${namespace}-kata:${digest(plan.parent!, phase, content)}`,
					// Sibling tasks often read alike ("write x" / "verify x"); they are
					// deliberate plan items, so skip the look-alike soft-block.
					"--force-new",
					"--json",
				],
				cwd,
			),
		);
		const issue = out?.issue;
		if (typeof issue?.short_id !== "string") throw new Error("kata create returned no short_id");
		// An idempotent replay can return a task closed earlier; re-adding reopens it.
		if (issue.status === "closed") {
			await kata(["reopen", `${plan.parent!.split("#")[0]}#${issue.short_id}`], cwd);
			await kata(["meta", "set", `${plan.parent!.split("#")[0]}#${issue.short_id}`, "todo.status", "pending"], cwd);
		}
		if (issue.metadata?.["todo.removed"] === true) await kata(["meta", "unset", `${plan.parent!.split("#")[0]}#${issue.short_id}`, "todo.removed"], cwd);
	}

	async function transition(task: Task, to: Status, change: Change, cwd: string): Promise<void> {
		const from = task.status;
		if (from === to && to !== "blocked") return;
		const ref = task.ref;
		if (task.delegated || host.isDelegated?.(ref)) {
			throw new Error(`Kata task ${ref} is delegated. Its subagent must manage and close it; use view to refresh its state.`);
		}
		if (task.ref.startsWith("local-")) { task.status = to; task.blocker = to === "blocked" ? change.reason || "Blocked in the local plan." : undefined; return; }
		let decision: any;
		if (!OPEN.has(from) && to === "in_progress") {
			// Explicit start may restart only this actor's and teammate's closed
			// task. Kata reopen has no CAS flag; validate its revision and owner
			// again afterward before any guarded work metadata is written.
			const closed = await owned(ref, cwd, false, true);
			if (closed.status !== "closed") throw new Error(`Kata task ${ref} changed before restart.`);
			await kata(["reopen", ref], cwd);
			const reopened = await owned(ref, cwd);
			if (reopened.revision !== closed.revision + 1) throw new Error(`Kata task ${ref} changed during restart; no work metadata was written.`);
			decision = reopened;
		} else if (to === "in_progress" || to === "blocked" || (to === "pending" && from === "blocked")) decision = await owned(ref, cwd, true);
		switch (to) {
			case "in_progress":
				decision = await work(ref, "work.attention", "ok", cwd, decision);
				if (from === "blocked") decision = await work(ref, "work.attention_msg", undefined, cwd, decision);
				await kata(["meta", "set", ref, "todo.status", "in_progress"], cwd);
				break;
			case "pending":
				if (from === "blocked") {
					decision = await work(ref, "work.attention", "ok", cwd, decision);
					decision = await work(ref, "work.attention_msg", undefined, cwd, decision);
				}
				await kata(["meta", "set", ref, "todo.status", "pending"], cwd);
				break;
			case "blocked": {
				const reason = change.reason || "Blocked in the todo plan.";
				decision = await work(ref, "work.attention", "stuck", cwd, decision);
				decision = await work(ref, "work.attention_msg", reason, cwd, decision);
				await kata(["meta", "set", ref, "todo.status", "blocked"], cwd);
				task.blocker = reason;
				break;
			}
			case "completed": {
				const message = change.message ? `${change.message} (task: ${task.content}; ${task.ref})` : "";
				if (!change.evidence?.length || (change.message || "").replace(/\s+/g, " ").trim().length < 40) {
					throw new Error(
						`Kata needs evidence and a 40+ character message to close ${ref} ("${task.content}") as done: pass evidence (commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>) and a message saying what changed and how it was verified. If it is not verified, block it instead.`,
					);
				}
				const args = ["close", ref, "--done", "--message", message];
				for (const e of change.evidence) args.push("--evidence", e);
				await closeTask(args, task, to, change, cwd);
				await kata(["meta", "set", ref, "todo.status", "completed"], cwd);
				break;
			}
			case "abandoned":
				await closeTask(["close", ref, "--wontfix", "--message", wontfix("Dropped", task, change)], task, to, change, cwd);
				await kata(["meta", "set", ref, "todo.status", "abandoned"], cwd);
				break;
		}
		task.status = to;
		if (!change.remove) retries.delete(ref);
		if (to !== "blocked") task.blocker = undefined;
	}

	// Kata wants 60+ characters for wontfix; the task and plan context supply
	// that around the caller's reason.
	function wontfix(verb: string, task: Task, change: Change): string {
		const why = change.message || change.reason || "no longer needed";
		return `${verb} from the todo plan under ${plan.parent}: "${task.content}". Reason: ${why}. This task was intentionally retired from the plan without asserting completion.`;
	}

	async function remove(task: Task, change: Change, cwd: string): Promise<void> {
		if (plan.local) { plan.tasks = plan.tasks.filter(t => t !== task); return; }
		if (OPEN.has(task.status)) {
			await transition(task, "abandoned", { ...change, remove: true }, cwd);
		}
		await kata(["meta", "set", task.ref, "todo.removed", "true", "--json-value"], cwd);
		retries.delete(task.ref);
	}

	// With no active task, start the earliest pending one (phase order).
	async function advance(cwd: string): Promise<void> {
		if (plan.tasks.some(t => t.status === "in_progress")) return;
		const next = phasesOf(plan.tasks).flatMap(p => p.tasks).find(t => t.status === "pending");
		if (next) await transition(next, "in_progress", {}, cwd);
	}

	function resolve(target: string | undefined, phase: string | undefined, fallback: "active" | "none"): Task[] {
		if (phase && !target) {
			const tasks = plan.tasks.filter(t => t.phase === phase);
			if (tasks.length === 0) throw new Error(`No phase "${phase}". Phases: ${phasesOf(plan.tasks).map(p => p.name).join(", ") || "none"}`);
			return tasks;
		}
		if (!target) {
			const active = plan.tasks.find(t => t.status === "in_progress");
			if (fallback === "active" && active) return [active];
			throw new Error("Name the task (verbatim content or Kata ref).");
		}
		const exact = plan.tasks.filter(t => t.content === target || t.ref === target || t.ref.split("#")[1] === target);
		if (exact.length === 1) return exact;
		const needle = target.toLowerCase();
		const fuzzy = plan.tasks.filter(t => t.content.toLowerCase().includes(needle));
		if (fuzzy.length === 1) return fuzzy;
		throw new Error(
			`${fuzzy.length ? "Ambiguous" : "No"} task "${target}". Tasks: ${plan.tasks.map(t => `"${t.content}"`).join(", ") || "none"}`,
		);
	}

	async function ensureParent(params: any, ctx: any): Promise<string | undefined> {
		if (!await probe(ctx.cwd)) { plan.local = true; return; }
		const explicit = options.explicitRef?.() ?? process.env.KATA_REF;
		if (explicit && (!plan.parent || plan.parent.split("#").pop() !== explicit.split("#").pop())) await adopt(explicit, ctx);
		else if (params.ref && !explicit) await adopt(params.ref, ctx);
		// A Pi child may establish the session parent before the lead uses todo.
		if (!plan.parent && !explicit && !params.ref) {
			const recovered = await sessionBinding(ctx);
			if (recovered) { setParent(recovered); await load(recovered.workspace); }
		}
		if (plan.parent) { await reopenParent(); return plan.parent; }
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Kata needs a real session id before creating an automatic parent.");
		const title = (params.message as string | undefined)?.trim() || host.getSessionName?.() || `Todo plan: ${(params.list ?? []).map((p: any) => p.phase).join(", ") || "tasks"}`.slice(0, 120);
		const cwd = path.resolve(ctx.cwd);
		const out = JSON.parse(await kata(["create", title, "--body", `Todo plan from ${namespace} session ${sessionId}.`, "--meta", `${namespace}.session_id=${sessionId}`, "--meta", `${namespace}.workspace=${cwd}`, "--label", `${namespace}-session`, "--idempotency-key", `${namespace}-session:${sessionId}`, "--force-new", "--json"], cwd));
		if (!out.issue?.short_id || !out.event?.project_name) throw new Error("kata create returned no parent identity");
		const ref = `${out.event.project_name}#${out.issue.short_id}`;
		// Create only accepts string metadata. Type the authority marker before
		// attention setup so a failed claim can still be recovered by session.
		await kata(["meta", "set", ref, `${namespace}.auto_parent`, "true", "--json-value"], cwd);
		setParent({ parent: ref, workspace: cwd, sessionId, auto: true });
		const claimed = await owned(ref, cwd, true);
		await work(ref, "work.attention", "ok", cwd, claimed);
		return ref;
	}

	async function reopenParent() {
		if (!plan.parent || !plan.auto) return;
		const shown = JSON.parse(await kata(["show", plan.parent, "--json"], plan.workspace!));
		if (shown.issue.status === "closed") await kata(["reopen", plan.parent], plan.workspace!);
	}

	class DeferredClose extends Error {}
	function scheduleRetry() {
		if (retryTimer) return;
		retryTimer = setTimeout(() => { retryTimer = undefined; void serial(drainRetries).catch(debug); }, 60_100);
		retryTimer.unref?.();
	}
	async function closeTask(args: string[], task: Task, to: Status, change: Change, cwd: string) {
		try { await kata(args, cwd); }
		catch (error) {
			if (!/throttl|sibling.*(burst|rate)|too many.*clos/i.test(String(error))) throw error;
			retries.set(task.ref, { task: { ...task }, to, change: { ...change }, cwd, at: Date.now() + 60_000 });
			persist();
			scheduleRetry();
			throw new DeferredClose(`Kata deferred closing "${task.content}" under its sibling throttle. It remains open and will retry after 60 seconds.`);
		}
	}
	async function drainRetries() {
		for (const [ref, pending] of retries) {
			if (pending.at > Date.now()) continue;
			try {
				const current = JSON.parse(await kata(["show", ref, "--json"], pending.cwd)).issue;
				if (current.status === "closed") {
					if (pending.change.remove) await kata(["meta", "set", ref, "todo.removed", "true", "--json-value"], pending.cwd);
					retries.delete(ref); continue;
				}
				await owned(ref, pending.cwd);
				await transition(pending.task, pending.to, pending.change, pending.cwd);
				if (pending.change.remove) await kata(["meta", "set", ref, "todo.removed", "true", "--json-value"], pending.cwd);
				retries.delete(ref);
				if (plan.tasks.some(task => task.ref === ref)) { await load(plan.workspace!); await advance(plan.workspace!); }
			} catch (error) { debug(error); }
		}
		if (retries.size) scheduleRetry();
		persist();
		await reconcile();
	}

	function proofArgs(items: any[]): string[] {
		const values = new Set<string>();
		for (const item of items) {
			const key: Record<string, string> = { commit: "sha", pr: "url", test: "command", external: "account", "no-change-audit": "rationale", "duplicate-of": "issue_ref", "superseded-by": "issue_ref" };
			const value = item[key[item.type]];
			if (typeof value === "string" && value.trim()) values.add(`${item.type}:${value}`);
			else if (item.type === "reviewed-paths" && Array.isArray(item.paths)) for (const file of item.paths) { if (typeof file !== "string" || !file.trim()) throw new Error("Malformed Kata evidence"); values.add(`reviewed-paths:${file}`); }
			else throw new Error("Malformed or unknown Kata evidence");
		}
		return [...values].flatMap(value => ["--evidence", value]);
	}

	const delegatedRunning = () => host.delegatedRunning?.() ?? false;
	async function reconcile() {
		await host.beforeReconcile?.();
		for (const binding of autoParents.values()) {
			const { parent, workspace } = binding;
			try {
				if (delegatedRunning()) return;
				const initial = JSON.parse(await kata(["show", parent, "--json"], workspace));
				if (initial.issue.status === "closed" || initial.issue.metadata?.[`${namespace}.auto_parent`] !== true || initial.issue.metadata?.[`${namespace}.session_id`] !== binding.sessionId) continue;
				if (!initial.children?.length || initial.children.some((c: any) => c.status !== "closed")) continue;
				const evidence: any[] = [];
				const audits = new Map<string, any[]>();
				let projects: any[] | undefined;
				for (const child of initial.children) {
					if (child.closed_reason === "wontfix") continue;
					let project = child.qualified_id?.split("#")[0];
					if (!project && child.project_id === initial.issue.project_id) project = parent.split("#")[0];
					if (!project) {
						projects ??= JSON.parse(await kata(["projects", "list", "--json"], workspace)).projects;
						project = projects!.find(p => p.id === child.project_id)?.name;
					}
					if (!project) throw new Error("Kata child project unavailable");
					if (!audits.has(project)) audits.set(project, JSON.parse(await kata(["audit", "closes", "--project", project, "--json"], workspace)).rows);
					const rows = audits.get(project)!;
					const row = rows.filter((r: any) => r.issue === child.short_id).sort((a: any, b: any) => b.event_id - a.event_id)[0];
					if (!row?.event_id) throw new Error("Kata child close event unavailable");
					const page = JSON.parse(await kata(["events", "--project", project, "--after", String(row.event_id - 1), "--limit", "1", "--json"], workspace));
					const event = page.events?.[0];
					if (page.reset_required || event?.event_id !== row.event_id || event.type !== "issue.closed" || event.issue_uid !== child.uid || Date.parse(event.payload?.closed_at) !== Date.parse(child.closed_at) || !Array.isArray(event.payload?.evidence)) throw new Error("Kata current child evidence unavailable");
					evidence.push(...event.payload.evidence);
				}
				const proof = proofArgs(evidence);
				if (!proof.length) throw new Error("Kata child close evidence union is empty");
				const final = JSON.parse(await kata(["show", parent, "--json"], workspace));
				if (final.issue.status === "closed" || delegatedRunning()) continue;
				if (final.issue.revision !== initial.issue.revision || final.children?.length !== initial.children.length || final.children.some((c: any) => c.status !== "closed" || !initial.children.some((old: any) => old.uid === c.uid && old.revision === c.revision))) continue;
				await kata(["close", parent, "--done", "--if-match", String(final.issue.revision), "--idempotency-key", `${namespace}-parent-close:${parent}:${final.issue.revision}`, "--message", `${namespace.toUpperCase()} session ${binding.sessionId}: all ${final.children.length} child issues are closed in Kata and delegated work has settled. Evidence is the union of their current Kata-recorded close events.`, ...proof], workspace);
			} catch (error) {
				debug(error);
				if (/throttl|sibling.*(burst|rate)|too many.*clos/i.test(String(error))) scheduleRetry();
				try { const live = JSON.parse(await kata(["show", parent, "--json"], workspace)); if (live.issue.status === "open") await kata(["label", "add", parent, "needs-review"], workspace); } catch (error) { debug(error); }
			}
		}
	}

	// ---------------------------------------------------------------------- ops

	async function apply(params: any, ctx: any): Promise<string> {
		currentCtx = ctx;
		currentId ||= ctx.sessionManager?.getSessionId?.();
		let cwd = plan.workspace || ctx.cwd;
		const change: Change = { message: params.message?.trim() || undefined, evidence: params.evidence, reason: params.reason?.trim() || undefined };
		const op = params.op as string;
		if (op === "view") {
			if (plan.parent) { await load(cwd); await reconcile(); }
			return render(plan);
		}
		if (op === "init") {
			const desired: { phase: string; content: string }[] = params.list?.length
				? params.list.flatMap((p: any) => p.items.map((content: string) => ({ phase: p.phase, content })))
				: (params.items ?? []).map((content: string) => ({ phase: params.phase || "Tasks", content }));
			if (desired.length === 0) throw new Error("init needs list (phases with items) or items.");
			await ensureParent(params, ctx);
			cwd = plan.workspace || ctx.cwd;
			await load(cwd);
			const wanted = new Set(desired.map(d => `${d.phase}\u0000${d.content}`));
			for (const task of plan.tasks) {
				if (!wanted.has(`${task.phase}\u0000${task.content}`)) await remove(task, { message: "replaced by a new todo plan" }, cwd);
			}
			const have = new Set(plan.tasks.map(t => `${t.phase}\u0000${t.content}`));
			for (const d of desired) if (!have.has(`${d.phase}\u0000${d.content}`)) {
				if (plan.local) plan.tasks.push({ ...d, ref: `local-${digest(d.phase, d.content)}`, status: "pending" });
				else await create(d.phase, d.content, plan.workspace!);
			}
			await load(cwd);
			await advance(cwd);
			return render(plan);
		}
		if (!plan.parent && !plan.local) throw new Error("No todo plan yet. Call todo op=init first.");
		await load(cwd);
		switch (op) {
			case "append": {
				const items: string[] = params.items?.length ? params.items : params.task ? [params.task] : [];
				if (items.length === 0) throw new Error("append needs items.");
				const phase = params.phase || plan.tasks[plan.tasks.length - 1]?.phase || "Tasks";
				await reopenParent();
				for (const content of items) {
					if (plan.local) plan.tasks.push({ content, phase, ref: `local-${digest(phase, content)}`, status: "pending" });
					else await create(phase, content, cwd);
				}
				await load(cwd);
				break;
			}
			case "start": {
				const [task] = resolve(params.task, undefined, "none");
				if (!OPEN.has(task.status)) await reopenParent();
				if (task.status === "blocked") throw new Error(`"${task.content}" is blocked; unblock it first.`);
				for (const other of plan.tasks) if (other !== task && other.status === "in_progress") await transition(other, "pending", {}, cwd);
				await transition(task, "in_progress", change, cwd);
				break;
			}
			case "done":
			case "drop": {
				const tasks = resolve(params.task, params.phase, "active").filter(t => OPEN.has(t.status));
				change.many = tasks.length > 1;
				for (const task of tasks) await transition(task, op === "done" ? "completed" : "abandoned", change, cwd);
				break;
			}
			case "rm":
				for (const task of resolve(params.task, params.phase, "none")) await remove(task, change, cwd);
				await load(cwd);
				break;
			case "block":
				for (const task of resolve(params.task, undefined, "active")) await transition(task, "blocked", change, cwd);
				break;
			case "unblock":
				for (const task of resolve(params.task, undefined, "none")) if (task.status === "blocked") await transition(task, "pending", change, cwd);
				break;
			default:
				throw new Error(`Unknown op "${op}".`);
		}
		await advance(cwd);
		await reconcile();
		return render(plan);
	}

	function details(op: string) {
		return {
			op,
			kata: { parent: plan.parent },
			phases: phasesOf(plan.tasks).map(p => ({
				name: p.name,
				tasks: p.tasks.map(t => (t.blocker ? { content: t.content, status: t.status, blocker: t.blocker } : { content: t.content, status: t.status })),
			})),
		};
	}

	async function execute(params: any, ctx: any) {
		return serial(async () => {
			try {
				if (!main(ctx)) throw new Error("The todo plan belongs to the main agent.");
				const text = await apply(params, ctx);
				return { content: [{ type: "text" as const, text }], details: details(params.op) };
			} catch (err) {
				// Kata may have applied part of a batch; show the state it actually holds.
				await load(plan.workspace || ctx.cwd).catch(() => undefined);
				return {
					content: [{ type: "text" as const, text: `${(err as Error).message}\n\n${render(plan)}` }],
					details: details(params.op),
					isError: err instanceof DeferredClose ? undefined : true,
				};
			} finally {
				persist();
				refresh(ctx);
			}
		});
	}

	async function command(args: string, ctx: any): Promise<string> {
		const match = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(args.trim());
		const sub = match?.[1] ?? "";
		const arg = match?.[2]?.trim() || undefined;
		const actor = process.env.USER || "user";
		const supported: Record<string, any> = {
			"": { op: "view" },
			start: { op: "start", task: arg },
			done: { op: "done", task: arg, message: `Marked done by ${actor} through /todo in ${namespace}; the user attests the work is complete.`, evidence: [`external:${actor}`] },
			drop: { op: "drop", task: arg, message: `dropped by ${actor} through /todo` },
			rm: { op: "rm", task: arg, message: `removed by ${actor} through /todo` },
			append: { op: "append", items: arg ? [arg] : [] },
			block: { op: "block", reason: arg },
			unblock: { op: "unblock", task: arg },
		};
		const params = supported[sub];
		if (!params) return `/todo ${sub} is not available with Kata. Use /todo [start|done|drop|rm|append|block|unblock], or kata tui.`;
		const text = await serial(async () => {
			try {
				return await apply(params, ctx);
			} catch (err) {
				return (err as Error).message;
			} finally {
				persist();
				refresh(ctx);
			}
		});
		return text;
	}

	async function observeToolResult(event: any, ctx: any) {
		progressed = true;
		if (!main(ctx) || (options.explicitRef?.() ?? process.env.KATA_REF) || event.toolName !== "bash" || event.isError || (event.details?.exitCode !== undefined && event.details.exitCode !== 0)) return;
		const command = event.input?.command;
		if (typeof command !== "string" || /[;|\n]/.test(command)) return;
		for (const invocation of kataCommands(command, options.executable)) {
			const parsed = shellOptions(invocation.words), args = parsed.args;
			let ref = args[0] === "claim" ? args[1] : args[0] === "meta" && args[1] === "set" && args[3] === "work.attention" && args[4] === "ok" ? args[2] : undefined;
			if (!ref || parsed.options.has("--as")) continue;
			if (!ref.includes("#") && parsed.value("--project")) ref = `${parsed.value("--project")}#${ref}`;
			const workspace = path.resolve(event.input.cwd || ctx.cwd, parsed.value("--workspace") || ".");
			const target = ref;
			await bounded(serial(async () => {
				if (!await probe(ctx.cwd) || plan.tasks.some(t => t.ref === target || t.ref.split("#")[1] === target)) return;
				await owned(target, workspace);
				await adopt(target, ctx, workspace);
			}));
		}
	}

	async function remind(messages: any[], ctx: any): Promise<string | undefined> {
		if (!main(ctx)) return;
		await bounded(serial(async () => { await load(plan.workspace || ctx.cwd); await drainRetries(); }));
		const open = plan.tasks.filter(t => t.status === "pending" || t.status === "in_progress");
		if (open.length === 0 || reminders >= MAX_REMINDERS || !progressed) return;
		// Do not push past a question the assistant just asked the user.
		const last = [...(messages)].reverse().find((m: any) => m?.role === "assistant");
		const text = Array.isArray(last?.content)
			? last.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("")
			: String(last?.content ?? "");
		if (text.trim().endsWith("?")) return;
		reminders++;
		progressed = false;
		return [
				"<system-reminder>",
				`Open Kata todo tasks under ${plan.parent} (reminder ${reminders}/${MAX_REMINDERS}):`,
				...open.map(t => `- ${t.content} (${t.ref}, ${t.status})`),
				"Continue the work, or update the plan: done with evidence, block with a reason when waiting on someone, or drop with a reason.",
				"If the user asked you to stop or pause, do not continue: block the remaining tasks with that reason and stop.",
				"</system-reminder>",
			].join("\n");
	}

	function warm(ctx: any, cwd = ctx.cwd) {
		const id = ctx.sessionManager?.getSessionId?.();
		if (cache.id !== id) cache = { id };
		const entry = cache;
		if (entry.pending || entry.contract) return entry.pending;
		entry.pending = (async () => {
			if (!await probe(cwd)) return;
			const [contract, inbox] = await Promise.allSettled([
				kata(["agent-contract-hook"], cwd).then(out => JSON.parse(out)?.hookSpecificOutput?.additionalContext),
				process.env.KATA_INBOX_USER ? kata(["inbox", "--context", "--for", process.env.KATA_INBOX_USER], cwd) : Promise.resolve(undefined),
			]);
			if (contract.status === "fulfilled" && typeof contract.value === "string") entry.contract = contract.value;
			else if (contract.status === "rejected") debug(contract.reason);
			if (inbox.status === "fulfilled") entry.inbox = inbox.value?.trim();
			else debug(inbox.reason);
		})().catch(debug).finally(() => { entry.pending = undefined; });
		return entry.pending;
	}

	return {
		get plan() { return plan; },
		get currentId() { return currentId; },
		get currentCtx() { return currentCtx; },
		set currentCtx(ctx: any) { currentCtx = ctx; },
		get cache() { return cache; },
		stateEntry: STATE_ENTRY,
		resetReminders() { reminders = 0; },
		debug, bounded, serial, kata, actor, owned, work, load, refresh, probe, bind,
		ensureParent, adopt, reconcile, drainRetries, apply, execute, command,
		observeToolResult, remind, warm,
	};
}
