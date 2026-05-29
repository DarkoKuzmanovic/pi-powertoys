import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

const TOY_KEY = "kittyAttention";
const DEFAULT_EXPIRE_MS = 8000;
const MAX_PAYLOAD_BYTES = 1800;
const BEL = "\x07";
const OSC = "\x1b]";
const ST = "\x1b\\";

type AttentionKind = "done" | "question" | "attention";

export interface KittyAttentionConfig {
	enabled: boolean;
	popup: boolean;
	bell: boolean;
	notifyOnDone: boolean;
	notifyOnQuestion: boolean;
	notifyOnAttention: boolean;
	expireMs: number;
}

export interface KittyNotificationInput {
	id: string;
	title: string;
	body: string;
	expireMs: number;
}

export type EnvLike = Record<string, string | undefined>;

const DEFAULT_CONFIG: KittyAttentionConfig = {
	enabled: true,
	popup: true,
	bell: true,
	notifyOnDone: true,
	notifyOnQuestion: true,
	notifyOnAttention: true,
	expireMs: DEFAULT_EXPIRE_MS,
};

export function normalizeConfig(raw: unknown): KittyAttentionConfig {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
	const value = raw as Partial<KittyAttentionConfig>;
	return {
		enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CONFIG.enabled,
		popup: typeof value.popup === "boolean" ? value.popup : DEFAULT_CONFIG.popup,
		bell: typeof value.bell === "boolean" ? value.bell : DEFAULT_CONFIG.bell,
		notifyOnDone: typeof value.notifyOnDone === "boolean" ? value.notifyOnDone : DEFAULT_CONFIG.notifyOnDone,
		notifyOnQuestion:
			typeof value.notifyOnQuestion === "boolean" ? value.notifyOnQuestion : DEFAULT_CONFIG.notifyOnQuestion,
		notifyOnAttention:
			typeof value.notifyOnAttention === "boolean" ? value.notifyOnAttention : DEFAULT_CONFIG.notifyOnAttention,
		expireMs:
			typeof value.expireMs === "number" && Number.isFinite(value.expireMs) && value.expireMs >= 0
				? Math.floor(value.expireMs)
				: DEFAULT_CONFIG.expireMs,
	};
}

export function shouldEmitKittyPopup(env: EnvLike = process.env): boolean {
	if (env.PI_KITTY_ATTENTION_FORCE === "1") return true;
	if (env.KITTY_WINDOW_ID && env.KITTY_WINDOW_ID.trim()) return true;
	return env.TERM?.toLowerCase().includes("kitty") ?? false;
}

export function buildKittyNotification(input: KittyNotificationInput): string {
	const id = sanitizeMetadataValue(input.id, "pi-attention");
	const expireMs = Math.max(0, Math.floor(input.expireMs));
	const metaPrefix = `i=${id}:`;
	const metaSuffix = `:e=1:w=${expireMs}`;
	const title = base64Payload(input.title);
	const body = base64Payload(input.body);

	return (
		`${OSC}99;${metaPrefix}d=0:p=title${metaSuffix};${title}${ST}` +
		`${OSC}99;${metaPrefix}d=1:p=body${metaSuffix};${body}${ST}`
	);
}

export function parseCommandArgs(args: string): Partial<KittyAttentionConfig> | null {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length === 0 || parts[0] === "status") return {};
	if (parts[0] === "on") return { enabled: true };
	if (parts[0] === "off") return { enabled: false };

	const [key, value] = parts;
	if (!key || !value) return null;

	if (key === "popup") return parseBooleanPatch(value, "popup");
	if (key === "bell") return parseBooleanPatch(value, "bell");
	if (key === "done") return parseBooleanPatch(value, "notifyOnDone");
	if (key === "question") return parseBooleanPatch(value, "notifyOnQuestion");
	if (key === "attention") return parseBooleanPatch(value, "notifyOnAttention");
	if (key === "expire") {
		const expireMs = Number.parseInt(value, 10);
		if (!Number.isFinite(expireMs) || expireMs < 0) return null;
		return { expireMs };
	}

	return null;
}

