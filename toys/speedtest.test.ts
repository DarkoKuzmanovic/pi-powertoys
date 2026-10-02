import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import {
	completeModelArgs,
	formatComparison,
	formatSingle,
	measureStream,
	parseSpeedtestArgs,
	resolveModelRefs,
	runBenchmark,
	summarizeSamples,
	type ModelResult,
	type RunSample,
} from "./speedtest.ts";

// ── parseSpeedtestArgs ─────────────────────────────────────────

test("parseSpeedtestArgs: defaults to 3 runs on the active model", () => {
	const p = parseSpeedtestArgs("");
	assert.equal(p.runs, 3);
	assert.deepEqual(p.refs, []);
	assert.equal(p.pick, false);
	assert.equal(p.thinking, undefined);
	assert.equal(p.error, undefined);
});

test("parseSpeedtestArgs: a bare integer sets runs, clamped to [1, 10]", () => {
	assert.equal(parseSpeedtestArgs("1").runs, 1);
	assert.equal(parseSpeedtestArgs("0").runs, 1);
	assert.equal(parseSpeedtestArgs("99").runs, 10);
});

test("parseSpeedtestArgs: model refs are collected in order alongside a run count", () => {
	const p = parseSpeedtestArgs("anthropic/claude-haiku-4-5 2 openai/gpt-5-mini");
	assert.equal(p.runs, 2);
	assert.deepEqual(p.refs, ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"]);
});

test("parseSpeedtestArgs: --thinking accepts both spaced and = forms", () => {
	assert.equal(parseSpeedtestArgs("--thinking high").thinking, "high");
	assert.equal(parseSpeedtestArgs("--thinking=low a/b").thinking, "low");
	assert.deepEqual(parseSpeedtestArgs("--thinking=low a/b").refs, ["a/b"]);
});

test("parseSpeedtestArgs: rejects unknown thinking levels and dangling flags", () => {
	assert.match(parseSpeedtestArgs("--thinking bogus").error ?? "", /thinking level/);
	assert.match(parseSpeedtestArgs("--thinking").error ?? "", /thinking level/);
	assert.match(parseSpeedtestArgs("--frobnicate").error ?? "", /unknown option/i);
});

test("parseSpeedtestArgs: pick mode takes no model refs", () => {
	assert.equal(parseSpeedtestArgs("pick").pick, true);
	assert.equal(parseSpeedtestArgs("pick 2").runs, 2);
	assert.match(parseSpeedtestArgs("pick a/b").error ?? "", /pick/);
});

// ── resolveModelRefs ───────────────────────────────────────────

const M = (provider: string, id: string) => ({ provider, id, name: id });
const available = [
	M("anthropic", "claude-haiku-4-5"),
	M("anthropic", "claude-sonnet-4-5"),
	M("openrouter", "anthropic/claude-sonnet-4-5"),
	M("openai", "gpt-5-mini"),
];
const all = [...available, M("google", "gemini-2.5-flash")];

test("resolveModelRefs: exact provider/id, splitting on the first slash only", () => {
	const r = resolveModelRefs(["openrouter/anthropic/claude-sonnet-4-5", "openai/gpt-5-mini"], available, all);
	assert.deepEqual(r.errors, []);
	assert.deepEqual(
		r.models.map((m) => m.provider + "/" + m.id),
		["openrouter/anthropic/claude-sonnet-4-5", "openai/gpt-5-mini"],
	);
});

test("resolveModelRefs: an exact bare id beats substring matches", () => {
	assert.equal(resolveModelRefs(["gpt-5-mini"], available, all).models[0]?.provider, "openai");
	// openrouter/anthropic/claude-sonnet-4-5 contains it, but only anthropic's id equals it.
	assert.equal(resolveModelRefs(["claude-sonnet-4-5"], available, all).models[0]?.provider, "anthropic");
});

test("resolveModelRefs: an ambiguous substring lists the candidates", () => {
	const amb = resolveModelRefs(["sonnet"], available, all);
	assert.equal(amb.models.length, 0);
	assert.match(amb.errors[0] ?? "", /ambiguous/);
	assert.match(amb.errors[0] ?? "", /anthropic\/claude-sonnet-4-5/);
});

test("resolveModelRefs: a unique case-insensitive substring resolves", () => {
	assert.equal(resolveModelRefs(["HAIKU"], available, all).models[0]?.id, "claude-haiku-4-5");
});

test("resolveModelRefs: known-but-unauthenticated and unknown refs report distinct errors", () => {
	const r = resolveModelRefs(["google/gemini-2.5-flash", "nope/nothing"], available, all);
	assert.equal(r.models.length, 0);
	assert.match(r.errors[0] ?? "", /no credentials/);
	assert.match(r.errors[1] ?? "", /no model matches/);
});

test("resolveModelRefs: duplicate refs collapse to one model", () => {
	const r = resolveModelRefs(["openai/gpt-5-mini", "gpt-5-mini"], available, all);
	assert.equal(r.models.length, 1);
});

// ── measureStream ──────────────────────────────────────────────

function clock(times: number[]): () => number {
	let i = 0;
	return () => {
		const t = times[Math.min(i, times.length - 1)]!;
		i++;
		return t;
	};
}

async function* events(list: unknown[]) {
	for (const e of list) yield e as never;
}

const finalMsg = (output: number, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	provider: "p",
	model: "m",
	stopReason: "stop",
	content: [],
	usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output, cost: { total: 0.002 } },
	...extra,
});

