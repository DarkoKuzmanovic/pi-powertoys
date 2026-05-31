/**
 * Contextual Working Message Extension
 *
 * Replaces the generic "Working" label with context-aware messages
 * based on which tool is currently executing. Optionally uses
 * Gemini 3.1 Flash Lite to generate witty, descriptive messages.
 *
 * AI messages are cached to a local JSON file, building a growing
 * database of funny messages. Respects 5 RPM rate limit.
 *
 * Uses OPENCODE_GO_API_KEY (primary) and GOOGLE_API_KEY (fallback) from environment.
 *
 * Commands:
 *   /working-style       Pick or set message style: static, dynamic, ai
 *   /working-indicator   Pick or set indicator spinner style
 *
 * Settings persist in ~/.pi/agent/cache/pi-powertoys/toys.json under the "contextualWorking" key.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ─── Configuration ───────────────────────────────────────────────

type MessageStyle = "static" | "dynamic" | "ai";
type IndicatorStyle = string;

const PRIMARY_MODEL = "deepseek-v4-flash";
const PRIMARY_API_BASE = "https://opencode.ai/zen/go/v1/chat/completions";
const FALLBACK_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const CACHE_PATH =
  dirname(new URL(import.meta.url).pathname) + "/contextual-working-cache.json";
const RATE_LIMIT_RPM = 5;
const RATE_WINDOW_MS = 60_000;

// ─── Static Message Map ─────────────────────────────────────────

const TOOL_MESSAGES: Record<string, string[]> = {
  bash: ["Running command...", "Executing...", "Spawning process..."],
  read: ["Reading file...", "Scanning code...", "Looking at files..."],
  write: ["Writing file...", "Creating file...", "Saving changes..."],
  edit: ["Editing code...", "Making changes...", "Patching file..."],
  grep: ["Searching files...", "Grepping...", "Finding matches..."],
  find: ["Finding files...", "Scanning directories...", "Locating files..."],
  ls: ["Listing directory...", "Browsing files..."],
  web_search: ["Searching the web...", "Looking up online...", "Googling..."],
  web_fetch: ["Fetching page...", "Downloading content...", "Loading URL..."],
  lsp_navigation: [
    "Navigating code...",
    "Jumping to definition...",
    "Resolving references...",
  ],
  ast_search: [
    "Searching AST...",
    "Pattern matching...",
    "Structural search...",
  ],
  ast_grep_search: ["Grepping AST...", "Pattern matching..."],
  interactive_shell: ["Spawning agent...", "Launching CLI..."],
  mcp: ["Calling MCP tool...", "Connecting to server..."],
  ask_user: ["Asking user...", "Waiting for input..."],
  obsidian_retrieve: ["Searching vault...", "Reading notes..."],
  obsidian_write: ["Writing note...", "Saving to vault..."],
  obsidian_edit: ["Editing note...", "Updating vault..."],
  subagent: ["Delegating to agent...", "Spawning subagent..."],
  todo_write: ["Updating tasks...", "Planning work..."],
};

// Seed fallbacks — used when AI is unreachable AND cache is empty
const SEED_MESSAGES: Record<string, string[]> = {
  bash: ["Conjuring shell magic", "Brewing commands", "Whispering to terminal"],
  read: ["Devouring code", "Absorbing knowledge", "Gobbling files"],
  write: ["Manifesting code", "Inscribing wisdom", "Channeling creativity"],
  edit: ["Performing surgery", "Stitching code", "Sculpting logic"],
  grep: ["On the hunt", "Detective mode", "Sniffing patterns"],
  find: ["Treasure hunting", "Charting the codebase", "Surveying lands"],
  ls: ["Browsing aisles", "Cataloguing reality"],
  web_search: ["Consulting oracle", "Surfing the void", "Asking the internet"],
  web_fetch: ["Plucking pages", "Harvesting bytes", "Reeling in data"],
  lsp_navigation: ["Teleporting through code", "Following breadcrumbs"],
  ast_search: ["Parsing reality", "Decoding the matrix"],
  interactive_shell: ["Summoning familiar", "Opening portal"],
  mcp: ["Dialing other realms", "Bridging dimensions"],
  ask_user: ["Needing wisdom", "Awaiting guidance"],
  obsidian_retrieve: ["Searching the archives", "Unearthing notes"],
  obsidian_write: ["Inscribing the vault", "Etching knowledge"],
  obsidian_edit: ["Polishing notes", "Refining thoughts"],
  subagent: ["Dispatching minion", "Rallying allies"],
  todo_write: ["Plotting world domination", "Orchestrating chaos"],
};

const DEFAULT_SEEDS = [
  "Dreaming electric",
  "Pondering existence",
  "Computing vibes",
  "Channeling thoughts",
];

// ─── Indicator Presets ──────────────────────────────────────────

const PASTEL_RAINBOW = [
  "\x1b[38;2;255;179;186m",
  "\x1b[38;2;255;223;186m",
  "\x1b[38;2;255;255;186m",
  "\x1b[38;2;186;255;201m",
  "\x1b[38;2;186;225;255m",
  "\x1b[38;2;218;186;255m",
];
const RESET_FG = "\x1b[39m";

function colorize(text: string, color: string): string {
  return `${color}${text}${RESET_FG}`;
}

/** Build a short preview string from indicator frames (strip ANSI for display). */
function framesPreview(frames: string[]): string {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const stripped = frames.map(stripAnsi);
  // Show up to 4 frames joined, ellipsis if more
  const preview = stripped.slice(0, 4).join("");
  return stripped.length > 4 ? `${preview}…` : preview;
}

