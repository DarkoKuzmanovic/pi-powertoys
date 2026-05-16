/**
 * agent-steer — Intercept messages typed while the agent is running.
 *
 * When the user submits a message mid-turn, a compact single-keypress prompt
 * appears. One key acts immediately — no Enter, no dialog stack, no Esc conflict.
 *
 *   s  steer    deliver before the next LLM call (same turn)
 *   q  queue    deliver after the agent fully finishes
 *   d  discard  throw the message away
 *   e  edit     restore the text to the editor (also: Esc)
 *
 * When the agent is idle, messages pass through normally.
 *
 * Slash command:
 *   /steer <text>  — bypass the prompt and steer directly
 *
 * Adapted from @agnishc/edb-agent-steer with the following changes:
 *   - Single-file (closure factory instead of separate class/types/index).
 *   - Multi-line preview: newlines collapsed to ↵ markers so paste renders sanely.
 *   - sendUserMessage wrapped in try/catch with user-visible failure notify.
 *   - Minimal Theme typing (Theme is not publicly exported by pi-coding-agent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ── Types ─────────────────────────────────────────────────────

type SteerChoice = "steer" | "queue" | "discard" | "edit";

/** Minimal slice of the global TUI Theme used here. The full Theme type is internal. */
interface ThemeSlice {
	fg: (role: string, text: string) => string;
}

// ── Component factory ─────────────────────────────────────────

function createSteerPrompt(message: string, theme: ThemeSlice, done: (choice: SteerChoice) => void): Component {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	// Collapse newlines so paste/multi-line previews stay on one row.
	const flat = message.replace(/\r?\n/g, " ↵ ").replace(/\s+/g, " ").trim();

	return {
		handleInput(data: string): void {
			if (matchesKey(data, "s")) done("steer");
			else if (matchesKey(data, "q")) done("queue");
			else if (matchesKey(data, "d")) done("discard");
			else if (matchesKey(data, "e") || matchesKey(data, "escape")) done("edit");
		},

		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const maxMsgW = Math.max(10, width - 8);
			const preview = flat.length > maxMsgW ? `${flat.slice(0, maxMsgW - 1)}…` : flat;

			const key = (k: string, label: string) => `${theme.fg("accent", k)}${theme.fg("dim", ` ${label}`)}`;

			cachedLines = [
				"",
				truncateToWidth(`  ${theme.fg("muted", "↵")}  ${theme.fg("dim", `"${preview}"`)}`, width),
				"",
				truncateToWidth(
					`  ${key("s", "steer")}   ${key("q", "queue")}   ${key("d", "discard")}   ${key("e", "edit")}`,
					width,
				),
				"",
			];
			cachedWidth = width;
			return cachedLines;
		},

		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		},
	};
}

// ── Extension ─────────────────────────────────────────────────

export default function agentSteerExtension(pi: ExtensionAPI): void {
	// Input interceptor — fires for every submitted message.
	pi.on("input", async (event, ctx) => {
		// Only intercept user-typed messages, not extension-injected ones.
		if (event.source !== "interactive") return { action: "continue" };

		// Esc in the editor fires input with text === ""; never block that.
		if (!event.text?.trim()) return { action: "continue" };

		// Agent idle → normal send.
		if (ctx.isIdle()) return { action: "continue" };

		// No interactive UI (print / JSON modes) → can't show prompt, pass through.
		if (!ctx.hasUI) return { action: "continue" };

		const choice = await ctx.ui.custom<SteerChoice>(
			(_tui, theme, _kb, done) => createSteerPrompt(event.text, theme as ThemeSlice, done),
		);

		// edit / Esc / overlay closed by some other path → restore text only.
		if (!choice || choice === "edit") {
			ctx.ui.setEditorText(event.text);
			return { action: "handled" };
		}

		if (choice === "discard") {
			ctx.ui.notify("Message discarded", "info");
			return { action: "handled" };
		}

		const deliver = choice === "steer" ? "steer" : "followUp";
		const okMsg = choice === "steer" ? "◀ Steered — before the next LLM call" : "⏳ Queued — after agent finishes";

		try {
			pi.sendUserMessage(event.text, { deliverAs: deliver });
			ctx.ui.notify(okMsg, "info");
		} catch (err) {
			// sendUserMessage is documented as void but extensions can race the
			// session lifecycle. Surface the failure instead of silently dropping.
			ctx.ui.setEditorText(event.text);
			ctx.ui.notify(`Steer failed: ${(err as Error).message ?? String(err)}`, "error");
		}

		return { action: "handled" };
	});

	// /steer slash command — explicit steer, bypasses the prompt.
	pi.registerCommand("steer", {
		description: "Steer text into the running agent turn (or send normally if idle). Usage: /steer <text>",
		handler: async (args, ctx) => {
			const content = args?.trim();
			if (!content) {
				ctx.ui.notify("/steer <text>  — steer text before the next LLM call", "info");
				return;
			}

			const running = !ctx.isIdle();
			try {
				if (running) {
					pi.sendUserMessage(content, { deliverAs: "steer" });
					ctx.ui.notify("◀ Steered — before the next LLM call", "info");
				} else {
					pi.sendUserMessage(content);
					ctx.ui.notify("Sent", "info");
				}
			} catch (err) {
				ctx.ui.notify(`Steer failed: ${(err as Error).message ?? String(err)}`, "error");
			}
		},
	});
}