test("measureStream: splits first token, first text, and decode window", async () => {
	// now() is read once per delta and once at the terminal event.
	const now = clock([100, 150, 400, 600, 1100]);
	const s = await measureStream(
		events([
			{ type: "start" },
			{ type: "thinking_delta", delta: "hmm" }, // 100
			{ type: "thinking_delta", delta: "ok" }, // 150
			{ type: "text_delta", delta: "Hello" }, // 400
			{ type: "text_delta", delta: " world" }, // 600
			{ type: "done", reason: "stop", message: finalMsg(200) }, // 1100
		]),
		{ start: 0, now },
	);
	assert.equal(s.ok, true);
	assert.equal(s.ttftMs, 100);
	assert.equal(s.firstTextMs, 400);
	assert.equal(s.totalMs, 1100);
	assert.equal(s.outputTokens, 200);
	assert.equal(s.tokensEstimated, false);
	assert.equal(s.tps, 200); // 200 tokens over the 1000 ms after the first token
	assert.equal(s.costUsd, 0.002);
	assert.equal(s.stopReason, "stop");
	assert.equal(s.dispatched, "p/m");
});

test("measureStream: falls back to a ~4 chars/token estimate when usage is missing", async () => {
	const s = await measureStream(
		events([
			{ type: "text_delta", delta: "a".repeat(40) },
			{ type: "text_delta", delta: "b".repeat(40) },
			{ type: "done", reason: "stop", message: finalMsg(0) },
		]),
		{ start: 0, now: clock([10, 20, 1010]) },
	);
	assert.equal(s.outputTokens, 20);
	assert.equal(s.tokensEstimated, true);
	assert.equal(s.tps, 20);
});

test("measureStream: hidden reasoning tokens are excluded from the decode rate", async () => {
	// No thinking deltas observed, but usage reports 300 reasoning tokens spent
	// before the first visible token: they were not generated inside the window.
	const usage = { ...finalMsg(0).usage, output: 400, reasoning: 300 };
	const s = await measureStream(
		events([
			{ type: "text_delta", delta: "x" },
			{ type: "text_delta", delta: "y" },
			{ type: "done", reason: "stop", message: finalMsg(400, { usage }) },
		]),
		{ start: 0, now: clock([2000, 2500, 3000]) },
	);
	assert.equal(s.outputTokens, 400);
	assert.equal(s.hiddenReasoningTokens, 300);
	assert.equal(s.tps, 100); // (400 - 300) tokens / 1 s
});

test("measureStream: an error event yields a failed sample with the provider message", async () => {
	const s = await measureStream(
		events([
			{ type: "error", reason: "error", error: finalMsg(0, { stopReason: "error", errorMessage: "HTTP 429: slow down" }) },
		]),
		{ start: 0, now: clock([50]) },
	);
	assert.equal(s.ok, false);
	assert.equal(s.error, "HTTP 429: slow down");
	assert.equal(s.stopReason, "error");
});

