import assert from "node:assert/strict";
import { test } from "node:test";
import {
	default as transcriptSkin,
	applySkin,
	completeArgs,
	formatStatus,
	mapOutsideCode,
	maskSecrets,
	normalizeConfig,
	parseCommandArgs,
	quoteThinking,
	shortenPaths,
	type SkinContext,
	type TranscriptSkinConfig,
} from "./transcript-skin.ts";

const HOME = "/home/tester";

function config(overrides: Partial<TranscriptSkinConfig> = {}): TranscriptSkinConfig {
	return normalizeConfig({ enabled: true, maskSecrets: true, shortenPaths: true, quoteThinking: true, ...overrides });
}

function context(overrides: Partial<SkinContext> = {}): SkinContext {
	return { messageType: "assistant", isStreaming: false, availableWidth: 80, ...overrides };
}

// ── maskSecrets ────────────────────────────────────────────────

test("maskSecrets redacts credential-shaped tokens but keeps the identifying prefix", () => {
	assert.equal(maskSecrets("key sk-proj-abcdefghijklmnop0123"), "key sk-proj-••••••••");
	assert.equal(maskSecrets("token ghp_abcdefghijklmnop0123"), "token ghp_••••••••");
	assert.equal(maskSecrets("Authorization: Bearer abcdefghijklmnop0123"), "Authorization: Bearer ••••••••");
	assert.equal(maskSecrets("id AKIAIOSFODNN7EXAMPLE"), "id AKIA••••••••");
	assert.equal(maskSecrets("google AIzaSyA0123456789abcdefghijk_-x"), "google AIza••••••••");
});

test("maskSecrets leaves ordinary prose byte-identical", () => {
	const prose = "The speedtest toy now strips null header markers before calling fetch.";
	assert.equal(maskSecrets(prose), prose);
});

test("maskSecrets does not fire on short prefix-shaped words", () => {
	// Below the minimum entropy length — these are not credentials.
	assert.equal(maskSecrets("sk-short"), "sk-short");
	assert.equal(maskSecrets("Bearer x"), "Bearer x");
});

// ── shortenPaths ───────────────────────────────────────────────

test("shortenPaths rewrites the home prefix to a copy-safe tilde", () => {
	assert.equal(shortenPaths(`${HOME}/a/b.ts`, { home: HOME, availableWidth: 200 }), "~/a/b.ts");
});

test("shortenPaths keeps a full path when it fits the width budget", () => {
	const input = `${HOME}/.pi/agent/extensions/pi-powertoys/toys/speedtest.ts`;
	assert.equal(shortenPaths(input, { home: HOME, availableWidth: 200 }), "~/.pi/agent/extensions/pi-powertoys/toys/speedtest.ts");
});

test("shortenPaths elides the middle when the path exceeds the budget", () => {
	const input = `${HOME}/.pi/agent/extensions/pi-powertoys/toys/speedtest.ts`;
	assert.equal(shortenPaths(input, { home: HOME, availableWidth: 80 }), "~/…/toys/speedtest.ts");
});

test("shortenPaths treats trailing sentence punctuation as prose, not path", () => {
	const input = `see ${HOME}/very/long/path/that/keeps/going/well/past/budget/file.ts.`;
	assert.equal(shortenPaths(input, { home: HOME, availableWidth: 60 }), "see ~/…/budget/file.ts.");
});

test("shortenPaths returns the input unchanged when no path is present", () => {
	const prose = "no paths here at all";
	assert.equal(shortenPaths(prose, { home: HOME, availableWidth: 80 }), prose);
});

test("shortenPaths falls back to a default width when availableWidth is unusable", () => {
	const input = `${HOME}/a/b.ts`;
	assert.equal(shortenPaths(input, { home: HOME, availableWidth: 0 }), "~/a/b.ts");
	assert.equal(shortenPaths(input, { home: HOME, availableWidth: Number.NaN }), "~/a/b.ts");
});

