# Oh-my-pi reference

Plugin ID: `kata@kata-plugin`; package: `kata-omp`. The canonical adapter is root `kata.ts`; the portable entry is `plugins/oh-my-pi/kata.ts`.

The adapter uses session start/shutdown, tree navigation, input, prompt/stop hooks, tool calls/results, `before_subagent_spawn`, and `task:subagent:lifecycle`. A shared coordinator joins final subagent IDs to child sessions. Only `ctx.agent.kind === "main"` can bind the main plan, draw its progress widget, or change main session attention.

| Variable | Meaning |
| --- | --- |
| `KATA_OMP_EXECUTABLE` | Kata executable; defaults to `kata`. |
| `KATA_REF` | Explicit main parent and main session-attention target. |
| `KATA_AUTHOR`, `KATA_TEAMMATE` | Existing actor and optional main teammate. |
| `KATA_INBOX_USER` | Inbox recipient override. |
| `KATA_OMP_DEBUG` | Optional append-only diagnostic log. |

The todo tool supports `init`, `append`, `start`, `block`, `unblock`, `done`, `drop`, `rm`, `view`. `/todo` supports `start`, `done`, `drop`, `rm`, `append`, `block`, and `unblock`; with no subcommand it shows the plan. Phases and task refs are retained in Kata. Local plans and queued close retries persist in custom session entries and resume with a saved session. Explicit `/todo done` records the user's completion attestation as external evidence. Removed items are retired, never deleted.

The plugin matches each delegation (the task item's `name`, `task` and the lifecycle `description`) against the plan when the subagent starts, so a `task` call sent in the same batch as `todo init` still binds. An open task named verbatim, by qualified ref or by bare short id wins. Otherwise the task with a clear weighted word overlap wins, its leading verb counted twice and the lead's active task at half weight. The active task is the fallback only for an explicit "current task" handoff. Batch tasks match by index. If no task matches, a separate child is created. One task cannot have two delegates, and a delegated task never occupies the lead's active slot. Main todo mutations cannot complete a running delegate's task: the child closes itself and `view` reloads Kata state. Delegate teammates derive from the agent id and session.

Subagents receive the cached contract, exact issue, teammate, and close command. Recognized standalone Kata Bash commands gain teammate and binding flags; actor impersonation is refused. A delegate that finishes without closing its issue gets `omp.status`, `needs-review`, one idempotent comment and a `kata notify` to the lead; a plan task is handed back to the lead's teammate so the lead can verify and close it, which removes `needs-review`. Terminal outcomes never write the delegate's `work.*` or infer a close from shell text.

Hooks have a 250 ms foreground budget; explicit todo operations await actual results. Main session attention for a `KATA_REF` session checks the actor and teammate, then runs `kata agent-hook attention-native pi start|end --session <id> --host-pid <pid> --ref <ref>`; Kata owns the token and transitions. Conflicting writes are preserved. See [closing rules](closing-rules.md).
