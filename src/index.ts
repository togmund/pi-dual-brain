/**
 * pi-dual-brain — coordination layer (not theater)
 *
 * Two agents, one mic.
 *
 * Right brain (quiet): Analyzes, suggests, coordinates. Its output is a
 * structured brief injected into the left brain's system prompt. No visible
 * monologues. Its "voice" is its actions.
 *
 * Left brain (loud): Speaks to user, calls tools, synthesizes the brief.
 *
 * Flow:
 *   before_agent_start → right brain generates brief → injected into system prompt
 *   left brain responds (may call consult_right_brain for mid-turn coordination)
 *   agent_end → right brain observes, updates state
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect, Layer } from "effect";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppConfig } from "./Config.js";
import { PiRuntime, RightBrain } from "./Domain.js";
import { RightBrainLive } from "./RightBrain.js";

const STATUS_KEY = "dual-brain";
const STATE_ENTRY = "dual-brain-state";
const BRIEF_ENTRY = "dual-brain-brief";
const LOG_ENTRY = "dual-brain-log";
const LOG_FILE = join(homedir(), ".pi", "agent", "extensions", "pi-dual-brain", "debug.ndjson");

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

function logEvent(event: string, data: Record<string, unknown>) {
  const line = JSON.stringify({ t: Date.now(), event, ...data }) + "\n";
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore
  }
  return { t: Date.now(), event, ...data };
}

function readLogs(limit: number = 20): string {
  if (!existsSync(LOG_FILE)) return "(no logs yet)";
  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).join("\n");
}

function getLastBrief(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === BRIEF_ENTRY) {
      return (entry.data as { brief: string }).brief;
    }
  }
  return undefined;
}

function gatherBriefs(ctx: ExtensionContext): Array<{ brief: string; timestamp: number }> {
  const out: Array<{ brief: string; timestamp: number }> = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === BRIEF_ENTRY) {
      out.push(entry.data as { brief: string; timestamp: number });
    }
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // before_agent_start — right brain generates a coordination brief
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return {};

    const config = await Effect.runPromise(AppConfig);
    const priorBriefs = gatherBriefs(ctx);

    const userPrompt = event.prompt ?? "";
    if (!userPrompt) {
      logEvent("before_agent_start", { skipped: "no user prompt" });
      return {};
    }

    // Build context for right brain: prior briefs + current prompt
    const priorText = priorBriefs
      .slice(-3)
      .map((b) => `[prior brief]: ${b.brief}`)
      .join("\n\n");

    const context = priorText
      ? `${priorText}\n\n--- new turn ---\n\n[user]: ${userPrompt}`
      : `[user]: ${userPrompt}`;

    let brief: string;
    try {
      brief = await runRightBrain(ctx, undefined, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        return yield* rightBrain.brief(context, config.model, config.persona);
      }));
    } catch (e) {
      logEvent("before_agent_start_error", { error: String(e) });
      return {};
    }

    // Persist brief
    pi.appendEntry(BRIEF_ENTRY, { brief, timestamp: Date.now() });

    logEvent("before_agent_start_brief", {
      brief: brief.slice(0, 300),
      model: config.model,
    });

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        `🧠 ${brief.slice(0, 40)}${brief.length > 40 ? "…" : ""}`,
      );
    }

    // Inject brief into system prompt — the left brain MUST reckon with it
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Coordination Brief (Right Brain)\n` +
        `Your coordinating partner has analyzed the user's message and the conversation context. ` +
        `You MUST synthesize this brief with the user's request. Do not acknowledge it separately. ` +
        `Do not summarize it. Use it to shape your actual response.\n\n` +
        brief,
    };
  });

  // -------------------------------------------------------------------------
  // agent_end — right brain observes the full turn for next round
  // -------------------------------------------------------------------------

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;

    const config = await Effect.runPromise(AppConfig);
    const priorBriefs = gatherBriefs(ctx);

    const turnMessages = (event.messages as any[])
      .filter((m: any) => m.content !== undefined)
      .map((m: any) => ({
        role: m.role as string,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }));

    const current = turnMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    const priorText = priorBriefs.map((b) => `[brief]: ${b.brief}`).join("\n\n");
    const transcript = priorText ? `${priorText}\n\n--- current turn ---\n\n${current}` : current;

    runRightBrain(ctx, undefined, Effect.gen(function* () {
      const rightBrain = yield* RightBrain;
      const observation = yield* rightBrain.observe(transcript, config.model, config.persona);

      logEvent("agent_end_observation", {
        observation: observation.slice(0, 300),
        model: config.model,
      });
    })).catch((e) => {
      logEvent("agent_end_error", { error: String(e) });
    });
  });

  // -------------------------------------------------------------------------
  // Tool — mid-turn consultation (structured, not poetic)
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "consult_right_brain",
    label: "Consult Right Brain",
    description:
      "Ask your coordinating partner for analysis on a specific question. " +
      "Returns structured output: analysis, suggested approach, and confidence.",
    parameters: Type.Object({
      question: Type.String({ description: "What to ask the right brain" }),
      context: Type.Optional(Type.String({ description: "Additional context" })),
      model: Type.Optional(Type.String({ description: "Override model" })),
      persona: Type.Optional(Type.String({ description: "Override persona" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await Effect.runPromise(AppConfig);
      const priorBriefs = gatherBriefs(ctx);

      logEvent("tool_consult_start", {
        question: params.question.slice(0, 200),
      });

      const priorText = priorBriefs
        .slice(-3)
        .map((b) => `[prior brief]: ${b.brief}`)
        .join("\n\n");

      const fullContext = params.context
        ? `${params.context}\n\n${priorText}`
        : priorText;

      const text = await runRightBrain(ctx, signal, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        return yield* rightBrain.consult(
          params.question,
          fullContext,
          params.model ?? config.model,
          params.persona ?? config.persona,
        );
      }));

      // Persist as brief so future turns see it
      pi.appendEntry(BRIEF_ENTRY, { brief: `[consult] ${text}`, timestamp: Date.now() });

      logEvent("tool_consult_end", {
        response: text.slice(0, 300),
      });

      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // Tool — tail logs
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "tail_dual_brain_logs",
    label: "Tail Dual Brain Logs",
    description: "Read recent structured log entries.",
    parameters: Type.Object({
      lines: Type.Optional(Type.Number({ description: "Number of lines", default: 20 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const logs = readLogs(params.lines ?? 20);
      return {
        content: [{ type: "text", text: `Recent dual-brain logs:\n\n${logs}` }],
        details: { logFile: LOG_FILE },
      };
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
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
        ctx.ui.notify("Dual brain disabled", "info");
        return;
      }
      if (args.trim() === "on") {
        enabled = true;
        ctx.ui.notify("Dual brain enabled", "info");
        return;
      }

      const lastBrief = getLastBrief(ctx);
      ctx.ui.notify(
        `${config.model} | ${enabled ? "on" : "off"}` +
          (lastBrief ? ` | brief: "${lastBrief.slice(0, 40)}${lastBrief.length > 40 ? "…" : ""}"` : ""),
        "info",
      );
    },
  });

  pi.registerCommand("dual-brain-logs", {
    description: "Tail recent structured logs",
    handler: async (_args, ctx) => {
      const logs = readLogs(20);
      ctx.ui.notify(`Logs: ${logs.slice(0, 200)}`, "info");
    },
  });

  pi.registerCommand("dual-brain-clear", {
    description: "Clear brief history",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify("Brief history cleared", "info");
    },
  });

  // -------------------------------------------------------------------------
  // Session hooks
  // -------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
        const data = entry.data as { enabled?: boolean };
        if (typeof data.enabled === "boolean") enabled = data.enabled;
      }
    }

    const config = await Effect.runPromise(AppConfig);
    logEvent("session_start", { enabled, model: config.model });

    if (ctx.hasUI) {
      ctx.ui.notify(
        `🧠 dual brain: ${config.model} — ${enabled ? "on" : "off"}`,
        enabled ? "info" : "warning",
      );
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    logEvent("session_shutdown", { enabled });
    pi.appendEntry(STATE_ENTRY, { enabled });
  });
}
