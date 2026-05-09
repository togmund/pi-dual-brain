/**
 * pi-dual-brain — visible speaker edition
 *
 * Right brain appears as a distinct speaker in the conversation thread,
 * not just a widget. Its thoughts are persistent messages you can scroll
 * back to in /tree. Structured logging lets both brains inspect the flow.
 *
 * Architecture:
 *   - Right brain observes turn → sends custom message (visible thread entry)
 *   - Left brain sees prior observation in system prompt
 *   - Structured log entries capture both sides of the flow
 *   - /dual-brain-logs command tails recent events
 *   - tail_dual_brain_logs tool lets left brain self-inspect
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect, Layer } from "effect";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppConfig } from "./Config.js";
import { PiRuntime, RightBrain } from "./Domain.js";
import { RightBrainLive } from "./RightBrain.js";

const WIDGET_KEY = "dual-brain";
const STATUS_KEY = "dual-brain";
const STATE_ENTRY = "dual-brain-state";
const OBSERVATION_ENTRY = "dual-brain-observation";
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

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function getLastObservation(ctx: ExtensionContext): string | undefined {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && entry.customType === OBSERVATION_ENTRY) {
      return (entry.data as { commentary: string }).commentary;
    }
  }
  return undefined;
}

function gatherObservations(ctx: ExtensionContext): Array<{ commentary: string; timestamp: number }> {
  const out: Array<{ commentary: string; timestamp: number }> = [];
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === OBSERVATION_ENTRY) {
      out.push(entry.data as { commentary: string; timestamp: number });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structured logging — both brains write here
// ---------------------------------------------------------------------------

function logEvent(event: string, data: Record<string, unknown>) {
  const line = JSON.stringify({ t: Date.now(), event, ...data }) + "\n";
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore
  }
  // Also persist in session for /tree visibility
  return { t: Date.now(), event, ...data };
}

function readLogs(limit: number = 20): string {
  if (!existsSync(LOG_FILE)) return "(no logs yet)";
  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // Message renderer — right brain gets its own speech bubble style
  // -------------------------------------------------------------------------

  pi.registerMessageRenderer("right-brain", (message, options, theme) => {
    let text: string;
    if (typeof message.content === "string") {
      text = message.content;
    } else {
      text = message.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
    const header = theme.fg("accent", theme.bold("🧠 right brain"));
    const mdTheme = getMarkdownTheme();

    if (options.expanded) {
      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(text, 0, 0, mdTheme, { color: (t: string) => theme.fg("dim", t) }));
      return container;
    }

    const preview = text.split("\n").slice(0, 3).join("\n");
    const full = `${header}\n${theme.fg("dim", preview)}`;
    return new Text(full, 0, 0);
  });

  // -------------------------------------------------------------------------
  // before_agent_start — left brain sees right brain's prior observation
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return {};

    const lastObservation = getLastObservation(ctx);
    if (!lastObservation) return {};

    const logData = logEvent("before_agent_start", {
      hasObservation: true,
      observationPreview: lastObservation.slice(0, 100),
    });
    pi.appendEntry(LOG_ENTRY, logData);

    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Your Right Brain's Observation (from last turn)\n` +
        `> ${lastObservation}\n\n` +
        `You may reference, disagree with, or ignore this. Your right brain ` +
        `will observe this turn when you're done.`,
    };
  });

  // -------------------------------------------------------------------------
  // agent_end — right brain observes, logs, speaks in thread
  // -------------------------------------------------------------------------

  pi.on("agent_end", async (event, ctx) => {
    if (!enabled) return;

    const config = await Effect.runPromise(AppConfig);
    const priorObservations = gatherObservations(ctx);

    const turnMessages = (event.messages as any[])
      .filter((m: any) => m.content !== undefined)
      .map((m: any) => ({ role: m.role as string, content: extractText(m.content) }));

    const current = turnMessages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
    const priorText = priorObservations.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
    const transcript = priorText ? `${priorText}\n\n--- current turn ---\n\n${current}` : current;

    runRightBrain(ctx, undefined, Effect.gen(function* () {
      const rightBrain = yield* RightBrain;
      const commentary = yield* rightBrain.observe(transcript, config.model, config.persona);

      // Persist as observation
      pi.appendEntry(OBSERVATION_ENTRY, { commentary, timestamp: Date.now() });

      // Log the event
      const logData = logEvent("agent_end_observation", {
        commentary: commentary.slice(0, 200),
        model: config.model,
      });
      pi.appendEntry(LOG_ENTRY, logData);

      // Speak in the conversation thread as a visible message
      pi.sendMessage(
        {
          customType: "right-brain",
          content: commentary,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: false },
      );

      // Show widget too
      if (ctx.hasUI) {
        const theme = ctx.ui.theme;
        ctx.ui.setWidget(
          WIDGET_KEY,
          [
            theme.fg("accent", theme.bold("🧠 right brain")),
            theme.fg("dim", commentary),
          ],
          { placement: "aboveEditor" },
        );
        ctx.ui.setStatus(
          STATUS_KEY,
          `🧠 ${commentary.slice(0, 40)}${commentary.length > 40 ? "…" : ""}`,
        );
      }
    })).catch((e) => {
      const logData = logEvent("agent_end_error", { error: String(e) });
      pi.appendEntry(LOG_ENTRY, logData);
    });
  });

  // -------------------------------------------------------------------------
  // Tool — explicit dialogue (left brain → right brain)
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "converse_with_right_brain",
    label: "Consult Right Brain",
    description: "Have a direct conversation with your right brain. Visible in the thread.",
    parameters: Type.Object({
      message: Type.String({ description: "What to ask the right brain" }),
      model: Type.Optional(Type.String({ description: "Override model" })),
      persona: Type.Optional(Type.String({ description: "Override persona" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const config = await Effect.runPromise(AppConfig);
      const priorObservations = gatherObservations(ctx);

      const logData = logEvent("tool_consult_start", {
        message: params.message.slice(0, 200),
      });
      pi.appendEntry(LOG_ENTRY, logData);

      const text = await runRightBrain(ctx, signal, Effect.gen(function* () {
        const rightBrain = yield* RightBrain;
        const transcript = priorObservations.map((c) => `[right-brain]: ${c.commentary}`).join("\n\n");
        const full = transcript
          ? `${transcript}\n\n--- consult ---\n\n[left]: ${params.message}`
          : `[left]: ${params.message}`;
        return yield* rightBrain.observe(full, params.model ?? config.model, params.persona ?? config.persona);
      }));

      // Persist and speak
      pi.appendEntry(OBSERVATION_ENTRY, { commentary: `[consult] ${text}`, timestamp: Date.now() });

      pi.sendMessage(
        {
          customType: "right-brain",
          content: `[consulted by left brain]\n${text}`,
          display: true,
        },
        { deliverAs: "followUp", triggerTurn: false },
      );

      const logData2 = logEvent("tool_consult_end", {
        response: text.slice(0, 200),
      });
      pi.appendEntry(LOG_ENTRY, logData2);

      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // -------------------------------------------------------------------------
  // Tool — tail logs (for self-inspection)
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "tail_dual_brain_logs",
    label: "Tail Dual Brain Logs",
    description: "Read recent structured log entries to understand what both brains are doing.",
    parameters: Type.Object({
      lines: Type.Optional(Type.Number({ description: "Number of log lines", default: 20 })),
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

      const lastObs = getLastObservation(ctx);
      ctx.ui.notify(
        `Right brain: ${config.model} | ${enabled ? "on" : "off"}` +
          (lastObs ? ` | last: "${lastObs.slice(0, 40)}${lastObs.length > 40 ? "…" : ""}"` : ""),
        "info",
      );
    },
  });

  pi.registerCommand("dual-brain-logs", {
    description: "Tail recent dual-brain structured logs",
    handler: async (_args, ctx) => {
      const logs = readLogs(20);
      ctx.ui.notify(`Logs: ${logs.slice(0, 200)}`, "info");
    },
  });

  pi.registerCommand("dual-brain-clear", {
    description: "Clear observation history",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      ctx.ui.notify("Observation history cleared", "info");
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
    const logData = logEvent("session_start", { enabled, model: config.model });
    pi.appendEntry(LOG_ENTRY, logData);

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
    const logData = logEvent("session_shutdown", { enabled });
    pi.appendEntry(LOG_ENTRY, logData);
    pi.appendEntry(STATE_ENTRY, { enabled });
  });
}
