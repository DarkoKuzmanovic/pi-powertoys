/**
 * session-recap — Session recap on idle return.
 *
 * /recap — generate a manual recap
 * /recap-config — configure auto-recap behavior
 *
 * Auto-recap injects a "Session Recap" custom message via before_agent_start
 * when the user returns after idleThresholdMinutes of inactivity.
 */

import { loadToyConfig, saveToyConfig } from "./toys-config.ts";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

// --- Config keys in toys.json ---
const COMPACT_MODEL_KEY = "compactModel";
const RECAP_KEY = "recap";

// --- Types ---
interface CompactModelConfig {
	provider: string;
	model: string;
}

interface RecapConfig {
	idleThresholdMinutes: number;
	enabled: boolean;
}

// --- Config helpers ---
function loadCompactModelConfig(): CompactModelConfig | null {
	const raw = loadToyConfig<CompactModelConfig>(COMPACT_MODEL_KEY);
	if (raw?.provider && raw?.model) return raw;
	return null;
}

function loadRecapConfig(): RecapConfig {
	const raw = loadToyConfig<Partial<RecapConfig>>(RECAP_KEY);
	if (!raw) return { idleThresholdMinutes: 30, enabled: true };
	return {
		idleThresholdMinutes: raw.idleThresholdMinutes ?? 30,
		enabled: raw.enabled ?? true,
	};
}

function saveRecapConfig(config: RecapConfig): void {
	saveToyConfig(RECAP_KEY, config);
}

// --- Shared model resolution ---
interface ResolvedModel {
	model: any;
	apiKey: string | undefined;
	headers: Record<string, string> | undefined;
}

async function resolveModel(
	pi: ExtensionAPI,
	ctx: any,
): Promise<{ resolved: ResolvedModel | null; fallbackReason?: string }> {
	const compactConfig = loadCompactModelConfig();
	if (!compactConfig) {
		// Try active model directly
		const active = ctx.model;
		if (!active) return { resolved: null, fallbackReason: "No compact-model config and no active model" };

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(active);
		if (!auth.ok || !auth.apiKey) return { resolved: null, fallbackReason: `Active model auth failed: ${auth.error ?? "no api key"}` };

		return {
			resolved: { model: active, apiKey: auth.apiKey, headers: auth.headers },
			fallbackReason: "No compact-model configured — using active model",
		};
	}

	const model = ctx.modelRegistry.find(compactConfig.provider, compactConfig.model);
	if (!model) {
		// Fall back to active
		const active = ctx.model;
		if (!active) return { resolved: null, fallbackReason: "Compact-model not found and no active model" };

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(active);
		if (!auth.ok || !auth.apiKey) return { resolved: null, fallbackReason: `Active model auth failed: ${auth.error ?? "no api key"}` };

		return {
			resolved: { model: active, apiKey: auth.apiKey, headers: auth.headers },
			fallbackReason: `${compactConfig.provider}/${compactConfig.model} not found — using active model`,
		};
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		// Fall back to active
		const active = ctx.model;
		if (!active) return { resolved: null, fallbackReason: "Compact-model auth failed and no active model" };

		const activeAuth = await ctx.modelRegistry.getApiKeyAndHeaders(active);
		if (!activeAuth.ok || !activeAuth.apiKey) {
			return { resolved: null, fallbackReason: `Both compact-model and active model auth failed` };
		}

		return {
			resolved: { model: active, apiKey: activeAuth.apiKey, headers: activeAuth.headers },
			fallbackReason: `Compact-model auth failed — using active model`,
		};
	}

	return { resolved: { model, apiKey: auth.apiKey, headers: auth.headers } };
}

// --- Recap generation ---
async function generateRecap(
	resolved: ResolvedModel,
	allMessages: any[],
	awayMinutes: number,
	signal?: AbortSignal,
): Promise<string | null> {
	const conversationText = serializeConversation(convertToLlm(allMessages));

	const recapPrompt = [
		{
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: `You are a session recap assistant. The user is returning to this conversation${awayMinutes > 0 ? ` after being away for about ${awayMinutes} minutes` : ""}. Generate a brief recap that answers:

1. What was the user working on? (main goal/task)
2. Where did we leave off? (last action taken, current state)
3. What's pending or next? (open threads, planned next steps)

Be concise — 5-10 lines max. Use bullet points. Focus on actionable context, not history.

<conversation>
${conversationText}
</conversation>`,
				},
			],
			timestamp: Date.now(),
		},
	];

	try {
		const response = await complete(resolved.model, { messages: recapPrompt }, {
			apiKey: resolved.apiKey,
			headers: resolved.headers,
			maxTokens: 2048,
			signal,
		});

		const summary = response.content
			.filter((c: any): c is { type: "text"; text: string } => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");

		if (!summary.trim()) return null;
		return summary;
	} catch {
		return null;
	}
}

