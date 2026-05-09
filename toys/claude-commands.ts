/**
 * Claude Commands Bridge for Pi
 *
 * Reads .claude/commands/*.md files from the project directory and home directory,
 * and registers them as Pi slash commands. When invoked, the command body is sent
 * as a user message to the agent via pi.sendUserMessage().
 *
 * This bridges the Claude Code custom commands format into Pi's extension system.
 *
 * Supported locations (searched in order, project-local takes precedence on name collision):
 *   - <cwd>/.claude/commands/*.md   (project-local)
 *   - <cwd>/.claude/commands/*.md   (project-local, including subdirectories)
 *
 * Claude Code file format:
 *   ---
 *   description: One-line description shown in command listing
 *   ---
 *   Command body (instructions sent to the agent)
 *
 * Registered commands:
 *   /<filename>        - Runs the command (e.g., /issues for issues.md)
 *   /claude-commands   - Lists all discovered Claude commands
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ClaudeCommand {
	name: string;
	description: string;
	body: string;
	path: string;
	source: "project" | "global";
}

function parseFrontmatter(content: string): { description: string; body: string } {
	let description = "";
	let body = content;

	if (content.startsWith("---")) {
		const end = content.indexOf("---", 3);
		if (end !== -1) {
			const frontmatter = content.slice(3, end).trim();
			body = content.slice(end + 3).trim();

			for (const line of frontmatter.split("\n")) {
				const match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
				if (match) {
					const key = match[1].trim().toLowerCase();
					const value = match[2].trim();
					if (key === "description") {
						description = value;
					}
				}
			}
		}
	}

	return { description, body };
}

function discoverCommands(cwd: string): ClaudeCommand[] {
	const commands: ClaudeCommand[] = [];
	const seen = new Set<string>();

	const searchDirs: Array<{ dir: string; source: "project" | "global" }> = [
		{ dir: join(cwd, ".claude", "commands"), source: "project" },
		{ dir: join(homedir(), ".claude", "commands"), source: "global" },
	];

	for (const { dir, source } of searchDirs) {
		if (!existsSync(dir)) continue;

		let files: string[];
		try {
			files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".md")).sort();
		} catch {
			continue;
		}

		for (const file of files) {
			// Flatten subdirectories with :
			// e.g., "issues.md" -> "issues", "git/commit.md" -> "git:commit"
			const name = file.replace(/\.md$/, "").replace(/\//g, ":");

			if (seen.has(name)) continue;
			seen.add(name);

			const filePath = join(dir, file);
			let content: string;
			try {
				content = readFileSync(filePath, "utf8");
			} catch {
				continue;
			}

			const { description, body } = parseFrontmatter(content);

			commands.push({
				name,
				description: description || `Claude command: ${name}`,
				body,
				path: filePath,
				source,
			});
		}
	}

	return commands;
}

export default function claudeCommandsExtension(pi: ExtensionAPI) {
	// Tracks discoverable commands; updated on session_start and resources_discover.
	// The command handlers read from this map + re-read from disk so edits take effect immediately.
	const commandMap = new Map<string, ClaudeCommand>();
	let lastCwd = "";
	const registeredNames = new Set<string>();

	function refreshCommands(cwd: string): ClaudeCommand[] {
		const commands = discoverCommands(cwd);
		commandMap.clear();
		for (const cmd of commands) {
			commandMap.set(cmd.name, cmd);
		}
		lastCwd = cwd;
		return commands;
	}

	async function handleCommand(cmd: ClaudeCommand, ctx: ExtensionContext): Promise<void> {
		// Re-read from disk so edits take effect immediately
		let content: string;
		try {
			content = readFileSync(cmd.path, "utf8");
		} catch {
			ctx.ui.notify(`Failed to read ${cmd.path}`, "error");
			return;
		}

		const { body } = parseFrontmatter(content);
		if (!body.trim()) {
			ctx.ui.notify(`Command "/${cmd.name}" is empty`, "warning");
			return;
		}

		ctx.ui.notify(`Running /${cmd.name}…`, "info");
		pi.sendUserMessage(body);
	}

	// Register per-command slash-command handlers on session start.
	// Track which names we've already registered — Pi doesn't replace
	// existing command names, so we only register new ones.
	const registerNewCommands = (commands: Command[]) => {
		for (const cmd of commands) {
			if (registeredNames.has(cmd.name)) continue;
			registeredNames.add(cmd.name);
			pi.registerCommand(cmd.name, {
				description: cmd.description,
				handler: async (_args, innerCtx) => {
					const live = commandMap.get(cmd.name);
					if (live) {
						await handleCommand(live, innerCtx);
					} else {
						innerCtx.ui.notify(`Command "/${cmd.name}" not found. Run /reload to rediscover.`, "warning");
				}
				},
			});
		}
	};

	pi.on("session_start", (_event, ctx) => {
		const commands = refreshCommands(ctx.cwd);
		registerNewCommands(commands);
	});

	// Keep the map fresh and register new commands on reload too
	pi.on("resources_discover", (event) => {
		const commands = refreshCommands(event.cwd);
		registerNewCommands(commands);
	});

	// Meta-command: list and run discovered commands
	pi.registerCommand("claude-commands", {
		description: "List all discovered .claude/commands",
		getArgumentCompletions: (prefix: string) => {
			const names = [...commandMap.keys()].filter((n) => n.startsWith(prefix));
			if (names.length === 0) return null;
			return names.map((n) => ({ value: n, label: `/${n}` }));
		},
		handler: async (args, ctx) => {
			// If invoked with an argument like "/claude-commands issues", run that command directly
			const directName = args.trim();
			if (directName) {
				const cmd = commandMap.get(directName);
				if (cmd) {
					await handleCommand(cmd, ctx);
					return;
				}
				// Fallthrough to list if not found
			}

			const commands = discoverCommands(ctx.cwd);
			if (commands.length === 0) {
				ctx.ui.notify(
					"No .claude/commands found.\nCreate .claude/commands/*.md files to add commands.",
					"info",
				);
				return;
			}

			const items = commands.map(
				(cmd) => `/${cmd.name} — ${cmd.description} [${cmd.source}]`,
			);

			const selected = await ctx.ui.select("Claude Commands", items);
			if (selected) {
				const cmdName = selected.split(" —")[0].slice(1);
				const cmd = commandMap.get(cmdName) ?? commands.find((c) => c.name === cmdName);
				if (cmd) {
					await handleCommand(cmd, ctx);
				}
			}
		},
	});
}