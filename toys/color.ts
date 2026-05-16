/**
 * color — Tag sessions with a color label.
 *
 * /color [name]  — pick a color from a TUI selector, or pass one directly.
 * /color off     — clear the color label.
 *
 * Sets a persistent colored indicator in the footer so you can visually
 * distinguish multiple Pi sessions running in different terminals.
 * The choice is saved in the session and restored on resume.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COLORS: Record<string, string> = {
	red: "🔴",
	orange: "🟠",
	yellow: "🟡",
	green: "🟢",
	blue: "🔵",
	purple: "🟣",
	cyan: "🩵",
};

const COLOR_NAMES = Object.keys(COLORS);

function applyColor(name: string, ctx: { ui: any }) {
	const emoji = COLORS[name];
	if (!emoji) return;
	ctx.ui.setStatus("session-color", `${emoji} ${name}`);
}

function clearColor(ctx: { ui: any }) {
	ctx.ui.setStatus("session-color", undefined);
}

export default function colorExtension(pi: ExtensionAPI) {
	// Restore from session state on start/resume
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === "session-color") {
				const data = entry.data as { color?: string } | undefined;
				if (data?.color && COLORS[data.color]) {
					applyColor(data.color, ctx);
				}
				break;
			}
		}
	});

	pi.registerCommand("color", {
		description: "Set a color label for this session",
		handler: async (args, ctx) => {
			// Direct argument: /color red, /color off
			if (args) {
				const name = args.trim().toLowerCase();
				if (name === "off" || name === "clear" || name === "none") {
					clearColor(ctx);
					pi.appendEntry("session-color", { color: null });
					ctx.ui.notify("Session color cleared", "info");
					return;
				}
				if (COLORS[name]) {
					applyColor(name, ctx);
					pi.appendEntry("session-color", { color: name });
					ctx.ui.notify(`Session color: ${COLORS[name]} ${name}`, "info");
					return;
				}
				ctx.ui.notify(`Unknown color "${name}". Options: ${COLOR_NAMES.join(", ")}`, "error");
				return;
			}

			// TUI picker
			const options = [
				...COLOR_NAMES.map((n) => `${COLORS[n]} ${n}`),
				"✖ clear",
			];

			const choice = await ctx.ui.select("Session color", options);
			if (choice === undefined) return;

			if (choice.startsWith("✖")) {
				clearColor(ctx);
				pi.appendEntry("session-color", { color: null });
				ctx.ui.notify("Session color cleared", "info");
				return;
			}

			const name = choice.split(" ").pop()!;
			if (COLORS[name]) {
				applyColor(name, ctx);
				pi.appendEntry("session-color", { color: name });
				ctx.ui.notify(`Session color: ${COLORS[name]} ${name}`, "info");
			}
		},
	});
}
