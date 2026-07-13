import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

/**
 * afk — away-from-keyboard commit-signing toggle.
 *
 * A GPG-signed commit made while you're away pops a pinentry passphrase window
 * that blocks until you type it — stalling the agent until you're back. `/afk on`
 * suspends git commit signing globally (`commit.gpgsign=false`) so nothing can
 * prompt; `/afk off` restores the exact previous value.
 *
 * Deliberately the simplest, stateless mechanism: no cached passphrase, no
 * gpg-agent TTL juggling, cannot stall. The only cost is that commits made
 * while AFK are unsigned — fine on a solo/private box. If you want every pushed
 * commit signed, don't push mid-AFK (or amend before pushing); re-signing
 * already-pushed commits rewrites history.
 *
 * Scope note: only `commit.gpgsign` is touched (the source of the stall).
 * Tag signing (`tag.gpgsign`) is left alone — signed tags are rare in agent runs.
 *
 * UI: a footer status glyph reflects state at a glance — a keyboard when signing
 * is active, a struck-through keyboard when AFK has suspended it. A keyboard
 * shortcut toggles the mode without typing `/afk`.
 */

const CONFIG_KEY = "afk";

/**
 * Keyboard shortcut that toggles AFK.
 *
 * NB: Pause/Break — the "obvious" dedicated key — is NOT bindable in pi. Its
 * key vocabulary (`KeyId` in @earendil-works/pi-tui) has no `pause`/`break`
 * token, so no shortcut string can name it. Three layers each get a veto:
 *   1. pi's decoder can't name Pause/Break and can't decode ANY modified
 *      function key (Alt/Ctrl/Shift + F1..F12) — those never arrive.
 *   2. Kitty's built-in keymap grabs ctrl+shift+<letter> (ctrl+shift+k =
 *      scroll up) before pi sees it.
 *   3. KDE global shortcuts grab many combos (Ctrl+Shift+F12, F12, Alt+K…).
 * `alt+z` (mnemonic: zzz = away) clears all three and decodes via the Kitty
 * keyboard protocol as CSI-u — the same path as the working `alt+1`. It's
 * non-printable, so it fires even while the editor is focused. Change this one
 * constant to rebind; verify the replacement is free in KDE (kglobalshortcutsrc),
 * Kitty, and pi.
 */
const TOGGLE_SHORTCUT = "alt+z";

// Nerd Font glyphs (Material Design Icons).
const ICON_KEYBOARD = "\udb80\udf0c"; // nf-md-keyboard      (U+F030C) — signing active
const ICON_KEYBOARD_OFF = "\udb80\udf10"; // nf-md-keyboard_off  (U+F0310) — signing suspended

interface AfkState {
	active: boolean;
	/** commit.gpgsign value captured at `/afk on`; null means it was unset. */
	prevGpgsign: string | null;
}

// ── git config helpers ──────────────────────────────────────────

/** Read a global git config value, or null when the key is unset. */
function gitConfigGet(key: string): string | null {
	try {
		return execFileSync("git", ["config", "--global", "--get", key], {
			encoding: "utf8",
			timeout: 5_000,
		}).trim();
	} catch {
		// `--get` exits non-zero when the key is absent.
		return null;
	}
}

function gitConfigSet(key: string, value: string): void {
	execFileSync("git", ["config", "--global", key, value], { timeout: 5_000 });
}

function gitConfigUnset(key: string): void {
	try {
		execFileSync("git", ["config", "--global", "--unset", key], { timeout: 5_000 });
	} catch {
		// Already unset — nothing to do.
	}
}

// ── State + UI ──────────────────────────────────────────────────

function isActive(): boolean {
	return loadToyConfig<AfkState>(CONFIG_KEY)?.active ?? false;
}

/** Reflect current AFK state as a footer status glyph. */
function updateStatus(ctx: ExtensionContext): void {
	const active = isActive();
	const glyph = active ? ICON_KEYBOARD_OFF : ICON_KEYBOARD;
	ctx.ui.setStatus(CONFIG_KEY, ctx.ui.theme.fg(active ? "warning" : "muted", glyph));
}

