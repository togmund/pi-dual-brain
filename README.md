# pi-dual-brain

A [pi](https://github.com/badlogic/pi-mono) extension that gives your agent a **double brain** — two models that consult each other.

Inspired by split-brain research: your left brain (pi's active model) speaks to you. Your right brain (a second model of your choice) can be consulted for second opinions, creative input, or critical analysis.

## Install

```bash
pi install git:github.com/togmund/pi-dual-brain
```

Or clone manually to `~/.pi/agent/extensions/pi-dual-brain/` and run `npm install`.

## Configure

Set your right-brain model in `~/.pi/agent/settings.json` or via environment variable:

```bash
export RIGHT_BRAIN_MODEL="deepseek/deepseek-chat"
export RIGHT_BRAIN_PERSONA="You are a critical, creative second mind."
export RIGHT_BRAIN_MAX_DEPTH=3
```

`RIGHT_BRAIN_MODEL` must be in `provider/model` format (use `pi --list-models` to see what's registered).

## Usage

The left brain learns about its partner automatically via the system prompt. It can call:

```
converse_with_right_brain({
  message: "Should we use Redis or PostgreSQL for this?"
})
```

The right brain responds, and the dialogue is recorded in session history.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `message` | `string` | What to ask the right brain |
| `model` | `string?` | Override model (`provider/model`) |
| `depth` | `number?` | Internal dialogue turns (1-5) |
| `persona` | `string?` | Override persona for this consult |

### Commands

- `/dual-brain` — Show status and current right-brain model
- `/dual-brain-clear` — Clear the internal dialogue history

## Architecture

```
User → Left Brain (pi model)
         ↓
    converse_with_right_brain tool
         ↓
    RightBrain service (Effect)
         ↓
    completeSimple(@earendil-works/pi-ai)
         ↓
    Right Brain model (configured via pi's model registry)
         ↓
    Response → Left Brain synthesizes → User
```

No duplicate API keys — the extension reads auth from pi's `modelRegistry`.

## Tech

- [Effect](https://effect.website/) for error handling, state management, and service composition
- `@earendil-works/pi-ai` for provider-agnostic model calls
- `oxlint` + `oxfmt` for linting and formatting
