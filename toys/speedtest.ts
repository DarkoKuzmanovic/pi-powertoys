/**
 * speedtest — benchmark model latency and throughput through Pi's own
 * provider layer.
 *
 *   /speedtest                      active model, 3 runs
 *   /speedtest 1                    quick single run
 *   /speedtest <model> <model> ...  compare models side by side
 *   /speedtest pick                 choose models to compare from a list
 *   --thinking <level>              request a reasoning level (default: provider default)
 *
 * Requests go through ctx.modelRegistry.streamSimple(), so every provider,
 * auth mode (API key, OAuth, auth-derived base URL), virtual model, and wire
 * protocol Pi supports works with no per-API code here. Output token counts
 * come from the provider's reported usage; a ~4 chars/token estimate is used
 * only when the provider reports none, and the result says so.
 *
 * Metrics per run:
 *   first token  — request start → first streamed token of any kind (thinking or text)
 *   first text   — request start → first visible answer text
 *   tok/s        — output tokens ÷ (end − first token). Reasoning tokens the
 *                  provider spent before the first visible token without
 *                  streaming them are excluded: they were not generated inside
 *                  that window.
 *   total        — request start → terminal event
 */
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { withStatusChip } from "./toy-kit.ts";

// ── Config ─────────────────────────────────────────────────────

const TEST_PROMPT =
	"Write about 250 words of plain prose on the history of the printing press and its effect on society. " +
	"No headings, lists, or preamble.";
const WARMUP_PROMPT = "Reply with just: ok";
// Headroom for reasoning models: a non-reasoning model stops near ~350 tokens
// on its own; a thinking model needs room to finish thinking and still answer.
const MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_RUNS = 3;
const MAX_RUNS = 10;
const MAX_MODELS = 10;
const STATUS_KEY = "speedtest";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const USAGE =
	"Usage: /speedtest [runs] [model ...] [--thinking <level>] | /speedtest pick [runs]. " +
	"Models are provider/id, an exact id, or a unique substring.";

// ── Types ──────────────────────────────────────────────────────

export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
	api?: string;
}

export interface RunSample {
	ok: boolean;
	error?: string;
	stopReason?: string;
	/** Request start → first streamed token of any kind. */
	ttftMs?: number;
	/** Request start → first visible answer text. */
	firstTextMs?: number;
	totalMs: number;
	outputTokens: number;
	/** True when the provider reported no output usage and tokens were estimated. */
	tokensEstimated: boolean;
	/** Reasoning tokens reported by the provider but never streamed (excluded from tps). */
	hiddenReasoningTokens: number;
	/** Undefined when fewer than two chunks arrived — no decode window to measure. */
	tps?: number;
	costUsd?: number;
	/** provider/model of the physical model that answered (differs for virtual models). */
	dispatched?: string;
}

export interface ModelResult<T extends ModelLike = ModelLike> {
	model: T;
	samples: RunSample[];
	error?: string;
}

export interface Summary {
	runs: number;
	ttftMs?: number;
	firstTextMs?: number;
	totalMs?: number;
	tps?: number;
	tpsMin?: number;
	tpsMax?: number;
	outputTokens?: number;
	hiddenReasoningTokens?: number;
	tokensEstimated: boolean;
	costUsd?: number;
	dispatched?: string;
}

export interface ParsedArgs {
	runs: number;
	refs: string[];
	pick: boolean;
	thinking?: ThinkingLevel;
	error?: string;
}

export type Phase = "warmup" | "run";

export interface Progress<T extends ModelLike> {
	model: T;
	phase: Phase;
	/** 1-based measured run index; 0 for the warm-up. */
	run: number;
	done: number;
	total: number;
}

