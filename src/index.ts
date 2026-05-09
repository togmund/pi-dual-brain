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
 * They influence each other. You see both minds.
 *
 * Configuration:
 *   RIGHT_BRAIN_MODEL=provider/model   (default: opencode-go/deepseek-v4-pro)
 *   RIGHT_BRAIN_PERSONA="..."          (optional)
 *
 * Commands:
 *   /dual-brain              Show status
 *   /dual-brain off          Disable right-brain observations
 *   /dual-brain on           Re-enable
 *   /dual-brain-clear        Clear internal dialogue history
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect, Layer } from "effect";
import { AppConfig } from "./Config.js";
import {
  Conversation,
  ConversationLive,
  PiRuntime,
  RightBrain,
  type DialogueEntry,
} from "./Domain.js";
import { RightBrainLive } from "./RightBrain.js";

const WIDGET_KEY = "dual-brain";
const STATUS_KEY = "dual-brain";

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

function makeLayer(piCtx: ExtensionContext, signal: AbortSignal | undefined) {
  const PiRuntimeLive = Layer.succeed(PiRuntime, {
    modelRegistry: piCtx.modelRegistry as any,
    signal,
  });

  return RightBrainLive.pipe(
    Layer.provide(PiRuntimeLive),
    Layer.merge(ConversationLive),
  );
}

function run<A, E>(
  piCtx: ExtensionContext,
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, E, RightBrain | Conversation>,
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
  entries: ReadonlyArray<DialogueEntry>,
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
  let enabled = true;
  let currentRightBrainComment: string | undefined;

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

    // Fire and forget — don't block the UI
    run(ctx, undefined, Effect.gen(function* () {
      const rightBrain = yield* RightBrain;
      const conv = yield* Conversation;

      const history = yield* conv.getHistory;
      const transcript = buildTurnTranscript(history, turnMessages);

      const commentary = yield* rightBrain.observe(
        transcript,
        config.model,
        config.persona,
      );

      currentRightBrainComment = commentary;

      yield* conv.record({
        from: "right",
        to: "left",
        content: commentary,
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
      // Silently ignore right-brain failures — left brain must not be blocked
    });
  });

  // -------------------------------------------------------------------------
  // Introspection tool — so the left brain can see its own state
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "check_dual_brain_status",
    label: "Check Dual Brain Status",
    description: "Check if the dual-brain extension is active, what model the right brain uses, and what it last said.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = await Effect.runPromise(AppConfig);

      const history = await run(ctx, undefined, Effect.gen(function* () {
        const conv = yield* Conversation;
        return yield* conv.getHistory;
      }));

      const lastRight = history.length > 0
        ? [...history].reverse().find((e) => e.from === "right")
        : undefined;

      const transcript = history.map((e) => `[${e.from}→${e.to}]: ${e.content}`).join("\n\n");

      return {
        content: [{ type: "text", text: `Dual brain is ${enabled ? "enabled" : "disabled"}.\nRight brain model: ${config.model}\nTurns in history: ${history.length}\nLast right-brain thought: ${lastRight?.content ?? "(none yet)"}` }],
        details: {
          enabled,
          model: config.model,
          persona: config.persona,
          turnCount: history.length,
          lastCommentary: lastRight?.content ?? null,
          transcript,
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
      const text = await run(ctx, signal, deepConsult(params));
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

      const history = await run(ctx, undefined, Effect.gen(function* () {
        const conv = yield* Conversation;
        return yield* conv.getHistory;
      }));

      const status = enabled ? "enabled" : "disabled";
      ctx.ui.notify(
        `Right brain: ${config.model} | ${status} | ${history.length} turns`,
        "info",
      );
    },
  });

  pi.registerCommand("dual-brain-clear", {
    description: "Clear the internal dialogue history",
    handler: async (_args, ctx) => {
      await run(ctx, undefined, Effect.gen(function* () {
        const conv = yield* Conversation;
        yield* conv.clear;
      }));
      currentRightBrainComment = undefined;
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify("Dialogue history cleared", "info");
    },
  });

  // -------------------------------------------------------------------------
  // session_start — restore state
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const config = await Effect.runPromise(AppConfig);

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "dual-brain-state") {
        const data = entry.data as { enabled?: boolean };
        if (typeof data.enabled === "boolean") enabled = data.enabled;
      }
    }

    if (ctx.hasUI) {
      ctx.ui.notify(
        `🧠 dual brain: ${config.model} — ${enabled ? "on" : "off"}  (/dual-brain off to disable)`,
        enabled ? "info" : "warning",
      );
    }
  });

  // -------------------------------------------------------------------------
  // session_shutdown — persist state
  // -------------------------------------------------------------------------

  pi.on("session_shutdown", async (_event, _ctx) => {
    pi.appendEntry("dual-brain-state", { enabled });
  });
}

// ---------------------------------------------------------------------------
// Deep consult (explicit tool)
// ---------------------------------------------------------------------------

function deepConsult(params: {
  message: string;
  model?: string;
  persona?: string;
}): Effect.Effect<string, never, RightBrain | Conversation> {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const rightBrain = yield* RightBrain;
    const conv = yield* Conversation;

    const modelRef = params.model ?? config.model;
    const persona = params.persona ?? config.persona;

    yield* conv.record({ from: "left", to: "right", content: params.message });

    const history = yield* conv.getHistory;
    const transcript = history.map((e) => `[${e.from}]: ${e.content}`).join("\n\n");

    const response = yield* rightBrain.observe(
      `${transcript}\n\n--- current consult ---\n\n[left]: ${params.message}`,
      modelRef,
      persona,
    );

    yield* conv.record({ from: "right", to: "left", content: response });

    return response;
  }).pipe(
    Effect.catchAll((error) => Effect.succeed(`Error consulting right brain: ${error.message}`)),
  );
}
