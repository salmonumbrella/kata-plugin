# Oh-my-pi reference

Plugin ID: `kata@kata-plugin`; package: `kata-omp`. The canonical adapter is root `kata.ts`; the portable entry is `plugins/oh-my-pi/kata.ts`.

The adapter uses session start/shutdown, tree navigation, input, prompt/stop hooks, tool calls/results, `before_subagent_spawn`, and `task:subagent:lifecycle`. A shared coordinator joins final subagent IDs to child sessions. Only `ctx.agent.kind === "main"` can bind the main plan, draw its progress widget, or change main session attention. A tracked worker can use todo under its own assigned issue and teammate; it cannot reuse the coordinator’s adapter context or inherited parent reference.

| Variable | Meaning |
| --- | --- |
| `KATA_OMP_EXECUTABLE` | Kata executable; defaults to `kata`. |
| `KATA_REF` | Explicit main parent and main session-attention target. |
| `KATA_AUTHOR`, `KATA_TEAMMATE` | Existing actor and optional main teammate. |
| `KATA_INBOX_USER` | Inbox recipient override. |
| `KATA_OMP_DEBUG` | Optional append-only diagnostic log. |

The todo tool supports `init`, `append`, `start`, `block`, `unblock`, `done`, `drop`, `rm`, `view`. `/todo` supports `start`, `done`, `drop`, `rm`, `append`, `block`, and `unblock`; with no subcommand it shows the plan. Phases and task refs are retained in Kata. Local plans and queued close retries persist in custom session entries and resume with a saved session. Explicit `/todo done` records the user's completion attestation as external evidence. Removed items are retired, never deleted.

The plugin matches each delegation (the task item's `name`, `task` and the lifecycle `description`) against the plan when the subagent starts, so a `task` call sent in the same batch as `todo init` still binds. An open task named by its title (quoted, as the whole text, or three or more words), by qualified ref, or by short id after `issue`, `kata`, `ref`, `task` or `#` wins; if that task is already delegated the `task` call is refused. Otherwise the task with a clear weighted word overlap wins, its leading verb counted twice and the lead's active task at half weight. The active task is the fallback only for an explicit "current task" handoff. Batch tasks match by index. If no task matches, a separate child is created. One task cannot have two delegates, and a delegated task never occupies the lead's active slot. Main todo mutations cannot complete a running delegate's task: the child closes itself and `view` reloads Kata state. Delegate teammates derive from the agent id and the lead session id.

Qualified explicit issue references and saved bindings take precedence over directory probing, including in unbound worktrees. An unavailable explicit issue is an error. Session-local plans are used only when no issue binding exists and Kata reports `project_not_initialized`; missing projects, authentication failures, and outages never select local mode.

Subagents receive the cached contract, exact issue, teammate, and close command. Their todo children belong to that assigned issue, and CLI calls carry the worker’s teammate without changing process-wide environment variables. An untracked worker receives a binding error. Recognized standalone Kata Bash commands gain teammate and binding flags; actor impersonation is refused. A delegate that finishes without closing its issue gets `omp.status`, `needs-review`, one idempotent comment and a `kata notify` to the lead; a plan task is handed back to the lead's teammate as pending, so the lead can verify and close it (which removes `needs-review`) or delegate it again. A `task` call that never starts a subagent releases its tasks when its result arrives. Terminal outcomes never write the delegate's `work.*` or infer a close from shell text.

Hooks have a 250 ms foreground budget; ordinary Kata subprocess calls have a 120-second ceiling so hosted reads are not killed after one second. Explicit todo operations await actual results. Failed startup binding is retried on the next todo call. If a read fails or returns malformed children, the widget and tool report unavailable state rather than cached task progress; `view` reloads it from Kata. Stop reminders wait for a successful refresh and do not describe a pending read as current state. Main session attention for a `KATA_REF` session checks the actor and teammate, then runs `kata agent-hook attention-native pi start|end --session <id> --host-pid <pid> --ref <ref>`; Kata owns the token and transitions. Conflicting writes are preserved. See [closing rules](closing-rules.md).
