import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("legacy ai style uses dynamic messages and local naming without network", () => {
  const home = mkdtempSync(join(tmpdir(), "working-test-"));
  try {
    const config = join(home, ".pi/agent/cache/pi-powertoys");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "toys.json"), JSON.stringify({ contextualWorking: { messageStyle: "ai", indicator: "braille" }, afk: { active: true } }));
    const script = `
      import extension from ${JSON.stringify(new URL("./contextual-working.ts", import.meta.url).href)};
      const events = {}, commands = {}; let name, message, calls = 0, status;
      globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: "NETWORK" } }] }) }; };
      const pi = { on: (n, f) => events[n] = f, registerCommand: (n, v) => commands[n] = v, setSessionName: n => name = n };
      extension(pi);
      const ctx = { hasUI: true, sessionManager: { getSessionName: () => undefined }, ui: { setWorkingIndicator: () => {}, setStatus: (_, v) => status = v, setWorkingMessage: v => message = v, theme: { fg: (_, v) => v }, notify: () => {} } };
      await events.session_start({}, ctx);
      await events.before_agent_start({ prompt: "Fix this local privacy issue please" }, ctx);
      await events.tool_execution_start({ toolName: "read", args: { path: "/work/secret.txt" } }, ctx);
      await events.turn_end({ turnIndex: 0 }, ctx);
      console.log(JSON.stringify({ name, message, calls, status }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, HOME: home, OPENCODE_GO_API_KEY: "dummy", GOOGLE_API_KEY: "dummy" } });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result, { name: "Fix this local privacy", message: "Reading secret.txt...", calls: 0, status: "braille · dynamic" });
    const source = readFileSync(new URL("./contextual-working.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /OPENCODE_GO_API_KEY|GOOGLE_API_KEY/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
