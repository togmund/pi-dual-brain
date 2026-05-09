/**
 * pi-dual-brain — healthy dual-consciousness edition
 *
 * Two independent models, one mouthpiece. Right brain observes and
 * comments; left brain speaks. They influence each other across turns.
 *
 * Architecture:
 *   - Right brain observes each completed turn (agent_end)
 *   - Observation is shown to user (widget) and stored (session entry)
 *   - Next turn: left brain sees prior observation in system prompt
 *   - Explicit tool (converse_with_right_brain) for deep dialogue
 *
 * No confabulation. No hidden injection into assistant messages.
 * The right brain is a visible, independent presence.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect, Layer } from "effect";
import { AppConfig } from "./Config.js";
import { PiRuntime, RightBrain } from "./Domain.js";
import { RightBrainLive } from "./RightBrain.js";

const WIDGET_KEY = "dual-brain";
const STATUS_KEY = "dual-brain";
const STATE_ENTRY = "dual-brain-state";
const OBSERVATION_ENTRY = "dual-brain-observation";

let enabled = true;

function runRightBrain<A, E>(
  piCtx: ExtensionContext,
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, E, RightBrain>,
): Promise<A> {
  const PiRuntimeLive = Layer.succeed(PiRuntime, {
    modelRegistry: piCtx.modelRegistry as any,
    signal,
  });
  return effect.pipe(
    Effect.provide(RightBrainLive.pipe(Layer.provide(PiRuntimeLive))),
    Effect.runPromise,
  );
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function getLastObservation(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === OBSERVATION_ENTRY) {
      return (entry.data as { commentary: string }).commentary;
    }
  }
  return undefined;
}

function gatherObservations(ctx: ExtensionContext): Array<{ commentary: string; timestamp: number }> {
  const out: Array<{ commentary: string; timestamp: number }> = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === OBSERVATION_ENTRY) {
      out.push(entry.data as { commentary: string; timestamp: number });
    }
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // before_agent_start — left brain sees right brain's prior observation
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return {};

    const lastObservation = getLastObservation(ctx);
    if (!lastObservation) return {};

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Your Right Brain's Observation (from last turn)\n` +
        `> ${lastObservation}\n\n` +
        `You may reference, disagree with, or ignore this. Your right brain ` +
        `will observe this turn when you're done.`,
    };
  });

  // -------------------------------------------------------------------------
  // agent_end — right brain observes the completed turn
  // -------------------------------------------------------------------------

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;

    const config = await Effect.runPromise(AppConfig);
    const priorObservations = gatherObservations(ctx);

    const turnMessages = (event.messages as any[])
      .filter((m: any) => m.content !== undefined)
      .map((m: any) => ({ role: m.role as string, content: extractText(m.content) }));

    const current = turnMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    const priorText = priorObservations.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
    const transcript = priorText ? `${priorText}\n\n--- current turn ---\n\n${current}` : current;

    runRightBrain(ctx, undefined, Effect.gen(function* () {
      const rightBrain = yield* RightBrain;
      const commentary = yield* rightBrain.observe(transcript, config.model, config.persona);

      // Persist for next turn's system prompt
      pi.appendEntry(OBSERVATION_ENTRY, { commentary, timestamp: Date.now() });

      // Show to user as widget
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
    })).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Tool — explicit dialogue between left and right brain
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "converse_with_right_brain",
    label: "Consult Right Brain",
    description: "Have a direct conversation with your right brain. The dialogue is visible to the user.",
    parameters: Type.Object({
      message: Type.String({ description: "What to ask the right brain" }),
      model: Type.Optional(Type.String({ description: "Override model" })),
      persona: Type.Optional(Type.String({ description: "Override persona" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await Effect.runPromise(AppConfig);
      const priorObservations = gatherObservations(ctx);

      const text = await runRightBrain(ctx, signal, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        const transcript = priorObservations.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
        const full = transcript
          ? `${transcript}\n\n--- consult ---\n\n[left]: ${params.message}`
          : `[left]: ${params.message}`;
        return yield* rightBrain.observe(full, params.model ?? config.model, params.persona ?? config.persona);
      }));

      // Also persist as observation so it's part of ongoing context
      pi.appendEntry(OBSERVATION_ENTRY, { commentary: `[consult] ${text}`, timestamp: Date.now() });

      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  pi.registerCommand("dual-brain", {
    description: "Show status or toggle",
    handler: async (args, ctx) => {
      const config = await Effect.runPromise(AppConfig);

      if (args.trim() === "off") {
        enabled = false;
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

      const lastObs = getLastObservation(ctx);
      ctx.ui.notify(
        `Right brain: ${config.model} | ${enabled ? "on" : "off"}` +
          (lastObs ? ` | last: "${lastObs.slice(0, 40)}${lastObs.length > 40 ? "…" : ""}"` : ""),
        "info",
      );
    },
  });

  pi.registerCommand("dual-brain-clear", {
    description: "Clear observation history",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify("Observation history cleared", "info");
    },
  });

  // -------------------------------------------------------------------------
  // session_start
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
        const data = entry.data as { enabled?: boolean };
        if (typeof data.enabled === "boolean") enabled = data.enabled;
      }
    }

    const config = await Effect.runPromise(AppConfig);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `🧠 dual brain: ${config.model} — ${enabled ? "on" : "off"}  (/dual-brain off to disable)`,
        enabled ? "info" : "warning",
      );
    }
  });

  // -------------------------------------------------------------------------
  // session_shutdown
  // -------------------------------------------------------------------------

  pi.on("session_shutdown", async (_event, _ctx) => {
    pi.appendEntry(STATE_ENTRY, { enabled });
  });
}