// --- Extension ---
export default function sessionRecap(pi: ExtensionAPI) {
	// Anti-thrashing guard
	let lastRecapTimestamp = 0;
	const RE_RECAP_GUARD_MS = 5 * 60 * 1000; // 5 minutes

	// --- Command: /recap ---
	pi.registerCommand("recap", {
		description: "Generate a session recap — where we are, what's in progress, what's next",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getEntries();
			const messageEntries = entries.filter(
				(e: any) => e.type === "message" && e.message,
			);

			if (messageEntries.length < 3) {
				ctx.ui.notify("Not enough conversation to recap (fewer than 3 messages)", "warning");
				return;
			}

			ctx.ui.notify("Generating recap…", "info");

			// Take last 50 messages
			const recent = messageEntries.slice(-50);
			const messages = recent.map((e: any) => e.message);

			const resolved = await resolveModel(pi, ctx);
			if (!resolved.resolved) {
				ctx.ui.notify(
					`Cannot generate recap: ${resolved.fallbackReason}`,
					"error",
				);
				return;
			}

			if (resolved.fallbackReason) {
				ctx.ui.notify(resolved.fallbackReason, "info");
			}

			const recap = await generateRecap(resolved.resolved, messages, 0);
			if (!recap) {
				ctx.ui.notify("Recap generation returned empty — try again", "warning");
				return;
			}

			ctx.ui.notify(`Session Recap\n\n${recap}`, "info");
		},
	});

	// --- Command: /recap-config ---
	pi.registerCommand("recap-config", {
		description: "Configure auto-recap idle threshold and toggle",
		handler: async (_args, ctx) => {
			const config = loadRecapConfig();
			const enabledLabel = config.enabled ? "ON" : "OFF";

			const action = await ctx.ui.select(
				`Auto-recap (currently: ${enabledLabel}, threshold: ${config.idleThresholdMinutes} min)`,
				[
					`Toggle auto-recap (currently: ${enabledLabel})`,
					`Change idle threshold (currently: ${config.idleThresholdMinutes} min)`,
				],
			);

			if (action === undefined) return;

			if (action.startsWith("Toggle")) {
				config.enabled = !config.enabled;
				saveRecapConfig(config);
				const newLabel = config.enabled ? "ON" : "OFF";
				ctx.ui.notify(`Auto-recap: ${newLabel}`, "info");
				return;
			}

			// Change threshold
			const threshold = await ctx.ui.select(
				"Idle threshold (how long before auto-recap triggers)",
				["1 minute", "2 minutes", "5 minutes", "10 minutes", "15 minutes", "30 minutes", "45 minutes", "60 minutes", "90 minutes", "120 minutes"],
			);

			if (threshold === undefined) return;

			const minutes = parseInt(threshold, 10);
			if (isNaN(minutes)) return;

			config.idleThresholdMinutes = minutes;
			saveRecapConfig(config);
			ctx.ui.notify(
				`Idle threshold set to ${minutes} minutes`,
				"info",
			);
		},
	});

	// --- Auto-recap on idle return ---
	pi.on("before_agent_start", async (event, ctx) => {
		const config = loadRecapConfig();
		if (!config.enabled) return;

		// Guard: don't recap within 5 minutes of last recap
		if (Date.now() - lastRecapTimestamp < RE_RECAP_GUARD_MS) return;

		const entries = ctx.sessionManager.getEntries();
		const messageEntries = entries.filter(
			(e: any) => e.type === "message" && e.message,
		);

		if (messageEntries.length < 5) return;

		// Find last message timestamp
		const sorted = [...messageEntries].sort(
			(a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		);
		const lastTimestamp = sorted[0]?.timestamp;
		if (!lastTimestamp) return;

		const lastTime = new Date(lastTimestamp).getTime();
		if (isNaN(lastTime)) return;

		const awayMinutes = Math.round((Date.now() - lastTime) / 60000);
		if (awayMinutes < config.idleThresholdMinutes) return;

		ctx.ui.notify(
			`Auto-recap: returning after ${awayMinutes} min — generating recap…`,
			"info",
		);

		// Get recent messages
		const messages = sorted.slice(0, 50).reverse().map((e: any) => e.message);

		const resolved = await resolveModel(pi, ctx);
		if (!resolved.resolved) {
			ctx.ui.notify(
				`Auto-recap skipped: ${resolved.fallbackReason}`,
				"warning",
			);
			return;
		}

		const recap = await generateRecap(resolved.resolved, messages, awayMinutes);
		if (!recap) {
			ctx.ui.notify("Auto-recap generated empty summary", "warning");
			return;
		}

		lastRecapTimestamp = Date.now();
		ctx.ui.notify(`Recap ready (away ${awayMinutes} min) ✓`, "info");

		return {
			message: {
				customType: "session-recap",
				content: `Session Recap (away ${awayMinutes} min):\n\n${recap}`,
				display: true,
			},
		};
	});
}