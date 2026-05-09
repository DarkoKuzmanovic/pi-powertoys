# pi-powertoys

A collection of standalone [Pi](https://github.com/earendil-works/pi-coding-agent) extensions. Each toy is a single file — install them all or pick what you need.

## Toys

| Toy | Command | What it does |
|-----|---------|-------------|
| **compact-model** | `/compact-model` | Offloads context compaction to a different model. Pick any available model from a TUI selector — ideal for fast, cheap models with large context windows. |
| **speedtest** | `/speedtest` | Benchmarks the active model's TTFT, tokens/sec, and total latency. Supports Anthropic, OpenAI completions, and OpenAI responses APIs. |
| **context-enforcer** | — | Truncates large bash output (both multi-line and single-line blobs like minified JSON) to save context tokens. Hard-blocks raw HTTP clients (`curl`, `wget`) in favor of context-mode tools. |
| **claude-commands** | `/claude-commands` | Reads `.claude/commands/*.md` files (including subdirectories) and registers them as Pi slash commands. Works with both project-local and global commands. |
| **quick-resume** | — | Prints a `pi --session <id>` command on exit so you can resume the session from your shell history. |
| **session-recap** | `/recap`, `/recap-config` | Generates a session recap on idle return or on demand. Reorients you after being away — what's in progress, what's pending. |
| **context** | `/context` | Shows current context usage — token count, context window, percentage, and a visual progress bar. Warns when nearing the limit. |
| **color** | `/color` | Tags sessions with a color label (footer indicator) so you can visually distinguish multiple terminals. Persists across resume. |
| **circuit-breaker** | `/circuit-breaker` | Stops compaction thrash loops. If compaction fires N times within M minutes, blocks further compaction and warns. |
| **history** | `/history`, `/search` | Browse all sessions across every project and full-text search past conversations. Dual-action picker: Enter previews, Ctrl+O switches. |
| **init** | `/init` | Generates a Pi-aware AGENTS.md for any project — tool hierarchy, file reading rules, architecture principles, subagent guidance. Detects project type and Pi docs path. |

## Install

```bash
git clone https://github.com/DarkoKuzmanovic/pi-powertoys.git \
  ~/.pi/agent/git/github.com/DarkoKuzmanovic/pi-powertoys
cd ~/.pi/agent/git/github.com/DarkoKuzmanovic/pi-powertoys
chmod +x install.sh && ./install.sh
```

Then restart Pi or run `/reload`.

### Install individual toys

Each toy is a standalone `.ts` file. Symlink just the ones you want:

```bash
ln -sfn ~/.pi/agent/git/github.com/DarkoKuzmanovic/pi-powertoys/toys/speedtest.ts \
  ~/.pi/agent/extensions/speedtest.ts
```

## Configuration

### compact-model

Stores its selected model in `~/.pi/agent/compact-model.json`:

```json
{
  "provider": "wafer",
  "model": "Qwen3.5-397B-A17B"
}
```

Run `/compact-model` to change it via TUI, or delete the file to disable.

## Uninstall

```bash
cd ~/.pi/agent/git/github.com/DarkoKuzmanovic/pi-powertoys
chmod +x uninstall.sh && ./uninstall.sh
```

## License

MIT