test("measureStream: a single chunk has no measurable decode rate", async () => {
	const s = await measureStream(
		events([
			{ type: "text_delta", delta: "whole answer at once" },
			{ type: "done", reason: "stop", message: finalMsg(5) },
		]),
		{ start: 0, now: clock([300, 300]) },
	);
	assert.equal(s.ok, true);
	assert.equal(s.tps, undefined);
});

test("measureStream: empty deltas do not start the first-token clock", async () => {
	const s = await measureStream(
		events([
			{ type: "text_delta", delta: "" },
			{ type: "text_delta", delta: "Hello" },
			{ type: "text_delta", delta: " world" },
			{ type: "done", reason: "stop", message: finalMsg(10) },
		]),
		// The empty delta reads no timestamp, so the first reading belongs to "Hello".
		{ start: 0, now: clock([500, 1000, 1500]) },
	);
	assert.equal(s.ttftMs, 500);
	assert.equal(s.firstTextMs, 500);
	assert.equal(s.tps, 10); // 10 tokens over the 1000 ms after the first token
});

test("measureStream: a stream that ends without done/error is a failure", async () => {
	const s = await measureStream(events([{ type: "text_delta", delta: "x" }]), { start: 0, now: clock([1, 2]) });
	assert.equal(s.ok, false);
	assert.match(s.error ?? "", /without a result/);
});

test("measureStream: works on a real pi-ai stream (faux provider)", async () => {
	const faux = fauxProvider({ tokensPerSecond: 2000 });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxThinking("Let me think about it."), fauxText("Printing changed the world. ".repeat(20))]),
	]);
	const start = performance.now();
	const s = await measureStream(
		models.streamSimple(faux.getModel(), { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
		{ start },
	);
	assert.equal(s.ok, true, s.error);
	assert.ok(s.outputTokens > 0);
	assert.equal(s.tokensEstimated, false);
	assert.ok((s.ttftMs ?? -1) >= 0);
	assert.ok((s.firstTextMs ?? -1) >= (s.ttftMs ?? 0));
	assert.ok(s.totalMs >= (s.firstTextMs ?? 0));
});

// ── runBenchmark ───────────────────────────────────────────────

const okSample = (tps: number, extra: Partial<RunSample> = {}): RunSample => ({
	ok: true,
	ttftMs: 100,
	firstTextMs: 100,
	totalMs: 1000,
	outputTokens: 100,
	tokensEstimated: false,
	hiddenReasoningTokens: 0,
	tps,
	costUsd: 0.001,
	stopReason: "stop",
	...extra,
});
const failSample = (error: string): RunSample => ({
	ok: false,
	error,
	totalMs: 10,
	outputTokens: 0,
	tokensEstimated: false,
	hiddenReasoningTokens: 0,
});

test("runBenchmark: warms each model, then interleaves runs round-robin", async () => {
	const calls: string[] = [];
	const { results, aborted } = await runBenchmark({
		models: [M("a", "1"), M("b", "2")],
		runs: 2,
		request: async (model, phase) => {
			calls.push(phase + ":" + model.provider);
			return okSample(50);
		},
	});
	assert.equal(aborted, false);
	assert.deepEqual(calls, ["warmup:a", "warmup:b", "run:a", "run:b", "run:a", "run:b"]);
	assert.equal(results[0]!.samples.length, 2); // warm-up discarded
});

test("runBenchmark: a failing model is dropped without stopping the others", async () => {
	const calls: string[] = [];
	const { results } = await runBenchmark({
		models: [M("a", "1"), M("b", "2")],
		runs: 3,
		request: async (model, phase) => {
			calls.push(phase + ":" + model.provider);
			if (model.provider === "a" && phase === "run") return failSample("HTTP 500");
			return okSample(50);
		},
	});
	assert.equal(results[0]!.error, "HTTP 500");
	assert.equal(results[1]!.samples.length, 3);
	assert.equal(calls.filter((c) => c === "run:a").length, 1);
});