// ── Argument parsing ───────────────────────────────────────────

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseSpeedtestArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const out: ParsedArgs = { runs: DEFAULT_RUNS, refs: [], pick: false };
	const setThinking = (value: string | undefined) => {
		if (!value) {
			out.error = "--thinking needs a thinking level: " + THINKING_LEVELS.join(", ");
		} else if (!isThinkingLevel(value)) {
			out.error = "unknown thinking level \"" + value + "\" (use one of " + THINKING_LEVELS.join(", ") + ")";
		} else {
			out.thinking = value;
		}
	};

	for (let i = 0; i < tokens.length && !out.error; i++) {
		const token = tokens[i]!;
		if (/^\d+$/.test(token)) {
			out.runs = Math.max(1, Math.min(MAX_RUNS, Number.parseInt(token, 10)));
		} else if (token === "pick") {
			out.pick = true;
		} else if (token === "--thinking" || token === "-t") {
			setThinking(tokens[++i]);
		} else if (token.startsWith("--thinking=")) {
			setThinking(token.slice("--thinking=".length));
		} else if (token.startsWith("-")) {
			out.error = "unknown option " + token;
		} else {
			out.refs.push(token);
		}
	}
	if (!out.error && out.pick && out.refs.length > 0) {
		out.error = "pick takes no model arguments — it opens a picker instead";
	}
	return out;
}

// ── Model resolution ───────────────────────────────────────────

const keyOf = (m: ModelLike) => m.provider + "/" + m.id;

/**
 * Resolve user refs against the authenticated models. Precedence: exact
 * provider/id → exact id → unique case-insensitive substring of provider/id.
 * A ref that only matches models without credentials says so explicitly.
 */
