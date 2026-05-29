# pi-powertoys

A collection of standalone [Pi](https://github.com/earendil-works/pi-coding-agent) extensions. Each toy is a single TypeScript file — add them to your `settings.json` to load.

## Toys

| Toy                  | Command                       | What it does                                                                                                                                                                                                      |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **compact-model**    | `/compact-model`              | Offloads context compaction to a different model. Pick any available model from a TUI selector — ideal for fast, cheap models with large context windows.                                                         |
| **speedtest**        | `/speedtest`                  | Benchmarks the active model's TTFT, tokens/sec, and total latency. Supports Anthropic, OpenAI completions, and OpenAI responses APIs.                                                                             |
| **crof-models**      | `/crof`                       | Browses Crof AI's available models. Sort by speed, filter by family, and copy the model id for `compact-model` or `settings.json`. Caches the model list locally.                                                  |
| **context-enforcer** | —                             | Truncates large bash output (both multi-line and single-line blobs like minified JSON) to save context tokens. Hard-blocks raw HTTP clients (`curl`, `wget`) in favor of context-mode tools.                      |
| **session-guard**    | —                             | Adds safety/coaching hooks from real session failures: broken extension symlink warnings, bash cwd/git/rm preflights, benign bash error reclassification, edit anchor mismatch hints, and provider error notices. |
| **claude-commands**  | `/claude-commands`            | Reads `.claude/commands/*.md` files (including subdirectories) and registers them as Pi slash commands. Works with both project-local and global commands.                                                        |
| **quick-resume**     | —                             | Prints a `pi --session-id <id>` command on exit so you can resume the session from your shell history.                                                                                                            |
| **session-recap**    | `/recap`, `/recap-config`    | Generates a session recap on idle return or on demand. Reorients you after being away — what's in progress, what's pending.                                                                                       |
| **context**          | `/context`                    | Shows current context usage — token count, context window, percentage, and a visual progress bar. Warns when nearing the limit.                                                                                   |
| **color**            | `/color`                      | Tags sessions with a color label (footer indicator) so you can visually distinguish multiple terminals. Persists across resume.                                                                                   |
| **circuit-breaker**  | `/circuit-breaker`            | Stops compaction thrash loops. If compaction fires N times within M minutes, blocks further compaction and warns.                                                                                                 |
| **init**             | `/init`                       | Generates a Pi-aware AGENTS.md for any project — tool hierarchy, file reading rules, architecture principles, subagent guidance. Detects project type and Pi docs path.                                           |
| **narrate**          | `/narrate`                    | Sets narration style for the session: default, verbose, teaching, caveman, linus, coffey, hemingway, noir, drill-sergeant, or zen. Interactive TUI picker. Persists across restarts.                                 |
| **contextual-working** | `/working-style`, `/working-indicator` | Replaces generic "Working..." with context-aware messages based on the active tool. Interactive TUI pickers for style and spinner. Persists across restarts. Can use AI to generate witty variants. |
| **intent-tracer**    | —                             | Injects `_i` (intent) field into tool schemas so the model declares what it's trying to accomplish before each tool call.                                                                                          |
| **json-guard**       | —                             | Validates JSON files after write/edit — warns the model immediately if syntax is broken so it can fix right away.                                                                                                 |
| **agent-steer**      | `/steer`                      | Intercepts mid-turn messages with steer / queue / discard / edit single-keypress prompt. `/steer <text>` bypasses the prompt and injects directly.                                                                   |
| **sys-prompt**       | `/sys-prompt`                 | Session-scoped system-prompt snippet manager — appends fenced additions to every turn. Persists across `/reload` and fork.                                                                                          |
| **context-viewer**   | `/system-prompt-data`, `/total-context-data` | Scrollable overlay of the full system prompt or entire LLM context. Live `/` search, `n`/`N` navigation, `y` clipboard copy.                                                           |
| **ultrathink**       | `/ultrathink`, `alt+u`         | Detects "ultrathink" as you type in the editor and toggles a status flag; pi-hud renders it as a rainbow chip in the footer. Manual toggle via `/ultrathink` or `alt+u`.                                              |
| **kitty-attention**  | `/kitty-attention`           | Sends Kitty terminal OSC 99 desktop popups and/or terminal bell when a Pi turn finishes, `ask_user` asks a question, or common approval/interactive tools need user attention. |

## Install

```shell
pi install git:github.com/DarkoKuzmanovic/pi-powertoys
```

Then restart Pi or run `/reload`.

### Load individual toys

Add just the ones you want to the `extensions` array in your `settings.json` package entry.

### Install individual toys

Each toy is a standalone `.ts` file. Symlink just the ones you want:

```bash
ln -sfn ~/.pi/agent/git/github.com/DarkoKuzmanovic/pi-powertoys/toys/speedtest.ts \
  ~/.pi/agent/extensions/speedtest.ts
```

## Configuration

All persistent toy settings are stored in a single file: `~/.pi/agent/toys.json`.

Each toy owns a top-level key:

| Key                 | Toy                  | Example value                                                |
| ------------------- | -------------------- | ----------------------------------------------------------- |
| `narrate`           | narrate              | `{ "style": "verbose" }`                                    |
| `compactModel`      | compact-model        | `{ "provider": "wafer", "model": "Qwen3.5-397B-A17B" }`     |
| `recap`             | session-recap        | `{ "idleThresholdMinutes": 30, "enabled": true }`          |
| `contextualWorking` | contextual-working   | `{ "messageStyle": "dynamic", "indicator": "braille" }`    |
| `kittyAttention`    | kitty-attention      | `{ "enabled": true, "popup": true, "bell": true, "notifyOnDone": true }` |

Legacy per-toy JSON files (`narrate-style.json`, `compact-model.json`, `session-recap.json`) are automatically migrated into `toys.json` on first load and removed.

Run the relevant `/command` to change any setting via TUI picker, or edit `toys.json` directly.

### Kitty attention notifications

`kitty-attention` emits Kitty's OSC 99 desktop notification escape code and a terminal bell by default. It notifies on completed LLM turns, `ask_user` questions, and common attention-needed tools such as Obsidian approval prompts and interactive shell overlays.

Configure it with:

```text
/kitty-attention status
/kitty-attention test
/kitty-attention on|off
/kitty-attention popup on|off
/kitty-attention bell on|off
/kitty-attention done on|off
/kitty-attention question on|off
/kitty-attention attention on|off
/kitty-attention expire 8000
```

Popup notifications are only emitted in Kitty (`KITTY_WINDOW_ID` or `TERM` contains `kitty`). Set `PI_KITTY_ATTENTION_FORCE=1` to force OSC 99 output while testing.

## Post-install: intent-tracer patch

The **intent-tracer** toy injects an `_i` (intent) field into tool calls, but Pi's validation layer rejects unknown fields before any extension hook can strip them. The `bin/pi-patcher` script patches `validateToolArguments()` in `pi-ai` to strip `_i` automatically.

```bash
# Check if the patch is needed
bin/pi-patcher --check

# Apply the patch (idempotent — safe to run repeatedly)
bin/pi-patcher

# Force re-apply (e.g. after a Pi update)
bin/pi-patcher --force
```

Run `pi-patcher` after every Pi update — updates overwrite `validation.js` and the patch is lost.

## Uninstall

Remove the package entry from `~/.pi/agent/settings.json` and restart Pi.

## License

MIT
