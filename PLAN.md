# PLAN

## Scope decision

- **Tier:** Standard.
- **Risk:** Critical protected — plaintext credential persistence plus cross-process quota-state integrity.
- **Evidence:** One repository and one coherent user-visible feature; architecture is resolved by the approved design at `docs/specs/2026-07-15-gemini-compaction-key-pool-design.md`; implementation touches compaction logic, secure state, masked UI, tests, and docs.
- **Allowed ceremony:** One TDD worker wave, deterministic verification, then a separate deep scrutinize pass and deep combined code review. No planner needed because file boundaries and decisions are explicit in the approved design.
- **Outcome dispatch ceiling:** 6 child dispatches.
- **Promotion triggers:** A required second repository, unresolved provider-transport fork, inability to classify errors without changing Pi core, or a credential-storage design change.
- **Started-at:** 2026-07-15T22:20:48+02:00
- **Run metrics:** dispatches: 6 · review-bundles: 2 · review-dispatches: 3 · worker-retries: 1 · oracle: 0 · completed-outcomes: 1 · child-runtime-minutes: 63 · compactions: 0 · first-worker-at: 2026-07-15T22:21:56+02:00 · time-to-first-worker: 1m08s · ended-at: 2026-07-15T23:33:39+02:00 · total-duration: 1h12m51s

## M1 — Secure adaptive Gemini key pool for context compaction

**Counters:** dispatches: 6/6 · review-bundles: 2 · review-dispatches: 3 · fix-cycles: 1/1 · oracle: 0 · worker-retries: 1 · direct-edits: 0

- [x] **M1.1 — Deliver the secure key pool, adaptive compaction failover, masked manager, and documentation**
  - [x] Add tests first and observe RED for Pacific-day normalization, selection/reservation, secure persistence, failure classification, retry boundaries, MiniMax-M3 fallback, and secret-redaction invariants.
  - [x] Implement mode-0600 atomic state, bounded stale-lock recovery, per-machine advisory counters, and least-attempt selection.
  - [x] Integrate exact-model Gemini rotation and explicit `minimax/MiniMax-M3` fallback without changing normal Google usage.
  - [x] Add `/compact-keypool` masked overlay management without command/session secret exposure.
  - [x] Refresh `README.md`, `AGENTS.md`, package test command if needed, and the approved design with grill decisions.
  - [x] Verify typecheck, unit tests, extension lint, and targeted manual behavior that does not require committing real keys.
  - [x] Pass critical protected two-phase review: deep scrutinize, then deep combined code review.

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
- 2026-07-15 — Fresh deterministic verification at 2026-07-15T22:57:02+02:00: `npm test` exit 0 (87/87 pass); `npm run typecheck` exit 0; `npx biome check .` exit 0; `git diff --check` exit 0.
- 2026-07-15 — Diff inspection: eight changed files including one new test file; implementation is wired through `session_before_compact` and `/compact-keypool`. No real credentials were used. Manual TUI/live-provider verification remains explicitly pending.
- 2026-07-15 — Deep scrutinize cycle 1 verdict: SHIP. Reproduced all four deterministic gates. Residual minor findings sent to combined review: outer hook glue lacks direct automation; non-TUI input is unmasked; corrupt-state compaction path is silent; lock failures can escape/misclassify a successful summary; all-unavailable notification is contradictory before MiniMax fallback; verify action propagates raw provider error text.
- 2026-07-15 — Deep combined review verdict: REQUEST_CHANGES. Blocking I-1: pool lock/persistence errors can escape the hook or discard an already-computed summary; 5s max wait is shorter than 10s stale threshold. One allowed fix cycle opened with the same worker. Nearby protected-boundary fixes included: masked-only key entry, sanitized verification failures, corrupt-state notice, consistent fallback notice, and complete grill-decision docs.
- 2026-07-15 — Post-fix verification: `npm test` exit 0 (93/93 pass); typecheck, Biome, and diff-check exit 0. Orchestrator audit found short-key fingerprint exposure (`abcd…abcd`) despite the full-secret prohibition; kept inside the existing fix cycle with a required regression test.
- 2026-07-15 — Final pre-review verification at 2026-07-15T23:29:39+02:00: `npm test` exit 0 (98/98 pass); `npm run typecheck` exit 0; `npx biome check .` exit 0; `git diff --check` exit 0. Short secrets are fully masked; verification-success accounting is best-effort; failure-accounting errors no longer trigger MiniMax; fallback provider errors are sanitized.
- 2026-07-15 — Final deep combined re-review reproduced all four gates and returned APPROVE with no Critical or Important findings. Outcome M1.1 passed at the hard 6-dispatch ceiling.

## Deferred

- None.
