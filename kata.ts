// omp-kata: Kata replaces oh-my-pi's todo tracker.
//
// Run with `todo.enabled: false` in omp's config. This extension then owns:
//   - the `todo` tool (same ops as omp's: init, start, done, drop, rm, block,
//     unblock, append, view), with every task stored as a Kata child issue;
//   - `/todo`, intercepted on input before omp's built-in command;
//   - a progress widget and a stop reminder while tasks remain open;
//   - cached Kata contracts, guarded main-session attention, and delegate identity.
//
// In Kata projects, plan items are children carrying `todo.phase`; other children
// participate in parent closure. Unbound folders use a session-local plan.

import path from "node:path";
import { createKataCore, DESCRIPTION, OPEN, sessionKey, render, matchDelegation,
	kataCommands as parseKataCommands, teammateFor, delegateCommand, delegateContext, type Binding } from "./core/kata-core";

const EXECUTABLE = process.env.KATA_OMP_EXECUTABLE || "kata";
const STATE_ENTRY = "io.kata.omp.parent";
export const kataCommands = (command: string) => parseKataCommands(command, EXECUTABLE);

type Delegate = {
	id: string; teammate: string; sessionFile?: string; parentAgentId?: string;
	state: string; planRef?: string; text?: string; single?: boolean; ref?: string; binding?: Binding; ready?: Promise<void>; reported?: string;
	coordinator: Coordinator;
};
type Coordinator = {
	id: string; records: Map<string, Delegate>;
	prepare: (record: Delegate) => Promise<void>;
	settle: (record: Delegate) => Promise<void>;
};
// OMP rebinds extension factories in the same module graph. Session file is the
// correlation key: agent names alone can collide across simultaneous sessions.
const delegatesBySession = new Map<string, Delegate>();

