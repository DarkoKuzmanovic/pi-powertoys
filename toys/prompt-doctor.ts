/**
 * prompt-doctor — Audits "always-on" prompt cost.
 *
 * /prompt-doctor — reports token cost breakdown, model-prompt overlap,
 * cross-file duplication, and dead paths in the always-on prompt files.
 *
 * Four checks:
 *   1. Cost breakdown — tokens (chars/4) per section (split on `^## `).
 *   2. Model-prompt overlap — sentences from the active model's prompt file
 *      that duplicate a line in AGENTS.md or APPEND_SYSTEM.md.
 *   3. Cross-file duplication — same overlap check between AGENTS.md and
 *      APPEND_SYSTEM.md (both directions).
 *   4. Dead paths — `~/...` and `/home/quzma/...` literals in the always-on
 *      files (plus BRAIN.md, ATLAS.md) that don't exist on disk.
 *
 * Overlap test: normalize whitespace+case, compare sentences of >= 8 words,
 * flag Jaccard word-overlap ratio >= 0.6.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ─────────────────────────────────────────────

const HOME = homedir();
const AGENTS_MD = join(HOME, ".pi", "agent", "AGENTS.md");
const APPEND_SYSTEM_MD = join(HOME, ".pi", "agent", "APPEND_SYSTEM.md");
const BRAIN_MD = join(HOME, ".pi", "agent", "BRAIN.md");
const ATLAS_MD = join(HOME, ".pi", "agent", "ATLAS.md");
const MODEL_PROMPTS_DIR = join(HOME, ".pi", "agent", "model-prompts");

const OVERLAP_THRESHOLD = 0.6;
const MIN_WORDS = 8;
const DEFAULT_VISIBLE_LINES = 30;

const OVERLAY_OPTIONS = {
	overlay: true as const,
	overlayOptions: {
		anchor: "center" as const,
		width: "90%" as const,
		minWidth: 60,
		maxHeight: "80%" as const,
	},
};

// ── Types ─────────────────────────────────────────────────

interface Section {
	name: string;
	content: string;
	startLine: number;
	lineCount: number;
	tokens: number;
}

interface DeadPath {
	path: string;
	line: number;
}

interface Overlap {
	sentence: string;
	matchedLine: string;
	ratio: number;
	line: number;
}

// ── Pure helpers (exported) ───────────────────────────────

/** Estimate token count from text length (chars / 4). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Split text into sections on `^## ` headings. */
export function splitSections(text: string): Section[] {
	if (text.trim().length === 0) return [];
	const lines = text.split("\n");
	const sections: Section[] = [];
	let currentName = "(preamble)";
	let currentStart = 1;
	let currentLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		if (line.startsWith("## ")) {
			if (currentLines.length > 0) {
				const content = currentLines.join("\n");
				sections.push({
					name: currentName,
					content,
					startLine: currentStart,
					lineCount: currentLines.length,
					tokens: estimateTokens(content),
				});
			}
			currentName = line.slice(3).trim();
			currentStart = i + 1;
			currentLines = [];
		} else {
			currentLines.push(line);
		}
	}
	if (currentLines.length > 0) {
		const content = currentLines.join("\n");
		sections.push({
			name: currentName,
			content,
			startLine: currentStart,
			lineCount: currentLines.length,
			tokens: estimateTokens(content),
		});
	}
	return sections;
}

