# Gemini compaction key-pool design

**Date:** 2026-07-15  
**Status:** Approved design, pending user review  
**Owner:** `pi-powertoys` / `compact-model` toy

## Summary

Extend the existing `compact-model` toy with a compaction-only Gemini API key pool for `google/gemini-3.1-flash-lite`. The pool distributes compaction requests across keys belonging to separate Google Cloud projects, tracks local daily usage, retries key-specific failures with another eligible key, and accepts key changes without reloading Pi.

The feature must not override the built-in Google provider, alter normal Google conversations, expose keys in session history, or duplicate Google's transport implementation.

## Confirmed premises

- Google Gemini API rate limits are applied per Google Cloud project, not per API key.
- The three initial keys belong to three separate Google Cloud projects.
- Each project currently exposes a 500 requests-per-day allowance for Gemini 3.1 Flash Lite.
- Google's RPD boundary resets at midnight Pacific time.
- The pool is intended only for automatic context compaction.
- The desired policy is adaptive failover rather than simple round-robin.
- Keys will be added through a masked Pi overlay.
- The existing `compact-model` hook already owns compaction-model authentication, invocation, fallback, and final compaction result construction. It is therefore the boundary that owns this behavior.

This design assumes use complies with Google's applicable terms and project/account-level controls. It does not attempt to conceal traffic or bypass an account-level restriction.

## Goals

1. Use up to three independent project quotas for Gemini compaction.
2. Balance requests conservatively across eligible keys.
3. Retry the same compaction with another key after a key-specific quota or authentication failure.
4. Keep pool behavior isolated from ordinary Google-provider conversations.
5. Allow key additions, removals, and state changes to affect the next compaction without `/reload`.
6. Never place plaintext keys in Git, `settings.json`, command arguments, notifications, or session entries.
7. Preserve the existing fallback to Pi's normal compaction path when the pool cannot produce a summary.

## Non-goals

- General-purpose Google-provider load balancing.
- Increasing quotas for multiple keys in the same Google Cloud project.
- Querying Google Cloud quota APIs.
- Synchronizing secrets or usage counters between machines.
- Tracking requests made by other applications.
- Retrying malformed requests, context overflows, user cancellations, or other failures unrelated to a key.
- Reimplementing the Google Generative AI transport.

## Alternatives considered

### A. `models.json` request-time key resolver

Configure the Google provider's `apiKey` as a `!command`. Pi resolves such commands at request time, so key changes can be hot-swapped.

**Rejected as the primary solution:** the resolver chooses a key before a request but cannot observe the response, classify a 429, update result-aware state, or retry the same compaction. It would also affect normal Google-provider usage rather than compaction alone.

### B. Extend `compact-model` with a key pool — selected

Select and pass the key directly to the existing `complete()` call inside `session_before_compact`. This keeps transport behavior in `pi-ai`, places retries at the compaction boundary, and leaves normal Google authentication untouched.

### C. Register a custom `google-compaction` provider

A provider alias could isolate credentials, but adaptive retry would still require a custom streaming wrapper or another compaction-level layer.

**Rejected:** more provider surface and transport coupling without improving the selected design.

## Architecture

The implementation remains one toy, following the repository's one-file-per-toy convention:

- Modify `toys/compact-model.ts`.
- Add focused tests in `toys/compact-model.test.ts`.
- Update `package.json` test script to include the new test file if necessary.
- Refresh `README.md` and `AGENTS.md` command/toy documentation.

Do not create a second extension or cross-toy helper. Key-pool functions may be exported from `compact-model.ts` for tests but must not register anything except through the existing default export.

Extract the network-attempt loop into an internal function that accepts a `completeFn` dependency (defaulting to `complete`). Tests must inject a fake rather than monkey-patching globals or making live requests.

### Activation condition

Use the key pool only when all conditions are true:

1. The selected compaction model is provider `google` and ID `gemini-3.1-flash-lite`.
2. The pool file contains at least one enabled, eligible key.
3. The compaction request has not been aborted.

Otherwise execute the existing single-auth compaction path unchanged.

### Data flow

```text
session_before_compact
  → load selected model
  → detect Gemini Flash Lite + configured pool
  → reserve least-used eligible key under lock
  → complete(model, summaryMessages, selectedKey)
      ├─ success → record success → return compaction
      ├─ key-specific failure → update key state → reserve next key → retry
      └─ non-key failure / abort → stop rotation
  → no key succeeds → return undefined
  → Pi executes its normal/default compaction fallback
```

## Secret and state storage

Use a dedicated file rather than shared `toys.json`:

`~/.pi/agent/cache/pi-powertoys/gemini-keypool.json`

The directory and file are per-machine cache state and remain outside Git/pi-sync.

### Filesystem requirements

