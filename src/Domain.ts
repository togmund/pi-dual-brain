import { Context, Data, Effect, Layer, Ref, Schema } from "effect";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export const Brain = Schema.Literal("left", "right");
export type Brain = typeof Brain.Type;

export class DialogueEntry extends Schema.Class<DialogueEntry>("DialogueEntry")({
  id: Schema.String,
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
// Pi context bridge
// ---------------------------------------------------------------------------

export interface PiRuntime {
  readonly modelRegistry: {
    find: (provider: string, model: string) => unknown | undefined;
    getApiKeyAndHeaders: (model: unknown) => Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
  };
  readonly signal?: AbortSignal;
}

export const PiRuntime = Context.GenericTag<PiRuntime>("PiRuntime");

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface RightBrain {
  /** Generate a coordination brief before the left brain speaks */
  readonly brief: (
    context: string,
    modelRef: string,
    persona: string,
  ) => Effect.Effect<string, ConsultError | ModelNotFoundError>;

  /** Mid-turn consultation on a specific question */
  readonly consult: (
    question: string,
    context: string,
    modelRef: string,
    persona: string,
  ) => Effect.Effect<string, ConsultError | ModelNotFoundError>;

  /** Observe completed turn for next-round context */
  readonly observe: (
    transcript: string,
    modelRef: string,
    persona: string,
  ) => Effect.Effect<string, ConsultError | ModelNotFoundError>;
}

export const RightBrain = Context.GenericTag<RightBrain>("RightBrain");

export interface Conversation {
  readonly record: (entry: Omit<DialogueEntry, "id" | "timestamp">) => Effect.Effect<void, never>;
  readonly getHistory: Effect.Effect<ReadonlyArray<DialogueEntry>, never>;
  readonly getTranscript: Effect.Effect<string, never>;
  readonly getLastRightBrainComment: Effect.Effect<string | undefined, never>;
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

      getLastRightBrainComment: Ref.get(entries).pipe(
        Effect.map((es) => {
          for (let i = es.length - 1; i >= 0; i--) {
            if (es[i].from === "right") return es[i].content;
          }
          return undefined;
        }),
      ),

      clear: Ref.set(entries, []),
    });
  }),
);
