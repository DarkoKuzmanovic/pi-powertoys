/**
 * compact-model — Offload context compaction to a different model.
 *
 * Lets you pick any available model for summarization instead of burning
 * tokens on your primary conversation model. Ideal for fast, cheap models
 * with large context windows (e.g. Qwen3.5 on Wafer, Gemini Flash, etc.)
 *
 * Commands:
 *   /compact-model   — show current model, pick a new one, or disable
 *   /compact-keypool — manage the Gemini compaction key pool (masked)
 *
 * Config stored in ~/.pi/agent/cache/pi-powertoys/toys.json under the "compactModel" key.
 * Gemini key-pool state stored at ~/.pi/agent/cache/pi-powertoys/gemini-keypool.json (mode 0600).
 */

import { loadToyConfig, saveToyConfig, removeToyConfig } from "./toys-config.ts";
import {
	existsSync,
	mkdirSync,
	chmodSync,
	readFileSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	statSync,
	openSync,
	writeSync,
	closeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, DynamicBorder, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const TOY_KEY = "compactModel";

interface CompactModelConfig {
	provider: string;
	model: string;
}

function loadConfig(): CompactModelConfig | null {
	const raw = loadToyConfig<CompactModelConfig>(TOY_KEY);
	if (raw?.provider && raw?.model) return raw;
	return null;
}

function saveConfig(config: CompactModelConfig | null): void {
	if (config === null) {
		removeToyConfig(TOY_KEY);
	} else {
		saveToyConfig(TOY_KEY, config);
	}
}

// ── Gemini key pool: Pacific-day accounting ──────────────────────

const PACIFIC_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
	timeZone: "America/Los_Angeles",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/**
 * Calendar day key (YYYY-MM-DD) in America/Los_Angeles for the given instant.
 * Google's Gemini RPD quota resets at Pacific midnight; comparing calendar
 * keys (rather than adding a fixed 24h offset) handles PST/PDT transitions.
 */
export function pacificDayKey(date: Date): string {
	// en-CA formats as YYYY-MM-DD directly.
	return PACIFIC_DAY_FORMATTER.format(date);
}

// ── Gemini key pool: types ──────────────────────────────────────

export type GeminiErrorCode = "quota-daily" | "rate-limit" | "auth";

export interface GeminiPoolKey {
	id: string; // random UUID, never derived from the secret
	secret: string;
	enabled: boolean;
	dayKey: string; // calendar date in America/Los_Angeles
	attempts: number; // reserved before network call
	successes: number;
	failures: number;
	lastUsedAt?: number;
	cooldownUntil?: number;
	exhaustedDayKey?: string;
	quarantinedReason?: "auth";
	lastErrorCode?: GeminiErrorCode;
}

export interface GeminiKeyPoolState {
	version: 1;
	softDailyLimit: number; // default 490
	keys: GeminiPoolKey[];
}

export const DEFAULT_SOFT_DAILY_LIMIT = 490;

/**
 * Reset a key's daily counters when its stored `dayKey` differs from the
 * current Pacific calendar day. Preserves enabled/disabled and auth
 * quarantine state across the reset — only the daily-scoped fields move.
 */
export function normalizeKeyForDay(key: GeminiPoolKey, currentDayKey: string): GeminiPoolKey {
	if (key.dayKey === currentDayKey) return key;
	return {
		...key,
		dayKey: currentDayKey,
		attempts: 0,
		successes: 0,
		failures: 0,
		exhaustedDayKey: undefined,
	};
}

/** Apply {@link normalizeKeyForDay} across every key in a pool state. */
export function normalizeStateForDay(state: GeminiKeyPoolState, currentDayKey: string): GeminiKeyPoolState {
	return { ...state, keys: state.keys.map((key) => normalizeKeyForDay(key, currentDayKey)) };
}

/**
 * Whether a (day-normalized) key may be reserved for the current compaction.
 * Callers must normalize keys for the day before checking eligibility so
 * `attempts`/`exhaustedDayKey` reflect the current Pacific day.
 */
export function isKeyEligible(
	key: GeminiPoolKey,
	currentDayKey: string,
	softDailyLimit: number,
	now: number,
	attemptedIds: ReadonlySet<string>,
): boolean {
	if (!key.enabled) return false;
	if (key.quarantinedReason === "auth") return false;
	if (key.attempts >= softDailyLimit) return false;
	if (key.exhaustedDayKey === currentDayKey) return false;
	if (key.cooldownUntil !== undefined && key.cooldownUntil > now) return false;
	if (attemptedIds.has(key.id)) return false;
	return true;
}

/**
 * Select the eligible key with the lowest local attempt count, breaking ties
 * by oldest `lastUsedAt` (never-used keys are treated as oldest), then by
 * stable key order. Returns `null` when no key is eligible.
 */
export function selectKey(
	state: GeminiKeyPoolState,
	currentDayKey: string,
	now: number,
	attemptedIds: ReadonlySet<string>,
): GeminiPoolKey | null {
	let best: GeminiPoolKey | null = null;
	for (const rawKey of state.keys) {
		const key = normalizeKeyForDay(rawKey, currentDayKey);
		if (!isKeyEligible(key, currentDayKey, state.softDailyLimit, now, attemptedIds)) continue;
		if (best === null) {
			best = key;
			continue;
		}
		if (key.attempts < best.attempts) {
			best = key;
			continue;
		}
		if (key.attempts === best.attempts) {
			const keyLastUsed = key.lastUsedAt ?? -Infinity;
			const bestLastUsed = best.lastUsedAt ?? -Infinity;
			if (keyLastUsed < bestLastUsed) best = key;
		}
	}
	return best;
}

/**
 * Display-safe fingerprint for a key, e.g. `AIza…7xQ2`. Never returns or
 * logs the full secret; used by notifications and the `/compact-keypool`
 * overlay only. Secrets too short for safe prefix/suffix disclosure are
 * fully masked (no plaintext characters).
 */
export function fingerprint(secret: string): string {
	const trimmed = secret.trim();
	// Need at least 9 chars so first4 and last4 don't overlap (which would
	// reconstruct the full secret). Below that, mask entirely.
	if (trimmed.length < 9) return "\u2022\u2022\u2022\u2022";
	const prefix = trimmed.slice(0, 4);
	const suffix = trimmed.slice(-4);
	return `${prefix}\u2026${suffix}`;
}

// ── Gemini key pool: error classification ────────────────────────

export interface GeminiErrorClassification {
	code: GeminiErrorCode | null;
	/** Only meaningful for code === "rate-limit". */
	retryDelayMs?: number;
}

function extractStatusCode(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const err = error as Record<string, unknown>;
	const response = err.response as Record<string, unknown> | undefined;
	const nestedError = err.error as Record<string, unknown> | undefined;
	const candidates: unknown[] = [err.status, err.statusCode, response?.status, nestedError?.code];
	for (const candidate of candidates) {
		if (typeof candidate === "number") return candidate;
	}
	return undefined;
}

function extractMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null) {
		const err = error as Record<string, unknown>;
		if (typeof err.message === "string") return err.message;
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}
	return String(error);
}

