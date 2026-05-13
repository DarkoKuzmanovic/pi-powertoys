/**
 * Intent Tracer — OMP-style intent annotations for tool calls.
 *
 * Injects a `_i` (intent) field into every tool's schema so the model
 * declares what it's trying to accomplish before each tool call.
 * Strips the field before validation so tools never see it.
 * Stores captured intents on globalThis for cross-extension access (e.g., pi-hud).
 *
 * Architecture:
 *   The model sees `_i` in every tool schema (via before_provider_request).
 *   Pi validates tool args against the ORIGINAL schema (without `_i`) in
 *   prepareToolCall(), which runs AFTER tool_execution_start but BEFORE tool_call.
 *   We strip `_i` in tool_execution_start — the earliest hook where args are
 *   accessible as a mutable reference to toolCall.arguments — so validation
 *   never sees the extra field.
 *
 * Hooks used:
 *   before_agent_start        — system prompt instruction
 *   before_provider_request   — schema injection into provider payload
 *   tool_execution_start      — strip _i BEFORE validation (args is a ref to toolCall.arguments)
 *
 * Kill switch: PI_INTENT_TRACING=0
 */

const INTENT_FIELD = "_i";
const INTENT_STORE_KEY = "__piIntentStore";

/** Tools where intent is obvious or adds no value */
const OMIT_TOOLS = new Set(["todo", "ask_user"]);

/**
 * Inject _i as the first property in a JSON Schema object.
 * Creates new objects — never mutates the input schema.
 */
function injectIntentIntoSchema(schema: any): any {
	if (!schema || typeof schema !== "object") return schema;
	const props = schema.properties;
	if (!props || typeof props !== "object") return schema;

	// Already has _i — reorder to front, ensure required
	if (INTENT_FIELD in props) {
		const { [INTENT_FIELD]: intentProp, ...rest } = props;
		const required = Array.isArray(schema.required) ? schema.required : [];
		return {
			...schema,
			properties: { [INTENT_FIELD]: intentProp, ...rest },
			...(required.includes(INTENT_FIELD) ? {} : { required: [...required, INTENT_FIELD] }),
		};
	}

	// Inject new _i field at front of properties, mark required
	const required = Array.isArray(schema.required) ? schema.required : [];
	return {
		...schema,
		properties: { [INTENT_FIELD]: { type: "string" }, ...props },
		required: [...required, INTENT_FIELD],
	};
}

export default function intentTracer(pi: any) {
	if (process.env.PI_INTENT_TRACING === "0") return;

	// Global store for cross-extension intent access (keyed by toolCallId)
	const store: Map<string, string> =
		(globalThis as any)[INTENT_STORE_KEY] || new Map<string, string>();
	(globalThis as any)[INTENT_STORE_KEY] = store;

	// ── 1. System prompt — tell the model how to fill _i ────────────
	pi.on("before_agent_start", (event: any) => ({
		systemPrompt:
			event.systemPrompt +
			`\n\n<intent-field>\nMost tools have a \`${INTENT_FIELD}\` parameter. Fill it with a concise intent in present participle form, 2-6 words, no period.\n</intent-field>`,
	}));

	// ── 2. Schema injection — add _i to every tool in provider payload
	pi.on("before_provider_request", (event: any) => {
		const payload = event.payload;
		const tools = payload?.tools;
		if (!Array.isArray(tools)) return;

		for (const tool of tools) {
			// Anthropic format: tools[].input_schema
			if (tool.input_schema?.properties) {
				if (tool.name && OMIT_TOOLS.has(tool.name)) continue;
				tool.input_schema = injectIntentIntoSchema(tool.input_schema);
			}
			// OpenAI format: tools[].function.parameters
			// Covers: OpenAI, Wafer, Ollama Cloud, OpenCode-Go
			else if (tool.function?.parameters?.properties) {
				if (OMIT_TOOLS.has(tool.function.name)) continue;
				tool.function.parameters = injectIntentIntoSchema(tool.function.parameters);
			}
		}

		return payload;
	});

	// ── 3. Intent capture & strip — BEFORE validation ────────────
	//
	// tool_execution_start fires before prepareToolCall() which runs
	// validateToolArguments(). event.args is a direct reference to
	// toolCall.arguments, so deleting _i here removes it before the
	// validator (which uses structuredClone) ever sees it.
	pi.on("tool_execution_start", (event: any) => {
		const args = event.args;
		if (!args || typeof args !== "object") return;

		const intent = args[INTENT_FIELD];
		if (intent !== undefined) {
			delete args[INTENT_FIELD];
		}

		if (typeof intent === "string" && intent.trim()) {
			store.set(event.toolCallId, intent.trim());
			// Keep store bounded — evict oldest beyond 200 entries
			if (store.size > 200) {
				const oldest = store.keys().next().value;
				if (oldest) store.delete(oldest);
			}
		}
	});

	// ── 4. Fallback strip in tool_call (defensive) ────────────
	// In case tool_execution_start doesn't fire or args aren't shared,
	// also strip in tool_call to prevent _i from reaching the tool.
	pi.on("tool_call", (event: any) => {
		if (event.input?.[INTENT_FIELD] !== undefined) {
			delete event.input[INTENT_FIELD];
		}
	});
}
