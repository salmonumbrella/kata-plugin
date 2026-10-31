# Changelog

## oh-my-pi 2.2.0 / pi 1.2.0 — 2026-10-31

Installing the oh-my-pi plugin now makes Kata the only todo system, in every folder, with no setup.

- **Takes over omp's todo.** The `todo.enabled: false` step is gone. The plugin's tool replaces the built-in one, and its results carry the plan under `details.kata` instead of `details.phases`, so omp's own reminders, mid-run nudge and HUD have nothing to track. `todo.enabled: false` keeps working.
- **No silent session-local plans.** A folder with no Kata project plans in `KATA_DEFAULT_PROJECT` (issues labeled with the repo), or in its inferred project, registered with `kata projects create` (no `kata init`, no files in the repo). `project_not_initialized` no longer produces a local plan.
- **Outages degrade visibly.** If Kata is unusable (missing executable, unreachable daemon) the plan is session-local with one warning per session, and it replays into Kata when Kata returns.
- **Lazy parent.** The automatic session parent is created on the first todo mutation, so a session that never plans leaves no issue.
- **No double contract.** The omp plugin skips its contract if the system prompt already carries it.
- The pi adapter shares the resolution, lazy parent and replay changes. Claude Code is unchanged.
- Breaking for scripts reading `details.phases` from omp `todo` results: use `details.kata.phases`.