test("runBenchmark: a failed warm-up marks the model failed", async () => {
	const { results } = await runBenchmark({
		models: [M("a", "1")],
		runs: 2,
		request: async () => failSample("no auth"),
	});
	assert.match(results[0]!.error ?? "", /warm-up: no auth/);
	assert.equal(results[0]!.samples.length, 0);
});

test("runBenchmark: stops scheduling once the signal aborts", async () => {
	const controller = new AbortController();
	let n = 0;
	const { aborted } = await runBenchmark({
		models: [M("a", "1")],
		runs: 5,
		signal: controller.signal,
		request: async () => {
			if (++n === 2) controller.abort();
			return okSample(10);
		},
	});
	assert.equal(aborted, true);
	assert.equal(n, 2);
});

test("runBenchmark: reports progress before every request", async () => {
	const seen: string[] = [];
	await runBenchmark({
		models: [M("a", "1")],
		runs: 1,
		request: async () => okSample(1),
		onProgress: (p) => seen.push(p.phase + " " + p.done + "/" + p.total + " " + p.model.provider),
	});
	assert.deepEqual(seen, ["warmup 0/2 a", "run 1/2 a"]);
});

// ── summarizeSamples ───────────────────────────────────────────

test("summarizeSamples: medians, tps range, cost sum, estimate flag", () => {
	const s = summarizeSamples([
		okSample(30, { ttftMs: 300, totalMs: 3000 }),
		okSample(10, { ttftMs: 100, totalMs: 1000, tokensEstimated: true }),
		okSample(20, { ttftMs: 200, totalMs: 2000 }),
	]);
	assert.equal(s.runs, 3);
	assert.equal(s.ttftMs, 200);
	assert.equal(s.tps, 20);
	assert.equal(s.tpsMin, 10);
	assert.equal(s.tpsMax, 30);
	assert.equal(s.totalMs, 2000);
	assert.equal(s.tokensEstimated, true);
	assert.ok(Math.abs((s.costUsd ?? 0) - 0.003) < 1e-12);
});

test("summarizeSamples: metrics no run measured stay undefined", () => {
	const s = summarizeSamples([okSample(1, { tps: undefined, firstTextMs: undefined, costUsd: undefined })]);
	assert.equal(s.tps, undefined);
	assert.equal(s.firstTextMs, undefined);
	assert.equal(s.costUsd, undefined);
});

// ── formatting ─────────────────────────────────────────────────

test("formatComparison: ranks by tok/s and lists failures last", () => {
	const results: ModelResult<ReturnType<typeof M>>[] = [
		{ model: M("slow", "s"), samples: [okSample(10)] },
		{ model: M("broken", "b"), samples: [], error: "HTTP 401: bad key" },
		{ model: M("fast", "f"), samples: [okSample(90)] },
	];
	const text = formatComparison(results, { runs: 1 });
	const fast = text.indexOf("fast/f");
	const slow = text.indexOf("slow/s");
	const broken = text.indexOf("broken/b");
	assert.ok(fast > 0 && slow > fast && broken > slow, text);
	assert.match(text, /HTTP 401: bad key/);
});

test("formatSingle: shows thinking time and the routed model when it differs", () => {
	const text = formatSingle(
		{
			model: { provider: "router", id: "auto", name: "Auto", api: "virtual" },
			samples: [okSample(60, { ttftMs: 200, firstTextMs: 1700, dispatched: "anthropic/claude-haiku-4-5" })],
		},
		{ runs: 1 },
	);
	assert.match(text, /1500 ms thinking/);
	assert.match(text, /anthropic\/claude-haiku-4-5/);
	assert.match(text, /60\.0 tok\/s/);
});

// ── completeModelArgs ──────────────────────────────────────────

test("completeModelArgs: completes the last token and keeps earlier ones", () => {
	const keys = ["anthropic/claude-haiku-4-5", "openai/gpt-5-mini"];
	const items = completeModelArgs("openai/gpt-5-mini anth", keys) ?? [];
	assert.deepEqual(
		items.map((i) => i.value),
		["openai/gpt-5-mini anthropic/claude-haiku-4-5"],
	);
	assert.ok((completeModelArgs("", keys) ?? []).some((i) => i.value === "pick"));
	assert.equal(completeModelArgs("zzz", keys), null);
});
