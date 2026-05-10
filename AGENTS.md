# pi-powertoys

A collection of standalone Pi extensions ("toys"). Each toy is a single TypeScript file that plugs into Pi's extension API.

## Project structure

```
toys/           # All extension source files — one .ts file per toy
install.sh      # Symlinks all toys into ~/.pi/agent/extensions/
uninstall.sh    # Removes symlinks
```

## Extension anatomy

Every toy exports a default function that receives `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function myToy(pi: ExtensionAPI) {
  // Subscribe to events with pi.on(...)
  // Register commands with pi.registerCommand(...)
  // Register tools with pi.registerTool(...)
}
```

### Key APIs

- **`pi.on(event, handler)`** — lifecycle hooks: `session_start`, `tool_call`, `session_before_compact`, etc.
- **`pi.registerCommand(name, { description, handler })`** — slash commands (`/speedtest`, `/compact-model`).
- **`pi.registerTool({ name, description, schema, handler })`** — tools callable by the LLM.
- **`ctx.ui.*`** — user interaction: `select()`, `confirm()`, `input()`, `notify()`, `custom()`.
- **`pi.appendEntry()`** — persist state across restarts.

### Configuration pattern

Toys that need persistent config use a JSON file in `~/.pi/agent/`:

```typescript
const CONFIG_PATH = join(homedir(), ".pi", "agent", "<toy-name>.json");
```

Load with defaults, save on change. Always handle missing/corrupt files gracefully.

## Current toys

| File | Slash command | Purpose |
|------|--------------|---------|
| `compact-model.ts` | `/compact-model` | Offloads compaction to a user-selected model |
| `speedtest.ts` | `/speedtest` | Benchmarks active model (TTFT, tok/s, latency) across Anthropic, OpenAI completions, and OpenAI responses APIs |
| `context-enforcer.ts` | — | Truncates large output (multi-line and single-line blobs), blocks raw HTTP clients |
| `session-guard.ts` | — | Adds safety/coaching hooks for broken extension symlinks, bash cwd/git/rm preflights, benign bash error reclassification, edit anchor mismatch hints, and provider error notices |
| `claude-commands.ts` | `/claude-commands` | Imports `.claude/commands/*.md` (including subdirectories) as Pi slash commands |
| `quick-resume.ts` | — | Prints `pi --session <id>` on exit for easy resume |
| `session-recap.ts` | `/recap`, `/recap-config` | Generates session recap on idle return or demand |
| `circuit-breaker.ts` | `/circuit-breaker` | Stops compaction thrash loops (N compactions in M minutes) |
| `context.ts` | `/context` | Shows token usage, context window %, and visual progress bar |
| `color.ts` | `/color` | Tags sessions with a color label in the footer |
| `init.ts` | `/init` | Generates Pi-aware AGENTS.md with tool hierarchy, reading rules, and architecture guidance |

## Conventions

- **One file = one toy.** No multi-file extensions. Keep dependencies to Node built-ins and Pi packages.
- **Self-contained.** Each toy works independently — no imports between toys.
- **Graceful defaults.** Config files are optional; toys work out of the box with sensible defaults.
- **TUI for config.** Use `ctx.ui.select()` / `ctx.ui.input()` for configuration, not manual file editing.
- **Pi packages only.** Only `node:*` built-ins and `@earendil-works/*` packages (`pi-coding-agent`, `pi-ai`, `pi-tui`). No third-party dependencies.

## Pi extension docs

Full API reference: `~/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

Check `~/.pi/agent/model-prompts/` for model-specific delegation and workflow guidance before starting complex work.