/** Render a frame preview suffix, safely handling optional/empty frames. */
function frameInfo(opts: WorkingIndicatorOptions): string {
  const frames = opts.frames ?? [];
  return frames.length > 0 ? ` ${framesPreview(frames)}` : "";
}

// ─── Spinner Loader (JSON-backed) ──────────────────────────────

interface SpinnerDef {
  frames: string[];
  intervalMs?: number;
}

const SPINNER_PATH =
  dirname(new URL(import.meta.url).pathname) + "/spinners.json";

const FALLBACK_INDICATORS: Record<string, WorkingIndicatorOptions> = {
  braille: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    intervalMs: 80,
  },
  moon: {
    frames: ["🌑 ", "🌒 ", "🌓 ", "🌔 ", "🌕 ", "🌖 ", "🌗 ", "🌘 "],
    intervalMs: 80,
  },
  triangle: {
    frames: ["◢", "◣", "◤", "◥"],
    intervalMs: 50,
  },
  pulse: {
    frames: ["⋅", "∙", "●", "∙"],
    intervalMs: 120,
  },
  noise: {
    frames: ["▓", "▒", "░"],
    intervalMs: 100,
  },
  pipe: {
    frames: ["┤", "┘", "┴", "└", "├", "┌", "┬", "┐"],
    intervalMs: 100,
  },
  globe: {
    frames: ["◜", "◠", "◝", "◞", "◡", "◟"],
    intervalMs: 100,
  },
  dot: {
    frames: [colorize("●", PASTEL_RAINBOW[0]!)],
  },
  none: {
    frames: [],
  },
  aesthetic: {
    frames: [
      "▰▱▱▱▱▱▱",
      "▰▰▱▱▱▱▱",
      "▰▰▰▱▱▱▱",
      "▰▰▰▰▱▱▱",
      "▰▰▰▰▰▱▱",
      "▰▰▰▰▰▰▱",
      "▰▰▰▰▰▰▰",
      "▰▱▱▱▱▱▱",
    ],
    intervalMs: 80,
  },
  boxBounce: {
    frames: ["▖", "▘", "▝", "▗"],
    intervalMs: 120,
  },
  dots8Bit: {
    frames: [
      "⠀",
      "⠁",
      "⠂",
      "⠃",
      "⠄",
      "⠅",
      "⠆",
      "⠇",
      "⡀",
      "⡁",
      "⡂",
      "⡃",
      "⡄",
      "⡅",
      "⡆",
      "⡇",
      "⠈",
      "⠉",
      "⠊",
      "⠋",
      "⠌",
      "⠍",
      "⠎",
      "⠏",
      "⡈",
      "⡉",
      "⡊",
      "⡋",
      "⡌",
      "⡍",
      "⡎",
      "⡏",
      "⠐",
      "⠑",
      "⠒",
      "⠓",
      "⠔",
      "⠕",
      "⠖",
      "⠗",
      "⡐",
      "⡑",
      "⡒",
      "⡓",
      "⡔",
      "⡕",
      "⡖",
      "⡗",
      "⠘",
      "⠙",
      "⠚",
      "⠛",
      "⠜",
      "⠝",
      "⠞",
      "⠟",
      "⡘",
      "⡙",
      "⡚",
      "⡛",
      "⡜",
      "⡝",
      "⡞",
      "⡟",
      "⠠",
      "⠡",
      "⠢",
      "⠣",
      "⠤",
      "⠥",
      "⠦",
      "⠧",
      "⡠",
      "⡡",
      "⡢",
      "⡣",
      "⡤",
      "⡥",
      "⡦",
      "⡧",
      "⠨",
      "⠩",
      "⠪",
      "⠫",
      "⠬",
      "⠭",
      "⠮",
      "⠯",
      "⡨",
      "⡩",
      "⡪",
      "⡫",
      "⡬",
      "⡭",
      "⡮",
      "⡯",
      "⠰",
      "⠱",
      "⠲",
      "⠳",
      "⠴",
      "⠵",
      "⠶",
      "⠷",
      "⡰",
      "⡱",
      "⡲",
      "⡳",
      "⡴",
      "⡵",
      "⡶",
      "⡷",
      "⠸",
      "⠹",
      "⠺",
      "⠻",
      "⠼",
      "⠽",
      "⠾",
      "⠿",
      "⡸",
      "⡹",
      "⡺",
      "⡻",
      "⡼",
      "⡽",
      "⡾",
      "⡿",
      "⢀",
      "⢁",
      "⢂",
      "⢃",
      "⢄",
      "⢅",
      "⢆",
      "⢇",
      "⣀",
      "⣁",
      "⣂",
      "⣃",
      "⣄",
      "⣅",
      "⣆",
      "⣇",
      "⢈",
      "⢉",
      "⢊",
      "⢋",
      "⢌",
      "⢍",
      "⢎",
      "⢏",
      "⣈",
      "⣉",
      "⣊",
      "⣋",
      "⣌",
      "⣍",
      "⣎",
      "⣏",
      "⢐",
      "⢑",
      "⢒",
      "⢓",
      "⢔",
      "⢕",
      "⢖",
      "⢗",
      "⣐",
      "⣑",
      "⣒",
      "⣓",
      "⣔",
      "⣕",
      "⣖",
      "⣗",
      "⢘",
      "⢙",
      "⢚",
      "⢛",
      "⢜",
      "⢝",
      "⢞",
      "⢟",
      "⣘",
      "⣙",
      "⣚",
      "⣛",
      "⣜",
      "⣝",
      "⣞",
      "⣟",
      "⢠",
      "⢡",
      "⢢",
      "⢣",
      "⢤",
      "⢥",
      "⢦",
      "⢧",
      "⣠",
      "⣡",
      "⣢",
      "⣣",
      "⣤",
      "⣥",
      "⣦",
      "⣧",
      "⢨",
      "⢩",
      "⢪",
      "⢫",
      "⢬",
      "⢭",
      "⢮",
      "⢯",
      "⣨",
      "⣩",
      "⣪",
      "⣫",
      "⣬",
      "⣭",
      "⣮",
      "⣯",
      "⢰",
      "⢱",
      "⢲",
      "⢳",
      "⢴",
      "⢵",
      "⢶",
      "⢷",
      "⣰",
      "⣱",
      "⣲",
      "⣳",
      "⣴",
      "⣵",
      "⣶",
      "⣷",
      "⢸",
      "⢹",
      "⢺",
      "⢻",
      "⢼",
      "⢽",
      "⢾",
      "⢿",
      "⣸",
      "⣹",
      "⣺",
      "⣻",
      "⣼",
      "⣽",
      "⣾",
      "⣿",
    ],
    intervalMs: 80,
  },
  growVertical: {
    frames: ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"],
    intervalMs: 120,
  },
  growHorizontal: {
    frames: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "▊", "▋", "▌", "▍", "▎"],
    intervalMs: 120,
  },
  sand: {
    frames: [
      "⠁",
      "⠂",
      "⠄",
      "⡀",
      "⡈",
      "⡐",
      "⡠",
      "⣀",
      "⣁",
      "⣂",
      "⣄",
      "⣌",
      "⣔",
      "⣤",
      "⣥",
      "⣦",
      "⣮",
      "⣶",
      "⣷",
      "⣿",
      "⡿",
      "⠿",
      "⢟",
      "⠟",
      "⡛",
      "⠛",
      "⠫",
      "⢋",
      "⠋",
      "⠍",
      "⡉",
      "⠉",
      "⠑",
      "⠡",
      "⢁",
    ],
    intervalMs: 80,
  },
};

