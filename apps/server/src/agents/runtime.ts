import { routeModel } from "../router/router.js";
import {
  resolveProvider,
  streamCompletion,
  type RouteMode,
} from "../providers/provider.js";
import type { Skill } from "../types.js";
import {
  getAgent,
  getWorkflow,
  type AgentDef,
  type WorkflowDef,
} from "./registry.js";

/**
 * Agent runtime (Layer 3).
 *
 * Multi-step skill orchestration — NOT a framework. A workflow is an ordered
 * list of agents; each agent runs one model turn, and its output is concatenated
 * into the next agent's prompt as context, so Planner → Coder → Reviewer is a
 * real chain. The runtime is transport-agnostic: callers pass an `AgentSink`,
 * and the gateway maps those events onto the WebSocket protocol + persistence.
 *
 * Reuses the existing model path exactly: routeModel (router) +
 * resolveProvider/streamCompletion (providers). Works offline via the mock
 * provider, like the rest of the loop.
 */

export interface StageInfo {
  agent: AgentDef;
  /** 1-based index within the workflow. */
  step: number;
  total: number;
  model: string;
  provider: string;
}

export interface AgentSink {
  /** A stage is starting. */
  onStageStart(info: StageInfo): void;
  /** A streamed token of the current stage's output. */
  onChunk(text: string): void;
  /** A stage finished; `output` is its full accumulated text. */
  onStageEnd(info: StageInfo, output: string): void;
  /** A recoverable error during a stage. */
  onError(message: string): void;
}

export interface WorkflowResult {
  /** Per-stage outputs in order. */
  stages: { agent: string; output: string }[];
  /** Whether every stage completed without a provider error. */
  ok: boolean;
}

/**
 * Route an agent to a logical model: explicit `model`, else its category via the
 * shared router rules, else "default". We synthesize a minimal Skill so the
 * agent inherits the same category routing table skills use.
 */
function routeAgent(agent: AgentDef): string {
  if (agent.model) return agent.model;
  if (agent.category) {
    const pseudo: Skill = {
      name: agent.name,
      description: agent.description,
      category: agent.category,
      bestModel: "",
      tools: [],
      prompt: agent.prompt,
      source: "agent",
      format: "json",
    };
    return routeModel(pseudo, null);
  }
  return routeModel(null, null);
}

/** Build the prompt for a stage, folding in prior stages' output as context. */
function buildStagePrompt(
  task: string,
  priorStages: { agent: string; output: string }[],
): string {
  if (priorStages.length === 0) return task;
  const context = priorStages
    .map((s) => `### Output from ${s.agent}:\n${s.output}`)
    .join("\n\n");
  return [
    `Original task: ${task}`,
    "",
    "Context from previous agents in the pipeline:",
    "",
    context,
    "",
    "Using the original task and the context above, perform your role now.",
  ].join("\n");
}

/** Run a single agent for one turn, streaming via the sink. */
export async function runAgent(
  agent: AgentDef,
  task: string,
  sink: AgentSink,
  step = 1,
  total = 1,
  priorStages: { agent: string; output: string }[] = [],
  mode: RouteMode = "best",
): Promise<string> {
  const model = routeAgent(agent);
  const res = resolveProvider(model, mode);
  const info: StageInfo = {
    agent,
    step,
    total,
    model,
    provider: res.provider,
  };
  sink.onStageStart(info);

  const prompt = buildStagePrompt(task, priorStages);
  let output = "";
  for await (const chunk of streamCompletion(res, agent.prompt, prompt)) {
    output += chunk;
    sink.onChunk(chunk);
  }
  sink.onStageEnd(info, output);
  return output;
}

/** Run a single agent by name. Returns null if the agent is unknown. */
export async function runSingleAgent(
  name: string,
  task: string,
  sink: AgentSink,
  mode: RouteMode = "best",
): Promise<WorkflowResult | null> {
  const agent = getAgent(name);
  if (!agent) return null;
  try {
    const output = await runAgent(agent, task, sink, 1, 1, [], mode);
    return { stages: [{ agent: agent.name, output }], ok: true };
  } catch (err) {
    sink.onError(`Agent "${name}" failed: ${(err as Error).message}`);
    return { stages: [], ok: false };
  }
}

/**
 * Run a workflow: each stage's output feeds the next as context. Returns null
 * if the workflow is unknown.
 */
export async function runWorkflow(
  workflow: WorkflowDef | string,
  task: string,
  sink: AgentSink,
  mode: RouteMode = "best",
): Promise<WorkflowResult | null> {
  const wf =
    typeof workflow === "string" ? getWorkflow(workflow) : workflow;
  if (!wf) return null;

  const stages: { agent: string; output: string }[] = [];
  const total = wf.steps.length;

  for (let i = 0; i < wf.steps.length; i++) {
    const agentName = wf.steps[i]!;
    const agent = getAgent(agentName);
    if (!agent) {
      sink.onError(
        `Workflow "${wf.name}" references unknown agent "${agentName}".`,
      );
      return { stages, ok: false };
    }
    try {
      const output = await runAgent(
        agent,
        task,
        sink,
        i + 1,
        total,
        stages,
        mode,
      );
      stages.push({ agent: agent.name, output });
    } catch (err) {
      sink.onError(
        `Stage ${i + 1} (${agent.name}) failed: ${(err as Error).message}`,
      );
      return { stages, ok: false };
    }
  }

  return { stages, ok: true };
}
