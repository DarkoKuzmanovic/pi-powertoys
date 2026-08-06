# pi-powertoys

A collection of standalone Pi extensions ("toys"). Each toy is a single TypeScript file that plugs into Pi's extension API.

## Project structure

```
toys/           # All extension source files — one .ts file per toy
bin/            # Utility scripts (pi-patcher)
```

Extensions are loaded via `~/.pi/agent/settings.json` — no installation script needed.

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

Toys that need persistent config use the shared `toys-config.ts` module, which stores everything in `~/.pi/agent/cache/pi-powertoys/toys.json` under a top-level key per toy:

```typescript
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

const TOY_KEY = "myToy";

function loadConfig(): MyConfig | null {
  return loadToyConfig<MyConfig>(TOY_KEY) ?? null;
}

function saveConfig(value: MyConfig): void {
  saveToyConfig(TOY_KEY, value);
}
```

Legacy per-toy JSON files are auto-migrated on first load. Always handle missing/corrupt data gracefully.

### Shared helpers (`toy-kit.ts`)

Stateless, dependency-free helpers shared across toys. `toy-kit.ts` imports nothing and registers nothing — import only what you need:

```typescript
import { textFromContent, contentWithText, findLastCustomEntry, withStatusChip } from "./toy-kit.ts";
```

- **`textFromContent(content)`** — normalize a tool-result `content` (string or text-block array) into a plain string.
- **`contentWithText(text)`** — wrap a string back into the `[{ type: "text", text }]` content shape.
- **`findLastCustomEntry<T>(entries, customType)`** — return the `data` of the most recent `custom` session entry of a given `customType` (for restore-on-`session_start`).
- **`withStatusChip(ctx, key, fn)`** — run `fn` with a status chip whose lifecycle is guaranteed: the chip is always cleared in a `finally`, even if `fn` throws.

A helper earns a place in `toy-kit.ts` only when two or more toys already hold a byte-identical copy. No speculative helpers — and do not route typed/bespoke logic through these (e.g. typed `pi-ai` response extraction stays inline).

## Current toys

