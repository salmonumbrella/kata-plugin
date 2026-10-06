# Metadata and labels

These keys describe observed execution and plan state. `work.*` belongs to the current writer; closed issues do not receive `work.*` updates.

| Keys | Purpose |
| --- | --- |
| `claude.auto_parent`, `omp.auto_parent`, `pi.auto_parent` | Typed boolean granting automatic-parent authority. Explicit bindings revoke that authority locally. |
| `claude.session_id`, `omp.session_id`, `pi.session_id` | Session identity for recovery and idempotency. |
| `claude.workspace`, `omp.workspace`, `pi.workspace` | Pinned original workspace. |
| `claude.tool_use_id`, `claude.agent_type`, `claude.teammate`, `claude.agent_id` | Delegated Agent attribution and native join. |
| `claude.workflow_run_id`, `claude.task_id`, `claude.workflow_name`, `claude.workflow_remote` | Local/remote workflow run identity. |
| `claude.status` | Observed running, completed, failed, killed, denied, or session-ended state; a pending denied close can use `denied-close-pending`. |
| `pi.subagent_id` | Child Pi session identity and task reservation. |
| `omp.subagent_id`, `omp.parent_agent_id`, `omp.status` | OMP delegation identity and outcome. |
| `todo.phase`, `todo.status`, `todo.removed` | Phase and plan state: pending, in_progress, blocked, completed, or abandoned. `todo.removed` is a separate boolean. |
| `work.attention`, `work.attention_msg`, `work.attention_session` | Guarded attention state where the adapter owns that transition. |

Labels `claude-session`, `omp-session`, and `pi-session` identify session parents. `needs-review` marks unverified work or rejected automatic closure. The automatic marker must be boolean `true`, not the string `"true"`.

A status report is not a close. Kata issue status and accepted close-event evidence determine completion. Qualified refs and original project/workspace routing are retained separately from display text.
