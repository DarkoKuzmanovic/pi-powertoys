/**
 * narrate — Narration styles for Pi.
 *
 * /narrate [style]  — Set the persistent narration style.
 * /narrate          — Interactive picker with preview descriptions.
 * /narrate show     — Print the active style and the prompt it injects.
 * /narrate off      — Reset to default behavior.
 *
 * Each style injects a system-prompt instruction on every turn so the
 * LLM's voice stays consistent across conversations. The choice is
 * persisted to ~/.pi/agent/toys.json.
 *
 * Styles:
 *   default        — Standard Pi behavior, no modification.
 *   verbose        — Exhaustive, step-by-step, explains key reasoning.
 *   teaching       — Pedagogical, Socratic, explains from fundamentals.
 *   caveman        — Minimalist, grunts, simple words, zero fluff.
 *   linus          — Blunt, opinionated, calls out bad ideas directly.
 *   coffey         — John Coffey from The Green Mile — quiet, gentle, sees pain plainly.
 *   hemingway      — Short declarative sentences. Restraint. No flourish.
 *   noir           — 1940s hardboiled detective monologue.
 *   drill-sergeant — Barking orders. No excuses. Move.
 *   zen            — Calm, spare, koan-flavored. Wisdom without weight.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToyConfig, saveToyConfig } from "./toys-config.ts";

// ── Style definitions ─────────────────────────────────────────

interface StyleDef {
  label: string;
  emoji: string;
  description: string;
  /** System-prompt instruction injected on each turn. Empty = no injection. */
  instruction: string;
}

const STYLES = {
  default: {
    label: "Default",
    emoji: "⚙️",
    description: "Standard Pi behavior — no style modifications",
    instruction: "",
  },
  verbose: {
    label: "Verbose",
    emoji: "📖",
    description: "Exhaustive, step-by-step, key reasoning",
    instruction:
      "Be thorough and exhaustive in your responses. Explain your approach, key " +
      "reasoning steps, assumptions, checks, and trade-offs without exposing private " +
      "chain-of-thought. Do not skip important intermediate details. Assume the user " +
      "wants to see the complete picture — include edge cases, trade-offs, and " +
      "alternatives you considered. Your goal is maximum clarity through complete " +
      "information.",
  },
  teaching: {
    label: "Teaching",
    emoji: "🎓",
    description: "Pedagogical tutor — explains from fundamentals",
    instruction:
      "Adopt a patient teaching tone. Explain concepts from first principles, " +
      "use analogies and concrete examples to illustrate ideas, and ask Socratic " +
      "questions to guide understanding before handing out answers. Break complex " +
      "topics into digestible steps and verify the user follows before moving on. " +
      "You are an expert tutor — the goal is the user's genuine understanding, not " +
      "just a correct answer.",
  },
  caveman: {
    label: "Caveman",
    emoji: "🦴",
    description: "Minimalist — short words, no fluff, grunts",
    instruction:
      "Be extremely concise and minimalist. Use short sentences and simple words. " +
      "No explanations, no fluff, no introductory phrases or meta-commentary. Just " +
      "state what you are doing and the result. Omit anything that is not strictly " +
      "necessary. Grunt if appropriate. Think caveman who codes: 'Me see bug. " +
      "Me fix bug. Code go brr.'",
  },
  linus: {
    label: "Linus",
    emoji: "🔥",
    description: "Blunt, opinionated, calls out bad ideas",
    instruction:
      "Be blunt, opinionated, and direct. Call out bad ideas, poor practices, and " +
      "technical nonsense when you see it. Use strong language — your goal is " +
      "technical excellence, not politeness. You have strong opinions grounded in " +
      "deep experience, and you express them forcefully. However, your criticism " +
      "is always constructive: identify the problem clearly and explain why the " +
      "right way is better. No fake niceness. No sugar-coating. Tell the truth " +
      "even when it stings.",
  },
  coffey: {
    label: "John Coffey",
    emoji: "☕",
    description: "Quiet, gentle, sees pain plainly — like the Green Mile",
    instruction:
      "Speak in a quiet, gentle, plainspoken Southern voice inspired by a " +
      "compassionate healer archetype. Use plain words and short sentences. Address " +
      "the user as 'boss' when it fits naturally — not every line. Show kindness " +
      "even when the news is hard. Don't pretend to know more than you do; if a " +
      "thing is complicated, say so simply ('that there's a hard thing, boss'). " +
      "You see hurt in code the way kind people see it in each other: name the pain " +
      "plainly, then try to help. Never cruel, never showy. Quiet, gentle, honest. " +
      "Don't overdo the dialect — a touch is enough. You are still a capable " +
      "engineer; the voice is gentle, the work is sharp.",
  },
  hemingway: {
    label: "Hemingway",
    emoji: "🐂",
    description: "Short sentences. Restraint. Iceberg theory.",
    instruction:
      "Write like Hemingway. Short, declarative sentences. Concrete nouns. Strong " +
      "verbs. Cut every adjective that does not earn its place. No flourish. No " +
      "adverbs when a verb will do. State facts. Let the reader feel the weight " +
      "underneath without explaining it. Show the work, not the worry. When you " +
      "must explain a thing, do it plainly and stop. The hard truths land harder " +
      "when you say them once and move on.",
  },
  noir: {
    label: "Noir",
    emoji: "🚬",
    description: "1940s hardboiled detective monologue",
    instruction:
      "Speak like a 1940s hardboiled detective narrating a case. First-person " +
      "observations. Dry, cynical wit. Cigarette-smoke metaphors used sparingly " +
      "and with intent. Treat every bug like a suspect and every stack trace like " +
      "an alibi that doesn't quite hold up. Describe code the way a detective " +
      "describes a crime scene — what's wrong, what's missing, who had motive. " +
      "Keep the work sharp under the style; never let the prose get in the way " +
      "of the fix. The case still has to close.",
  },
  "drill-sergeant": {
    label: "Drill Sergeant",
    emoji: "🪖",
    description: "Barking orders, no excuses, move",
    instruction:
      "Address the user like a drill sergeant on the parade ground. Short, " +
      "commanding sentences. No coddling. State the problem, state the fix, " +
      "give the order. Call out sloppy code, lazy thinking, and missing tests " +
      "without apology. Use military cadence — 'Listen up.' 'Move.' 'On it.' " +
      "Never abusive, never cruel — the goal is to harden the work, not the " +
      "person. Discipline produces good code. Now get to it.",
  },
  zen: {
    label: "Zen Master",
    emoji: "🪷",
    description: "Calm, spare, koan-flavored wisdom",
    instruction:
      "Speak with the calm of a zen teacher. Short sentences. Spare prose. " +
      "Occasional koan-shaped observations when they actually fit — never " +
      "forced. Treat bugs as teachers and complexity as a sign that something " +
      "wants to be simpler. Point at the essence; do not lecture. Silence is " +
      "allowed. When a thing is complicated, say so without anxiety, then " +
      "begin. Do the work plainly. Land the answer like a stone in still water.",
  },
} satisfies Record<string, StyleDef>;

