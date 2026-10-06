# Pi reference

Package: `kata-pi`; portable entry: `plugins/pi/kata.ts`. The repository root has a `pi.extensions` shim for Git installation. Pi supplies TypeBox and its extension API through declared peers. The entry exits under OMP before loading TypeBox.

| Event/surface | Behavior |
| --- | --- |
| `session_start` | Restore saved plans/retries or child binding; retain the native attention baseline and clear inherited `KATA_REF`. Export the child-process marker. |
| `session_tree`, `session_shutdown` | Reload/drain reconciliation; unfinished children request review on their own issues. |
| `before_agent_start` | Bind inherited child work, inject its contract and exact issue/teammate/close command, or add the main plan and fallback context. |
| `agent_before_settle` | Add a hidden continuation for actionable unfinished main work, within a three-reminder progress budget. Questions, blockers, aborts and errors suppress it. |
| `tool_call` | Ensure a parent before tools can launch children; mutate Bash input in place to route bare `kata` and enforce child teammate attribution. Refuse child `--as`. |
| `tool_result` | Observe successful standalone main claims; ignore failed results. |
| `registerCommand("todo")`, `input` | Provide `/todo` and visible command replies. |

`KATA_PI_EXECUTABLE` selects the executable, falling back to `KATA_OMP_EXECUTABLE`, then `kata`. Debug output uses `KATA_PI_DEBUG`, with `KATA_OMP_DEBUG` as fallback. Existing actor identity is preserved. Explicit executable paths and quoted data are not rewritten.

Main sessions export `KATA_PI_PARENT` with their process/session identity, qualified parent ref, workspace, and teammate seed. A child Pi process inherits that marker, retains the actor, derives a distinct teammate, and sets its own inbox recipient. A prompt naming an open plan task by content or qualified ref binds that task; otherwise one available active task is used, or one separate child issue is created. Revision guards prevent two children from taking the same task. Main todo mutations cannot complete delegated tasks: the child closes itself and `view` reloads Kata state. Saved child bindings retain identity when resumed.

The main process clears `KATA_REF` from its environment after preserving the native adapter's captured baseline (or preseeding that same baseline if this plugin runs first). Its own explicit plan binding remains pinned. Children therefore cannot make native startup/shutdown change lead attention. Use the supplied qualified binding for child scripts rather than assuming inherited `KATA_REF`. The native registry controls [contract coexistence](../how-to/use-with-kata-agent-hooks.md); children always receive their own binding and contract.

Todo operations match the [OMP plan](oh-my-pi.md). Local plans and pending close retries persist in session custom entries and resume with the saved session. Children manage their own issues instead of mutating the main todo plan. Automatic parents reconcile from actual Kata children and accepted close evidence; explicit parents remain the lead's responsibility. See [closing rules](closing-rules.md) and [limits](../explanation/limits.md).