// ── mapOutsideCode ─────────────────────────────────────────────

test("mapOutsideCode skips fenced blocks", () => {
	const markdown = ["prose", "```bash", "code", "```", "more prose"].join("\n");
	assert.equal(mapOutsideCode(markdown, () => "X"), ["X", "```bash", "code", "```", "X"].join("\n"));
});

test("mapOutsideCode honours tilde fences and ignores non-matching markers inside them", () => {
	const markdown = ["~~~text", "```", "still code", "~~~", "prose"].join("\n");
	assert.equal(mapOutsideCode(markdown, () => "X"), ["~~~text", "```", "still code", "~~~", "X"].join("\n"));
});

test("mapOutsideCode treats an unclosed fence as code through end of message", () => {
	const markdown = ["prose", "```bash", "streaming code"].join("\n");
	assert.equal(mapOutsideCode(markdown, () => "X"), ["X", "```bash", "streaming code"].join("\n"));
});

test("mapOutsideCode skips inline code spans but transforms surrounding prose", () => {
	assert.equal(mapOutsideCode("a `code` b", (segment) => segment.toUpperCase()), "A `code` B");
});

// ── quoteThinking ──────────────────────────────────────────────

test("quoteThinking blockquotes every line without dropping content", () => {
	assert.equal(quoteThinking("one\n\ntwo"), "> one\n>\n> two");
});

test("quoteThinking leaves already-quoted lines alone", () => {
	assert.equal(quoteThinking("> already"), "> already");
});

// ── applySkin pipeline ─────────────────────────────────────────

test("applySkin returns the input untouched when disabled", () => {
	const input = `${HOME}/a/b.ts sk-proj-abcdefghijklmnop0123`;
	assert.equal(applySkin(input, context(), config({ enabled: false }), HOME), input);
});

test("applySkin never rewrites paths inside code fences", () => {
	const markdown = [
		`prose ${HOME}/very/long/path/that/keeps/going/past/budget/file.ts`,
		"```bash",
		`cd ${HOME}/very/long/path/that/keeps/going/past/budget`,
		"```",
	].join("\n");

	const output = applySkin(markdown, context({ availableWidth: 40 }), config(), HOME);
	const lines = output.split("\n");

	assert.equal(lines[0], "prose ~/…/budget/file.ts");
	assert.equal(lines[2], `cd ${HOME}/very/long/path/that/keeps/going/past/budget`);
});

test("applySkin masks secrets inside code fences, where they actually appear", () => {
	const markdown = ["```bash", "export OPENAI_API_KEY=sk-proj-abcdefghijklmnop0123", "```"].join("\n");
	const output = applySkin(markdown, context(), config(), HOME);
	assert.ok(output.includes("sk-proj-••••••••"));
	assert.ok(!output.includes("abcdefghijklmnop0123"));
});

test("applySkin defers path shortening while streaming but still masks", () => {
	const input = `${HOME}/a/b.ts and sk-proj-abcdefghijklmnop0123`;
	const output = applySkin(input, context({ isStreaming: true }), config(), HOME);
	assert.ok(output.startsWith(`${HOME}/a/b.ts`), "path left alone mid-stream");
	assert.ok(output.endsWith("sk-proj-••••••••"), "secret masked on the first frame");
});

test("applySkin blockquotes only the thinking message type", () => {
	assert.equal(applySkin("idea", context({ messageType: "assistant-thinking" }), config(), HOME), "> idea");
	assert.equal(applySkin("idea", context({ messageType: "assistant" }), config(), HOME), "idea");
	assert.equal(applySkin("idea", context({ messageType: "user" }), config(), HOME), "idea");
});

// ── config and command parsing ─────────────────────────────────

test("normalizeConfig falls back to defaults for missing or malformed input", () => {
	assert.deepEqual(normalizeConfig(undefined), {
		enabled: true,
		maskSecrets: false,
		shortenPaths: true,
		quoteThinking: true,
	});
	assert.deepEqual(normalizeConfig("nonsense"), normalizeConfig(undefined));
	assert.equal(normalizeConfig({ maskSecrets: "yes" }).maskSecrets, false);
});

