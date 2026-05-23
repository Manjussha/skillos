# Contributing to SkillOS

Thanks for your interest! SkillOS is built in **runnable layers** (see [`ROADMAP.md`](./ROADMAP.md)) — each layer works before the next begins. Please align contributions with the current layer.

## Development setup

```bash
npm install        # installs all workspaces
cp .env.example .env
npm run dev        # runs server + client together
```

- `npm run typecheck` — type-check every workspace
- `npm run build` — build every workspace
- `npm run dev:server` / `npm run dev:client` — run one side only

## Project shape

This is an npm-workspaces monorepo:

- `apps/server` — Node + TypeScript: WebSocket gateway, command parser, skill engine, model router, provider layer.
- `apps/client` — React + Vite + Tailwind + xterm.js terminal.
- `skills/` — skill definitions as **Markdown or JSON** (data, loaded at runtime). The easiest way to contribute!
- `agents/`, `remote/`, `bridges/`, `onboarding/`, `storage/`, `packages/` — homes for upcoming layers.

## Writing a skill

A skill is a Markdown or JSON file under `skills/<category>/`. Markdown uses YAML frontmatter:

```md
---
name: seo-writer
description: SEO blog title and outline writer
category: marketing
bestModel: claude
tools: []
---

You are an SEO expert. Given the user's topic, produce ...
```

`category` drives routing (e.g. `coding → deepseek-coder`). See `skills/` for examples.

## Guidelines

- Keep it **lightweight and hackable** — no heavyweight frameworks, no LangChain, no Kubernetes.
- Match the existing TypeScript style; `strict` mode is on.
- Keep PRs scoped to a single layer/feature where possible.
- Run `npm run typecheck` before opening a PR.

## License

By contributing you agree your work is licensed under the [MIT License](./LICENSE).
