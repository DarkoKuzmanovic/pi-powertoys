import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withStatusChip } from "./toy-kit.ts";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * startup-benchmark — measure Pi HARNESS STARTUP time (not model latency).
 *
 * The sibling /speedtest toy benchmarks the active model's TPS/TTFT. This one
 * answers a different question the user was bisecting by hand: "how much does
 * booting the harness — loading every extension — actually cost, and which
 * extension is the culprit?"
 *
 * Mechanism: spawn `pi <cfg> --mode rpc` with stdin closed. In rpc mode an EOF
 * on stdin drives the exact same clean shutdown path as an interactive `/exit`
 * (pi's onInputEnd → shutdown → runtimeHost.dispose), so the process boots the
 * full harness and exits WITHOUT ever prompting a model. Wall time from spawn
 * to exit is therefore pure startup + teardown, with no model latency to
 * pollute it. `--offline`/`--no-session` keep each boot hermetic and repeatable.
 *
 *   delta   (default) — floor boot (`pi -ne`, extensions disabled) vs a full
 *                        boot; the difference is the total extension-load cost.
 *   isolate           — floor boot, then each extension alone (`pi -ne -e
 *                        <entry>`); each entry's delta over the floor is its own
 *                        load cost. Reproduces the manual bisect automatically.
 *
 * Every measured config appends a JSONL row (with hostname, so darko-laptop and
 * darko-desktop results can be compared later) to:
 *   ~/.pi/agent/cache/pi-powertoys/startup-benchmark.jsonl
 */

// --- Config ---
const DEFAULT_RUNS = 3;
const MAX_RUNS = 20;
const PER_RUN_TIMEOUT_MS = 45_000; // hard cap per boot — guards against a hung pi
const RESULTS_PATH = join(homedir(), ".pi", "agent", "cache", "pi-powertoys", "startup-benchmark.jsonl");

// --- Types ---
type Mode = "delta" | "isolate";

interface ParsedArgs {
	mode: Mode;
	runs: number;
	entries: string[]; // explicit entry paths (isolate mode); empty → use package default
}

interface Stats {
	runs: number;
	minMs: number;
	medianMs: number;
	meanMs: number;
	maxMs: number;
	stdevMs: number;
}

interface ResultRow {
	ts: string;
	host: string;
	piVersion: string;
	cwd: string;
	mode: Mode;
	label: string;
	configArgs: string[];
	entry: string | null;
	minMs: number;
	medianMs: number;
	meanMs: number;
	maxMs: number;
	stdevMs: number;
	deltaVsFloorMs: number | null;
}

// --- Main ---
export default function startupBenchmarkExtension(pi: ExtensionAPI) {
	pi.registerCommand("startup-benchmark", {
		description:
			"Benchmark harness startup (extension-load cost), not model latency. Usage: /startup-benchmark [N] | /startup-benchmark isolate [N] [entry...]",
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");

			// Verify the pi binary exists up front; also record its version so
			// cross-machine rows stay apples-to-apples.
			let piVersion: string;
			try {
				piVersion = execFileSync("pi", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
			} catch {
				ctx.ui.notify("startup-benchmark: `pi` not found on PATH (or `pi --version` failed) — cannot benchmark.", "error");
				return;
			}

			const cwd = process.cwd();
			const rows: ResultRow[] = [];

			try {
				await withStatusChip(ctx, "startup-benchmark", async () => {
					// One discarded warm-up boot so the first *measured* run doesn't
					// eat cold-FS-cache cost that later spawns won't (median-friendly).
					ctx.ui.setStatus("startup-benchmark", "⏱ Warming up...");
					await timeOneBoot(["-ne"], PER_RUN_TIMEOUT_MS, cwd);

					// Floor: extensions disabled — the no-extensions startup baseline.
					const floor = await measureConfig(["-ne"], parsed.runs, PER_RUN_TIMEOUT_MS, cwd, (i) =>
						ctx.ui.setStatus("startup-benchmark", `⏱ floor (no extensions) — run ${i + 1}/${parsed.runs}...`),
					);
					if (floor.error) {
						ctx.ui.notify(`startup-benchmark: floor boot failed — ${floor.error}`, "error");
						return;
					}
					const floorStats = summarize(floor.samplesMs);
					rows.push(buildRow({ mode: parsed.mode, label: "floor (-ne)", configArgs: ["-ne"], entry: null, stats: floorStats, floorMedianMs: floorStats.medianMs, host: hostname(), piVersion, cwd }));

					if (parsed.mode === "delta") {
						// Full boot: normal extension discovery.
						const full = await measureConfig([], parsed.runs, PER_RUN_TIMEOUT_MS, cwd, (i) =>
							ctx.ui.setStatus("startup-benchmark", `⏱ full boot — run ${i + 1}/${parsed.runs}...`),
						);
						if (full.error) {
							ctx.ui.notify(`startup-benchmark: full boot failed — ${full.error}`, "error");
							return;
						}
						const fullStats = summarize(full.samplesMs);
						rows.push(buildRow({ mode: parsed.mode, label: "full boot", configArgs: [], entry: null, stats: fullStats, floorMedianMs: floorStats.medianMs, host: hostname(), piVersion, cwd }));
					} else {
						// isolate: measure each extension entry on its own.
						const entries = parsed.entries.length > 0
							? parsed.entries.map((e) => resolve(cwd, e))
							: defaultEntries();
						if (entries.length === 0) {
							ctx.ui.notify("startup-benchmark: no extension entries to isolate (pass entry paths, or run from the package so package.json can be read).", "error");
							return;
						}
						for (let idx = 0; idx < entries.length; idx++) {
							const entry = entries[idx]!;
							const label = basename(entry);
							const cfg = ["-ne", "-e", entry];
							const one = await measureConfig(cfg, parsed.runs, PER_RUN_TIMEOUT_MS, cwd, (i) =>
								ctx.ui.setStatus("startup-benchmark", `⏱ isolate ${label} (${idx + 1}/${entries.length}) — run ${i + 1}/${parsed.runs}...`),
							);
							if (one.error) {
								ctx.ui.notify(`startup-benchmark: isolate ${label} failed — ${one.error}`, "error");
								return;
							}
							const st = summarize(one.samplesMs);
							rows.push(buildRow({ mode: parsed.mode, label, configArgs: cfg, entry, stats: st, floorMedianMs: floorStats.medianMs, host: hostname(), piVersion, cwd }));
						}
					}
				});
			} catch (e) {
				if (!isStaleCtxError(e)) throw e;
				return; // session was replaced mid-benchmark — abort silently
			}

			if (rows.length === 0) return;

			let savedTo = "";
			try {
				savedTo = appendRows(rows);
			} catch (e: any) {
				ctx.ui.notify(`startup-benchmark: results computed but could not write JSONL — ${e?.message ?? e}`, "error");
			}

			try {
				ctx.ui.notify(formatSummary(parsed, rows, savedTo), "info");
			} catch (e) {
				if (!isStaleCtxError(e)) throw e;
			}
		},
	});
}

// --- Arg parsing (pure) ---
export function parseArgs(raw: string, defaultRuns = DEFAULT_RUNS, maxRuns = MAX_RUNS): ParsedArgs {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	let mode: Mode = "delta";
	let runs = defaultRuns;
	const entries: string[] = [];
	for (const tok of tokens) {
		const low = tok.toLowerCase();
		if (low === "isolate" || low === "iso" || low === "per-ext") {
			mode = "isolate";
			continue;
		}
		if (low === "delta") {
			mode = "delta";
			continue;
		}
		if (/^\d+$/.test(tok)) {
			runs = clamp(parseInt(tok, 10), 1, maxRuns);
			continue;
		}
		// Anything else is treated as an extension entry path → implies isolate.
		entries.push(tok);
		mode = "isolate";
	}
	return { mode, runs, entries };
}

// --- Aggregation (pure) ---
export function summarize(samplesMs: number[]): Stats {
	if (samplesMs.length === 0) throw new Error("summarize: no samples");
	const s = [...samplesMs].sort((a, b) => a - b);
	const n = s.length;
	const mean = s.reduce((a, b) => a + b, 0) / n;
	const median = n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
	const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
	return {
		runs: n,
		minMs: s[0]!,
		medianMs: median,
		meanMs: mean,
		maxMs: s[n - 1]!,
		stdevMs: Math.sqrt(variance),
	};
}

interface BuildRowParams {
	mode: Mode;
	label: string;
	configArgs: string[];
	entry: string | null;
	stats: Stats;
	floorMedianMs: number | null;
	host: string;
	piVersion: string;
	cwd: string;
}

/** Assemble a JSONL result row. The floor row passes its own median as
 *  floorMedianMs, yielding deltaVsFloorMs === 0 (a harmless, explicit baseline). */
export function buildRow(p: BuildRowParams): ResultRow {
	const delta = p.floorMedianMs === null ? null : round(p.stats.medianMs - p.floorMedianMs);
	return {
		ts: new Date().toISOString(),
		host: p.host,
		piVersion: p.piVersion,
		cwd: p.cwd,
		mode: p.mode,
		label: p.label,
		configArgs: p.configArgs,
		entry: p.entry,
		minMs: round(p.stats.minMs),
		medianMs: round(p.stats.medianMs),
		meanMs: round(p.stats.meanMs),
		maxMs: round(p.stats.maxMs),
		stdevMs: round(p.stats.stdevMs),
		deltaVsFloorMs: delta,
	};
}

// --- Helpers (pure) ---
function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function round(n: number): number {
	return Math.round(n);
}

/** True when e is Pi's "stale ctx" guard firing — session replaced mid-run. */
function isStaleCtxError(e: unknown): boolean {
	return e instanceof Error && /stale after session replacement/.test(e.message);
}

/** Resolve the package's own extension entries (absolute paths) from package.json. */
function defaultEntries(): string[] {
	try {
		const here = dirname(fileURLToPath(import.meta.url)); // .../toys
		const pkgPath = join(here, "..", "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { pi?: { extensions?: unknown } };
		const list = pkg.pi?.extensions;
		if (Array.isArray(list)) {
			return list
				.filter((p): p is string => typeof p === "string")
				.map((p) => resolve(dirname(pkgPath), p));
		}
	} catch {
		// no package.json reachable — caller handles the empty case
	}
	return [];
}

// --- Measurement (impure) ---
interface MeasureResult {
	samplesMs: number[];
	error?: string;
}

async function measureConfig(
	configArgs: string[],
	runs: number,
	perRunTimeoutMs: number,
	cwd: string,
	onProgress?: (runIndex: number) => void,
): Promise<MeasureResult> {
	const samplesMs: number[] = [];
	for (let i = 0; i < runs; i++) {
		onProgress?.(i);
		const r = await timeOneBoot(configArgs, perRunTimeoutMs, cwd);
		if (r.error) return { samplesMs, error: r.error };
		samplesMs.push(r.ms!);
	}
	return { samplesMs };
}

/**
 * Spawn one `pi <cfg> --mode rpc --offline --no-session` with stdin closed and
 * time it from spawn to exit. stdin === /dev/null delivers an immediate EOF,
 * which drives pi's clean rpc shutdown once the harness has finished booting.
 */
function timeOneBoot(
	configArgs: string[],
	timeoutMs: number,
	cwd: string,
): Promise<{ ms?: number; error?: string }> {
	return new Promise((resolveP) => {
		const fullArgs = [...configArgs, "--mode", "rpc", "--offline", "--no-session"];
		const start = performance.now();
		let settled = false;
		let stderr = "";

		let child;
		try {
			child = spawn("pi", fullArgs, { cwd, stdio: ["ignore", "ignore", "pipe"] });
		} catch (e: any) {
			resolveP({ error: `failed to spawn pi: ${e?.message ?? e}` });
			return;
		}

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
			resolveP({ error: `boot timed out after ${timeoutMs}ms (pi ${fullArgs.join(" ")})` });
		}, timeoutMs);

		child.stderr?.on("data", (d: Buffer) => {
			if (stderr.length < 2000) stderr += d.toString();
		});

		child.on("error", (e: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveP({ error: `failed to spawn pi: ${e.message}` });
		});

		child.on("exit", (code: number | null, signal: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				resolveP({ ms: performance.now() - start });
			} else {
				resolveP({ error: `pi exited code=${code} signal=${signal}: ${stderr.slice(0, 300).trim()}` });
			}
		});
	});
}

