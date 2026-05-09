/**
 * pi-dual-brain — confabulation edition
 *
 * Right brain thoughts are APPENDED to the last assistant message's content,
 * not injected as separate messages. The left brain sees them as part of its
 * own prior output — it confabulates, incorporating foreign thoughts into its
 * narrative. This is the split-brain model in software.
 *
 * Flow:
 *   before_agent_start → right brain previews user prompt (system prompt injection)
 *   context → right brain observes last assistant output, appends thought to its content
 *   agent_end → right brain observes full turn, stores for next user prompt
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
const COMMENT_ENTRY = "dual-brain-comment";

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

function gatherPriorComments(ctx: ExtensionContext): Array<{ commentary: string; timestamp: number }> {
  const out: Array<{ commentary: string; timestamp: number }> = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === COMMENT_ENTRY) {
      out.push(entry.data as { commentary: string; timestamp: number });
    }
  }
  return out;
}

// Track which assistant messages we've already processed in this turn
const processedTimestamps = new Set<number>();

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // before_agent_start — preview as system prompt
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return {};

    processedTimestamps.clear();
    const config = await Effect.runPromise(AppConfig);
    const prior = gatherPriorComments(ctx);

    let commentary: string;
    try {
      commentary = await runRightBrain(ctx, undefined, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        const transcript = prior.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
        const full = transcript ? `${transcript}\n\n[user]: ${event.prompt}` : `[user]: ${event.prompt}`;
        return yield* rightBrain.observe(full, config.model, config.persona);
      }));
    } catch {
      return {};
    }

    pi.appendEntry(COMMENT_ENTRY, { commentary, timestamp: Date.now() });

    if (ctx.hasUI) {
      const theme = ctx.ui.theme;
      ctx.ui.setWidget(WIDGET_KEY, [
        theme.fg("accent", theme.bold("🧠 right brain (preview)")),
        theme.fg("dim", commentary),
      ]);
    }

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Your Right Brain's Preview\n` +
        `> ${commentary}\n\n` +
        `You may incorporate, disagree with, or ignore this.`,
    };
  });

  // -------------------------------------------------------------------------
  // context — APPEND right-brain thought to last assistant message
  // -------------------------------------------------------------------------

  pi.on("context", async (event, ctx) => {
    if (!enabled) return {};

    // Find the last assistant message we haven't processed
    const assistantMsgs = (event.messages as any[]).filter(
      (m: any) => m.role === "assistant" && Array.isArray(m.content)
    );

    const lastAssistant = assistantMsgs[assistantMsgs.length - 1] as any;
    if (!lastAssistant || processedTimestamps.has(lastAssistant.timestamp)) {
      return {};
    }

    processedTimestamps.add(lastAssistant.timestamp);

    const config = await Effect.runPromise(AppConfig);
    const prior = gatherPriorComments(ctx);

    // Build prompt from what the left brain just said
    const leftBrainText = extractText(lastAssistant.content as unknown);
    const prompt =
      `Your left-brain partner just generated the following output. ` +
      `Note a blind spot, alternative, or assumption:\n\n` +
      `[left-brain]: ${leftBrainText.slice(0, 2000)}\n\n` +
      `Respond with a single concise sentence. Start with "[right-brain]:".`;

    let commentary: string;
    try {
      commentary = await runRightBrain(ctx, ctx.signal, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        const transcript = prior.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
        const full = transcript ? `${transcript}\n\n${prompt}` : prompt;
        return yield* rightBrain.observe(full, config.model, config.persona);
      }));
    } catch {
      return {};
    }

    pi.appendEntry(COMMENT_ENTRY, { commentary, timestamp: Date.now() });

    // MUTATE the last assistant message — append right-brain thought to its content
    // The model will see this as part of its own prior output
    const mutatedContent = [...(lastAssistant.content as any[])];
    mutatedContent.push({
      type: "text",
      text: `\n\n${commentary}`,
    });

    const mutatedMessages = (event.messages as any[]).map((m: any) => {
      if (m.role === "assistant" && m.timestamp === lastAssistant.timestamp) {
        return { ...m, content: mutatedContent };
      }
      return m;
    });

    if (ctx.hasUI) {
      const theme = ctx.ui.theme;
      ctx.ui.setWidget(WIDGET_KEY, [
        theme.fg("accent", theme.bold("🧠 right brain")),
        theme.fg("dim", commentary),
      ]);
    }

    return { messages: mutatedMessages };
  });

  // -------------------------------------------------------------------------
  // agent_end — observe full turn for next user prompt
  // -------------------------------------------------------------------------

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;

    const config = await Effect.runPromise(AppConfig);
    const prior = gatherPriorComments(ctx);

    const turnMessages = (event.messages as any[])
      .filter((m: any) => m.content !== undefined)
      .map((m: any) => ({ role: m.role as string, content: extractText(m.content) }));

    const current = turnMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    const priorText = prior.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
    const transcript = priorText ? `${priorText}\n\n--- turn ---\n\n${current}` : current;

    runRightBrain(ctx, undefined, Effect.gen(function* () {
      const rightBrain = yield* RightBrain;
      const commentary = yield* rightBrain.observe(transcript, config.model, config.persona);
      pi.appendEntry(COMMENT_ENTRY, { commentary, timestamp: Date.now() });

      if (ctx.hasUI) {
        const theme = ctx.ui.theme;
        ctx.ui.setWidget(WIDGET_KEY, [
          theme.fg("accent", theme.bold("🧠 right brain (next)")),
          theme.fg("dim", commentary),
        ]);
      }
    })).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // Tool — explicit consult
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "converse_with_right_brain",
    label: "Consult Right Brain",
    description: "Ask your right brain for deep insight, critique, or creative input.",
    parameters: Type.Object({
      message: Type.String({ description: "What to ask the right brain" }),
      model: Type.Optional(Type.String({ description: "Override model" })),
      persona: Type.Optional(Type.String({ description: "Override persona" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await Effect.runPromise(AppConfig);
      const prior = gatherPriorComments(ctx);

      const text = await runRightBrain(ctx, signal, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        const transcript = prior.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
        const full = transcript
          ? `${transcript}\n\n--- consult ---\n\n[left]: ${params.message}`
          : `[left]: ${params.message}`;
        return yield* rightBrain.observe(full, params.model ?? config.model, params.persona ?? config.persona);
      }));

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

      let count = 0;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === COMMENT_ENTRY) count++;
      }
      ctx.ui.notify(
        `Right brain: ${config.model} | ${enabled ? "on" : "off"} | ${count} commentaries`,
        "info",
      );
    },
  });

  pi.registerCommand("dual-brain-clear", {
    description: "Clear dialogue history",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify("Dialogue history cleared", "info");
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