export function resolveModelRefs<T extends ModelLike>(
	refs: readonly string[],
	available: readonly T[],
	all: readonly T[],
): { models: T[]; errors: string[] } {
	const models: T[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();

	const match = (pool: readonly T[], ref: string): T[] => {
		const lower = ref.toLowerCase();
		const exactKey = pool.filter((m) => keyOf(m).toLowerCase() === lower);
		if (exactKey.length > 0) return exactKey;
		const exactId = pool.filter((m) => m.id.toLowerCase() === lower);
		if (exactId.length > 0) return exactId;
		return pool.filter((m) => keyOf(m).toLowerCase().includes(lower));
	};

	for (const ref of refs) {
		const hits = match(available, ref);
		if (hits.length === 1) {
			const model = hits[0]!;
			if (!seen.has(keyOf(model))) {
				seen.add(keyOf(model));
				models.push(model);
			}
			continue;
		}
		if (hits.length > 1) {
			const names = hits.slice(0, 6).map(keyOf).join(", ");
			errors.push("\"" + ref + "\" is ambiguous: " + names + (hits.length > 6 ? ", …" : ""));
			continue;
		}
		const unauthenticated = match(all, ref);
		if (unauthenticated.length === 1) {
			errors.push(keyOf(unauthenticated[0]!) + " has no credentials (log in or set its API key)");
		} else {
			errors.push("no model matches \"" + ref + "\"");
		}
	}
	return { models, errors };
}

// ── Measurement ────────────────────────────────────────────────

/**
 * Consume one pi-ai event stream and turn it into timing metrics. The clock is
 * injectable so tests can script exact timestamps; now() is read once per
 * streamed delta and once at the terminal event.
 */
export async function measureStream(
	events: AsyncIterable<AssistantMessageEvent>,
	opts: { start: number; now?: () => number },
): Promise<RunSample> {
	const now = opts.now ?? (() => performance.now());
	let firstToken: number | undefined;
	let firstText: number | undefined;
	let end: number | undefined;
	let deltas = 0;
	let chars = 0;
	let sawThinking = false;
	let final: AssistantMessage | undefined;
	let failed = false;
	let thrown: string | undefined;

	try {
		for await (const event of events) {
			if ((event.type === "thinking_delta" || event.type === "text_delta") && event.delta.length > 0) {
				const t = now();
				deltas++;
				chars += event.delta.length;
				firstToken ??= t;
				if (event.type === "thinking_delta") sawThinking = true;
				else firstText ??= t;
			} else if (event.type === "done") {
				end = now();
				final = event.message;
			} else if (event.type === "error") {
				end = now();
				final = event.error;
				failed = true;
			}
		}
	} catch (e) {
		thrown = errorText(e);
	}

	const endAt = end ?? now();
	const base: RunSample = {
		ok: false,
		totalMs: endAt - opts.start,
		outputTokens: 0,
		tokensEstimated: false,
		hiddenReasoningTokens: 0,
	};
	if (!final) {
		return { ...base, error: thrown ?? "stream ended without a result" };
	}
	const stopReason = final.stopReason;
	if (failed || stopReason === "error" || stopReason === "aborted") {
		return { ...base, stopReason, error: final.errorMessage || stopReason };
	}

	const reported = final.usage?.output ?? 0;
	const tokensEstimated = !(reported > 0);
	const outputTokens = tokensEstimated ? Math.ceil(chars / 4) : reported;
	// Optional: only some providers report reasoning tokens separately.
	const reportedReasoning = final.usage?.reasoning ?? 0;
	const hiddenReasoningTokens =
		!sawThinking && !tokensEstimated && Number.isFinite(reportedReasoning)
			? Math.max(0, Math.min(outputTokens, reportedReasoning))
			: 0;
	const windowMs = firstToken === undefined ? 0 : endAt - firstToken;
	const tps = deltas >= 2 && windowMs > 0 ? ((outputTokens - hiddenReasoningTokens) / windowMs) * 1000 : undefined;
	const cost = final.usage?.cost?.total;

	return {
		ok: true,
		stopReason,
		ttftMs: firstToken === undefined ? undefined : firstToken - opts.start,
		firstTextMs: firstText === undefined ? undefined : firstText - opts.start,
		totalMs: endAt - opts.start,
		outputTokens,
		tokensEstimated,
		hiddenReasoningTokens,
		tps,
		costUsd: typeof cost === "number" && cost > 0 ? cost : undefined,
		dispatched: final.provider && final.model ? final.provider + "/" + final.model : undefined,
	};
}

// ── Orchestration ──────────────────────────────────────────────

/**
 * Warm every model once (discarded — absorbs connection setup and cold
 * starts), then interleave measured runs round-robin so slow drift in network
 * conditions spreads across all models instead of biasing whichever ran last.
 * A model that fails is dropped; the rest continue. Runs are sequential on
 * purpose: parallel requests would compete for bandwidth and skew timings.
 */
export async function runBenchmark<T extends ModelLike>(opts: {
	models: readonly T[];
	runs: number;
	request: (model: T, phase: Phase) => Promise<RunSample>;
	onProgress?: (progress: Progress<T>) => void;
	signal?: AbortSignal;
}): Promise<{ results: ModelResult<T>[]; aborted: boolean }> {
	const results: ModelResult<T>[] = opts.models.map((model) => ({ model, samples: [] }));
	const total = opts.models.length * (opts.runs + 1);
	let done = 0;
	const aborted = () => opts.signal?.aborted === true;

	const step = async (result: ModelResult<T>, phase: Phase, run: number): Promise<RunSample> => {
		opts.onProgress?.({ model: result.model, phase, run, done, total });
		const sample = await opts.request(result.model, phase);
		done++;
		return sample;
	};

	for (const result of results) {
		if (aborted()) return { results, aborted: true };
		const sample = await step(result, "warmup", 0);
		if (aborted()) return { results, aborted: true };
		if (!sample.ok) result.error = "warm-up: " + (sample.error ?? "failed");
	}

	for (let run = 1; run <= opts.runs; run++) {
		for (const result of results) {
			if (result.error) continue;
			if (aborted()) return { results, aborted: true };
			const sample = await step(result, "run", run);
			if (aborted()) return { results, aborted: true };
			if (sample.ok) result.samples.push(sample);
			else result.error = sample.error ?? "failed";
		}
	}
	return { results, aborted: false };
}

// ── Statistics ─────────────────────────────────────────────────

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function defined(values: readonly (number | undefined)[]): number[] {
	return values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function summarizeSamples(samples: readonly RunSample[]): Summary {
	const ok = samples.filter((s) => s.ok);
	const tpsValues = defined(ok.map((s) => s.tps));
	const costs = defined(ok.map((s) => s.costUsd));
	return {
		runs: ok.length,
		ttftMs: median(defined(ok.map((s) => s.ttftMs))),
		firstTextMs: median(defined(ok.map((s) => s.firstTextMs))),
		totalMs: median(ok.map((s) => s.totalMs)),
		tps: median(tpsValues),
		tpsMin: tpsValues.length > 0 ? Math.min(...tpsValues) : undefined,
		tpsMax: tpsValues.length > 0 ? Math.max(...tpsValues) : undefined,
		outputTokens: median(ok.map((s) => s.outputTokens)),
		hiddenReasoningTokens: median(ok.map((s) => s.hiddenReasoningTokens)),
		tokensEstimated: ok.some((s) => s.tokensEstimated),
		costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : undefined,
		dispatched: ok.find((s) => s.dispatched)?.dispatched,
	};
}

// ── Formatting ─────────────────────────────────────────────────

const ms = (v: number | undefined) => (v === undefined ? "—" : Math.round(v) + " ms");
const compactMs = (v: number | undefined) =>
	v === undefined ? "—" : v < 10_000 ? Math.round(v) + "ms" : (v / 1000).toFixed(1) + "s";
const tpsText = (v: number | undefined) => (v === undefined ? "—" : v.toFixed(1));
const usd = (v: number | undefined) => (v === undefined ? "—" : "$" + (v < 0.01 ? v.toFixed(4) : v.toFixed(3)));

function rating(tps: number | undefined): { icon: string; label: string } {
	if (tps === undefined) return { icon: "⚪", label: "not measurable" };
	if (tps >= 50) return { icon: "🟢", label: "fast" };
	if (tps >= 20) return { icon: "🟡", label: "moderate" };
	return { icon: "🔴", label: "slow" };
}

function runLabel(summaryRuns: number, requested: number): string {
	if (requested === 1) return "1 run";
	return summaryRuns === requested ? requested + " runs, median" : summaryRuns + "/" + requested + " runs, median";
}

export function formatSingle(result: ModelResult, opts: { runs: number; thinking?: ThinkingLevel }): string {
	const key = keyOf(result.model);
	const s = summarizeSamples(result.samples);
	if (s.runs === 0) {
		return "✗ Speed test failed: " + key + " — " + (result.error ?? "no successful runs");
	}
	const r = rating(s.tps);
	const name = result.model.name && result.model.name !== result.model.id ? result.model.name + " (" + key + ")" : key;
	const lines = [r.icon + " Speed test: " + name + " — " + runLabel(s.runs, opts.runs)];
	lines.push("  First token:  " + ms(s.ttftMs));
	if (s.firstTextMs !== undefined && s.ttftMs !== undefined && s.firstTextMs - s.ttftMs >= 1) {
		lines.push("  First text:   " + ms(s.firstTextMs) + " (" + ms(s.firstTextMs - s.ttftMs) + " thinking)");
	} else if (s.firstTextMs === undefined) {
		lines.push("  First text:   — (no visible answer text within " + MAX_TOKENS + " tokens)");
	}
	let throughput = "  Throughput:   " + (s.tps === undefined ? "—" : tpsText(s.tps) + " tok/s") + " (" + r.label + ")";
	if (s.tpsMin !== undefined && s.tpsMax !== undefined && s.tps !== undefined && s.tpsMax - s.tpsMin > s.tps * 0.1) {
		throughput += " · range " + tpsText(s.tpsMin) + "–" + tpsText(s.tpsMax);
	}
	lines.push(throughput);
	lines.push("  Total:        " + ms(s.totalMs));
	lines.push(
		"  Output:       " +
			(s.tokensEstimated
				? "~" + Math.round(s.outputTokens ?? 0) + " tokens (estimated — provider reported no usage)"
				: Math.round(s.outputTokens ?? 0) + " tokens (provider-reported)"),
	);
	if ((s.hiddenReasoningTokens ?? 0) > 0) {
		lines.push("  Hidden reasoning: " + Math.round(s.hiddenReasoningTokens!) + " tokens before first text (excluded from tok/s)");
	}
	if (s.costUsd !== undefined) lines.push("  Cost:         " + usd(s.costUsd) + " for " + s.runs + " run" + (s.runs > 1 ? "s" : ""));
	if (s.dispatched && s.dispatched !== key) lines.push("  Routed to:    " + s.dispatched);
	if (result.model.api) lines.push("  API:          " + result.model.api);
	if (opts.thinking) lines.push("  Thinking:     " + opts.thinking + " (requested)");
	if (result.error) lines.push("  ⚠ Stopped early: " + result.error);
	return lines.join("\n");
}

export function formatComparison(results: readonly ModelResult[], opts: { runs: number; thinking?: ThinkingLevel }): string {
	const rows = results.map((result) => ({ result, s: summarizeSamples(result.samples) }));
	const ranked = rows
		.filter((r) => r.s.runs > 0)
		.sort((a, b) => (b.s.tps ?? -1) - (a.s.tps ?? -1) || (a.s.totalMs ?? 0) - (b.s.totalMs ?? 0));
	const failed = rows.filter((r) => r.s.runs === 0);

	const width = Math.min(44, Math.max(5, ...ranked.map((r) => keyOf(r.result.model).length)));
	const fit = (text: string) => (text.length > width ? text.slice(0, width - 1) + "…" : text.padEnd(width));
	const header =
		"Speed test — " + results.length + " models · " + opts.runs + " run" + (opts.runs > 1 ? "s each, median" : "") +
		(opts.thinking ? " · thinking " + opts.thinking : "");
	const lines = [header, ""];
	lines.push(" #  " + fit("Model") + "   1st tok  1st text    tok/s     total  tokens     cost");
	ranked.forEach((r, i) => {
		const s = r.s;
		lines.push(
			String(i + 1).padStart(2) + "  " + fit(keyOf(r.result.model)) + " " +
				compactMs(s.ttftMs).padStart(9) +
				compactMs(s.firstTextMs).padStart(10) +
				tpsText(s.tps).padStart(9) +
				compactMs(s.totalMs).padStart(10) +
				((s.tokensEstimated ? "~" : "") + Math.round(s.outputTokens ?? 0)).padStart(8) +
				usd(s.costUsd).padStart(9),
		);
	});
	const notes: string[] = [];
	for (const r of ranked) {
		const key = keyOf(r.result.model);
		if (r.s.dispatched && r.s.dispatched !== key) notes.push("  " + key + " routed to " + r.s.dispatched);
		if (r.result.error) notes.push("  ⚠ " + key + " stopped after " + r.s.runs + "/" + opts.runs + " runs: " + r.result.error);
		if ((r.s.hiddenReasoningTokens ?? 0) > 0) {
			notes.push("  " + key + ": ~" + Math.round(r.s.hiddenReasoningTokens!) + " hidden reasoning tokens excluded from tok/s");
		}
	}
	for (const r of failed) notes.push(" ✗  " + keyOf(r.result.model) + " — " + (r.result.error ?? "no successful runs"));
	if (ranked.some((r) => r.s.tokensEstimated)) notes.push("  ~ = estimated token count (provider reported no usage)");
	if (notes.length > 0) lines.push("", ...notes);
	return lines.join("\n");
}

// ── Completions ────────────────────────────────────────────────

export function completeModelArgs(prefix: string, modelKeys: readonly string[]): AutocompleteItem[] | null {
	const tokens = prefix.split(/\s+/);
	const last = tokens.pop() ?? "";
	const head = tokens.filter(Boolean);
	const join = (value: string) => [...head, value].join(" ");
	const lower = last.toLowerCase();

	if (head[head.length - 1] === "--thinking" || head[head.length - 1] === "-t") {
		const levels = THINKING_LEVELS.filter((l) => l.startsWith(lower));
		return levels.length > 0 ? levels.map((l) => ({ value: join(l), label: l })) : null;
	}
	if (last.startsWith("-")) {
		return "--thinking".startsWith(last) ? [{ value: join("--thinking"), label: "--thinking", description: "request a reasoning level" }] : null;
	}

	const used = new Set(head);
	const candidates = [
		...(head.length === 0 ? [{ key: "pick", description: "choose models to compare from a list" }] : []),
		...modelKeys.filter((k) => !used.has(k)).map((key) => ({ key, description: undefined as string | undefined })),
	];
	const matches = candidates
		.filter((c) => c.key.toLowerCase().includes(lower))
		.sort((a, b) => Number(!a.key.toLowerCase().startsWith(lower)) - Number(!b.key.toLowerCase().startsWith(lower)))
		.slice(0, 50);
	if (matches.length === 0) return null;
	return matches.map((c) => ({ value: join(c.key), label: c.key, ...(c.description ? { description: c.description } : {}) }));
}

// ── Helpers ────────────────────────────────────────────────────

function errorText(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** True when e is Pi's "stale ctx" guard firing — session replaced/reloaded mid-run. */
function isStaleCtxError(e: unknown): boolean {
	return e instanceof Error && /stale after session replacement/.test(e.message);
}

/** Run a UI call; a stale ctx (session replaced mid-benchmark) reports false instead of throwing. */
function tryUi(fn: () => void): boolean {
	try {
		fn();
		return true;
	} catch (e) {
		if (isStaleCtxError(e)) return false;
		throw e;
	}
}

function failedSample(error: string): RunSample {
	return { ok: false, error, totalMs: 0, outputTokens: 0, tokensEstimated: false, hiddenReasoningTokens: 0 };
}

/**
 * Run work with a cancel path. In the TUI a bordered loader owns the input
 * area so Esc cancels; elsewhere the work runs under a plain controller.
 * Either way the work's own result (possibly partial) is returned.
 */
async function withCancel<R>(
	ctx: ExtensionCommandContext,
	label: string,
	work: (signal: AbortSignal) => Promise<R>,
): Promise<R> {
	if (ctx.mode !== "tui") {
		return work(ctx.signal ?? new AbortController().signal);
	}
	let job: Promise<R> | undefined;
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			done(undefined);
		};
		const loader = new BorderedLoader(tui, theme, label);
		loader.onAbort = finish;
		job = work(loader.signal);
		job.then(finish, finish);
		return loader;
	});
	if (!job) throw new Error("speedtest: loader UI closed before the benchmark started");
	// After Esc the loader's signal aborts the in-flight request, so this
	// settles promptly with whatever completed before the cancel.
	return job;
}

