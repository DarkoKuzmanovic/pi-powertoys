# PLAN

## Scope decision

- **Tier:** Standard.
- **Risk:** Critical protected — plaintext credential persistence plus cross-process quota-state integrity.
- **Evidence:** One repository and one coherent user-visible feature; architecture is resolved by the approved design at `docs/specs/2026-07-15-gemini-compaction-key-pool-design.md`; implementation touches compaction logic, secure state, masked UI, tests, and docs.
- **Allowed ceremony:** One TDD worker wave, deterministic verification, then a separate deep scrutinize pass and deep combined code review. No planner needed because file boundaries and decisions are explicit in the approved design.
- **Outcome dispatch ceiling:** 6 child dispatches.
- **Promotion triggers:** A required second repository, unresolved provider-transport fork, inability to classify errors without changing Pi core, or a credential-storage design change.
- **Started-at:** 2026-07-15T22:20:48+02:00
- **Run metrics:** dispatches: 0 · review-bundles: 0 · review-dispatches: 0 · worker-retries: 0 · oracle: 0 · completed-outcomes: 0 · child-runtime-minutes: 0 · compactions: 0

## M1 — Secure adaptive Gemini key pool for context compaction

**Counters:** dispatches: 0/6 · review-bundles: 0 · review-dispatches: 0 · fix-cycles: 0/1 · oracle: 0 · worker-retries: 0 · direct-edits: 0

- [ ] **M1.1 — Deliver the secure key pool, adaptive compaction failover, masked manager, and documentation**
  - [ ] Add tests first and observe RED for Pacific-day normalization, selection/reservation, secure persistence, failure classification, retry boundaries, MiniMax-M3 fallback, and secret-redaction invariants.
  - [ ] Implement mode-0600 atomic state, bounded stale-lock recovery, per-machine advisory counters, and least-attempt selection.
  - [ ] Integrate exact-model Gemini rotation and explicit `minimax/MiniMax-M3` fallback without changing normal Google usage.
  - [ ] Add `/compact-keypool` masked overlay management without command/session secret exposure.
  - [ ] Refresh `README.md`, `AGENTS.md`, package test command if needed, and the approved design with grill decisions.
  - [ ] Verify typecheck, unit tests, extension lint, and targeted manual behavior that does not require committing real keys.
  - [ ] Pass critical protected two-phase review: deep scrutinize, then deep combined code review.

## Grill decisions

- Mode-0600 plaintext storage is accepted as the local threat boundary.
- The same keys may be used lightly on darko-desktop and darko-laptop; counters remain per-machine and advisory, while Google 429 responses are authoritative.
- When all Gemini keys are unavailable, compact-model explicitly falls back to `minimax/MiniMax-M3`, not the active conversation model.

## Conventions

- Follow the one-file-per-toy rule; keep implementation in `toys/compact-model.ts` plus its test file.
- Use only Node built-ins and existing `@earendil-works/*` packages; add no dependencies.
- New behavior follows RED → GREEN → REFACTOR within one worker context.
- Never print, log, notify, serialize into sessions, or commit a plaintext key.
- Do not touch the unrelated live-checkout modification in `toys/shortcut-help.ts`.
- The worktree root is `/tmp/pi-powertoys-gemini-keypool`; all implementation and verification happen there.

## Confidence gaps

- Google error objects may expose status/details differently across SDK paths. Classification must stay narrow, test both structured and message forms, and avoid mutating key state when uncertain.
- No real keys are committed or passed to subagents; live credential verification remains a user-controlled post-merge action.

## Gate log

- 2026-07-15 — Written design approved by user and committed as `689451f`.
- 2026-07-15 — Balanced grill resolved storage threat model, cross-machine advisory accounting, and explicit MiniMax-M3 fallback.
- 2026-07-15 — Scope classified Standard / critical protected; hard outcome ceiling 6.

## Deferred

- None.
