/**
 * Ultrathink Extension — sets an "ultrathink" status that pi-hud renders as
 * a rainbow chip in the footer (line 1, next to the model chip).
 *
 * Detects "ultrathink" AS YOU TYPE in the editor and toggles the status.
 * Also exposes a manual toggle via /ultrathink and alt+u.
 *
 * Rendering moved to pi-hud (render/format.ts:rainbowChip) so we no longer
 * own a widget or run a 50ms animation timer. Status changes auto-trigger
 * a TUI re-render via ctx.ui.setStatus().
 *
 * Source (original animated widget version):
 *   https://github.com/hjanuschka/shitty-extensions/blob/main/extensions/ultrathink.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "ultrathink";
const STATUS_TEXT = "ultrathink";

export default function (pi: ExtensionAPI) {
	let editorWatchInterval: ReturnType<typeof setInterval> | null = null;
	let isShowingRainbow = false;
	let manualMode = false; // When true, don't auto-disable based on editor text
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let currentCtx: any = null;

	// Show ultrathink status (pi-hud picks it up and renders the rainbow chip)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function showUltrathink(ctx: any) {
		if (isShowingRainbow) return;
		currentCtx = ctx;
		isShowingRainbow = true;
		ctx.ui.setStatus(STATUS_KEY, STATUS_TEXT);
	}

	// Hide ultrathink status
	function hideUltrathink() {
		if (currentCtx) {
			currentCtx.ui.setStatus(STATUS_KEY, undefined);
		}
		isShowingRainbow = false;
	}

	// Start watching editor for "ultrathink"
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function startEditorWatch(ctx: any) {
		if (editorWatchInterval) return;
		currentCtx = ctx;

		// Poll editor text frequently to detect typing
		editorWatchInterval = setInterval(() => {
			try {
				const text = ctx.ui.getEditorText?.() || "";
				const hasUltrathink = text.toLowerCase().includes("ultrathink");
				if (hasUltrathink && !isShowingRainbow) {
					manualMode = false; // Auto-detected, not manual
					showUltrathink(ctx);
				} else if (!hasUltrathink && isShowingRainbow && !manualMode) {
					// Only auto-disable if not in manual mode
					hideUltrathink();
				}
			} catch {
				// Ignore errors if UI not available
			}
		}, 200); // 200ms is responsive enough for typed detection without burning CPU
	}

	// Stop watching editor
	function stopEditorWatch() {
		if (editorWatchInterval) {
			clearInterval(editorWatchInterval);
			editorWatchInterval = null;
		}
		manualMode = false;
		hideUltrathink();
	}

	// Start watching when session starts
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			startEditorWatch(ctx);
		}
	});

	// Inject thinking instructions when prompt is sent
	pi.on("before_agent_start", async (event, ctx) => {
		void ctx;
		const prompt = event.prompt?.toLowerCase() || "";
		if (prompt.includes("ultrathink")) {
			return {
				systemPrompt: `${event.systemPrompt}\n\nThe user has requested ULTRATHINK mode. This means:\n- Think EXTREMELY deeply about the problem\n- Consider multiple approaches and their tradeoffs\n- Be extra thorough in your analysis\n- Take your time to reason through complex aspects\n- Provide comprehensive, well-thought-out responses\n`,
			};
		}
	});

	// Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		stopEditorWatch();
	});


	// Manual toggle command
	pi.registerCommand("ultrathink", {
		description: "Toggle ultrathink rainbow mode",
		handler: async (_args, ctx) => {
			if (isShowingRainbow && manualMode) {
				manualMode = false;
				hideUltrathink();
				ctx.ui.notify("Ultrathink disabled", "info");
			} else {
				manualMode = true;
				showUltrathink(ctx);
				// Append "ultrathink" to current editor text if not already there
				const currentText = ctx.ui.getEditorText?.() || "";
				if (!currentText.toLowerCase().includes("ultrathink")) {
					ctx.ui.setEditorText(currentText ? `${currentText}\n\nULTRATHINK` : "ULTRATHINK");
				}
				ctx.ui.notify("Ultrathink enabled - will be added to prompt", "info");
			}
		},
	});

	// Keyboard shortcut (alt+u — ctrl+u is taken by tui.editor.deleteToLineStart + app.tree.filter.userOnly)
	pi.registerShortcut("alt+u", {
		description: "Toggle ultrathink mode",
		handler: async (ctx) => {
			if (isShowingRainbow && manualMode) {
				manualMode = false;
				hideUltrathink();
				ctx.ui.notify("Ultrathink disabled", "info");
			} else {
				manualMode = true;
				showUltrathink(ctx);
				// Append "ULTRATHINK" to current editor text if not already there
				const currentText = ctx.ui.getEditorText?.() || "";
				if (!currentText.toLowerCase().includes("ultrathink")) {
					ctx.ui.setEditorText(currentText ? `${currentText}\n\nULTRATHINK` : "ULTRATHINK");
				}
				ctx.ui.notify("Ultrathink enabled - will be added to prompt", "info");
			}
		},
	});
}
