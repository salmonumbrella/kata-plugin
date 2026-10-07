# Claude Code reference

Plugin ID: `kata@kata-plugin`. Entry: `plugins/claude-code/hooks/register.ts`. It uses function hooks and typed state contracts under the `kata` namespace.

| Surface | Behavior |
| --- | --- |
| `session.start`, `classic.SessionStart`, `prompt.submit` | Restore binding, cache contract, recover pending work, record session description. |
| `agent.spawn` | Record launch intent, bind to the issue the spawn names or else create an attributed child, inject contract and close instructions, join native identity. |
| `tool.call`, `turn.start`, `turn.complete` | Observe activity and verification, protect attribution, reconcile terminal work. |
| `session.receive`, `session.append` | Join verified teammate receipts and local/remote workflow results. |
| `classic.Stop`, `session.end` | Respect native work and lead settlement; attempt bounded reconciliation. |
| `command.run` | Handle `/kata`, `/kata bind <ref>`, `/kata unbind`. |

Options in `pluginConfigs.kata.options` (an installed plugin may use the full ID):

| Option | Default | Meaning |
| --- | --- | --- |
| `kataExecutable` | `kata` | Executable name or absolute path. |
| `spawnCreateTimeoutMs` | `3000` | Spawn preparation budget; clamped to 250–30000 ms. |

Other foreground hooks retain short deadlines. Effects persist across reload/resume with pinned project, workspace, session, and execution scope. Transport outages back off from 1 to 60 seconds; close throttles retry after 60 seconds. Debug output goes to Claude's log, without warning UI.

Delegates keep the actor and receive distinct teammates. Recognized Bash invocations receive teammate attribution; `--as` impersonation is refused. Explicit teammate flags remain. Embedded scripts must supply their own binding command. This lexical handling is not a shell sandbox.

A spawn that names an existing open issue is tracked on it rather than a new child; see [bind work to an issue](../how-to/bind-work-to-an-issue.md). On a bound issue the plugin writes only `claude.*` metadata and its report comment; it never closes or labels it. The contract is fetched with `kata agent-contract-hook --source kata-agent-contract-hook`.

The agent should close its own issue. A conservative verification fallback can close an open child; see [closing rules](closing-rules.md). Agent-closed issues retain their reports, labels, closure and `work.*`; only terminal `claude.status` may be updated with a revision guard. Failure, kill, or insufficient proof leaves open work with `needs-review`.

Local and remote Workflow runs get one attributed issue per run, joined by the native task ID. Remote completion updates status and requests review; remote paths do not verify the local checkout. Own verified writer results supply reviewed-path evidence. Idle teammates require a joined final receipt; idle alone is not completion. Automatic parents also wait for lead settlement and all current Kata children.
