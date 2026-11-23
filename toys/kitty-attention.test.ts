import assert from "node:assert/strict";
import { test } from "node:test";
import kittyAttention from "./kitty-attention.ts";

test("completion alerts wait for agent_settled while question alerts remain registered", () => {
	const handlers: Record<string, Function> = {};
	kittyAttention({ on: (name: string, handler: Function) => { handlers[name] = handler; }, registerCommand: () => {} } as any);
	assert.equal(handlers.agent_end, undefined);
	assert.equal(typeof handlers.agent_settled, "function");
	assert.equal(typeof handlers.tool_call, "function");
});
