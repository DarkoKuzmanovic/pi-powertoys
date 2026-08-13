import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withStatusChip } from "./toy-kit.ts";

// --- Config ---
const TEST_PROMPT = "Write a short paragraph (3-4 sentences) about the history of the printing press and its impact on society.";
const MAX_TOKENS = 512;
const TIMEOUT_MS = 60_000;
const WARMUP_PROMPT = "Say 'ok'.";
const WARMUP_MAX_TOKENS = 16;
const DEFAULT_RUNS = 3;

// --- Types ---
interface SpeedTestResult {
	provider: string;
	modelId: string;
	modelName: string;
	ttftMs: number;
	tps: number;
	totalMs: number;
	outputTokens: number;   // content-based token count (accurate)
	reportedTokens: number;  // from usage field (may be allocation, not actual)
	chunkCount: number;
	apiType: string;
	error?: string;
}

// --- Main ---
export default function speedTestExtension(pi: ExtensionAPI) {
	pi.registerCommand("speedtest", {
		description: "Benchmark active model's TPS, TTFT, and latency. Usage: /speedtest [N] (default 3 runs, /speedtest 1 for quick)",
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model. Use /model to select one.", "error");
				return;
			}

			// Parse optional run count: /speedtest 1
			const numRuns = Math.max(1, Math.min(10, parseInt(args?.trim() || String(DEFAULT_RUNS), 10) || DEFAULT_RUNS));

			ctx.ui.notify(`⏱ Speed test: ${model.id} (${numRuns} run${numRuns > 1 ? "s" : ""})...`, "info");

			const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!authResult.ok) {
				ctx.ui.notify(`Auth error for ${model.provider}: ${authResult.error}`, "error");
				return;
			}

			// Measurement runs — chip is cleared in finally even if a request throws.
		const runs: SpeedTestResult[] = [];
		let failed = false;
		let aborted = false;
		// The streaming fetches below can outlive the session: if the user runs
		// /reload, /new, switches sessions, or forks mid-test, Pi invalidates this
		// ctx and every ctx.* access throws. Treat that as a silent abort rather
		// than a crashed extension; the session it reported to is already gone.
		try {
			await withStatusChip(ctx, "speedtest", async () => {
				// Warm-up request (discarded — warms connection, avoids cold-start)
				ctx.ui.setStatus("speedtest", `⏱ Warming up...`);
				await runSpeedTest(model, authResult.apiKey, authResult.headers, WARMUP_PROMPT, WARMUP_MAX_TOKENS);

				for (let i = 0; i < numRuns; i++) {
					ctx.ui.setStatus("speedtest", `⏱ Run ${i + 1}/${numRuns}...`);
					const result = await runSpeedTest(model, authResult.apiKey, authResult.headers, TEST_PROMPT, MAX_TOKENS);
					if (result.error) {
						ctx.ui.notify(`Speedtest failed on run ${i + 1}: ${result.error}`, "error");
						failed = true;
						return;
					}
					runs.push(result);
				}
			});
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
			aborted = true;
		}
		if (failed || aborted) return;

			// Compute results
			const medianTtft = median(runs.map((r) => r.ttftMs));
			const medianTps = median(runs.map((r) => r.tps));
			const medianTotal = median(runs.map((r) => r.totalMs));
			const avgTokens = Math.round(runs.reduce((s, r) => s + r.outputTokens, 0) / runs.length);
			const avgChunks = Math.round(runs.reduce((s, r) => s + r.chunkCount, 0) / runs.length);

			const rating = medianTps >= 50 ? "🟢" : medianTps >= 20 ? "🟡" : "🔴";
			const label = medianTps >= 50 ? "fast" : medianTps >= 20 ? "moderate" : "slow";

			const runLabel = numRuns > 1 ? `${numRuns} runs, median` : "1 run";
			const lines: string[] = [
				`${rating} Speed Test: ${runs[0]!.modelName} (${runLabel})`,
				`  TTFT:    ${medianTtft.toFixed(0)} ms`,
				`  TPS:     ${medianTps.toFixed(1)} tok/s (${label})`,
				`  Total:   ${medianTotal.toFixed(0)} ms`,
				`  Tokens:  ${avgTokens} (content)`,
				`  Chunks:  ${avgChunks}`,
				`  API:     ${runs[0]!.apiType}`,
			];

			// Show per-run detail if there's meaningful variance
			if (numRuns > 1) {
				const tpsValues = runs.map((r) => r.tps);
				const tpsRange = Math.max(...tpsValues) - Math.min(...tpsValues);
				if (tpsRange > medianTps * 0.1) {
					lines.push(`  (range: ${Math.min(...tpsValues).toFixed(1)}–${Math.max(...tpsValues).toFixed(1)} tok/s)`);
				}
			}

		try {
			ctx.ui.notify(lines.join("\n"), "info");
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		},
	});
}

