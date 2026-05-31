# pi-powertoys

A curated collection of standalone [Pi](https://github.com/earendil-works/pi-coding-agent) extensions. Each active toy is a single TypeScript file under `toys/` — add only the toys you want to the package entry in `settings.json`.

## Active toys

| Toy | Command | What it does |
| --- | --- | --- |
| **compact-model** | `/compact-model` | Offloads context compaction to a different model. Pick any available model from a TUI selector — ideal for fast, cheap models with large context windows. |
| **speedtest** | `/speedtest` | Benchmarks the active model's TTFT, tokens/sec, and total latency. Supports Anthropic, OpenAI completions, and OpenAI responses APIs. |
| **context-enforcer** | — | Truncates large bash output and hard-blocks raw HTTP clients (`curl`, `wget`) in favor of context-mode tools. |
| **session-guard** | — | Adds safety/coaching hooks from real session failures: broken extension symlink warnings, bash cwd/git/rm preflights, benign bash error reclassification, edit anchor mismatch hints, and provider error notices. |
| **context** | `/context` | Shows current context usage — token count, context window, percentage, and a visual progress bar. Warns when nearing the limit. |
| **color** | `/color` | Tags sessions with a color label so multiple terminals are easier to distinguish. Persists across resume. |
| **circuit-breaker** | `/circuit-breaker` | Stops compaction thrash loops. If compaction fires N times within M minutes, blocks further compaction and warns. |
| **contextual-working** | `/working-style`, `/working-indicator` | Replaces generic "Working..." with context-aware messages based on the active tool. Interactive TUI pickers for style and spinner. Persists across restarts. |
| **intent-tracer** | — | Injects `_i` intent fields into tool schemas so the model declares what it is trying to accomplish before each tool call. Requires the post-install patch below. |
| **json-guard** | — | Validates JSON files after write/edit and warns the model immediately if syntax is broken. |
| **agent-steer** | `/steer` | Intercepts mid-turn messages with steer / queue / discard / edit single-keypress prompt. `/steer <text>` bypasses the prompt and injects directly. |
| **sys-prompt** | `/sys-prompt` | Session-scoped system-prompt snippet manager. Appends fenced additions to every turn and persists across `/reload` and fork. |
| **context-viewer** | `/system-prompt-data`, `/total-context-data` | Scrollable overlay of the full system prompt or entire LLM context. Live `/` search, `n`/`N` navigation, `y` clipboard copy. |
| **ultrathink** | `/ultrathink`, `alt+u` | Detects "ultrathink" as you type and toggles a status flag; pi-hud renders it as a rainbow chip. |
| **kitty-attention** | `/kitty-attention` | Sends Kitty terminal OSC 99 desktop popups and/or terminal bell when a Pi turn finishes, `ask_user` asks a question, or common approval/interactive tools need user attention. |
| **lint** | `/lint` | Auto-detects linting for Pi extension TypeScript/JavaScript via Biome or Python projects via Ruff. Use cautiously with `--fix` because it mutates files. |

## Archived toys

The repo keeps retired toys under `archive/toys/` for reference, but they are not loaded by `package.json` or the local `settings.json` allowlist:

- `archive/toys/claude-commands.ts` — legacy `.claude/commands` bridge; Pi prompt templates and skills are preferred.
- `archive/toys/init.ts` — generic project bootstrap; PMTI project/milestone/task/implementation flow is preferred.
- `archive/toys/narrate.ts` — novelty narration styles; not part of the core workflow.
- `archive/toys/quick-resume.ts` — redundant with Pi session resume/history workflows.
- `archive/toys/session-recap.ts` — overlaps with `pi-memory`, compaction summaries, and planned open-loop dashboards unless reintegrated deliberately.

## Install

```shell
pi install git:github.com/DarkoKuzmanovic/pi-powertoys
```

Then restart Pi or run `/reload`.

### Load individual toys

Add just the ones you want to the `extensions` array in your `settings.json` package entry. This local setup uses an explicit allowlist, so adding a toy to `package.json` alone is not enough.

### Install individual toys

Each active toy is a standalone `.ts` file. Symlink just the ones you want:

```bash
ln -sfn ~/.pi/agent/git/github.com/DarkoKuzmanovic/pi-powertoys/toys/speedtest.ts \
  ~/.pi/agent/extensions/speedtest.ts
```

## Configuration

Persistent toy settings are stored in a single file: `~/.pi/agent/cache/pi-powertoys/toys.json`.

| Key | Toy | Example value |
| --- | --- | --- |
| `compactModel` | compact-model | `{ "provider": "wafer", "model": "Qwen3.5-397B-A17B" }` |
| `contextualWorking` | contextual-working | `{ "messageStyle": "dynamic", "indicator": "braille" }` |
| `kittyAttention` | kitty-attention | `{ "enabled": true, "popup": true, "bell": true, "notifyOnDone": true }` |

Legacy `~/.pi/agent/toys.json` and older per-toy JSON files are automatically migrated into `cache/pi-powertoys/toys.json` on first load and removed.

Run the relevant `/command` to change any setting via TUI picker, or edit `cache/pi-powertoys/toys.json` directly.

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

The **intent-tracer** toy injects an `_i` intent field into tool calls, but Pi's validation layer rejects unknown fields before any extension hook can strip them. The `bin/pi-patcher` script patches `validateToolArguments()` in `pi-ai` to strip `_i` automatically.

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
