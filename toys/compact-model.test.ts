import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, utimesSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	pacificDayKey,
	normalizeKeyForDay,
	selectKey,
	DEFAULT_SOFT_DAILY_LIMIT,
	fingerprint,
	classifyGeminiError,
	writePoolStateFile,
	loadPoolStateFile,
	acquirePoolLock,
	reserveKey,
	recordOutcome,
	runGeminiKeyPoolCompletion,
	attemptFallbackModel,
	MINIMAX_FALLBACK,
	runCompactionHook,
	addKeyToPool,
	removeKeyFromPool,
	setKeyEnabled,
	clearKeyQuarantine,
	setSoftDailyLimit,
	validateKeySecret,
	mutatePoolState,
	reserveSpecificKey,
	verifyPoolKey,
	LOCK_STALE_MS,
	LOCK_MAX_WAIT_MS,
	type PoolPaths,
	type GeminiPoolKey,
	type GeminiKeyPoolState,
} from "./compact-model.ts";

function makeKey(overrides: Partial<GeminiPoolKey> = {}): GeminiPoolKey {
	return {
		id: "key-1",
		secret: "AIzaSyFAKESECRETVALUE0000000000000",
		enabled: true,
		dayKey: "2026-07-14",
		attempts: 3,
		successes: 2,
		failures: 1,
		...overrides,
	};
}

test("pacificDayKey: UTC evening rolls back to the prior Pacific calendar day (PST)", () => {
	// 2026-01-01T07:30:00Z is 2025-12-31T23:30 in America/Los_Angeles (PST, UTC-8).
	assert.equal(pacificDayKey(new Date("2026-01-01T07:30:00Z")), "2025-12-31");
});

test("pacificDayKey: DST boundary (PDT, UTC-7) — just before and after Pacific midnight", () => {
	// 2026-07-15T06:59:00Z is 2026-07-14T23:59 PDT.
	assert.equal(pacificDayKey(new Date("2026-07-15T06:59:00Z")), "2026-07-14");
	// 2026-07-15T07:01:00Z is 2026-07-15T00:01 PDT.
	assert.equal(pacificDayKey(new Date("2026-07-15T07:01:00Z")), "2026-07-15");
});

test("normalizeKeyForDay: same day is a no-op", () => {
	const key = makeKey({ dayKey: "2026-07-15" });
	const result = normalizeKeyForDay(key, "2026-07-15");
	assert.deepEqual(result, key);
});

test("normalizeKeyForDay: new day resets counters and clears exhaustedDayKey, preserves enabled/quarantine", () => {
	const key = makeKey({
		dayKey: "2026-07-14",
		attempts: 490,
		successes: 480,
		failures: 5,
		exhaustedDayKey: "2026-07-14",
		enabled: false,
		quarantinedReason: "auth",
		lastErrorCode: "auth",
	});
	const result = normalizeKeyForDay(key, "2026-07-15");
	assert.equal(result.dayKey, "2026-07-15");
	assert.equal(result.attempts, 0);
	assert.equal(result.successes, 0);
	assert.equal(result.failures, 0);
	assert.equal(result.exhaustedDayKey, undefined);
	// Enabled/disabled and auth quarantine survive the daily reset.
	assert.equal(result.enabled, false);
	assert.equal(result.quarantinedReason, "auth");
});

function makeState(keys: GeminiPoolKey[], softDailyLimit = DEFAULT_SOFT_DAILY_LIMIT): GeminiKeyPoolState {
	return { version: 1, softDailyLimit, keys };
}

const DAY = "2026-07-15";
const NOW = Date.parse("2026-07-15T12:00:00Z");

test("selectKey: picks the eligible key with the lowest attempts", () => {
	const low = makeKey({ id: "low", dayKey: DAY, attempts: 1 });
	const high = makeKey({ id: "high", dayKey: DAY, attempts: 5 });
	const state = makeState([high, low]);
	const picked = selectKey(state, DAY, NOW, new Set());
	assert.equal(picked?.id, "low");
});

test("selectKey: ties on attempts break by oldest lastUsedAt (never-used beats used)", () => {
	const used = makeKey({ id: "used", dayKey: DAY, attempts: 2, lastUsedAt: NOW - 1000 });
	const unused = makeKey({ id: "unused", dayKey: DAY, attempts: 2 });
	const state = makeState([used, unused]);
	assert.equal(selectKey(state, DAY, NOW, new Set())?.id, "unused");
});

test("selectKey: full ties fall back to stable key order (first eligible key wins)", () => {
	const a = makeKey({ id: "a", dayKey: DAY, attempts: 0 });
	const b = makeKey({ id: "b", dayKey: DAY, attempts: 0 });
	const state = makeState([a, b]);
	assert.equal(selectKey(state, DAY, NOW, new Set())?.id, "a");
});

test("selectKey: excludes a key at or above the soft daily limit", () => {
	const atCap = makeKey({ id: "at-cap", dayKey: DAY, attempts: 490 });
	const under = makeKey({ id: "under", dayKey: DAY, attempts: 489 });
	const state = makeState([atCap, under]);
	assert.equal(selectKey(state, DAY, NOW, new Set())?.id, "under");
});

test("selectKey: excludes a key on an active cooldown, includes one whose cooldown has passed", () => {
	const cooling = makeKey({ id: "cooling", dayKey: DAY, attempts: 0, cooldownUntil: NOW + 60_000 });
	const cooled = makeKey({ id: "cooled", dayKey: DAY, attempts: 1, cooldownUntil: NOW - 1 });
	const state = makeState([cooling, cooled]);
	assert.equal(selectKey(state, DAY, NOW, new Set())?.id, "cooled");
});

