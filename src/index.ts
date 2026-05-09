/**
 * pi-dual-brain
 *
 * Gives your agent a double brain. The left brain (your active pi model)
 * speaks to you. The right brain (a second model of your choice) can be
 * consulted via the `converse_with_right_brain` tool. The two brains
 * share a dialogue history within each session.
 *
 * Configuration:
 *   RIGHT_BRAIN_MODEL=provider/model   (e.g. deepseek/deepseek-chat)
 *   RIGHT_BRAIN_PERSONA="..."          (optional system prompt)
 *   RIGHT_BRAIN_MAX_DEPTH=3            (default internal turn depth)
 *
 * Commands:
 *   /dual-brain                        Show status and current right-brain model
 *   /dual-brain-clear                  Clear the internal dialogue history
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect, Layer } from "effect";
import { AppConfig } from "./Config.js";
import { Conversation, ConversationLive, PiRuntime, RightBrain } from "./Domain.js";
import { RightBrainLive } from "./RightBrain.js";

// ---------------------------------------------------------------------------
// Layer wiring
// ---------------------------------------------------------------------------

function makeLayer(piCtx: ExtensionContext, signal: AbortSignal | undefined) {
  const PiRuntimeLive = Layer.succeed(PiRuntime, {
    modelRegistry: piCtx.modelRegistry,
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
// Consult logic
// ---------------------------------------------------------------------------

function consult(params: {
  message: string;
  model?: string;
  depth?: number;
  persona?: string;
}): Effect.Effect<string, never, RightBrain | Conversation> {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const rightBrain = yield* RightBrain;
    const conv = yield* Conversation;

    const modelRef = params.model ?? config.model;
    const persona = params.persona ?? config.persona;
    const depth = params.depth ?? config.maxDepth;

    yield* conv.record({ from: "left", to: "right", content: params.message });

    let lastResponse = "";

    for (let i = 0; i < depth; i++) {
      const history = yield* conv.getHistory;
      const response = yield* rightBrain.ask(
        i === 0 ? params.message : lastResponse,
        history,
        modelRef,
        persona,
      );

      lastResponse = response;
      yield* conv.record({ from: "right", to: "left", content: response });
    }

    return lastResponse;
  }).pipe(
    Effect.catchAll((error) => Effect.succeed(`Error consulting right brain: ${error.message}`)),
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const ConsultParams = Type.Object({
  message: Type.String({ description: "What to ask the right brain" }),
  model: Type.Optional(Type.String({ description: 'Override model, e.g. "provider/model"' })),
  depth: Type.Optional(
    Type.Number({ description: "Internal dialogue depth (default from env)", minimum: 1, maximum: 5 }),
  ),
  persona: Type.Optional(Type.String({ description: "Override persona for this consult" })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "converse_with_right_brain",
    label: "Consult Right Brain",
    description: "Ask your inner right brain for insight, critique, or creative input.",
    parameters: ConsultParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const text = await run(ctx, signal, consult(params));
      return { content: [{ type: "text", text }] };
    },
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const config = await Effect.runPromise(AppConfig);
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Your Right Brain\n` +
        `You have a silent partner — a second mind accessible only via the ` +
        `\`converse_with_right_brain\` tool. It runs on **${config.model}**. ` +
        `Use it when you want a second opinion, creative input, or critical analysis.`,
    };
  });

  pi.registerCommand("dual-brain", {
    description: "Show dual-brain status",
    handler: async (_args, ctx) => {
      const config = await Effect.runPromise(AppConfig);
      const history = await run(ctx, undefined, Effect.gen(function* () {
        const conv = yield* Conversation;
        return yield* conv.getHistory;
      }));

      ctx.ui.notify(
        `Right brain: ${config.model}  |  History: ${history.length} turns`,
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
      ctx.ui.notify("Dialogue history cleared", "success");
    },
  });
}
