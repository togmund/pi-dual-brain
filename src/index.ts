/**
 * pi-dual-brain — minimal version
 *
 * Core flow: right brain observes each turn, commentary feeds into
 * left brain's context via before_agent_start.
 *
 * No tools. No Typebox. Events + commands only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { AppConfig } from "./Config.js";
import { PiRuntime, RightBrain } from "./Domain.js";
import { RightBrainLive } from "./RightBrain.js";

const WIDGET_KEY = "dual-brain";
const STATUS_KEY = "dual-brain";
const STATE_ENTRY = "dual-brain-state";
const COMMENT_ENTRY = "dual-brain-comment";

// ---------------------------------------------------------------------------
// Mutable module state — wiped on /reload, hydrated from session entries
// ---------------------------------------------------------------------------

let enabled = true;
let lastCommentary: string | undefined;

// ---------------------------------------------------------------------------
// Effect layer — RightBrain service only
// ---------------------------------------------------------------------------

function runRightBrain<A, E>(
  piCtx: ExtensionContext,
  signal: AbortSignal | undefined,
  effect: Effect.Effect<A, E, RightBrain>,
): Promise<A> {
  const PiRuntimeLive = Layer.succeed(PiRuntime, {
    modelRegistry: piCtx.modelRegistry as any,
    signal,
  });
  const layer = RightBrainLive.pipe(Layer.provide(PiRuntimeLive));
  return effect.pipe(Effect.provide(layer), Effect.runPromise);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
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

function buildTranscript(
  priorComments: Array<{ commentary: string; timestamp: number }>,
  turnMessages: Array<{ role: string; content: string }>,
): string {
  const prior = priorComments.map((c) => `[right-brain @ ${new Date(c.timestamp).toISOString()}]: ${c.commentary}`).join("\n\n");
  const current = turnMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  return prior ? `${prior}\n\n--- current turn ---\n\n${current}` : current;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // before_agent_start — inject right brain's prior commentary
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!enabled || !lastCommentary) return {};

    const injected =
      event.systemPrompt +
      `\n\n## Your Right Brain's Last Thought\n` +
      `Your silent partner observed the last turn and said:\n` +
        `> ${lastCommentary}\n\n` +
        `You may agree, disagree, or ignore this.`;

    // Persist the injection so the user can verify it happened
    pi.appendEntry("dual-brain-injection", {
      commentary: lastCommentary,
      systemPromptLength: injected.length,
      timestamp: Date.now(),
    });

    return { systemPrompt: injected };
  });

  // -------------------------------------------------------------------------
  // agent_end — fire right-brain observation
  // -------------------------------------------------------------------------

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;

    const config = await Effect.runPromise(AppConfig);

    const turnMessages = (event.messages as any[])
      .filter((m: any) => m.content !== undefined)
      .map((m: any) => ({ role: m.role as string, content: extractText(m.content) }));

    // Gather prior commentary from session entries for transcript context
    const priorComments: Array<{ commentary: string; timestamp: number }> = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === COMMENT_ENTRY) {
        const data = entry.data as { commentary: string; timestamp: number };
        priorComments.push(data);
      }
    }

    // Fire and forget
    runRightBrain(ctx, undefined, Effect.gen(function* () {
      const rightBrain = yield* RightBrain;
      const transcript = buildTranscript(priorComments, turnMessages);

      const commentary = yield* rightBrain.observe(transcript, config.model, config.persona);

      lastCommentary = commentary;

      // Persist commentary as session entry (survives /reload, user can inspect)
      pi.appendEntry(COMMENT_ENTRY, { commentary, timestamp: Date.now() });

      if (ctx.hasUI) {
        const theme = ctx.ui.theme;
        ctx.ui.setWidget(
          WIDGET_KEY,
          [theme.fg("accent", theme.bold("🧠 right brain")), theme.fg("dim", commentary)],
          { placement: "aboveEditor" },
        );
        ctx.ui.setStatus(STATUS_KEY, `🧠 ${commentary.slice(0, 40)}${commentary.length > 40 ? "…" : ""}`);
      }
    })).catch(() => {});
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
        lastCommentary = undefined;
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

      // Count commentary entries
      let count = 0;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === COMMENT_ENTRY) count++;
      }

      ctx.ui.notify(
        `Right brain: ${config.model} | ${enabled ? "on" : "off"} | ${count} commentaries stored`,
        "info",
      );
    },
  });

  pi.registerCommand("dual-brain-clear", {
    description: "Clear dialogue history",
    handler: async (_args, ctx) => {
      lastCommentary = undefined;
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify("Dialogue history cleared", "info");
    },
  });

  // -------------------------------------------------------------------------
  // session_start — hydrate state from persisted entries
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
        const data = entry.data as { enabled?: boolean };
        if (typeof data.enabled === "boolean") enabled = data.enabled;
      }
      if (entry.type === "custom" && entry.customType === COMMENT_ENTRY) {
        const data = entry.data as { commentary: string };
        lastCommentary = data.commentary;
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