test("selectKey: excludes a key already daily-exhausted for the current Pacific day", () => {
	const exhausted = makeKey({ id: "exhausted", dayKey: DAY, attempts: 0, exhaustedDayKey: DAY });
	const ok = makeKey({ id: "ok", dayKey: DAY, attempts: 10 });
	const state = makeState([exhausted, ok]);
	assert.equal(selectKey(state, DAY, NOW, new Set())?.id, "ok");
});

test("selectKey: excludes disabled and auth-quarantined keys", () => {
	const disabled = makeKey({ id: "disabled", dayKey: DAY, attempts: 0, enabled: false });
	const quarantined = makeKey({ id: "quarantined", dayKey: DAY, attempts: 0, quarantinedReason: "auth" });
	const ok = makeKey({ id: "ok", dayKey: DAY, attempts: 10 });
	const state = makeState([disabled, quarantined, ok]);
	assert.equal(selectKey(state, DAY, NOW, new Set())?.id, "ok");
});

test("selectKey: excludes keys already attempted in the current compaction", () => {
	const a = makeKey({ id: "a", dayKey: DAY, attempts: 0 });
	const b = makeKey({ id: "b", dayKey: DAY, attempts: 5 });
	const state = makeState([a, b]);
	assert.equal(selectKey(state, DAY, NOW, new Set(["a"]))?.id, "b");
});

test("selectKey: returns null when no key is eligible", () => {
	const state = makeState([makeKey({ id: "a", dayKey: DAY, enabled: false })]);
	assert.equal(selectKey(state, DAY, NOW, new Set()), null);
});

test("fingerprint: shows only a short trailing slice, never the full secret", () => {
	const secret = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ7xQ2";
	const masked = fingerprint(secret);
	assert.ok(masked.endsWith("7xQ2"));
	assert.ok(!masked.includes(secret));
	assert.ok(masked.length < secret.length);
});

test("fingerprint: short secrets still never reveal the full value", () => {
	const masked = fingerprint("abcd");
	assert.notEqual(masked, "abcd");
});

test("classifyGeminiError: structured 401/403 status classifies as auth", () => {
	assert.equal(classifyGeminiError({ status: 401, message: "denied" }).code, "auth");
	assert.equal(classifyGeminiError({ status: 403, message: "denied" }).code, "auth");
});

test("classifyGeminiError: message-only auth failure classifies as auth", () => {
	const err = new Error("API key not valid. Please pass a valid API key.");
	assert.equal(classifyGeminiError(err).code, "auth");
});

test("classifyGeminiError: 429 with a daily-quota message classifies as quota-daily", () => {
	const err = {
		status: 429,
		message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per day'.",
	};
	assert.equal(classifyGeminiError(err).code, "quota-daily");
});

test("classifyGeminiError: 429 without a daily mention classifies as transient rate-limit", () => {
	const err = { status: 429, message: "Resource has been exhausted, try again later." };
	const result = classifyGeminiError(err);
	assert.equal(result.code, "rate-limit");
});

test("classifyGeminiError: extracts a provider-supplied retryDelay for transient 429s", () => {
	const err = { status: 429, message: 'Rate limited. { "retryDelay": "35s" }' };
	assert.equal(classifyGeminiError(err).retryDelayMs, 35_000);
});

test("classifyGeminiError: 5xx provider failures do not rotate (code is null)", () => {
	assert.equal(classifyGeminiError({ status: 500, message: "internal error" }).code, null);
});

test("classifyGeminiError: context-overflow message does not rotate (code is null)", () => {
	const err = new Error("The input token count exceeds the maximum number of tokens allowed");
	assert.equal(classifyGeminiError(err).code, null);
});

test("classifyGeminiError: an ambiguous message mentioning only 'limit' never rotates (no broad-word match)", () => {
	const err = new Error("The response was too large for the token limit.");
	assert.equal(classifyGeminiError(err).code, null);
});

function withTempPaths(fn: (paths: PoolPaths) => void | Promise<void>): Promise<void> {
	const cacheDir = mkdtempSync(join(tmpdir(), "gemini-keypool-test-"));
	const stateFile = join(cacheDir, "gemini-keypool.json");
	const paths: PoolPaths = { cacheDir, stateFile, lockFile: `${stateFile}.lock` };
	return Promise.resolve()
		.then(() => fn(paths))
		.finally(() => rmSync(cacheDir, { recursive: true, force: true }));
}

function sampleState(): GeminiKeyPoolState {
	return { version: 1, softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT, keys: [makeKey()] };
}

test("writePoolStateFile: creates the cache dir at 0700 and the state file at 0600", async () => {
	await withTempPaths((paths) => {
		writePoolStateFile(paths, sampleState());
		const dirMode = statSync(paths.cacheDir).mode & 0o777;
		const fileMode = statSync(paths.stateFile).mode & 0o777;
		assert.equal(dirMode, 0o700);
		assert.equal(fileMode, 0o600);
	});
});

test("writePoolStateFile: repairs mode 0600 on an existing over-permissive file", async () => {
	await withTempPaths((paths) => {
		writePoolStateFile(paths, sampleState());
		// Simulate an over-permissive file from outside our writer.
		writeFileSync(paths.stateFile, JSON.stringify(sampleState()), { mode: 0o644 });
		writePoolStateFile(paths, sampleState());
		const fileMode = statSync(paths.stateFile).mode & 0o777;
		assert.equal(fileMode, 0o600);
	});
});

test("loadPoolStateFile: round-trips a state written by writePoolStateFile", async () => {
	await withTempPaths((paths) => {
		const state = sampleState();
		writePoolStateFile(paths, state);
		const result = loadPoolStateFile(paths);
		assert.equal(result.corrupt, false);
		assert.deepEqual(result.state, state);
	});
});

test("loadPoolStateFile: missing file is absent, not corrupt", async () => {
	await withTempPaths((paths) => {
		const result = loadPoolStateFile(paths);
		assert.equal(result.state, null);
		assert.equal(result.corrupt, false);
	});
});

