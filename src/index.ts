/**
 * pi-dual-brain
 *
 * Gives your agent a double brain. Both hemispheres process every turn.
 *
 * Left brain (your active pi model) speaks to you.
 * Right brain (a second model of your choice) observes each turn and
 * generates commentary — shown in a widget and fed into left brain's
 * context on the next turn.
 *
 * State is persisted in session entries (survives /reload) and mirrored
 * in-memory for fast access during the session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect, Layer } from "effect";
import { AppConfig } from "./Config.js";
import {
  PiRuntime,
  RightBrain,
  DialogueEntry,
  type DialogueEntry as DialogueEntryType,
} from "./Domain.js";
import { RightBrainLive } from "./RightBrain.js";

const WIDGET_KEY = "dual-brain";
const STATUS_KEY = "dual-brain";
const STATE_ENTRY_TYPE = "dual-brain-state";
const DIALOGUE_ENTRY_TYPE = "dual-brain-dialogue";

// ---------------------------------------------------------------------------
// In-memory mirror — fast access during the session
// ---------------------------------------------------------------------------

let enabled = true;
let currentRightBrainComment: string | undefined;
const dialogueHistory: DialogueEntryType[] = [];

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function recordEntry(entry: Omit<DialogueEntryType, "id" | "timestamp">) {
  dialogueHistory.push(new DialogueEntry(entry));
}

function getHistory(): ReadonlyArray<DialogueEntryType> {
  return dialogueHistory;
}

function getLastRightBrainComment(): string | undefined {
  for (let i = dialogueHistory.length - 1; i >= 0; i--) {
    if (dialogueHistory[i].from === "right") return dialogueHistory[i].content;
  }
  return undefined;
}

function clearHistory() {
  dialogueHistory.length = 0;
}

function getTranscript(): string {
  return dialogueHistory.map((e) => `[${e.from}→${e.to}]: ${e.content}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Hydrate from session — called once at session_start
// ---------------------------------------------------------------------------

function hydrateFromSession(ctx: ExtensionContext) {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "custom") continue;

    if (entry.customType === STATE_ENTRY_TYPE) {
      const data = entry.data as { enabled?: boolean };
      if (typeof data.enabled === "boolean") enabled = data.enabled;
    }

    if (entry.customType === DIALOGUE_ENTRY_TYPE) {
      const data = entry.data as {
        from: "left" | "right";
        to: "left" | "right";
        content: string;
        timestamp: number;
      };
      dialogueHistory.push(
        new DialogueEntry({
          from: data.from,
          to: data.to,
          content: data.content,
        }),
      );
      if (data.from === "right") {
        currentRightBrainComment = data.content;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Effect layer wiring — RightBrain only (conversation is plain mutable)
// ---------------------------------------------------------------------------

function makeLayer(piCtx: ExtensionContext, signal: AbortSignal | undefined) {
  const PiRuntimeLive = Layer.succeed(PiRuntime, {
    modelRegistry: piCtx.modelRegistry as any,
    signal,
  });
  return RightBrainLive.pipe(Layer.provide(PiRuntimeLive));
}

function runRightBrain<A, E>(
  piCtx: ExtensionContext,
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, E, RightBrain>,
): Promise<A> {
  return effect.pipe(Effect.provide(makeLayer(piCtx, signal)), Effect.runPromise);
}

// ---------------------------------------------------------------------------
// Transcript builder
// ---------------------------------------------------------------------------

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string };
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

function buildTurnTranscript(
  entries: ReadonlyArray<DialogueEntryType>,
  turnMessages: Array<{ role: string; content: string }>,
): string {
  const prior = entries.map((e) => `[${e.from}]: ${e.content}`).join("\n\n");
  const current = turnMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  return prior ? `${prior}\n\n--- current turn ---\n\n${current}` : current;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // before_agent_start — inject right brain's prior comment into context
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!enabled || !currentRightBrainComment) return {};

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Your Right Brain's Last Thought\n` +
        `Your silent partner (running on a different model) observed the last turn and said:\n` +
        `> ${currentRightBrainComment}\n\n` +
        `You may agree, disagree, or ignore this. It is not authoritative — just another perspective.`,
    };
  });

  // -------------------------------------------------------------------------
  // agent_end — fire right-brain observation in background
  // -------------------------------------------------------------------------

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;

    const config = await Effect.runPromise(AppConfig);

    const turnMessages = (event.messages as any[])
      .filter((m: any) => m.content !== undefined)
      .map((m: any) => ({
        role: m.role as string,
        content: extractTextContent(m.content),
      }));

    // Fire and forget
    runRightBrain(ctx, undefined, Effect.gen(function* () {
      const rightBrain = yield* RightBrain;

      const history = getHistory();
      const transcript = buildTurnTranscript(history, turnMessages);

      const commentary = yield* rightBrain.observe(
        transcript,
        config.model,
        config.persona,
      );

      currentRightBrainComment = commentary;
      recordEntry({ from: "right", to: "left", content: commentary });

      // Persist to session so it survives /reload
      pi.appendEntry(DIALOGUE_ENTRY_TYPE, {
        from: "right",
        to: "left",
        content: commentary,
        timestamp: Date.now(),
      });

      if (ctx.hasUI) {
        const theme = ctx.ui.theme;
        ctx.ui.setWidget(
          WIDGET_KEY,
          [
            theme.fg("accent", theme.bold("🧠 right brain")),
            theme.fg("dim", commentary),
          ],
          { placement: "aboveEditor" },
        );
        ctx.ui.setStatus(
          STATUS_KEY,
          `🧠 ${commentary.slice(0, 40)}${commentary.length > 40 ? "…" : ""}`,
        );
      }
    })).catch(() => {
      // Silently ignore right-brain failures
    });
  });

  // -------------------------------------------------------------------------
  // Introspection tool
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "check_dual_brain_status",
    label: "Check Dual Brain Status",
    description: "Check if the dual-brain extension is active, what model the right brain uses, and what it last said.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const config = await Effect.runPromise(AppConfig);
      const lastRight = getLastRightBrainComment();

      return {
        content: [{ type: "text", text: `Dual brain is ${enabled ? "enabled" : "disabled"}.\nRight brain model: ${config.model}\nTurns in history: ${dialogueHistory.length}\nLast right-brain thought: ${lastRight ?? "(none yet)"}` }],
        details: {
          enabled,
          model: config.model,
          persona: config.persona,
          turnCount: dialogueHistory.length,
          lastCommentary: lastRight ?? null,
          transcript: getTranscript(),
        },
      };
    },
  });

  // -------------------------------------------------------------------------
  // Explicit consult tool
  // -------------------------------------------------------------------------

  const ConsultParams = Type.Object({
    message: Type.String({ description: "What to ask the right brain" }),
    model: Type.Optional(Type.String({ description: 'Override model, e.g. "provider/model"' })),
    persona: Type.Optional(Type.String({ description: "Override persona for this consult" })),
  });

  pi.registerTool({
    name: "converse_with_right_brain",
    label: "Consult Right Brain",
    description: "Ask your right brain for deep insight, critique, or creative input.",
    parameters: ConsultParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await Effect.runPromise(AppConfig);

      const modelRef = params.model ?? config.model;
      const persona = params.persona ?? config.persona;

      recordEntry({ from: "left", to: "right", content: params.message });

      const text = await runRightBrain(ctx, signal, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        const transcript = getTranscript();

        const response = yield* rightBrain.observe(
          `${transcript}\n\n--- current consult ---\n\n[left]: ${params.message}`,
          modelRef,
          persona,
        );

        recordEntry({ from: "right", to: "left", content: response });

        // Persist consult to session
        pi.appendEntry(DIALOGUE_ENTRY_TYPE, {
          from: "right",
          to: "left",
          content: response,
          timestamp: Date.now(),
        });

        return response;
      }));

      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("dual-brain", {
    description: "Show dual-brain status or toggle",
    handler: async (args, ctx) => {
      const config = await Effect.runPromise(AppConfig);

      if (args.trim() === "off") {
        enabled = false;
        currentRightBrainComment = undefined;
        if (ctx.hasUI) {
          ctx.ui.setWidget(WIDGET_KEY, undefined);
          ctx.ui.setStatus(STATUS_KEY, undefined);
        }
        ctx.ui.notify("Right brain disabled", "info");
        return;
      }

      if (args.trim() === "on") {
        enabled = true;
        ctx.ui.notify("Right brain enabled", "info");
        return;
      }

      ctx.ui.notify(
        `Right brain: ${config.model} | ${enabled ? "enabled" : "disabled"} | ${dialogueHistory.length} turns`,
        "info",
      );
    },
  });

  pi.registerCommand("dual-brain-clear", {
    description: "Clear the internal dialogue history",
    handler: async (_args, ctx) => {
      clearHistory();
      currentRightBrainComment = undefined;
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify("Dialogue history cleared", "info");
    },
  });

  // -------------------------------------------------------------------------
  // session_start — hydrate from persisted entries
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    hydrateFromSession(ctx);

    const config = await Effect.runPromise(AppConfig);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `🧠 dual brain: ${config.model} — ${enabled ? "on" : "off"} (${dialogueHistory.length} turns restored)  (/dual-brain off to disable)`,
        enabled ? "info" : "warning",
      );
    }
  });

  // -------------------------------------------------------------------------
  // session_shutdown — persist toggle state
  // -------------------------------------------------------------------------

  pi.on("session_shutdown", async (_event, _ctx) => {
    pi.appendEntry(STATE_ENTRY_TYPE, { enabled });
  });
}
