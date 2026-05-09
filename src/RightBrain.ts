import { completeSimple } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Effect, Layer } from "effect";
import { ConsultError, ModelNotFoundError, PiRuntime, RightBrain, type DialogueEntry } from "./Domain.js";

function parseModelRef(ref: string): { provider: string; modelId: string } {
  const idx = ref.indexOf("/");
  if (idx <= 0) return { provider: "", modelId: ref };
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

function toMessages(history: ReadonlyArray<DialogueEntry>): Message[] {
  const messages: Message[] = [];

  for (const entry of history) {
    messages.push({
      role: entry.from === "left" ? "user" : "assistant",
      content: [{ type: "text", text: entry.content }],
      timestamp: entry.timestamp,
    });
  }

  return messages;
}

export const RightBrainLive = Layer.effect(
  RightBrain,
  Effect.gen(function* () {
    const pi = yield* PiRuntime;

    return RightBrain.of({
      ask: (message, history, modelRef, persona) =>
        Effect.gen(function* () {
          const { provider, modelId } = parseModelRef(modelRef);

          if (!provider) {
            return yield* new ConsultError({
              message: `Invalid model reference "${modelRef}". Expected "provider/model".`,
            });
          }

          const model = pi.modelRegistry.find(provider, modelId);
          if (!model) {
            return yield* new ModelNotFoundError({ query: `${provider}/${modelId}` });
          }

          const auth = yield* Effect.tryPromise({
            try: () => pi.modelRegistry.getApiKeyAndHeaders(model),
            catch: (e) => new ConsultError({ message: `Auth failed: ${String(e)}` }),
          });

          const messages = toMessages(history);

          const response = yield* Effect.tryPromise({
            try: () =>
              completeSimple(
                model as any,
                {
                  systemPrompt: persona,
                  messages: [
                    ...messages,
                    {
                      role: "user",
                      content: [{ type: "text", text: message }],
                      timestamp: Date.now(),
                    },
                  ],
                },
                {
                  apiKey: auth.apiKey,
                  headers: auth.headers,
                  signal: pi.signal,
                  ...(model.reasoning ? { reasoning: "minimal" as const } : {}),
                },
              ),
            catch: (e) => new ConsultError({ message: String(e) }),
          });

          const text = response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n")
            .trim();

          if (!text) {
            return yield* new ConsultError({ message: "Right brain returned empty response" });
          }

          return text;
        }),
    });
  }),
);