- Cache directory mode: `0700` where the extension creates it.
- Pool file mode: `0600` on every write, including existing-file repair.
- Writes: serialize to a same-directory temporary file, set `0600`, then atomically rename.
- Lock: same-directory exclusive lock file with stale-lock recovery.
- Never include a plaintext key in errors, notifications, logs, or serialized session entries.

### Schema

```ts
interface GeminiKeyPoolState {
  version: 1;
  softDailyLimit: number; // default 490
  keys: GeminiPoolKey[];
}

interface GeminiPoolKey {
  id: string;             // random UUID, never derived from the secret
  secret: string;
  enabled: boolean;
  dayKey: string;         // calendar date in America/Los_Angeles
  attempts: number;       // reserved before network call
  successes: number;
  failures: number;
  lastUsedAt?: number;
  cooldownUntil?: number;
  exhaustedDayKey?: string;
  quarantinedReason?: "auth";
  lastErrorCode?: "quota-daily" | "rate-limit" | "auth";
}
```

Fingerprints are derived only for display, for example `AIza…7xQ2`; they do not need persisted fields.

Malformed state must fail closed for the pool—notify and use normal compaction fallback—without deleting or overwriting the corrupt file.

## Daily accounting and selection

### Pacific-day reset

Derive a `dayKey` using `Intl.DateTimeFormat` with `timeZone: "America/Los_Angeles"`. When a key's stored `dayKey` differs from the current key:

- Reset `attempts`, `successes`, and `failures`.
- Clear `exhaustedDayKey` from prior days.
- Preserve enabled/disabled and authentication quarantine state.

Using a calendar key instead of adding 24 hours handles Pacific daylight-saving transitions.

### Reservation

Multiple Pi processes may compact concurrently. Selection and request reservation therefore happen under a short-lived filesystem lock:

1. Load and normalize state.
2. Filter eligible keys.
3. Select the key with the lowest `attempts` count.
4. Break ties by oldest `lastUsedAt`, then stable key order.
5. Increment `attempts` and set `lastUsedAt` before releasing the lock.
6. Perform the network request without holding the lock.
7. Reacquire the lock to record success or failure.

A process crash after reservation is conservative: it may consume one local allowance without a successful request, but it cannot cause overuse.

### Eligibility

A key is eligible when:

- `enabled === true`.
- It is not quarantined for authentication failure.
- `attempts < softDailyLimit` after daily normalization.
- `exhaustedDayKey !== currentDayKey`.
- `cooldownUntil` is absent or in the past.
- It has not already been attempted for the current compaction.

The default soft daily limit is 490, leaving ten requests per project as a safety margin. The manager may expose a bounded setting from 1–500.

## Failure classification and retries

Use structured status/details when exposed by the thrown error; otherwise use narrow message matching. Never classify based on a broad word such as `limit` alone.

### Retry with another key

- **Daily/project quota 429:** mark `exhaustedDayKey` as the current Pacific day.
- **Transient 429:** apply provider retry delay when available, otherwise a 60-second cooldown.
- **401/403 authentication failure:** set `quarantinedReason: "auth"` until the user explicitly re-enables or replaces the key.

Try each eligible key at most once for one compaction. Preserve the same summary input, `firstKeptEntryId`, `tokensBefore`, and abort signal across attempts.

### Do not rotate

Stop and use existing fallback behavior for:

- User abort / aborted signal.
- Context overflow.
- Malformed request or unsupported content.
- Empty summary response.
- Other 4xx failures not identified as authentication/quota.
- Provider-wide 5xx failures unless future evidence establishes a key-specific case.

If classification is uncertain, do not quarantine or exhaust a key. Record a sanitized code only when classification is confident.

## Key-manager UI

Register `/compact-keypool` from the existing toy.

The command opens an overlay that displays:

- Masked fingerprint.
- Enabled, cooldown, daily-exhausted, or auth-quarantined status.
- `successes / attempts / softDailyLimit` for the current Pacific day.
- Last sanitized failure code.

Actions:

1. **Add key** — custom password-style input that renders bullets, accepts paste, supports backspace/confirm/cancel, and never writes the plaintext value to the editor or session.
2. **Enable/disable key**.
3. **Remove key** — requires confirmation.
4. **Clear auth quarantine** — explicit action after the credential is fixed.
5. **Set soft daily limit** — bounded to 1–500.
6. **Verify key** — optional; clearly warn that verification consumes one API request.

Verification must use the same reservation and result-accounting path as compaction so it cannot bypass the soft daily limit or make counters inaccurate.

Adding a key performs only conservative local validation (trimmed, non-empty, no whitespace/control characters). Do not hardcode one key prefix as an invariant.

The command must never show full secrets or pass them as slash-command arguments.

## User feedback

Compaction notifications may include only fingerprints and aggregate attempt counts, for example:

- `Compacting via Gemini Flash Lite (key …7xQ2, attempt 1/3)…`
- `Gemini key …7xQ2 rate-limited; retrying with …A91k`
- `All Gemini compaction keys unavailable; using default compaction`

