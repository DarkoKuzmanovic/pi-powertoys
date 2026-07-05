# pi-powertoys

A curated collection of standalone [Pi](https://github.com/earendil-works/pi-coding-agent) extensions. Each active toy is a single TypeScript file under `toys/` — add only the toys you want to the package entry in `settings.json`.

## Active toys

| Toy | Command | What it does |
| --- | --- | --- |
| **compact-model** | `/compact-model` | Offloads context compaction to a different model. Pick any available model from a scrolling, filterable TUI selector (windowed like pi's `/model`) — ideal for fast, cheap models with large context windows. |
| **speedtest** | `/speedtest` | Benchmarks the active model's TTFT, tokens/sec, and total latency. Supports Anthropic, OpenAI completions, OpenAI responses, and OpenAI Codex Responses APIs. |
| **startup-benchmark** | `/startup-benchmark` | Benchmarks harness *startup* (extension-load cost), not model latency. Times repeated `pi … --mode rpc` boots that exit on stdin EOF — the non-interactive `/exit` path, so no model is prompted. Default `delta` mode compares floor (`-ne`) vs full boot; `isolate` mode measures each extension alone (`-ne -e <entry>`) to find the culprit. Appends JSONL rows (with hostname) to `~/.pi/agent/cache/pi-powertoys/startup-benchmark.jsonl`. |
| **context** | `/context` | Shows a 10×10 dot-grid breakdown of context usage by category (system prompt, user, assistant, tool results, free space), turn/tool-call/compaction stats, and cumulative reasoning-token count when the model reports thinking tokens. |
| **contextual-working** | `/working-style`, `/working-indicator` | Replaces generic "Working..." with context-aware messages based on the active tool. Interactive TUI pickers for style and spinner. Persists across restarts. |
| **intent-tracer** | — | Injects `_i` intent fields into tool schemas so the model declares what it is trying to accomplish before each tool call. Requires the post-install patch below. |
| **agent-steer** | `/steer` | Intercepts mid-turn messages with steer / queue / discard / edit single-keypress prompt. `/steer <text>` bypasses the prompt and injects directly. |
| **context-viewer** | `/system-prompt-data`, `/total-context-data` | Scrollable overlay of the full system prompt or entire LLM context. Live `/` search, `n`/`N` navigation, `y` clipboard copy. |
| **ultrathink** | `/ultrathink`, `alt+6` | Detects "ultrathink" as you type and toggles a status flag; pi-hud renders it as a rainbow chip. |
| **kitty-attention** | `/kitty-attention` | Sends Kitty terminal OSC 99 desktop popups and/or terminal bell when a Pi turn finishes, `ask_user` asks a question, or common approval/interactive tools need user attention. |
| **lint** | `/lint` | Auto-detects linting for Pi extension TypeScript/JavaScript via Biome or Python via Ruff. Use cautiously with `--fix` because it mutates files. |
| **shortcut-help** | `/shortcuts`, `alt+1` | Floating cheat sheet with two tabs — local shortcuts + slash commands, and the prompt gallery; Tab cycles tabs. |

## Archived toys

The repo keeps retired toys under `archive/toys/` for reference, but they are not loaded by `package.json` or the local `settings.json` allowlist:

- `archive/toys/claude-commands.ts` — legacy `.claude/commands` bridge; Pi prompt templates and skills are preferred.
- `archive/toys/init.ts` — generic project bootstrap; PMTI project/milestone/task/implementation flow is preferred.
- `archive/toys/narrate.ts` — novelty narration styles; not part of the core workflow.
- `archive/toys/quick-resume.ts` — redundant with Pi session resume/history workflows.
- `archive/toys/session-recap.ts` — overlaps with `pi-memory`, compaction summaries, and planned open-loop dashboards unless reintegrated deliberately.

## Moved to pi-guardian

The always-on safety hooks formerly shipped as `context-enforcer`, `session-guard`, `circuit-breaker`, and `json-guard` now live in `../pi-guardian`. Powertoys keeps interactive/productivity toys; guardian owns deterministic session-protection hooks.

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

Legacy `~/.pi/agent/toys.json` and older per-toy JSON files are automatically migrated into `cache/pi-powertoys/toys.json` on first load and removed. The former `circuitBreaker` setting is copied by `pi-guardian` into `~/.pi/agent/cache/pi-guardian/guardian.json` on first use.

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