export default function kittyAttention(pi: ExtensionAPI): void {
	let config = normalizeConfig(loadToyConfig<Partial<KittyAttentionConfig>>(TOY_KEY));

	function saveConfig(next: KittyAttentionConfig): void {
		config = next;
		saveToyConfig(TOY_KEY, next);
	}

	function patchConfig(patch: Partial<KittyAttentionConfig>): KittyAttentionConfig {
		const next = normalizeConfig({ ...config, ...patch });
		saveConfig(next);
		return next;
	}

	function emit(kind: AttentionKind, title: string, body: string): void {
		if (!config.enabled) return;
		if (!isKindEnabled(config, kind)) return;
		const canWriteTerminal = process.stdout.isTTY || process.env.PI_KITTY_ATTENTION_FORCE === "1";
		if (!canWriteTerminal) return;

		try {
			if (config.bell) process.stdout.write(BEL);
			if (config.popup && shouldEmitKittyPopup()) {
				process.stdout.write(
					buildKittyNotification({
						id: `pi-${kind}-${Date.now().toString(36)}`,
						title,
						body,
						expireMs: config.expireMs,
					}),
				);
			}
		} catch {
			// Terminal notification is best-effort. Never let it affect the agent turn.
		}
	}

	pi.on("tool_call", (event) => {
		const toolName = event.toolName.toLowerCase();
		if (toolName === "ask_user") {
			emit("question", "Pi needs an answer", extractQuestionText(event.input));
			return;
		}

		if (isAttentionTool(toolName, event.input)) {
			emit("attention", "Pi needs attention", describeAttentionTool(toolName));
		}
	});

	pi.on("agent_end", () => {
		emit("done", "Pi turn complete", "The LLM turn has finished.");
	});

	pi.registerCommand("kitty-attention", {
		description:
			"Configure Kitty terminal popup/bell alerts. Usage: /kitty-attention [on|off|status|test|popup on|off|bell on|off|done on|off|question on|off|attention on|off|expire <ms>]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed.toLowerCase() === "test") {
				emit("attention", "Pi attention test", "Popup and bell test from /kitty-attention.");
				ctx.ui.notify("Sent Kitty attention test", "info");
				return;
			}

			const patch = parseCommandArgs(trimmed);
			if (patch === null) {
				ctx.ui.notify(
					"Usage: /kitty-attention [on|off|status|test|popup on|off|bell on|off|done on|off|question on|off|attention on|off|expire <ms>]",
					"error",
				);
				return;
			}

			const next = Object.keys(patch).length > 0 ? patchConfig(patch) : config;
			ctx.ui.notify(formatStatus(next), "info");
		},
	});
}

function parseBooleanPatch<K extends keyof KittyAttentionConfig>(
	value: string,
	key: K,
): Pick<KittyAttentionConfig, K> | null {
	if (value === "on" || value === "true" || value === "1") return { [key]: true } as Pick<KittyAttentionConfig, K>;
	if (value === "off" || value === "false" || value === "0") return { [key]: false } as Pick<KittyAttentionConfig, K>;
	return null;
}

function isKindEnabled(config: KittyAttentionConfig, kind: AttentionKind): boolean {
	if (kind === "done") return config.notifyOnDone;
	if (kind === "question") return config.notifyOnQuestion;
	return config.notifyOnAttention;
}

function isAttentionTool(toolName: string, input: unknown): boolean {
	if (toolName === "obsidian_write" || toolName === "obsidian_edit" || toolName === "obsidian_manage") {
		return !hasDryRun(input);
	}
	if (toolName === "obsidian_destroy") return !hasDryRun(input);
	if (toolName === "interactive_shell") return isInteractiveShellAttention(input);
	return false;
}

function describeAttentionTool(toolName: string): string {
	if (toolName.startsWith("obsidian_")) return "An Obsidian operation may need approval.";
	if (toolName === "interactive_shell") return "An interactive shell session is waiting in the overlay.";
	return "Pi is waiting for user attention.";
}

function hasDryRun(input: unknown): boolean {
	return isRecord(input) && input.dryRun === true;
}

function isInteractiveShellAttention(input: unknown): boolean {
	if (!isRecord(input)) return false;
	if (typeof input.attach === "string") return true;
	return input.mode === undefined || input.mode === "interactive";
}

function extractQuestionText(input: unknown): string {
	if (!isRecord(input)) return "A question is waiting in Pi.";
	const context = typeof input.context === "string" && input.context.trim() ? `${input.context.trim()}\n\n` : "";
	const question = typeof input.question === "string" && input.question.trim() ? input.question.trim() : "A question is waiting in Pi.";
	return truncateText(`${context}${question}`, 220);
}

function formatStatus(config: KittyAttentionConfig): string {
	return [
		"Kitty attention notifications:",
		`enabled: ${onOff(config.enabled)}`,
		`popup: ${onOff(config.popup)}${shouldEmitKittyPopup() ? "" : " (not Kitty; set PI_KITTY_ATTENTION_FORCE=1 to force)"}`,
		`bell: ${onOff(config.bell)}`,
		`done/question/attention: ${onOff(config.notifyOnDone)}/${onOff(config.notifyOnQuestion)}/${onOff(config.notifyOnAttention)}`,
		`expire: ${config.expireMs}ms`,
	].join("\n");
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

function base64Payload(text: string): string {
	return Buffer.from(truncateUtf8(text, MAX_PAYLOAD_BYTES), "utf8").toString("base64");
}

function truncateText(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function truncateUtf8(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	return `${buffer.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8").replace(/\uFFFD+$/u, "")}…`;
}

function sanitizeMetadataValue(value: string, fallback: string): string {
	const safe = value.replace(/[^a-zA-Z0-9\-_/+.,(){}[\]*&^%$#@!`~]/g, "-").slice(0, 128);
	return safe || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}
