/**
 * Contextual Working Message Extension
 *
 * Replaces the generic "Working" label with context-aware messages
 * based on which tool is currently executing.
 *
 * Commands:
 *   /working-style       Pick or set message style: static, dynamic
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
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

// ─── Configuration ───────────────────────────────────────────────

type MessageStyle = "static" | "dynamic";
type IndicatorStyle = string;
type ColorAnimation = "off" | "rainbow" | "ocean" | "aurora" | "ember" | "neon" | "mist" | "dusk" | "sage" | "smoke";

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

// ─── Color Animation Palettes ────────────────────────────────────

const COLOR_PALETTES: Record<string, [number, number, number][]> = {
  rainbow: [[255,107,129], [255,180,107], [255,247,107], [107,255,180], [107,180,255], [200,107,255]],
  ocean: [[0,180,216], [72,202,228], [144,224,239], [0,150,199], [0,119,182], [72,202,228]],
  aurora: [[0,255,136], [0,204,187], [0,153,219], [102,102,255], [178,102,255], [0,255,136]],
  ember: [[255,69,0], [255,140,0], [255,200,0], [255,165,0], [255,99,71], [255,69,0]],
  neon: [[255,0,255], [0,255,255], [255,255,0], [0,255,128], [255,0,128], [128,0,255]],
  // ponytail: subtle gradients — calmer than neon/ember, more presence than v1
  mist: [[120,140,200], [150,150,210], [180,150,205], [160,165,205], [120,175,195], [120,140,200]],
  dusk: [[90,150,210], [140,130,215], [190,120,200], [210,130,170], [150,150,205], [90,150,210]],
  sage: [[90,180,180], [120,195,160], [160,200,150], [140,185,175], [110,175,195], [90,180,180]],
  smoke: [[255,255,255], [215,215,215], [175,175,175], [140,140,140], [200,200,200], [255,255,255]],
};

function renderGradientText(text: string, palette: [number, number, number][], phase: number): string {
  if (text.length === 0) return text;
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === " ") { result += ch; continue; }
    const t = ((i / Math.max(text.length - 1, 1)) * 2 + phase) % 1;
    const idx = t * (palette.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, palette.length - 1);
    const frac = idx - lo;
    const r = Math.round(palette[lo]![0] + (palette[hi]![0] - palette[lo]![0]) * frac);
    const g = Math.round(palette[lo]![1] + (palette[hi]![1] - palette[lo]![1]) * frac);
    const b = Math.round(palette[lo]![2] + (palette[hi]![2] - palette[lo]![2]) * frac);
    result += `\x1b[38;2;${r};${g};${b}m${ch}`;
  }
  return result + RESET_FG;
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
  colorAnimation?: ColorAnimation;
}

const TOY_KEY = "contextualWorking";

function loadWorkingConfig(): WorkingConfig | undefined {
  return loadToyConfig<WorkingConfig>(TOY_KEY);
}

function saveWorkingConfig(
  messageStyle: MessageStyle,
  indicator: IndicatorStyle,
  colorAnimation: ColorAnimation = "off",
): void {
  saveToyConfig(TOY_KEY, { messageStyle, indicator, colorAnimation });
}

// ─── Main Extension ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load persisted settings
  const persisted = loadWorkingConfig();
  let messageStyle: MessageStyle = persisted?.messageStyle === "static" ? "static" : "dynamic";
  let indicatorIndex = 0;
  let currentIndicator: IndicatorStyle = persisted?.indicator ?? "braille";
  indicatorIndex = INDICATOR_NAMES.indexOf(currentIndicator);
  let colorAnimation: ColorAnimation = persisted?.colorAnimation ?? "off";
  let colorTimer: ReturnType<typeof setInterval> | null = null;
  let colorPhase = 0;

  function startColorAnimation(ctx: ExtensionContext) {
    stopColorAnimation();
    if (colorAnimation === "off") return;
    const palette = COLOR_PALETTES[colorAnimation];
    if (!palette) return;
    colorPhase = 0;
    colorTimer = setInterval(() => {
      colorPhase = (colorPhase + 0.03) % 1;
      const colored = renderGradientText(lastMessage, palette, colorPhase);
      ctx.ui.setWorkingMessage(colored);
    }, 80);
  }

  function stopColorAnimation() {
    if (colorTimer) {
      clearInterval(colorTimer);
      colorTimer = null;
    }
  }

  const applyIndicator = (ctx: ExtensionContext) => {
    const opts = INDICATORS[currentIndicator];
    ctx.ui.setWorkingIndicator(opts);
    ctx.ui.setStatus(
      "contextual-working",
      `${[ctx.ui.theme.fg("accent", currentIndicator), ctx.ui.theme.fg("accent", messageStyle)].filter(Boolean).join(" · ")}`
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

    }

    lastMessage = message;
    if (ctx) {
      ctx.ui.setWorkingMessage(message);
      if (colorAnimation !== "off") startColorAnimation(ctx);
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
    if (colorAnimation !== "off") startColorAnimation(ctx);
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
    stopColorAnimation();
    if (autoNameDone || event.turnIndex > 0) return;
    // Auto-naming is purely cosmetic — skip in non-interactive runs.
    if (!ctx.hasUI) return;
    autoNameDone = true;

    if (ctx.sessionManager.getSessionName()) return;
    if (!firstPrompt) return;

    const userPrompt = firstPrompt;

    const words = userPrompt
      .replace(/[^\w\s-]/g, "")
      .split(/\s+/)
      .filter(Boolean);
    let name = words.slice(0, 4).join(" ");

    // Cap length and apply
    if (name.length > 60) name = name.slice(0, 57) + "...";
    if (name) {
      try {
        pi.setSessionName(name);
      } catch {
        // Session no longer accepting updates — silently drop the auto-name.
      }
    }
  });
  // until the next tool updates it.

  // ─── Commands ─────────────────────────────────────────────

  const STYLE_NAMES: MessageStyle[] = ["static", "dynamic"];
  let styleIndex = STYLE_NAMES.indexOf(messageStyle);

  pi.registerCommand("working-style", {
    description: "Pick message style: static or dynamic.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (arg && arg !== "static" && arg !== "dynamic") {
        ctx.ui.notify(`Usage: /working-style [static|dynamic]`, "error");
        return;
      }

      if (arg) {
        messageStyle = arg as MessageStyle;
        styleIndex = STYLE_NAMES.indexOf(messageStyle);
      } else {
        const choice = await ctx.ui.select("Message Style", [
          `📋 static — Rotating messages from a fixed list`,
          `🔍 dynamic — Adds context from tool inputs`,
        ]);
        if (choice === undefined) return; // cancelled

        if (choice.startsWith("📋")) messageStyle = "static";
        else if (choice.startsWith("🔍")) messageStyle = "dynamic";

        styleIndex = STYLE_NAMES.indexOf(messageStyle);
      }

      applyIndicator(ctx);
      saveWorkingConfig(messageStyle, currentIndicator, colorAnimation);
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
          const marker = name === currentIndicator ? " ✓" : "";
          return `${name}${marker}`;
        });
        const choice = await ctx.ui.select("Working Indicator", options);
        if (choice === undefined) return; // cancelled

        // Strip the ✓ marker to get the name
        const picked = choice.replace(/ ✓$/, "") as IndicatorStyle;
        if (picked in INDICATORS) {
          currentIndicator = picked;
          indicatorIndex = INDICATOR_NAMES.indexOf(currentIndicator);
        }
      }

      applyIndicator(ctx);
      saveWorkingConfig(messageStyle, currentIndicator, colorAnimation);
      ctx.ui.notify(`Working indicator: ${currentIndicator}`, "info");
    },
  });

  // ─── Color Animation Command ───────────────────────────────

  const COLOR_NAMES: ColorAnimation[] = ["off", "rainbow", "ocean", "aurora", "ember", "neon", "mist", "dusk", "sage", "smoke"];

  pi.registerCommand("working-color", {
    description: "Pick color animation for working message.",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && !COLOR_NAMES.includes(arg as ColorAnimation)) {
        ctx.ui.notify(`Usage: /working-color [${COLOR_NAMES.join("|")}]`, "error");
        return;
      }
      if (arg) {
        colorAnimation = arg as ColorAnimation;
      } else {
        const options = COLOR_NAMES.map((name) => {
          const marker = name === colorAnimation ? " ✓" : "";
          const desc = name === "off"
            ? "No color animation"
            : `${name.charAt(0).toUpperCase() + name.slice(1)} gradient wave`;
          return `${name} — ${desc}${marker}`;
        });
        const choice = await ctx.ui.select("Working Color Animation", options);
        if (choice === undefined) return;
        const picked = choice.split(" — ")[0]!.trim() as ColorAnimation;
        if (COLOR_NAMES.includes(picked)) {
          colorAnimation = picked;
        }
      }
      saveWorkingConfig(messageStyle, currentIndicator, colorAnimation);
      if (colorAnimation === "off") {
        stopColorAnimation();
        ctx.ui.setWorkingMessage(lastMessage);
      }
      applyIndicator(ctx);
      ctx.ui.notify(`Working color: ${colorAnimation}`, "info");
    },
  });
}
