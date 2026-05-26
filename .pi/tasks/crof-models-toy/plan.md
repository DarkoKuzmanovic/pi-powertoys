# Plan: crof-models-toy

## Decisions

1. **Fetch method:** Jina Reader (`https://r.jina.ai/https://crof.ai/pricing`) — returns clean markdown, avoids `context-enforcer.ts` blocking raw `fetch()`
2. **Cache:** Store in `toys.json` under key `crofModels` with `{timestamp: number, models: CrofModel[]}`. TTL = 10 min.
3. **Display:** Plain text table via `ctx.ui.notify()`, not TUI overlay — simpler, matches `/speedtest` pattern
4. **Parsing:** Regex on Jina Reader markdown output. Each model line matches: `name quant ctx/max [vision] [Nx requests] $… $… $… ~N t/s`
5. **File name:** `toys/crof-models.ts` (not `crof-models-toy.ts` — matches existing convention like `context.ts`, `color.ts`)
6. **Command name:** `/crof`

## Files

### 1. `toys/crof-models.ts` — NEW (~180 lines)

Full extension file. Structure:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

const TOY_KEY = "crofModels";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const JINA_URL = "https://r.jina.ai/https://crof.ai/pricing";

interface CrofModel {
  name: string;
  quant: string;
  maxOutput: string;
  vision: boolean;
  reqMultiplier: string; // "1x", "2x", "0.5x", "0.75x", "10x", or ""
  speedTps: number;
}

interface CacheEntry {
  timestamp: number;
  models: CrofModel[];
}

export default function crofModelsExtension(pi: ExtensionAPI) {
  pi.registerCommand("crof", {
    description: "Show Crof AI models sorted by speed",
    handler: async (args, ctx) => { /* ... */ },
  });
}
```

**Handler logic:**
1. Parse `args` string for flags: `--vision`, `--quant <val>`, `--min-speed <val>`
2. Check cache: `loadToyConfig<CacheEntry>(TOY_KEY)` — if fresh (<10 min), use it
3. If stale/missing: `await fetch(JINA_URL)`, parse markdown into `CrofModel[]`, save cache
4. Filter models per flags
5. Sort by `speedTps` descending
6. Render table and `ctx.ui.notify(table, "info")`

**Parsing logic (the hard part):**
- Jina Reader output lines look like:
  ```
  deepseek-v4-pro Q4_0 1,000,000 / 131,072 $0.30 $0.003 $0.50 ~11 t/s
  kimi-k2.6 Q3_K_L 262,144 / 262,144 vision $0.50 $0.10 $1.99 ~57 t/s
  deepseek-v4-pro-precision Q8_0 1,000,000 / 131,072 2x requests $0.70 $0.006 $1.40 ~21 t/s
  kimi-k2.5-lightning beta 530b-int4 131,072 / 32,768 vision $1.00 $0.20 $3.00 ~92 t/s
  glm-5.1-precision beta Q8_0 202,752 / 202,752 2x requests $0.75 $0.15 $2.90 ~78 t/s
  ```
- Regex approach: match lines that contain `~\d+ t/s` at the end
- Split each matching line into tokens, extract:
  - Speed: `~(\d+(?:\.\d+)?)\s*t/s`
  - Quant: second token (or for multi-word quants like "530b-int4", use the token before the context numbers)
  - Context/max-output: `(\d[\d,]*)\s*/\s*(\d[\d,]*)` — second capture is max output
  - Vision: check if `vision` appears in line
  - Request multiplier: `(\d+(?:\.\d+)?)x\s*requests?` or `0\.75x`
  - Name: everything before the quant token

**Table rendering:**
```
 Crof AI Models (sorted by speed)

 Name                        Quant       Max Out    Vis  Req    Speed
 ─────────────────────────── ─────────── ────────── ──── ───── ─────
 qwen3.5-9b                  fp8         262,144    —    0.5x   190 t/s
 kimi-k2.5-lightning beta    530b-int4   32,768     ✓          92 t/s
 mimo-v2.5-pro-precision     Q8_0        131,072    —    2x    82 t/s
 ...

 Filters: --vision  --quant <substr>  --min-speed <N>
 Cache: 7 min remaining
```

**Flag parsing:**
```typescript
function parseArgs(raw: string): { vision: boolean; quant: string; minSpeed: number } {
  const tokens = raw.split(/\s+/);
  let vision = false, quant = "", minSpeed = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--vision") vision = true;
    else if (tokens[i] === "--quant" && tokens[i+1]) quant = tokens[++i];
    else if (tokens[i] === "--min-speed" && tokens[i+1]) minSpeed = parseFloat(tokens[++i]);
  }
  return { vision, quant, minSpeed };
}
```

### 2. `settings.json` — APPEND one line

Add `"toys/crof-models.ts"` at end of the pi-powertoys extensions array (after `"toys/ultrathink.ts"`).

## Tests

Manual verification only (no test infrastructure):
1. Start pi, run `/crof` — should show table with ~21 models sorted by speed
2. `/crof --vision` — only models with vision tag (kimi-k2.6, kimi-k2.5, gemma-4-31b-it, qwen3.6-27b, qwen3.5-397b-a17b, qwen3.5-9b, kimi-k2.5-lightning, kimi-k2.6-precision)
3. `/crof --quant Q8` — only Q8_0 models
4. `/crof --min-speed 50` — only models ≥50 t/s
5. Disconnect network, `/crof` — should show cached data if fresh, or clear error if no cache
6. Run `/crof` twice within 10 min — second call should use cache (note "cache" line in output)

## Risks

1. **Jina Reader rate limits** — free tier may throttle. Mitigation: cache + graceful error message suggesting retry later.
2. **Page format changes** — crof.ai could restructure the pricing page. Mitigation: if no `~\d+ t/s` lines found, show "Could not parse pricing page — format may have changed" instead of empty table.
3. **Model name parsing ambiguity** — names with spaces ("kimi-k2.5-lightning beta", "glm-5.1-precision beta") make token-split parsing tricky. Mitigation: parse from both ends — speed from the end, quant from after the name, context/max in the middle.
4. **context-enforcer blocking** — if Jina Reader URL is also blocked. Mitigation: Jina Reader is an HTTP GET to a different domain; `context-enforcer` blocks patterns like `fetch(` in LLM tool calls, not in extension code. Extension code runs outside the LLM tool chain.
5. **Cache staleness** — 10-min TTL means models could change during session. Mitigation: show cache age in output so user knows staleness.

## Rollback

- Delete `toys/crof-models.ts`
- Remove `"toys/crof-models.ts"` from `settings.json`
- Remove `crofModels` key from `~/.pi/agent/toys.json` (optional cleanup)
