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

A delegated prompt naming an open task verbatim or by qualified ref binds that issue. Otherwise, a single delegation uses the active task. Batch tasks match by index. If no task matches, a separate child is created. One task cannot have two delegates. Main todo mutations cannot complete delegated tasks: the child closes itself and `view` reloads Kata state.

Subagents receive the cached contract, exact issue, teammate, and close command. Recognized standalone Kata Bash commands gain teammate and binding flags; actor impersonation is refused. Terminal outcomes update observation metadata and mark unfinished work for review. They never write the delegate's `work.*` or infer a close from shell text.

Hooks have a 250 ms foreground budget; explicit todo operations await actual results. Guarded main attention uses actor, teammate, session tokens, and revision/value checks. Conflicting writes are preserved. See [closing rules](closing-rules.md).
