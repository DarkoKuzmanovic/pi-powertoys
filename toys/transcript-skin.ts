/**
 * transcript-skin — Display-only rewriting of transcript Markdown.
 *
 * Owns pi-powertoys' single `registerMarkdownTransformer` slot and runs an
 * ordered pipeline of individually-toggleable rules:
 *
 *   1. maskSecrets    — redact credential-shaped tokens (off by default)
 *   2. shortenPaths   — collapse long absolute paths to fit the terminal
 *   3. quoteThinking  — render thinking blocks as blockquotes
 *
 * Everything here is display-only: the model still receives the untouched
 * text. The transformer runs on *every repaint* — including every streaming
 * frame and every scroll tick — so each rule opens with the cheapest possible
 * bail-out and all regexes are module-level constants.
 */

import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

const TOY_KEY = "transcriptSkin";

/** Structural mirror of Pi's `MarkdownTransformContext`. */
export interface SkinContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

export interface TranscriptSkinConfig {
	enabled: boolean;
	maskSecrets: boolean;
	shortenPaths: boolean;
	quoteThinking: boolean;
}

const DEFAULT_CONFIG: TranscriptSkinConfig = {
	enabled: true,
	// Off by default: masking is a screenshare affordance, not an everyday one.
	maskSecrets: false,
	shortenPaths: true,
	quoteThinking: true,
};

export function normalizeConfig(raw: unknown): TranscriptSkinConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const value = raw as Partial<TranscriptSkinConfig>;
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CONFIG.enabled,
		maskSecrets: typeof value.maskSecrets === "boolean" ? value.maskSecrets : DEFAULT_CONFIG.maskSecrets,
		shortenPaths: typeof value.shortenPaths === "boolean" ? value.shortenPaths : DEFAULT_CONFIG.shortenPaths,
		quoteThinking: typeof value.quoteThinking === "boolean" ? value.quoteThinking : DEFAULT_CONFIG.quoteThinking,
	};
}

// ── Rule 1: secret masking ─────────────────────────────────────

const MASK = "••••••••";

/**
 * Cheap substring probes. A false positive only costs one regex sweep; a
 * false negative would leak, so these stay broader than the patterns below.
 */
const SECRET_HINTS: readonly string[] = [
	"sk-",
	"ghp_",
	"gho_",
	"ghu_",
	"ghs_",
	"ghr_",
	"github_pat_",
	"AKIA",
	"xox",
	"AIza",
	"earer ",
];

const SECRET_RULES: ReadonlyArray<readonly [RegExp, string]> = [
	[/\b(sk-(?:proj-|ant-api\d{2}-|or-v1-)?)[A-Za-z0-9_-]{16,}/g, `$1${MASK}`],
	[/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, `$1${MASK}`],
	[/\b(AKIA)[0-9A-Z]{12,}/g, `$1${MASK}`],
	[/\b(xox[baprs]-)[A-Za-z0-9-]{10,}/g, `$1${MASK}`],
	[/\b(AIza)[A-Za-z0-9_-]{20,}/g, `$1${MASK}`],
	[/(\bBearer\s+)[A-Za-z0-9._-]{16,}/gi, `$1${MASK}`],
];

/**
 * Redact credential-shaped tokens, keeping the recognisable prefix so the
 * reader can still tell *which kind* of key it was.
 *
 * Deliberately applied inside code fences too: leaked keys usually appear in
 * pasted commands and command output, which is exactly where fences are.
 */
