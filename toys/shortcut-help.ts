/**
 * Shortcut & Command Cheat Sheet — Alt+1 shows a floating overlay listing
 * all custom keyboard shortcuts and useful slash commands. Any keypress dismisses.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, visibleWidth } from "@earendil-works/pi-tui";

type Entry = { key: string; description: string };

const SHORTCUTS: Entry[] = [
	{ key: "Alt+1", description: "This cheat sheet" },
	{ key: "Alt+5", description: "Toggle Pixoo display" },
	{ key: "Alt+6", description: "Toggle Ultrathink" },
	{ key: "Alt+7", description: "Cycle Fusion (off→lite→full)" },
	{ key: "Alt+8", description: "Cycle Fable (off→lite→full)" },
	{ key: "Alt+9", description: "Cycle Ponytail (off→lite→full→ultra)" },
	{ key: "Ctrl+`", description: "gitui overlay (Kitty)" },
	{ key: "Ctrl+P", description: "Cycle scoped models" },
	{ key: "Shift+Tab", description: "Cycle thinking level" },
	{ key: "Ctrl+L", description: "Open model selector" },
	{ key: "Esc", description: "Interrupt agent mid-turn" },
];

const COMMANDS: Entry[] = [
	{ key: "/fable tui", description: "Manage Fable-capable models" },
	{ key: "/scoped-models", description: "Enable/disable models for Ctrl+P" },
	{ key: "/working-color", description: "Animate working message colors" },
	{ key: "/steer <text>", description: "Inject text mid-turn" },
	{ key: "/sys-prompt", description: "Add/view/delete system prompt snippets" },
	{ key: "/memory", description: "List or search past session memories" },
	{ key: "/pitaj", description: "Ask another model inline" },
	{ key: "/compact-model", description: "Pick compaction model" },
	{ key: "/context", description: "Token usage & context fill" },
	{ key: "/speedtest", description: "Benchmark model TPS/TTFT" },
	{ key: "/qna", description: "Extract Q&A from session" },
	{ key: "/lint", description: "Lint loaded extensions" },
	{ key: "/hud hint cycle", description: "Rotate footer hints continuously" },
	{ key: "/color <name>", description: "Tag session in tree view" },
	{ key: "/enhance", description: "Rewrite prompt via stronger model" },
	{ key: "/loop tests", description: "Loop until tests pass" },
];

class CheatSheetOverlay implements Focusable {
	readonly width = 68;
	focused = false;

	private theme: Theme;
	private done: () => void;

	constructor(theme: Theme, done: () => void) {
		this.theme = theme;
		this.done = done;
	}

	handleInput(_data: string): void {
		this.done();
	}

	render(_width: number): string[] {
		const w = this.width;
		const th = this.theme;
		const innerW = w - 2;
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};

		const row = (content: string) =>
			th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

		const divider = () =>
			row(` ${th.fg("dim", "─".repeat(innerW - 2))}`);

		const section = (items: Entry[], keyWidth: number) => {
			for (const { key, description } of items) {
				const keyStr = th.fg("warning", pad(key, keyWidth));
				lines.push(row(` ${keyStr} ${th.fg("text", description)}`));
			}
		};

		// Top border
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		lines.push(row(` ${th.fg("accent", "⌨  Pi Cheat Sheet                            Alt+1 to reopen")}`));
		lines.push(row(""));

		// Shortcuts
		lines.push(row(` ${th.fg("accent", "Shortcuts")}`));
		section(SHORTCUTS, 16);
		lines.push(divider());

		// Commands
		lines.push(row(` ${th.fg("accent", "Commands")}`));
		section(COMMANDS, 20);

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "Press any key to dismiss")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("alt+1", {
		description: "Show Pi cheat sheet overlay",
		handler: async (ctx) => {
			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) => new CheatSheetOverlay(theme, done),
				{ overlay: true },
			);
		},
	});

	pi.registerCommand("shortcuts", {
		description: "Show Pi cheat sheet overlay",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) => new CheatSheetOverlay(theme, done),
				{ overlay: true },
			);
		},
	});
}
