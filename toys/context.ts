/**
 * context — Visual context usage breakdown.
 *
 * /context — shows a colored dot grid representing token allocation,
 *            category breakdown with percentages, and session stats.
 *
 * Inspired by Claude Code's /context. Goes beyond the HUD footer by
 * showing WHERE your tokens are going.
 */

import {
	estimateTokens,
	buildSessionContext,
	DynamicBorder,
	type CompactionEntry,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

// ── Formatting ──────────────────────────────────────────────────────

function fmtK(n: number): string {
	if (n >= 100_000) return `${(n / 1000).toFixed(0)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return `${n}`;
}

// ── Category definition ─────────────────────────────────────────────

interface Category {
	label: string;
	tokens: number;
	color: string; // theme color name
	symbol: string;
}

// ── Main extension ──────────────────────────────────────────────────

export default function contextExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show visual context usage breakdown",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const model = ctx.model;

			if (!usage) {
				ctx.ui.notify("No context data yet — send a message first.", "info");
				return;
			}

			const modelName = model?.id ?? "unknown";
			const { tokens: totalTokens, contextWindow, percent } = usage;

			// ── Gather data ─────────────────────────────────────

			const entries = ctx.sessionManager.getBranch();
			const leafId = ctx.sessionManager.getLeafId();
			const sessionContext = buildSessionContext(entries, leafId);
			const messages = sessionContext.messages;

			const systemPrompt = ctx.getSystemPrompt();
			const systemTokens = Math.ceil(systemPrompt.length / 4);

			let userTokens = 0;
			let userCount = 0;
			let assistantTokens = 0;
			let assistantCount = 0;
			let toolResultTokens = 0;
			let toolResultCount = 0;
			let toolCallCount = 0;
			// Subset of assistant `output` tokens; not all providers report it.
			let reasoningTokens = 0;

			for (const msg of messages) {
				const est = estimateTokens(msg);
				if (msg.role === "user") {
					userTokens += est;
					userCount++;
				} else if (msg.role === "assistant") {
					assistantTokens += est;
					assistantCount++;
					if (Array.isArray(msg.content)) {
						toolCallCount += msg.content.filter(
							(c: any) => c.type === "tool_use",
						).length;
					}
					const reasoning = (msg as any).usage?.reasoning;
					if (typeof reasoning === "number") reasoningTokens += reasoning;
				} else if (msg.role === "toolResult") {
					toolResultTokens += est;
					toolResultCount++;
				}
			}

			const compactions = entries.filter(
				(e): e is CompactionEntry => e.type === "compaction",
			);

			const usedTokens = systemTokens + userTokens + assistantTokens + toolResultTokens;
			const freeTokens = Math.max(0, contextWindow - usedTokens);

			// ── Build categories ────────────────────────────────

			const categories: Category[] = [
				{ label: "System prompt", tokens: systemTokens, color: "accent", symbol: "●" },
				{ label: "User messages", tokens: userTokens, color: "success", symbol: "●" },
				{ label: "Assistant", tokens: assistantTokens, color: "mdLink", symbol: "●" },
				{ label: "Tool results", tokens: toolResultTokens, color: "warning", symbol: "●" },
				{ label: "Free space", tokens: freeTokens, color: "dim", symbol: "○" },
			];

			// ── Build grid (10×10 = 100 cells, each = 1%) ──────

			const cells: { color: string; filled: boolean }[] = [];
			for (const cat of categories) {
				const pct = contextWindow > 0 ? (cat.tokens / contextWindow) * 100 : 0;
				const count = Math.round(pct);
				for (let i = 0; i < count && cells.length < 100; i++) {
					cells.push({ color: cat.color, filled: cat.label !== "Free space" });
				}
			}
			// Fill remaining with free space
			while (cells.length < 100) {
				cells.push({ color: "dim", filled: false });
			}

			// ── Render ──────────────────────────────────────────

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const container = new Container();

				container.addChild(
					new DynamicBorder((s: string) => theme.fg("accent", s)),
				);

				// Title
				container.addChild(
					new Text(
						"  " +
							theme.fg("accent", theme.bold("Context Usage")) +
							theme.fg("dim", `  ${modelName}`),
						0,
						0,
					),
				);
				container.addChild(new Text("", 0, 0)); // spacer

				// Right-side text for grid rows
				const tokensStr = totalTokens !== null ? fmtK(totalTokens) : "—";
				const percentStr = percent !== null ? `${percent.toFixed(0)}%` : "—";
				const rightText: string[] = [
					theme.fg("text", modelName),
					theme.fg("dim", `${tokensStr}/${fmtK(contextWindow)} tokens (${percentStr})`),
					"",
					theme.fg("text", "Estimated usage by category"),
				];

				// Category legend lines
				for (const cat of categories) {
					const pct = contextWindow > 0
						? ((cat.tokens / contextWindow) * 100).toFixed(1)
						: "0.0";
					const dot = theme.fg(cat.color as any, cat.symbol);
					const label = cat.label.padEnd(16);
					rightText.push(
						`${dot} ${theme.fg("text", label)} ${theme.fg("dim", `${fmtK(cat.tokens).padStart(6)} (${pct}%)`)}`,
					);
				}

				// Stats line
				rightText.push("");
				rightText.push(
					theme.fg(
						"dim",
						`Turns: ${userCount} · Tool calls: ${toolCallCount} · Compactions: ${compactions.length}`,
					),
				);

				if (compactions.length > 0) {
					const last = compactions[compactions.length - 1];
					rightText.push(
						theme.fg("dim", `Last compaction saved ~${fmtK(last.tokensBefore)} tokens`),
					);
				}

				if (reasoningTokens > 0) {
					// Diagnostic only — reasoning tokens are billed but typically not
					// resent in later turns, so they're not part of the dot-grid above.
					rightText.push(
						theme.fg("dim", `Reasoning tokens (cumulative): ${fmtK(reasoningTokens)}`),
					);
				}

				// Build grid rows with right-side text
				for (let row = 0; row < 10; row++) {
					const rowCells = cells.slice(row * 10, (row + 1) * 10);
					const gridStr = rowCells
						.map((c) =>
							theme.fg(
								c.color as any,
								c.filled ? "●" : "○",
							),
						)
						.join(" ");

					const right = row < rightText.length ? "   " + rightText[row] : "";
					container.addChild(new Text("  " + gridStr + right, 0, 0));
				}

				// Any remaining right text below the grid
				for (let i = 10; i < rightText.length; i++) {
					container.addChild(new Text("  " + " ".repeat(19) + "   " + rightText[i], 0, 0));
				}

				container.addChild(new Text("", 0, 0)); // spacer

				// Dismiss hint
				container.addChild(
					new Text(
						"  " + theme.fg("dim", "press any key to dismiss"),
						0,
						0,
					),
				);

				container.addChild(
					new DynamicBorder((s: string) => theme.fg("accent", s)),
				);

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: () => {
						done();
					},
				};
			});
		},
	});
}