function extractRetryDelayMs(message: string): number | undefined {
	const match = message.match(/retryDelay"?\s*[:=]?\s*"?(\d+)s/i);
	if (!match) return undefined;
	return Number(match[1]) * 1000;
}

/**
 * Classify a thrown Gemini completion error into a narrow, key-rotation
 * relevant code. Prefers structured status/details; falls back to narrow
 * message matching. Never classifies on a broad word such as "limit" alone
 * — ambiguous failures return `code: null` so the caller does not mutate key
 * state or rotate keys without confidence.
 */
export function classifyGeminiError(error: unknown): GeminiErrorClassification {
	const status = extractStatusCode(error);
	const message = extractMessage(error);

	if (status === 401 || status === 403) return { code: "auth" };
	if (/\bAPI key not valid\b/i.test(message) || /\bunauthorized\b/i.test(message) || /\bpermission denied\b/i.test(message)) {
		return { code: "auth" };
	}

	const isRateLimitStatus = status === 429;
	const mentionsResourceExhausted = /RESOURCE_EXHAUSTED/i.test(message);
	const mentionsTooManyRequests = /too many requests/i.test(message);
	const mentionsRateLimit = /rate.?limit/i.test(message);

	if (isRateLimitStatus || mentionsResourceExhausted || mentionsTooManyRequests || mentionsRateLimit) {
		const mentionsDaily = /\bper[\s-]?day\b/i.test(message) || /\bdaily\b/i.test(message);
		if (mentionsDaily) return { code: "quota-daily" };
		return { code: "rate-limit", retryDelayMs: extractRetryDelayMs(message) };
	}

	return { code: null };
}

// ── Gemini key pool: secure state storage ──────────────────────

export interface PoolPaths {
	cacheDir: string;
	stateFile: string;
	lockFile: string;
}

const DEFAULT_CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "pi-powertoys");
const DEFAULT_STATE_FILE = join(DEFAULT_CACHE_DIR, "gemini-keypool.json");

export function defaultPoolPaths(): PoolPaths {
	return { cacheDir: DEFAULT_CACHE_DIR, stateFile: DEFAULT_STATE_FILE, lockFile: `${DEFAULT_STATE_FILE}.lock` };
}

/** Directory mode 0700; state/lock files mode 0600, enforced on every write. */
function ensureCacheDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		/* best-effort repair on a pre-existing dir we don't own */
	}
}

function isValidPoolKey(value: unknown): value is GeminiPoolKey {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.secret === "string" &&
		typeof v.enabled === "boolean" &&
		typeof v.dayKey === "string" &&
		typeof v.attempts === "number" &&
		typeof v.successes === "number" &&
		typeof v.failures === "number"
	);
}

function isValidPoolState(value: unknown): value is GeminiKeyPoolState {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (v.version !== 1) return false;
	if (typeof v.softDailyLimit !== "number") return false;
	if (!Array.isArray(v.keys)) return false;
	return v.keys.every(isValidPoolKey);
}

export interface LoadPoolStateResult {
	state: GeminiKeyPoolState | null;
	corrupt: boolean;
}

/**
 * Load and validate pool state. Malformed state (unreadable, invalid JSON,
 * or structurally wrong) fails closed: returns `corrupt: true` without ever
 * deleting or overwriting the file, so the caller can fall back to normal
 * compaction while leaving recovery to the user.
 */
export function loadPoolStateFile(paths: PoolPaths): LoadPoolStateResult {
	if (!existsSync(paths.stateFile)) return { state: null, corrupt: false };
	let raw: string;
	try {
		raw = readFileSync(paths.stateFile, "utf-8");
	} catch {
		return { state: null, corrupt: true };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { state: null, corrupt: true };
	}
	if (!isValidPoolState(parsed)) return { state: null, corrupt: true };
	return { state: parsed, corrupt: false };
}

/**
 * Atomic, mode-0600 write: serialize to a same-directory temp file, chmod,
 * then rename over the target. Repairs mode 0600 even when the file already
 * existed with looser permissions.
 */