/** Jaccard word-overlap ratio between two strings. */
export function overlapRatio(a: string, b: string): number {
	const setA = wordSet(a);
	const setB = wordSet(b);
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersection = 0;
	for (const word of setA) {
		if (setB.has(word)) intersection++;
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Find dead paths (~/... or /home/quzma/...) in text that don't exist on disk. */
export function findDeadPaths(text: string): DeadPath[] {
	const deadPaths: DeadPath[] = [];
	const lines = text.split("\n");
	const pathRegex = /(~\/[^\s"'`|]+|\/home\/quzma\/[^\s"'`|]+)/g;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		let match: RegExpExecArray | null;
		pathRegex.lastIndex = 0;
		while ((match = pathRegex.exec(line)) !== null) {
			let rawPath = match[0] as string;
			// Strip trailing punctuation
			rawPath = rawPath.replace(/[.,)]+$/, "");
			// Expand ~ to home
			const expanded = rawPath.startsWith("~/")
				? join(HOME, rawPath.slice(2))
				: rawPath;
			if (!existsSync(expanded)) {
				deadPaths.push({ path: rawPath, line: i + 1 });
			}
		}
	}
	return deadPaths;
}

// ── Internal helpers ──────────────────────────────────────

function readTextFile(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordSet(s: string): Set<string> {
	const normalized = normalize(s);
	if (normalized.length === 0) return new Set();
	return new Set(normalized.split(" "));
}

function countWords(s: string): number {
	return s.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Extract sentences (>= 8 words) from text — bullets and sentence fragments. */
function extractSentences(text: string): string[] {
	const lines = text.split("\n");
	const sentences: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		// Strip bullet/markdown prefixes
		const cleaned = trimmed.replace(/^[-*>\d.]+\s*/, "");
		// Split on sentence boundaries
		const parts = cleaned.split(/(?<=[.!?])\s+/);
		for (const part of parts) {
			if (countWords(part) >= MIN_WORDS) {
				sentences.push(part.trim());
			}
		}
		// Also check the full cleaned line as a sentence (for bullet points)
		if (countWords(cleaned) >= MIN_WORDS && !sentences.includes(cleaned)) {
			sentences.push(cleaned);
		}
	}
	return sentences;
}

/** Find sentences that overlap with any line in the target. */
function findOverlaps(
	sentences: string[],
	targetLines: string[],
	threshold: number,
): Overlap[] {
	const overlaps: Overlap[] = [];
	for (const sentence of sentences) {
		for (let i = 0; i < targetLines.length; i++) {
			const line = targetLines[i] as string;
			if (line.trim().length === 0) continue;
			const ratio = overlapRatio(sentence, line);
			if (ratio >= threshold) {
				overlaps.push({
					sentence,
					matchedLine: line,
					ratio,
					line: i + 1,
				});
			}
		}
	}
	return overlaps;
}

/** Resolve the active model's prompt file by filename stem. */
function resolveModelPromptFile(modelId: string): string | null {
	let files: string[];
	try {
		files = readdirSync(MODEL_PROMPTS_DIR).filter((f) => f.endsWith(".md"));
	} catch {
		return null;
	}

	const target = modelId.toLowerCase();
	let baseMatch: string | null = null;
	let variantMatch: string | null = null;

	for (const file of files) {
		const stem = file.toLowerCase().replace(/\.md$/, "");
		const baseStem = stem.split("@")[0] as string;
		if (baseStem === target) {
			if (stem.includes("@")) {
				if (variantMatch === null) variantMatch = file;
			} else {
				baseMatch = file;
				break;
			}
		}
	}

	const chosen = baseMatch ?? variantMatch;
	return chosen ? join(MODEL_PROMPTS_DIR, chosen) : null;
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ── Report builder ────────────────────────────────────────

interface FileSections {
	file: string;
	sections: Section[];
	totalTokens: number;
	totalChars: number;
}

interface ReportData {
	fileSections: FileSections[];
	combinedTokens: number;
	combinedChars: number;
	modelPrompt: { modelId: string; filePath: string; overlaps: Overlap[] } | null;
	crossFile: { aToB: Overlap[]; bToA: Overlap[] } | null;
	deadPaths: { file: string; paths: DeadPath[] }[];
	skipped: string[];
}

function collectReportData(modelId: string | null): ReportData {
	const skipped: string[] = [];

	const agentsMd = readTextFile(AGENTS_MD);
	const appendSystemMd = readTextFile(APPEND_SYSTEM_MD);

	if (!agentsMd) skipped.push("AGENTS.md (not found)");
	if (!appendSystemMd) skipped.push("APPEND_SYSTEM.md (not found)");

	// ── Check 1: Cost breakdown ──
	const fileSections: FileSections[] = [];
	let combinedTokens = 0;
	let combinedChars = 0;

	for (const [file, content] of [
		["AGENTS.md", agentsMd],
		["APPEND_SYSTEM.md", appendSystemMd],
	] as const) {
		if (!content) continue;
		const sections = splitSections(content);
		const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
		fileSections.push({
			file,
			sections,
			totalTokens,
			totalChars: content.length,
		});
		combinedTokens += totalTokens;
		combinedChars += content.length;
	}

	// ── Check 2: Model-prompt overlap ──
	let modelPrompt: ReportData["modelPrompt"] = null;
	if (modelId) {
		const modelPromptPath = resolveModelPromptFile(modelId);
		if (modelPromptPath) {
			const modelPromptText = readTextFile(modelPromptPath);
			if (modelPromptText) {
				const sentences = extractSentences(modelPromptText);
				const targetLines: string[] = [];
				if (agentsMd) targetLines.push(...agentsMd.split("\n"));
				if (appendSystemMd) targetLines.push(...appendSystemMd.split("\n"));
				const overlaps = findOverlaps(sentences, targetLines, OVERLAP_THRESHOLD);
				modelPrompt = { modelId, filePath: modelPromptPath, overlaps };
			} else {
				skipped.push(`model prompt file (${modelPromptPath} — unreadable)`);
			}
		} else {
			skipped.push(`model prompt for "${modelId}" (no matching file)`);
		}
	} else {
		skipped.push("model-prompt overlap (no active model)");
	}

	// ── Check 3: Cross-file duplication ──
	let crossFile: ReportData["crossFile"] = null;
	if (agentsMd && appendSystemMd) {
		const aSentences = extractSentences(agentsMd);
		const bSentences = extractSentences(appendSystemMd);
		const aLines = agentsMd.split("\n");
		const bLines = appendSystemMd.split("\n");
		crossFile = {
			aToB: findOverlaps(aSentences, bLines, OVERLAP_THRESHOLD),
			bToA: findOverlaps(bSentences, aLines, OVERLAP_THRESHOLD),
		};
	}

	// ── Check 4: Dead paths ──
	const deadPaths: { file: string; paths: DeadPath[] }[] = [];
	for (const [file, path] of [
		["AGENTS.md", AGENTS_MD],
		["APPEND_SYSTEM.md", APPEND_SYSTEM_MD],
		["BRAIN.md", BRAIN_MD],
		["ATLAS.md", ATLAS_MD],
	] as const) {
		const text = readTextFile(path);
		if (!text) {
			if (file === "AGENTS.md" || file === "APPEND_SYSTEM.md") continue;
			skipped.push(`${file} (not found)`);
			continue;
		}
		const paths = findDeadPaths(text);
		if (paths.length > 0) {
			deadPaths.push({ file, paths });
		}
	}

	return {
		fileSections,
		combinedTokens,
		combinedChars,
		modelPrompt,
		crossFile,
		deadPaths,
		skipped,
	};
}

function renderReportLines(data: ReportData, theme: Theme): string[] {
	const lines: string[] = [];
	const sep = (label: string): string =>
		theme.fg("border", `━━ ${label} ${"━".repeat(Math.max(0, 56 - label.length))}`);

	// ── Cost breakdown ──
	lines.push(sep("Cost Breakdown"));
	lines.push(
		` Combined per-turn total: ${theme.fg("accent", `~${data.combinedTokens.toLocaleString()} tokens`)} (${data.combinedChars.toLocaleString()} chars)`,
	);
	lines.push("");

	for (const fs of data.fileSections) {
		lines.push(
			` ${theme.fg("text", theme.bold(fs.file))} — ${fs.sections.length} sections, ~${fs.totalTokens.toLocaleString()} tokens (${fs.totalChars.toLocaleString()} chars)`,
		);
		lines.push(`   ${theme.fg("dim", "tokens  lines  start  name")}`);
		const sorted = [...fs.sections].sort((a, b) => b.tokens - a.tokens);
		for (const s of sorted) {
			lines.push(
				`   ${theme.fg("text", String(s.tokens).padStart(5))}  ${String(s.lineCount).padStart(5)}  ${theme.fg("dim", `L${s.startLine}`.padStart(5))}  ${s.name}`,
			);
		}
		lines.push("");
	}

	// ── Model-prompt overlap ──
	lines.push(sep("Model-Prompt Overlap"));
	if (data.modelPrompt) {
		const mp = data.modelPrompt;
		lines.push(` Model: ${theme.fg("accent", mp.modelId)}`);
		lines.push(` Prompt: ${theme.fg("dim", mp.filePath)}`);
		lines.push("");
		if (mp.overlaps.length === 0) {
			lines.push(` ${theme.fg("success", "✓")} No overlapping sentences found.`);
		} else {
			lines.push(
				` ${theme.fg("warning", "⚠")} ${mp.overlaps.length} sentence(s) overlap (>=${(OVERLAP_THRESHOLD * 100).toFixed(0)}% word-overlap) with always-on files:`,
			);
			for (const o of mp.overlaps) {
				lines.push('   ' + theme.fg("warning", '[' + o.ratio.toFixed(2) + ']') + ' "' + truncate(o.sentence, 100) + '"');
				lines.push('          ' + theme.fg("dim", '-> L' + o.line + ':') + ' "' + truncate(o.matchedLine, 100) + '"');
			}
		}
	} else {
		lines.push(` ${theme.fg("dim", "(skipped — see Skipped section)")}`);
	}
	lines.push("");

	// ── Cross-file duplication ──
	lines.push(sep("Cross-File Duplication"));
	if (data.crossFile) {
		const cf = data.crossFile;
		if (cf.aToB.length === 0 && cf.bToA.length === 0) {
			lines.push(` ${theme.fg("success", "✓")} No cross-file duplication found.`);
		} else {
			if (cf.aToB.length > 0) {
				lines.push(` AGENTS.md -> APPEND_SYSTEM.md: ${cf.aToB.length} overlap(s)`);
				for (const o of cf.aToB) {
					lines.push('   ' + theme.fg("warning", '[' + o.ratio.toFixed(2) + ']') + ' "' + truncate(o.sentence, 100) + '"');
					lines.push('          ' + theme.fg("dim", '-> L' + o.line + ':') + ' "' + truncate(o.matchedLine, 100) + '"');
				}
			}
			if (cf.bToA.length > 0) {
				lines.push(` APPEND_SYSTEM.md -> AGENTS.md: ${cf.bToA.length} overlap(s)`);
				for (const o of cf.bToA) {
					lines.push('   ' + theme.fg("warning", '[' + o.ratio.toFixed(2) + ']') + ' "' + truncate(o.sentence, 100) + '"');
					lines.push('          ' + theme.fg("dim", '-> L' + o.line + ':') + ' "' + truncate(o.matchedLine, 100) + '"');
				}
			}
		}
	} else {
		lines.push(` ${theme.fg("dim", "(skipped — need both AGENTS.md and APPEND_SYSTEM.md)")}`);
	}
	lines.push("");

	// ── Dead paths ──
	lines.push(sep("Dead Paths"));
	if (data.deadPaths.length === 0) {
		lines.push(` ${theme.fg("success", "✓")} No dead paths found.`);
	} else {
		for (const dp of data.deadPaths) {
			lines.push(` ${theme.fg("text", theme.bold(dp.file))}:`);
			for (const p of dp.paths) {
				lines.push(`   ${theme.fg("dim", `L${p.line}:`)} ${theme.fg("warning", p.path)}`);
			}
		}
	}
	lines.push("");

	// ── Skipped ──
	if (data.skipped.length > 0) {
		lines.push(sep("Skipped"));
		for (const s of data.skipped) {
			lines.push(` ${theme.fg("dim", `• ${s}`)}`);
		}
		lines.push("");
	}

	return lines;
}

// ── Scrollable overlay ────────────────────────────────────

interface OverlayOpts {
	title: string;
	subtitle: string;
	displayLines: string[];
	theme: Theme;
	done: () => void;
}

function createScrollableOverlay(opts: OverlayOpts): Component {
	let scrollOffset = 0;
	let visibleLines = DEFAULT_VISIBLE_LINES;

	function maxScroll(): number {
		return Math.max(0, opts.displayLines.length - visibleLines);
	}

	return {
		render(width: number): string[] {
			const th = opts.theme;
			const innerW = width - 2;
			const lines: string[] = [];

			const pad = (s: string, len: number): string => {
				const vis = visibleWidth(s);
				return s + " ".repeat(Math.max(0, len - vis));
			};
			const row = (content: string): string =>
				th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");
			const borderTop = th.fg("border", `╭${"─".repeat(innerW)}╮`);
			const borderSep = th.fg("border", `├${"─".repeat(innerW)}┤`);
			const borderBottom = th.fg("border", `╰${"─".repeat(innerW)}╯`);

			// Title
			const title = ` ${th.fg("accent", th.bold(opts.title))}  ${th.fg("dim", `(${opts.subtitle})`)}`;
			lines.push(borderTop, row(title));

			// Content
			const ms = maxScroll();
			scrollOffset = Math.max(0, Math.min(scrollOffset, ms));

			for (let i = 0; i < visibleLines; i++) {
				const lineIdx = scrollOffset + i;
				if (lineIdx < opts.displayLines.length) {
					const line = opts.displayLines[lineIdx] as string;
					lines.push(row(truncateToWidth(line, innerW)));
				} else {
					lines.push(row(th.fg("dim", "~")));
				}
			}

			// Footer
			lines.push(borderSep);
			const scrollPercent =
				opts.displayLines.length <= visibleLines
					? "All"
					: scrollOffset === 0
						? "Top"
						: scrollOffset >= ms
							? "Bot"
							: `${Math.round(((scrollOffset + visibleLines) / opts.displayLines.length) * 100)}%`;
			const stats = th.fg(
				"dim",
				` ${scrollOffset + 1}-${Math.min(scrollOffset + visibleLines, opts.displayLines.length)} of ${opts.displayLines.length} [${scrollPercent}] `,
			);
			const help = th.fg("dim", "↑↓ scroll · q close");
			lines.push(row(stats + help));
			lines.push(borderBottom);

			return lines;
		},

		handleInput(data: string): void {
			if (matchesKey(data, Key.escape) || data === "q") {
				opts.done();
				return;
			}
			if (matchesKey(data, Key.down) || data === "j") {
				scrollOffset = Math.min(scrollOffset + 1, maxScroll());
			} else if (matchesKey(data, Key.up) || data === "k") {
				scrollOffset = Math.max(0, scrollOffset - 1);
			} else if (matchesKey(data, Key.home) || data === "g") {
				scrollOffset = 0;
			} else if (matchesKey(data, Key.end) || data === "G") {
				scrollOffset = maxScroll();
			} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("f"))) {
				scrollOffset = Math.min(scrollOffset + visibleLines - 2, maxScroll());
			} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("b"))) {
				scrollOffset = Math.max(0, scrollOffset - (visibleLines - 2));
			} else if (matchesKey(data, Key.ctrl("d"))) {
				scrollOffset = Math.min(scrollOffset + Math.floor(visibleLines / 2), maxScroll());
			} else if (matchesKey(data, Key.ctrl("u"))) {
				scrollOffset = Math.max(0, scrollOffset - Math.floor(visibleLines / 2));
			}
		},

		invalidate(): void {
			// Stateless render — no caches to clear.
		},
	};
}