let INDICATORS: Record<string, WorkingIndicatorOptions>;
let INDICATOR_NAMES: string[];

try {
  const raw = readFileSync(SPINNER_PATH, "utf-8");
  const parsed: Record<string, SpinnerDef> = JSON.parse(raw);
  const built: Record<string, WorkingIndicatorOptions> = {};
  const names: string[] = [];
  for (const [key, def] of Object.entries(parsed)) {
    if (def && Array.isArray(def.frames)) {
      built[key] = { frames: def.frames };
      if (def.intervalMs !== undefined) {
        built[key].intervalMs = def.intervalMs;
      }
      names.push(key);
    }
  }
  if (names.length === 0) throw new Error("No valid spinners found");
  INDICATORS = built;
  INDICATOR_NAMES = names;
} catch (err) {
  console.warn(
    `[contextual-working] Failed to load ${SPINNER_PATH}, using built-in fallback: ${(err as Error).message}`,
  );
  INDICATORS = FALLBACK_INDICATORS;
  INDICATOR_NAMES = Object.keys(FALLBACK_INDICATORS);
}

// ─── Persistent JSON Cache ──────────────────────────────────────
// Stores AI-generated messages per tool, growing over time.

interface MessageCache {
  messages: Record<string, string[]>;
  lastUpdated: number;
}

