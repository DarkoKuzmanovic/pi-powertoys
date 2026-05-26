# Task: crof-models-toy

**Created:** 2026-05-26
**Status:** scaffolded
**Test-first:** false — no test infrastructure in pi-powertoys

## Goal

New Pi Powertoys extension `/crof` that scrapes https://crof.ai/pricing, caches the result with a 10-min TTL, and renders a table of models sorted by speed (t/s descending) with columns: name, quantization, max output, vision (✓/—), req (1x/2x/0.5x etc), speed (t/s). Supports filter flags: `--vision`, `--quant <substring>`, `--min-speed <number>`.

## In-scope files

- `toys/crof-models.ts` — new file: the entire extension (scrape, parse, cache, render, command)
- `~/.pi/agent/settings.json` — add `"toys/crof-models.ts"` to the pi-powertoys extensions array
- `toys/toys-config.ts` — used for cache persistence (read-only, no changes needed)

## Out-of-scope

- No modifications to existing toys
- No third-party dependencies (no cheerio, axios, etc.)
- No TUI overlay — output goes to assistant message via `ctx.ui.notify()` or returned text
- No caching of model metadata beyond the scrape result (no per-model favorites, etc.)

## Acceptance criteria

- [ ] `/crof` fetches live data from crof.ai/pricing and displays all models
- [ ] Table columns: Name | Quant | Max Out | Vision | Req | Speed
- [ ] Sorted by speed descending
- [ ] `--vision` flag filters to vision-only models
- [ ] `--quant Q8` filters by quantization substring match
- [ ] `--min-speed 30` filters to models with ≥30 t/s
- [ ] Scrape result cached for 10 min; repeated `/crof` within TTL uses cache
- [ ] Graceful error on fetch failure (notify user, no crash)
- [ ] No third-party deps — only `node:*` built-ins and `@earendil-works/*`
- [ ] Extension registered in settings.json

## Constraints

- Follow existing toy conventions: one file, `export default function(pi: ExtensionAPI)`, `pi.registerCommand()`
- Use `toys-config.ts` for cache persistence (`loadToyConfig`/`saveToyConfig`)
- Parse the pricing page with regex/string ops only (no DOM parser)
- Page data format (from Jina Reader output): each model line is `name quant context/max-out tags pricing speed`
- Handle page structure drift with fallback parsing and clear error messages

## Gotchas

- The pricing page may be SPA-rendered — a plain HTTP GET returns server-rendered HTML. Use Jina Reader fallback (`https://r.jina.ai/https://crof.ai/pricing`) if raw HTML is too JS-dependent.
- `toys-config.ts` stores cache under a top-level key — use key `crofModels`.
- `settings.json` extensions list is ordered; append new entry at end of the array.
- Vision and request-usage tags are embedded in the same field on the page (e.g., `262,144 / 262,144 vision 2x requests`). Parse them from the combined string.