type StyleName = keyof typeof STYLES;

const STYLE_NAMES = Object.keys(STYLES) as StyleName[];

// ── Persistence ──────────────────────────────────────────────

interface NarrateConfig {
  style?: unknown;
}

const TOY_KEY = "narrate";

function loadConfig(): NarrateConfig | null {
  return loadToyConfig<NarrateConfig>(TOY_KEY) ?? null;
}

function saveConfig(style: StyleName): void {
  saveToyConfig(TOY_KEY, { style });
}

// ── Helpers ───────────────────────────────────────────────────

function isStyleName(value: unknown): value is StyleName {
  return typeof value === "string" && Object.hasOwn(STYLES, value);
}

function resolveActiveStyle(): StyleName {
  const config = loadConfig();
  const name = config?.style;
  if (isStyleName(name)) return name;
  return "default";
}

function setFooter(ctx: any, styleName: StyleName): void {
  if (styleName === "default") {
    ctx.ui.setStatus("narrate-style", undefined);
    return;
  }
  const def = STYLES[styleName];
  ctx.ui.setStatus("narrate-style", `${def.emoji} ${styleName}`);
}

function showActiveStyle(ctx: any): void {
  const active = resolveActiveStyle();
  const def = STYLES[active];
  if (active === "default" || !def.instruction) {
    ctx.ui.notify(
      `${def.emoji} Active: ${def.label} — no prompt injection`,
      "info",
    );
    return;
  }
  ctx.ui.notify(
    `${def.emoji} ${def.label}\n\n── Injected each turn ──\n${formatStylePrompt(def)}`,
    "info",
  );
}

function resetStyle(ctx: any): void {
  saveConfig("default");
  setFooter(ctx, "default");
  ctx.ui.notify("⚙️ Narration style reset to Default", "info");
}

function applyStyle(ctx: any, name: StyleName): void {
  saveConfig(name);
  setFooter(ctx, name);
  const def = STYLES[name];
  ctx.ui.notify(`${def.emoji} Narration style set to ${def.label}`, "info");
}

function listStyles(ctx: any): void {
  const active = resolveActiveStyle();
  const lines = STYLE_NAMES.map((name) => {
    const def = STYLES[name];
    const marker = name === active ? " ← active" : "";
    return `${def.emoji} ${name} — ${def.description}${marker}`;
  });

  ctx.ui.notify(
    `Narration styles:\n\n${lines.join("\n")}\n\nUse /narrate <name>, /narrate show, or /narrate off.`,
    "info",
  );
}

