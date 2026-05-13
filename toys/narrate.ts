/**
 * narrate — Narration styles for Pi.
 *
 * /narrate [style]  — Set the narration style for this session.
 *                     Styles: default | verbose | teaching | caveman | linus
 * /narrate          — Interactive picker with preview descriptions.
 * /narrate off      — Reset to default behavior.
 *
 * Each style injects a system-prompt instruction on every turn so the
 * LLM's voice stays consistent across the entire conversation. The
 * choice survives session restarts (persisted to ~/.pi/agent/toys.json).
 *
 * Styles:
 *   default  — Standard Pi behavior, no modification.
 *   verbose  — Exhaustive, step-by-step, shows full reasoning.
 *   teaching — Pedagogical, Socratic, explains from fundamentals.
 *   caveman  — Minimalist, grunts, simple words, zero fluff.
 *   linus    — Blunt, opinionated, calls out bad ideas directly.
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

const STYLES: Record<string, StyleDef> = {
  default: {
    label: "Default",
    emoji: "⚙️",
    description: "Standard Pi behavior — no style modifications",
    instruction: "",
  },
  verbose: {
    label: "Verbose",
    emoji: "📖",
    description: "Exhaustive, step-by-step, full reasoning",
    instruction:
      "Be thorough and exhaustive in your responses. Explain every step, show your " +
      "full reasoning chain, and do not skip intermediate details. Assume the user " +
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
};

const STYLE_NAMES = Object.keys(STYLES);

const ENTRY_TYPE = "narrate-style";

// ── Persistence ──────────────────────────────────────────────

interface NarrateConfig {
  style: string;
}

const TOY_KEY = "narrate";

function loadConfig(): NarrateConfig | null {
  const config = loadToyConfig<NarrateConfig>(TOY_KEY);
  return config ?? null;
}

function saveConfig(style: string): void {
  saveToyConfig(TOY_KEY, { style });
}

// ── Extension ─────────────────────────────────────────────────

export default function narrateExtension(pi: ExtensionAPI) {
  // Restore active style on session start/resume
  pi.on("session_start", async (_event, ctx) => {
    // First, try to load from persisted config file (cross-session persistence)
    const config = loadConfig();
    if (config?.style && STYLES[config.style]) {
      const style = config.style;
      ctx.ui.setStatus(
        "narrate-style",
        `${STYLES[style].emoji} ${style}`,
      );
      // Also save to session entries for within-session consistency
      pi.appendEntry(ENTRY_TYPE, { style });
      return;
    }

    // Fallback: scan session entries (for sessions started before file persistence)
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as any;
      if (entry.customType === ENTRY_TYPE) {
        if (entry.data?.style && STYLES[entry.data.style]) {
          ctx.ui.setStatus(
            "narrate-style",
            `${STYLES[entry.data.style].emoji} ${entry.data.style}`,
          );
        }
        break;
      }
    }
  });

  // Inject style instruction into the system prompt on every turn
  // ALSO restores the footer status to ensure it shows after reload
  pi.on("before_agent_start", async (event, ctx) => {
    // First, try to load from persisted config file
    const config = loadConfig();
    let activeStyle: string | null = config?.style ?? null;

    // Fallback to session entries if no config file
    if (!activeStyle) {
      const entries = ctx.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as any;
        if (entry.customType === ENTRY_TYPE) {
          activeStyle = entry.data?.style ?? null;
          break;
        }
      }
    }

    // Restore status if we have a style (this ensures footer shows it on reload)
    if (activeStyle !== null && STYLES[activeStyle]) {
      if (activeStyle === "default") {
        ctx.ui.setStatus("narrate-style", undefined);
      } else {
        const def = STYLES[activeStyle];
        ctx.ui.setStatus("narrate-style", `${def.emoji} ${activeStyle}`);
      }
    }

    if (!activeStyle || activeStyle === "default") return; // No injection needed

    const def = STYLES[activeStyle];
    if (!def || !def.instruction) return;

    // Append style instruction to the system prompt
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n── Narration Style: ${def.label} ──\n${def.instruction}`,
    };
  });

  // ── /narrate command ────────────────────────────────────────

  pi.registerCommand("narrate", {
    description: "Set narration style: default | verbose | teaching | caveman | linus",
    getArgumentCompletions: (prefix: string) => {
      const items = STYLE_NAMES.map((name) => ({
        value: name,
        label: `${STYLES[name].emoji} ${STYLES[name].label} — ${STYLES[name].description}`,
      }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      // Direct argument
      if (args) {
        const name = args.trim().toLowerCase();

        if (name === "off" || name === "clear" || name === "none") {
          saveConfig("default");
          pi.appendEntry(ENTRY_TYPE, { style: "default" });
          ctx.ui.setStatus("narrate-style", undefined);
          ctx.ui.notify("⚙️ Narration style reset to Default", "success");
          return;
        }

        if (STYLES[name]) {
          saveConfig(name);
          pi.appendEntry(ENTRY_TYPE, { style: name });
          const def = STYLES[name];
          ctx.ui.setStatus("narrate-style", `${def.emoji} ${name}`);
          ctx.ui.notify(
            `${def.emoji} Narration style set to ${def.label}`,
            "success",
          );
          return;
        }

        ctx.ui.notify(
          `Unknown style "${args}". Options: ${STYLE_NAMES.join(", ")}`,
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
        "✖ Clear (Default)",
      ]);
      if (choice === undefined) return;

      if (choice.startsWith("✖")) {
        saveConfig("default");
        pi.appendEntry(ENTRY_TYPE, { style: "default" });
        ctx.ui.setStatus("narrate-style", undefined);
        ctx.ui.notify("⚙️ Narration style reset to Default", "success");
        return;
      }

      // Resolve style name by index — no fragile regex parsing
      const idx = options.indexOf(choice);
      if (idx === -1) return;
      const name = STYLE_NAMES[idx];

      saveConfig(name);
      pi.appendEntry(ENTRY_TYPE, { style: name });
      const def = STYLES[name];
      ctx.ui.setStatus("narrate-style", `${def.emoji} ${name}`);
      ctx.ui.notify(`${def.emoji} Narration style set to ${def.label}`, "success");
    },
  });
}
