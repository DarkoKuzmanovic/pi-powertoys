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
