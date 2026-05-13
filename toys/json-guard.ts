/**
 * json-guard — Post-edit JSON syntax validator.
 *
 * After any edit/write to a .json file, reads it back and tries JSON.parse.
 * If parsing fails, appends a warning to the tool result so the model
 * knows to fix it immediately — same idea as Pi's syntax-regression
 * validator for Rust/C/Java, but for JSON.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TAG = "[json-guard]";

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => String(part.text ?? ""))
		.join("\n");
}

function contentWithText(text: string) {
	return [{ type: "text" as const, text }];
}

function extractPath(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const obj = input as Record<string, unknown>;
	return typeof obj.path === "string" ? obj.path : undefined;
}

function isJsonPath(path: string): boolean {
	return path.endsWith(".json");
}

function validateJsonFile(path: string): { valid: boolean; error?: string } {
	try {
		const content = readFileSync(path, "utf-8");
		JSON.parse(content);
		return { valid: true };
	} catch (err: any) {
		return { valid: false, error: err?.message ?? "Unknown parse error" };
	}
}

export default function jsonGuard(pi: ExtensionAPI) {
	pi.on("tool_result", (event: any) => {
		try {
			const toolName = String(event?.toolName ?? "").toLowerCase();
			if (toolName !== "edit" && toolName !== "write") return;

			const filePath = extractPath(event?.input);
			if (!filePath || !isJsonPath(filePath)) return;

			// Skip if the edit itself already failed
			if (event?.isError) return;

			const resolved = resolve(filePath);
			const result = validateJsonFile(resolved);

			if (!result.valid) {
				const text = textFromContent(event?.content);
				const warning =
					`\n\n${TAG} JSON syntax error in ${filePath}:\n` +
					`${result.error}\n` +
					`Fix this before continuing. Re-read the file, find the syntax error, and correct it.`;
				return {
					content: contentWithText(text + warning),
					isError: true,
				};
			}
		} catch {
			// Fail open — guard should never break normal tool use.
		}
	});
}
