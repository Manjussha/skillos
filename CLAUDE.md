# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**SkillOS** — a lightweight, open-source (MIT), local-first AI terminal hub. You type into a terminal; SkillOS parses the command, selects a **skill**, routes it to the best **model**, and streams the response back. Differentiator: *intelligent capability routing + portable skills + terminal interoperability*, not "supports many models."

Source of truth for the long-term vision is [`POD.md`](./POD.md); the realistic, re-sequenced build plan is [`ROADMAP.md`](./ROADMAP.md). When they conflict, ROADMAP.md wins (it records decisions that override the original design).

## Current state

**All v0.1 layers (0–5) are built and verified.** The core loop runs end-to-end: `terminal → command parser → skill engine → rule-based router → provider → streamed response`, plus:
- **Layer 2 — persistence/onboarding:** SQLite + Prisma (users/profile, skills, packs, sessions, routing prefs, message history), first-run onboarding (use-case → stack → mode → **provider + API key**, the key written to `.env` and applied live with no restart; local-terminal only), auto skill loading, and `/generate-skills`. See `storage/` and `onboarding/`.
- **Layer 3 — agents:** Planner/Coder/Reviewer/Writer with real stage-to-stage chaining; `/agents`, `/agent`, `/build-dashboard`, `/build-api`. See `agents/`.
- **Layer 4 — remote access:** Cloudflare Tunnel (`/remote start|stop|status`), scoped/expiring session tokens, QR codes, and a centralized permission model with confirmation prompts for privileged tools over remote sessions. See `remote/`.
- **Layer 5 — terminal bridges:** a `Bridge` interface with a local shell bridge (gated through the Layer 4 permission model) and an Aider bridge; `/connect`, `/bridges`, and `/run` wrapper proxying. See `bridges/`.

Each layer has a verifier under `scripts/` (`smoke.mjs`, `verify-layer2|3|4|5.mjs`) — all pass against a live local server with the mock provider (no API keys needed). Layers 4 and 5 degrade gracefully when `cloudflared` / `aider` aren't installed, so everything is verifiable offline.

Two post-v0.1 additions ride on the existing protocol (no new ServerMessage types): a **unified runtime LLM picker** — `/provider` (local-only) lists a single grouped menu via `providerInfo()`: **API providers** (key `✓` / active `*`), **Local / hosted** (Ollama local, Ollama Cloud), and **installed CLI tools** (Claude Code, Gemini, OpenCode, Kilo Code — marked `✓ installed` / `✗ not installed`), plus a trailing "Skip (mock)" option. Selecting an API/cloud provider switches it or collects an API key; selecting an installed CLI sets it active (`SKILLOS_PROVIDER=<cliId>`) and connects its bridge so the whole loop streams through that CLI's own auth; selecting an uninstalled CLI shows the install hint without activating. All persistence goes through the generalized `applyProviderChoice(providerId, apiKey)` (writes `envKey`/`SKILLOS_PROVIDER` to `.env` + `process.env` live; CLI ids write only `SKILLOS_PROVIDER`). `/models` is interactive numbered selection of the **active provider's** real models via `modelsFor()` (empty for CLIs). Both use a `session.picker` state handled before command parsing (a `/command` cancels an active picker). And **cross-session memory** — `apps/server/src/memory/memory.ts` compresses a session into `storage/memory/<userId>.md` on disconnect (model summary if a provider is set, else a deterministic offline digest) and recalls it on the next connection, injecting a bounded preamble into the system prompt. Verifier: `scripts/verify-memory.mjs`.

This was built **in runnable layers** — keep each layer working before extending. Honest known gaps: no OS sandbox for shell execution yet (the permission gate is the active control); the Aider live-proxy path is untested without `aider` installed. See each subsystem README for details.

## Commands

```bash
npm install          # install all workspaces (npm workspaces, NOT pnpm — corepack is blocked here)
npm run dev          # run server + browser client together (concurrently)
npm run dev:server   # server only — tsx watch, ws://localhost:8787
npm run dev:client   # browser terminal only — Vite, http://localhost:5173
npm run cli          # native terminal client (apps/cli) — needs the server running
                     #   npm run cli -- --url ws://host   /   -- --token <t> for remote
npm run typecheck    # tsc --noEmit across all workspaces
npm run build        # build all workspaces
node scripts/smoke.mjs   # drive the core loop over WebSocket without a browser (server must be running)
```

