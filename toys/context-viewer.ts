/**
 * context-viewer — Inspect what the LLM actually sees.
 *
 *   /system-prompt-data  — full system prompt in a scrollable overlay
 *   /total-context-data  — system prompt + every message + usage stats
 *
 * Both overlays support:
 *   - Line numbers
 *   - Arrow / Page / Home / End / j/k/g/G / Ctrl-D / Ctrl-U scrolling
 *   - `/` live search, n/N navigation, current match highlighted
 *   - `y` copy raw text to clipboard
 *   - `Esc` / `q` close
 *
 * Adapted from @agnishc/edb-context-viewer with the following changes:
 *   - Single-file (overlay class + commands merged).
 *   - Tool-call argument JSON is truncated past TOOLCALL_ARGS_MAX (2000
 *     chars) to keep `/total-context-data` searchable on huge sessions —
 *     full text still exists in the real context, only the viewer trims.
 *   - Footer help line stays inside the border on narrow terminals (was:
 *     could overflow when stats prefix was long).
 */

import {
	buildSessionContext,
	type ContextUsage,
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Constants ─────────────────────────────────────────────

const DEFAULT_VISIBLE_LINES = 30;
const TOOLCALL_ARGS_MAX = 2000; // truncate massive tool-call arg dumps for search performance

// ── Helpers ───────────────────────────────────────────────

function buildNumberedLines(text: string, theme: Theme): string[] {
	const rawLines = text.split("\n");
	const numWidth = String(rawLines.length).length;
	return rawLines.map((line, i) => {
		const num = String(i + 1).padStart(numWidth, " ");
		return `${theme.fg("dim", num)} ${theme.fg("dim", "│")} ${line}`;
	});
}

function truncateMaybe(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}… [+${s.length - max} chars]`;
}

// biome-ignore lint/suspicious/noExplicitAny: SessionEntry message-block shape is loose.
function formatContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const lines: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			lines.push(String(block));
			continue;
		}
		// biome-ignore lint/suspicious/noExplicitAny: untyped block.
		const b = block as any;
		switch (b.type) {
			case "text":
				lines.push(b.text ?? "");
				break;
			case "thinking":
				lines.push(`[Thinking: ${b.thinking ?? ""}]`);
				break;
			case "toolCall": {
				const args = JSON.stringify(b.arguments ?? {});
				lines.push(`[Tool Call: ${b.name}(${truncateMaybe(args, TOOLCALL_ARGS_MAX)})]`);
				break;
			}
			case "image": {
				const label = b.mimeType ?? b.source?.type ?? "unknown";
				lines.push(`[Image: ${label}]`);
				break;
			}
			default:
				lines.push(`[${b.type ?? "unknown"}]`);
		}
	}
	return lines;
}

// biome-ignore lint/suspicious/noExplicitAny: usage shape is loose.
function formatUsage(usage: any): string | undefined {
	if (!usage) return undefined;
	const parts: string[] = [];
	if (usage.input != null) parts.push(`input: ${usage.input}`);
	if (usage.output != null) parts.push(`output: ${usage.output}`);
	if (usage.cacheRead != null) parts.push(`cache-read: ${usage.cacheRead}`);
	if (usage.cacheWrite != null) parts.push(`cache-write: ${usage.cacheWrite}`);
	if (usage.totalTokens != null) parts.push(`total: ${usage.totalTokens}`);
	return parts.length > 0 ? `Tokens: ${parts.join(", ")}` : undefined;
}

function formatMessageForDisplay(message: SessionContext["messages"][number], index: number): string[] {
	// biome-ignore lint/suspicious/noExplicitAny: message-entry shape is union, untyped.
	const msg = message as any;
	const lines: string[] = ["", `──── Message ${index + 1} ────`, `Role: ${msg.role ?? "unknown"}`];

	if (msg.role === "assistant") {
		if (msg.provider || msg.model) {
			lines.push(`Model: ${[msg.provider, msg.model].filter(Boolean).join("/")}`);
		}
		const usage = formatUsage(msg.usage);
		if (usage) lines.push(usage);
		if (msg.stopReason) lines.push(`Stop: ${msg.stopReason}`);
		if (msg.errorMessage) lines.push(`Error: ${msg.errorMessage}`);
	}

	if (msg.role === "toolResult") {
		lines.push(`Tool: ${msg.toolName ?? "unknown"}`);
		lines.push(`Tool Call ID: ${msg.toolCallId ?? "unknown"}`);
		lines.push(`Error: ${msg.isError ? "yes" : "no"}`);
	}

	lines.push(...formatContent(msg.content));
	return lines;
}

interface ModelInfo {
	provider: string;
	id: string;
	contextWindow?: number;
}

function buildTotalContextText(
	systemPrompt: string,
	context: SessionContext,
	usage: ContextUsage | undefined,
	model: ModelInfo | undefined,
): string {
	const sep = "═══════════════════════════════════════════════════════";
	const sections: string[] = [];

	sections.push(sep, "SYSTEM PROMPT", sep, systemPrompt, "");

	sections.push(sep, "MESSAGES", sep);
	if (context.messages.length > 0) {
		for (let i = 0; i < context.messages.length; i++) {
			sections.push(...formatMessageForDisplay(context.messages[i] as SessionContext["messages"][number], i));
		}
	} else {
		sections.push("(no messages yet)");
	}

	sections.push("", sep, "CONTEXT USAGE", sep);
	if (usage) {
		sections.push(`Tokens: ${usage.tokens?.toLocaleString() ?? "unknown"}`);
		if (model) {
			sections.push(`Model: ${model.provider}/${model.id}`);
			const contextWindow = model.contextWindow ?? usage.contextWindow;
			if (contextWindow) {
				const pct = usage.percent ?? (usage.tokens == null ? null : (usage.tokens / contextWindow) * 100);
				sections.push(
					`Context Window: ${usage.tokens?.toLocaleString() ?? "unknown"} / ${contextWindow.toLocaleString()} (${
						pct == null ? "unknown" : `${pct.toFixed(1)}%`
					})`,
				);
			}
		}
	} else {
		sections.push("(no usage data available)");
	}

	return sections.join("\n");
}

// ── Scrollable overlay ────────────────────────────────────

interface ScrollableOverlayOptions {
	title: string;
	subtitle: string;
	rawText: string;
	displayLines: string[];
	theme: Theme;
	done: () => void;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TUI input + render are inherently branchy.
function createScrollableOverlay(opts: ScrollableOverlayOptions): Component {
	let scrollOffset = 0;
	let visibleLines = DEFAULT_VISIBLE_LINES;

	// Search state
	let searchMode = false;
	let searchQuery = "";
	let searchMatches: number[] = [];
	let currentMatchIndex = -1;
	let copyFlash = false;

	function maxScroll(): number {
		return Math.max(0, opts.displayLines.length - visibleLines);
	}

	function scrollDown(amount: number): void {
		scrollOffset = Math.min(scrollOffset + amount, maxScroll());
	}
	function scrollUp(amount: number): void {
		scrollOffset = Math.max(0, scrollOffset - amount);
	}
	function scrollToBottom(): void {
		scrollOffset = maxScroll();
	}

	function findMatches(): void {
		const query = searchQuery.toLowerCase();
		const rawLines = opts.rawText.split("\n");
		searchMatches = [];
		if (query.length === 0) {
			currentMatchIndex = -1;
			return;
		}
		for (let i = 0; i < rawLines.length; i++) {
			if ((rawLines[i] ?? "").toLowerCase().includes(query)) {
				searchMatches.push(i);
			}
		}
	}

	function scrollToMatch(): void {
		if (currentMatchIndex < 0 || currentMatchIndex >= searchMatches.length) return;
		const targetLine = searchMatches[currentMatchIndex] as number;
		if (targetLine < scrollOffset || targetLine >= scrollOffset + visibleLines) {
			scrollOffset = Math.max(0, targetLine - Math.floor(visibleLines / 3));
		}
	}

	function nextMatch(): void {
		if (searchMatches.length === 0) return;
		currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
		scrollToMatch();
	}

	function prevMatch(): void {
		if (searchMatches.length === 0) return;
		currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
		scrollToMatch();
	}

	async function doCopy(): Promise<void> {
		copyFlash = true;
		try {
			await copyToClipboard(opts.rawText);
		} catch {
			// Clipboard tool unavailable — silently ignore.
		}
		setTimeout(() => {
			copyFlash = false;
		}, 1500);
	}

	return {
		render(width: number): string[] {
			const th = opts.theme;
			const innerW = width - 2;
			const lines: string[] = [];

			const pad = (s: string, len: number) => {
				const vis = visibleWidth(s);
				return s + " ".repeat(Math.max(0, len - vis));
			};
			const row = (content: string) =>
				th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");
			const borderTop = th.fg("border", `╭${"─".repeat(innerW)}╮`);
			const borderSep = th.fg("border", `├${"─".repeat(innerW)}┤`);
			const borderBottom = th.fg("border", `╰${"─".repeat(innerW)}╯`);

			// ── Title ──
			const title = ` ${th.fg("accent", th.bold(opts.title))}  ${th.fg("dim", `(${opts.subtitle})`)}`;
			lines.push(borderTop, row(title));

			// ── Search bar / separator ──
			if (searchMode) {
				const c = ` ${th.fg("accent", "/")} ${searchQuery}${th.fg("dim", "▏")}`;
				lines.push(row(c));
			} else if (searchMatches.length > 0) {
				const c = ` ${th.fg("accent", "/")} ${th.fg("text", searchQuery)} ${th.fg("dim", "—")} ${th.fg(
					"accent",
					`${currentMatchIndex + 1}/${searchMatches.length}`,
				)}`;
				lines.push(row(c));
			} else {
				lines.push(borderSep);
			}

			// ── Content ──
			const ms = maxScroll();
			scrollOffset = Math.max(0, Math.min(scrollOffset, ms));

			for (let i = 0; i < visibleLines; i++) {
				const lineIdx = scrollOffset + i;
				if (lineIdx < opts.displayLines.length) {
					let line = opts.displayLines[lineIdx] as string;
					const isCurrent =
						searchMatches.length > 0 &&
						currentMatchIndex >= 0 &&
						searchMatches[currentMatchIndex] === lineIdx;
					const isOther = searchMatches.length > 0 && searchMatches.includes(lineIdx) && !isCurrent;
					if (isCurrent) {
						line = th.bg("selectedBg", truncateToWidth(line, innerW));
					} else if (isOther) {
						line = th.fg("warning", truncateToWidth(line, innerW));
					} else {
						line = truncateToWidth(line, innerW);
					}
					lines.push(row(line));
				} else {
					lines.push(row(th.fg("dim", "~")));
				}
			}

			// ── Footer ──
			lines.push(borderSep);

			const scrollPercent =
				opts.displayLines.length <= visibleLines
					? "All"
					: scrollOffset === 0
						? "Top"
						: scrollOffset >= ms
							? "Bot"
							: `${Math.round(((scrollOffset + visibleLines) / opts.displayLines.length) * 100)}%`;

			const statsRaw = ` ${scrollOffset + 1}-${Math.min(
				scrollOffset + visibleLines,
				opts.displayLines.length,
			)} of ${opts.displayLines.length} [${scrollPercent}] `;
			const stats = th.fg("dim", statsRaw);
			const flash = copyFlash ? th.fg("success", "✓ Copied! ") : "";
			const help = th.fg("dim", "↑↓ scroll · / search · n/N next · y copy · q close");

			// Truncate help if it would overflow narrow terminals.
			const usedWidth = visibleWidth(statsRaw) + visibleWidth(copyFlash ? "✓ Copied! " : "");
			const helpWidth = Math.max(0, innerW - usedWidth);
			const helpDisplay = visibleWidth(help) > helpWidth ? truncateToWidth(help, helpWidth) : help;

			lines.push(row(stats + flash + helpDisplay));
			lines.push(borderBottom);

			return lines;
		},

		handleInput(data: string): void {
			if (searchMode) {
				if (matchesKey(data, Key.escape)) {
					searchMode = false;
					searchQuery = "";
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (searchQuery.length > 0) {
						findMatches();
						if (searchMatches.length > 0) {
							currentMatchIndex = 0;
							scrollToMatch();
						}
					}
					searchMode = false;
					return;
				}
				if (matchesKey(data, Key.backspace)) {
					searchQuery = searchQuery.slice(0, -1);
					return;
				}
				if (data.length === 1 && data.charCodeAt(0) >= 32) {
					searchQuery += data;
					findMatches();
					if (searchMatches.length > 0) {
						currentMatchIndex = 0;
						scrollToMatch();
					}
				}
				return;
			}

			if (matchesKey(data, Key.escape) || data === "q") {
				opts.done();
				return;
			}

			if (matchesKey(data, Key.down) || data === "j") {
				scrollDown(1);
			} else if (matchesKey(data, Key.up) || data === "k") {
				scrollUp(1);
			} else if (matchesKey(data, Key.home) || data === "g") {
				scrollOffset = 0;
			} else if (matchesKey(data, Key.end) || data === "G") {
				scrollToBottom();
			} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
				scrollDown(visibleLines - 2);
			} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
				scrollUp(visibleLines - 2);
			} else if (matchesKey(data, Key.ctrl("d"))) {
				scrollDown(Math.floor(visibleLines / 2));
			} else if (matchesKey(data, Key.ctrl("u"))) {
				scrollUp(Math.floor(visibleLines / 2));
			} else if (data === "/") {
				searchMode = true;
				searchQuery = "";
				searchMatches = [];
				currentMatchIndex = -1;
			} else if (data === "n") {
				nextMatch();
			} else if (data === "N") {
				prevMatch();
			} else if (data === "y") {
				void doCopy();
			}
		},

		invalidate(): void {
			// stateless render — no caches to clear
		},
	};
}

// ── Overlay options ───────────────────────────────────────

const OVERLAY_OPTIONS = {
	overlay: true as const,
	overlayOptions: {
		anchor: "center" as const,
		width: "90%" as const,
		minWidth: 60,
		maxHeight: "80%" as const,
	},
};

// ── Extension ─────────────────────────────────────────────

export default function contextViewerExtension(pi: ExtensionAPI): void {
	pi.registerCommand("system-prompt-data", {
		description: "Show the full system prompt in a scrollable popup",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const systemPrompt = ctx.getSystemPrompt();
			if (!systemPrompt) {
				ctx.ui.notify("No system prompt available yet. Send a message first.", "warning");
				return;
			}

			const lineCount = systemPrompt.split("\n").length;
			const charCount = systemPrompt.length;

			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) =>
					createScrollableOverlay({
						title: "System Prompt",
						subtitle: `${charCount.toLocaleString()} chars · ${lineCount} lines`,
						rawText: systemPrompt,
						displayLines: buildNumberedLines(systemPrompt, theme),
						theme,
						done,
					}),
				OVERLAY_OPTIONS,
			);
		},
	});

	pi.registerCommand("total-context-data", {
		description: "Show the complete LLM context (system prompt + all messages + usage)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const systemPrompt = ctx.getSystemPrompt() ?? "";
			const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			const fullText = buildTotalContextText(systemPrompt, context, ctx.getContextUsage(), ctx.model);

			await ctx.ui.custom<void>(
				(_tui, theme, _kb, done) =>
					createScrollableOverlay({
						title: "Total Context Data",
						subtitle: `${fullText.length.toLocaleString()} chars · ${fullText.split("\n").length} lines`,
						rawText: fullText,
						displayLines: buildNumberedLines(fullText, theme),
						theme,
						done,
					}),
				OVERLAY_OPTIONS,
			);
		},
	});
}
