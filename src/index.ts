/**
 * pi-dual-brain — internal monologue edition
 *
 * Right brain speaks in assistant-role messages via context injection.
 * Left brain sees right-brain thoughts as if they were its own prior
 * reflections, marked with [right-brain] to preserve epistemic status.
 *
 * Flow:
 *   before_agent_start → right brain previews, injects as system prompt
 *   context → right brain observes prior assistant output, injects as [right-brain] assistant message
 *   tool_result → right brain critiques tool output, injects as [right-brain] assistant message
 *   agent_end → right brain observes full turn, stores for next user message
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
let lastCommentary: string | undefined;
let turnAssistantMessages: Array<{ content: string; timestamp: number }> = [];

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

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // before_agent_start — preview as system prompt injection
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return {};

    turnAssistantMessages = [];
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

    lastCommentary = commentary;
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
  // context — inject [right-brain] assistant messages before LLM calls
  // -------------------------------------------------------------------------

  pi.on("context", async (event, ctx) => {
    if (!enabled) return {};

    // Only inject if there's been assistant output this turn we haven't processed
    const assistantOutputs = event.messages.filter(
      (m) => m.role === "assistant" && m.content
    ) as Array<{ role: "assistant"; content: any[]; timestamp: number }>;

    const newAssistantMessages = assistantOutputs.filter(
      (m) => !turnAssistantMessages.some((tam) => tam.timestamp === m.timestamp)
    );

    if (newAssistantMessages.length === 0) return {};

    // Record them so we don't re-process
    for (const msg of newAssistantMessages) {
      turnAssistantMessages.push({
        content: extractText(msg.content),
        timestamp: msg.timestamp,
      });
    }

    const config = await Effect.runPromise(AppConfig);
    const prior = gatherPriorComments(ctx);

    // Build transcript of what the left brain just said
    const leftBrainOutput = newAssistantMessages
      .map((m) => extractText(m.content))
      .join("\n\n");

    const prompt =
      `Your left-brain partner just said the following. Briefly note a blind spot, ` +
      `alternative angle, or implicit assumption:\n\n` +
      `[left-brain]: ${leftBrainOutput.slice(0, 2000)}\n\n` +
      `Be concise — one sentence. Start with "[right-brain]:".`;

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

    lastCommentary = commentary;
    pi.appendEntry(COMMENT_ENTRY, { commentary, timestamp: Date.now() });

    // Inject as assistant message with [right-brain] marker
    // The left brain will see this as if it had thought it
    const injected: any = {
      role: "assistant",
      content: [{ type: "text", text: `[right-brain]: ${commentary}` }],
      timestamp: Date.now(),
      api: "custom",
      provider: "dual-brain",
      model: config.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
    };

    const messages = [...event.messages, injected];

    if (ctx.hasUI) {
      const theme = ctx.ui.theme;
      ctx.ui.setWidget(WIDGET_KEY, [
        theme.fg("accent", theme.bold("🧠 right brain")),
        theme.fg("dim", commentary),
      ]);
    }

    return { messages };
  });

  // -------------------------------------------------------------------------
  // agent_end — observe full turn for next user message
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

      lastCommentary = commentary;
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
      model: Type.Optional(Type.String({ description: 'Override model' })),
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
      lastCommentary = undefined;
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
      if (entry.type === "custom" && entry.customType === COMMENT_ENTRY) {
        lastCommentary = (entry.data as { commentary: string }).commentary;
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
