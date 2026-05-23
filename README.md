# SkillOS

> Open-source AI terminal hub with intelligent routing, portable skills, and terminal interoperability.

SkillOS is a lightweight, local-first AI terminal operating system. You type into a terminal; SkillOS parses the command, picks the right **skill**, routes it to the best **model**, and streams the response back. It is Markdown-based, hackable, and terminal-native.

The differentiator is not "supports many models" — it's **intelligent capability routing + portable skills + terminal interoperability**.

## Status

**v0.1 feature-complete.** All six layers are built and verified — the core loop (terminal → skill → router → provider → streamed response), persistence + onboarding, multi-step agents, remote access (Cloudflare Tunnel + scoped tokens + QR + permission prompts), and terminal bridges (shell + Aider). Layers 4–5 degrade gracefully when `cloudflared`/`aider` aren't installed, so it all runs offline with the built-in mock provider. See [`ROADMAP.md`](./ROADMAP.md) for the layered plan and [`POD.md`](./POD.md) for the full product vision.

## Quick start

```bash
# 1. install dependencies (npm workspaces)
npm install

# 2. (optional) configure providers — onboarding can also do this for you
cp .env.example .env
#   add a key (e.g. OPENROUTER_API_KEY) or run Ollama; with neither, a built-in
#   mock provider streams simulated responses so everything works offline.

# 3a. browser terminal: server + web client
npm run dev
#     then open the URL Vite prints (default http://localhost:5173)

# 3b. OR native terminal: run the server, then the CLI in another shell
npm run dev:server
npm run cli
```

On first run you'll be walked through onboarding (use-case → stack → mode →
provider → optional API key). Then try:

```
/help
/skills
/seo write a punchy title about a printing business
/build-dashboard a sales overview
```

The CLI accepts `--url ws://host` and `--token <token>` (for a remote session),
and `/exit` to quit.

## How it works

```
You → Terminal (xterm.js) → WebSocket → Command Parser
   → Skill Engine → Model Router → Provider (Vercel AI SDK) → streamed response
```

| Piece | Where |
| --- | --- |
| Browser terminal (React + xterm.js) | `apps/client` |
| Native terminal client (Node readline) | `apps/cli` |
| Gateway, parser, engine, router, providers | `apps/server` |
| Skill definitions (Markdown / JSON) | `skills/` |
| Future layers (agents, remote, bridges…) | `agents/`, `remote/`, `bridges/`, `onboarding/`, `storage/` |

## Tech stack

TypeScript · React · Tailwind · xterm.js · Node.js · WebSockets · **Vercel AI SDK** (multi-provider) · Ollama (local) · SQLite + Prisma (persistence layer) · Cloudflare Tunnel (remote layer).

> Note: the original design listed LiteLLM, but SkillOS uses the **Vercel AI SDK** to stay all-TypeScript. It covers OpenAI, Anthropic, Gemini, Groq, OpenRouter, and Ollama through one streaming interface.

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Licensed under [MIT](./LICENSE).
