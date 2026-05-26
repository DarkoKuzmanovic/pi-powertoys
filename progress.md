# Progress

## 2026-05-26 — crof-models-toy recon

**Status:** Scout recon complete

**Output:** `.pi/tasks/crof-models-toy/recon/scout.md`

### Findings

1. **Extension pattern verified** — `toys/color.ts` is the simplest reference (39 lines of logic)
2. **Slash command registration** — `pi.registerCommand(name, { description, handler })`
3. **Config persistence** — `toys/toys-config.ts` provides `loadToyConfig`/`saveToyConfig` storing in `~/.pi/agent/toys.json`
4. **Extension loading** — Two-place registration: `package.json` + `~/settings.json`

### Hidden coupling flagged

1. **`context-enforcer.ts` blocks raw `fetch()`** — Must use `ctx_fetch_and_index` or add allowlist
2. **Two-place extension registration** — Easy to forget one file
3. **Config key collisions** — All toys share `toys.json`, need unique key
4. **HTML parsing** — No built-in parser, need strategy for crof.ai/pricing

### Next step

Implementer should:
1. Read `toys/color.ts` for pattern
2. Read `context-enforcer.ts` to understand HTTP blocking
3. Decide on fetch approach (`ctx_fetch_and_index` vs allowlist)
4. Choose display format (TUI vs notify)
