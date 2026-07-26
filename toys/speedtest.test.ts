import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import speedTestExtension from "./speedtest.ts";

type CapturedHandler = (args: string, ctx: unknown) => Promise<void>;

test("speedtest sends xai-responses through the Grok CLI proxy contract", async () => {
	let handler: CapturedHandler | undefined;
	const pi = {
		registerCommand(name: string, definition: { handler: CapturedHandler }) {
			assert.equal(name, "speedtest");
			handler = definition.handler;
		},
	} as unknown as ExtensionAPI;
	speedTestExtension(pi);
	assert.ok(handler);

	const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
	const notifications: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		requests.push({
			url: String(input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
		});
		const sse = [
			'data: {"type":"response.output_text.delta","delta":"ok"}',
			'data: {"choices":[{"delta":{"content":"ok"}}]}',
			'data: {"type":"response.usage","usage":{"output_tokens":1}}',
			"data: [DONE]",
			"",
		].join("\n");
		return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
	};

	try {
		await handler("1", {
			model: {
				provider: "xai-auth",
				id: "grok-4.5",
				name: "Grok 4.5",
				api: "xai-responses",
				baseUrl: "https://cli-chat-proxy.grok.com/v1",
			},
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "oauth-token", headers: {} }),
			},
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
				setStatus() {},
			},
		});
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(requests.length, 2, "warm-up and measurement requests should both use the xAI adapter");
	for (const request of requests) {
		assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/responses");
		assert.equal(request.headers.get("authorization"), "Bearer oauth-token");
		assert.equal(request.headers.get("x-xai-token-auth"), "xai-grok-cli");
		assert.equal(request.headers.get("x-authenticateresponse"), "authenticate-response");
		assert.equal(request.headers.get("x-grok-client-identifier"), "pi-powertoys");
		assert.match(request.headers.get("x-grok-client-version") ?? "", /^\d+\.\d+\.\d+$/);
		assert.equal(request.headers.get("x-grok-model-override"), "grok-4.5");
		assert.ok(request.headers.get("x-grok-conv-id"));
		assert.ok(request.headers.get("x-grok-req-id"));
		assert.ok(request.headers.get("x-grok-session-id"));
		assert.equal(request.body.model, "grok-4.5");
		assert.equal(request.body.stream, true);
		assert.equal(typeof request.body.input, "string");
	}
	assert.equal(notifications.some((message) => message.includes("Speedtest failed")), false);
});