test("loadPoolStateFile: malformed JSON fails closed without deleting or rewriting the file", async () => {
	await withTempPaths((paths) => {
		writeFileSync(paths.stateFile, "{ not valid json", { mode: 0o600 });
		const before = readFileSync(paths.stateFile, "utf-8");
		const result = loadPoolStateFile(paths);
		assert.equal(result.state, null);
		assert.equal(result.corrupt, true);
		const after = readFileSync(paths.stateFile, "utf-8");
		assert.equal(after, before);
	});
});

test("loadPoolStateFile: structurally invalid state (missing required fields) fails closed", async () => {
	await withTempPaths((paths) => {
		writeFileSync(paths.stateFile, JSON.stringify({ version: 1, keys: "nope" }), { mode: 0o600 });
		const result = loadPoolStateFile(paths);
		assert.equal(result.state, null);
		assert.equal(result.corrupt, true);
	});
});

test("acquirePoolLock: sequential acquire/release cycles succeed", async () => {
	await withTempPaths(async (paths) => {
		const release1 = await acquirePoolLock(paths);
		release1();
		const release2 = await acquirePoolLock(paths);
		release2();
	});
});

test("acquirePoolLock: a concurrent acquisition waits for the lock to be released (mutual exclusion)", async () => {
	await withTempPaths(async (paths) => {
		const release1 = await acquirePoolLock(paths);
		let secondAcquired = false;
		const secondPromise = acquirePoolLock(paths).then((release2) => {
			secondAcquired = true;
			release2();
		});

		// Give the second attempt a chance to run — it must NOT have acquired yet.
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(secondAcquired, false);

		release1();
		await secondPromise;
		assert.equal(secondAcquired, true);
	});
});

test("acquirePoolLock: a stale lock (older than the bound) is recovered instead of blocking forever", async () => {
	await withTempPaths(async (paths) => {
		writeFileSync(paths.lockFile, "99999", { mode: 0o600 });
		const old = new Date(Date.now() - 60_000);
		utimesSync(paths.lockFile, old, old);

		// Bound staleness at 1s so this test doesn't wait for the real default.
		const release = await acquirePoolLock(paths, 1_000);
		release();
	});
});

function poolStateWithTwoKeys(): GeminiKeyPoolState {
	return {
		version: 1,
		softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT,
		keys: [
			makeKey({ id: "a", secret: "AIzaSyKEY_A_FAKESECRET000000000000", dayKey: DAY, attempts: 0, successes: 0, failures: 0 }),
			makeKey({ id: "b", secret: "AIzaSyKEY_B_FAKESECRET111111111111", dayKey: DAY, attempts: 0, successes: 0, failures: 0 }),
		],
	};
}

test("reserveKey: increments attempts and sets lastUsedAt for the selected key, persisted under lock", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const reserved = await reserveKey(paths, new Set(), NOW);
		assert.equal(reserved?.id, "a");
		assert.equal(reserved?.attempts, 1);
		assert.equal(reserved?.lastUsedAt, NOW);

		const { state } = loadPoolStateFile(paths);
		const persisted = state?.keys.find((k) => k.id === "a");
		assert.equal(persisted?.attempts, 1);
		assert.equal(persisted?.lastUsedAt, NOW);
	});
});

test("reserveKey: excludes already-attempted keys and returns null once none remain", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const attempted = new Set<string>(["a", "b"]);
		const reserved = await reserveKey(paths, attempted, NOW);
		assert.equal(reserved, null);
	});
});

test("reserveKey: returns null when no pool state exists (no file)", async () => {
	await withTempPaths(async (paths) => {
		const reserved = await reserveKey(paths, new Set(), NOW);
		assert.equal(reserved, null);
	});
});

test("recordOutcome: success increments successes for the given key only", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		await recordOutcome(paths, "a", { kind: "success" }, NOW);
		const { state } = loadPoolStateFile(paths);
		const a = state?.keys.find((k) => k.id === "a");
		const b = state?.keys.find((k) => k.id === "b");
		assert.equal(a?.successes, 1);
		assert.equal(b?.successes, 0);
	});
});

test("recordOutcome: quota-daily failure sets exhaustedDayKey to the current Pacific day", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		await recordOutcome(paths, "a", { kind: "failure", classification: { code: "quota-daily" } }, NOW);
		const { state } = loadPoolStateFile(paths);
		const a = state?.keys.find((k) => k.id === "a");
		assert.equal(a?.exhaustedDayKey, pacificDayKey(new Date(NOW)));
		assert.equal(a?.failures, 1);
		assert.equal(a?.lastErrorCode, "quota-daily");
	});
});

test("recordOutcome: transient rate-limit failure sets a cooldown (provider delay or 60s default)", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		await recordOutcome(paths, "a", { kind: "failure", classification: { code: "rate-limit" } }, NOW);
		const { state } = loadPoolStateFile(paths);
		const a = state?.keys.find((k) => k.id === "a");
		assert.equal(a?.cooldownUntil, NOW + 60_000);

		await recordOutcome(
			paths,
			"b",
			{ kind: "failure", classification: { code: "rate-limit", retryDelayMs: 5_000 } },
			NOW,
		);
		const { state: state2 } = loadPoolStateFile(paths);
		const b = state2?.keys.find((k) => k.id === "b");
		assert.equal(b?.cooldownUntil, NOW + 5_000);
	});
});

test("recordOutcome: auth failure quarantines the key until explicitly cleared", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		await recordOutcome(paths, "a", { kind: "failure", classification: { code: "auth" } }, NOW);
		const { state } = loadPoolStateFile(paths);
		const a = state?.keys.find((k) => k.id === "a");
		assert.equal(a?.quarantinedReason, "auth");
		assert.equal(a?.lastErrorCode, "auth");
	});
});