// --- Helpers ---
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** True when e is Pi's "stale ctx" guard firing - session replaced/reloaded mid-run. */
function isStaleCtxError(e: unknown): boolean {
	return e instanceof Error && /stale after session replacement/.test(e.message);
}

/** Count tokens from actual content text. ~1.3 tokens/word for English. */
function countContentTokens(text: string): number {
	const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
	return Math.ceil(words * 1.3);
}

// --- Speedtest runner ---

/**
 * Pi 0.84 `ProviderHeaders` values are `string | null`, where `null` means
 * "delete this header". These raw `fetch` calls have no deletion semantics, so
 * a null would be stringified into the request as "null". Drop them instead.
 */
function stripNullHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

async function runSpeedTest(
	model: any,
	apiKey: string | undefined,
	rawExtraHeaders: Record<string, string | null> | undefined,
	prompt: string,
	maxTokens: number,
): Promise<SpeedTestResult> {
	const result: SpeedTestResult = {
		provider: model.provider,
		modelId: model.id,
		modelName: model.name || model.id,
		ttftMs: 0,
		tps: 0,
		totalMs: 0,
		outputTokens: 0,
		reportedTokens: 0,
		chunkCount: 0,
		apiType: model.api as string,
	};

	const api = model.api as string;
	const baseUrl = (model.baseUrl as string).replace(/\/$/, "");

	if (!apiKey) {
		result.error = "No API key resolved for this provider";
		return result;
	}

	const extraHeaders = stripNullHeaders(rawExtraHeaders);

	try {
		if (api === "openai-codex-responses") {
			return await runOpenAICodexResponsesTest(baseUrl, model.id, apiKey, extraHeaders, result, prompt, maxTokens);
		}
		if (api === "openai-responses") {
			return await runOpenAIResponsesTest(baseUrl, model.id, apiKey, extraHeaders, result, prompt, maxTokens);
		}
		if (api === "anthropic-messages") {
			return await runAnthropicTest(baseUrl, model.id, apiKey, extraHeaders, result, prompt, maxTokens);
		}
		// openai-completions and any OpenAI-compatible API
		return await runOpenAITest(baseUrl, model.id, apiKey, extraHeaders, result, prompt, maxTokens);
	} catch (e: any) {
		result.error = e?.message ?? String(e);
		return result;
	}
}

// --- OpenAI-compatible (Ollama, Wafer, etc.) ---
async function runOpenAITest(
	baseUrl: string,
	modelId: string,
	apiKey: string | undefined,
	extraHeaders: Record<string, string> | undefined,
	result: SpeedTestResult,
	prompt: string,
	maxTokens: number,
): Promise<SpeedTestResult> {
	const url = `${baseUrl}/chat/completions`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...extraHeaders,
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const body = JSON.stringify({
		model: modelId,
		messages: [{ role: "user", content: prompt }],
		max_tokens: maxTokens,
		stream: true,
		stream_options: { include_usage: true },
	});

	return await executeStreamTest(url, headers, body, result, (chunk) => {
		const content = chunk.choices?.[0]?.delta?.content;
		const tokens = chunk.usage?.completion_tokens;
		return { content: content || undefined, outputTokens: tokens || undefined };
	});
}

// --- OpenAI Responses API ---
async function runOpenAIResponsesTest(
	baseUrl: string,
	modelId: string,
	apiKey: string | undefined,
	extraHeaders: Record<string, string> | undefined,
	result: SpeedTestResult,
	prompt: string,
	maxTokens: number,
): Promise<SpeedTestResult> {
	const url = `${baseUrl}/responses`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...extraHeaders,
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const body = JSON.stringify({
		model: modelId,
		input: prompt,
		max_output_tokens: maxTokens,
		stream: true,
	});

	return await executeStreamTest(url, headers, body, result, (chunk) => {
		const content = chunk.type === "response.output_text.delta"
			? chunk.delta
			: undefined;
		const tokens =
			chunk.type === "response.usage" && chunk.usage
				? chunk.usage.output_tokens
				: undefined;
		return { content, outputTokens: tokens };
	});
}

