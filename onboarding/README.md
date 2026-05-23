# onboarding/ — Layer 2

First-run personalization and skill bootstrapping. The logic lives in
`apps/server/src/onboarding/`; this README documents the flow.

## Flow (server-driven, over the existing WebSocket protocol)

When a connection's local user has **no profile**, the server walks them through
these questions using ordinary `info` messages (no protocol change — answers
come back as normal `input` messages):

1. **Use-case** — pick a number (Coding, Writing, SEO, Marketing, Design,
   Research, Business) *or* type a free-text business description
   (e.g. "I run a printing business"). Free text is mapped to a coarse category.
2. **Stack** — comma-separated from `react, node, python, php, flutter`, or `skip`.
3. **Mode** — `fast` / `best` / `cheapest` / `local`. This is **live**: it biases
   provider + model selection (see "Mode → routing" below).
4. **Provider** — `OpenRouter` (paste a key), `Ollama` (local, no key), or
   `Skip` (use the built-in mock responses).
5. **API key** — only asked when OpenRouter is chosen; paste the key or `skip`.

Use-case/stack/mode are persisted to `Profile` (see `storage/`). The provider
key is **not** stored in the DB — it's written to the repo-root `.env`
(gitignored) and applied to `process.env` immediately, so it takes effect with
**no server restart**. The state machine is in `flow.ts` (`newOnboarding`,
`promptFor`, `applyAnswer`, `toProfileInput`); credential persistence is in
`env.ts` (`applyProviderChoice`).

> **Local-only:** onboarding (and therefore key entry) is restricted to the
> local terminal — a remote/tunnel session can never start it or set keys. Note
> the key is echoed in the terminal as you type it (no masking yet).

## Mode → routing

The chosen mode flows into `providers/provider.ts` (`resolveProvider(logical,
mode)`) on every request:

- **`local`** → use local Ollama models (private, on-device) when configured.
- **`best`** → higher-quality (pricier) OpenRouter models, e.g. `claude` →
  `anthropic/claude-3.5-sonnet`.
- **`fast` / `cheapest`** → lighter, cheaper models, e.g. `claude` →
  `anthropic/claude-3-haiku`.

With no provider key configured, every mode falls back to the offline mock
provider.

## Auto skill loading

After onboarding, `selectActiveSkills()` marks which already-loaded skills are
"active" for the profile, based on use-case category + stack (e.g. a React/Node
stack activates `coding` skills). Active skills are stored on the profile and
shown with a `*` in `/skills`.

## Auto skill generation

`/generate-skills <describe your domain>` (`generate.ts`) asks the provider layer
for 2–4 skill definitions as JSON, runs each through a **quality gate**
(`validateSkill`: valid kebab-case name, known category, non-trivial
description + prompt), and writes the survivors as Markdown under
`skills/<category>/` so the engine loads them on the next server start.

Offline-safe: with no provider key the mock provider returns prose, not JSON, so
generation falls back to a deterministic, valid template derived from the
description. Generated files carry `generated: true` in their frontmatter.

## Commands

| Command | Effect |
| --- | --- |
| (automatic on first run) | Starts onboarding when no profile exists. |
| `/onboarding` | (Re)start the onboarding flow. |
| `/profile` | Show the saved profile. |
| `/generate-skills <domain>` | Generate + quality-gate + write domain skills. |

## Verify

With the server running (`npm run dev:server`):

```bash
node scripts/verify-layer2.mjs   # drives onboarding → /profile → /generate-skills → /skills
```

On a fresh DB this also exercises the first-run onboarding path. After it runs,
`scripts/smoke.mjs` (the Layer 1 core-loop check) connects with the saved
profile and skips onboarding.