const GEMINI_MODEL = { provider: "google", id: "gemini-3.1-flash-lite" };

function textResponse(text: string) {
	return { content: [{ type: "text", text }] };
}

function collectingNotify(): { calls: Array<{ message: string; type: string }>; notify: (message: string, type: "info" | "warning" | "error") => void } {
	const calls: Array<{ message: string; type: string }> = [];
	return { calls, notify: (message, type) => calls.push({ message, type }) };
}

test("runGeminiKeyPoolCompletion: first key succeeds — exactly one call and the correct text", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const calls: unknown[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			calls.push(opts.apiKey ?? "");
			return textResponse("the summary");
		};
		const { notify } = collectingNotify();
		const result = await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: new AbortController().signal,
			completeFn,
			now: NOW,
			notify,
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.text, "the summary");
		assert.equal(calls.length, 1);

		const { state } = loadPoolStateFile(paths);
		const a = state?.keys.find((k) => k.id === "a");
		assert.equal(a?.successes, 1);
	});
});

test("runGeminiKeyPoolCompletion: first key gets a key-specific 429, second key retries and succeeds", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const usedApiKeys: string[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			usedApiKeys.push(opts.apiKey ?? "");
			if (usedApiKeys.length === 1) {
				throw { status: 429, message: "Resource exhausted, try again later." };
			}
			return textResponse("second key summary");
		};
		const result = await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: new AbortController().signal,
			completeFn,
			now: NOW,
		});
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.text, "second key summary");
		assert.equal(usedApiKeys.length, 2);
		assert.notEqual(usedApiKeys[0], usedApiKeys[1]);

		const { state } = loadPoolStateFile(paths);
		const a = state?.keys.find((k) => k.id === "a");
		const b = state?.keys.find((k) => k.id === "b");
		assert.equal(a?.cooldownUntil, NOW + 60_000);
		assert.equal(b?.successes, 1);
	});
});

test("runGeminiKeyPoolCompletion: a non-key failure stops rotation — no second attempt", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const usedApiKeys: string[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			usedApiKeys.push(opts.apiKey ?? "");
			throw new Error("The input token count exceeds the maximum number of tokens allowed");
		};
		const result = await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: new AbortController().signal,
			completeFn,
			now: NOW,
		});
		assert.deepEqual(result, { ok: false, reason: "non-key-failure" });
		assert.equal(usedApiKeys.length, 1);

		const { state } = loadPoolStateFile(paths);
		const a = state?.keys.find((k) => k.id === "a");
		// The reservation attempt is conservatively counted, but no rotation-relevant
		// state (failures/cooldown/exhaustion) was mutated for an unclassified error.
		assert.equal(a?.attempts, 1);
		assert.equal(a?.failures, 0);
	});
});

test("runGeminiKeyPoolCompletion: abort during the first attempt stops rotation without a retry", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const controller = new AbortController();
		const usedApiKeys: string[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			usedApiKeys.push(opts.apiKey ?? "");
			controller.abort();
			throw new Error("aborted");
		};
		const result = await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: controller.signal,
			completeFn,
			now: NOW,
		});
		assert.deepEqual(result, { ok: false, reason: "aborted" });
		assert.equal(usedApiKeys.length, 1);
	});
});

test("runGeminiKeyPoolCompletion: all keys unavailable is distinguishable, so the caller knows to try MiniMax-M3", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, {
			version: 1,
			softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT,
			keys: [makeKey({ id: "a", dayKey: DAY, enabled: false })],
		});
		const completeFn = async () => textResponse("unused");
		const result = await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: new AbortController().signal,
			completeFn,
			now: NOW,
		});
		assert.deepEqual(result, { ok: false, reason: "all-unavailable" });
	});
});

test("runGeminiKeyPoolCompletion: notifications never include the plaintext secret, only fingerprints", async () => {
	await withTempPaths(async (paths) => {
		const state = poolStateWithTwoKeys();
		writePoolStateFile(paths, state);
		const completeFn = async () => textResponse("ok");
		const { calls, notify } = collectingNotify();
		await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: new AbortController().signal,
			completeFn,
			now: NOW,
			notify,
		});
		assert.ok(calls.length > 0);
		for (const call of calls) {
			for (const key of state.keys) {
				assert.ok(!call.message.includes(key.secret), `notification leaked secret: ${call.message}`);
			}
		}
	});
});

function fakeModelRegistry(options: {
	model?: { provider: string; id: string } | null;
	auth?: { ok: boolean; apiKey?: string; headers?: Record<string, string> };
}) {
	return {
		find: (_provider: string, _id: string) => options.model ?? undefined,
		getApiKeyAndHeaders: async (_model: unknown) => options.auth ?? { ok: false },
	};
}

test("MINIMAX_FALLBACK: names the explicit fallback model, not the active conversation model", () => {
	assert.deepEqual(MINIMAX_FALLBACK, { provider: "minimax", model: "MiniMax-M3" });
});

test("attemptFallbackModel: succeeds against the explicit fallback model when authed", async () => {
	const registry = fakeModelRegistry({
		model: { provider: "minimax", id: "MiniMax-M3" },
		auth: { ok: true, apiKey: "minimax-secret" },
	});
	const usedApiKeys: string[] = [];
	const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
		usedApiKeys.push(opts.apiKey ?? "");
		return textResponse("fallback summary");
	};
	const result = await attemptFallbackModel({
		modelRegistry: registry,
		provider: MINIMAX_FALLBACK.provider,
		modelId: MINIMAX_FALLBACK.model,
		messages: [],
		maxTokens: 8192,
		signal: new AbortController().signal,
		completeFn,
	});
	assert.equal(result?.text, "fallback summary");
	assert.deepEqual(usedApiKeys, ["minimax-secret"]);
});