// --- Anthropic messages API ---
async function runAnthropicTest(
	baseUrl: string,
	modelId: string,
	apiKey: string | undefined,
	extraHeaders: Record<string, string> | undefined,
	result: SpeedTestResult,
	prompt: string,
	maxTokens: number,
): Promise<SpeedTestResult> {
	const url = `${baseUrl}/v1/messages`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		...extraHeaders,
	};
	if (apiKey) {
		// OAuth access tokens (sk-ant-oat...) → Authorization: Bearer;
		// standard API keys (sk-ant-api...) → x-api-key.
		// Mirrors pi-ai's isOAuthToken() check — the startsWith("sk-") alone
		// misroutes OAuth tokens to x-api-key, which Anthropic rejects (401).
		if (apiKey.includes("sk-ant-oat")) {
			headers["Authorization"] = `Bearer ${apiKey}`;
			// Claude Code identity headers for OAuth subscription tokens.
			// Mirrors pi-ai's createClient() OAuth path. (The system prompt
			// below is what actually satisfies Anthropic's OAuth gate; these
			// headers are sent for parity with the working client.)
			headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
			headers["user-agent"] = "claude-cli/2.1.75";
			headers["x-app"] = "cli";
		} else if (apiKey.startsWith("sk-")) {
			headers["x-api-key"] = apiKey;
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}
	}

	const body = JSON.stringify({
		model: modelId,
		messages: [{ role: "user", content: prompt }],
		max_tokens: maxTokens,
		stream: true,
		// OAuth (Claude subscription) tokens MUST send the Claude Code identity
		// as the system prompt — Anthropic rejects OAuth requests without it
		// (429 rate_limit_error, before rate-limit accounting). Mirrors pi-ai's
		// buildParams() isOAuthToken path.
		...(apiKey?.includes("sk-ant-oat")
			? { system: "You are Claude Code, Anthropic's official CLI for Claude." }
			: {}),
	});

	return await executeStreamTest(url, headers, body, result, (chunk) => {
		if (chunk.type === "content_block_delta") {
			return { content: chunk.delta?.text };
		}
		if (chunk.type === "message_delta") {
			return { outputTokens: chunk.usage?.output_tokens };
		}
		return null;
	});
}

// --- Shared streaming executor ---
type ChunkParser = (chunk: any) => { content?: string; outputTokens?: number } | null;

async function executeStreamTest(
	url: string,
	headers: Record<string, string>,
	body: string,
	result: SpeedTestResult,
	parseChunk: ChunkParser,
): Promise<SpeedTestResult> {
	const startTime = Date.now();
	let firstTokenTime: number | null = null;
	let reportedTokens = 0;
	let fullContent = "";
	let chunkCount = 0;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			result.error = `HTTP ${response.status}: ${text.slice(0, 200)}`;
			return result;
		}

		if (!response.body) {
			result.error = "No response body — streaming not supported by this endpoint";
			return result;
		}

		reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop()!;

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				if (trimmed.startsWith("data: ")) {
					const data = trimmed.slice(6).trim();
					if (data === "[DONE]") continue;

					try {
						const parsed = JSON.parse(data);
						const chunk = parseChunk(parsed);
						if (!chunk) continue;

						if (chunk.content) {
							fullContent += chunk.content;
							chunkCount++;
							if (firstTokenTime === null) {
								firstTokenTime = Date.now();
							}
						}
						if (chunk.outputTokens) {
							reportedTokens = chunk.outputTokens;
						}
					} catch {
						// Skip malformed JSON chunks
					}
				}
			}
		}

		const endTime = Date.now();

		// Use content-based token counting (accurate) over usage field (may be allocation)
		const contentTokens = fullContent.length > 0 ? countContentTokens(fullContent) : 0;
		const outputTokens = contentTokens > 0 ? contentTokens : reportedTokens;

		result.ttftMs = firstTokenTime !== null ? firstTokenTime - startTime : 0;
		result.totalMs = endTime - startTime;
		result.outputTokens = outputTokens;
		result.reportedTokens = reportedTokens;
		result.chunkCount = chunkCount;

		const generationMs = firstTokenTime !== null ? endTime - firstTokenTime : result.totalMs;
		result.tps = generationMs > 0 ? (outputTokens / generationMs) * 1000 : 0;
	} catch (e: any) {
		if (e.name === "AbortError") {
			result.error = `Timed out after ${TIMEOUT_MS / 1000}s`;
		} else {
			result.error = e?.message ?? String(e);
		}
	} finally {
		clearTimeout(timeout);
		// Explicitly release the reader's lock so a timeout/abort mid-stream
		// can't leave undici's underlying socket half-consumed (the trigger for
		// "internal client error while terminating a mid-stream response" —
		// pi itself patched this class of crash in its own client in 0.80.3,
		// but speedtest's raw fetch() doesn't inherit that fix).
		if (reader) {
			try {
				await reader.cancel();
			} catch {
				// Best-effort teardown — stream may already be closed/errored.
			}
		}
	}

	return result;
}

