/**
 * crof-models — Browse Crof AI model pricing sorted by speed.
 *
 * /crof                  — show all models sorted by t/s
 * /crof --vision         — show only vision models
 * /crof --quant Q8_0     — filter by quantization substring
 * /crof --min-speed 50   — show only models ≥ 50 t/s
 *
 * Scrapes https://crof.ai/pricing via Jina Reader, caches for 10 min.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

// ── Config ──────────────────────────────────────────────────────────

const TOY_KEY = "crofModels";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const JINA_URL = "https://r.jina.ai/https://crof.ai/pricing";
const FETCH_TIMEOUT_MS = 15_000;

// ── Types ───────────────────────────────────────────────────────────

interface CrofModel {
	name: string;
	quant: string;
	maxOutput: string;
	vision: boolean;
	reqMultiplier: string;
	speedTps: number;
}

interface CacheEntry {
	timestamp: number;
	models: CrofModel[];
}

interface ParsedArgs {
	vision: boolean;
	quant: string;
	minSpeed: number;
}

// ── Main extension ──────────────────────────────────────────────────

export default function crofModelsExtension(pi: ExtensionAPI) {
	pi.registerCommand("crof", {
		description:
			"Show Crof AI models sorted by speed. Flags: --vision, --quant <substr>, --min-speed <N>",
		handler: async (args, ctx) => {
			const flags = parseArgs(args ?? "");

			let models: CrofModel[];
			let cacheAgeMin: number | null = null;

			// ── Check cache ───────────────────────────────────────
			const cached = loadToyConfig<CacheEntry>(TOY_KEY);
			if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
				models = cached.models;
				cacheAgeMin = Math.round((Date.now() - cached.timestamp) / 60_000);
			} else {
				// ── Fetch fresh ────────────────────────────────────
				ctx.ui.notify("Fetching Crof AI pricing…", "info");

				let text: string;
				try {
					const controller = new AbortController();
					const timeout = setTimeout(
						() => controller.abort(),
						FETCH_TIMEOUT_MS,
					);

					const resp = await fetch(JINA_URL, {
						signal: controller.signal,
						headers: { Accept: "text/plain" },
					});
					clearTimeout(timeout);

					if (!resp.ok) {
						const msg = `HTTP ${resp.status} from Jina Reader`;
						ctx.ui.notify(
							`Could not fetch pricing: ${msg}. Try again later.`,
							"error",
						);
						return;
					}

					text = await resp.text();
				} catch (err: unknown) {
					const msg =
						err instanceof Error ? err.message : String(err);
					ctx.ui.notify(
						`Could not fetch pricing: ${msg}. Try again later.`,
						"error",
					);
					return;
				}

				models = parseModels(text);

				if (models.length === 0) {
					ctx.ui.notify(
						"Could not parse pricing page — format may have changed.",
						"error",
					);
					return;
				}

				// ── Save cache ─────────────────────────────────────
				saveToyConfig(TOY_KEY, { timestamp: Date.now(), models });
				cacheAgeMin = 0;
			}

			// ── Filter ────────────────────────────────────────────
			let filtered = models;
			if (flags.vision) filtered = filtered.filter((m) => m.vision);
			if (flags.quant)
				filtered = filtered.filter((m) =>
					m.quant.toLowerCase().includes(flags.quant.toLowerCase()),
				);
			if (flags.minSpeed > 0)
				filtered = filtered.filter((m) => m.speedTps >= flags.minSpeed);

			// ── Sort by speed descending ──────────────────────────
			filtered.sort((a, b) => b.speedTps - a.speedTps);

			if (filtered.length === 0) {
				ctx.ui.notify("No models match the given filters.", "info");
				return;
			}

			// ── Render table ───────────────────────────────────────
			const table = renderTable(filtered, cacheAgeMin, flags);
			ctx.ui.notify(table, "info");
		},
	});
}

// ── Argument parsing ────────────────────────────────────────────────

function parseArgs(raw: string): ParsedArgs {
	const tokens = raw.split(/\s+/);
	let vision = false;
	let quant = "";
	let minSpeed = 0;

	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--vision") {
			vision = true;
		} else if (tokens[i] === "--quant" && tokens[i + 1]) {
			quant = tokens[++i]!;
		} else if (tokens[i] === "--min-speed" && tokens[i + 1]) {
			minSpeed = parseFloat(tokens[++i]!) || 0;
		}
	}

	return { vision, quant, minSpeed };
}

// ── Model parsing ───────────────────────────────────────────────────

/**
 * Parse Jina Reader output into CrofModel array.
 *
 * Jina Reader may return each model as:
 *   - A single line: `deepseek-v4-pro Q4_0 1,000,000 / 131,072 $0.30 $0.003 $0.50 ~11 t/s`
 *   - Multiple lines (fields separated by blank lines):
 *     `deepseek-v4-pro\n\nQ4_0 1,000,000 / 131,072\n\n$0.30\n\n...\n\n~11 t/s`
 *
 * Strategy: accumulate non-empty lines into a buffer. When a line contains
 * `~N t/s`, flush the buffer as one model entry.
 */