export function maskSecrets(text: string): string {
	let hinted = false;
	for (const hint of SECRET_HINTS) {
		if (text.includes(hint)) {
			hinted = true;
			break;
		}
	}
	if (!hinted) return text;

	let out = text;
	for (const [pattern, replacement] of SECRET_RULES) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

// ── Rule 2: path shortening ────────────────────────────────────

const MIN_PATH_BUDGET = 32;
const FALLBACK_WIDTH = 80;
const TILDE_PATH_RE = /~(?:\/[A-Za-z0-9._@+-]+)+/g;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathBudget(availableWidth: number): number {
	const width = Number.isFinite(availableWidth) && availableWidth > 0 ? availableWidth : FALLBACK_WIDTH;
	return Math.max(MIN_PATH_BUDGET, Math.floor(width * 0.45));
}

/**
 * Collapse absolute home paths. `$HOME/x` becomes `~/x` unconditionally —
 * that stays copy-pasteable because shells expand `~`. Only when a path still
 * exceeds the width budget is its middle elided to `~/…/parent/leaf`, which
 * is *not* copy-safe and is therefore never applied inside code regions.
 */
export function shortenPaths(text: string, options: { home: string; availableWidth: number }): string {
	const { home } = options;
	const hasHome = home.length > 0 && text.includes(home);
	if (!hasHome && !text.includes("~/")) return text;

	const budget = pathBudget(options.availableWidth);
	const withTilde = hasHome ? text.replace(new RegExp(escapeRegExp(home), "g"), "~") : text;

	return withTilde.replace(TILDE_PATH_RE, (match) => {
		// Trailing sentence punctuation is not part of the path.
		let path = match;
		let trailing = "";
		while (path.length > 2 && (path.endsWith(".") || path.endsWith(","))) {
			trailing = `${path.slice(-1)}${trailing}`;
			path = path.slice(0, -1);
		}

		if (path.length <= budget) return `${path}${trailing}`;
		const segments = path.split("/");
		if (segments.length <= 3) return `${path}${trailing}`;
		return `~/…/${segments.slice(-2).join("/")}${trailing}`;
	});
}

// ── Rule 3: thinking blockquotes ───────────────────────────────

/**
 * Prefix every line with `> ` so themes render thinking dimmed and offset.
 * Nothing is removed — a string transformer has no way to offer an "expand"
 * affordance, so truncation would be unrecoverable.
 */
export function quoteThinking(text: string): string {
	if (!text) return text;
	return text
		.split("\n")
		.map((line) => (line.startsWith(">") ? line : line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

// ── Code-region protection ─────────────────────────────────────

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`[^`\n]*`)/g;

/**
 * Apply `fn` only to prose, never to fenced blocks or inline code spans.
 *
 * Inline detection handles single-backtick spans only; multi-backtick inline
 * spans are rare enough in practice that the extra parsing is not worth the
 * per-repaint cost.
 */
export function mapOutsideCode(markdown: string, fn: (segment: string) => string): string {
	const lines = markdown.split("\n");
	let fence: string | null = null;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		const match = FENCE_RE.exec(line);

		if (fence !== null) {
			// Inside a fence: only a matching, at-least-as-long marker closes it.
			if (match && match[1]?.[0] === fence[0] && (match[1]?.length ?? 0) >= fence.length) {
				fence = null;
			}
			continue;
		}

		if (match?.[1]) {
			fence = match[1];
			continue;
		}

		lines[index] = line
			.split(INLINE_CODE_RE)
			.map((segment, segmentIndex) => (segmentIndex % 2 === 1 ? segment : fn(segment)))
			.join("");
	}

	return lines.join("\n");
}

// ── Pipeline ───────────────────────────────────────────────────

export function applySkin(
	markdown: string,
	context: SkinContext,
	config: TranscriptSkinConfig,
	home: string,
): string {
	if (!config.enabled || !markdown) return markdown;

	let out = markdown;

	// Masking runs first, and runs while streaming: if it is on at all, the
	// user is sharing their screen and wants redaction on the very first frame.
	if (config.maskSecrets) out = maskSecrets(out);

	// Path elision is cosmetic, and widths jitter mid-stream — defer it.
	if (config.shortenPaths && !context.isStreaming) {
		out = mapOutsideCode(out, (segment) =>
			shortenPaths(segment, { home, availableWidth: context.availableWidth }),
		);
	}

	// Last: this adds `> ` prefixes that would break fence tracking above.
	if (config.quoteThinking && context.messageType === "assistant-thinking") {
		out = quoteThinking(out);
	}

	return out;
}

// ── Command parsing ────────────────────────────────────────────

export function parseCommandArgs(args: string): Partial<TranscriptSkinConfig> | null {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "status") return {};
	if (parts[0] === "on") return { enabled: true };
	if (parts[0] === "off") return { enabled: false };

	const [key, value] = parts;
	if (!key || !value) return null;

	if (key === "mask") return parseBooleanPatch(value, "maskSecrets");
	if (key === "paths") return parseBooleanPatch(value, "shortenPaths");
	if (key === "thinking") return parseBooleanPatch(value, "quoteThinking");

	return null;
}

function parseBooleanPatch<K extends keyof TranscriptSkinConfig>(
	value: string,
	key: K,
): Pick<TranscriptSkinConfig, K> | null {
	if (value === "on" || value === "true" || value === "1") return { [key]: true } as Pick<TranscriptSkinConfig, K>;
	if (value === "off" || value === "false" || value === "0") return { [key]: false } as Pick<TranscriptSkinConfig, K>;
	return null;
}

export function formatStatus(config: TranscriptSkinConfig): string {
	return [
		"Transcript skin (display only — the model still sees the original):",
		`enabled: ${onOff(config.enabled)}`,
		`mask secrets: ${onOff(config.maskSecrets)}`,
		`shorten paths: ${onOff(config.shortenPaths)}`,
		`quote thinking: ${onOff(config.quoteThinking)}`,
	].join("\n");
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

const USAGE = "Usage: /transcript-skin [on|off|status|mask on|off|paths on|off|thinking on|off]";

// ── Entry point ────────────────────────────────────────────────

export default function transcriptSkin(pi: ExtensionAPI): void {
	let config = normalizeConfig(loadToyConfig<Partial<TranscriptSkinConfig>>(TOY_KEY));
	const home = homedir();

	function patchConfig(patch: Partial<TranscriptSkinConfig>): TranscriptSkinConfig {
		config = normalizeConfig({ ...config, ...patch });
		saveToyConfig(TOY_KEY, config);
		return config;
	}

	pi.registerMarkdownTransformer((markdown, context) => {
		try {
			return applySkin(markdown, context as SkinContext, config, home);
		} catch {
			// Rendering must never break on a cosmetic rule.
			return markdown;
		}
	});

	pi.registerCommand("transcript-skin", {
		description: `Configure display-only transcript rewriting. ${USAGE}`,
		handler: async (args, ctx) => {
			const patch = parseCommandArgs(args);
			if (patch === null) {
				ctx.ui.notify(USAGE, "error");
				return;
			}

			const next = Object.keys(patch).length > 0 ? patchConfig(patch) : config;
			ctx.ui.notify(formatStatus(next), "info");
		},
	});
}