async function pickModels(ctx: ExtensionCommandContext): Promise<Model<Api>[]> {
	const available = [...ctx.modelRegistry.getAvailable()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
	const selected = new Set<string>();
	for (;;) {
		const runItem = "▶ Run speed test (" + selected.size + " selected)";
		const items = [runItem, ...available.map((m) => (selected.has(keyOf(m)) ? "☑ " : "☐ ") + keyOf(m))];
		const choice = await ctx.ui.select("Pick models to compare — select to toggle, then Run", items);
		if (choice === undefined) return [];
		if (choice === runItem) {
			if (selected.size > 0) return available.filter((m) => selected.has(keyOf(m)));
			ctx.ui.notify("Select at least one model first.", "warning");
			continue;
		}
		const key = choice.slice(2);
		if (selected.has(key)) selected.delete(key);
		else if (selected.size >= MAX_MODELS) ctx.ui.notify("At most " + MAX_MODELS + " models per comparison.", "warning");
		else selected.add(key);
	}
}

// ── Extension ──────────────────────────────────────────────────

export default function speedTestExtension(pi: ExtensionAPI) {
	// Completion callbacks get no ctx, so keep a snapshot of model keys,
	// refreshed on session start and on every /speedtest invocation.
	let completionKeys: string[] = [];
	const refreshKeys = (ctx: { modelRegistry: { getAvailable(): Model<Api>[] } }) => {
		try {
			completionKeys = ctx.modelRegistry.getAvailable().map(keyOf).sort();
		} catch {
			// Registry not ready or ctx stale — keep the previous snapshot.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		refreshKeys(ctx);
	});

	pi.registerCommand("speedtest", {
		description:
			"Benchmark model TTFT, tok/s, and latency. /speedtest [runs] [model ...] [--thinking <level>] · /speedtest pick",
		getArgumentCompletions: (prefix) => completeModelArgs(prefix, completionKeys),
		handler: async (args, ctx) => {
			const parsed = parseSpeedtestArgs(args ?? "");
			if (parsed.error) {
				ctx.ui.notify(parsed.error + "\n" + USAGE, "error");
				return;
			}
			refreshKeys(ctx);

			let models: Model<Api>[];
			if (parsed.pick) {
				if (!ctx.hasUI) {
					ctx.ui.notify("/speedtest pick needs an interactive UI; pass model ids instead.", "error");
					return;
				}
				models = await pickModels(ctx);
				if (models.length === 0) return;
			} else if (parsed.refs.length > 0) {
				const { models: resolved, errors } = resolveModelRefs(
					parsed.refs,
					ctx.modelRegistry.getAvailable(),
					ctx.modelRegistry.getAll(),
				);
				if (errors.length > 0) {
					ctx.ui.notify("Speed test: " + errors.join("\n"), "error");
					return;
				}
				models = resolved;
			} else if (ctx.model) {
				models = [ctx.model];
			} else {
				ctx.ui.notify("No active model. Use /model to select one, or pass model ids.", "error");
				return;
			}
			if (models.length > MAX_MODELS) {
				ctx.ui.notify("At most " + MAX_MODELS + " models per comparison (got " + models.length + ").", "error");
				return;
			}

			// Capture the registry once: if the session is replaced mid-run, the
			// old ctx throws on access, but the requests themselves stay valid.
			const registry = ctx.modelRegistry;
			const runs = parsed.runs;
			const reasoning = parsed.thinking as ModelsSimpleStreamOptions["reasoning"];
			const what = models.length === 1 ? keyOf(models[0]!) : models.length + " models";
			const label = "Speed test: " + what + " · " + runs + " run" + (runs > 1 ? "s" : "") + " — Esc to cancel";

			let stale = false;
			const outcome = await withStatusChip(ctx, STATUS_KEY, () =>
				withCancel(ctx, label, async (userSignal) => {
					const staleAbort = new AbortController();
					const signal = AbortSignal.any([userSignal, staleAbort.signal]);
					return runBenchmark({
						models,
						runs,
						signal,
						onProgress: (p) => {
							const where = p.phase === "warmup" ? "warming up" : "run " + p.run + "/" + runs;
							const text = "⏱ " + (models.length > 1 ? keyOf(p.model) + " · " : "") + where;
							if (!tryUi(() => ctx.ui.setStatus(STATUS_KEY, text))) {
								stale = true;
								staleAbort.abort();
							}
						},
						request: async (model, phase) => {
							const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
							const requestSignal = AbortSignal.any([signal, timeout]);
							const context: Context = {
								messages: [
									{ role: "user", content: phase === "warmup" ? WARMUP_PROMPT : TEST_PROMPT, timestamp: Date.now() },
								],
							};
							const start = performance.now();
							try {
								const stream = registry.streamSimple(model, context, {
									maxTokens: MAX_TOKENS,
									signal: requestSignal,
									// Every run must pay full prompt processing; no cache reuse between runs.
									cacheRetention: "none",
									...(reasoning ? { reasoning } : {}),
								});
								const sample = await measureStream(stream, { start });
								// A provider may settle a timed-out request as a truncated
								// "done"; never let that pass as a valid measurement.
								if (timeout.aborted && !signal.aborted) {
									return failedSample("timed out after " + REQUEST_TIMEOUT_MS / 1000 + " s");
								}
								return sample;
							} catch (e) {
								return failedSample(errorText(e));
							}
						},
					});
				}),
			).catch((e: unknown) => {
				if (isStaleCtxError(e)) {
					stale = true;
					return undefined;
				}
				throw e;
			});
			if (stale || !outcome) return;

			const { results, aborted } = outcome;
			const anySamples = results.some((r) => r.samples.length > 0);
			let text: string;
			if (aborted && !anySamples) {
				text = "Speed test cancelled.";
			} else {
				const body =
					results.length === 1 ? formatSingle(results[0]!, { runs, thinking: parsed.thinking }) : formatComparison(results, { runs, thinking: parsed.thinking });
				text = aborted ? "Speed test cancelled — partial results:\n" + body : body;
			}
			const failedAll = results.every((r) => r.samples.length === 0);
			tryUi(() => ctx.ui.notify(text, failedAll && !aborted ? "error" : "info"));
		},
	});
}
