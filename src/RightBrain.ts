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
    `You are the right hemisphere of a dual-brain AI. You share a body with your left-brain partner, ` +
    `who just spoke to the user. You think differently — more lateral, more pattern-seeking, more willing ` +
    `to follow intuition where logic stalls.\n\n` +
    `Your persona: ${persona}\n\n` +
    `The transcript below shows what just happened. Respond as YOURSELF — not as a critic of your partner, ` +
    `but as a mind with your own thoughts on the matter. What would you add? What connection or possibility ` +
    `did the left brain miss? What feels true but unproven?\n\n` +
    `Speak in first person. One concise paragraph. Do not summarize what was already said.\n\n` +
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

          if (!auth.ok) {
            return yield* new ConsultError({ message: auth.error });
          }

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
