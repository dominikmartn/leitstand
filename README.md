# Leitstand

See disk space, context usage and blocked hooks above your Claude Code prompt.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/loud-dark.gif">
  <img alt="Leitstand above the Claude Code prompt: two jobs running with moving bars, one done, one failed, the disk and a footer that counts everything" src="docs/loud-light.gif" width="696">
</picture>

Leitstand is a mod for Claude Code. It shows above your prompt what Claude Code does not: how much disk is left, how full the context is, and which hook just blocked a tool call. After long work it plays a sound once nothing runs any more. The name is German for control room.

## Install

```sh
claude plugin marketplace add dominikmartn/leitstand
claude plugin install leitstand@leitstand
```

Then start a new session. Leitstand stays out of sight until something needs you. Type `/stand` to open the list any time.

Leitstand needs a Claude Code version with mods (TypeScript plugin hooks). I tested it with Claude Code 2.1.288 on macOS.

## What you see

Each row shows a state, a name, a bar and how much is used. Running agents and shells are not listed, because Claude Code already lists them below the prompt.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/loud-open-dark.png">
  <img alt="Open list: two running jobs, one done, one failed with needs you, the disk at 79 percent" src="docs/loud-open-light.png" width="696">
</picture>

- **needs you**: the disk is running low. The footer counts it in yellow.
- **disk**: free space on this machine. The bar and the percent show how much is used. It warns at 35 GB free and turns red at 20 GB.
- **context**: tokens used of the session's window. From 250k tokens on, the row turns yellow and says `compact`, as a reminder to run `/compact`. Leitstand never compacts by itself.

Type `/stand` to open or close the list. Closing it acknowledges the disk warning. The warning comes back when free space drops to the next level (20 GB).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/loud-warn-dark.png">
  <img alt="Nothing running, but the disk has only 28 GB free and the context is at 527k of 1M" src="docs/loud-warn-light.png" width="696">
</picture>

When a hook of yours blocks a tool call, Leitstand shows the hook's name and its reason until your next prompt.

## Two themes

**loud** is the default. It has halftone bars, always lists the disk and has a footer that counts what needs you.

**quiet** has thin bars and no footer. The disk shows only when it runs low.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/themes-dark.png">
  <img alt="Both themes side by side. Loud closed: one line with 2 running. Loud open: two running jobs, one done, one failed, the disk and a footer. Quiet closed: one line with 2 running. Quiet open: two running jobs with thin bars and the context row." src="docs/themes-light.png" width="912">
</picture>

To use quiet, set the variable before you start Claude Code:

```sh
export LEITSTAND_THEME=quiet
```

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `LEITSTAND_THEME` | `loud` | `loud` or `quiet` |
| `LEITSTAND_DISK_HOST` | unset | Measures the disk of an ssh host instead of this machine, for example a build server |
| `LEITSTAND_SOUND` | on | `off` mutes the sound after long work |

The sound plays on macOS when work took longer than a minute and nothing runs any more. On Linux it stays silent.

The disk host goes to `ssh -o BatchMode=yes`, so it needs key-based login. Leitstand accepts a host name, an ssh alias, an IP address or `user@host`, for example `buildbox`, `10.0.0.5` or `me@nas.local`. Set ports and keys in `~/.ssh/config`. A value with spaces, quotes or a leading dash shows `invalid disk host`, and Leitstand does not fall back to the local disk. When a measurement fails, the last value stays with `stale` next to it.

## For agents

If a user asks you to install, configure or debug Leitstand, these facts apply.

- Type: Claude Code plugin with a hooks module, `hooks/register.tsx`, listed in `hooks/hooks.json`. No MCP server, no skills. The only network call is ssh, and only when `LEITSTAND_DISK_HOST` is set.
- Install: `claude plugin marketplace add dominikmartn/leitstand`, then `claude plugin install leitstand@leitstand`. Add `--scope project` to both for one project only. The user must start a new session.
- Requirements: Claude Code with mods (TypeScript plugin hooks). Tested with 2.1.288 on macOS. Not tested on Linux, where the sound stays off.
- Configure: three environment variables, all optional. `LEITSTAND_THEME` = `loud` (default) or `quiet`. `LEITSTAND_DISK_HOST` = an ssh host, unset means this machine. `LEITSTAND_SOUND` = `off` to mute. Set them in the shell, or in `~/.claude/settings.json` like this: `{ "env": { "LEITSTAND_THEME": "quiet" } }`. A new session picks them up.
- Jobs: not shown. Claude Code lists running agents and shells below the prompt itself. Leitstand still follows `Agent` calls and `Bash` calls with `run_in_background: true` from the main session, only to know when nothing runs any more for the sound. A job ends with its task notification or a `TaskStop`.
- Commands it runs: `sh -c 'df -kP /System/Volumes/Data 2>/dev/null || df -kP /'` every 5 minutes, or the same `df` through `ssh` when `LEITSTAND_DISK_HOST` is set. On macOS, `afplay /System/Library/Sounds/Glass.aiff`.
- State: the disk value is shared between sessions through the plugin store. All other state lives in the session.
- Verify: `claude plugin list` shows `leitstand@leitstand`. In a new session, type `/stand`. A list with the disk row must appear above the prompt, and after Claude's first answer also a context row. `/stand` again closes it. If nothing appears, `claude plugin validate <plugin dir>` lists the hooks Leitstand registers.
- Tests: `claude plugin test .` in the repo.

## Develop

```sh
git clone https://github.com/dominikmartn/leitstand
cd leitstand
CLAUDE_CODE_PLUGIN_DIRS=$PWD claude
claude plugin test .
```

The editor types live in `.claude-plugin/types/`. Claude Code's plugin tooling generates them, and they are not committed.

## Why German

I built this for myself first and called it Leitstand, the word for the room where people watch a power plant or a rail network. It stayed. English has kindergarten and zeitgeist, so it can take one more.

Made by [@dominikmartn](https://x.com/dominikmartn) · MIT license
