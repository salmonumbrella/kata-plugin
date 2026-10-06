# Kata Plugin

Kata work tracking for Claude Code, oh-my-pi, and pi. Delegated work and todo plans become Kata issues with attributed ownership and evidence for completion. Kata validates each close; automatic session parents close after their children finish.

| Plugin | Tracks |
| --- | --- |
| [Claude Code](docs/reference/claude-code.md) | Delegated agents and local/remote workflow runs |
| [oh-my-pi](docs/reference/oh-my-pi.md) | Todo plans and task subagents |
| [pi](docs/reference/pi.md) | Todo plans and child Pi processes |

Claude Code:

```text
/plugin marketplace add salmonumbrella/kata-plugin
/plugin install kata@kata-plugin
```

Or, with a local clone, `skillshare plugin add ./kata-plugin/plugins/claude-code --target claude -g`.

Oh-my-pi:

```sh
omp plugin marketplace add salmonumbrella/kata-plugin
omp plugin install kata@kata-plugin
```

Disable its built-in todo with `todo.enabled: false` in the YAML config.

Pi:

```sh
pi install git:github.com/salmonumbrella/kata-plugin
# or, from a local clone:
pi install ./kata-plugin/plugins/pi
```

Requires Kata 0.18 for these plugins, plus the selected harness. Native attention through `kata agent-hook` requires Kata 0.19. The Claude function-hook API must be available; tested host versions are Claude Code 2.1.291, oh-my-pi 18.6.3, and pi 1.0.2. Bun and Node are needed for development.

Start with the [first session tutorial](docs/tutorials/first-session.md), [installation guide](docs/how-to/install.md), or [development guide](docs/development.md). See [completion rules](docs/reference/closing-rules.md) and [limits](docs/explanation/limits.md) before adopting automatic closure.
