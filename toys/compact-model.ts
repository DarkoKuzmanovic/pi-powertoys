/**
 * compact-model — Offload context compaction to a different model.
 *
 * Lets you pick any available model for summarization instead of burning
 * tokens on your primary conversation model. Ideal for fast, cheap models
 * with large context windows (e.g. Qwen3.5 on Wafer, Gemini Flash, etc.)
 *
 * Commands:
 *   /compact-model — show current model, pick a new one, or disable
 *
 * Config stored in ~/.pi/agent/toys.json under the "compactModel" key.
 */

import { loadToyConfig, saveToyConfig, removeToyConfig } from "./toys-config.ts";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

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

			// Build option list: disable + each available model
			const options = [
				"⊘  Disable (use active model)",
				...available.map((m) => {
					const marker = (current?.provider === m.provider && current?.model === m.id) ? " ✓" : "";
					return `${m.provider}/${m.id}${marker}`;
				}),
			];

			const choice = await ctx.ui.select(
				`Compaction model (current: ${currentLabel})`,
				options,
			);

			if (choice === undefined) return; // cancelled

			if (choice.startsWith("⊘")) {
				saveConfig(null);
				ctx.ui.notify("Compaction model: disabled — will use active model", "info");
				return;
			}

			// Strip the ✓ marker if present
			const clean = choice.replace(/ ✓$/, "");
			const slashIdx = clean.indexOf("/");
			if (slashIdx === -1) return;

			const provider = clean.slice(0, slashIdx);
			const model = clean.slice(slashIdx + 1);

			saveConfig({ provider, model });
			ctx.ui.notify(`Compaction model: ${provider}/${model}`, "info");
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
			`Compacting ${allMessages.length} messages (${tokensBefore.toLocaleString()} tokens) via ${model.id}…`,
			"info",
		);

		const conversationText = serializeConversation(convertToLlm(allMessages));

		const previousContext = previousSummary
			? `\n\nPrevious session summary for context:\n${previousSummary}`
			: "";

		const summaryMessages = [
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

		try {
			const response = await complete(model, { messages: summaryMessages }, {
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 8192,
				signal,
			});

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			if (!summary.trim()) {
				if (!signal.aborted) {
					ctx.ui.notify("compact-model: empty summary, using default", "warning");
				}
				return;
			}

			const estimatedAfter = Math.round(summary.length / 4);
			const savings = Math.round((1 - estimatedAfter / tokensBefore) * 100);
			ctx.ui.notify(`Compacted via ${model.id}: ${tokensBefore.toLocaleString()} → ~${estimatedAfter.toLocaleString()} tokens (~${savings}% saved) ✓`, "info");

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!signal.aborted) {
				ctx.ui.notify(`compact-model failed: ${message}`, "error");
			}
			return;
		}
	});
}
