import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTabs, loadKittyLauncherHelp, parseKittyLauncherHelp } from "./shortcut-help.ts";

test("parseKittyLauncherHelp derives displayed keys from tagged Kitty mappings", () => {
	const config = `
# pi-launcher-help: gitui — local worktree, index, and branches
map ctrl+shift+grave launch --type=window --cwd=current gitui

# This mapping is intentionally absent from Pi help.
map ctrl+shift+x launch something-else

# pi-launcher-help: GitHub dashboard — remote PRs, issues, and notifications
map ctrl+shift+g launch --type=window --cwd=current gh dash
`;

	assert.deepEqual(parseKittyLauncherHelp(config), [
		{ key: "Ctrl+Shift+`", description: "gitui — local worktree, index, and branches" },
		{ key: "Ctrl+Shift+G", description: "GitHub dashboard — remote PRs, issues, and notifications" },
	]);
});
test("parseKittyLauncherHelp ignores tagged mappings that use Kitty map options", () => {
	const config = `
# pi-launcher-help: optioned mapping is outside the tagged-help contract
map --when-focused ctrl+shift+h launch something
`;

	assert.deepEqual(parseKittyLauncherHelp(config), []);
});


test("loadKittyLauncherHelp reports a clear fallback when the config is unavailable", () => {
	const configPath = `/tmp/pi-powertoys-missing-${process.pid}/kitty.conf`;
	assert.deepEqual(loadKittyLauncherHelp(configPath), {
		entries: [],
		notice: `Terminal launchers unavailable (${configPath})`,
	});
});


test("loadKittyLauncherHelp reports when a readable config has no tagged mappings", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-powertoys-shortcuts-"));
	const configPath = join(directory, "kitty.conf");
	try {
		writeFileSync(configPath, "map ctrl+shift+x launch untagged\n", "utf8");
		assert.deepEqual(loadKittyLauncherHelp(configPath), {
			entries: [],
			notice: `No tagged Kitty launcher mappings found (${configPath})`,
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});


test("buildTabs separates Pi shortcuts from Kitty-authoritative terminal launchers", () => {
	const launchers = [
		{ key: "Alt+2", description: "pero — scratchpad and todos" },
		{ key: "Ctrl+Shift+`", description: "gitui — local worktree, index, and branches" },
	];
	const tabs = buildTabs({ entries: launchers });
	const cheatSections = tabs[0]?.sections;

	assert.deepEqual(cheatSections?.map((section) => section.title), [
		"Pi shortcuts",
		"Terminal launchers (Kitty)",
		"Commands",
	]);
	assert.deepEqual(cheatSections?.[1]?.entries, launchers);
	assert.equal(cheatSections?.[0]?.entries.some((entry) => entry.key === "Alt+2"), false);
});
test("buildTabs shows the fallback notice without a terminal launchers section", () => {
	const notice = "Terminal launchers unavailable (/tmp/missing-kitty.conf)";
	const cheatSections = buildTabs({ entries: [], notice })[0]?.sections ?? [];

	assert.deepEqual(
		cheatSections.map((section) => section.title),
		["Pi shortcuts", "Commands"],
	);
	assert.deepEqual(
		cheatSections[0]?.entries.find((entry) => entry.key === "Kitty"),
		{ key: "Kitty", description: notice },
	);
});

test("buildTabs includes Herdr custom bindings before standard shortcuts", () => {
	const herdrTab = buildTabs({ entries: [] }).find((tab) => tab.label === "🧭 Herdr");

	assert.deepEqual(herdrTab?.sections.map((section) => section.title), [
		"Our direct bindings",
		"Standard Herdr shortcuts",
	]);
	assert.deepEqual(herdrTab?.sections[0]?.entries, [
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
	]);
	assert.deepEqual(herdrTab?.sections[1]?.entries, [
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
	]);
});

test("buildTabs keeps the primary Cheat Sheet aligned with current shortcuts and commands", () => {
	const cheatSections = buildTabs({ entries: [] })[0]?.sections ?? [];
	const shortcutEntries = cheatSections.find((section) => section.title === "Pi shortcuts")?.entries ?? [];
	const commandEntries = cheatSections.find((section) => section.title === "Commands")?.entries ?? [];

	assert.deepEqual(shortcutEntries.find((entry) => entry.key === "Alt+7"), {
		key: "Alt+7",
		description: "Cycle Fusion (off→lite→full→max)",
	});
	for (const key of ["Alt+5", "Alt+Z", "Ctrl+Shift+P", "Ctrl+T", "Ctrl+O", "Ctrl+X", "Alt+Enter"]) {
		assert.equal(shortcutEntries.some((entry) => entry.key === key), true, `missing shortcut ${key}`);
	}
	for (const command of ["/reload", "/ss [ocr]", "/afk", "/pixoo"]) {
		assert.equal(commandEntries.some((entry) => entry.key === command), true, `missing command ${command}`);
	}
	for (const stale of ["/fable tui", "/enhance", "/loop tests"]) {
		assert.equal(commandEntries.some((entry) => entry.key === stale), false, `stale command ${stale}`);
	}
});
