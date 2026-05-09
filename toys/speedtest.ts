import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---
const TEST_PROMPT = "Say 'hello world' and nothing else.";
const MAX_TOKENS = 128;
const TIMEOUT_MS = 30_000;

// --- Types ---
interface SpeedTestResult {
	provider: string;
	modelId: string;
	modelName: string;
	ttftMs: number;
	tps: number;
	totalMs: number;
	outputTokens: number;
	apiType: string;
	error?: string;
}

// --- Main ---
export default function speedTestExtension(pi: ExtensionAPI) {
	pi.registerCommand("speedtest", {
		description: "Benchmark active model's TPS, TTFT, and latency",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model. Use /model to select one.", "error");
				return;
			}

			ctx.ui.setStatus("speedtest", `⏱ Testing ${model.id}...`);

			const authResult = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!authResult.ok) {
				ctx.ui.setStatus("speedtest", undefined);
				ctx.ui.notify(`Auth error for ${model.provider}: ${authResult.error}`, "error");
				return;
			}

			const result = await runSpeedTest(model, authResult.apiKey, authResult.headers);
			ctx.ui.setStatus("speedtest", undefined);

			if (result.error) {
				ctx.ui.notify(`Speedtest failed: ${result.error}`, "error");
				return;
			}

			const rating = result.tps >= 50 ? "🟢" : result.tps >= 20 ? "🟡" : "🔴";
			const label = result.tps >= 50 ? "fast" : result.tps >= 20 ? "moderate" : "slow";

			ctx.ui.notify(
				[
					`${rating} Speed Test: ${result.modelName}`,
					`  TTFT:    ${result.ttftMs.toFixed(0)} ms`,
					`  TPS:     ${result.tps.toFixed(1)} tok/s (${label})`,
					`  Total:   ${result.totalMs.toFixed(0)} ms`,
					`  Tokens:  ${result.outputTokens}`,
					`  API:     ${result.apiType}`,
				].join("\n"),
				"info",
			);
		},
	});
}

// --- Speedtest runner ---
async function runSpeedTest(
	model: any,
	apiKey: string | undefined,
	extraHeaders: Record<string, string> | undefined,
): Promise<SpeedTestResult> {
	const result: SpeedTestResult = {
		provider: model.provider,
		modelId: model.id,
		modelName: model.name || model.id,
		ttftMs: 0,
		tps: 0,
		totalMs: 0,
		outputTokens: 0,
		apiType: model.api as string,
	};

	const api = model.api as string;
	const baseUrl = (model.baseUrl as string).replace(/\/$/, "");

	try {
		if (api === "anthropic-messages") {
			return await runAnthropicTest(baseUrl, model.id, apiKey, extraHeaders, result);
		}
		// openai-completions, openai-responses, and any OpenAI-compatible API
		return await runOpenAITest(baseUrl, model.id, apiKey, extraHeaders, result);
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
		messages: [{ role: "user", content: TEST_PROMPT }],
		max_tokens: MAX_TOKENS,
		stream: true,
		stream_options: { include_usage: true },
	});

	return await executeStreamTest(url, headers, body, result, (chunk) => {
		const content = chunk.choices?.[0]?.delta?.content;
		const tokens = chunk.usage?.completion_tokens;
		return { content: content || undefined, outputTokens: tokens || undefined };
	});
}

// --- Anthropic messages API ---
async function runAnthropicTest(
	baseUrl: string,
	modelId: string,
	apiKey: string | undefined,
	extraHeaders: Record<string, string> | undefined,
	result: SpeedTestResult,
): Promise<SpeedTestResult> {
	const url = `${baseUrl}/v1/messages`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		...extraHeaders,
	};
	if (apiKey) {
		// OAuth token → Authorization: Bearer; API key → x-api-key
		if (apiKey.startsWith("sk-")) {
			headers["x-api-key"] = apiKey;
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}
	}

	const body = JSON.stringify({
		model: modelId,
		messages: [{ role: "user", content: TEST_PROMPT }],
		max_tokens: MAX_TOKENS,
		stream: true,
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
	let outputTokens = 0;
	let fullContent = "";

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

		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
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
							if (firstTokenTime === null) {
								firstTokenTime = Date.now();
							}
						}
						if (chunk.outputTokens) {
							outputTokens = chunk.outputTokens;
						}
					} catch {
						// Skip malformed JSON chunks
					}
				}
			}
		}

		const endTime = Date.now();

		// Estimate tokens from content length if usage not provided
		if (outputTokens === 0 && fullContent.length > 0) {
			outputTokens = Math.ceil(fullContent.length / 4);
		}

		result.ttftMs = firstTokenTime !== null ? firstTokenTime - startTime : 0;
		result.totalMs = endTime - startTime;
		result.outputTokens = outputTokens;

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
	}

	return result;
}
