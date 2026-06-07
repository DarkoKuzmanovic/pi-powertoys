/**
 * session-guard — Small safety/coaching hooks from real session failures.
 *
 * Covers:
 * - startup health checks for broken extension symlinks
 * - bash preflight for missing cwd, simple git commands outside repos, and obvious destructive rm
 * - bash result reclassification for guardrail/no-match false errors
 * - edit anchor mismatch hints with fresh anchors extracted from the tool output
 * - provider status notices for 429/5xx responses
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textFromContent, contentWithText } from "./toy-kit.ts";

const EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");
const PROVIDER_NOTICE_COOLDOWN_MS = 60_000;
const EDIT_MISMATCH_MARKER = "[session-guard] Fresh anchor hints:";


function findGitRoot(startDir: string): string | undefined {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function cwdFromEvent(event: any): string {
	const inputCwd = event?.input?.cwd;
	if (typeof inputCwd === "string" && inputCwd.trim()) {
		return isAbsolute(inputCwd) ? inputCwd : resolve(process.cwd(), inputCwd);
	}
	return process.cwd();
}

function isSimpleGitCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!/^git\b/.test(trimmed)) return false;
	if (/^git\s+-C\s+\S+/.test(trimmed)) return false;
	return true;
}

function hasDangerousRm(command: string): boolean {
	const compact = command.replace(/\s+/g, " ").trim();
	if (!/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/.test(compact)) return false;
	return /\s(\/|~|\$HOME|\.\.|\.)(\s|$)/.test(compact) || /\.pi\/agent/.test(compact);
}

function brokenExtensionSymlinks(): string[] {
	try {
		if (!existsSync(EXTENSIONS_DIR)) return [];
		return readdirSync(EXTENSIONS_DIR)
			.filter((name) => name.endsWith(".ts"))
			.filter((name) => {
				const path = join(EXTENSIONS_DIR, name);
				try {
					const stat = lstatSync(path);
					if (!stat.isSymbolicLink()) return false;
					realpathSync(path);
					return false;
				} catch {
					return true;
				}
			});
	} catch {
		return [];
	}
}

function isGuardrailCoaching(text: string): boolean {
	return (
		text.includes("Use ctx_fetch_and_index instead of") ||
		text.includes("Use ctx_execute instead of") ||
		text.includes("Bash is for mutations/navigation only") ||
		text.includes("Plan mode: bash command blocked")
	);
}

function isHarmlessBashMiss(command: string, text: string): boolean {
	if (!text.includes("Command exited with code 1")) return false;
	if (!/\b(grep|rg|fd)\b/.test(command)) return false;
	const cleaned = text
		.replace(/Command exited with code 1/g, "")
		.replace(/\[Hint:[\s\S]*?\]/g, "")
		.replace(/\(no output\)/g, "")
		.trim();
	return cleaned.length === 0;
}

function extractFreshAnchors(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.match(/>>>\s*(\d+:[a-f0-9]+\|.*)$/i)?.[1])
		.filter((line): line is string => Boolean(line))
		.slice(0, 8);
}

export default function sessionGuard(pi: ExtensionAPI) {
	const providerNoticeAt = new Map<number, number>();

	pi.on("session_start", async (_event, ctx) => {
		const broken = brokenExtensionSymlinks();
		if (broken.length > 0) {
			ctx.ui.notify(
				`session-guard: broken extension symlink(s): ${broken.join(", ")}. ` +
					`Run pi-powertoys install or remove stale links.`,
				"warning",
			);
		}
	});

	pi.on("tool_call", (event: any) => {
		try {
			const toolName = String(event?.toolName ?? "").toLowerCase();
			if (toolName !== "bash") return;

			const command = String(event?.input?.command ?? "").trim();
			if (!command) return;

			const cwd = cwdFromEvent(event);
			if (!existsSync(cwd)) {
				return {
					block: true,
					reason: `session-guard: working directory does not exist: ${cwd}`,
				};
			}

			if (isSimpleGitCommand(command) && !findGitRoot(cwd)) {
				return {
					block: true,
					reason: `session-guard: this is not a git repository: ${cwd}. Use ls/find first or run git -C <repo>.`,
				};
			}

			if (hasDangerousRm(command)) {
				return {
					block: true,
					reason: "session-guard: blocked broad rm -rf. Use a precise path or a recoverable trash/move operation.",
				};
			}
		} catch {
			// Fail open; this guard should never break normal tool use.
		}
	});

	pi.on("tool_result", (event: any) => {
		try {
			const toolName = String(event?.toolName ?? "").toLowerCase();
			const text = textFromContent(event?.content);
			if (!text) return;

			if (toolName === "bash") {
				const command = String(event?.input?.command ?? "");
				if (event?.isError && (isGuardrailCoaching(text) || isHarmlessBashMiss(command, text))) {
					return { isError: false };
				}
				if (event?.isError && /✓ Build successful|Build successful/i.test(text)) {
					return { isError: false };
				}
			}

			if (toolName === "edit" && !text.includes(EDIT_MISMATCH_MARKER)) {
				const anchors = extractFreshAnchors(text);
				if (anchors.length > 0) {
					const hint =
						`\n\n${EDIT_MISMATCH_MARKER}\n` +
						anchors.map((anchor) => `- ${anchor}`).join("\n") +
						"\nRetry with these current anchors, or re-read if the intended block moved farther away.";
					return { content: contentWithText(text + hint) };
				}
			}
		} catch {
			// Pass through unchanged on guard failure.
		}
	});

	pi.on("after_provider_response", (event: any, ctx) => {
		try {
			const status = Number(event?.status);
			if (![429, 500, 502, 503, 504].includes(status)) return;

			const now = Date.now();
			const last = providerNoticeAt.get(status) ?? 0;
			if (now - last < PROVIDER_NOTICE_COOLDOWN_MS) return;
			providerNoticeAt.set(status, now);

			const retryAfter = event?.headers?.["retry-after"];
			const suffix = retryAfter ? ` Retry-After: ${retryAfter}.` : "";
			ctx.ui.notify(
				`session-guard: provider returned HTTP ${status}.${suffix} ` +
					`If the turn aborts, retry with another model/provider.`,
				status === 429 ? "warning" : "error",
			);
		} catch {
			// Notification only.
		}
	});
}