test("attemptFallbackModel: returns null when the fallback model is not registered", async () => {
	const registry = fakeModelRegistry({ model: null });
	const completeFn = async () => textResponse("unused");
	const result = await attemptFallbackModel({
		modelRegistry: registry,
		provider: MINIMAX_FALLBACK.provider,
		modelId: MINIMAX_FALLBACK.model,
		messages: [],
		maxTokens: 8192,
		signal: new AbortController().signal,
		completeFn,
	});
	assert.equal(result, null);
});

test("attemptFallbackModel: returns null when there is no auth for the fallback model", async () => {
	const registry = fakeModelRegistry({
		model: { provider: "minimax", id: "MiniMax-M3" },
		auth: { ok: false },
	});
	const completeFn = async () => textResponse("unused");
	const result = await attemptFallbackModel({
		modelRegistry: registry,
		provider: MINIMAX_FALLBACK.provider,
		modelId: MINIMAX_FALLBACK.model,
		messages: [],
		maxTokens: 8192,
		signal: new AbortController().signal,
		completeFn,
	});
	assert.equal(result, null);
});

test("attemptFallbackModel: a completion failure returns null rather than throwing", async () => {
	const registry = fakeModelRegistry({
		model: { provider: "minimax", id: "MiniMax-M3" },
		auth: { ok: true, apiKey: "minimax-secret" },
	});
	const completeFn = async () => {
		throw new Error("network down");
	};
	const result = await attemptFallbackModel({
		modelRegistry: registry,
		provider: MINIMAX_FALLBACK.provider,
		modelId: MINIMAX_FALLBACK.model,
		messages: [],
		maxTokens: 8192,
		signal: new AbortController().signal,
		completeFn,
	});
	assert.equal(result, null);
});

const NON_GEMINI_MODEL = { provider: "anthropic", id: "claude-sonnet-4-5" };
const NORMAL_AUTH = { apiKey: "normal-auth-key", headers: undefined };

function hookOptionsBase(overrides: Partial<Parameters<typeof runCompactionHook>[0]> = {}) {
	return {
		model: NON_GEMINI_MODEL,
		auth: NORMAL_AUTH,
		conversationText: "hi",
		previousSummary: undefined,
		tokensBefore: 1000,
		firstKeptEntryId: "entry-1",
		signal: new AbortController().signal,
		completeFn: async () => textResponse("unused"),
		modelRegistry: fakeModelRegistry({ model: null }),
		notify: () => {},
		poolPaths: { cacheDir: "/nonexistent", stateFile: "/nonexistent/gemini-keypool.json", lockFile: "/nonexistent/gemini-keypool.json.lock" },
		now: NOW,
		...overrides,
	};
}

test("runCompactionHook: non-Gemini model uses the existing single-auth path unchanged", async () => {
	const usedApiKeys: string[] = [];
	const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
		usedApiKeys.push(opts.apiKey ?? "");
		return textResponse("normal summary");
	};
	const result = await runCompactionHook(hookOptionsBase({ completeFn }));
	assert.equal(result?.summary, "normal summary");
	assert.deepEqual(usedApiKeys, ["normal-auth-key"]);
});

test("runCompactionHook: Gemini Flash Lite with no configured pool uses the existing single-auth path unchanged", async () => {
	await withTempPaths(async (paths) => {
		// No pool file written at paths.stateFile — pool absent.
		const usedApiKeys: string[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			usedApiKeys.push(opts.apiKey ?? "");
			return textResponse("normal summary");
		};
		const result = await runCompactionHook(
			hookOptionsBase({ model: GEMINI_MODEL, completeFn, poolPaths: paths }),
		);
		assert.equal(result?.summary, "normal summary");
		assert.deepEqual(usedApiKeys, ["normal-auth-key"]);
	});
});

test("runCompactionHook: Gemini Flash Lite with an activated pool uses a pool key, not the normal auth", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const usedApiKeys: string[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			usedApiKeys.push(opts.apiKey ?? "");
			return textResponse("pool summary");
		};
		const result = await runCompactionHook(
			hookOptionsBase({ model: GEMINI_MODEL, completeFn, poolPaths: paths }),
		);
		assert.equal(result?.summary, "pool summary");
		assert.deepEqual(usedApiKeys, ["AIzaSyKEY_A_FAKESECRET000000000000"]);
	});
});

test("runCompactionHook: all pool keys unavailable explicitly falls back to MiniMax-M3", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, {
			version: 1,
			softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT,
			keys: [makeKey({ id: "a", dayKey: DAY, enabled: false })],
		});
		const usedModels: string[] = [];
		const completeFn = async (model: { provider: string; id: string }) => {
			usedModels.push(`${model.provider}/${model.id}`);
			return textResponse("minimax summary");
		};
		const modelRegistry = fakeModelRegistry({
			model: { provider: "minimax", id: "MiniMax-M3" },
			auth: { ok: true, apiKey: "minimax-secret" },
		});
		const result = await runCompactionHook(
			hookOptionsBase({ model: GEMINI_MODEL, completeFn, modelRegistry, poolPaths: paths }),
		);
		assert.equal(result?.summary, "minimax summary");
		assert.deepEqual(usedModels, ["minimax/MiniMax-M3"]);
	});
});

test("runCompactionHook: all pool keys AND MiniMax-M3 unavailable returns null for Pi's own default fallback", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, {
			version: 1,
			softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT,
			keys: [makeKey({ id: "a", dayKey: DAY, enabled: false })],
		});
		const completeFn = async () => textResponse("unused");
		const modelRegistry = fakeModelRegistry({ model: null });
		const result = await runCompactionHook(
			hookOptionsBase({ model: GEMINI_MODEL, completeFn, modelRegistry, poolPaths: paths }),
		);
		assert.equal(result, null);
	});
});

