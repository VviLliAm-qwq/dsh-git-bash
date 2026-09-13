# dsh-git-bash

[![ci](https://github.com/VviLliAm-qwq/dsh-git-bash/actions/workflows/ci.yml/badge.svg)](https://github.com/VviLliAm-qwq/dsh-git-bash/actions/workflows/ci.yml)

**English** · [中文](README.zh.md)

Make a **Git for Windows** installation resolvable as `bash` inside the dsh
host process, so the official bash shell stack can run on Windows.

## The problem it solves

dsh ships two shell stacks and gates them by platform: on Windows
`@deepseek-ai/dsh-base` mounts `pwsh-sandbox` + `tool-pwsh` and disables
`bash-sandbox` + `tool-bash`. The bash stack is not disabled for lack of
support — it is disabled because it spawns the **bare name** `bash`:

- the executor runs `["bash", "-c", command]`, and
- the sandbox layer builds its own `["bash", "-c", command]` for the confined
  runner.

Neither place accepts a configurable executable path. A stock Windows PATH does
not resolve `bash`: Git for Windows puts `cmd\git.exe` on PATH, but not
`bin\bash.exe`. So the only seam that reaches both spawn sites is the process
PATH — which is what this plugin edits.

## What it does

On `win32` only, during `apply()`:

1. detects a Git installation (`%ProgramFiles%\Git\bin`,
   `%ProgramFiles(x86)%\Git\bin`, `%LOCALAPPDATA%\Programs\Git\bin`, then
   `C:\Program Files\Git\bin`) and checks that it really holds `bash.exe`;
2. prepends that directory to `process.env.PATH` — but only when `bash` is not
   resolvable already, and never reordering an existing entry;
3. records what it decided in `~/.dsh-tui/dsh-git-bash.log` (bounded: past
   128 KiB the older half is dropped, and `node --test` runs never write it);
4. restores the previous PATH on unload — but only while the value is still its
   own, so a PATH someone else edited afterwards is left alone.

On other platforms it logs `skipped: not win32` and does nothing.

It never throws: a missing installation, an unreadable log or a hostile config
leaves the host exactly as it was.

## Enabling the bash stack: the bundle patch does both halves

A plugin cannot register a tool; it can only make the environment the official
tools need. So this package's own bundle patch does both halves, and installing
the package IS the installation:

```yaml
- insert:
    - id: dsh-git-bash
      name: 'dsh-git-bash'
- id: bash-sandbox      # enabled (config restated: a patch replaces it whole)
  disabled: false
- id: pwsh-sandbox      # disabled
  disabled: true
- id: tool-bash         # enabled -> the `bash` tool appears
  disabled: false
- id: tool-pwsh         # disabled
  disabled: true
```

Both stacks provide `ctx.shell`, so exactly one may mount: this is a swap, not
an addition. `pwsh` remains reachable from bash (`powershell -Command '…'`) if
you need it.

**Reverting is removing the bundle** (`dsh plugin --profile <p> remove
dsh-git-bash`): every override above disappears with it and the platform gating
in `@deepseek-ai/dsh-base` applies again.

> **Do not put this swap in a LIVE profile's own `cordis.patch.yml` instead.**
> That file is watched by `patchReload: live`, so editing it re-configures
> running sessions immediately — before this plugin's row is loaded, which
> leaves them with a shell stack that cannot spawn `bash`. A bundle patch is
> read at boot, which is the order this needs.

## Install

```sh
dsh plugin --profile dsh-tui add file:/absolute/path/to/dsh-git-bash
```

Then restart the TUI (`/restart`) and confirm the composition before trusting
it:

```sh
dsh --profile dsh-tui --dump-config    # composes the tree without starting the UI
```

## Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `gitBinDir` | string | `""` | Directory holding `bash.exe`. Empty = auto-detect. When set, it is the only candidate — a typo is reported instead of being papered over. |

Set it on the plugin's row when detection cannot find your installation:

```yaml
- id: dsh-git-bash
  config:
    gitBinDir: 'D:\PortableGit\bin'
```

## Known limitations

- **This enables a platform-gated stack.** dsh disables the bash rows on Windows
  by design; this plugin removes the reason it cannot work, but that composition
  is not one upstream tests. Keep the `.bak` of your `cordis.patch.yml`: rolling
  back is deleting the four override lines above.
- **Sandbox modes are the untested part.** With `danger-full-access` the
  executor skips the confinement wrapper entirely, which is what has been
  exercised here. Under `workspace-write` the sandbox layer wraps the command in
  the Windows ACL restricted-token runner — a path built for POSIX. Treat
  confined modes as unverified.
- A plugin cannot add tools; it can only make the environment the official tools
  need. If the bash rows are not enabled, this plugin changes nothing visible.
- The PATH edit is process-wide inside the host process, which is exactly the
  point: every consumer resolving `bash` (the agent's own commands included)
  benefits.

## Development

```sh
pnpm install
pnpm test              # node:test unit tests (pure discovery/PATH rules)
pnpm check:encoding    # no UTF-8 BOM / damaged sequences / tab indentation
pnpm verify            # both, in order
```

The tests are pure and injectable: `resolveBinDir` takes its environment and its
existence probe as arguments, so the discovery rules are pinned without touching
the machine. The win32 cases exercise the real installation when one is present
and skip otherwise.

## Diagnostics

`~/.dsh-tui/dsh-git-bash.log` holds one line per decision: the detected
directory, `already resolvable`, `PATH left unchanged`, the unload restore (or
`PATH left alone: it changed after this plugin`). Every message is also sent to
the host logger.

## Publishing

- **Repository**: <https://github.com/VviLliAm-qwq/dsh-git-bash> (public)
- **Release**: `v*` tags drive `.github/workflows/release.yml`, which publishes to npm through **trusted publishing (OIDC)** — no token is stored in the repository.

## License

MIT.
