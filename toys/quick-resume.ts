// pi-quick-resume — Shows a Claude Code-style resume command on exit
//
// When you press Ctrl+D twice to exit Pi, this extension prints:
//
//   Resume this session with:
//   pi --session <session-id>
//
// Uses --session (not --resume) because --resume opens a picker,

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

export default function piQuickResume(pi: ExtensionAPI) {
	pi.on("session_shutdown", async (event, ctx) => {
		if (event.reason !== "quit") return;

		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return; // ephemeral session, nothing to resume

		// Extract UUID from filename: <timestamp>_<uuid>.jsonl
		const basename = path.basename(sessionFile, ".jsonl");
		const uuid = basename.split("_").pop();
		if (!uuid || uuid === basename) return; // no UUID found

		// Use ANSI codes for dim styling (same as Claude Code's look)
		const dim = "\x1b[2m";
		const reset = "\x1b[0m";
		const bold = "\x1b[1m";

		// Print after Pi's own exit message
		process.stdout.write(
			`\n${dim}Resume this session with:${reset}\n` +
			`${bold}pi --session ${uuid}${reset}\n\n`,
		);
	});
}