function parseModels(text: string): CrofModel[] {
	const lines = text.split("\n");
	const entries: string[] = [];
	let buffer: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue; // skip blank lines

		buffer.push(trimmed);

		// A line containing the speed marker ends a model entry
		if (/~\d+(?:\.\d+)?\s*t\/s/.test(trimmed)) {
			entries.push(buffer.join(" "));
			buffer = [];
		}
	}
	// Any remaining buffer without speed marker → ignore (footer, etc.)

	const models: CrofModel[] = [];

	for (const entry of entries) {
		const speedMatch = entry.match(
			/~(\d+(?:\.\d+)?)\s*t\/s\s*$/,
		);
		if (!speedMatch) continue;

		const speedTps = parseFloat(speedMatch[1]!);

		const ctxMatch = entry.match(
			/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/,
		);
		if (!ctxMatch) continue;

		const maxOutput = ctxMatch[2]!.replace(/,/g, "");

		// Vision tag
		const vision = /\bvision\b/i.test(entry);

		// Request multiplier: "2x requests", "0.5x requests", "0.75x requests", "10x requests"
		const reqMatch = entry.match(
			/(\d+(?:\.\d+)?)x\s*requests?/i,
		);
		const reqMultiplier = reqMatch ? `${reqMatch[1]}x` : "";

		// ── Extract name and quant ──────────────────────────────
		// Everything before the context/max-output is "name quant [beta]"
		const beforeCtx = entry.slice(0, ctxMatch.index!).trim();

		// Quant is the last token matching known quant patterns
		// Patterns: Q4_0, Q8_0, Q6_K, Q3_K_L, Q4_K_M, fp8, int4,
		//           530b-int4, awq
		const quantPattern =
			/^(.+?)\s+((?:Q\d_[A-Z0-9_]+|fp\d+|int\d+|[\d.]+b-int\d+|awq))\s*$/i;
		const quantMatch = beforeCtx.match(quantPattern);

		let name: string;
		let quant: string;

		if (quantMatch) {
			name = quantMatch[1]!.trim();
			quant = quantMatch[2]!;
		} else {
			// Fallback: last token is the quant, everything before is name
			const tokens = beforeCtx.split(/\s+/);
			quant = tokens[tokens.length - 1] ?? "";
			name = tokens.slice(0, -1).join(" ") || beforeCtx;
		}

		// Remove trailing "beta" from name if present (it's a status tag)
		name = name.replace(/\s+beta\s*$/i, "");

		models.push({
			name,
			quant,
			maxOutput: formatNumber(parseInt(maxOutput, 10)),
			vision,
			reqMultiplier,
			speedTps,
		});
	}

	return models;
}

// ── Table rendering ─────────────────────────────────────────────────

function renderTable(
	models: CrofModel[],
	cacheAgeMin: number | null,
	flags: ParsedArgs,
): string {
	// Column widths
	const nameW = Math.max(28, ...models.map((m) => m.name.length)) + 1;
	const quantW = 11;
	const maxOutW = 10;
	const visW = 4;
	const reqW = 5;
	const speedW = 9;

	const sep = "─".repeat(nameW) + " " +
		"─".repeat(quantW) + " " +
		"─".repeat(maxOutW) + " " +
		"─".repeat(visW) + " " +
		"─".repeat(reqW) + " " +
		"─".repeat(speedW);

	const header =
		"Name".padEnd(nameW) + " " +
		"Quant".padEnd(quantW) + " " +
		"Max Out".padEnd(maxOutW) + " " +
		"Vis".padEnd(visW) + " " +
		"Req".padEnd(reqW) + " " +
		"Speed".padEnd(speedW);

	const rows = models.map((m) => {
		const vis = m.vision ? "✓" : "—";
		const speed = `~${m.speedTps} t/s`;
		return (
			m.name.padEnd(nameW) + " " +
			m.quant.padEnd(quantW) + " " +
			m.maxOutput.padEnd(maxOutW) + " " +
			vis.padEnd(visW) + " " +
			m.reqMultiplier.padEnd(reqW) + " " +
			speed
		);
	});

	const parts: string[] = [
		"Crof AI Models (sorted by speed)",
		"",
		header,
		sep,
		...rows,
		"",
	];

	// Active filters
	const activeFilters: string[] = [];
	if (flags.vision) activeFilters.push("--vision");
	if (flags.quant) activeFilters.push(`--quant ${flags.quant}`);
	if (flags.minSpeed > 0)
		activeFilters.push(`--min-speed ${flags.minSpeed}`);

	if (activeFilters.length > 0) {
		parts.push(`Filters: ${activeFilters.join("  ")}`);
	}

	parts.push(
		`Flags: --vision  --quant <substr>  --min-speed <N>`,
	);

	if (cacheAgeMin !== null) {
		const cacheLabel =
			cacheAgeMin === 0
				? "fresh"
				: `${CACHE_TTL_MS / 60_000 - cacheAgeMin} min remaining`;
		parts.push(`Cache: ${cacheLabel}`);
	}

	return parts.join("\n");
}

// ── Number formatting ────────────────────────────────────────────────

function formatNumber(n: number): string {
	return n.toLocaleString("en-US");
}
