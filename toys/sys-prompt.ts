/**
 * sys-prompt — Session-scoped system-prompt snippets.
 *
 * Build up a list of additions that get appended to the system prompt on every
 * agent turn in the current session. Useful for steering long sessions without
 * burning context on repeated reminders.
 *
 *   /sys-prompt   — open overlay (compose / list / delete)
 *
 * Snippets persist via session entries (survive /reload, fork-aware) but are
 * scoped to this session only — they do not leak into other sessions.
 *
 * Adapted from @agnishc/edb-append-system-prompt with the following changes:
 *   - Single-file (state + component + index merged).
 *   - Injected snippets are wrapped in a labelled fence so they're findable
 *     in /system-prompt-data dumps and clearly separated from the base prompt.
 *   - List items show actual snippet preview text, not just "Snippet N".
 *   - Enter on a snippet is a no-op (was: triggered delete confirm).
 *     Delete now requires explicit `d` key — Enter on snippet is reserved.
 *   - Footer hints clarified.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findLastCustomEntry } from "./toy-kit.ts";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────

interface Snippet {
	id: string;
	text: string;
	createdAt: number;
}

type OverlayAction = { type: "add"; text: string } | { type: "delete"; id: string; text: string };

interface ThemeSlice {
	fg: (role: string, text: string) => string;
	bold: (text: string) => string;
}

const STATUS_KEY = "sys-prompt";
const ENTRY_TYPE = "sys-prompt-snippets";

// ── Module state ──────────────────────────────────────────────

let snippets: Snippet[] = [];

// ── Utils ─────────────────────────────────────────────────────

function formatAge(ts: number): string {
	const s = Math.floor((Date.now() - ts) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

function wordCount(text: string): number {
	return text.trim().split(/\s+/).filter(Boolean).length;
}

// ── State helpers ─────────────────────────────────────────────

function loadFromSession(ctx: ExtensionContext): Snippet[] {
	return findLastCustomEntry<{ snippets?: Snippet[] }>(ctx.sessionManager.getEntries(), ENTRY_TYPE)?.snippets ?? [];
}

function persist(pi: ExtensionAPI): void {
	pi.appendEntry(ENTRY_TYPE, { snippets });
}

function updateStatusBar(ctx: ExtensionContext): void {
	if (snippets.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const label = snippets.length === 1 ? "1 snippet" : `${snippets.length} snippets`;
	const theme = ctx.ui.theme as ThemeSlice;
	ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", `⊕ ${label}`));
}

// ── Overlay component ─────────────────────────────────────────

type Mode = "list" | "composing";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TUI components are inherently branchy.
function createOverlay(
	tui: unknown,
	theme: ThemeSlice,
	done: (result?: OverlayAction) => void,
	prefillText?: string,
): Component {
	const dim = (s: string) => theme.fg("dim", s);
	const accent = (s: string) => theme.fg("accent", s);
	const muted = (s: string) => theme.fg("muted", s);

	let mode: Mode = snippets.length === 0 ? "composing" : "list";

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};

	// biome-ignore lint/suspicious/noExplicitAny: TUI is the public type, not exported.
	const editor = new Editor(tui as any, editorTheme);
	editor.focused = true;
	if (prefillText) editor.setText(prefillText);

	editor.onSubmit = (text) => {
		const trimmed = text.trim();
		if (trimmed) {
			done({ type: "add", text: trimmed });
		} else if (snippets.length > 0) {
			mode = "list";
			requestRender();
		} else {
			done();
		}
	};

	const selectTheme: SelectListTheme = {
		selectedPrefix: (t) => theme.fg("accent", t),
		selectedText: (t) => theme.fg("accent", t),
		description: (t) => theme.fg("dim", t),
		scrollInfo: (t) => theme.fg("dim", t),
		noMatch: (t) => theme.fg("warning", t),
	};

	function buildItems(): SelectItem[] {
		const items: SelectItem[] = [{ value: "__add__", label: accent("＋ Add new snippet"), description: "" }];
		for (const s of snippets) {
			const flat = s.text.replace(/\s+/g, " ").trim();
			items.push({
				value: s.id,
				label: truncateToWidth(flat, 55),
				description: `${formatAge(s.createdAt)}  ·  ${wordCount(s.text)} words`,
			});
		}
		return items;
	}

	const list = new SelectList(buildItems(), 12, selectTheme);

	function requestRender(): void {
		(tui as { requestRender?: () => void }).requestRender?.();
	}

	function renderHeader(width: number): string[] {
		const titleText = " ✦ System Prompt Snippets";
		const title = theme.bold(accent(titleText));
		const count = snippets.length === 0 ? muted("none active") : accent(`${snippets.length} active`);
		const gap = Math.max(2, width - visibleWidth(titleText) - visibleWidth(count) - 1);
		return [title + " ".repeat(gap) + count];
	}

	function renderBody(width: number): string[] {
		if (mode === "composing") {
			const lines: string[] = [];
			lines.push(dim("  Write a system-prompt addition (Enter to submit, blank line cancels):"));
			lines.push("");
			for (const line of editor.render(width - 2)) {
				lines.push(` ${line}`);
			}
			return lines;
		}
		return list.render(width);
	}

	function renderFooter(width: number): string[] {
		const divider = dim("─".repeat(width));
		if (mode === "composing") {
			return [divider, dim(`  Enter submit  ·  Esc ${snippets.length > 0 ? "back to list" : "close"}`)];
		}
		return [divider, dim("  ↑↓ navigate  ·  Enter add new  ·  d delete selected  ·  Esc close")];
	}

	return {
		render(width: number): string[] {
			return [...renderHeader(width), dim("─".repeat(width)), ...renderBody(width), ...renderFooter(width)];
		},

		handleInput(data: string): void {
			if (mode === "composing") {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					if (snippets.length > 0) {
						mode = "list";
						requestRender();
					} else {
						done();
					}
					return;
				}
				editor.handleInput(data);
				requestRender();
				return;
			}

			// list mode
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				done();
				return;
			}

			if (data === "d") {
				const sel = list.getSelectedItem();
				if (sel && sel.value !== "__add__") {
					const snippet = snippets.find((s) => s.id === sel.value);
					if (snippet) done({ type: "delete", id: snippet.id, text: snippet.text });
				}
				return;
			}

			if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				const sel = list.getSelectedItem();
				if (!sel) return;
				if (sel.value === "__add__") {
					mode = "composing";
					editor.setText("");
					editor.focused = true;
					requestRender();
				}
				// Enter on a snippet is intentionally a no-op — `d` is the only delete path.
				return;
			}

			if (
				matchesKey(data, Key.up) ||
				matchesKey(data, Key.down) ||
				matchesKey(data, Key.pageUp) ||
				matchesKey(data, Key.pageDown)
			) {
				list.handleInput(data);
				requestRender();
				return;
			}
		},

		invalidate(): void {
			editor.invalidate?.();
			list.invalidate();
		},
	};
}

function openOverlay(ctx: ExtensionCommandContext, prefillText?: string): Promise<OverlayAction | undefined> {
	// biome-ignore lint/suspicious/noExplicitAny: ctx.ui.custom overlay options aren't part of the public type.
	return (ctx.ui as any).custom(
		(tui: unknown, theme: ThemeSlice, _kb: unknown, done: (result?: OverlayAction) => void) =>
			createOverlay(tui, theme, done, prefillText),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "65%", maxHeight: "80%" },
		},
	);
}

// ── Extension ─────────────────────────────────────────────────

export default function sysPromptExtension(pi: ExtensionAPI): void {
	// Restore state on session start / reload.
	pi.on("session_start", async (_event, ctx) => {
		snippets = loadFromSession(ctx);
		updateStatusBar(ctx);
	});

	// Append all active snippets to the system prompt on every turn.
	// Wrapped in a labelled fence for visibility in /system-prompt-data dumps.
	pi.on("before_agent_start", async (event) => {
		if (snippets.length === 0) return;
		const addition = snippets.map((s) => s.text).join("\n\n");
		const fence =
			`── Session prompt additions (${snippets.length}) ──\n` +
			`${addition}\n` +
			`── end session prompt additions ──`;
		return { systemPrompt: `${event.systemPrompt}\n\n${fence}` };
	});

	pi.registerCommand("sys-prompt", {
		description: "Manage session-scoped system-prompt snippets — add, view, delete",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			await ctx.waitForIdle();

			let pendingText: string | undefined;
			let shouldReopen = false;

			do {
				shouldReopen = false;
				const action = await openOverlay(ctx, pendingText);
				pendingText = undefined;

				if (!action) break;

				if (action.type === "add") {
					const preview = action.text.length > 500 ? `${action.text.slice(0, 497)}…` : action.text;
					const confirmed = await ctx.ui.confirm("Add this to your system prompt?", preview);
					if (confirmed) {
						snippets.push({ id: randomUUID(), text: action.text, createdAt: Date.now() });
						persist(pi);
						updateStatusBar(ctx);
					} else {
						// Preserve typed text so the user doesn't lose their work on cancel.
						pendingText = action.text;
					}
					shouldReopen = true;
				}

				if (action.type === "delete") {
					const preview = action.text.length > 300 ? `${action.text.slice(0, 297)}…` : action.text;
					const confirmed = await ctx.ui.confirm("Remove this snippet from your system prompt?", preview);
					if (confirmed) {
						snippets = snippets.filter((s) => s.id !== action.id);
						persist(pi);
						updateStatusBar(ctx);
					}
					shouldReopen = true;
				}
			} while (shouldReopen);
		},
	});
}