// ── Extension ─────────────────────────────────────────────

export default function promptDoctorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("prompt-doctor", {
		description:
			"Audit always-on prompt cost: token breakdown, model-prompt overlap, cross-file duplication, and dead paths.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const modelId = ctx.model?.id ?? null;
			const data = collectReportData(modelId);

			if (ctx.mode === "tui") {
				await ctx.ui.custom<void>(
					(_tui, theme, _kb, done) =>
						createScrollableOverlay({
							title: "Prompt Doctor",
							subtitle: `~${data.combinedTokens.toLocaleString()} tokens · ${data.skipped.length} skipped`,
							displayLines: renderReportLines(data, theme),
							theme,
							done,
						}),
					OVERLAY_OPTIONS,
				);
			} else {
				// Non-TUI fallback: brief summary via notify
				const parts: string[] = [
					`Combined: ~${data.combinedTokens.toLocaleString()} tokens (${data.combinedChars.toLocaleString()} chars)`,
				];
				if (data.modelPrompt) {
					parts.push(`Model-prompt overlaps: ${data.modelPrompt.overlaps.length}`);
				}
				if (data.crossFile) {
					parts.push(`Cross-file: ${data.crossFile.aToB.length + data.crossFile.bToA.length}`);
				}
				parts.push(`Dead paths: ${data.deadPaths.reduce((n, dp) => n + dp.paths.length, 0)}`);
				if (data.skipped.length > 0) {
					parts.push(`Skipped: ${data.skipped.length}`);
				}
				ctx.ui.notify(parts.join(" · "), "info");
			}
		},
	});
}
