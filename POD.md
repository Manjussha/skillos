# SkillOS — Open Source AI Terminal Hub

## Vision

SkillOS is a lightweight open-source AI terminal operating system that combines:

* Multi-model AI routing
* Skills system
* Agent workflows
* Remote terminal access
* Terminal interoperability
* Personalized onboarding
* Local + cloud AI execution

Inspired by:

* Claude Code
* Aider
* OpenDevin
* Continue.dev
* LiteLLM
* Cursor

---

# Core Philosophy

## Must Be

* Lightweight
* Fast
* Modular
* Open-source
* Local-first
* Developer-friendly
* Markdown-based
* Hackable
* Terminal-native

## Must NOT Be

* Enterprise bloated
* Over-engineered
* Kubernetes-heavy
* LangChain-complex
* Electron-heavy initially

---

# Main Product Idea

```text
User
↓
Terminal Interface
↓
Intent Detection
↓
Skill Engine
↓
Model Router
↓
Best AI Model
↓
Execution
↓
Streaming Response
```

---

# Product Positioning

> Open-source AI terminal hub with intelligent routing, portable skills, remote control, and multi-terminal interoperability.

---

# Core Features

## 1. Multi-Model Support

Supported providers:

* OpenAI
* Claude
* Gemini
* DeepSeek
* Groq
* Ollama
* OpenRouter
* Local models

---

## 2. Intelligent Model Routing

System automatically selects:

* Best model
* Cheapest model
* Fastest model
* Local/private model

Based on:

* Task
* Skill
* User preferences
* Cost
* Performance

### Initial Routing

Rule-based routing only.

Example:

```ts
if (skill.category === 'coding') {
  return 'deepseek-coder'
}

if (skill.category === 'reasoning') {
  return 'claude'
}

if (skill.category === 'ui') {
  return 'gemini'
}
```

---

# 3. Skills System

Skills are the main intelligence layer.

Users can:

* Use skills
* Install skills
* Create skills
* Share skills
* Export/import skills

---

## Skill Types

### Prompt Skills

Simple prompt wrappers.

Examples:

```bash
/seo
/blog
/summarize
/rewrite
```

---

### Tool Skills

Can access:

* Filesystem
* Git
* Browser
* Shell
* APIs

Examples:

```bash
/debug
/code-review
```

---

### Agent Skills

Multi-step workflows.

Examples:

```bash
/build-dashboard
/build-api
```

---

### Router Skills

Automatically choose models.

Examples:

```bash
/use-best-model
/use-cheapest-model
```

---

# Skill Format

## JSON Example

```json
{
  "name": "seo-writer",
  "description": "SEO blog writer",
  "category": "marketing",
  "bestModel": "claude",
  "tools": ["filesystem"],
  "prompt": "You are an SEO expert..."
}
```

---

## Markdown Example

```md
# Skill: SEO Writer

Category: marketing
BestModel: claude

Prompt:
You are an SEO expert...
```

---

# Default Built-in Skills

## Coding

* /code-review
* /debug
* /generate-api
* /sql-helper
* /explain-code

## Writing

* /blog
* /rewrite
* /email
* /summarize

## Marketing

* /seo
* /ads
* /landing-page

## Design

* /ui-review
* /color-palette
* /prompt-generator

## Business

* /proposal
* /quotation
* /invoice-helper

---

# 4. Onboarding Intelligence

First-time setup personalizes the entire experience.

---

## Example Onboarding Flow

```text
What will you use SkillOS for?

[ ] Coding
[ ] Writing
[ ] SEO
[ ] Marketing
[ ] Design
[ ] Research
[ ] Business
```

Then:

```text
Preferred stack?
[ ] React
[ ] Node
[ ] Python
[ ] PHP
[ ] Flutter
```

Then:

```text
Preferred mode?
[ ] Fast
[ ] Best quality
[ ] Cheapest
[ ] Local/private AI
```

---

# Auto Skill Loading

Example:

If user selects:

* React
* Node
* Backend

System auto-loads:

