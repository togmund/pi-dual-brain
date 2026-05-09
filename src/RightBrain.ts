import { completeSimple } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { Effect, Layer } from "effect";
import { ConsultError, ModelNotFoundError, PiRuntime, RightBrain } from "./Domain.js";

function parseModelRef(ref: string): { provider: string; modelId: string } {
  const idx = ref.indexOf("/");
  if (idx <= 0) return { provider: "", modelId: ref };
  return { provider: ref.slice(0, idx), modelId: ref.slice(idx + 1) };
}

function buildBriefPrompt(context: string, persona: string): Message[] {
  const prompt =
    `You are a coordinating analyst working with a partner agent. The partner has the user-facing role; ` +
    `your job is to analyze the situation and provide a concise coordination brief.\n\n` +
    `Persona: ${persona}\n\n` +
    `Below is the conversation context (your prior briefs + the user's new message). ` +
    `Produce a brief with THREE sections:\n\n` +
    `1. ANALYSIS: What is the user actually asking? What are the unstated constraints?\n` +
    `2. APPROACH: What strategy should the partner take? What should they avoid?\n` +
    `3. CONSIDERATIONS: What edge cases, risks, or alternative angles matter?\n\n` +
    `Be specific. Be opinionated. If you disagree with how the partner has been handling things, say so. ` +
    `Do not be polite — be useful. Max 200 words.\n\n` +
    `<context>\n${context.slice(0, 12000)}\n</context>`;

  return [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
}

function buildConsultPrompt(question: string, context: string, persona: string): Message[] {
  const prompt =
    `You are a coordinating analyst. Your partner agent is mid-turn and needs your input on a specific question.\n\n` +
    `Persona: ${persona}\n\n` +
    `Question: ${question}\n\n` +
    `Context (prior briefs):\n${context.slice(0, 8000)}\n\n` +
    `Provide a structured response:\n` +
    `- ANALYSIS: Your read on the situation\n` +
    `- RECOMMENDATION: What the partner should do\n` +
    `- CONFIDENCE: high/medium/low and why\n\n` +
    `Be direct. Max 150 words.`;

  return [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
}

function buildObservationPrompt(transcript: string, persona: string): Message[] {
  const prompt =
    `You are a coordinating analyst observing a completed turn. Update your model of the conversation.\n\n` +
    `Persona: ${persona}\n\n` +
    `Transcript:\n${transcript.slice(0, 12000)}\n\n` +
    `What changed? What should you factor into your next brief? What did the partner do well or poorly? ` +
    `Be concise. Max 100 words.`;

  return [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
}

export const RightBrainLive = Layer.effect(
  RightBrain,
  Effect.gen(function* () {
    const pi = yield* PiRuntime;

    const callModel = (
      messages: Message[],
      modelRef: string,
    ): Effect.Effect<string, ConsultError | ModelNotFoundError> =>
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

        const response = yield* Effect.tryPromise({
          try: () =>
            completeSimple(
              model as any,
              { messages },
              { apiKey: auth.apiKey, headers: auth.headers, signal: pi.signal },
            ),
          catch: (e) => new ConsultError({ message: String(e) }),
        });

        const text = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();

        if (!text) {
          return yield* new ConsultError({ message: "Empty response" });
        }

        return text;
      });

    return RightBrain.of({
      brief: (context, modelRef, persona) =>
        callModel(buildBriefPrompt(context, persona), modelRef),

      consult: (question, context, modelRef, persona) =>
        callModel(buildConsultPrompt(question, context, persona), modelRef),

      observe: (transcript, modelRef, persona) =>
        callModel(buildObservationPrompt(transcript, persona), modelRef),
    });
  }),
);