test("parseCommandArgs understands the documented verbs", () => {
	assert.deepEqual(parseCommandArgs(""), {});
	assert.deepEqual(parseCommandArgs("status"), {});
	assert.deepEqual(parseCommandArgs("on"), { enabled: true });
	assert.deepEqual(parseCommandArgs("off"), { enabled: false });
	assert.deepEqual(parseCommandArgs("mask on"), { maskSecrets: true });
	assert.deepEqual(parseCommandArgs("paths off"), { shortenPaths: false });
	assert.deepEqual(parseCommandArgs("thinking 0"), { quoteThinking: false });
});

test("parseCommandArgs rejects unknown keys and values", () => {
	assert.equal(parseCommandArgs("mask maybe"), null);
	assert.equal(parseCommandArgs("nonsense on"), null);
});

test("formatStatus names the display-only contract", () => {
	assert.ok(formatStatus(config()).startsWith("Transcript skin (display only"));
});

test("completeArgs suggests every verb on an empty prefix", () => {
	const items = completeArgs("") ?? [];
	assert.deepEqual(
		items.map((i) => i.value),
		["status", "on", "off", "mask", "paths", "thinking"],
	);
});

test("completeArgs narrows by prefix", () => {
	assert.deepEqual((completeArgs("ma") ?? []).map((i) => i.value), ["mask"]);
	// "o" matches both "on" and "off".
	assert.deepEqual((completeArgs("o") ?? []).map((i) => i.value), ["on", "off"]);
});

test("completeArgs offers on/off once a toggle key is typed", () => {
	assert.deepEqual(
		(completeArgs("mask ") ?? []).map((i) => i.value),
		["mask on", "mask off"],
	);
	// Values carry the key, because a suggestion replaces the whole argument.
	assert.deepEqual((completeArgs("thinking of") ?? []).map((i) => i.value), ["thinking off"]);
});

test("completeArgs declines where it has nothing useful to add", () => {
	assert.equal(completeArgs("zzz"), null);
	assert.equal(completeArgs("status "), null, "status takes no value");
	assert.equal(completeArgs("mask on "), null, "nothing follows a complete pair");
	assert.equal(completeArgs("mask zzz"), null);
});

test("every completion suggestion round-trips through parseCommandArgs", () => {
	// The two halves of the command must agree: anything offered must parse.
	for (const seed of ["", "mask ", "paths ", "thinking "]) {
		for (const item of completeArgs(seed) ?? []) {
			if (!item.value.includes(" ") && ["mask", "paths", "thinking"].includes(item.value)) {
				continue; // bare toggle key still needs its value
			}
			assert.notEqual(
				parseCommandArgs(item.value),
				null,
				`suggestion ${JSON.stringify(item.value)} must be accepted by parseCommandArgs`,
			);
		}
	}
});

test("transcriptSkin registers a transformer and a slash command without touching the model path", () => {
	let transformer: ((markdown: string, context: SkinContext) => string) | undefined;
	let commandName: string | undefined;
	let options: { getArgumentCompletions?: unknown } | undefined;

	const stub = {
		registerMarkdownTransformer(fn: (markdown: string, context: SkinContext) => string) {
			transformer = fn;
		},
		registerCommand(name: string, opts: { getArgumentCompletions?: unknown }) {
			commandName = name;
			options = opts;
		},
	} as unknown as Parameters<typeof transcriptSkin>[0];

	transcriptSkin(stub);

	assert.equal(commandName, "transcript-skin");
	assert.equal(typeof transformer, "function");
	assert.equal(typeof options?.getArgumentCompletions, "function");

	// Whatever the stored config says, the transformer must return a string and
	// never throw — a cosmetic rule may not be able to break rendering.
	const out = transformer?.("plain text", context());
	assert.equal(typeof out, "string");
});