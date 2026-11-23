import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withStatusChip } from "./toy-kit.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");
const TIMEOUT_MS = 30_000;

interface LintTarget {
	tool: "biome" | "ruff";
	command: string;
	args: string[];
	cwd: string;
	label: string;
}

function detectTarget(cwd: string, pathArg: string, fix: boolean): LintTarget | null {

	// Check if cwd is a Python project
	const hasPyproject = existsSync(join(cwd, "pyproject.toml"));
	const hasSetupPy = existsSync(join(cwd, "setup.py"));
	const isPython = hasPyproject || hasSetupPy;

	// Check if cwd is inside extensions or is a TS/JS project
	const isExtensions = cwd.startsWith(EXTENSIONS_DIR);
	const hasBiomeJson = existsSync(join(cwd, "biome.json"));
	const hasPackageJson = existsSync(join(cwd, "package.json"));
	const isTS = hasBiomeJson || isExtensions;

	// Explicit path narrows the target
	const target = pathArg || ".";

	if (isPython) {
		return {
			tool: "ruff",
			command: "ruff",
			args: ["check", ...(fix ? ["--fix"] : []), "--statistics", "--", target],
			cwd,
			label: `ruff → ${cwd}`,
		};
	}

	if (isTS) {
		const biomeDir = hasBiomeJson ? cwd : EXTENSIONS_DIR;
		const checkTarget = pathArg ? join(cwd, pathArg) : cwd;
		return {
			tool: "biome",
			command: "bunx",
			args: ["--bun", "@biomejs/biome", "check", ...(fix ? ["--write"] : []), "--reporter=summary", "--", checkTarget],
			cwd: biomeDir,
			label: `biome → ${checkTarget}`,
		};
	}

	// Fallback: if cwd has no markers but we have a path arg, try extensions
	if (!pathArg && hasPackageJson) {
		return {
			tool: "biome",
			command: "bunx",
			args: ["--bun", "@biomejs/biome", "check", ...(fix ? ["--write"] : []), "--reporter=summary", "--", cwd],
			cwd,
			label: `biome → ${cwd}`,
		};
	}

	return null;
}

function parseBiomeResult(out: string): { errors: string; warnings: string } {
	const errorMatch = out.match(/Found (\d+) errors?\./);
	const warnMatch = out.match(/Found (\d+) warnings?\./);
	return {
		errors: errorMatch ? errorMatch[1] : "0",
		warnings: warnMatch ? warnMatch[1] : "0",
	};
}

function parseRuffResult(out: string): { errors: string; fixable: string } {
	const errMatch = out.match(/Found (\d+) errors?\./);
	const fixMatch = out.match(/\[.\] (\d+) fixable/);
	return {
		errors: errMatch ? errMatch[1] : "0",
		fixable: fixMatch ? fixMatch[1] : "0",
	};
}

export default function lintExtension(pi: ExtensionAPI) {
	pi.registerCommand("lint", {
		description:
			"Lint current project or Pi extensions. Auto-detects: Python → ruff, TS/JS → biome. Usage: /lint [path] [--fix]",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const wantsFix = trimmed.includes("--fix");
			const pathArg = trimmed.replace("--fix", "").trim();

			// Use session cwd, fall back to extensions dir
			const cwd = ctx.cwd ?? EXTENSIONS_DIR;
			const target = detectTarget(cwd, pathArg, wantsFix);

			if (!target) {
				ctx.ui.notify(
					"No lintable project detected (need pyproject.toml, biome.json, or be in extensions/)",
					"warning",
				);
				return;
			}

			await withStatusChip(ctx, "lint", async () => {
				ctx.ui.setStatus("lint", `🔍 ${target.tool} → linting...`);
				try {
					const { stdout: output } = await execFileAsync(target.command, target.args, {
						cwd: target.cwd,
						timeout: TIMEOUT_MS,
						encoding: "utf-8",
					});
					ctx.ui.notify(`✅ ${target.tool}: no issues found`, "info");
					if (output.trim()) ctx.ui.notify(output.trim().slice(0, 1000), "info");
				} catch (err: unknown) {
					const e = err as { stdout?: string; stderr?: string; code?: number };
					const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();

					if (target.tool === "biome" && e.code === 1) {
						const { errors, warnings } = parseBiomeResult(out);
						ctx.ui.notify(
							`⚠️ biome: ${errors} errors, ${warnings} warnings`,
							errors !== "0" ? "error" : "warning",
						);
					} else if (target.tool === "ruff" && e.code === 1) {
						const { errors, fixable } = parseRuffResult(out);
						ctx.ui.notify(
							`⚠️ ruff: ${errors} issues (${fixable} fixable with --fix)`,
							"warning",
						);
					} else {
						ctx.ui.notify(`${target.tool} failed (exit ${e.code})`, "error");
					}

					if (out) ctx.ui.notify(out.slice(0, 1000), e.code === 1 ? "warning" : "error");
				}
			});
		},
	});
}
