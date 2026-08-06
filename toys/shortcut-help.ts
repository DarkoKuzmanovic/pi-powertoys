/**
 * Shortcut & Command Cheat Sheet — Alt+1 shows a floating overlay with three
 * tabs: local shortcuts + slash commands; Herdr shortcuts; and the prompt gallery
 * (adapted from ~/.pi/agent/prompts/gallery.md). Tab cycles tabs; any other key dismisses.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Entry = { key: string; description: string };
type Section = { title: string; keyWidth: number; entries: Entry[] };
type Tab = { label: string; sections: Section[] };

const KITTY_HELP_TAG = /^\s*#\s*pi-launcher-help:\s*(.+?)\s*$/;
// Tagged help supports plain `map <shortcut> <action>` lines; option flags have value-dependent grammar.
const KITTY_MAP = /^\s*map\s+(?!--)(\S+)\s+/;

function formatKittyShortcut(shortcut: string): string {
	const names: Record<string, string> = {
		alt: "Alt",
		ctrl: "Ctrl",
		grave: "`",
		shift: "Shift",
		super: "Super",
	};
	return shortcut
		.split("+")
		.map((part) => names[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part))
		.join("+");
}

export function parseKittyLauncherHelp(config: string): Entry[] {
	const lines = config.split(/\r?\n/);
	const entries: Entry[] = [];
	for (let index = 0; index < lines.length - 1; index++) {
		const description = lines[index]?.match(KITTY_HELP_TAG)?.[1];
		if (!description) continue;
		const shortcut = lines[index + 1]?.match(KITTY_MAP)?.[1];
		if (!shortcut) continue;
		entries.push({ key: formatKittyShortcut(shortcut), description });
	}
	return entries;
}

type LauncherHelpResult = { entries: Entry[]; notice?: string };

const KITTY_CONFIG_PATH = join(
	process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
	"kitty",
	"kitty.conf",
);

export function loadKittyLauncherHelp(configPath = KITTY_CONFIG_PATH): LauncherHelpResult {
	try {
		const entries = parseKittyLauncherHelp(readFileSync(configPath, "utf8"));
		return entries.length > 0
			? { entries }
			: { entries, notice: `No tagged Kitty launcher mappings found (${configPath})` };
	} catch {
		return {
			entries: [],
			notice: `Terminal launchers unavailable (${configPath})`,
		};
	}
}

const PI_SHORTCUTS: Entry[] = [
	{ key: "Alt+1", description: "This cheat sheet" },
	{ key: "Alt+5", description: "Toggle Pixoo display" },
	{ key: "Alt+9", description: "Cycle Ponytail (off→lite→full→ultra)" },
	{ key: "Alt+Z", description: "Toggle AFK commit-signing mode" },
	{ key: "Ctrl+P", description: "Cycle scoped models" },
	{ key: "Ctrl+Shift+P", description: "Cycle scoped models backward" },
	{ key: "Shift+Tab", description: "Cycle thinking level" },
	{ key: "Ctrl+T", description: "Collapse or expand thinking blocks" },
	{ key: "Ctrl+L", description: "Open model selector" },
	{ key: "Ctrl+O", description: "Collapse or expand tool output" },
	{ key: "Ctrl+X", description: "Copy last assistant message" },
	{ key: "Ctrl+G", description: "Open editor text in external editor" },
	{ key: "Alt+Enter", description: "Queue a follow-up message" },
	{ key: "Esc", description: "Interrupt agent mid-turn" },
];

const COMMANDS: Entry[] = [
	{ key: "/reload", description: "Reload extensions, prompts, skills, and themes" },
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
	{ key: "/ss [ocr]", description: "Capture desktop region into context" },
	{ key: "/afk", description: "Show or toggle commit-signing AFK mode" },
	{ key: "/pixoo", description: "Control Pixoo usage display" },
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
			{ key: "/crew [spec]", description: "Multi-milestone build via PLAN.md" },
			{ key: "/crew-wrap", description: "Close out a crew session" },
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

const GALLERY_TAB: Tab = {
	label: "📚 Prompt Gallery",
	sections: GALLERY_SECTIONS,
};

const HERDR_TAB: Tab = {
	label: "🧭 Herdr",
	sections: [
		{
			title: "Our direct bindings",
			keyWidth: 20,
			entries: [
				{ key: "Ctrl+1 / 3", description: "Split pane down / right" },
				{ key: "Ctrl+2/4/6/8", description: "Focus down / left / right / up" },
				{ key: "Ctrl+5", description: "Return to last focused pane" },
				{ key: "Ctrl+7 / 9", description: "Previous / next agent" },
				{ key: "Ctrl+0", description: "Close focused pane" },
				{ key: "Ctrl+Shift+1", description: "Enter resize mode" },
				{ key: "Ctrl+Shift+3", description: "Open full session navigator" },
				{ key: "Ctrl+Shift+4 / 6", description: "Previous / next tab" },
				{ key: "Ctrl+Shift+5", description: "Toggle focused pane zoom" },
				{ key: "Ctrl+Shift+7 / 9", description: "Previous / next workspace" },
			],
		},
		{
			title: "Standard Herdr shortcuts",
			keyWidth: 20,
			entries: [
				{ key: "Ctrl+B, ?", description: "Show active Herdr keybindings" },
				{ key: "Ctrl+B, C", description: "Create a new tab" },
				{ key: "Ctrl+B, Shift+N", description: "Create a new workspace" },
				{ key: "Ctrl+B, W", description: "Open workspace picker" },
				{ key: "Ctrl+B, E", description: "Edit focused pane scrollback" },
				{ key: "Ctrl+B, O", description: "Open notification target" },
				{ key: "Ctrl+B, Shift+G", description: "Create a worktree workspace" },
				{ key: "Ctrl+B, B", description: "Toggle sidebar" },
				{ key: "Ctrl+B, Q", description: "Detach; leave session running" },
				{ key: "Ctrl+B, Shift+R", description: "Reload Herdr configuration" },
			],
		},
	],
};

export function buildTabs(launcherHelp: LauncherHelpResult): Tab[] {
	const piEntries = launcherHelp.notice
		? [...PI_SHORTCUTS, { key: "Kitty", description: launcherHelp.notice }]
		: PI_SHORTCUTS;
	const sections: Section[] = [{ title: "Pi shortcuts", keyWidth: 16, entries: piEntries }];
	if (launcherHelp.entries.length > 0) {
		sections.push({ title: "Terminal launchers (Kitty)", keyWidth: 16, entries: launcherHelp.entries });
	}
	sections.push({ title: "Commands", keyWidth: 20, entries: COMMANDS });
	return [{ label: "⌨ Cheat Sheet", sections }, HERDR_TAB, GALLERY_TAB];
}

class CheatSheetOverlay implements Focusable {
	readonly width = 72;
	focused = false;

	private theme: Theme;
	private tui: { requestRender: () => void };
	private done: () => void;
	private tabs: Tab[];
	private tabIndex = 0;

	constructor(tui: { requestRender: () => void }, theme: Theme, tabs: Tab[], done: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.tabs = tabs;
		this.done = done;
	}

	handleInput(data: string): void {
		if (data === "\t" || matchesKey(data, "tab")) {
			this.tabIndex = (this.tabIndex + 1) % this.tabs.length;
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
		const tab = this.tabs[this.tabIndex] ?? this.tabs[0];

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
		const tabBar = this.tabs.map((t, i) =>
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
		description: "Show cheat sheet overlay (Tab cycles: Herdr, gallery)",
		handler: async (ctx) => {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new CheatSheetOverlay(tui, theme, buildTabs(loadKittyLauncherHelp()), done),
				{ overlay: true },
			);
		},
	});

	pi.registerCommand("shortcuts", {
		description: "Show cheat sheet overlay (Tab cycles: Herdr, gallery)",
		handler: async (_args, ctx) => {
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) => new CheatSheetOverlay(tui, theme, buildTabs(loadKittyLauncherHelp()), done),
				{ overlay: true },
			);
		},
	});
}
