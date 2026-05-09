# pi-powertoys

A collection of standalone [Pi](https://github.com/mariozechner/pi) extensions. Each toy is a single file — install them all or pick what you need.

## Toys

| Toy | Command | What it does |
|-----|---------|-------------|
| **compact-model** | `/compact-model` | Offloads context compaction to a different model. Pick any available model from a TUI selector — ideal for fast, cheap models with large context windows. |
| **speedtest** | `/speedtest` | Benchmarks the active model's TTFT, tokens/sec, and total latency with a single streaming request. |
| **context-enforcer** | — | Truncates large bash output to save context tokens and hard-blocks raw HTTP clients (`curl`, `wget`) in favor of context-mode tools. |
| **claude-commands** | `/claude-commands` | Reads `.claude/commands/*.md` files and registers them as Pi slash commands. Works with both project-local and global commands. |
| **quick-resume** | — | Prints a `pi --session <id>` command on exit so you can resume the session from your shell history. |

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
