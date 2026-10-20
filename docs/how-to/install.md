# Install

Install Kata 0.19 or later and initialize the intended project with `kata init --project example`. These plugins use `agent-contract-hook`, revision guards, typed evidence, `audit closes`, and `events`.

## Claude Code

```text
/plugin marketplace add /path/to/kata-plugin
/plugin install kata@kata-plugin
```

Restart Claude. For one session, use `claude --plugin-dir /path/to/kata-plugin/plugins/claude-code`. The manifest name and all state contracts are `kata`.

Skillshare can copy the complete plugin:

```sh
skillshare plugin add /path/to/kata-plugin/plugins/claude-code --target claude -g
```

## Oh-my-pi

```sh
omp plugin marketplace add /path/to/kata-plugin
omp plugin install kata@kata-plugin
```

Set this in your OMP YAML configuration and restart:

```yaml
todo:
  enabled: false
```

To try it without installing:

```sh
omp --no-extensions --config /path/to/notodo.yml -e /path/to/kata-plugin/plugins/oh-my-pi/kata.ts
```

## Pi

```sh
pi install /path/to/kata-plugin/plugins/pi
```

The root manifest supports `pi install git:github.com/salmonumbrella/kata-plugin`. Pi 1.0.2 cannot select a repository subdirectory through a Git URL; appending `/plugins/pi` changes the clone URL. Use the root shim or a local plugin directory.

For one run: `pi --no-extensions -e /path/to/kata-plugin/plugins/pi/kata.ts`. Remove any other todo extension first. Keep each plugin directory intact: its adjacent `kata-core.ts` is required. Do not overwrite the native adapter at the user extension path `kata.ts`.

Both marketplaces identify the plugin as `kata@kata-plugin`. The npm package names `kata-omp` and `kata-pi` identify the portable packages. The root pi shim does not make the OMP package a pi extension.