```bash
/react-helper
/api-builder
/debug-node
/sql-helper
```

---

# Auto Skill Generation

If user says:

```text
I run a printing business
```

System auto-generates:

```bash
/quotation-generator
/banner-copy
/seo-printing
/print-pricing
```

---

# 5. Agents System

Initial lightweight agents:

* Planner
* Coder
* Reviewer
* Writer

---

## Example Workflow

```text
/build-dashboard

↓ Planner
↓ Coder
↓ Reviewer
```

---

# 6. Terminal Bridges

SkillOS can connect to external AI terminals.

Supported bridge targets:

* Claude Code
* OpenCode
* Aider
* Continue.dev
* Cursor
* Local shell
* SSH machines

---

# Bridge System

Each bridge exposes capabilities.

Example:

```json
{
  "name": "claude-code",
  "capabilities": [
    "coding",
    "review",
    "git"
  ],
  "commands": [
    "/review",
    "/code-review"
  ]
}
```

---

# Auto Skill Extraction

When connecting external terminals:

```bash
/connect claude-code
```

SkillOS:

* Detects commands
* Reads skills
* Extracts capabilities
* Generates wrappers
* Creates internal skill map

Example:

```bash
/run claude-review
```

Internally:

```text
SkillOS
↓
Claude Code Bridge
↓
Claude executes
↓
Response streamed back
```

---

# 7. Remote Access System

Users can control SkillOS remotely.

Features:

* QR access
* Remote terminal
* Browser access
* Mobile control
* Real-time streaming

---

# Recommended Remote Architecture

## Cloudflare Tunnel

Preferred remote tunnel system.

Reasons:

* Free
* Secure
* HTTPS
* No port forwarding
* Easy setup
* Mobile-friendly
* Works behind NAT

---

# Remote Workflow

## User Runs

```bash
/remote start
```

---

## System Performs

```text
1. Start websocket server
2. Start Cloudflare Tunnel
3. Generate token
4. Generate QR code
5. Show public URL
```

---

## User Sees

```text
Remote Access Ready

https://abc.trycloudflare.com

[ QR CODE ]
```

---

# Mobile Features

Mobile/browser client can:

* Send commands
* Watch streams
* Upload files
* Stop agents
* Monitor execution
* View logs

---

# Security System

## Initial Security

* Session tokens
* Permission prompts
* Docker sandboxing
* Limited shell access
* Session expiry

Example:

```json
{
  "session": "abc123",
  "expires": "2h",
  "permissions": ["terminal"]
}
```

---

# 8. Tech Stack

| Layer         | Technology        |
| ------------- | ----------------- |
| Frontend      | React             |
| Terminal      | xterm.js          |
| Backend       | Node.js           |
| Language      | TypeScript        |
| Realtime      | WebSockets        |
| AI Layer      | LiteLLM           |
| Local Models  | Ollama            |
| Database      | SQLite            |
| ORM           | Prisma            |
| Styling       | Tailwind          |
| Remote Tunnel | Cloudflare Tunnel |
| Packaging     | Docker            |

---

# 9. System Architecture

```text
Frontend Terminal
    ↓
WebSocket Gateway
    ↓
Command Parser
    ↓
Skill Engine
    ↓
Model Router
    ↓
Providers
```

---

# Extended Architecture

```text
User
↓
SkillOS Terminal
↓
Skill Router
↓
Terminal Bridges
    ├── Claude Code
    ├── OpenCode
    ├── Aider
    ├── Local Shell
    └── Remote Workspace
```

---

# 10. Folder Structure

```text
skillos/

├── apps/
│   ├── client/
│   └── server/
│
├── skills/
│   ├── coding/
│   ├── writing/
│   ├── marketing/
│   └── business/
│
├── agents/
│   ├── planner/
│   ├── coder/
│   └── reviewer/
│
├── providers/
│   ├── openai/
│   ├── anthropic/
│   ├── ollama/
│   └── openrouter/
│
├── bridges/
│   ├── claude-code/
│   ├── aider/
│   ├── opencode/
│   └── shell/
│
├── remote/
│   ├── websocket/
│   ├── qr/
│   ├── auth/
│   └── tunnel/
│
├── router/
├── onboarding/
├── storage/
└── packages/
```