function loadCache(): MessageCache {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as MessageCache;
    if (data.messages && typeof data.messages === "object") return data;
  } catch {
    /* file doesn't exist or invalid JSON — start fresh */
  }
  return { messages: {}, lastUpdated: 0 };
}

function saveCache(cache: MessageCache): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    cache.lastUpdated = Date.now();
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, "\t") + "\n");
  } catch {
    /* silently fail — cache is best-effort */
  }
}

function addCachedMessage(toolName: string, message: string): void {
  const cache = loadCache();
  if (!cache.messages[toolName]) cache.messages[toolName] = [];
  const pool = cache.messages[toolName]!;
  // Dedupe — don't store identical messages
  if (!pool.includes(message)) {
    pool.push(message);
    // Cap per-tool at 50 messages to prevent unbounded growth
    if (pool.length > 50) pool.shift();
    saveCache(cache);
  }
}

function getCachedMessages(toolName: string): string[] | undefined {
  const cache = loadCache();
  return cache.messages[toolName];
}

// ─── Rate Limiter ───────────────────────────────────────────────
// Tracks API call timestamps, respects 5 RPM.

class RateLimiter {
  private callTimes: number[] = [];

  canCall(): boolean {
    const now = Date.now();
    // Prune timestamps older than the window
    this.callTimes = this.callTimes.filter((t) => now - t < RATE_WINDOW_MS);
    return this.callTimes.length < RATE_LIMIT_RPM;
  }

