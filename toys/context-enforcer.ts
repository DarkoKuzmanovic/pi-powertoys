/**
 * Context-mode enforcer v2 — output-based truncation.
 *
 * Instead of trying to predict which commands produce large output
 * (whitelist approach — fragile, over-blocks small commands, under-blocks
 * whitelisted commands with large output), we let bash run freely and
 * truncate the RESULT when it exceeds a threshold.
 *
 * The model sees a truncated preview + a note telling it to use ctx_execute
 * for the full output. This teaches the model to prefer ctx_execute for
 * large-output commands without blocking legitimate small-output usage.
 *
 * Hard blocks are reserved for HTTP clients only (curl/wget/fetch) —
 * those should always use ctx_fetch_and_index regardless of output size.
 */

// ── Configuration ───────────────────────────────────────────

/** Lines of output before truncation kicks in */
const TRUNCATE_AFTER_LINES = 30;

/** Characters of output before truncation kicks in */
const TRUNCATE_AFTER_CHARS = 2000;

/** Lines to keep as preview when truncating */
const PREVIEW_HEAD_LINES = 10;
const PREVIEW_TAIL_LINES = 5;

// ── Hard blocks (HTTP clients only) ─────────────────────────
// These should ALWAYS use ctx_fetch_and_index, not bash.

const HARD_BLOCKED: Array<{ pattern: RegExp; name: string; tool: string }> = [
  { pattern: /\bcurl\b/, name: "curl", tool: "ctx_fetch_and_index" },
  { pattern: /\bwget\b/, name: "wget", tool: "ctx_fetch_and_index" },
  { pattern: /\bfetch\s*\(/, name: "fetch()", tool: "ctx_fetch_and_index" },
  { pattern: /\brequests\.\w+\(/, name: "requests.*()", tool: "ctx_execute" },
  { pattern: /\bhttp\.\w+\(/, name: "http.*()", tool: "ctx_execute" },
  { pattern: /\burllib\b/, name: "urllib", tool: "ctx_execute" },
  { pattern: /\bInvoke-WebRequest\b/, name: "Invoke-WebRequest", tool: "ctx_fetch_and_index" },
];

// ── Extension ───────────────────────────────────────────────

export default function contextModeEnforcer(pi: any) {

  // Layer 1: PreToolUse — hard-block HTTP clients only
  pi.on("tool_call", (event: any) => {
    try {
      const toolName = String(event?.toolName ?? "").toLowerCase();
      if (toolName !== "bash") return;

      const command = String(event?.input?.command ?? "").trim();
      if (!command) return;

      for (const { pattern, name, tool } of HARD_BLOCKED) {
        if (pattern.test(command)) {
          return {
            block: true,
            reason: `Use ${tool} instead of ${name} in bash. ` +
              `Raw HTTP output floods the context window.`,
          };
        }
      }
    } catch {
      // On error, allow passthrough
    }
  });

  // Layer 2: PostToolUse — truncate large bash output
  pi.on("tool_result", (event: any) => {
    try {
      const toolName = String(event?.toolName ?? "").toLowerCase();
      if (toolName !== "bash") return;

      // Get the text content from the result
      const content = event?.content;
      if (!content) return;

      let text: string;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text ?? "")
          .join("\n");
      } else {
        return;
      }

      const lines = text.split("\n");
      const charCount = text.length;

      // Below threshold — pass through unchanged
      if (lines.length <= TRUNCATE_AFTER_LINES && charCount <= TRUNCATE_AFTER_CHARS) {
        return;
      }

      // Above threshold — truncate with preview
      const command = String(event?.input?.command ?? "").trim();
      const head = lines.slice(0, PREVIEW_HEAD_LINES).join("\n");
      const tail = lines.slice(-PREVIEW_TAIL_LINES).join("\n");
      const omitted = lines.length - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES;

      const truncated = [
        head,
        "",
        `... (${omitted} lines, ${charCount.toLocaleString()} chars omitted) ...`,
        "",
        tail,
        "",
        "─".repeat(60),
        `Output truncated to save context. For full output, use:`,
        `  mcp({ tool: "context_mode_ctx_execute",`,
        `    args: '${JSON.stringify({ language: "shell", code: command })}' })`,
      ].join("\n");

      return {
        content: [{ type: "text", text: truncated }],
      };
    } catch {
      // On error, pass through unchanged
    }
  });
}