// --- Output ---
function appendRows(rows: ResultRow[]): string {
	mkdirSync(dirname(RESULTS_PATH), { recursive: true });
	const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
	appendFileSync(RESULTS_PATH, text, "utf8");
	return RESULTS_PATH;
}

function formatSummary(parsed: ParsedArgs, rows: ResultRow[], savedTo: string): string {
	const runLabel = parsed.runs > 1 ? `${parsed.runs} runs, median` : "1 run";
	const lines: string[] = [];

	if (parsed.mode === "delta") {
		const floor = rows.find((r) => r.deltaVsFloorMs === 0 && r.label.startsWith("floor"));
		const full = rows.find((r) => r.label === "full boot");
		const delta = full?.deltaVsFloorMs ?? null;
		lines.push(`⏱ Startup Benchmark — extension-load cost (${runLabel})`);
		if (floor) lines.push(`  Floor (-ne):  ${floor.medianMs} ms`);
		if (full) lines.push(`  Full boot:    ${full.medianMs} ms`);
		if (delta !== null) {
			const rating = delta >= 2000 ? "🔴" : delta >= 500 ? "🟡" : "🟢";
			lines.push(`  ${rating} Extensions add: ${delta} ms`);
		}
	} else {
		const floor = rows.find((r) => r.label.startsWith("floor"));
		lines.push(`⏱ Startup Benchmark — per-extension isolate (${runLabel})`);
		if (floor) lines.push(`  Floor (-ne): ${floor.medianMs} ms`);
		const isolates = rows
			.filter((r) => r.entry !== null)
			.slice()
			.sort((a, b) => (b.deltaVsFloorMs ?? 0) - (a.deltaVsFloorMs ?? 0));
		for (const r of isolates) {
			lines.push(`  +${String(r.deltaVsFloorMs ?? 0).padStart(5)} ms  ${r.label}`);
		}
	}

	if (savedTo) lines.push(`  → ${rows.length} row${rows.length > 1 ? "s" : ""} appended to ${savedTo}`);
	return lines.join("\n");
}