  recordCall(): void {
    this.callTimes.push(Date.now());
  }

  timeUntilNextCall(): number {
    if (this.canCall()) return 0;
    const now = Date.now();
    const oldest = this.callTimes[0]!;
    return Math.max(0, RATE_WINDOW_MS - (now - oldest));
  }
}

// ─── AI Message Generator ────────────────────────────────────────

class MessageGenerator {
  private primaryApiKey: string;
  private fallbackApiKey?: string;
  private rateLimiter = new RateLimiter();
  private pending = new Map<string, Promise<string>>();

  constructor(primaryApiKey: string, fallbackApiKey?: string) {
    this.primaryApiKey = primaryApiKey;
    this.fallbackApiKey = fallbackApiKey;
  }

  async generateMessage(
    toolName: string,
    toolInput?: Record<string, unknown>,
  ): Promise<string> {
    // Rate limit check — skip API if at limit
    if (!this.rateLimiter.canCall()) {
      throw new Error(
        `Rate limited — next call in ${Math.ceil(this.rateLimiter.timeUntilNextCall() / 1000)}s`,
      );
    }

    // Deduplicate in-flight requests
    const cacheKey = `${toolName}:${
      toolInput
        ? Object.entries(toolInput)
            .slice(0, 2)
            .map(([k, v]) => `${k}=${String(v).slice(0, 30)}`)
            .join("&")
        : ""
    }`;
    const pending = this.pending.get(cacheKey);
    if (pending) return pending;

    const promise = this.fetchMessage(toolName, toolInput)
      .then((msg) => {
        this.pending.delete(cacheKey);
        // Save AI message to persistent cache
        addCachedMessage(toolName, msg);
        return msg;
      })
      .catch((err) => {
        this.pending.delete(cacheKey);
        throw err;
      });

    this.pending.set(cacheKey, promise);
    return promise;
  }

