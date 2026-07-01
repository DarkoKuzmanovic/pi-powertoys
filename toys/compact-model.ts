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
 * Config stored in ~/.pi/agent/cache/pi-powertoys/toys.json under the "compactModel" key.
 */

import { loadToyConfig, saveToyConfig, removeToyConfig } from "./toys-config.ts";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, DynamicBorder, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

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
