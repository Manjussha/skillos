# agents/ — Layer 3

Multi-step **agent workflows** that chain skills/roles with streamed step output.
This is orchestration over the existing model path — **not** a framework. There
is no graph engine, no tool-calling loop, no LangChain. An agent is data (a role
+ system prompt + preferred model); a workflow is an ordered list of agents whose
outputs feed forward.

The runtime lives in `apps/server/src/agents/`:

- `registry.ts` — data-driven definitions: the `AGENTS` and `WORKFLOWS` objects.
- `runtime.ts` — runs a single agent or a workflow, streaming each stage through
  a transport-agnostic `AgentSink`. Reuses the Layer 1 model path exactly:
  `routeModel` (router) + `resolveProvider` / `streamCompletion` (providers), so
  everything works offline with the mock provider.

The WebSocket gateway (`apps/server/src/index.ts`) owns I/O: it builds a sink
that maps runtime events onto the protocol and persists each stage to the message
store best-effort (DB errors never block a run).

## Built-in agents

| Agent      | Role                                           | Routes to        |
| ---------- | ---------------------------------------------- | ---------------- |
| `planner`  | Breaks a task into a concrete, ordered plan    | `claude` (reasoning) |
| `coder`    | Implements code from a plan                    | `deepseek-coder` (coding) |
| `reviewer` | Reviews implemented code for bugs and quality  | `deepseek-coder` (coding) |
| `writer`   | Writes clear prose, docs, or marketing copy    | `claude` (writing) |

Each agent declares a `model` (logical model name) and/or a `category`. If
`model` is set it's used directly; otherwise the agent is routed by `category`
through the same rules skills use (`router/router.ts`); otherwise `"default"`.

## Commands

| Command                     | What it does                                            |
| --------------------------- | ------------------------------------------------------- |
| `/agents`                   | List built-in agents and workflows                      |
| `/agent <name> <task>`      | Run one agent for a single turn                         |
| `/build-dashboard <desc>`   | Workflow: Planner → Coder → Reviewer for a dashboard UI |
| `/build-api <desc>`         | Workflow: Planner → Coder → Reviewer for an API         |

Any workflow in `WORKFLOWS` is also runnable as a bare `/<workflow-name>`
command, the same way skills are.

## How chaining works

A workflow runs its agents in order. Each stage's full output is concatenated
into the next stage's user prompt as labeled context:

```
Original task: <task>

Context from previous agents in the pipeline:

### Output from planner:
<planner output>

### Output from coder:
<coder output>

Using the original task and the context above, perform your role now.
```

So the Planner's plan really feeds the Coder, and the Coder's code (plus the
plan) really feeds the Reviewer. Each stage announces itself with a `stage`
message and a readable `info` header, then streams its model output as `chunk`s.
A workflow is a single user turn, so exactly one `done` is emitted at the end
(keeping the Layer 1 prompt-rearm contract).

## Protocol

Layer 3 adds one backward-compatible `ServerMessage` variant (mirrored in
`apps/server/src/types.ts` and `apps/client/src/App.tsx`):

```ts
{ type: "stage"; agent: string; step: number; total: number; model: string; provider: string }
```

Older clients can ignore it — the runtime also emits an `info` header for every
stage, so progress is visible without special handling.

## Adding a new agent

Add one entry to `AGENTS` in `registry.ts`:

```ts
tester: {
  name: "tester",
  description: "Writes tests for implemented code",
  category: "coding",          // or set `model: "deepseek-coder"`
  prompt: "You are the Tester agent… write thorough unit tests.",
},
```

It's immediately runnable via `/agent tester <task>` — no other code change.

## Adding a new workflow

Add one entry to `WORKFLOWS` in `registry.ts`:

```ts
"build-and-test": {
  name: "build-and-test",
  description: "Plan, build, review, then test",
  steps: ["planner", "coder", "reviewer", "tester"],
},
```

It's runnable as `/build-and-test <task>` immediately (bare workflow commands are
dispatched automatically). To give it a dedicated case in `/help` or the
dispatcher switch, add it in `apps/server/src/index.ts` alongside
`build-dashboard` / `build-api`.

## Verifying

With the server running (`npm run dev:server`):

```bash
node scripts/verify-layer3.mjs
```

It drives `/agents` and `/build-dashboard`, prints the staged
Planner → Coder → Reviewer stream, and asserts all three stages ran.

See [`../ROADMAP.md`](../ROADMAP.md) Layer 3.