---

# 11. Commands

## Core Commands

```bash
/help
/models
/skills
/agents
```

---

## Model Commands

```bash
/use claude
/use gpt
/use deepseek
```

---

## Skill Commands

```bash
/install seo-pack
/create-skill
/run code-review
```

---

## Remote Commands

```bash
/remote start
/remote stop
/remote status
```

---

## Bridge Commands

```bash
/connect claude-code
/connect aider
/bridges
```

---

# 12. Database Design

## User Profile

```json
{
  "userType": "developer",
  "stacks": ["react", "node"],
  "preferences": {
    "speed": true
  }
}
```

---

## Skills Table

```ts
id
name
category
prompt
bestModel
tools
createdAt
```

---

## Sessions Table

```ts
id
token
expires
permissions
createdAt
```

---

# 13. MVP Scope

## Version 0.1

### Must Have

* Terminal UI
* WebSocket streaming
* LiteLLM integration
* OpenRouter support
* Ollama support
* Skills system
* Onboarding flow
* Rule-based routing
* QR remote access
* Cloudflare Tunnel
* One terminal bridge

---

## NOT Required Yet

* Marketplace
* Advanced RAG
* Kubernetes
* Vector databases
* Team collaboration
* Distributed execution
* AI routing

---

# 14. Roadmap

# Phase 1 — Foundation

## Week 1

Build:

* React frontend
* xterm.js terminal
* Node.js backend
* WebSocket server

---

# Phase 2 — AI Layer

## Week 2

Build:

* LiteLLM integration
* OpenRouter support
* Ollama support
* Streaming responses

---

# Phase 3 — Skills

## Week 3

Build:

* Skill parser
* JSON skills
* Markdown skills
* Command parser
* Onboarding system

---

# Phase 4 — Agents

## Week 4

Build:

* Planner agent
* Coder agent
* Reviewer agent

---

# Phase 5 — Remote Access

## Week 5

Build:

* Cloudflare Tunnel
* QR generation
* Mobile terminal
* Remote auth

---

# Phase 6 — Bridges

## Week 6

Build:

* Claude Code bridge
* Capability scanning
* Skill extraction
* Command wrappers

---

# 15. Open Source Strategy

## License

MIT License

---

## Repository Structure

```text
skillos
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── ROADMAP.md
├── docs/
└── examples/
```

---

# Future Repositories

## Main App

```text
skillos
```

## Skill Packs

```text
skillos-skills
```

## Community Skills

```text
skillos-community
```

---

# 16. Long-Term Vision

Build:

# AI Operating System

Where:

* AI models collaborate
* Skills become extensions
* Agents automate work
* Users personalize intelligence
* Terminals interconnect
* Remote AI workspaces become portable

---

# 17. Biggest Differentiator

NOT:

> Supports many models

BUT:

# Intelligent capability routing with personalized skills and terminal interoperability.

---

# 18. Competitor Analysis

| Tool         | Missing                   |
| ------------ | ------------------------- |
| Claude Code  | Multi-model routing       |
| Cursor       | Skill ecosystem           |
| OpenDevin    | Lightweight UX            |
| Continue.dev | Terminal-native workflows |
| LibreChat    | Intelligent routing       |
| Aider        | Remote orchestration      |

---

# 19. First Release Goal

Version 0.1 should:

* Connect models
* Stream responses
* Load skills
* Parse commands
* Support onboarding
* Route tasks
* Enable remote access
* Connect one external terminal

Simple.
Fast.
Useful.

---

# 20. Final Summary

SkillOS is a lightweight open-source AI terminal operating system that combines:

* Multi-model intelligence
* Personalized skills
* Remote execution
* Terminal interoperability
* AI agents
* Local + cloud AI
* Intelligent routing

The goal is to create a universal AI workspace runtime that works everywhere and connects every AI workflow into one modular terminal ecosystem.
