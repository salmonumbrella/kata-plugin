# Closing rules

Kata is the final validator. Todo `done` requires a substantive message of at least 40 characters and typed evidence. Wontfix retirement requires a task-specific reason of at least 60 characters. The displayed task becomes completed or abandoned only after Kata accepts the close. Throttled closes remain pending and retry only while their saved issue revision and requested action still apply. A valid instruction replacing that task’s intent cancels a superseded retry. Re-listing the same task preserves a promised completion; explicitly keeping a task cancels its pending removal. Starting another task or rejecting invalid input preserves the promised close; unavailable or rejected evidence is never invented.

OMP and Pi check the current actor, exact teammate, and issue revision before task changes, including completion, retirement, and replay. A rejected ownership or revision check preserves the other writer’s state. Session-local plans (kept only while Kata is unreachable) skip Kata writes until they replay; a Kata project whose name starts with `local-` still requires normal ownership and evidence.

An automatic parent closes only when every current Kata child is closed, required delegation has finished, and the adapter's settlement barriers are satisfied. The adapter bounds the close audit by the current children’s close times, reads each exact close event, unions its typed evidence, then rechecks the parent’s ownership, membership, and revisions before the guarded parent close. Wontfix children count as closed but supply no proof. Missing/empty evidence or a rejected union leaves the parent open with `needs-review`. Explicit parents never auto-close. New work may reopen an automatic parent.

## Claude child fallback

Prefer the delegate's own Kata close. For an open child, the Claude fallback requires fresh observed commit, created PR, or passing test/typecheck evidence after the last repository write. Reads do not verify work. Failed checks, interrupted tools, unresolved write paths, possibly mutating commands, and incomplete final reports veto the fallback. A later HEAD lookup cannot invent commit proof. Known external writes preserve scope; physical aliases back into the repository still count.

Documentation-only writers can supply their own explicit verification with reviewed paths. Every observed write must qualify as documentation; code/config/test writes veto this exception. Workflow completion instead uses each writing contributor's own verified result and reported repository files. A container's blanket claim cannot certify unverified nested writers.

This fallback still exists for Claude children. OMP and pi delegates close themselves; one that finishes without closing hands its plan task back to the lead with `needs-review`, and the lead's own accepted close then removes the label. Automatic-parent completion in every adapter trusts Kata close records and never reconstructs proof from shell commands.