export function writePoolStateFile(paths: PoolPaths, state: GeminiKeyPoolState): void {
	ensureCacheDir(paths.cacheDir);
	const tmpFile = `${paths.stateFile}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmpFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(tmpFile, 0o600);
	renameSync(tmpFile, paths.stateFile);
	try {
		chmodSync(paths.stateFile, 0o600);
	} catch {
		/* best-effort; rename already placed a 0600 file */
	}
}

export const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 25;
// Max wait must strictly exceed stale threshold so a lock that becomes stale
// at the exact boundary is still recoverable within the wait window.
export const LOCK_MAX_WAIT_MS = 12_000;

/**
 * Acquire a same-directory exclusive lock file (`O_EXCL`), with bounded
 * stale-lock recovery: a lock file older than `staleMs` is assumed to be
 * left behind by a crashed process and is removed so a new holder can
 * proceed. Returns a release function; callers must call it exactly once.
 */
export async function acquirePoolLock(paths: PoolPaths, staleMs = LOCK_STALE_MS): Promise<() => void> {
	ensureCacheDir(paths.cacheDir);
	const deadline = Date.now() + LOCK_MAX_WAIT_MS;
	for (;;) {
		try {
			const fd = openSync(paths.lockFile, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return () => {
				try {
					unlinkSync(paths.lockFile);
				} catch {
					/* already released/removed */
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				const stat = statSync(paths.lockFile);
				if (Date.now() - stat.mtimeMs > staleMs) {
					unlinkSync(paths.lockFile);
					continue;
				}
			} catch {
				/* lock disappeared between EEXIST and stat — retry immediately */
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error("gemini-keypool: could not acquire pool lock (timed out)");
			}
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
		}
	}
}

// ── Gemini key pool: reservation + outcome accounting ────────────

/**
 * Reserve the least-used eligible key for one compaction attempt under an
 * exclusive lock: load, normalize for the current Pacific day, select, then
 * increment `attempts` and set `lastUsedAt` before releasing the lock. The
 * network request itself happens outside the lock. A crash between
 * reservation and request is conservative — it may consume one local
 * allowance without a successful request, but cannot cause overuse.
 */
export async function reserveKey(
	paths: PoolPaths,
	attemptedIds: ReadonlySet<string>,
	now: number = Date.now(),
): Promise<GeminiPoolKey | null> {
	const release = await acquirePoolLock(paths);
	try {
		const { state } = loadPoolStateFile(paths);
		if (!state) return null;
		const dayKey = pacificDayKey(new Date(now));
		const normalized = normalizeStateForDay(state, dayKey);
		const picked = selectKey(normalized, dayKey, now, attemptedIds);
		if (!picked) {
			// Persist the daily normalization even when nothing was selected.
			writePoolStateFile(paths, normalized);
			return null;
		}
		const reserved: GeminiPoolKey = { ...picked, attempts: picked.attempts + 1, lastUsedAt: now };
		const nextKeys = normalized.keys.map((key) => (key.id === reserved.id ? reserved : key));
		writePoolStateFile(paths, { ...normalized, keys: nextKeys });
		return reserved;
	} finally {
		release();
	}
}

export type ReservationOutcome =
	| { kind: "success" }
	| { kind: "failure"; classification: GeminiErrorClassification };

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * Record the outcome of a network attempt against a previously reserved key,
 * under the same lock used for reservation. Only confidently-classified
 * key-specific failures mutate rotation-relevant state (cooldown,
 * daily-exhaustion, auth quarantine); callers should not invoke this at all
 * for unrelated/ambiguous failures (see `classifyGeminiError`).
 */
export async function recordOutcome(
	paths: PoolPaths,
	keyId: string,
	outcome: ReservationOutcome,
	now: number = Date.now(),
): Promise<void> {
	const release = await acquirePoolLock(paths);
	try {
		const { state } = loadPoolStateFile(paths);
		if (!state) return;
		const dayKey = pacificDayKey(new Date(now));
		const nextKeys = state.keys.map((rawKey) => {
			if (rawKey.id !== keyId) return rawKey;
			const key = normalizeKeyForDay(rawKey, dayKey);
			if (outcome.kind === "success") {
				return { ...key, successes: key.successes + 1 };
			}
			const { code, retryDelayMs } = outcome.classification;
			const updated: GeminiPoolKey = { ...key, failures: key.failures + 1, lastErrorCode: code ?? key.lastErrorCode };
			if (code === "quota-daily") return { ...updated, exhaustedDayKey: dayKey };
			if (code === "rate-limit") return { ...updated, cooldownUntil: now + (retryDelayMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS) };
			if (code === "auth") return { ...updated, quarantinedReason: "auth" as const };
			return updated;
		});
		writePoolStateFile(paths, { ...state, keys: nextKeys });
	} finally {
		release();
	}
}

// ── Gemini key pool: network-attempt loop ────────────────────

export interface CompletionContentPart {
	type: string;
	text?: string;
}

export interface CompletionResponse {
	content: CompletionContentPart[];
}

export interface CompletionRequestOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	maxTokens: number;
	signal: AbortSignal;
}

/**
 * Structural shape of `complete()` narrowed to what the key-pool loop needs.
 * Tests inject a fake matching this shape instead of monkey-patching the
 * real `complete` export or making live requests.
 */
export type CompleteFn = (
	model: { provider: string; id: string },
	context: { messages: unknown },
	options: CompletionRequestOptions,
) => Promise<CompletionResponse>;

/** Extract concatenated text parts from a completion response. */
export function extractSummaryText(response: CompletionResponse): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export interface GeminiKeyPoolCompletionOptions {
	paths: PoolPaths;
	model: { provider: string; id: string };
	headers?: Record<string, string>;
	messages: unknown;
	maxTokens: number;
	signal: AbortSignal;
	completeFn: CompleteFn;
	now?: number;
	notify?: (message: string, type: "info" | "warning" | "error") => void;
}

// Defensive cap only — the loop naturally terminates once reserveKey finds no
// more eligible keys (each attempted id is excluded from the next reservation).
const MAX_KEY_POOL_ATTEMPTS = 25;

function rotationReason(code: GeminiErrorCode): string {
	if (code === "quota-daily") return "hit its daily quota";
	if (code === "rate-limit") return "was rate-limited";
	return "failed authentication";
}

export type GeminiKeyPoolCompletionResult =
	| { ok: true; text: string }
	| { ok: false; reason: "aborted" | "empty-summary" | "non-key-failure" | "all-unavailable" };

/**
 * Run one compaction completion against the Gemini key pool, retrying a
 * key-specific failure with the next eligible key. Never rotates on abort,
 * an empty summary, or a failure that `classifyGeminiError` cannot
 * confidently attribute to a specific key. Only `reason: "all-unavailable"`
 * (every eligible key was exhausted) is worth an explicit MiniMax-M3
 * fallback attempt — the other reasons fall straight through to Pi's own
 * default compaction.
 */
export async function runGeminiKeyPoolCompletion(
	options: GeminiKeyPoolCompletionOptions,
): Promise<GeminiKeyPoolCompletionResult> {
	const { paths, model, headers, messages, maxTokens, signal, completeFn, notify } = options;
	const attemptedIds = new Set<string>();

	for (let attemptNumber = 1; attemptNumber <= MAX_KEY_POOL_ATTEMPTS; attemptNumber++) {
		if (signal.aborted) return { ok: false, reason: "aborted" };
		const now = options.now ?? Date.now();
		const reserved = await reserveKey(paths, attemptedIds, now);
		if (!reserved) {
			notify?.("All Gemini compaction keys unavailable", "warning");
			return { ok: false, reason: "all-unavailable" };
		}
		attemptedIds.add(reserved.id);
		notify?.(
			`Compacting via Gemini Flash Lite (key ${fingerprint(reserved.secret)}, attempt ${attemptNumber})\u2026`,
			"info",
		);

		try {
			const response = await completeFn(model, { messages }, { apiKey: reserved.secret, headers, maxTokens, signal });
			const text = extractSummaryText(response);
			if (!text.trim()) return { ok: false, reason: "empty-summary" }; // do not rotate
			// Best-effort success accounting: a persistence failure must not
			// discard the already-obtained summary. Notify generically and
			// return the text so the caller can use it.
			try {
				await recordOutcome(paths, reserved.id, { kind: "success" }, now);
			} catch {
				notify?.("Gemini key pool: accounting update failed (summary preserved)", "warning");
			}
			return { ok: true, text };
		} catch (error) {
			if (signal.aborted) return { ok: false, reason: "aborted" }; // abort mid-flight — do not rotate
			const classification = classifyGeminiError(error);
			if (classification.code === null) return { ok: false, reason: "non-key-failure" }; // do not rotate
			// Best-effort failure accounting: if recording the failure itself
			// fails, stop rotation safely without throwing. The key's state
			// will be stale but the 429 from Google will correct it next time.
			try {
				await recordOutcome(paths, reserved.id, { kind: "failure", classification }, now);
			} catch {
				notify?.("Gemini key pool: failure accounting update failed", "warning");
				return { ok: false, reason: "non-key-failure" }; // safe stop — no proof all keys are unavailable
			}
			notify?.(
				`Gemini key ${fingerprint(reserved.secret)} ${rotationReason(classification.code)}; retrying with another key`,
				"warning",
			);
		}
	}
	notify?.("All Gemini compaction keys unavailable", "warning");
	return { ok: false, reason: "all-unavailable" };
}

// ── Gemini key pool: explicit MiniMax-M3 fallback ──────────────────

/**
 * When every Gemini pool key is unavailable, compaction explicitly falls
 * back to this model rather than Pi's active conversation model (grill
 * decision, 2026-07-15) — the active model is often expensive/large-context
 * and unsuited to a cheap summarization pass. If this model or its auth is
 * unavailable too, the hook still returns control to Pi's own default
 * compaction fallback.
 */
export const MINIMAX_FALLBACK = { provider: "minimax", model: "MiniMax-M3" } as const;

export interface FallbackModelRegistry {
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	getApiKeyAndHeaders(
		model: { provider: string; id: string },
	): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
}

export interface FallbackModelOptions {
	modelRegistry: FallbackModelRegistry;
	provider: string;
	modelId: string;
	messages: unknown;
	maxTokens: number;
	signal: AbortSignal;
	completeFn: CompleteFn;
	notify?: (message: string, type: "info" | "warning" | "error") => void;
}

/**
 * Attempt a single, non-rotating completion against an explicit fallback
 * model (used for {@link MINIMAX_FALLBACK}). Returns `null` — never throws
 * — whenever the model is unregistered, unauthenticated, aborted, or the
 * completion itself fails, so the caller can fall through to Pi's default
 * compaction.
 */
export async function attemptFallbackModel(options: FallbackModelOptions): Promise<{ text: string } | null> {
	const { modelRegistry, provider, modelId, messages, maxTokens, signal, completeFn, notify } = options;
	const model = modelRegistry.find(provider, modelId);
	if (!model) {
		notify?.(
			`All Gemini compaction keys unavailable; ${provider}/${modelId} fallback model not found, using default compaction`,
			"warning",
		);
		return null;
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		notify?.(
			`All Gemini compaction keys unavailable; no auth for ${provider}/${modelId}, using default compaction`,
			"warning",
		);
		return null;
	}

	if (signal.aborted) return null;

	try {
		const response = await completeFn(model, { messages }, { apiKey: auth.apiKey, headers: auth.headers, maxTokens, signal });
		const text = extractSummaryText(response);
		if (!text.trim()) return null;
		notify?.(`All Gemini compaction keys unavailable; used ${provider}/${modelId} instead`, "info");
		return { text };
	} catch {
		if (!signal.aborted) {
			notify?.(`${provider}/${modelId} fallback failed; using default compaction`, "warning");
		}
		return null;
	}
}

// ── Compaction hook: activation + orchestration (testable) ──────────

function buildSummaryMessages(conversationText: string, previousSummary: string | undefined) {
	const previousContext = previousSummary
		? `\n\nPrevious session summary for context:\n${previousSummary}`
		: "";

	return [
		{
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: `You are a conversation summarizer. Create a comprehensive summary of this conversation that captures:${previousContext}

1. The main goals and objectives discussed
2. Key decisions made and their rationale
3. Important code changes, file modifications, or technical details
4. Current state of any ongoing work
5. Any blockers, issues, or open questions
6. Next steps that were planned or suggested

Be thorough but concise. The summary will replace the ENTIRE conversation history, so include all information needed to continue the work effectively.

Format the summary as structured markdown with clear sections.

<conversation>
${conversationText}
</conversation>`,
				},
			],
			timestamp: Date.now(),
		},
	];
}

export interface CompactionHookOptions {
	model: { provider: string; id: string };
	auth: { apiKey: string; headers?: Record<string, string> };
	conversationText: string;
	previousSummary?: string;
	tokensBefore: number;
	firstKeptEntryId: string;
	signal: AbortSignal;
	completeFn: CompleteFn;
	modelRegistry: FallbackModelRegistry;
	notify: (message: string, type: "info" | "warning" | "error") => void;
	poolPaths: PoolPaths;
	now?: number;
}

export interface CompactionHookResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

/**
 * Decide and run one compaction: activate the Gemini key pool only for the
 * exact model/pool-eligibility condition, falling back to explicit
 * MiniMax-M3 when every pool key is unavailable; otherwise run the existing
 * single-auth path unchanged. Returns `null` when the caller should fall
 * through to Pi's own default compaction.
 */
export async function runCompactionHook(options: CompactionHookOptions): Promise<CompactionHookResult | null> {
	const {
		model,
		auth,
		conversationText,
		previousSummary,
		tokensBefore,
		firstKeptEntryId,
		signal,
		completeFn,
		modelRegistry,
		notify,
		poolPaths,
	} = options;
	const summaryMessages = buildSummaryMessages(conversationText, previousSummary);

	const isGeminiFlashLite = model.provider === "google" && model.id === "gemini-3.1-flash-lite";
	if (isGeminiFlashLite && !signal.aborted) {
		const { state, corrupt } = loadPoolStateFile(poolPaths);
		if (corrupt) {
			// I-6: Never modify a corrupt state file. Notify once and fall
			// through to the single-auth path below.
			notify("Gemini key pool state is corrupt; using single-auth compaction. Fix or remove the pool file manually.", "warning");
		} else if (state) {
			const now = options.now ?? Date.now();
			// Activation only requires a configured pool (at least one key on file),
			// not momentary eligibility — a pool with zero currently-usable keys
			// still activates so the explicit MiniMax-M3 fallback below runs,
			// instead of silently reverting to the plain single-auth Google path.
			const activated = state.keys.length > 0;
			if (activated) {
				try {
					const poolResult = await runGeminiKeyPoolCompletion({
						paths: poolPaths,
						model,
						messages: summaryMessages,
						maxTokens: 8192,
						signal,
						completeFn,
						now: options.now,
						notify,
					});

					let text: string | null = poolResult.ok ? poolResult.text : null;
					if (!poolResult.ok && poolResult.reason === "all-unavailable") {
						const fallback = await attemptFallbackModel({
							modelRegistry,
							provider: MINIMAX_FALLBACK.provider,
							modelId: MINIMAX_FALLBACK.model,
							messages: summaryMessages,
							maxTokens: 8192,
							signal,
							completeFn,
							notify,
						});
						text = fallback?.text ?? null;
					}

					if (!text) return null; // Pi's own default compaction fallback

					const estimatedAfter = Math.round(text.length / 4);
					const savings = Math.round((1 - estimatedAfter / tokensBefore) * 100);
					notify(
						`Compacted: ${tokensBefore.toLocaleString()} \u2192 ~${estimatedAfter.toLocaleString()} tokens (~${savings}% saved) \u2713`,
						"info",
					);
					return { summary: text, firstKeptEntryId, tokensBefore };
				} catch {
					// I-2: Unexpected pool lock/read/write/persistence errors must
					// never escape the hook. Notify with a generic sanitized
					// warning and return null so Pi default compaction takes over.
					notify("Gemini key pool error; using default compaction", "warning");
					return null;
				}
			}
		}
	}

	// Existing single-auth path — unchanged behavior for non-Gemini models,
	// Gemini without a configured pool, or Gemini once the pool line above has
	// already handled (and returned from) the pool-activated case.
	try {
		const response = await completeFn(model, { messages: summaryMessages }, {
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 8192,
			signal,
		});

		const summary = extractSummaryText(response);

		if (!summary.trim()) {
			if (!signal.aborted) {
				notify("compact-model: empty summary, using default", "warning");
			}
			return null;
		}

		const estimatedAfter = Math.round(summary.length / 4);
		const savings = Math.round((1 - estimatedAfter / tokensBefore) * 100);
		notify(
			`Compacted via ${model.id}: ${tokensBefore.toLocaleString()} \u2192 ~${estimatedAfter.toLocaleString()} tokens (~${savings}% saved) \u2713`,
			"info",
		);

		return { summary, firstKeptEntryId, tokensBefore };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!signal.aborted) {
			notify(`compact-model failed: ${message}`, "error");
		}
		return null;
	}
}

// ── Gemini key pool: manager primitives (used by /compact-keypool) ────

/**
 * Conservative local validation only — trimmed, non-empty, no embedded
 * whitespace/control characters. Deliberately does not require any single
 * key-prefix shape so alternate Gemini credential formats stay accepted.
 */
export function validateKeySecret(input: string): { ok: true; secret: string } | { ok: false; error: string } {
	const secret = input.trim();
	if (!secret) return { ok: false, error: "Key cannot be empty" };
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally scanning for control chars to reject them
	if (/[\s\x00-\x1f\x7f]/.test(secret)) {
		return { ok: false, error: "Key must not contain whitespace or control characters" };
	}
	return { ok: true, secret };
}

/** Append a new enabled key for the current Pacific day. Does not mutate `state`. */
export function addKeyToPool(state: GeminiKeyPoolState, secret: string, now: number = Date.now()): GeminiKeyPoolState {
	const key: GeminiPoolKey = {
		id: randomUUID(),
		secret,
		enabled: true,
		dayKey: pacificDayKey(new Date(now)),
		attempts: 0,
		successes: 0,
		failures: 0,
	};
	return { ...state, keys: [...state.keys, key] };
}

export function removeKeyFromPool(state: GeminiKeyPoolState, keyId: string): GeminiKeyPoolState {
	return { ...state, keys: state.keys.filter((key) => key.id !== keyId) };
}

export function setKeyEnabled(state: GeminiKeyPoolState, keyId: string, enabled: boolean): GeminiKeyPoolState {
	return { ...state, keys: state.keys.map((key) => (key.id === keyId ? { ...key, enabled } : key)) };
}

export function clearKeyQuarantine(state: GeminiKeyPoolState, keyId: string): GeminiKeyPoolState {
	return {
		...state,
		keys: state.keys.map((key) => (key.id === keyId ? { ...key, quarantinedReason: undefined } : key)),
	};
}

const MIN_SOFT_DAILY_LIMIT = 1;
const MAX_SOFT_DAILY_LIMIT = 500;

/** Clamp to the documented 1–500 bound. */
export function setSoftDailyLimit(state: GeminiKeyPoolState, limit: number): GeminiKeyPoolState {
	const clamped = Math.min(MAX_SOFT_DAILY_LIMIT, Math.max(MIN_SOFT_DAILY_LIMIT, Math.round(limit)));
	return { ...state, softDailyLimit: clamped };
}

const EMPTY_POOL_STATE: GeminiKeyPoolState = { version: 1, softDailyLimit: DEFAULT_SOFT_DAILY_LIMIT, keys: [] };

/**
 * Read-modify-write a pool state under the exclusive lock, defaulting to an
 * empty pool when no file exists yet (e.g. adding the first key). Returns
 * the persisted state. Callers must not call this against a known-corrupt
 * state — check {@link loadPoolStateFile}'s `corrupt` flag first and fail
 * closed instead, per the design's "never auto-repair" invariant.
 */
export async function mutatePoolState(
	paths: PoolPaths,
	mutate: (state: GeminiKeyPoolState) => GeminiKeyPoolState,
): Promise<GeminiKeyPoolState> {
	const release = await acquirePoolLock(paths);
	try {
		const { state } = loadPoolStateFile(paths);
		const next = mutate(state ?? EMPTY_POOL_STATE);
		writePoolStateFile(paths, next);
		return next;
	} finally {
		release();
	}
}

// ── Gemini key pool: targeted reservation + manual verification ─────

/**
 * Reserve a *specific* key by id (bypassing least-attempts selection),
 * under the same lock and daily-normalization path as {@link reserveKey}.
 * Used by the `/compact-keypool` "Verify key" action so manual verification
 * consumes an API request through the same reservation + accounting path as
 * compaction — keeping counters and cooldown/quarantine state consistent.
 */
export async function reserveSpecificKey(
	paths: PoolPaths,
	keyId: string,
	now: number = Date.now(),
): Promise<GeminiPoolKey | null> {
	const release = await acquirePoolLock(paths);
	try {
		const { state } = loadPoolStateFile(paths);
		if (!state) return null;
		const dayKey = pacificDayKey(new Date(now));
		const normalized = normalizeStateForDay(state, dayKey);
		const picked = normalized.keys.find((key) => key.id === keyId);
		if (!picked) {
			writePoolStateFile(paths, normalized);
			return null;
		}
		const reserved: GeminiPoolKey = { ...picked, attempts: picked.attempts + 1, lastUsedAt: now };
		const nextKeys = normalized.keys.map((key) => (key.id === reserved.id ? reserved : key));
		writePoolStateFile(paths, { ...normalized, keys: nextKeys });
		return reserved;
	} finally {
		release();
	}
}

export type VerifyPoolKeyResult =
	| { ok: true; text: string }
	| { ok: false; reason: "not-found" | "failure"; code?: GeminiErrorCode | null };

/**
 * Manually verify a single pool key by id: reserve it, make one completion
 * attempt, and record the outcome through the same accounting path as
 * compaction. Returns `{ ok: true, text }` on success, or `{ ok: false, ... }`
 * with the classification on failure. Never throws — the caller (the
 * `/compact-keypool` command) surfaces the result to the user.
 */
export async function verifyPoolKey(
	paths: PoolPaths,
	keyId: string,
	completeFn: CompleteFn,
	now: number = Date.now(),
	notify?: (message: string, type: "info" | "warning" | "error") => void,
): Promise<VerifyPoolKeyResult> {
	const reserved = await reserveSpecificKey(paths, keyId, now);
	if (!reserved) {
		return { ok: false, reason: "not-found" };
	}

	notify?.(`Verifying Gemini key ${fingerprint(reserved.secret)}\u2026`, "info");

	const model = { provider: "google", id: "gemini-3.1-flash-lite" };
	const messages = [{
		role: "user" as const,
		content: [{ type: "text" as const, text: "Reply with the single word: ok" }],
		timestamp: now,
	}];

	try {
		const response = await completeFn(model, { messages }, {
			apiKey: reserved.secret,
			maxTokens: 16,
			signal: new AbortController().signal,
		});
		const text = extractSummaryText(response);
		// Best-effort success accounting: a persistence failure must not
		// discard the verification result.
		try {
			await recordOutcome(paths, reserved.id, { kind: "success" }, now);
		} catch {
			notify?.("Gemini key pool: accounting update failed (verification preserved)", "warning");
		}
		notify?.(`Gemini key ${fingerprint(reserved.secret)} verified \u2713`, "info");
		return { ok: true, text };
	} catch (error) {
		const classification = classifyGeminiError(error);
		// Best-effort failure accounting — never throw from verify.
		if (classification.code !== null) {
			try {
				await recordOutcome(paths, reserved.id, { kind: "failure", classification }, now);
			} catch {
				// Accounting failure is non-fatal; the key state will be stale
				// but Google's 429 will correct it next time.
			}
		}
		// I-5: Never leak raw provider error text. Return only the sanitized
		// classification code and a generic failure message.
		notify?.(`Gemini key ${fingerprint(reserved.secret)} verification failed${classification.code ? ` (${classification.code})` : ""}`, "warning");
		return { ok: false, reason: "failure", code: classification.code };
	}
}
const DISABLE_VALUE = "__compact_model_disable__";
const CURRENT_MARKER = " ✓";

interface ModelPickerEntry {
	value: string;
	label: string;
	description?: string;
}

function modelValue(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function buildModelPickerEntries(
	models: Array<{ provider: string; id: string; reasoning?: boolean }>,
	currentValue: string | null,
): ModelPickerEntry[] {
	const entries = models
		.map((model) => ({ value: modelValue(model), reasoning: model.reasoning === true }))
		.sort((a, b) => a.value.localeCompare(b.value))
		.map((model) => ({
			value: model.value,
			label: model.value === currentValue ? `${model.value}${CURRENT_MARKER}` : model.value,
			description: model.reasoning ? "reasoning" : undefined,
		}));

	return [
		{
			value: DISABLE_VALUE,
			label: "⊘  Disable (use active model)",
			description: "Use the active conversation model for compaction",
		},
		...entries,
	];
}

function parseModelValue(value: string): { provider: string; model: string } | null {
	const slashIdx = value.indexOf("/");
	if (slashIdx <= 0 || slashIdx >= value.length - 1) return null;
	return { provider: value.slice(0, slashIdx), model: value.slice(slashIdx + 1) };
}

async function pickModelWindowed(
	ctx: any,
	title: string,
	entries: ModelPickerEntry[],
	currentValue: string | null,
): Promise<string | null> {
	return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result: string | null) => void) => {
		const items: SelectItem[] = entries.map((entry) => ({
			value: entry.value,
			label: entry.label,
			description: entry.description,
		}));
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		const header = new Text(theme.fg("accent", theme.bold(title)));
		container.addChild(header);
		const list = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		if (currentValue) {
			const index = items.findIndex((item) => item.value === currentValue);
			if (index >= 0) list.setSelectedIndex(index);
		}
		list.onSelect = (item: SelectItem) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · type to filter · enter select · esc cancel")));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		let filter = "";
		const refreshHeader = () => {
			header.setText(theme.fg("accent", theme.bold(filter ? `${title}  /${filter}` : title)));
		};

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (data.length === 1 && data >= " " && data !== "\u007f") {
					filter += data;
					list.setFilter(filter);
					refreshHeader();
				} else if (data === "\u007f" || data === "\b") {
					filter = filter.slice(0, -1);
					list.setFilter(filter);
					refreshHeader();
				} else {
					list.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}

// ── /compact-keypool: masked overlay manager ──────────────────────

interface KeypoolContext {
	mode: string;
	hasUI: boolean;
	ui: {
		notify: (message: string, type: "info" | "warning" | "error") => void;
		select: (title: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, body: string) => Promise<boolean>;
		input: (title: string, placeholder: string) => Promise<string | undefined>;
		custom: <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown) => Promise<T | null>;
		theme: { fg: (role: string, text: string) => string };
	};
	modelRegistry: FallbackModelRegistry;
}

function keyStatus(key: GeminiPoolKey, dayKey: string): string {
	if (!key.enabled) return "disabled";
	if (key.quarantinedReason) return `quarantined (${key.quarantinedReason})`;
	if (key.exhaustedDayKey === dayKey) return "daily-exhausted";
	if (key.cooldownUntil && key.cooldownUntil > Date.now()) return "cooldown";
	return "enabled";
}

function keyLabel(key: GeminiPoolKey, dayKey: string): string {
	const fp = fingerprint(key.secret);
	const status = keyStatus(key, dayKey);
	const stats = `${key.successes}/${key.attempts}`;
	let label = `${fp}  [${status}]  ${stats}`;
	if (key.lastErrorCode) label += `  last:${key.lastErrorCode}`;
	return label;
}

async function keypoolMenu(ctx: KeypoolContext, paths: PoolPaths, initialState: GeminiKeyPoolState): Promise<void> {
	let state = initialState;
	let running = true;

	while (running) {
		const dayKey = pacificDayKey(new Date());
		const keyOptions = state.keys.map((key) => keyLabel(key, dayKey));
		const actions = [
			"── Add key ──",
			`── Soft daily limit: ${state.softDailyLimit} ──`,
			"── Done ──",
		];
		const options = [...keyOptions, ...actions];

		const title = `Gemini key pool (${state.keys.length} keys)`;
		const choice = await ctx.ui.select(title, options);
		if (!choice) return;

		const keyIndex = keyOptions.indexOf(choice);
		if (keyIndex >= 0) {
			const key = state.keys[keyIndex];
			await keyActionMenu(ctx, paths, key, dayKey);
			const reloaded = loadPoolStateFile(paths);
			state = reloaded.state ?? EMPTY_POOL_STATE;
			continue;
		}

		if (choice === actions[0]) {
			await addKeyFlow(ctx, paths);
			const reloaded = loadPoolStateFile(paths);
			state = reloaded.state ?? EMPTY_POOL_STATE;
			continue;
		}

		if (choice === actions[1]) {
			await setLimitFlow(ctx, paths, state);
			const reloaded = loadPoolStateFile(paths);
			state = reloaded.state ?? EMPTY_POOL_STATE;
			continue;
		}

		if (choice === actions[2]) {
			running = false;
		}
	}
}

async function keyActionMenu(ctx: KeypoolContext, paths: PoolPaths, key: GeminiPoolKey, dayKey: string): Promise<void> {
	const fp = fingerprint(key.secret);
	const status = keyStatus(key, dayKey);
	const options = [
		key.enabled ? "Disable" : "Enable",
		"Remove",
		"Clear quarantine",
		"Verify key",
		"Back",
	];
	const choice = await ctx.ui.select(`${fp} [${status}]`, options);
	if (!choice) return;

	if (choice === "Enable" || choice === "Disable") {
		await mutatePoolState(paths, (s) => setKeyEnabled(s, key.id, !key.enabled));
		ctx.ui.notify(`${fp} ${key.enabled ? "disabled" : "enabled"}`, "info");
		return;
	}

	if (choice === "Remove") {
		const ok = await ctx.ui.confirm("Remove key?", `Remove ${fp}? This cannot be undone.`);
		if (ok) {
			await mutatePoolState(paths, (s) => removeKeyFromPool(s, key.id));
			ctx.ui.notify(`${fp} removed`, "info");
		}
		return;
	}

	if (choice === "Clear quarantine") {
		await mutatePoolState(paths, (s) => clearKeyQuarantine(s, key.id));
		ctx.ui.notify(`${fp} quarantine cleared`, "info");
		return;
	}

	if (choice === "Verify key") {
		ctx.ui.notify(`Verifying ${fp}\u2026`, "info");
		const result = await verifyPoolKey(paths, key.id, complete as unknown as CompleteFn, Date.now(), (msg, type) => ctx.ui.notify(msg, type));
		if (result.ok) {
			ctx.ui.notify(`${fp} verified \u2713`, "info");
		} else if (result.reason === "not-found") {
			ctx.ui.notify(`${fp} not found in pool`, "warning");
		} else {
			ctx.ui.notify(`${fp} verification failed${result.code ? ` (${result.code})` : ""}`, "warning");
		}
		return;
	}
}

async function addKeyFlow(ctx: KeypoolContext, paths: PoolPaths): Promise<void> {
	// I-4: Masked key entry requires TUI mode. Refuse in non-TUI modes
	// rather than falling back to unmasked ctx.ui.input, which would echo
	// the plaintext secret to the terminal/session.
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
		ctx.ui.notify("compact-keypool: masked key entry requires TUI mode", "warning");
		return;
	}

	const secret = await ctx.ui.custom<string | null>((_tui, theme, _kb, done) =>
		createMaskedInput(theme as { fg: (role: string, text: string) => string }, done),
	) ?? undefined;

	if (!secret) return;

	const validated = validateKeySecret(secret);
	if (!validated.ok) {
		ctx.ui.notify(`compact-keypool: ${validated.error}`, "warning");
		return;
	}

	await mutatePoolState(paths, (s) => addKeyToPool(s, validated.secret));
	ctx.ui.notify(`Key added: ${fingerprint(validated.secret)}`, "info");
}

async function setLimitFlow(ctx: KeypoolContext, paths: PoolPaths, state: GeminiKeyPoolState): Promise<void> {
	const input = await ctx.ui.input("Soft daily limit per key (1–500):", String(state.softDailyLimit));
	if (!input) return;
	const parsed = Number.parseInt(input, 10);
	if (Number.isNaN(parsed)) {
		ctx.ui.notify("compact-keypool: invalid number", "warning");
		return;
	}
	const next = await mutatePoolState(paths, (s) => setSoftDailyLimit(s, parsed));
	ctx.ui.notify(`Soft daily limit set to ${next.softDailyLimit}`, "info");
}

function createMaskedInput(theme: { fg: (role: string, text: string) => string }, done: (value: string | null) => void) {
	let value = "";
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	return {
		handleInput(data: string): void {
			if (matchesKey(data, "enter")) {
				done(value || null);
				return;
			}
			if (matchesKey(data, "escape")) {
				done(null);
				return;
			}
			if (matchesKey(data, "backspace") || data === "\u007f" || data === "\b") {
				value = value.slice(0, -1);
				cachedWidth = undefined;
				return;
			}
			// Printable characters (including paste as multi-char data).
			// Reject control characters and whitespace within pasted content.
			const filtered = data.replace(/[\x00-\x1f\x7f\s]/g, "");
			if (filtered) {
				value += filtered;
				cachedWidth = undefined;
			}
		},

		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;
			const bullets = "\u2022".repeat(Math.min(value.length, 40));
			const display = bullets || theme.fg("dim", "(empty)");
			cachedLines = [
				"",
				`  ${theme.fg("accent", "Paste Gemini API key")}`,
				`  ${display}`,
				"",
				`  ${theme.fg("dim", "Enter to confirm \u00b7 Esc to cancel")}`,
				"",
			];
			cachedWidth = width;
			return cachedLines;
		},

		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}

export default function compactModel(pi: ExtensionAPI) {
	// --- Command: /compact-model ---
	pi.registerCommand("compact-model", {
		description: "Choose which model handles context compaction",
		handler: async (_args, ctx) => {
			const current = loadConfig();
			const currentLabel = current
				? `${current.provider}/${current.model}`
				: "default (active model)";

			const available = ctx.modelRegistry.getAvailable();
			if (available.length === 0) {
				ctx.ui.notify("No models with configured auth found", "warning");
				return;
			}

			const currentValue = current ? `${current.provider}/${current.model}` : null;
			const entries = buildModelPickerEntries(available, currentValue);
			const title = `Compaction model (current: ${currentLabel})`;

			let value: string | null;
			if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
				value = await pickModelWindowed(ctx, title, entries, currentValue);
			} else {
				const byLabel = new Map(entries.map((entry) => [entry.label, entry.value] as const));
				const choice = await ctx.ui.select(title, entries.map((entry) => entry.label));
				value = choice ? (byLabel.get(choice) ?? null) : null;
			}

			if (value === null) return; // cancelled

			if (value === DISABLE_VALUE) {
				saveConfig(null);
				ctx.ui.notify("Compaction model: disabled — will use active model", "info");
				return;
			}

			const parsed = parseModelValue(value);
			if (!parsed) {
				ctx.ui.notify("compact-model: could not parse selected model", "warning");
				return;
			}

			saveConfig(parsed);
			ctx.ui.notify(`Compaction model: ${parsed.provider}/${parsed.model}`, "info");
		},
	});

	// --- Gemini key-pool manager ---

	pi.registerCommand("compact-keypool", {
		description: "Manage the Gemini compaction key pool (masked)",
		handler: async (_args, ctx) => {
			const paths = defaultPoolPaths();
			const { state, corrupt } = loadPoolStateFile(paths);
			if (corrupt) {
				ctx.ui.notify(
					"compact-keypool: pool state file is corrupt — refusing to modify. Fix or remove the file manually.",
					"error",
				);
				return;
			}
			await keypoolMenu(ctx as unknown as KeypoolContext, paths, state ?? EMPTY_POOL_STATE);
		},
	});

	// --- Compaction hook ---
	pi.on("session_before_compact", async (event, ctx) => {
		const config = loadConfig();
		if (!config) return; // disabled — use default

		// Skip if the configured model is already active
		if (
			ctx.model?.provider === config.provider &&
			ctx.model?.id === config.model
		) {
			return;
		}

		const model = ctx.modelRegistry.find(config.provider, config.model);
		if (!model) {
			ctx.ui.notify(
				`compact-model: ${config.provider}/${config.model} not found, using default`,
				"warning",
			);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify(
				`compact-model: no auth for ${config.provider}, using default`,
				"warning",
			);
			return;
		}

		const { preparation, signal } = event;
		const {
			messagesToSummarize,
			turnPrefixMessages,
			tokensBefore,
			firstKeptEntryId,
			previousSummary,
		} = preparation;

		const allMessages = [...messagesToSummarize, ...turnPrefixMessages];

		ctx.ui.notify(
			`Compacting ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) via ${model.id}\u2026`,
			"info",
		);

		const conversationText = serializeConversation(convertToLlm(allMessages));

		const result = await runCompactionHook({
			model: { provider: model.provider, id: model.id },
			auth: { apiKey: auth.apiKey, headers: auth.headers },
			conversationText,
			previousSummary,
			tokensBefore,
			firstKeptEntryId,
			signal,
			completeFn: complete as unknown as CompleteFn,
			modelRegistry: ctx.modelRegistry,
			notify: (message, type) => ctx.ui.notify(message, type),
			poolPaths: defaultPoolPaths(),
		});

		if (!result) return;

		return {
			compaction: {
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
			},
		};
	});
}
