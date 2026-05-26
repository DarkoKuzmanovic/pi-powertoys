# Crof Models Toy — Scout Recon

## Files Retrieved

1. `toys/color.ts` (lines 1-98) — Simplest toy pattern: slash command + session state persistence
2. `toys/context.ts` (lines 1-228) — TUI-based display with custom rendering
3. `toys/toys-config.ts` (lines 1-106) — Shared config persistence module
4. `toys/compact-model.ts` (lines 1-211) — Config persistence + lifecycle hook pattern
5. `toys/speedtest.ts` (lines 290-369) — HTTP fetch usage for API calls
6. `package.json` (lines 1-72) — Project structure + extension registration via `pi.extensions`
7. `~/settings.json` (lines 43-64) — How pi-powertoys extensions are loaded
8. `AGENTS.md` (lines 1-80) — Extension conventions and API reference

## Key Code

### Extension Pattern (from `color.ts`)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function colorExtension(pi: ExtensionAPI) {
  // Restore from session state on start/resume
  pi.on("session_start", async (_event, ctx) => {
    // restore logic
  });

  pi.registerCommand("color", {
    description: "Set a color label for this session",
    handler: async (args, ctx) => {
      // command logic using ctx.ui.select(), ctx.ui.notify()
    },
  });
}
```

### Slash Command Registration

```typescript
pi.registerCommand("commandName", {
  description: "Human-readable description",
  getArgumentCompletions: (prefix: string) => { /* optional */ },
  handler: async (args, ctx) => {
    // args: string | undefined
    // ctx: { ui: ..., sessionManager: ..., model: ..., ... }
  },
});
```

### Config Persistence (from `toys-config.ts`)

```typescript
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

const TOY_KEY = "crofModels";

interface CrofModelsConfig {
  // your config shape
}

function loadConfig(): CrofModelsConfig | null {
  return loadToyConfig<CrofModelsConfig>(TOY_KEY) ?? null;
}

function saveConfig(value: CrofModelsConfig): void {
  saveToyConfig(TOY_KEY, value);
}
```

Config file location: `~/.pi/agent/toys.json`

### HTTP Fetch Pattern (from `speedtest.ts`)

```typescript
const response = await fetch(url, {
  method: "POST",
  headers,
  body,
  signal: controller.signal,
});

if (!response.ok) {
  const text = await response.text();
  // handle error
}

// For streaming:
const reader = (response.body as ReadableStream<Uint8Array>).getReader();
```

### Extension Registration in `package.json`

```json
{
  "pi": {
    "extensions": [
      "./toys/compact-model.ts",
      "./toys/speedtest.ts",
      // ... add "./toys/crof-models-toy.ts" here
    ]
  }
}
```

### Extension Loading in `settings.json`

```json
{
  "packages": [
    {
      "source": "/home/quzma/.pi/agent/extensions/pi-powertoys",
      "extensions": [
        "toys/compact-model.ts",
        "toys/speedtest.ts",
        // ... add "toys/crof-models-toy.ts" here
      ]
    }
  ]
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Pi Coding Agent                                            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Extension Loader (settings.json → package.json)      │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│                          ▼                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  toys/crof-models-toy.ts                               │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  pi.on("session_start", ...)                    │  │  │
│  │  │  pi.registerCommand("/crof-models", handler)    │  │  │
│  │  │  pi.registerTool(...) [optional]                │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                          │                              │  │
│  │                          ▼                              │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  toys/toys-config.ts                            │  │  │
│  │  │  → ~/.pi/agent/toys.json                        │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                          │                              │  │
│  │                          ▼                              │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  fetch(crof.ai/pricing)                         │  │  │
│  │  │  → parse HTML → display models                  │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Data flow:**
1. Extension loaded via `settings.json` → `package.json` → `toys/crof-models-toy.ts`
2. On `/crof-models` command: fetch crof.ai/pricing → parse → display via `ctx.ui.custom()` or `ctx.ui.notify()`
3. Optional: cache results in `toys.json` via `toys-config.ts`

## Test Infrastructure

**Not applicable** — pi-powertoys toys do not have a test suite. Verification is manual:
- Run `pi` and invoke `/crof-models` command
- Check TUI output for correct model data

**Closest reference:** `color.ts` for simple command pattern, `context.ts` for TUI display.

## Hidden Coupling / Risks

### 1. HTTP Client Blocking (`context-enforcer.ts`)

**Critical:** The `context-enforcer.ts` extension **blocks raw `fetch()` calls** and redirects to `ctx_fetch_and_index`:

```typescript
// context-enforcer.ts:39
{ pattern: /\bfetch\s*\(/, name: "fetch()", tool: "ctx_fetch_and_index" },
```

**Impact:** Your toy cannot use native `fetch()` directly. Must use one of:
- `ctx_fetch_and_index` tool (via `ctx.tools.fetchAndIndex()`)
- Request an exemption in `context-enforcer.ts` for crof.ai domain
- Use `pi-ai`'s `complete()` with web context (if available)

**Resolution options:**
1. Add crof.ai to an allowlist in `context-enforcer.ts`
2. Use `ctx_fetch_and_index` tool instead of `fetch()`
3. Move HTTP logic to a tool that bypasses the enforcer

### 2. Two-Place Extension Registration

Extensions must be registered in **two files**:
- `package.json` → `pi.extensions` array
- `~/settings.json` → `packages[].extensions` array

**Risk:** Forgetting one means the toy won't load.

### 3. Config Key Collisions

All toys share `~/.pi/agent/toys.json`. Each toy must use a **unique top-level key**:
```typescript
const TOY_KEY = "crofModels"; // must be unique across all toys
```

### 4. HTML Parsing Dependency

Scraping crof.ai/pricing requires HTML parsing. No built-in parser in toys. Options:
- Use regex (fragile)
- Import a lightweight parser (adds dependency)
- Use `ctx_fetch_and_index` which may already parse

## Start Here

**First file to open:** `toys/color.ts`

**Why:** It's the simplest complete toy (39 lines of logic). Shows:
- Basic extension function signature
- `pi.on("session_start", ...)` for restore
- `pi.registerCommand()` with handler
- `ctx.ui.select()` and `ctx.ui.notify()` usage
- `pi.appendEntry()` for session persistence

**Second file:** `toys/toys-config.ts` — understand the config API before implementing persistence.

**Third file:** `context-enforcer.ts` — **read before writing any fetch code** to understand the HTTP blocking and how to work around it.

## Open Questions

1. **How to bypass context-enforcer for crof.ai?** Need to decide: allowlist, use `ctx_fetch_and_index`, or different approach.
2. **Display format:** TUI (`ctx.ui.custom()`) like `context.ts`, or simple notify like `color.ts`?
3. **Caching:** Should model data be cached in `toys.json`? How long TTL?
4. **Tool vs Command:** Should this be a tool (LLM-callable) or just a slash command (user-triggered)?