export default function ompKata(pi: any) {
	const z = pi.zod;
	const main = (ctx: any) => ctx?.agent?.kind === "main";
	let attentionSession: { id: string; cwd: string; ref?: string } | undefined;
	let coordinator: Coordinator | undefined;
	// Spawn text per task tool call; refs once a plan existed when it was seen.
	const assignments = new Map<string, { texts: string[]; refs?: (string | undefined)[] }>();
	const core = createKataCore({
		exec: (...args) => pi.exec(...args),
		appendEntry: (...args) => pi.appendEntry(...args),
		getSessionName: () => pi.getSessionName?.(),
		isMain: main,
		isDelegated: ref => [...(coordinator?.records.values() ?? [])].some(record => (record.ref || record.planRef) === ref),
		beforeReconcile: syncSnapshots,
		delegatedRunning: () => [...(coordinator?.records.values() ?? [])].some(record => record.state === "started" || !record.ref || record.ready) ||
			(core.currentCtx?.getAsyncJobSnapshot?.()?.running ?? []).some((job: any) => job.type === "task"),
	}, { namespace: "omp", executable: EXECUTABLE, debugFile: process.env.KATA_OMP_DEBUG });
	const { serial, bounded, debug, kata, actor, owned, work, load, bind, ensureParent, reconcile } = core;
	const warm = (ctx: any) => core.warm(ctx, self(ctx)?.binding?.workspace || ctx.cwd);
	pi.registerTool({
		name: "todo",
		label: "Todo (Kata)",
		description: DESCRIPTION,
		approval: "read",
		parameters: z.object({
			op: z.enum(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"]),
			list: z.array(z.object({ phase: z.string(), items: z.array(z.string()).min(1) })).optional().describe("phases for init"),
			task: z.string().optional().describe("verbatim task content or Kata ref"),
			phase: z.string().optional(),
			items: z.array(z.string()).optional().describe("tasks for flat init or append"),
			reason: z.string().optional().describe("blocker note for block"),
			ref: z.string().optional().describe("existing Kata issue this plan serves (init)"),
			message: z.string().optional().describe("done: what changed and how it was verified (40+ chars); drop/rm: reason; init without ref: title for the new Kata parent"),
			evidence: z.array(z.string()).optional().describe("required for done: commit:<sha>, test:<cmd>, pr:<url>, reviewed-paths:<path>"),
		}),
		async execute(_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
			return core.execute(params, ctx);
		},
	});

	// OMP reserves built-in command names; intercept /todo before its dispatcher.
	pi.on("input", async (event: any, ctx: any) => {
		if (!main(ctx)) return;
		const match = /^\/todo(?:\s+([\s\S]*))?$/.exec(event.text.trim());
		if (!match) {
			if (event.source === "interactive" && !event.text.trim().startsWith("/")) core.resetReminders();
			return;
		}
		ctx.ui?.notify?.(await core.command(match[1] || "", ctx), "info");
		return { handled: true };
	});
	// --------------------------------------------------------------- delegates

	function self(ctx: any): Delegate | undefined {
		const file = ctx.sessionManager?.getSessionFile?.();
		const record = file ? delegatesBySession.get(sessionKey(file, ctx.cwd)) : undefined;
		return record?.id === ctx.agent?.id ? record : undefined;
	}

	function root(ctx: any): Coordinator | undefined {
		if (!main(ctx)) return self(ctx)?.coordinator;
		const id = ctx.sessionManager?.getSessionId?.();
		if (!id) return;
		if (coordinator?.id === id) return coordinator;
		coordinator = {
			id, records: new Map(),
			prepare: record => serial(async () => {
				await ensureParent({}, ctx);
				if (!core.plan.parent || core.plan.local) return;
				const binding: Binding = { parent: core.plan.parent, workspace: core.plan.workspace!, sessionId: id, auto: core.plan.auto };
				record.binding = binding;
				// todo init and task often share one batch, so the plan may not have
				// existed when the task call was seen. Match against it now.
				if (!record.planRef && record.text?.trim()) {
					await load(binding.workspace);
					record.planRef = matchDelegation(core.plan.tasks, record.text, reserved(record), record.single)?.ref;
				}
				if (record.planRef) {
					const ref = record.planRef;
					let issue = JSON.parse(await kata(["show", ref, "--json"], binding.workspace)).issue;
					// Retry an interrupted transfer only if it is already ours.
					if (issue.metadata?.teammate !== record.teammate || issue.owner !== await actor(binding.workspace)) {
						issue = await owned(ref, binding.workspace, true);
						await kata(["meta", "set", ref, "teammate", record.teammate, "--if-match", String(issue.revision)], binding.workspace);
					}
					if (issue.status !== "open") throw new Error(`Delegated task ${ref} is already closed.`);
					for (const [key, value] of Object.entries({ "omp.subagent_id": record.id, "omp.session_id": id, "omp.parent_agent_id": record.parentAgentId || "main", "omp.status": "running", "todo.status": "in_progress" })) {
						await kata(["meta", "set", ref, key, value], binding.workspace);
					}
					record.ref = ref;
				} else {
					const out = JSON.parse(await kata(["create", `Subagent ${record.id}`, "--parent", binding.parent, "--project", binding.parent.split("#")[0],
						"--body", `Delegated OMP work for agent ${record.id}, session ${id}. The subagent must close this issue itself with its verification evidence.`,
						"--owner", await actor(binding.workspace), "--teammate", record.teammate,
						"--meta", `omp.subagent_id=${record.id}`, "--meta", `omp.session_id=${id}`, "--meta", `omp.parent_agent_id=${record.parentAgentId || "main"}`,
						"--meta", "omp.status=running", "--idempotency-key", `omp-agent:${id}:${record.id}`, "--force-new", "--json"], binding.workspace));
					record.ref = `${binding.parent.split("#")[0]}#${out.issue.short_id}`;
				}
				pi.appendEntry(`${STATE_ENTRY}.delegate`, { id: record.id, ref: record.ref, teammate: record.teammate, sessionFile: record.sessionFile, binding });
			}),
			settle: record => serial(async () => { await settleRecord(record); await reconcile(); }),
		};
		return coordinator;
	}

	async function settleRecord(record: Delegate) {
		if (!record.ref || !record.binding || record.state === "started" || record.reported === record.state) return;
		const cwd = record.binding.workspace;
		const view = JSON.parse(await kata(["show", record.ref, "--json"], cwd));
		// Only observation metadata belongs to the parent; delegate work.* stays untouched.
		if (view.issue.metadata?.["omp.status"] !== record.state) await kata(["meta", "set", record.ref, "omp.status", record.state, "--if-match", String(view.issue.revision)], cwd);
		if (view.issue.status !== "closed") {
			await kata(["label", "add", record.ref, "needs-review"], cwd);
			const marker = `[omp:${record.coordinator.id}:${record.id}:${record.state}]`;
			if (!(view.comments ?? []).some((c: any) => c.body?.includes(marker))) await kata(["comment", record.ref, "--body", `Subagent ${record.id} ${record.state} without closing its Kata issue. Review the work and supply evidence before closing. ${marker}`], cwd);
		}
		record.reported = record.state;
	}

	async function syncSnapshots() {
		const snapshot = core.currentCtx?.getAsyncJobSnapshot?.();
		if (!coordinator || !snapshot) return;
		for (const job of snapshot.recent ?? []) {
			if (job.type !== "task" || !["completed", "failed", "aborted", "cancelled"].includes(job.status)) continue;
			const record = coordinator.records.get(job.id) || coordinator.records.get(job.agentId);
			if (!record || (snapshot.running ?? []).some((r: any) => r.id === job.id || r.agentId === record.id)) continue;
			record.state = job.status === "cancelled" ? "aborted" : job.status;
		}
		for (const record of coordinator.records.values()) {
			if (record.state !== "started" && !record.ready) {
				try { await settleRecord(record); } catch (error) { debug(error); }
			}
		}
	}

	function reserved(except?: Delegate): Set<string> {
		const refs = [...assignments.values()].flatMap(a => a.refs ?? []);
		for (const record of coordinator?.records.values() ?? []) if (record !== except) refs.push(record.ref || record.planRef);
		return new Set(refs.filter((ref): ref is string => !!ref));
	}

	function prepare(record: Delegate) {
		if (record.ref || record.ready) return record.ready;
		record.ready = record.coordinator.prepare(record).catch(debug).finally(() => { record.ready = undefined; });
		return record.ready;
	}

	pi.on("before_subagent_spawn", async (_event: any, ctx: any) => {
		core.currentCtx = ctx;
		const owner = root(ctx);
		if (main(ctx) && owner) await bounded(serial(() => ensureParent({}, ctx)));
	});

	pi.events?.on("task:subagent:lifecycle", (event: any) => {
		if (!core.currentCtx || !event?.id) return;
		const owner = root(core.currentCtx);
		if (!owner) return;
		let record = owner.records.get(event.id);
		if (event.status === "started") {
			if (!record) {
				const assignment = main(core.currentCtx) ? assignments.get(event.parentToolCallId) : undefined;
				const text = [assignment?.texts[event.index ?? 0], event.description].filter(Boolean).join("\n");
				record = { id: event.id, planRef: assignment?.refs?.[event.index ?? 0], text, single: (assignment?.texts.length ?? 1) === 1, teammate: teammateFor(event.id, owner.id), parentAgentId: core.currentCtx.agent?.id, sessionFile: event.sessionFile, state: "started", coordinator: owner };
				owner.records.set(event.id, record);
			}
			record.state = "started";
			record.reported = undefined;
			if (event.sessionFile) delegatesBySession.set(sessionKey(event.sessionFile, core.currentCtx.cwd), record);
			void prepare(record);
		} else if (record && ["completed", "failed", "aborted"].includes(event.status)) {
			record.state = event.status;
			const ready = prepare(record);
			if (ready) void ready.then(() => owner.settle(record!)).catch(debug);
			else void owner.settle(record).catch(debug);
		}
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		// OMP's advisor can call this main-session handler with a sub identity.
		// Keep the session coordinator attached to the actual main context.
		if (main(ctx) || !core.currentCtx || !main(core.currentCtx)) core.currentCtx = ctx;
		if (main(ctx) && event.toolName === "task" && event.toolCallId) {
			const items: any[] = Array.isArray(event.input?.tasks) ? event.input.tasks : [event.input];
			const texts = items.map(item => [item?.name, item?.task, item?.description].filter(value => typeof value === "string").join("\n"));
			const assignment: { texts: string[]; refs?: (string | undefined)[] } = { texts };
			assignments.set(event.toolCallId, assignment);
			return serial(async () => {
				if (!core.plan.parent || core.plan.local) return;
				await load(core.plan.workspace!);
				const taken = reserved();
				assignment.refs = texts.map(text => {
					const named = core.plan.tasks.filter(task => OPEN.has(task.status) && (text.includes(task.content) || text.includes(task.ref)));
					if (named.length === 1 && (taken.has(named[0].ref) || named[0].delegated)) throw new Error(`Plan task ${named[0].ref} is already delegated.`);
					const selected = matchDelegation(core.plan.tasks, text, taken, texts.length === 1);
					if (selected) taken.add(selected.ref);
					return selected?.ref;
				});
			}).catch(error => { assignments.delete(event.toolCallId); return { block: true, reason: String(error) }; });
		}
		if (ctx.agent?.kind !== "sub" || event.toolName !== "bash" || typeof event.input?.command !== "string") return;
		const commands = kataCommands(event.input.command);
		if (!commands.length) return;
		const record = self(ctx);
		const teammate = record?.teammate || teammateFor(ctx.agent.id);
		try { return { input: { ...event.input, command: delegateCommand(event.input.command, EXECUTABLE, teammate, record?.binding) } }; }
		catch (error) { return { block: true, reason: String(error) }; }
	});

	pi.on("tool_result", (event: any, ctx: any) => core.observeToolResult(event, ctx));
	pi.on("session_stop", async (event: any, ctx: any) => {
		const additionalContext = await core.remind(event.messages ?? [], ctx);
		if (additionalContext) return { continue: true, additionalContext };
	});

	async function prepareIfTracked(ctx: any) { const record = self(ctx); if (record) await prepare(record); }

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		await bounded(Promise.all([
			main(ctx) && core.currentId !== ctx.sessionManager?.getSessionId?.() ? serial(() => bind(ctx)) : undefined,
			(async () => { if (!main(ctx)) await prepareIfTracked(ctx); await warm(ctx); })(),
		]));
		const sections: string[] = [];
		if (core.cache.contract) sections.push(`<kata_contract>\n${core.cache.contract}\n</kata_contract>`);
		const delegate = !main(ctx) ? self(ctx) : undefined;
		if (delegate?.ref && delegate.binding) {
			sections.push(`<kata_binding>\n${delegateContext(EXECUTABLE, ctx.agent.id, delegate.ref, delegate.teammate, delegate.binding)}\n</kata_binding>`);
		}
		if (core.cache.inbox) sections.push(`<kata_inbox>\n${core.cache.inbox}\n</kata_inbox>`);
		if (main(ctx) && core.plan.parent) sections.push(`<kata_todo>\nThe todo tool is backed by Kata. Current plan:\n${render(core.plan)}\n</kata_todo>`);
		if (!sections.length) return;
		const base = (Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt || ""]).filter((s: string) => !/^<kata_(contract|todo|inbox|binding)>/.test(s));
		return { systemPrompt: [...base, sections.join("\n\n")] };
	});

	// --------------------------------------------------------------- attention

	async function attention(mode: "start" | "end", session: { id: string; cwd: string; ref?: string }, ctx?: any) {
		const ref = session.ref;
		if (!ref) return;
		try {
			let issue = await owned(ref, session.cwd);
			const token = `omp:${process.pid}:${session.id}`;
			if (mode === "start") {
				issue = await work(ref, "work.attention_session", token, session.cwd, issue);
				issue = await work(ref, "work.attention", "ok", session.cwd, issue, token);
			} else if (issue.metadata?.["work.attention_session"] === token) {
				if (issue.metadata?.["work.attention"] === "ok") {
					issue = await work(ref, "work.attention", "needs-human", session.cwd, issue, token);
					issue = await work(ref, "work.attention_msg", "omp session ended; review the current work before continuing.", session.cwd, issue, token);
				}
				issue = await work(ref, "work.attention_session", `ended:${token}`, session.cwd, issue, token);
			}
		} catch (err) {
			debug(`Kata attention skipped: ${(err as Error).message}`);
		}
	}

	async function begin(ctx: any) {
		if (!main(ctx)) { core.currentCtx = ctx; void prepareIfTracked(ctx).then(() => warm(ctx)).catch(debug); return; }
		const explicit = process.env.KATA_REF;
		const previous = attentionSession;
		const id = ctx.sessionManager?.getSessionId?.();
		void warm(ctx);
		await bounded(serial(async () => {
			await bind(ctx, explicit);
			core.resetReminders();
			if (!id || previous?.id === id) return;
			if (previous) await attention("end", previous, ctx);
			attentionSession = { id, cwd: core.plan.workspace || path.resolve(ctx.cwd), ref: explicit && core.plan.parent };
			await attention("start", attentionSession, ctx);
		}));
	}

	pi.on("session_start", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_switch", (_event: any, ctx: any) => begin(ctx));
	pi.on("session_branch", (_event: any, ctx: any) => main(ctx) ? bounded(serial(() => bind(ctx))) : undefined);
	pi.on("session_tree", (_event: any, ctx: any) => main(ctx) ? bounded(serial(() => bind(ctx))) : undefined);
	pi.on("session_shutdown", async (_event: any, ctx: any) => {
		if (!main(ctx)) return;
		const session = attentionSession;
		attentionSession = undefined;
		await bounded(serial(async () => { await reconcile(); if (session) await attention("end", session, ctx); }));
	});
}