There is no test runner yet. `scripts/smoke.mjs` is the fastest way to verify the server loop after a change — start `npm run dev:server`, then run it.

## Architecture

npm-workspaces monorepo. The request pipeline lives in `apps/server/src`:

- `parser.ts` — splits input into a `/command` vs a free-text prompt.
- `skills/engine.ts` — loads skills from the **top-level `skills/` dir** (Markdown w/ YAML frontmatter *or* JSON) into a `Map<name, Skill>` at startup. Override the location with `SKILLS_DIR`; default is `<repo-root>/skills` resolved relative to the server's cwd.
- `router/router.ts` — **rule-based only** (learned routing is deferred). Precedence: `/use` override → skill `bestModel` → category rule → `"default"`. This yields a *logical* model name.
- `providers/provider.ts` — a **provider registry** with runtime selection. `resolveProvider(logical, mode)` picks the **active** provider (see below) and maps the logical name (or a concrete model id) + the session's **mode** to a concrete model, then streams text. Registry `ProviderKind`s: direct **openai / anthropic / google / groq / deepseek** (each via its `@ai-sdk/*` factory, key read from `process.env` at call time), **openrouter** (via `@ai-sdk/openai` pointed at OpenRouter's OpenAI-compatible endpoint, still honoring `mode` best/cheap tiers), **ollama** (local; direct `fetch` to its NDJSON streaming API — no SDK), **ollama-cloud** (hosted; via `@ai-sdk/openai` pointed at `OLLAMA_CLOUD_URL` ?? `https://ollama.com/v1`, key `OLLAMA_API_KEY`, models `gpt-oss:120b`/`gpt-oss:20b`), and a **mock** provider used when nothing is configured so the loop is demoable offline. Each registry entry declares `id`, `label`, `envKey`, `needsKey`, selectable `models`, a `logical` map, and `defaultModel`. **CLI-backed providers (the unified picker):** installed AI CLIs — **claude-code / gemini / opencode / kilo-code** — are ALSO selectable as the active provider. They are NOT registry entries; they resolve to a `cli` `ProviderKind` with the concrete CLI id carried on `Resolution.cliId`. `streamCompletion`'s `cli` case folds `system`+`prompt` into one string and streams it through the matching bridge's `ask` capability (`runCliAsk` in `bridges/registry.ts`, bounded by `SKILLOS_CLI_TIMEOUT_MS`), so the whole loop is answered by that CLI using **its own auth** (no SkillOS key). The CLIs are detected ONCE at startup (`detectCliProviders`, parallel + short timeout, cached for the process — new installs need a restart). **Active-provider selection:** `activeSelection()` reads `SKILLOS_PROVIDER` and returns a registry kind OR an installed CLI id; if unset/unusable it auto-detects (first keyed provider in priority order — OpenRouter first to preserve prior behavior — else Ollama if `OLLAMA_BASE_URL`, else mock). `activeProvider()` collapses a CLI selection to `"cli"`. `local` mode still forces Ollama when configured. Helpers `providerInfo()` (for the unified `/provider` picker — grouped api/local/cli with key/installed/active markers) and `modelsFor(id)` (for `/models`; empty for CLIs) introspect live. **Adding a registry provider** = one registry entry + a factory case in the `streamCompletion` switch; **adding a CLI provider** = a bridge module + an entry in `CLI_PROVIDER_BRIDGES`.
- `index.ts` — WebSocket gateway (attached to an `http.Server` on the same port so a Cloudflare Tunnel can reach it) tying it together; per-connection session holds the `/use` override, DB user/session ids, onboarding state, and trust origin (local vs remote).
- `storage/` — Prisma client + repo helpers (Layer 2). `onboarding/` — onboarding flow + skill generation (Layer 2). `agents/` — agent registry + runtime (Layer 3). `remote/` — tunnel, tokens, QR, and the centralized `permissions.ts` gate (Layer 4). `bridges/` — `Bridge` interface, shell + aider bridges, registry (Layer 5).

