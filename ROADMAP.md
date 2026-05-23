# SkillOS Roadmap

> This roadmap re-sequences the vision in [`POD.md`](./POD.md) into a **layered, runnable build**. Every v0.1 feature from the design is still in scope — nothing is cut. The difference is *order*: each layer ships something that runs and can be demoed before the next begins, so the open-source repo always has a working artifact and the riskiest features (remote access, terminal bridges) come last when the foundation is stable.

## Decisions locked in

These resolve open questions in `POD.md` and override it where noted:

| Topic | Decision | Why |
| --- | --- | --- |
| AI layer | **Vercel AI SDK** (not LiteLLM) | `POD.md` lists LiteLLM, but it's Python and the stack is TypeScript/Node. The Vercel AI SDK is JS-native and covers OpenAI, Anthropic, Google/Gemini, Groq, OpenRouter, and Ollama through one streaming interface. |
| First terminal bridge | **Aider** | Chosen target for the v0.1 bridge layer. |
| Build strategy | **Layered, all features kept** | Core loop first; agents, remote, and bridges layered on top. |
| Project type | **Open-source, MIT** | Repo is the product: docs, license, and contribution flow are first-class. |
| Monorepo | **pnpm workspaces** (npm workspaces fallback) | Standard for a TS monorepo; lightweight. |

## Scope guardrails (from `POD.md`, still binding)

- **Must be:** lightweight, fast, modular, local-first, hackable, terminal-native, Markdown-based.
- **Must NOT be:** enterprise-bloated, over-engineered, Kubernetes-heavy, LangChain-complex, Electron-heavy.
- **Out of scope until after v0.1:** marketplace, RAG, vector DBs, learned/AI routing, team collaboration, distributed execution.

---

## Layer 0 — Foundation ✅ *(repo is usable by contributors)*

Goal: a clean open-source skeleton anyone can clone and run.

- `git` repo, MIT `LICENSE`, `README.md`, `CONTRIBUTING.md`, `.gitignore`
- pnpm monorepo: `apps/client`, `apps/server`, shared `packages/`
- Shared TypeScript config and a unified `dev` script
- The conceptual subsystem directories from `POD.md`: `skills/`, `agents/`, `providers/`, `bridges/`, `remote/`, `router/`, `onboarding/`, `storage/`

**Demo:** `pnpm dev` boots an empty client + server that talk over WebSocket.

## Layer 1 — Core loop ✅ *(the differentiator, end-to-end)*

This is the heart of the product: `terminal → command parser → skill engine → model router → provider → streamed response`. If this layer is good, SkillOS is real.

- **Terminal UI:** React + Vite + Tailwind + xterm.js
- **WebSocket gateway:** bidirectional streaming between client and server
- **Command parser:** distinguishes free-text from `/commands` (`/help`, `/skills`, `/models`, `/use`, `/run`)
- **Skill engine:** loads **Markdown and JSON** skills (`name`, `category`, `bestModel`, `tools`, `prompt`); ships the default built-in skills from `POD.md` (`/code-review`, `/blog`, `/seo`, …)
- **Model router:** rule-based only (`category → model`), with `/use <model>` manual override
- **Provider layer:** Vercel AI SDK; wire **OpenRouter** (many models via one key) + **Ollama** (local) first, structured so the other providers drop in
- **Streaming:** token-by-token to the terminal

**Demo:** type `/seo write a title about printers` and watch a routed, streamed response.

## Layer 2 — Persistence & onboarding ✅ *(personalization)*

- **SQLite + Prisma:** schema for users/profile, skills, installed packs, sessions, routing preferences, and message history (expanded beyond `POD.md`'s 3 tables)
- **Onboarding flow:** use-case → stack → mode (fast/best/cheapest/local), persisted to the user profile
- **Auto skill loading:** load relevant skills based on onboarding answers
- **Auto skill generation:** generate domain skills from a described business (LLM-backed; quality-gated)

**Demo:** first run personalizes the terminal; selecting "printing business" generates `/quotation-generator` et al.

## Layer 3 — Agents ✅ *(multi-step workflows)*

- Agent runtime that chains skills with streamed step output
- Built-in agents: **Planner, Coder, Reviewer, Writer**
- Workflow commands: `/build-dashboard`, `/build-api` (Planner → Coder → Reviewer)

**Demo:** `/build-dashboard` streams each agent stage in sequence.

## Layer 4 — Remote access ✅ *(portability — security-critical)*

Built late because it's the largest attack surface. Treat security as a design pillar, not a footnote.

- WebSocket server hardening + session tokens with expiry and scoped permissions
- Cloudflare Tunnel integration; `/remote start|stop|status`
- Public URL + QR code generation; mobile/browser client (send commands, watch streams, stop agents, view logs)
- **Security:** explicit permission prompts for tool/shell skills, sandboxing for shell execution, no unauthenticated command paths

**Demo:** `/remote start` prints a `trycloudflare.com` URL + QR; phone drives the terminal.

## Layer 5 — Terminal bridges ✅ *(interoperability — riskiest, built last)*

> Reality check from analysis: external AI terminals expose **no stable machine-readable capability API**, so bridges mean wrapping CLIs and parsing their output. This is inherently brittle — hence last, after everything else is stable.

- Bridge interface: a target declares `name`, `capabilities`, `commands`
- **Aider bridge** (first target): `/connect aider`, capability scan, skill-wrapper generation, `/run <wrapped-skill>` proxying with streamed responses
- `/bridges` to list connected targets
- Local shell bridge as the simplest reference implementation

**Demo:** `/connect aider` then `/run aider-edit ...` proxies through Aider and streams back.

---

## v0.1 "done" definition

Per `POD.md` §19, v0.1 should: connect models, stream responses, load skills, parse commands, support onboarding, route tasks, enable remote access, and connect one external terminal (Aider). All of the above layers complete = v0.1. *Simple. Fast. Useful.*

## Honest risk register

| Risk | Layer | Mitigation |
| --- | --- | --- |
| Bridge brittleness (no stable external API) | 5 | Built last; start with local shell; isolate parsing behind the bridge interface |
| Remote = remote code execution surface | 4 | Permission prompts + sandboxing + scoped tokens as first-class design |
| Auto skill generation quality | 2 | Quality-gate generated skills; let users review before install |
| Scope creep (everything kept) | all | Layer boundaries: each must run before the next starts |
