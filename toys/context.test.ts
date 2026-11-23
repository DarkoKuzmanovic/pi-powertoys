import assert from "node:assert/strict";
import { test } from "node:test";
import contextExtension from "./context.ts";

test("context counts Pi toolCall blocks and labels pre-compaction size", async () => {
	let handler: Function = () => {};
	contextExtension({ registerCommand: (_: string, command: any) => { handler = command.handler; } } as any);
	const entries = [
		{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", api: "test", provider: "test", model: "test", timestamp: 0 } },
		{ type: "compaction", id: "b", parentId: "a", timestamp: "2026-01-01", summary: "summary", firstKeptEntryId: "a", tokensBefore: 10000 },
	];
	let output = "";
	await handler("", { getContextUsage: () => ({ tokens: 100, contextWindow: 100000, percent: 0.1 }), model: { id: "test" }, getSystemPrompt: () => "system", sessionManager: { getBranch: () => entries, getLeafId: () => "b" }, ui: { custom: async (render: Function) => { const component = render({}, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, () => {}); output = component.render(150).join("\n"); } } });
	assert.match(output, /Tool calls: 1/);
	assert.match(output, /before compaction.*10\.0k/i);
	assert.doesNotMatch(output, /saved.*10\.0k/i);
});
