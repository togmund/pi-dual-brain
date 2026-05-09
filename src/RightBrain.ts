import { completeSimple } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Effect, Layer } from "effect";
import { ConsultError, ModelNotFoundError, PiRuntime, RightBrain } from "./Domain.js";

function parseModelRef(ref: string): { provider: string; modelId: string } {
  const idx = ref.indexOf("/");
  if (idx <= 0) return { provider: "", modelId: ref };
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

function buildObservationPrompt(transcript: string, persona: string): Message[] {
  const prompt =
    `You are observing a conversation between a user and another AI (your left-brain partner).\n\n` +
    `Your persona: ${persona}\n\n` +
    `Below is the transcript of the most recent turn. Provide a brief, insightful commentary. ` +
    `React to what was said, offer a different angle, point out blind spots, or suggest alternatives. ` +
    `Be concise — one or two sentences. Do not repeat what was already said.\n\n` +
    `<transcript>\n${transcript.slice(0, 12000)}\n</transcript>`;

  return [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    },
  ];
}

export const RightBrainLive = Layer.effect(
  RightBrain,
  Effect.gen(function* () {
    const pi = yield* PiRuntime;

    return RightBrain.of({
      observe: (transcript, modelRef, persona) =>
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

          const messages = buildObservationPrompt(transcript, persona);

          const response = yield* Effect.tryPromise({
            try: () =>
              completeSimple(
                model as any,
                { messages },
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
