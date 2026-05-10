/**
 * init — Initialize AGENTS.md with Pi-aware project context.
 *
 * /init — generates or updates AGENTS.md with Pi tooling guidance, tool
 *         hierarchy, file reading rules, architecture principles, and more.
 *
 * If AGENTS.md already exists, offers to append a Pi section or replace.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Project detection ───────────────────────────────────────────────

interface ProjectInfo {
	name: string;
	type?: string;
	description?: string;
}

function detectProject(cwd: string): ProjectInfo {
	// Node / JS / TS
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			return {
				name: pkg.name || basename(cwd),
				type: "Node.js",
				description: pkg.description,
			};
		} catch {}
	}

	// Rust
	if (existsSync(join(cwd, "Cargo.toml"))) {
		const cargo = readFileSync(join(cwd, "Cargo.toml"), "utf-8");
		const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
		return { name: nameMatch?.[1] || basename(cwd), type: "Rust" };
	}

	// Python
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
		return { name: basename(cwd), type: "Python" };
	}

	// Go
	if (existsSync(join(cwd, "go.mod"))) {
		return { name: basename(cwd), type: "Go" };
	}

	return { name: basename(cwd) };
}

// ── Pi docs resolution ──────────────────────────────────────────────

async function resolvePiDocsRoot(pi: ExtensionAPI): Promise<string> {
	try {
		const result = await pi.exec("node", [
			"-e",
			"console.log(require('path').dirname(require.resolve('@earendil-works/pi-coding-agent/package.json')))",
		]);
		if (result.exitCode === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	} catch {}
	return "";
}

// ── Template ────────────────────────────────────────────────────────

function generatePiSection(piRoot: string): string {
	const docsRef = piRoot
		? [
				``,
				`### Pi documentation`,
				``,
				`- Main docs: \`${piRoot}/README.md\``,
				`- Usage: \`${piRoot}/docs/usage.md\``,
				`- Extensions: \`${piRoot}/docs/extensions.md\``,
				`- TUI components: \`${piRoot}/docs/tui.md\``,
				`- Skills: \`${piRoot}/docs/skills.md\``,
				`- SDK: \`${piRoot}/docs/sdk.md\``,
				`- Settings: \`${piRoot}/docs/settings.md\``,
				`- Themes: \`${piRoot}/docs/themes.md\``,
				`- Prompt templates: \`${piRoot}/docs/prompt-templates.md\``,
				``,
				`Read the relevant docs before building extensions, tools, or custom UI.`,
			]
		: [];

	return [
		`## Pi Environment`,
		``,
		`This project uses [Pi](https://github.com/mariozechner/pi) as its coding agent.`,
		...docsRef,
		``,
		`### Tool use hierarchy`,
		``,
		`Prefer Pi's native tools over bash:`,
		``,
		`1. **Reading files:** \`read\` > \`grep\` > \`find\` > \`ls\` > \`ast_search\` > bash`,
		`2. **Editing files:** \`edit\` (anchored) > \`write\` (create/rewrite)`,
		`3. **Web/HTTP:** \`web_search\` / \`web_fetch\` — never use \`curl\` or \`wget\` in bash`,
		`4. **Large output:** \`mcp ctx_execute\` — runs in sandbox, only summary enters context`,
		`5. **Bash:** only for mutations (git, npm, mkdir) and quick checks`,
		``,
		`### File reading rules`,
		``,
		`- Never use \`cat\`, \`head\`, \`tail\`, \`bat\`, \`less\`, or \`more\` via bash. Use the \`read\` tool.`,
		`- Use \`offset\`/\`limit\` on files above ~50 lines. Search first, then read the range.`,
		`- Pattern: **Search → Read → Act.** Find what you need, read only that section, then edit.`,
		``,
		`### Architecture principles`,
		``,
		`- Understand Pi's hook lifecycle before building extensions (\`tool_call\` pre, \`tool_result\` post, etc.).`,
		`- Prefer reactive over predictive — intercept output, don't predict it.`,
		`- Smallest effective intervention — don't build a 150-line regex whitelist when a 20-line truncator works.`,
		`- Know what already exists before adding new capabilities.`,
		``,
		`### Working style`,
		``,
		`- **Multiple approaches?** List them briefly and ask. Don't prototype all of them.`,
		`- **Ambiguous scope?** State what you understand and ask about the gap.`,
		`- **Unfamiliar API?** Spend ≤5 min reading types/docs, then ask for a pointer.`,
		`- **Improving working code?** Say what you'd change and why first.`,
		``,
		`Understand 80% → ask about the 20% → build the right thing once.`,
		``,
		`### Subagents`,
		``,
		`- Call \`subagent({ action: "list" })\` before delegating. Never guess agent names.`,
		`- Always set \`chainDir\` for chains and parallel tasks.`,
		`- Check \`~/.pi/agent/model-prompts/\` for model-specific delegation and workflow guidance.`,
		``,
		`### Skills`,
		``,
		`Check \`<available_skills>\` in the system prompt before starting specialized work.`,
		`Load a skill's \`SKILL.md\` when the task matches its description — don't reinvent guidance that already exists.`,
	].join("\n");
}

function generateFullAgentsMd(project: ProjectInfo, piRoot: string): string {
	const lines: string[] = [
		`# ${project.name}`,
		``,
	];

	if (project.description) {
		lines.push(project.description, ``);
	}

	if (project.type) {
		lines.push(`**Stack:** ${project.type}`, ``);
	}

	lines.push(generatePiSection(piRoot), ``);

	return lines.join("\n");
}

// ── Main extension ──────────────────────────────────────────────────

const PI_SECTION_MARKER = "## Pi Environment";

export default function initExtension(pi: ExtensionAPI) {
	pi.registerCommand("init", {
		description: "Initialize AGENTS.md with Pi-aware project context",
		handler: async (_args, ctx) => {
			const cwd = ctx.cwd;
			const agentsPath = join(cwd, "AGENTS.md");
			const project = detectProject(cwd);

			ctx.ui.setStatus("init", "🔍 Resolving Pi docs…");
			const piRoot = await resolvePiDocsRoot(pi);
			ctx.ui.setStatus("init", undefined);

			const piSection = generatePiSection(piRoot);

			if (existsSync(agentsPath)) {
				const existing = readFileSync(agentsPath, "utf-8");

				// Check if Pi section already exists
				if (existing.includes(PI_SECTION_MARKER)) {
					ctx.ui.notify("AGENTS.md already contains a Pi Environment section.", "info");
					return;
				}

				const action = await ctx.ui.select("AGENTS.md already exists", [
					"📎 Append Pi section",
					"🔄 Replace entirely",
					"✖ Cancel",
				]);

				if (!action || action.startsWith("✖")) return;

				if (action.startsWith("📎")) {
					const updated = existing.trimEnd() + "\n\n" + piSection + "\n";
					writeFileSync(agentsPath, updated, "utf-8");
					ctx.ui.notify(`✓ Appended Pi Environment section to AGENTS.md`, "success");
				} else {
					const content = generateFullAgentsMd(project, piRoot);
					writeFileSync(agentsPath, content, "utf-8");
					ctx.ui.notify(`✓ Replaced AGENTS.md for ${project.name}`, "success");
				}
			} else {
				const content = generateFullAgentsMd(project, piRoot);
				writeFileSync(agentsPath, content, "utf-8");
				ctx.ui.notify(`✓ Created AGENTS.md for ${project.name}`, "success");
			}
		},
	});
}
