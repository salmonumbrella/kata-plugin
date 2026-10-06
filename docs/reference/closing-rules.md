# Closing rules

Kata is the final validator. Todo `done` requires a substantive message of at least 40 characters and typed evidence. Wontfix retirement requires a task-specific reason of at least 60 characters. The displayed task becomes completed or abandoned only after Kata accepts the close. Throttled closes remain pending and retry; unavailable or rejected evidence is never invented.

An automatic parent closes only when every current Kata child is closed, required delegation has finished, and the adapter's settlement barriers are satisfied. The adapter reads each child's current close event, unions its typed evidence, then rereads membership and revisions before the guarded parent close. Wontfix children count as closed but supply no proof. Missing/empty evidence or a rejected union leaves the parent open with `needs-review`. Explicit parents never auto-close. New work may reopen an automatic parent.

## Claude child fallback

Prefer the delegate's own Kata close. For an open child, the Claude fallback requires fresh observed commit, created PR, or passing test/typecheck evidence after the last repository write. Reads do not verify work. Failed checks, interrupted tools, unresolved write paths, possibly mutating commands, and incomplete final reports veto the fallback. A later HEAD lookup cannot invent commit proof. Known external writes preserve scope; physical aliases back into the repository still count.

Documentation-only writers can supply their own explicit verification with reviewed paths. Every observed write must qualify as documentation; code/config/test writes veto this exception. Workflow completion instead uses each writing contributor's own verified result and reported repository files. A container's blanket claim cannot certify unverified nested writers.

This fallback still exists for Claude children. OMP delegates close themselves. Automatic-parent completion in every adapter trusts Kata close records and never reconstructs proof from shell commands.
