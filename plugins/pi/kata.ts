import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createKataCore, DESCRIPTION, kataCommands, quote, render, teammateFor, delegateCommand, delegateContext, type Binding } from "./kata-core";

// Match the native adapter's capability/scope selection, including a project
// root boundary. Recheck at prompt time: either factory can load first.
export function nativeContractActive(cwd: string): boolean {
	const registry = (globalThis as any)[Symbol.for("kata.pi.native.v1")];
	for (const adapter of registry?.adapters?.values?.() ?? []) {
		const options = adapter?.options;
		if (!options?.contract) continue;
		if (options.scope === "user") return true;
		if (options.scope !== "project" || typeof options.workspace !== "string") continue;
		const relative = path.relative(options.workspace, path.resolve(cwd));
		if (relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) return true;
	}
	return false;
}

export type PiParent = { pid: number; sessionId: string; ref?: string; workspace: string; teammate: string };

// The native adapter reuses this exact baseline on session_start. Preseed it
// when we run first; leave its captured baseline alone when we run second.
// Clearing KATA_REF is then independent of extension ordering.
export function isolateChildAttention(ctx: ExtensionContext, explicit?: string) {
	const registry = (globalThis as any)[Symbol.for("kata.pi.native.v1")];
	const cwd = path.resolve(ctx.cwd), id = ctx.sessionManager.getSessionId();
	let selected: any;
	for (const adapter of registry?.adapters?.values?.() ?? []) {
		const o = adapter.options;
		if (!o?.attention) continue;
		if (o.scope === "project") {
			const relative = path.relative(o.workspace, cwd);
			if (relative !== "" && (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))) continue;
			if (!selected || selected.options.scope !== "project" || o.workspace.length > selected.options.workspace.length) selected = adapter;
		} else if (!selected) selected = adapter;
	}
	const previous = registry?.active?.get(cwd);
	if (selected && id && (!previous || previous.id !== id || previous.ended)) {
		registry.active.set(cwd, { id, cwd, executable: selected.options.executable, ref: explicit || "", started: false, ended: false });
	}
	delete process.env.KATA_REF;
}