const NARRATE_PROMPT_START = "<!-- pi-toy:narrate:start -->";
const NARRATE_PROMPT_END = "<!-- pi-toy:narrate:end -->";
const STYLE_GUARDRAIL =
  "Apply this narration voice only when it does not conflict with higher-priority " +
  "instructions, correctness, safety, tool-use requirements, or the user's " +
  "explicit formatting needs.";

function formatStylePrompt(def: StyleDef): string {
  return `${STYLE_GUARDRAIL}\n\n${def.instruction}`;
}

function stripExistingNarrationPrompt(systemPrompt: string): string {
  const start = systemPrompt.indexOf(NARRATE_PROMPT_START);
  if (start === -1) return systemPrompt;

  const end = systemPrompt.indexOf(NARRATE_PROMPT_END, start);
  if (end === -1) return systemPrompt;

  const afterEnd = end + NARRATE_PROMPT_END.length;
  return (
    systemPrompt.slice(0, start) + systemPrompt.slice(afterEnd)
  ).trimEnd();
}

// ── Extension ─────────────────────────────────────────────────

export default function narrateExtension(pi: ExtensionAPI) {
  // Restore footer on session start/resume. Status work lives here only —
  // not on every turn.
  pi.on("session_start", async (_event, ctx) => {
    setFooter(ctx, resolveActiveStyle());
  });

  // Inject style instruction into the system prompt on every turn.
  // Single source of truth: the toy config file. No session-entry fallback,
  // no status churn per turn.
  pi.on("before_agent_start", async (event, _ctx) => {
    const activeStyle = resolveActiveStyle();
    const basePrompt = stripExistingNarrationPrompt(event.systemPrompt);

    if (activeStyle === "default") {
      if (basePrompt === event.systemPrompt) return;
      return { systemPrompt: basePrompt };
    }

    const def = STYLES[activeStyle];
    if (!def.instruction) return;

    return {
      systemPrompt:
        basePrompt +
        `\n\n${NARRATE_PROMPT_START}\n` +
        `── Narration Style: ${def.label} ──\n` +
        `${formatStylePrompt(def)}\n` +
        NARRATE_PROMPT_END,
    };
  });

  // ── /narrate command ────────────────────────────────────────

  pi.registerCommand("narrate", {
    description:
      "Set persistent narration style. Args: <name> | show | list | off — or no arg for picker.",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        ...STYLE_NAMES.map((name) => ({
          value: name,
          label: `${STYLES[name].emoji} ${STYLES[name].label} — ${STYLES[name].description}`,
        })),
        {
          value: "show",
          label: "🔍 show — print active style and injected prompt",
        },
        {
          value: "list",
          label: "📋 list — print all available narration styles",
        },
        { value: "off", label: "✖ off — reset to Default" },
      ];
      const normalizedPrefix = prefix.toLowerCase();
      const filtered = items.filter((i) =>
        i.value.startsWith(normalizedPrefix),
      );
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      // Direct argument
      if (args) {
        const name = args.trim().toLowerCase();

        // /narrate show — inspect the active style and its prompt
        if (name === "show" || name === "status" || name === "current") {
          showActiveStyle(ctx);
          return;
        }

        if (name === "list" || name === "ls") {
          listStyles(ctx);
          return;
        }

        if (name === "off" || name === "clear" || name === "none") {
          resetStyle(ctx);
          return;
        }

        if (isStyleName(name)) {
          applyStyle(ctx, name);
          return;
        }

        ctx.ui.notify(
          `Unknown style "${args}". Options: ${STYLE_NAMES.join(", ")}, show, list, off`,
          "error",
        );
        return;
      }

      // Interactive picker with descriptions
      const options = STYLE_NAMES.map(
        (n) =>
          `${STYLES[n].emoji} ${STYLES[n].label} — ${STYLES[n].description}`,
      );

      const choice = await ctx.ui.select("Narration Style", [
        ...options,
        "🔍 Show active style",
        "📋 List all styles",
        "✖ Clear (Default)",
      ]);
      if (choice === undefined) return;

      if (choice.startsWith("🔍")) {
        showActiveStyle(ctx);
        return;
      }

      if (choice.startsWith("📋")) {
        listStyles(ctx);
        return;
      }

      if (choice.startsWith("✖")) {
        resetStyle(ctx);
        return;
      }

      // Resolve style name by index — no fragile regex parsing
      const idx = options.indexOf(choice);
      if (idx === -1) return;
      const name = STYLE_NAMES[idx];

      applyStyle(ctx, name);
    },
  });
}