There are **two clients**, both speaking the same WebSocket JSON protocol:
- `apps/client` — browser xterm.js terminal (`src/App.tsx`), its own line editing.
- `apps/cli` — native terminal client (`src/index.ts`) built on Node `readline`, for driving SkillOS straight from a shell. Run with `npm run cli`.

**Client/server protocol** — defined in `apps/server/src/types.ts` and **mirrored** in `apps/client/src/App.tsx` (`ServerMessage`) and `apps/cli/src/index.ts` (`ServerMessage`). Keep all three in sync. Client sends `{type:"input"|"auth"|"permission-response"}`; server streams `{type:"info"|"chunk"|"error"}`, structured markers `{type:"stage"|"qr"|"permission-request"}`, and ends **every** input turn with exactly one `{type:"done", meta}`.

**Turn-end contract (important):** every input produces exactly one `done`. Streaming turns (model/skill/agent) send `done` with real `meta.model`. Non-streaming commands (`/help`, `/skills`, onboarding answers, `/remote`, …) send `done` with **empty `meta.model`** via `endTurn()` — a pure "turn complete, re-show the prompt" signal. Clients render the meta line only when `meta.model` is non-empty, and rearm the prompt on `done` or `error`. The initial greeting/onboarding-start `info` is sent outside a turn (no `done`), so clients also rearm on an `info` received while idle. If you add a command, route it through `endTurn` (info-only) or emit your own `done` (streaming) — never neither, or the prompt hangs.

## Key decisions (override POD.md where noted)

- **AI layer is the Vercel AI SDK (`ai` + `@ai-sdk/*`), NOT LiteLLM.** POD.md lists LiteLLM but it's Python; the stack is all-TypeScript. SkillOS supports **multiple providers with runtime selection** via a registry in `providers/provider.ts`: direct OpenAI / Anthropic / Google / Groq / DeepSeek, plus OpenRouter (one key, many models) and Ollama (local). The active provider is chosen by `SKILLOS_PROVIDER` or auto-detected from whichever key is set (OpenRouter first to preserve prior single-key behavior); `/provider` switches it live.
- **First terminal bridge target is Aider** (Layer 5).
- **pnpm is unavailable in this environment** (corepack can't write to `Program Files`). Use **npm workspaces**.
- Stack is current as of build: React 19, Vite 8, Tailwind 4 (via `@tailwindcss/vite`, no PostCSS config), `ai` v6 + `@ai-sdk/openai|anthropic|google|groq` v3 and `@ai-sdk/deepseek` v2, `@xterm/*` v6.

## Adding things

- **A skill:** drop a `.md` (YAML frontmatter: `name`, `description`, `category`, `bestModel`, `tools`) or `.json` file under `skills/<category>/`. It's picked up at server startup; `category` drives routing. No code change needed.
- **A provider:** add an entry to `PROVIDER_REGISTRY` (id, label, envKey, needsKey, models, logical map, defaultModel) and a factory case in the `streamCompletion` switch (or `sdkModel` for AI-SDK-backed providers) in `providers/provider.ts`. Add its key to `.env.example`. Keep the dependency surface small — the project philosophy is lightweight/hackable, no heavy frameworks, no LangChain.
- **A CLI-backed provider:** add a bridge module under `bridges/` (implement `Bridge`, graceful detection, an `ask` capability), register it in `BRIDGES`, and add its id to `CLI_PROVIDER_BRIDGES` in `bridges/registry.ts` (+ a `CLI_LABELS` entry in `provider.ts`). It then appears in the unified `/provider` picker, is detected at startup, and the `cli` case of `streamCompletion` streams the core loop through it.

## Constraints (from POD.md, still binding)

Lightweight, fast, modular, local-first, hackable, terminal-native, Markdown-based. Not enterprise-bloated, over-engineered, Kubernetes-heavy, or LangChain-complex. Remote access (Layer 4) is the largest attack surface — treat its security (permission prompts, sandboxing, scoped tokens) as a design pillar, not an afterthought.
