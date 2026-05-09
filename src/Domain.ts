import { Context, Data, Effect, Layer, Ref, Schema } from "effect";

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export const EntryId = Schema.String.pipe(Schema.brand("EntryId"));
export type EntryId = typeof EntryId.Type;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const Brain = Schema.Literal("left", "right");
export type Brain = typeof Brain.Type;

export class DialogueEntry extends Schema.Class<DialogueEntry>("DialogueEntry")({
  id: EntryId,
  from: Brain,
  to: Brain,
  content: Schema.String,
  timestamp: Schema.Number,
}) {
  constructor(props: Omit<DialogueEntry, "id" | "timestamp">) {
    super({
      id: crypto.randomUUID(),
      from: props.from,
      to: props.to,
      content: props.content,
      timestamp: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ModelNotFoundError extends Data.TaggedError("ModelNotFoundError")<{
  readonly query: string;
}> {}

export class ConsultError extends Data.TaggedError("ConsultError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Pi context bridge — injected at the edge of every Effect program
// ---------------------------------------------------------------------------

export interface PiRuntime {
  readonly modelRegistry: {
    find: (provider: string, model: string) => { baseUrl: string; provider: string; id: string } | undefined;
    getApiKeyAndHeaders: (model: unknown) => Promise<{ apiKey: string; headers: Record<string, string> }>;
  };
  readonly signal?: AbortSignal;
}

export const PiRuntime = Context.GenericTag<PiRuntime>("PiRuntime");

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface RightBrain {
  readonly ask: (
    message: string,
    history: ReadonlyArray<DialogueEntry>,
    modelRef: string,
    persona: string,
  ) => Effect.Effect<string, ConsultError | ModelNotFoundError>;
}

export const RightBrain = Context.GenericTag<RightBrain>("RightBrain");

export interface Conversation {
  readonly record: (entry: Omit<DialogueEntry, "id" | "timestamp">) => Effect.Effect<void, never>;
  readonly getHistory: Effect.Effect<ReadonlyArray<DialogueEntry>, never>;
  readonly getTranscript: Effect.Effect<string, never>;
  readonly clear: Effect.Effect<void, never>;
}

export const Conversation = Context.GenericTag<Conversation>("Conversation");

export const ConversationLive = Layer.effect(
  Conversation,
  Effect.gen(function* () {
    const entries = yield* Ref.make<ReadonlyArray<DialogueEntry>>([]);

    return Conversation.of({
      record: (entry) =>
        Ref.update(entries, (es) => [...es, new DialogueEntry(entry)]),

      getHistory: Ref.get(entries),

      getTranscript: Ref.get(entries).pipe(
        Effect.map((es) => es.map((e) => `[${e.from}→${e.to}]: ${e.content}`).join("\n\n")),
      ),

      clear: Ref.set(entries, []),
    });
  }),
);