/** Suspend commit signing. Returns false if AFK was already on. */
function enableAfk(): boolean {
	if (isActive()) return false;
	const prev = gitConfigGet("commit.gpgsign");
	gitConfigSet("commit.gpgsign", "false");
	saveToyConfig(CONFIG_KEY, { active: true, prevGpgsign: prev } satisfies AfkState);
	return true;
}

/**
 * Restore commit signing. Returns the restored value for display, or null if
 * AFK was already off (nothing changed).
 */
function disableAfk(): string | null {
	const state = loadToyConfig<AfkState>(CONFIG_KEY);
	if (!state?.active) return null;
	const prev = state.prevGpgsign ?? null;
	if (prev === null) {
		gitConfigUnset("commit.gpgsign");
	} else {
		gitConfigSet("commit.gpgsign", prev);
	}
	saveToyConfig(CONFIG_KEY, { active: false, prevGpgsign: null } satisfies AfkState);
	return prev === null ? "unset (git default)" : prev;
}

// ── Extension ───────────────────────────────────────────────────

export default function afkExtension(pi: ExtensionAPI) {
	// Keep the footer glyph in sync from the moment the session opens.
	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
	});

	// Alt+Z toggles AFK without typing a command.
	pi.registerShortcut(TOGGLE_SHORTCUT, {
		description: "Toggle AFK: suspend/restore git commit signing so pinentry can't stall the agent.",
		handler: async (ctx) => {
			try {
				if (isActive()) {
					const restored = disableAfk();
					ctx.ui.notify(
						`🔔 AFK off — commit signing restored (commit.gpgsign = ${restored}).`,
						"info",
					);
				} else {
					enableAfk();
					ctx.ui.notify(
						"🔕 AFK on — git commit signing suspended. No pinentry prompt will stall the agent. Toggle again or /afk off when you're back.",
						"info",
					);
				}
				updateStatus(ctx);
			} catch (e: any) {
				ctx.ui.notify(`/afk toggle failed to update git config: ${e?.message ?? String(e)}`, "error");
			}
		},
	});

	pi.registerCommand("afk", {
		description:
			"Away-from-keyboard mode: suspend git commit signing so a GPG pinentry prompt can't stall the agent while you're away. Usage: /afk on | /afk off | /afk (status).",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const active = isActive();

			try {
				if (sub === "on") {
					if (!enableAfk()) {
						ctx.ui.notify("🔕 AFK is already on — commit signing already suspended.", "info");
						return;
					}
					updateStatus(ctx);
					ctx.ui.notify(
						"🔕 AFK on — git commit signing suspended globally. No pinentry prompt will stall the agent. Run /afk off when you're back.",
						"info",
					);
					return;
				}

				if (sub === "off") {
					const restored = disableAfk();
					if (restored === null) {
						ctx.ui.notify("🔔 AFK is already off — commit signing is active.", "info");
						return;
					}
					updateStatus(ctx);
					ctx.ui.notify(`🔔 AFK off — commit signing restored (commit.gpgsign = ${restored}).`, "info");
					return;
				}

				if (sub === "" || sub === "status") {
					const current = gitConfigGet("commit.gpgsign") ?? "unset (git default = off)";
					if (active) {
						ctx.ui.notify(
							`🔕 AFK is ON — commit signing suspended (commit.gpgsign = ${current}). Commits made now are unsigned. /afk off to restore.`,
							"info",
						);
					} else {
						ctx.ui.notify(`🔔 AFK is off — commit signing active (commit.gpgsign = ${current}).`, "info");
					}
					return;
				}

				ctx.ui.notify(`Unknown argument "${sub}". Usage: /afk on | /afk off | /afk (status).`, "error");
			} catch (e: any) {
				ctx.ui.notify(`/afk failed to update git config: ${e?.message ?? String(e)}`, "error");
			}
		},
	});
}