test("runCompactionHook: existing single-auth network failure still returns null (non-Gemini path unaffected)", async () => {
	const completeFn = async () => {
		throw new Error("network down");
	};
	const result = await runCompactionHook(hookOptionsBase({ completeFn }));
	assert.equal(result, null);
});

test("validateKeySecret: accepts a trimmed, non-empty, whitespace-free value", () => {
	const result = validateKeySecret("  AIzaSyABCDEF1234567890  ");
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.secret, "AIzaSyABCDEF1234567890");
});

test("validateKeySecret: rejects empty/whitespace-only input", () => {
	assert.equal(validateKeySecret("").ok, false);
	assert.equal(validateKeySecret("   ").ok, false);
});

test("validateKeySecret: rejects embedded whitespace or control characters", () => {
	assert.equal(validateKeySecret("AIza abc").ok, false);
	assert.equal(validateKeySecret("AIza\tabc").ok, false);
	assert.equal(validateKeySecret("AIza\nabc").ok, false);
});

test("validateKeySecret: does not hardcode a single required key prefix", () => {
	// A non-Google-shaped-but-otherwise-valid secret must still be accepted;
	// validation is purely structural (trimmed/non-empty/no embedded whitespace).
	assert.equal(validateKeySecret("sk-not-an-aiza-prefixed-value").ok, true);
});

test("addKeyToPool: appends a new enabled key for today with zeroed counters", () => {
	const state: GeminiKeyPoolState = { version: 1, softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT, keys: [] };
	const next = addKeyToPool(state, "AIzaNewSecretValue000000000000", NOW);
	assert.equal(next.keys.length, 1);
	const added = next.keys[0];
	assert.equal(added.secret, "AIzaNewSecretValue000000000000");
	assert.equal(added.enabled, true);
	assert.equal(added.attempts, 0);
	assert.equal(added.dayKey, pacificDayKey(new Date(NOW)));
	assert.ok(added.id.length > 0);
});

test("addKeyToPool: does not mutate the original state object", () => {
	const state: GeminiKeyPoolState = { version: 1, softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT, keys: [] };
	addKeyToPool(state, "AIzaAnother0000000000000000000", NOW);
	assert.equal(state.keys.length, 0);
});

test("removeKeyFromPool: removes only the targeted key", () => {
	const state = poolStateWithTwoKeys();
	const next = removeKeyFromPool(state, "a");
	assert.deepEqual(
		next.keys.map((k) => k.id),
		["b"],
	);
});

test("setKeyEnabled: toggles enabled only for the targeted key", () => {
	const state = poolStateWithTwoKeys();
	const next = setKeyEnabled(state, "a", false);
	assert.equal(next.keys.find((k) => k.id === "a")?.enabled, false);
	assert.equal(next.keys.find((k) => k.id === "b")?.enabled, true);
});

test("clearKeyQuarantine: clears quarantinedReason for the targeted key only", () => {
	const state: GeminiKeyPoolState = {
		version: 1,
		softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT,
		keys: [
			makeKey({ id: "a", quarantinedReason: "auth" }),
			makeKey({ id: "b", quarantinedReason: "auth" }),
		],
	};
	const next = clearKeyQuarantine(state, "a");
	assert.equal(next.keys.find((k) => k.id === "a")?.quarantinedReason, undefined);
	assert.equal(next.keys.find((k) => k.id === "b")?.quarantinedReason, "auth");
});

test("setSoftDailyLimit: clamps to the 1–500 bound", () => {
	const state: GeminiKeyPoolState = { version: 1, softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT, keys: [] };
	assert.equal(setSoftDailyLimit(state, 0).softDailyLimit, 1);
	assert.equal(setSoftDailyLimit(state, 501).softDailyLimit, 500);
	assert.equal(setSoftDailyLimit(state, 250).softDailyLimit, 250);
});

test("mutatePoolState: applies a mutation under lock, defaulting to an empty pool when no file exists", async () => {
	await withTempPaths(async (paths) => {
		const next = await mutatePoolState(paths, (state) => addKeyToPool(state, "AIzaFirstEverKey00000000000000", NOW));
		assert.equal(next.keys.length, 1);
		const { state: persisted } = loadPoolStateFile(paths);
		assert.equal(persisted?.keys.length, 1);
		assert.equal(persisted?.keys[0]?.secret, "AIzaFirstEverKey00000000000000");
	});
});

test("mutatePoolState: mutation sees and persists on top of the current on-disk state", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		await mutatePoolState(paths, (state) => setKeyEnabled(state, "a", false));
		const { state } = loadPoolStateFile(paths);
		assert.equal(state?.keys.find((k) => k.id === "a")?.enabled, false);
		assert.equal(state?.keys.find((k) => k.id === "b")?.enabled, true);
	});
});

test("reserveSpecificKey: reserves the targeted key by id, incrementing its attempts", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const reserved = await reserveSpecificKey(paths, "a", NOW);
		assert.equal(reserved?.id, "a");
		const { state } = loadPoolStateFile(paths);
		assert.equal(state?.keys.find((k) => k.id === "a")?.attempts, 1);
		assert.equal(state?.keys.find((k) => k.id === "a")?.lastUsedAt, NOW);
		// Key b is untouched.
		assert.equal(state?.keys.find((k) => k.id === "b")?.attempts, 0);
	});
});

test("reserveSpecificKey: returns null when the key id does not exist", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const reserved = await reserveSpecificKey(paths, "nonexistent", NOW);
		assert.equal(reserved, null);
	});
});

test("reserveSpecificKey: returns null when no pool state exists", async () => {
	await withTempPaths(async (paths) => {
		const reserved = await reserveSpecificKey(paths, "a", NOW);
		assert.equal(reserved, null);
	});
});

