# Troubleshoot

| Symptom | Check |
| --- | --- |
| Todo remains local | Run `kata list` from the same folder and check project binding and executable configuration. |
| Close refused | Inspect the actual Kata error, evidence, owner, teammate, and current children. Do not force a completed display state. |
| Parent stays open | Check all current children, pending/running delegates, lead settlement, and `needs-review`. Explicit parents stay open by design. |
| Duplicate todo tool | Disable OMP's native todo or remove another pi todo extension. |
| No visible error | Hooks are deliberately quiet. Enable Claude debug logging, `KATA_OMP_DEBUG`, or `KATA_PI_DEBUG`. |
| Claude typecheck lacks declarations | Load the plugin in an isolated live session first; Claude generates version-specific `.claude-plugin/types/`. |
| Git install cannot find pi subdirectory | Install the repository root shim or clone and install the local `plugins/pi` directory. |
| Pi child changed lead attention | The native attention adapter does not distinguish child processes. Avoid inheriting the lead's `KATA_REF`. |

## Skillshare snapshot ownership conflict

An update can fail when Skillshare stores a local plugin source with `~` but the snapshot owner records its absolute path. In the affected configuration, restore the source to the same absolute spelling used when adding the plugin, then retry the update. Do not delete another source's snapshot or force ownership. A later config save may shorten the path again. This workaround is documented in [runkids/skillshare#461](https://github.com/runkids/skillshare/issues/461).

## Unavailable Kata

Foreground hooks use short deadlines and retain retryable work. Claude persists queued effects; todo close retries are in memory. An outage should leave work open. Correct the route or executable and resume; do not point a test at a normal store to bypass isolation.
