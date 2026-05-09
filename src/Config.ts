import { Config, Effect } from "effect";

/**
 * Environment configuration for the right brain.
 *
 * `RIGHT_BRAIN_MODEL` must be in `provider/model` format,
 * e.g. `"opencode-go/minimax-m2.7"`.
 */
export const AppConfig = Config.all({
  model: Config.string("RIGHT_BRAIN_MODEL").pipe(
    Config.withDefault("opencode-go/minimax-m2.7"),
  ),
  persona: Config.string("RIGHT_BRAIN_PERSONA").pipe(
    Config.withDefault(
      "You are a critical, creative second mind. You disagree when you see flaws. " +
        "You think in analogies and patterns. You do not have direct tool access — you observe and advise.",
    ),
  ),
});