test("reserveSpecificKey: still normalizes for the current Pacific day before reserving", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, {
			version: 1,
			softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT,
			keys: [makeKey({ id: "a", dayKey: "2026-07-14", attempts: 100, successes: 90, failures: 10, exhaustedDayKey: "2026-07-14" })],
		});
		const reserved = await reserveSpecificKey(paths, "a", NOW);
		assert.equal(reserved?.id, "a");
		// Counters reset for the new day, then attempts incremented to 1.
		assert.equal(reserved?.attempts, 1);
		assert.equal(reserved?.successes, 0);
		assert.equal(reserved?.exhaustedDayKey, undefined);
	});
});

test("verifyPoolKey: success records a success and returns ok with the response text", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const usedKeys: string[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			usedKeys.push(opts.apiKey ?? "");
			return textResponse("verify ok");
		};
		const result = await verifyPoolKey(paths, "a", completeFn, NOW);
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.text, "verify ok");
		assert.deepEqual(usedKeys, ["AIzaSyKEY_A_FAKESECRET000000000000"]);
		const { state } = loadPoolStateFile(paths);
		assert.equal(state?.keys.find((k) => k.id === "a")?.successes, 1);
		assert.equal(state?.keys.find((k) => k.id === "a")?.attempts, 1);
	});
});

test("verifyPoolKey: a 429 rate-limit failure records the failure and returns not-ok", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const completeFn = async () => {
			const err = new Error("RESOURCE_EXHAUSTED");
			Object.assign(err, { status: 429 });
			throw err;
		};
		const result = await verifyPoolKey(paths, "a", completeFn, NOW);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "failure");
		const { state } = loadPoolStateFile(paths);
		assert.equal(state?.keys.find((k) => k.id === "a")?.failures, 1);
		assert.equal(state?.keys.find((k) => k.id === "a")?.lastErrorCode, "rate-limit");
	});
});

test("verifyPoolKey: a 401 auth failure quarantines the key", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const completeFn = async () => {
			const err = new Error("API key not valid");
			Object.assign(err, { status: 401 });
			throw err;
		};
		const result = await verifyPoolKey(paths, "a", completeFn, NOW);
		assert.equal(result.ok, false);
		const { state } = loadPoolStateFile(paths);
		assert.equal(state?.keys.find((k) => k.id === "a")?.quarantinedReason, "auth");
	});
});

test("verifyPoolKey: returns not-found when the key id does not exist", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const result = await verifyPoolKey(paths, "nonexistent", async () => textResponse("unused"), NOW);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "not-found");
	});
});

test("verifyPoolKey: notifications never include the plaintext secret, only fingerprints", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const completeFn = async () => textResponse("ok");
		const { calls, notify } = collectingNotify();
		await verifyPoolKey(paths, "a", completeFn, NOW, notify);
		for (const { message } of calls) {
			assert.ok(!message.includes("AIzaSyKEY_A_FAKESECRET"), `notification leaked plaintext: ${message}`);
		}
	});
});

// ── Review fix cycle: RED tests ──────────────────────────────────

test("I-1: LOCK_MAX_WAIT_MS strictly exceeds LOCK_STALE_MS", () => {
	// A lock held for the full stale threshold must still be recoverable
	// within the max wait window. If max wait < stale, a lock that becomes
	// stale at the exact threshold would already be past the deadline.
	assert.ok(LOCK_MAX_WAIT_MS > LOCK_STALE_MS, `max wait (${LOCK_MAX_WAIT_MS}) must exceed stale (${LOCK_STALE_MS})`);
});

test("I-2: runCompactionHook catches unexpected pool persistence errors and returns null", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		// Point the lock file to a path whose parent doesn't exist so
		// acquirePoolLock throws ENOENT inside the pool-activated branch.
		const badPaths: PoolPaths = {
			cacheDir: paths.cacheDir,
			stateFile: paths.stateFile,
			lockFile: "/nonexistent/dir/gemini-keypool.json.lock",
		};
		const { calls, notify } = collectingNotify();
		const result = await runCompactionHook(
			hookOptionsBase({ model: GEMINI_MODEL, poolPaths: badPaths, notify }),
		);
		assert.equal(result, null);
		assert.ok(calls.some((c) => c.type === "warning" || c.type === "error"), "expected a sanitized warning notification");
	});
});

test("I-3: successful Gemini response is not discarded when recordOutcome fails", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const { calls, notify } = collectingNotify();
		// After the completion succeeds, sabotage the lock file path so
		// recordOutcome's acquirePoolLock throws. The summary must still
		// be returned (best-effort accounting).
		let callCount = 0;
		const completeFn = async () => {
			callCount++;
			if (callCount === 1) {
				// Swap the lock file to an invalid path for recordOutcome.
				paths.lockFile = "/nonexistent/dir/gemini-keypool.json.lock";
				return textResponse("pool summary");
			}
			return textResponse("unused");
		};
		const result = await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: new AbortController().signal,
			completeFn,
			now: NOW,
			notify,
		});
		// The summary must still be returned even if accounting failed.
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.text, "pool summary");
		// A generic warning about accounting should have been emitted.
		assert.ok(
			calls.some((c) => c.type === "warning"),
			"expected a warning about best-effort accounting failure",
		);
	});
});

test("I-5: verifyPoolKey never leaks raw provider error text in notifications or result", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const uniqueMarker = "SECRET_INTERNAL_DEBUG_TOKEN_XYZ789";
		const completeFn = async () => {
			const err = new Error(uniqueMarker);
			Object.assign(err, { status: 429 });
			throw err;
		};
		const { calls, notify } = collectingNotify();
		const result = await verifyPoolKey(paths, "a", completeFn, NOW, notify);
		assert.equal(result.ok, false);
		// The raw error message must not appear in any notification.
		for (const { message } of calls) {
			assert.ok(!message.includes(uniqueMarker), `notification leaked raw error: ${message}`);
		}
		// The result must not carry any raw error text — only classification code.
		if (!result.ok) {
			assert.equal((result as Record<string, unknown>).error, undefined, "result should not carry raw error text");
		}
	});
});