| File | Slash command | Purpose |
| --- | --- | --- |
| `compact-model.ts` | `/compact-model` | Offloads compaction to a user-selected model via a scrolling, filterable TUI selector (windowed like pi's `/model`; falls back to plain `ctx.ui.select` in non-TUI modes) |
| `compact-model.ts` | `/compact-keypool` | Manages the Gemini compaction key pool (`google/gemini-3.1-flash-lite`): masked fingerprint display, bullet-style key input (no plaintext in session/editor), per-key status (enabled/cooldown/daily-exhausted/quarantined), enable/disable/remove/clear-quarantine/verify-key actions, soft daily limit (1–500), and explicit MiniMax-M3 fallback when all keys unavailable. Pool state stored at `~/.pi/agent/cache/pi-powertoys/gemini-keypool.json` (mode 0600, atomic writes, O_EXCL lock with stale recovery) |
| `speedtest.ts` | `/speedtest` | Benchmarks active model (TTFT, tok/s, latency) across Anthropic, OpenAI completions, OpenAI responses, and OpenAI Codex Responses APIs |
| `startup-benchmark.ts` | `/startup-benchmark` | Benchmarks harness startup (extension-load cost), not model latency. Times repeated `pi … --mode rpc` boots that exit on stdin EOF (no model prompt). `delta` = floor `-ne` vs full boot; `isolate` = each extension via `-ne -e <entry>`. Appends hostname-tagged JSONL to `~/.pi/agent/cache/pi-powertoys/startup-benchmark.jsonl`. Pure `parseArgs`/`summarize`/`buildRow` unit-tested via `npm test` (`node --test`) |
| `context.ts` | `/context` | Shows a 10×10 dot-grid breakdown of context usage by category, turn/tool-call/compaction stats, and cumulative reasoning-token count when reported |
| `contextual-working.ts` | `/working-style`, `/working-indicator` | Context-aware "Working..." messages based on active tool, with AI-generated witty variants |
| `intent-tracer.ts` | — | Injects `_i` intent field into tool schemas for better tool-call transparency |
| `agent-steer.ts` | `/steer` | Intercepts mid-turn messages with steer / queue / discard / edit single-keypress prompt; `/steer <text>` bypasses prompt |
| `context-viewer.ts` | `/system-prompt-data`, `/total-context-data` | Scrollable overlay of full system prompt or entire LLM context; live `/` search, `n`/`N` navigation, `y` clipboard copy |
| `kitty-attention.ts` | `/kitty-attention` | Sends Kitty OSC 99 desktop popups and/or terminal bell when turns finish, questions are asked, or user attention is likely needed |
| `lint.ts` | `/lint` | Auto-detects linting for Pi extension TS/JS via Biome or Python via Ruff; `--fix` mutates files |
| `shortcut-help.ts` | `/shortcuts`, `Alt+1` | Floating three-tab cheat sheet for Pi shortcuts/commands, prompt gallery, and shorthands; terminal launcher rows are read on demand from `# pi-launcher-help:` tags immediately preceding mappings in `~/.config/kitty/kitty.conf` |
| `transcript-skin.ts` | `/transcript-skin` | Display-only Markdown rewriting through `registerMarkdownTransformer` — optional secret masking (off by default, for screenshare), width-aware home-path shortening, and thinking blocks rendered as blockquotes. Rules run as an ordered pipeline; path elision never touches fenced or inline code, so copied commands stay valid. The model always receives the original text |

Archived toys live under `archive/toys/` and are not loaded by the local `settings.json` allowlist: `claude-commands.ts`, `init.ts`, `narrate.ts`, `quick-resume.ts`, `session-recap.ts`, and `ultrathink.ts`.

Moved safety hooks (`context-enforcer.ts`, `session-guard.ts`, `circuit-breaker.ts`, `json-guard.ts`) are owned by `../pi-guardian`. Previously disabled local toys have been removed; restore them from git history only if deliberately reintroduced and added back to both manifests.

## Conventions

- **One file = one toy.** No multi-file extensions. Keep dependencies to Node built-ins and Pi packages.
- **Minimal cross-toy imports.** `toys-config.ts` (persistence) and `toy-kit.ts` (stateless helpers) are the **only** two shared modules. Every other toy stays self-contained. A helper earns a place in `toy-kit.ts` only when it is duplicated verbatim across two or more toys.
- **Graceful defaults.** Config files are optional; toys work out of the box with sensible defaults.
- **TUI for config.** Use `ctx.ui.select()` / `ctx.ui.input()` for configuration, not manual file editing.
- **Pi packages only.** Only `node:*` built-ins and `@earendil-works/*` packages (`pi-coding-agent`, `pi-ai`, `pi-tui`). No third-party dependencies.
- **When adding a toy, update both manifests.** `package.json`'s `pi.extensions` is the package manifest, but this machine's active `~/.pi/agent/settings.json` uses an object-form package entry with an explicit `extensions` allowlist. Pi docs say package filters narrow what the manifest allows, so a new toy will not load after `/reload` unless it is also added to that settings entry.
- **Use `LINE:HASH` anchors for edits.** After `read`, `grep`, `ast_search`, or `write`, copy the `LINE:HASH` anchor (e.g., `42:abc1`) into `edit` operations — never use raw line numbers.

## Pi extension docs

Full API reference: `~/.nvm/versions/node/v24.12.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

Check `~/.pi/agent/model-prompts/` for model-specific delegation and workflow guidance before starting complex work.

## CodeGraph

This project does **not** ship a committed CodeGraph index — `.codegraph/` is gitignored and opt-in per checkout (run `codegraph init` to build one locally). If one exists on your machine, prefer these tools over grep/find when exploring code structure; otherwise fall back to Read/Grep/Glob:

| Task                       | Tool                | Why                                      |
| -------------------------- | ------------------- | ---------------------------------------- |
| Find a symbol by name      | `codegraph_search`  | Faster than grep, returns locations only |
| Understand how a toy works | `codegraph_context` | Entry points + related symbols + source  |
| Deep exploration           | `codegraph_explore` | Full source grouped by file, call graph  |
| What calls X?              | `codegraph_callers` | Call hierarchy without manual tracing    |
| What does X call?          | `codegraph_callees` | Downstream dependencies                  |
| Impact of changing X       | `codegraph_impact`  | Blast radius before editing              |

**When to use grep instead:** plain text search (comments, error messages, config values, non-code files).

### Spinners reference

- **Source of all spinner definitions:** [`sindresorhus/cli-spinners`](https://raw.githubusercontent.com/sindresorhus/cli-spinners/master/spinners.json)
  ~80 spinners available. Copy any entry into `toys/spinners.json` and it auto-loads on next session start.
- **Per-toy file:** `toys/spinners.json` — defines spinner frames + intervalMs.
- **Format:** `{ "spinnerName": { "frames": [...], "intervalMs": N } }`
- **Custom spinners:** Edit the JSON, add any entry. No code changes needed.
- **Fallback:** `contextual-working.ts` has a hardcoded `FALLBACK_INDICATORS` map in case the JSON is missing/corrupt. It's a smaller, independent safety-net set — not kept in sync 1:1 with `spinners.json`.
- **Picker/HUD display:** `/working-indicator` and the pi-hud status chip show the spinner *name* only (e.g. `braille`), not an ASCII frame preview — keeps the picker compact and the HUD non-distracting.