  private async fetchMessage(
    toolName: string,
    toolInput?: Record<string, unknown>,
  ): Promise<string> {
    const inputDesc = toolInput
      ? Object.entries(toolInput)
          .slice(0, 2)
          .map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`)
          .join(", ")
      : "";

    const prompt = `Generate a short (2-4 words max) playful working message for a coding agent that is currently using the "${toolName}" tool${inputDesc ? ` with ${inputDesc}` : ""}. Be creative, witty, and brief. No punctuation at end. Examples: "Hunting bugs", "Decoding mysteries", "Weaving code". Reply with ONLY the message text, nothing else.`;

    return this.callAI(prompt);
  }

  /** Call the AI with a custom prompt (respects rate limiter, tries primary then fallback). */
  async callAI(prompt: string, maxTokens = 20): Promise<string> {
    if (!this.rateLimiter.canCall()) {
      throw new Error(
        `Rate limited — next call in ${Math.ceil(this.rateLimiter.timeUntilNextCall() / 1000)}s`,
      );
    }
    this.rateLimiter.recordCall();

    try {
      return await this.fetchFromPrimary(prompt, maxTokens);
    } catch {
      if (this.fallbackApiKey) {
        try {
          return await this.fetchFromFallback(prompt, maxTokens);
        } catch {
          // fall through
        }
      }
      throw new Error("AI call failed");
    }
  }

  private async fetchFromPrimary(
    prompt: string,
    maxTokens = 20,
  ): Promise<string> {
    const response = await fetch(PRIMARY_API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.primaryApiKey}`,
      },
      body: JSON.stringify({
        model: PRIMARY_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.9,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenCode Go API ${response.status}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty response from primary");
    return text;
  }

  private async fetchFromFallback(
    prompt: string,
    maxTokens = 20,
  ): Promise<string> {
    const url = `${FALLBACK_API_BASE}/${FALLBACK_MODEL}:generateContent?key=${this.fallbackApiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.9,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini API ${response.status}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new Error("Empty response from fallback");
    return text;
  }
}

// ─── AI Fallback — cache-first, then seeds ─────────────────────

function getAIMessage(toolName: string): string {
  // 1. Try persistent cache (AI-generated messages from past sessions)
  const cached = getCachedMessages(toolName);
  if (cached && cached.length > 0) {
    return cached[Math.floor(Math.random() * cached.length)]!;
  }
  // 2. Fall back to seed messages
  const seeds = SEED_MESSAGES[toolName];
  if (seeds) return seeds[Math.floor(Math.random() * seeds.length)]!;
  return DEFAULT_SEEDS[Math.floor(Math.random() * DEFAULT_SEEDS.length)]!;
}

// ─── Dynamic Message Builder (no AI, just smarter static) ──────

function buildDynamicMessage(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string {
  const messages = TOOL_MESSAGES[toolName];
  if (!messages) return "Working...";

  // Pick a random message for variety
  const base =
    messages[Math.floor(Math.random() * messages.length)] ?? "Working...";

  // For specific tools, add context from input
  if (toolName === "bash" && toolInput?.command) {
    const cmd = String(toolInput.command).split(" ")[0]?.slice(0, 15) ?? "";
    if (cmd) return `${base} ${cmd}`;
  }
  if (toolName === "read" && toolInput?.path) {
    const file = String(toolInput.path).split("/").pop()?.slice(0, 20) ?? "";
    if (file) return `Reading ${file}...`;
  }
  if (toolName === "edit" && toolInput?.path) {
    const file = String(toolInput.path).split("/").pop()?.slice(0, 20) ?? "";
    if (file) return `Editing ${file}...`;
  }
  if (toolName === "write" && toolInput?.path) {
    const file = String(toolInput.path).split("/").pop()?.slice(0, 20) ?? "";
    if (file) return `Writing ${file}...`;
  }
  if (toolName === "grep" && toolInput?.pattern) {
    const pat = String(toolInput.pattern).slice(0, 20) ?? "";
    if (pat) return `Searching "${pat}"...`;
  }
  if (toolName === "find" && toolInput?.pattern) {
    const pat = String(toolInput.pattern).slice(0, 20) ?? "";
    if (pat) return `Finding "${pat}"...`;
  }

  return base;
}

// ─── Persistence ───────────────────────────────────────────────

interface WorkingConfig {
  messageStyle: MessageStyle;
  indicator: IndicatorStyle;
}

const TOY_KEY = "contextualWorking";

function loadWorkingConfig(): WorkingConfig | undefined {
  return loadToyConfig<WorkingConfig>(TOY_KEY);
}

function saveWorkingConfig(
  messageStyle: MessageStyle,
  indicator: IndicatorStyle,
): void {
  saveToyConfig(TOY_KEY, { messageStyle, indicator });
}

// ─── Main Extension ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load persisted settings
  const persisted = loadWorkingConfig();
  let messageStyle: MessageStyle = persisted?.messageStyle ?? "dynamic";
  let indicatorIndex = 0;
  let currentIndicator: IndicatorStyle = persisted?.indicator ?? "braille";
  indicatorIndex = INDICATOR_NAMES.indexOf(currentIndicator);
  let generator: MessageGenerator | null = null;

  // Initialize AI generator — OpenCode Go (primary) + Gemini (fallback)
  const opencodeGoApiKey = process.env.OPENCODE_GO_API_KEY;
  const googleApiKey = process.env.GOOGLE_API_KEY;
  if (opencodeGoApiKey) {
    generator = new MessageGenerator(opencodeGoApiKey, googleApiKey);
  } else if (googleApiKey) {
    generator = new MessageGenerator(googleApiKey);
  }

  const providerTag = () =>
    messageStyle === "ai"
      ? process.env.OPENCODE_GO_API_KEY
        ? "deepseek-v4-flash"
        : process.env.GOOGLE_API_KEY
          ? "gemini"
          : "cache"
      : messageStyle;

  const applyIndicator = (ctx: ExtensionContext) => {
    const opts = INDICATORS[currentIndicator];
    ctx.ui.setWorkingIndicator(opts);
    const preview = frameInfo(opts);
    ctx.ui.setStatus(
      "contextual-working",
      `\udb81\udff6 ${[preview.trim() ? ctx.ui.theme.fg("accent", preview.trim()) : "", ctx.ui.theme.fg("accent", providerTag())].filter(Boolean).join(" · ")}`
    );
  };

  let lastMessage = "Thinking...";

  const applyMessage = async (
    toolName: string,
    toolInput?: Record<string, unknown>,
    ctx?: ExtensionContext,
  ) => {
    let message: string;

    switch (messageStyle) {
      case "static": {
        const msgs = TOOL_MESSAGES[toolName] ?? ["Working..."];
        message = msgs[Math.floor(Math.random() * msgs.length)] ?? "Working...";
        break;
      }
      case "dynamic": {
        message = buildDynamicMessage(toolName, toolInput);
        break;
      }
      case "ai": {
        if (!generator) {
          // No API key — use cached or seed messages
          message = getAIMessage(toolName);
        } else {
          // Try Gemini (rate-limited), fallback to cache/seeds on failure
          const fallback = getAIMessage(toolName);
          try {
            message = await Promise.race([
              generator.generateMessage(toolName, toolInput),
              new Promise<string>((resolve) =>
                setTimeout(() => resolve(fallback), 2000),
              ),
            ]);
          } catch {
            message = fallback;
          }
        }
        break;
      }
    }

    lastMessage = message;
    if (ctx) {
      ctx.ui.setWorkingMessage(message);
    }
  };

  // ─── Auto Session Naming ──────────────────────────────────────
  let firstPrompt: string | null = null;
  let autoNameDone = false;

  // ─── Hook into lifecycle ────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Reset auto-naming state for new sessions
    autoNameDone = false;
    firstPrompt = null;

    applyIndicator(ctx);
    ctx.ui.setWorkingMessage(lastMessage);
  });

  pi.on("turn_start", async (_event, ctx) => {
    ctx.ui.setWorkingMessage(lastMessage);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const toolName = event.toolName;
    const args = event.args as Record<string, unknown> | undefined;
    await applyMessage(toolName, args, ctx);
  });

  // No reset on tool_execution_end or agent_end — the message persists

  // Capture the user's first prompt before the agent starts

  // Capture the user's first prompt before the agent starts
  pi.on("before_agent_start", (event) => {
    if (firstPrompt === null && event.prompt) {
      firstPrompt = event.prompt;
    }
  });

  // After the first turn completes, auto-name the session if unnamed
  pi.on("turn_end", async (event, ctx) => {
    if (autoNameDone || event.turnIndex > 0) return;
    // Auto-naming is purely cosmetic — skip in non-interactive runs (e.g. -p mode,
    // subagent dispatches). The handler awaits an AI call that can outlive the
    // session, and post-await pi.setSessionName() would throw "stale ctx".
    if (!ctx.hasUI) return;
    autoNameDone = true;

    if (ctx.sessionManager.getSessionName()) return;
    if (!firstPrompt) return;

    const userPrompt = firstPrompt;

    // Generate name via AI (same provider chain as working-style ai)
    const namingPrompt = `Generate a very short session name (3-5 words max, no quotes, no punctuation) for a coding session that started with this user request: "${userPrompt.slice(0, 200)}". The name should be concise and descriptive, like a git branch name or document title. Reply with ONLY the name, nothing else.`;

    let name = "";
    if (generator) {
      try {
        name = await Promise.race([
          generator.callAI(namingPrompt, 30),
          new Promise<string>((resolve) => setTimeout(() => resolve(""), 3000)),
        ]);
      } catch {
        name = "";
      }
    }

    // Fallback: derive name from first few words of user prompt
    if (!name) {
      const words = userPrompt
        .replace(/[^\w\s-]/g, "")
        .split(/\s+/)
        .filter(Boolean);
      name = words.slice(0, 4).join(" ");
    }

    // Cap length and apply
    if (name.length > 60) name = name.slice(0, 57) + "...";
    if (name) {
      // Wrap in try/catch — even with the hasUI guard, an interactive session
      // can be replaced/closed during the AI call, invalidating the pi handle.
      try {
        pi.setSessionName(name);
      } catch {
        // Session no longer accepting updates — silently drop the auto-name.
      }
    }
  });
  // until the next tool updates it.

  // ─── Commands ─────────────────────────────────────────────

  const STYLE_NAMES: MessageStyle[] = ["static", "dynamic", "ai"];
  let styleIndex = STYLE_NAMES.indexOf(messageStyle);

  pi.registerCommand("working-style", {
    description: "Pick message style: static, dynamic, or ai.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg && arg !== "static" && arg !== "dynamic" && arg !== "ai") {
        ctx.ui.notify(`Usage: /working-style [static|dynamic|ai]`, "error");
        return;
      }

      if (arg) {
        messageStyle = arg as MessageStyle;
        styleIndex = STYLE_NAMES.indexOf(messageStyle);
      } else {
        const aiNote = !generator ? " (cache/seeds only)" : "";
        const choice = await ctx.ui.select("Message Style", [
          `📋 static — Rotating messages from a fixed list`,
          `🔍 dynamic — Adds context from tool inputs`,
          `🤖 ai — AI-generated witty messages${aiNote}`,
        ]);
        if (choice === undefined) return; // cancelled

        if (choice.startsWith("📋")) messageStyle = "static";
        else if (choice.startsWith("🔍")) messageStyle = "dynamic";
        else if (choice.startsWith("🤖")) messageStyle = "ai";

        styleIndex = STYLE_NAMES.indexOf(messageStyle);
      }

      if (messageStyle === "ai" && !generator) {
        ctx.ui.notify(
          "No OPENCODE_GO_API_KEY or GOOGLE_API_KEY — using cached/seed messages only.",
          "warning",
        );
      }

      applyIndicator(ctx);
      saveWorkingConfig(messageStyle, currentIndicator);
      ctx.ui.notify(`Working style: ${messageStyle}`, "info");
    },
  });

  pi.registerCommand("working-indicator", {
    description: "Pick the working indicator spinner style.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg && !(arg in INDICATORS)) {
        ctx.ui.notify(
          `Usage: /working-indicator [${INDICATOR_NAMES.join("|")}]`,
          "error",
        );
        return;
      }

      if (arg) {
        currentIndicator = arg as IndicatorStyle;
        indicatorIndex = INDICATOR_NAMES.indexOf(currentIndicator);
      } else {
        const options = INDICATOR_NAMES.map((name) => {
          const opts = INDICATORS[name];
          const preview = frameInfo(opts);
          const marker = name === currentIndicator ? " ✓" : "";
          return `${name}${preview}${marker}`;
        });
        const choice = await ctx.ui.select("Working Indicator", options);
        if (choice === undefined) return; // cancelled

        // Strip the ✓ marker and preview to get the name
        const picked = choice
          .replace(/ ✓$/, "")
          .split(" ")[0]! as IndicatorStyle;
        if (picked in INDICATORS) {
          currentIndicator = picked;
          indicatorIndex = INDICATOR_NAMES.indexOf(currentIndicator);
        }
      }

      applyIndicator(ctx);
      saveWorkingConfig(messageStyle, currentIndicator);
      const opts = INDICATORS[currentIndicator];
      const preview = frameInfo(opts);
      ctx.ui.notify(`Working indicator: ${currentIndicator}${preview}`, "info");
    },
  });
}