test("I-6: corrupt pool state during compaction notifies once and falls back without modifying the file", async () => {
	await withTempPaths(async (paths) => {
		// Write corrupt JSON to the state file.
		writeFileSync(paths.stateFile, "{ broken json", { mode: 0o600 });
		const { calls, notify } = collectingNotify();
		const usedApiKeys: string[] = [];
		const completeFn = async (_model: unknown, _ctx: unknown, opts: { apiKey?: string }) => {
			usedApiKeys.push(opts.apiKey ?? "");
			return textResponse("normal summary");
		};
		const result = await runCompactionHook(
			hookOptionsBase({ model: GEMINI_MODEL, completeFn, poolPaths: paths, notify }),
		);
		// Should fall back to single-auth path and produce a summary.
		assert.equal(result?.summary, "normal summary");
		assert.deepEqual(usedApiKeys, ["normal-auth-key"]);
		// The corrupt file must not have been modified.
		assert.equal(readFileSync(paths.stateFile, "utf-8"), "{ broken json");
		// Exactly one warning about corrupt state.
		const corruptWarnings = calls.filter((c) => c.message.includes("corrupt"));
		assert.equal(corruptWarnings.length, 1);
	});
});

test("I-7: pool loop does not emit 'using default compaction' when MiniMax succeeds", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, {
			version: 1,
			softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT,
			keys: [makeKey({ id: "a", dayKey: DAY, enabled: false })],
		});
		const { calls, notify } = collectingNotify();
		const completeFn = async (model: { provider: string; id: string }) => {
			if (model.provider === "minimax") return textResponse("minimax summary");
			throw new Error("should not reach Gemini");
		};
		const modelRegistry = fakeModelRegistry({
			model: { provider: "minimax", id: "MiniMax-M3" },
			auth: { ok: true, apiKey: "minimax-secret" },
		});
		const result = await runCompactionHook(
			hookOptionsBase({ model: GEMINI_MODEL, completeFn, modelRegistry, poolPaths: paths, notify }),
		);
		assert.equal(result?.summary, "minimax summary");
		// No notification should contain the contradictory 'using default compaction' wording.
		for (const { message } of calls) {
			assert.ok(!message.includes("using default compaction"), `contradictory notification: ${message}`);
		}
	});
});

// ── Final protected-boundary fix cycle: RED tests ────────────────

test("fingerprint: short secret does not appear in full as a substring of the output", () => {
	const short = "abcd";
	const masked = fingerprint(short);
	assert.ok(!masked.includes(short), `fingerprint leaked the full short secret: ${masked}`);
});

test("fingerprint: normal-length API key still shows useful first4/last4", () => {
	const secret = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ7xQ2";
	const masked = fingerprint(secret);
	assert.ok(masked.startsWith("AIza"), `expected first4 prefix, got: ${masked}`);
	assert.ok(masked.endsWith("7xQ2"), `expected last4 suffix, got: ${masked}`);
	assert.ok(!masked.includes(secret), `fingerprint leaked the full secret: ${masked}`);
});

test("verifyPoolKey: success remains ok when outcome persistence fails", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		const { calls, notify } = collectingNotify();
		let callCount = 0;
		const completeFn = async () => {
			callCount++;
			if (callCount === 1) {
				// Sabotage the lock path so recordOutcome's acquirePoolLock throws.
				paths.lockFile = "/nonexistent/dir/gemini-keypool.json.lock";
				return textResponse("ok");
			}
			return textResponse("unused");
		};
		const result = await verifyPoolKey(paths, "a", completeFn, NOW, notify);
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.text, "ok");
		assert.ok(
			calls.some((c) => c.type === "warning" && c.message.includes("accounting")),
			"expected a generic accounting warning",
		);
	});
});

test("runGeminiKeyPoolCompletion: failure-accounting persistence error returns non-key-failure, not all-unavailable", async () => {
	await withTempPaths(async (paths) => {
		writePoolStateFile(paths, poolStateWithTwoKeys());
		let callCount = 0;
		const completeFn = async () => {
			callCount++;
			if (callCount === 1) {
				// Sabotage the lock path so recordOutcome's acquirePoolLock throws.
				paths.lockFile = "/nonexistent/dir/gemini-keypool.json.lock";
				const err = new Error("RESOURCE_EXHAUSTED");
				Object.assign(err, { status: 429 });
				throw err;
			}
			return textResponse("unused");
		};
		const result = await runGeminiKeyPoolCompletion({
			paths,
			model: GEMINI_MODEL,
			messages: [],
			maxTokens: 8192,
			signal: new AbortController().signal,
			completeFn,
			now: NOW,
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, "non-key-failure");
		// Exactly one completion attempt — no rotation to a second key.
		assert.equal(callCount, 1);
	});
});

test("attemptFallbackModel: never leaks raw provider error text in notifications", async () => {
	const uniqueMarker = "FALLBACK_INTERNAL_DEBUG_TOKEN_ZXY999";
	const registry = fakeModelRegistry({
		model: { provider: "minimax", id: "MiniMax-M3" },
		auth: { ok: true, apiKey: "minimax-secret" },
	});
	const completeFn = async () => {
		throw new Error(uniqueMarker);
	};
	const { calls, notify } = collectingNotify();
	const result = await attemptFallbackModel({
		modelRegistry: registry,
		provider: MINIMAX_FALLBACK.provider,
		modelId: MINIMAX_FALLBACK.model,
		messages: [],
		maxTokens: 8192,
		signal: new AbortController().signal,
		completeFn,
		notify,
	});
	assert.equal(result, null);
	for (const { message } of calls) {
		assert.ok(!message.includes(uniqueMarker), `notification leaked raw error: ${message}`);
	}
});
