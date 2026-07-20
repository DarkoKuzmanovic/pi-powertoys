# PLAN — M2 Kitty launcher help

## Scope decision

- **Tier:** Light
- **Risk:** ordinary
- **Evidence:** One extension file, one focused parser test, and one user-level Kitty configuration change; no architecture fork or protected boundary.
- **Allowed ceremony:** Test-first parser change, typecheck/test gate, one draft PR trial.
- **Promotion triggers:** Additional repositories, generated Kitty configuration, or changes to Crew policy during this trial.
- **Delivery:** draft-pr (`origin/DarkoKuzmanovic/pi-powertoys`, pending)
- **Started-at:** 2026-07-20T11:36:27+02:00
- **First-worker-at:** direct orchestrator work; no worker dispatch
- **Time-to-first-worker:** n/a
- **Dispatches:** 0
- **Review-bundles:** 0
- **Worker-retries:** 0
- **Oracle:** 0

## Outcome M2.1 — One source for terminal-launcher help

- [x] Add failing parser coverage for tagged Kitty launcher mappings.
- [x] Make `kitty.conf` authoritative for terminal-launcher keys and descriptions.
- [x] Preserve the existing Alt+2 `pero` launcher in the migrated help data.
- [x] Show a clear fallback when tagged launcher mappings are unavailable.
- [x] Run focused tests, the full test script, and typecheck.

## Outcome M2.2 — GitHub dashboard launcher

- [x] Verify the installed `gh-dash` extension.
- [x] Add a non-conflicting Kitty launcher for `gh dash`.
- [x] Verify Kitty reports zero bad config lines and both launcher binaries resolve; runtime keypress remains a manual check.

## Outcome M2.3 — Draft PR trial

- [ ] Push `crew/m2-kitty-launcher-help` after the verified outcome gate.
- [ ] Open a draft PR whose body summarizes scope and links to this pushed `PLAN.md` without mirroring its checkboxes.
- [ ] Record the PR URL in `## Scope decision`.

## Verification — 2026-07-20

- `npm run typecheck` — exit 0.
- `npm test` — exit 0; 107 tests, 107 passed, 0 failed.
- `git diff --check` — exit 0.
- Fresh-context reviewer — APPROVE, no blockers; both SHOULD-FIX findings resolved with regression coverage.
- Kitty config parser — exit 0 with zero bad lines; live keypress remains unverified because the tool sandbox has no running Kitty session.

## Deferred

- Encode the delivery convention into the Crew prompt and skill only after this manual trial is evaluated.
