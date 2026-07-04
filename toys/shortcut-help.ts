/**
 * Shortcut & Command Cheat Sheet — Alt+1 shows a floating overlay with two
 * tabs: local shortcuts + slash commands, and the prompt gallery (adapted
 * from ~/.pi/agent/prompts/gallery.md). Tab cycles tabs; any other key dismisses.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

type Entry = { key: string; description: string };
type Section = { title: string; keyWidth: number; entries: Entry[] };
type Tab = { label: string; sections: Section[] };

const SHORTCUTS: Entry[] = [
	{ key: "Alt+1", description: "This cheat sheet" },
	{ key: "Alt+5", description: "Toggle Pixoo display" },
	{ key: "Alt+6", description: "Toggle Ultrathink" },
	{ key: "Alt+7", description: "Cycle Fusion (off→lite→full→ultracode)" },
	{ key: "Alt+9", description: "Cycle Ponytail (off→lite→full→ultra)" },
	{ key: "Ctrl+`", description: "gitui overlay (Kitty)" },
	{ key: "Ctrl+P", description: "Cycle scoped models" },
	{ key: "Shift+Tab", description: "Cycle thinking level" },
	{ key: "Ctrl+L", description: "Open model selector" },
	{ key: "Ctrl+G", description: "Open editor text in external editor" },
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

// Adapted from ~/.pi/agent/prompts/gallery.md (/gallery) — keep in sync when
// prompts are added or retired there.
const GALLERY_SECTIONS: Section[] = [
	{
		title: "Session lifecycle",
		keyWidth: 18,
		entries: [
			{ key: "/onboard [focus]", description: "Session start: scan repo, load context" },
			{ key: "/wrap [save]", description: "Session end: gaps, blind spots, lessons" },
		],
	},
	{
		title: "Execution tiers (pick by scale)",
		keyWidth: 18,
		entries: [
			{ key: "/auto-do <task>", description: "Bounded task: plan→build→review→verify" },
			{ key: "/legate [spec]", description: "Multi-milestone build via PLAN.md" },
			{ key: "/legate-wrap", description: "Close out a legate session" },
			{ key: "/ultracode <task>", description: "Too big for one context window" },
		],
	},
	{
		title: "Dev loop",
		keyWidth: 18,
		entries: [
			{ key: "/debug <bug>", description: "Reproduce → isolate → root-cause → fix" },
			{ key: "/fix-issue <n>", description: "GitHub issue → verified PR" },
			{ key: "/review [base]", description: "Pre-merge review, ranked findings" },
			{ key: "/ship [focus]", description: "Docs, verify, commit, push" },
		],
	},
	{
		title: "Maintenance & strategy",
		keyWidth: 18,
		entries: [
			{ key: "/extension-audit", description: "Evidence audit + semver roadmap" },
			{ key: "/release [bump]", description: "Changelog, bump, tag, publish" },
			{ key: "/upkeep [apply]", description: "Deps, audit, CI, branches sweep" },
		],
	},
	{
		title: "Decision support",
		keyWidth: 18,
		entries: [
			{ key: "/council <q>", description: "4 models blind, chairman verdict" },
			{ key: "/gallery", description: "Full gallery index in chat" },
		],
	},
];

const CHEAT_TAB: Tab = {
	label: "⌨ Cheat Sheet",
	sections: [
		{ title: "Shortcuts", keyWidth: 16, entries: SHORTCUTS },
		{ title: "Commands", keyWidth: 20, entries: COMMANDS },
	],
};

const GALLERY_TAB: Tab = {
	label: "📚 Prompt Gallery",
	sections: GALLERY_SECTIONS,
};

const TABS: Tab[] = [CHEAT_TAB, GALLERY_TAB];

class CheatSheetOverlay implements Focusable {
	readonly width = 68;
	focused = false;

	private theme: Theme;
	private tui: { requestRender: () => void };
	private done: () => void;
	private tabIndex = 0;

	constructor(tui: { requestRender: () => void }, theme: Theme, done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	handleInput(data: string): void {
		if (data === "\t" || matchesKey(data, "tab")) {
			this.tabIndex = (this.tabIndex + 1) % TABS.length;
			this.tui.requestRender();
			return;
		}
		this.done();
	}

	render(_width: number): string[] {
		const w = this.width;
		const th = this.theme;
		const innerW = w - 2;
		const lines: string[] = [];
		const tab = TABS[this.tabIndex] ?? CHEAT_TAB;

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

		// Top border + tab bar
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		const tabBar = TABS.map((t, i) =>
			i === this.tabIndex
				? th.fg("accent", `▸ ${t.label}`)
				: th.fg("dim", `  ${t.label}`),
		).join("   ");
		lines.push(row(` ${tabBar}`));
		lines.push(row(""));

		// Sections of the active tab
		tab.sections.forEach((s, i) => {
			lines.push(row(` ${th.fg("accent", s.title)}`));
			section(s.entries, s.keyWidth);
			if (i < tab.sections.length - 1) lines.push(divider());
		});

		lines.push(row(""));
		lines.push(row(` ${th.fg("dim", "Tab switch tab · any other key dismiss · Alt+1 reopen")}`));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("alt+1", {
		description: "Show Pi cheat sheet overlay (Tab cycles to prompt gallery)",
		handler: async (ctx) => {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new CheatSheetOverlay(tui, theme, done),
				{ overlay: true },
			);
		},
	});

	pi.registerCommand("shortcuts", {
		description: "Show Pi cheat sheet overlay (Tab cycles to prompt gallery)",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new CheatSheetOverlay(tui, theme, done),
				{ overlay: true },
			);
		},
	});
}