// --- OpenAI Codex Responses API ---
async function runOpenAICodexResponsesTest(
	baseUrl: string,
	modelId: string,
	apiKey: string,
	_extraHeaders: Record<string, string> | undefined,
	result: SpeedTestResult,
	prompt: string,
	maxTokens: number,
): Promise<SpeedTestResult> {
	const resolved = baseUrl.replace(/\/+$/, "");
	const url =
		resolved.endsWith("/codex/responses") || resolved.endsWith("/codex")
			? `${resolved}${resolved.endsWith("/codex") ? "/responses" : ""}`
			: `${resolved}/codex/responses`;

	// Extract account ID from JWT (compact format: header.payload.signature)
	const accountId = (() => {
		try {
			const payload = apiKey.split(".")[1];
			const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
			return decoded.aid || decoded.sub || decoded.email || "";
		} catch {
			return "";
		}
	})();

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		"openai-organization": "personal",
		"OpenAI-Beta": "responses_websockets=2026-02-06",
	};
	if (accountId) {
		headers["account-id"] = accountId;
	}

	const body = JSON.stringify({
		model: modelId,
		store: false,
		stream: true,
		instructions: "You are a helpful assistant.",
		input: [{ role: "user", content: prompt }],
		text: { verbosity: "low" },
		include: ["reasoning.encrypted_content"],
	});

	const startTime = Date.now();
	let firstTokenTime: number | null = null;
	let reportedTokens = 0;
	let fullContent = "";
	let chunkCount = 0;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			result.error = `HTTP ${response.status}: ${text.slice(0, 200)}`;
			return result;
		}

		if (!response.body) {
			result.error = "No response body";
			return result;
		}

		reader = (response.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				const dataLines = chunk
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim())
					.join("\n")
					.trim();

				if (!dataLines || dataLines === "[DONE]") {
					idx = buffer.indexOf("\n\n");
					continue;
				}

				try {
					const event = JSON.parse(dataLines);
					const type: string = event.type;

					if (type === "response.output_text.delta") {
						const text = event.delta;
						if (text) {
							fullContent += text;
							chunkCount++;
							if (firstTokenTime === null) {
								firstTokenTime = Date.now();
							}
						}
					} else if (
						type === "response.done" ||
						type === "response.completed" ||
						type === "response.incomplete"
					) {
						const usage = event.response?.usage;
						if (usage?.output_tokens || usage?.completion_tokens) {
							reportedTokens = usage.output_tokens || usage.completion_tokens;
						}
					}
				} catch {
					// skip malformed
				}
				idx = buffer.indexOf("\n\n");
			}
		}

		const endTime = Date.now();

		// Use content-based token counting (accurate) over usage field (may be allocation)
		const contentTokens = fullContent.length > 0 ? countContentTokens(fullContent) : 0;
		const outputTokens = contentTokens > 0 ? contentTokens : reportedTokens;

		result.ttftMs = firstTokenTime !== null ? firstTokenTime - startTime : 0;
		result.totalMs = endTime - startTime;
		result.outputTokens = outputTokens;
		result.reportedTokens = reportedTokens;
		result.chunkCount = chunkCount;

		const generationMs = firstTokenTime !== null ? endTime - firstTokenTime : result.totalMs;
		result.tps = generationMs > 0 ? (outputTokens / generationMs) * 1000 : 0;
	} catch (e: any) {
		if (e.name === "AbortError") {
			result.error = `Timed out after ${TIMEOUT_MS / 1000}s`;
		} else {
			result.error = e?.message ?? String(e);
		}
	} finally {
		clearTimeout(timeout);
		// See executeStreamTest's matching finally block for why this matters.
		if (reader) {
			try {
				await reader.cancel();
			} catch {
				// Best-effort teardown — stream may already be closed/errored.
			}
		}
	}

	return result;
}
