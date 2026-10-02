# ROADMAP

Status: complete

## Released
- **M0** — Initial pi-powertoys collection — v1.0.0
- **M1** — Secure adaptive Gemini key pool for context compaction (2026-07-15)
- **M2** — Shortcut help derives terminal-launcher keys from tagged `kitty.conf` mappings; draft-PR delivery trial ([PR #1](https://github.com/DarkoKuzmanovic/pi-powertoys/pull/1), merged 2026-10-02). Trial record: [`PLAN.md` at 7f5d624](https://github.com/DarkoKuzmanovic/pi-powertoys/blob/7f5d624544d13775e042bb69e4770b9e236fc322/PLAN.md)

## Current

## Planned

- **Argument completions for `/afk`** — complete `on` / `off` via `getArgumentCompletions`; reuse the `transcript-skin` completer/parser round-trip test shape.
- **Argument completions for `/working-style`, `/working-indicator`, and `/working-color`** — complete each from the `STYLE_NAMES` / `COLOR_NAMES` const arrays that already exist in `toys/contextual-working.ts`; reuse the `transcript-skin` completer/parser round-trip test shape.