export default async function piKata(pi: ExtensionAPI) {
	// OMP also discovers legacy pi manifests. Do not register a second todo
	// tool there, or even ask its loader to resolve pi's TypeBox dependency.
	if ((pi as any).zod) return;
	let inherited: PiParent | undefined;
	try {
		const marker = JSON.parse(process.env.KATA_PI_PARENT || "null");
		if (marker && Number.isInteger(marker.pid) && marker.pid !== process.pid && typeof marker.sessionId === "string" && typeof marker.workspace === "string" && typeof marker.teammate === "string") inherited = marker;
	} catch { /* An invalid marker grants no parent binding. */ }
	const explicit = inherited ? undefined : process.env.KATA_REF;
	if (inherited) delete process.env.KATA_REF;
	let delegate: { id: string; ref: string; teammate: string; binding: Binding } | undefined;
	const { Type } = await import("typebox");
	const executable = process.env.KATA_PI_EXECUTABLE || process.env.KATA_OMP_EXECUTABLE || "kata";
	const core = createKataCore({
		exec: (...args) => pi.exec(...args),
		appendEntry: (...args) => pi.appendEntry(...args),
		getSessionName: () => pi.getSessionName(),
		allowUI: ctx => ctx.hasUI === true,
		isMain: () => !inherited,
	}, { namespace: "pi", executable, explicitRef: () => inherited ? undefined : explicit, debugFile: process.env.KATA_PI_DEBUG || process.env.KATA_OMP_DEBUG });

	function exportParent(ctx: ExtensionContext) {
		process.env.KATA_PI_PARENT = JSON.stringify({ pid: process.pid, sessionId: ctx.sessionManager.getSessionId(),
			ref: inherited ? delegate?.ref : core.plan.parent || explicit,
			workspace: inherited ? delegate?.binding.workspace || inherited.workspace : core.plan.workspace || path.resolve(ctx.cwd),
			teammate: process.env.KATA_TEAMMATE || "" } satisfies PiParent);
	}
	async function prepareDelegate(ctx: ExtensionContext, prompt: string) {
		if (!inherited) return;
		if (delegate) {
			process.env.KATA_TEAMMATE = delegate.teammate;
			process.env.KATA_INBOX_USER = `${await core.actor(delegate.binding.workspace)}/${delegate.teammate}`;
			exportParent(ctx);
			return;
		}
		const id = ctx.sessionManager.getSessionId();
		if (!id) throw new Error("Pi child needs a real session identity before tracking work.");
		if (!inherited.ref) {
			const candidates = JSON.parse(await core.kata(["list", "--status", "all", "--meta", `pi.session_id=${inherited.sessionId}`, "--label", "pi-session", "--limit", "2", "--json"], inherited.workspace)).issues ?? [];
			const parent = candidates.find((issue: any) => issue.metadata?.["pi.auto_parent"] === true);
			if (parent) inherited.ref = parent.qualified_id;
			else {
				// A session-start extension can spawn before the lead uses todo.
				// Establish only parent identity; the child never writes lead work.*.
				const out = JSON.parse(await core.kata(["create", "Todo plan: tasks", "--body", `Todo plan from pi session ${inherited.sessionId}.`,
					"--owner", await core.actor(inherited.workspace), "--teammate", inherited.teammate,
					"--meta", `pi.session_id=${inherited.sessionId}`, "--meta", `pi.workspace=${inherited.workspace}`, "--label", "pi-session",
					"--idempotency-key", `pi-session:${inherited.sessionId}`, "--force-new", "--json"], inherited.workspace));
				if (!out.issue?.short_id || !out.event?.project_name) throw new Error("kata create returned no parent identity");
				inherited.ref = `${out.event.project_name}#${out.issue.short_id}`;
				await core.kata(["meta", "set", inherited.ref!, "pi.auto_parent", "true", "--json-value"], inherited.workspace);
			}
		}
		if (!inherited.ref) throw new Error("Pi child parent identity is unavailable.");
		const binding: Binding = { parent: inherited.ref, workspace: inherited.workspace, sessionId: inherited.sessionId, auto: false };
		const teammate = teammateFor(`${inherited.teammate || "pi"}:${inherited.sessionId}:${id}`);
		process.env.KATA_TEAMMATE = teammate;
		process.env.KATA_INBOX_USER = `${await core.actor(binding.workspace)}/${teammate}`;
		const shown = JSON.parse(await core.kata(["show", binding.parent, "--json"], binding.workspace));
		const children = (shown.children ?? []).filter((c: any) => c.status === "open" && typeof c.metadata?.["todo.phase"] === "string");
		const named = children.filter((c: any) => prompt.includes(c.title) || prompt.includes(c.qualified_id || `${binding.parent.split("#")[0]}#${c.short_id}`));
		const active = children.filter((c: any) => c.metadata?.["todo.status"] === "in_progress" && !c.metadata?.["pi.subagent_id"] && !c.metadata?.["omp.subagent_id"]);
		const selected = named.length === 1 ? named[0] : named.length === 0 && active.length === 1 ? active[0] : undefined;
		const key = `pi-agent:${inherited.sessionId}:${id}`;
		const restored = (ctx.sessionManager.getBranch() as any[]).filter(e => e.type === "custom" && e.customType === "io.kata.pi.delegate" && e.data?.id === id).at(-1)?.data;
		let ref: string;
		if (restored?.ref) ref = restored.ref;
		else if (selected) {
			ref = selected.qualified_id || `${binding.parent.split("#")[0]}#${selected.short_id}`;
			if (selected.metadata?.["pi.subagent_id"] && selected.metadata["pi.subagent_id"] !== id) throw new Error(`Plan task ${ref} is already delegated.`);
			if (selected.owner && (selected.owner !== await core.actor(binding.workspace) || ![inherited.teammate, teammate].includes(selected.metadata?.teammate || ""))) throw new Error(`Plan task ${ref} belongs to another writer.`);
			if (!selected.owner) await core.kata(["claim", ref, "--teammate", teammate, "--if-unowned"], binding.workspace);
			else await core.kata(["meta", "set", ref, "teammate", teammate, "--if-match", String(selected.revision)], binding.workspace);
			await core.kata(["meta", "set", ref, "pi.subagent_id", id], binding.workspace);
			await core.kata(["meta", "set", ref, "todo.status", "in_progress"], binding.workspace);
		} else {
			const out = JSON.parse(await core.kata(["create", `Subagent ${id}`, "--parent", binding.parent, "--project", binding.parent.split("#")[0],
				"--body", `Delegated Pi work. The child must close this issue with its verification evidence.`, "--owner", await core.actor(binding.workspace), "--teammate", teammate,
				"--meta", `pi.subagent_id=${id}`, "--meta", `pi.session_id=${inherited.sessionId}`, "--idempotency-key", key, "--force-new", "--json"], binding.workspace));
			if (!out.issue?.short_id) throw new Error("kata create returned no child identity");
			ref = `${binding.parent.split("#")[0]}#${out.issue.short_id}`;
		}
		delegate = { id, ref, teammate, binding };
		pi.appendEntry("io.kata.pi.delegate", { ...delegate, parentMarker: inherited });
		const issue = JSON.parse(await core.kata(["show", ref, "--json"], binding.workspace)).issue;
		if (issue.status === "open") {
			const owned = await core.owned(ref, binding.workspace);
			await core.work(ref, "work.attention", "ok", binding.workspace, owned);
		}
		exportParent(ctx);
	}

	pi.registerTool({
		name: "todo",
		label: "Todo (Kata)",
		description: DESCRIPTION,
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		parameters: Type.Object({
			op: Type.Union(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"].map(op => Type.Literal(op))),
			list: Type.Optional(Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String(), { minItems: 1 }) }), { description: "phases for init" })),
			task: Type.Optional(Type.String({ description: "verbatim task content or Kata ref" })),
			phase: Type.Optional(Type.String()),
			items: Type.Optional(Type.Array(Type.String(), { description: "tasks for flat init or append" })),
			reason: Type.Optional(Type.String({ description: "blocker note for block" })),
			ref: Type.Optional(Type.String({ description: "existing Kata issue this plan serves (init)" })),
			message: Type.Optional(Type.String({ description: "done: changes and verification (40+ characters); drop/rm: reason; init without ref: title for the automatic parent" })),
			evidence: Type.Optional(Type.Array(Type.String(), { description: "required for done: commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await core.execute(params, ctx);
			if (!inherited) exportParent(ctx);
			return result;
		},
	});

	pi.registerCommand("todo", {
		description: "View or update the Kata plan: start, done, drop, rm, append, block, unblock",
		async handler(args, ctx) {
			const text = await core.command(args, ctx);
			// Custom messages remain observable in print/JSON as well as the TUI.
			pi.sendMessage({ customType: "kata.todo.command", content: text, display: true }, { triggerTurn: false });
		},
	});
	pi.on("input", async (event) => {
		if (event.source === "interactive" && !event.text.trim().startsWith("/")) core.resetReminders();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!inherited) {
			await core.serial(async () => { await core.ensureParent({}, ctx); exportParent(ctx); });
		}
		if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
		let command = event.input.command;
		if (inherited) {
			if (!delegate) return { block: true, reason: "Kata child binding is unavailable; retry after parent startup." };
			try { command = delegateCommand(command, executable, delegate.teammate, delegate.binding); }
			catch (error) { return { block: true, reason: String(error) }; }
		}
		for (const invocation of kataCommands(command, executable).reverse()) {
			if (invocation.executable.value !== "kata" || executable === "kata") continue;
			command = command.slice(0, invocation.executable.start) + quote(executable) + command.slice(invocation.executable.end);
		}
		event.input.command = command;
	});
	pi.on("tool_result", (event, ctx) => core.observeToolResult({ ...event, details: undefined }, ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		if (inherited) await prepareDelegate(ctx, event.prompt || "");
		else exportParent(ctx);
		const native = !inherited && nativeContractActive(ctx.cwd);
		await core.bounded(Promise.all([
			core.currentId !== ctx.sessionManager.getSessionId() ? core.serial(() => core.bind(ctx, explicit)) : undefined,
			native ? undefined : core.warm(ctx, delegate?.binding.workspace || ctx.cwd),
		]));
		const sections = event.systemPromptOptions.sections;
		if (!native) {
			if (core.cache.contract) sections.kata_contract = core.cache.contract;
			if (core.cache.inbox) sections.kata_inbox = core.cache.inbox;
		}
		if (delegate) sections.kata_binding = delegateContext(executable, delegate.id, delegate.ref, delegate.teammate, delegate.binding);
		if (core.plan.parent) sections.kata_todo = `The todo tool is backed by Kata. Current plan:\n${render(core.plan)}`;
		else delete sections.kata_todo;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "completed") return;
		const content = await core.remind(event.context.contextMessages, ctx);
		if (!content) return;
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: "kata.todo.reminder", content, display: false }],
			continue: true,
		};
	});

	const bind = (ctx: ExtensionContext) => core.bounded(core.serial(async () => {
		await core.bind(ctx, explicit);
		if (!inherited) exportParent(ctx);
		core.resetReminders();
	}));
	pi.on("session_start", async (_event, ctx) => {
		const saved = (ctx.sessionManager.getBranch() as any[]).filter(e => e.type === "custom" && e.customType === "io.kata.pi.delegate" && e.data?.id === ctx.sessionManager.getSessionId()).at(-1)?.data;
		if (saved?.parentMarker && (!explicit || inherited)) {
			inherited = saved.parentMarker;
			delegate = saved;
			process.env.KATA_TEAMMATE = saved.teammate;
			delete process.env.KATA_REF;
		}
		if (inherited && !inherited.ref && !await core.probe(inherited.workspace)) inherited = undefined;
		isolateChildAttention(ctx, inherited ? undefined : explicit);
		return bind(ctx);
	}); // startup/reload/new/resume/fork
	pi.on("session_tree", (_event, ctx) => core.bounded(core.serial(async () => {
		await core.bind(ctx, explicit);
		if (!inherited) exportParent(ctx);
		await core.reconcile();
	})));
	pi.on("session_shutdown", (_event, ctx) => core.bounded(core.serial(async () => {
		await core.load(core.plan.workspace || ctx.cwd);
		await core.drainRetries();
		if (delegate) {
			const view = JSON.parse(await core.kata(["show", delegate.ref, "--json"], delegate.binding.workspace));
			if (view.issue.status === "open") {
				await core.kata(["label", "add", delegate.ref, "needs-review"], delegate.binding.workspace);
				let issue = await core.owned(delegate.ref, delegate.binding.workspace);
				issue = await core.work(delegate.ref, "work.attention", "needs-human", delegate.binding.workspace, issue);
				await core.work(delegate.ref, "work.attention_msg", "Pi child ended without closing its issue; review its report and verification.", delegate.binding.workspace, issue);
			}
		}
	})));
}
