/**
 * circuit-breaker — Stops compaction thrash loops.
 *
 * If compaction fires N times within M minutes, blocks further compaction
 * and warns the user. Prevents infinite compact→refill→compact cycles.
 *
 * /circuit-breaker — configure max compactions, window, and toggle.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

const TOY_KEY = "circuitBreaker";

interface Config {
	maxCompactions: number;
	windowMinutes: number;
	enabled: boolean;
}

function loadConfig(): Config {
	const raw = loadToyConfig<Partial<Config>>(TOY_KEY);
	return {
		maxCompactions: raw?.maxCompactions ?? 3,
		windowMinutes: raw?.windowMinutes ?? 5,
		enabled: raw?.enabled ?? true,
	};
}

function saveConfig(config: Config): void {
	saveToyConfig(TOY_KEY, config);
}

export default function circuitBreaker(pi: ExtensionAPI) {
	const compactionTimestamps: number[] = [];

	pi.on("session_before_compact", async (_event, ctx) => {
		const config = loadConfig();
		if (!config.enabled) return;

		const now = Date.now();
		const windowMs = config.windowMinutes * 60_000;

		// Prune old timestamps outside the window
		while (compactionTimestamps.length > 0 && now - compactionTimestamps[0] > windowMs) {
			compactionTimestamps.shift();
		}

		if (compactionTimestamps.length >= config.maxCompactions) {
			ctx.ui.notify(
				`⚡ Circuit breaker tripped: ${compactionTimestamps.length} compactions in ${config.windowMinutes} min. ` +
				`Context is thrashing — consider reducing system prompt size or starting a new session. ` +
				`Run /circuit-breaker to adjust.`,
				"error",
			);
			return { cancel: true };
		}

		// Record this compaction attempt
		compactionTimestamps.push(now);
	});

	pi.registerCommand("circuit-breaker", {
		description: "Configure the compaction circuit breaker",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			const statusLabel = config.enabled ? "ON" : "OFF";

			const action = await ctx.ui.select(
				`Circuit breaker (${statusLabel}, max ${config.maxCompactions} in ${config.windowMinutes} min)`,
				[
					`Toggle (currently: ${statusLabel})`,
					`Max compactions (currently: ${config.maxCompactions})`,
					`Window (currently: ${config.windowMinutes} min)`,
					`Reset — clear trip counter`,
				],
			);
			if (action === undefined) return;

			if (action.startsWith("Toggle")) {
				config.enabled = !config.enabled;
				saveConfig(config);
				ctx.ui.notify(`Circuit breaker: ${config.enabled ? "ON" : "OFF"}`, "info");
			} else if (action.startsWith("Max")) {
				const val = await ctx.ui.select("Max compactions before tripping", ["2", "3", "5", "8", "10"]);
				if (val === undefined) return;
				config.maxCompactions = parseInt(val, 10);
				saveConfig(config);
				ctx.ui.notify(`Max compactions set to ${config.maxCompactions}`, "info");
			} else if (action.startsWith("Window")) {
				const val = await ctx.ui.select("Window (minutes)", ["2", "3", "5", "10", "15", "30"]);
				if (val === undefined) return;
				config.windowMinutes = parseInt(val, 10);
				saveConfig(config);
				ctx.ui.notify(`Window set to ${config.windowMinutes} min`, "info");
			} else if (action.startsWith("Reset")) {
				compactionTimestamps.length = 0;
				ctx.ui.notify("Trip counter cleared", "info");
			}
		},
	});
}
