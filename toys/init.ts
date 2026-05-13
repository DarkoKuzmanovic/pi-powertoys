/**
 * init — Initialize AGENTS.md with Pi-aware project context.
 *
 * /init — generates or updates AGENTS.md with:
 *   - Auto-detected Commands section (package manager, scripts, build/test/lint)
 *   - Pi Environment section (tool hierarchy, file rules, working style)
 *
 * Generated content lives inside HTML-comment fences so re-running /init
 * refreshes only the auto-generated block and preserves user prose around it.
 * Every write is preceded by a unified-diff confirm dialog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// ── Fence markers ───────────────────────────────────────────────────

const FENCE_VERSION = 2;
const FENCE_START_RE = /<!--\s*pi:init:start[^>]*-->/;
const FENCE_END_RE = /<!--\s*pi:init:end\s*-->/;
const LEGACY_PI_HEADING = "## Pi Environment";

function fenceStart(): string {
	const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
	return `<!-- pi:init:start v=${FENCE_VERSION} generated=${ts} -->`;
}
const FENCE_END = "<!-- pi:init:end -->";

// ── Project detection ───────────────────────────────────────────────

interface CommandSet {
	install?: string;
	dev?: string;
	build?: string;
	test?: string;
	lint?: string;
	format?: string;
	typecheck?: string;
	other?: Array<{ label: string; cmd: string }>;
}

interface ProjectInfo {
	name: string;
	type?: string;
	description?: string;
	languageVersion?: string;
	packageManager?: string;
	commands: CommandSet;
	monorepo?: { tool: string; packages?: string[] };
}

function readTextSafe(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

function detectPackageManager(cwd: string): string | undefined {
	if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "package-lock.json"))) return "npm";
	return undefined;
}

function detectLanguageVersion(cwd: string): string | undefined {
	const nvm = readTextSafe(join(cwd, ".nvmrc"));
	if (nvm) return `Node ${nvm.trim()}`;
	const py = readTextSafe(join(cwd, ".python-version"));
	if (py) return `Python ${py.trim()}`;
	const rust = readTextSafe(join(cwd, "rust-toolchain.toml")) || readTextSafe(join(cwd, "rust-toolchain"));
	if (rust) {
		const m = rust.match(/channel\s*=\s*"([^"]+)"/) || rust.match(/^(\S+)$/m);
		if (m) return `Rust ${m[1]}`;
	}
	const goMod = readTextSafe(join(cwd, "go.mod"));
	if (goMod) {
		const m = goMod.match(/^go\s+(\S+)/m);
		if (m) return `Go ${m[1]}`;
	}
	return undefined;
}

function detectMonorepo(cwd: string, pkg?: any): ProjectInfo["monorepo"] {
	if (existsSync(join(cwd, "pnpm-workspace.yaml"))) return { tool: "pnpm workspaces" };
	if (existsSync(join(cwd, "turbo.json"))) return { tool: "Turborepo" };
	if (existsSync(join(cwd, "nx.json"))) return { tool: "Nx" };
	if (pkg?.workspaces) return { tool: "npm/yarn workspaces" };
	const cargo = readTextSafe(join(cwd, "Cargo.toml"));
	if (cargo && /^\[workspace\]/m.test(cargo)) return { tool: "Cargo workspace" };
	return undefined;
}

// Pick the npm script for a given semantic role. Returns the script name, not the command.
function pickScript(scripts: Record<string, string>, candidates: string[]): string | undefined {
	for (const c of candidates) if (scripts[c]) return c;
	// Loose match on prefix (e.g. "test:unit" if "test" missing)
	for (const c of candidates) {
		const found = Object.keys(scripts).find((s) => s === c || s.startsWith(`${c}:`));
		if (found) return found;
	}
	return undefined;
}

function detectNodeCommands(scripts: Record<string, string>, pm: string): CommandSet {
	const run = (script: string) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);
	const installCmd = pm === "npm" ? "npm install" : pm === "bun" ? "bun install" : `${pm} install`;
	const cs: CommandSet = { install: installCmd };
	const dev = pickScript(scripts, ["dev", "start", "serve"]);
	if (dev) cs.dev = run(dev);
	const build = pickScript(scripts, ["build", "compile"]);
	if (build) cs.build = run(build);
	const test = pickScript(scripts, ["test", "test:unit"]);
	if (test) cs.test = run(test);
	const lint = pickScript(scripts, ["lint", "check"]);
	if (lint) cs.lint = run(lint);
	const format = pickScript(scripts, ["format", "fmt"]);
	if (format) cs.format = run(format);
	const tc = pickScript(scripts, ["typecheck", "type-check", "tsc"]);
	if (tc) cs.typecheck = run(tc);
	return cs;
}

function detectMakefileTargets(cwd: string): Array<{ label: string; cmd: string }> {
	const mk = readTextSafe(join(cwd, "Makefile"));
	if (!mk) return [];
	const targets = new Set<string>();
	for (const line of mk.split("\n")) {
		const m = line.match(/^([a-zA-Z][a-zA-Z0-9_.-]*):/);
		if (m && !line.includes("=")) targets.add(m[1]);
	}
	const known = ["dev", "build", "test", "lint", "format", "fmt", "check", "run", "install"];
	return known.filter((t) => targets.has(t)).map((t) => ({ label: t, cmd: `make ${t}` }));
}

function detectProject(cwd: string): ProjectInfo {
	const name = basename(cwd) || "project";
	const languageVersion = detectLanguageVersion(cwd);

	// Node / JS / TS
	const pkgRaw = readTextSafe(join(cwd, "package.json"));
	if (pkgRaw) {
		try {
			const pkg = JSON.parse(pkgRaw);
			const pm = detectPackageManager(cwd) || "npm";
			const scripts = (pkg.scripts ?? {}) as Record<string, string>;
			return {
				name: pkg.name || name,
				type: "Node.js",
				description: pkg.description,
				languageVersion,
				packageManager: pm,
				commands: detectNodeCommands(scripts, pm),
				monorepo: detectMonorepo(cwd, pkg),
			};
		} catch {}
	}

	// Rust
	const cargo = readTextSafe(join(cwd, "Cargo.toml"));
	if (cargo) {
		const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
		return {
			name: nameMatch?.[1] || name,
			type: "Rust",
			languageVersion,
			commands: {
				build: "cargo build",
				test: "cargo test",
				lint: "cargo clippy --all-targets -- -D warnings",
				format: "cargo fmt",
			},
			monorepo: detectMonorepo(cwd),
		};
	}

	// Python
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"))) {
		const py = readTextSafe(join(cwd, "pyproject.toml")) || "";
		const cs: CommandSet = { test: "pytest" };
		if (/ruff/i.test(py)) {
			cs.lint = "ruff check .";
			cs.format = "ruff format .";
		}
		if (/mypy/i.test(py)) cs.typecheck = "mypy .";
		return { name, type: "Python", languageVersion, commands: cs };
	}

	// Go
	if (existsSync(join(cwd, "go.mod"))) {
		return {
			name,
			type: "Go",
			languageVersion,
			commands: {
				build: "go build ./...",
				test: "go test ./...",
				lint: "go vet ./...",
			},
		};
	}

	// Generic — still pick up Makefile if present
	const mk = detectMakefileTargets(cwd);
	return {
		name,
		commands: mk.length ? { other: mk } : {},
	};
}

// ── Pi docs resolution ──────────────────────────────────────────────

async function resolvePiDocsRoot(pi: ExtensionAPI): Promise<string> {
	try {
		const result = await pi.exec("node", [
			"-e",
			"console.log(require('path').dirname(require.resolve('@earendil-works/pi-coding-agent/package.json')))",
		]);
		if (result.exitCode === 0 && result.stdout.trim()) return result.stdout.trim();
	} catch {}
	return "";
}

// ── Section generators ──────────────────────────────────────────────

function generateCommandsSection(project: ProjectInfo): string | undefined {
	const c = project.commands;
	const rows: Array<[string, string]> = [];
	if (c.install) rows.push(["Install", c.install]);
	if (c.dev) rows.push(["Dev", c.dev]);
	if (c.build) rows.push(["Build", c.build]);
	if (c.test) rows.push(["Test", c.test]);
	if (c.lint) rows.push(["Lint", c.lint]);
	if (c.format) rows.push(["Format", c.format]);
	if (c.typecheck) rows.push(["Typecheck", c.typecheck]);
	if (c.other) for (const o of c.other) rows.push([o.label, o.cmd]);
	if (rows.length === 0) return undefined;

	const lines = ["## Commands", ""];
	if (project.packageManager) lines.push(`Package manager: \`${project.packageManager}\`.`, "");
	for (const [label, cmd] of rows) lines.push(`- **${label}:** \`${cmd}\``);
	lines.push("");
	if (project.monorepo) {
		lines.push(`**Monorepo:** ${project.monorepo.tool}. Scope commands with workspace flags as needed.`, "");
	}
	return lines.join("\n");
}

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

function generateFencedBlock(project: ProjectInfo, piRoot: string): string {
	const commands = generateCommandsSection(project);
	const parts = [fenceStart(), ""];
	if (commands) parts.push(commands, "");
	parts.push(generatePiSection(piRoot), "", FENCE_END);
	return parts.join("\n");
}

function generateFullAgentsMd(project: ProjectInfo, piRoot: string): string {
	const lines: string[] = [`# ${project.name}`, ``];
	if (project.description) lines.push(project.description, ``);
	const stackBits: string[] = [];
	if (project.type) stackBits.push(project.type);
	if (project.languageVersion) stackBits.push(project.languageVersion);
	if (stackBits.length) lines.push(`**Stack:** ${stackBits.join(" · ")}`, ``);
	lines.push(generateFencedBlock(project, piRoot), ``);
	return lines.join("\n");
}

// ── Diff utility (line-based LCS → +/- with context) ────────────────

function lineDiff(oldText: string, newText: string): { unified: string; added: number; removed: number } {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	const N = a.length;
	const M = b.length;
	// Bound LCS to avoid pathological memory on huge files (AGENTS.md is small).
	if (N * M > 2_000_000) {
		return {
			unified: `(files too large for inline diff — ${N} vs ${M} lines)`,
			added: M,
			removed: N,
		};
	}
	const lcs: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0));
	for (let i = N - 1; i >= 0; i--) {
		for (let j = M - 1; j >= 0; j--) {
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}
	type Op = { tag: "+" | "-" | " "; line: string };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < N && j < M) {
		if (a[i] === b[j]) {
			ops.push({ tag: " ", line: a[i] });
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			ops.push({ tag: "-", line: a[i++] });
		} else {
			ops.push({ tag: "+", line: b[j++] });
		}
	}
	while (i < N) ops.push({ tag: "-", line: a[i++] });
	while (j < M) ops.push({ tag: "+", line: b[j++] });

	// Group with 2 lines of context.
	const CTX = 2;
	const isChange = (o: Op) => o.tag !== " ";
	const hunks: string[] = [];
	let k = 0;
	while (k < ops.length) {
		if (!isChange(ops[k])) {
			k++;
			continue;
		}
		const start = Math.max(0, k - CTX);
		let end = k;
		while (end < ops.length) {
			if (isChange(ops[end])) {
				end++;
			} else {
				// Look ahead: if another change within CTX*2, keep absorbing.
				let lookahead = end;
				let nextChange = -1;
				while (lookahead < ops.length && lookahead - end <= CTX * 2) {
					if (isChange(ops[lookahead])) {
						nextChange = lookahead;
						break;
					}
					lookahead++;
				}
				if (nextChange >= 0) {
					end = nextChange;
				} else {
					break;
				}
			}
		}
		const stop = Math.min(ops.length, end + CTX);
		const slice = ops.slice(start, stop);
		hunks.push(slice.map((o) => `${o.tag} ${o.line}`).join("\n"));
		k = stop;
	}
	const added = ops.filter((o) => o.tag === "+").length;
	const removed = ops.filter((o) => o.tag === "-").length;
	return {
		unified: hunks.length ? hunks.join("\n…\n") : "(no textual changes)",
		added,
		removed,
	};
}

function truncate(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `${lines.slice(0, maxLines).join("\n")}\n… (${lines.length - maxLines} more lines)`;
}

// ── Conflict resolution ─────────────────────────────────────────────

interface ConflictPlan {
	kind: "create" | "fenced-update" | "legacy-migrate" | "append-fenced" | "replace-all" | "noop";
	nextContent: string;
	summary: string;
}

function planUpdate(existing: string | undefined, project: ProjectInfo, piRoot: string): ConflictPlan {
	const newBlock = generateFencedBlock(project, piRoot);

	if (existing === undefined) {
		return {
			kind: "create",
			nextContent: generateFullAgentsMd(project, piRoot),
			summary: "Create new AGENTS.md",
		};
	}

	const startMatch = existing.match(FENCE_START_RE);
	const endMatch = existing.match(FENCE_END_RE);
	if (startMatch && endMatch && endMatch.index! > startMatch.index!) {
		const before = existing.slice(0, startMatch.index!);
		const after = existing.slice(endMatch.index! + endMatch[0].length);
		const currentBlock = existing.slice(startMatch.index!, endMatch.index! + endMatch[0].length);
		const next = `${before}${newBlock}${after}`;
		if (currentBlock.trim() === newBlock.trim() || next === existing) {
			return { kind: "noop", nextContent: existing, summary: "Pi block already up to date" };
		}
		return {
			kind: "fenced-update",
			nextContent: next,
			summary: "Refresh fenced Pi block (preserves surrounding prose)",
		};
	}

	if (existing.includes(LEGACY_PI_HEADING)) {
		return {
			kind: "legacy-migrate",
			nextContent: existing, // chosen by user
			summary: "Legacy Pi section detected — choose how to upgrade",
		};
	}

	return {
		kind: "append-fenced",
		nextContent: `${existing.trimEnd()}\n\n${newBlock}\n`,
		summary: "Append fenced Pi block to existing AGENTS.md",
	};
}

// ── Main extension ──────────────────────────────────────────────────

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

			const existing = existsSync(agentsPath) ? readFileSync(agentsPath, "utf-8") : undefined;
			let plan = planUpdate(existing, project, piRoot);

			// Legacy migration branch — resolve to a concrete plan.
			if (plan.kind === "legacy-migrate" && existing) {
				const choice = await ctx.ui.select(
					"AGENTS.md has an old Pi section (no fences). How should /init upgrade it?",
					[
						"🔁 Migrate to fenced block (replace old section in place)",
						"📎 Add a new fenced block at the end (keep old section)",
						"🔄 Replace entire file",
						"✖ Cancel",
					],
				);
				if (!choice || choice.startsWith("✖")) {
					ctx.ui.notify("init cancelled", "info");
					return;
				}
				const newBlock = generateFencedBlock(project, piRoot);
				if (choice.startsWith("🔁")) {
					// Replace from "## Pi Environment" to the next top-level heading or EOF.
					const idx = existing.indexOf(LEGACY_PI_HEADING);
					const after = existing.slice(idx + LEGACY_PI_HEADING.length);
					const nextTopMatch = after.match(/\n##\s/);
					const tailStart = nextTopMatch ? idx + LEGACY_PI_HEADING.length + nextTopMatch.index! : existing.length;
					const before = existing.slice(0, idx).trimEnd();
					const tail = existing.slice(tailStart);
					plan = {
						kind: "fenced-update",
						nextContent: `${before}\n\n${newBlock}${tail}`,
						summary: "Migrate legacy Pi section to fenced block",
					};
				} else if (choice.startsWith("📎")) {
					plan = {
						kind: "append-fenced",
						nextContent: `${existing.trimEnd()}\n\n${newBlock}\n`,
						summary: "Append fenced Pi block alongside legacy section",
					};
				} else {
					plan = {
						kind: "replace-all",
						nextContent: generateFullAgentsMd(project, piRoot),
						summary: "Replace entire AGENTS.md",
					};
				}
			}

			if (plan.kind === "noop") {
				ctx.ui.notify("AGENTS.md Pi block is already up to date.", "info");
				return;
			}

			// Build diff preview.
			const diff = lineDiff(existing ?? "", plan.nextContent);
			const stats = `+${diff.added}  −${diff.removed}`;
			const preview = truncate(diff.unified, 120);
			const title = `${plan.summary}  (${stats})`;
			const message = [
				`File: ${agentsPath}`,
				`Action: ${plan.kind}`,
				`Project: ${project.name}${project.type ? ` (${project.type})` : ""}`,
				``,
				preview,
			].join("\n");

			const ok = await ctx.ui.confirm(title, message);
			if (!ok) {
				ctx.ui.notify("init cancelled", "info");
				return;
			}

			writeFileSync(agentsPath, plan.nextContent, "utf-8");
			ctx.ui.notify(`✓ ${plan.summary}`, "info");
		},
	});
}