The final success notification retains the existing token-savings information.

## Reload semantics

- Loading the new extension code initially requires `/reload` or a new Pi session.
- Adding, removing, enabling, disabling, or replacing keys requires no reload.
- Pool state is read and normalized immediately before each compaction.
- Cooldown expiry and Pacific-day rollover require no reload.
- `/compact-model` selection changes remain immediate.
- Changes to extension source code still require `/reload`.

## Testing strategy

### Pure unit tests

- Pacific `dayKey` around PST/PDT and DST boundaries.
- Daily normalization clears counters/exhaustion but preserves auth quarantine and enabled state.
- Least-attempt selection and deterministic tie-breaking.
- Soft-cap exclusion.
- Cooldown and daily-exhaustion eligibility.
- Per-compaction attempted-key exclusion.
- Error classifier: daily quota, transient 429, 401/403, abort, unrelated 4xx, context overflow, 5xx, ambiguous messages.
- Fingerprint generation never returns a full key.
- Corrupt state fails closed without rewriting.
- Atomic writer repairs/enforces `0600`.
- Lock reservation prevents duplicate selection under concurrent simulated reservations.

### Hook-level tests

With fake model registry/auth and stubbed `complete()` behavior:

- Pool absent → existing auth path is unchanged.
- Non-Gemini model → existing auth path is unchanged.
- First key succeeds → exactly one call and correct compaction result.
- First key gets a key-specific 429 → state updates and second key retries.
- Non-key failure → no second key attempt and normal fallback.
- Abort during first attempt → no retry.
- All keys unavailable/fail → handler returns undefined for Pi fallback.
- No notification or error includes any plaintext key.

### Manual verification

1. Add three masked keys from separate projects.
2. Select `google/gemini-3.1-flash-lite` through `/compact-model`.
3. Trigger a real compaction and confirm only one counter increments.
4. Temporarily disable the selected key and confirm the next eligible key is used without reload.
5. Test a deliberately invalid key and confirm quarantine plus failover without secret leakage.
6. Open a normal Google conversation and confirm it still uses Pi's ordinary Google credential rather than the pool.

## Risks and mitigations

1. **Same-project keys mistakenly treated as separate quota.** Document project-scoped quotas and require the user to confirm separate projects; runtime cannot prove it.
2. **Requests outside Pi make local counters stale.** Keep a safety margin and let 429 responses correct eligibility.
3. **Error-message drift causes false quota classification.** Prefer structured fields, use narrow patterns, and fail without state mutation when uncertain.
4. **Concurrent Pi sessions race state updates.** Reserve under an exclusive file lock and write atomically.
5. **Crash leaves a reserved request unsatisfied.** Count reservations conservatively; daily reset self-heals.
6. **Secrets leak through UI/logging/errors.** Mask all displays, sanitize errors, avoid session entries, and test output surfaces.
7. **Corrupt state destroys keys.** Never overwrite malformed state automatically; fail closed and require explicit recovery.
8. **Retry loop amplifies provider outage.** Retry only key-specific failures, once per eligible key, while honoring abort.
9. **Feature changes ordinary Google usage.** Activate only inside the compaction hook for the exact selected model.
10. **Pacific reset mishandles DST.** Compare timezone-derived calendar keys instead of adding fixed durations.

## Rollout

1. Implement state, locking, selection, and classification as testable pure functions inside `compact-model.ts`.
2. Add tests before changing the live hook path.
3. Integrate adaptive attempts behind the exact activation condition.
4. Add masked manager UI and documentation.
5. Run typecheck, unit tests, and extension lint.
6. `/reload` once to load the code.
7. Add keys through `/compact-keypool`; no further reload.
8. Keep MiniMax-M3 selected until manual Gemini verification passes, then explicitly switch via `/compact-model`.

## Rollback

### Behavioral rollback

- Select MiniMax-M3 through `/compact-model`; this bypasses the Gemini pool immediately.
- Disable all pool keys through `/compact-keypool`.

### Code rollback

- Restore the pre-feature versions of `toys/compact-model.ts`, tests, manifest test script, and docs.
- `/reload` after restoring extension source.

The key-pool file may remain inert in cache or be removed explicitly by the user. Code rollback must never delete secrets automatically.

## Acceptance criteria

- Three separate-project keys can be added without plaintext entering session history.
- Key changes affect the next compaction without reload.
- Successful compactions balance across keys by conservative local attempt count.
- Key-specific quota/auth failures retry another eligible key at most once each.
- Non-key errors and aborts do not rotate.
- All-keys-unavailable returns control to Pi's existing compaction fallback.
- Normal Google-provider usage never consumes pool keys.
- State survives restart, resets by Pacific calendar day, and remains safe under concurrent Pi sessions.
- Key storage remains mode `0600`, with no key material in logs, notifications, Git, or session entries.
- Existing non-Gemini compact-model behavior remains unchanged and tested.
