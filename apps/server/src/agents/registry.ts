/**
 * Agent registry (Layer 3).
 *
 * Agents are data, not classes. Each agent is a role with a system prompt and a
 * preferred logical model; the runtime routes that model through the existing
 * router/provider path. Keeping definitions in a plain object means adding an
 * agent is a one-entry edit — no framework, in keeping with the project's
 * lightweight/hackable philosophy.
 *
 * An agent maps to the model layer in one of two ways:
 *   - `model`: a logical model name handed straight to resolveProvider.
 *   - `category`: routed via the same category rules skills use, so an agent
 *     inherits the project's routing table (e.g. "coding" -> deepseek-coder).
 * If both are absent the runtime falls back to "default".
 */

export interface AgentDef {
  /** Stable id used by /agent <name> and workflow definitions. */
  name: string;
  /** One-line role description, shown by /agents. */
  description: string;
  /** System prompt that defines the agent's behavior for its turn. */
  prompt: string;
  /** Preferred logical model (e.g. "claude"). Optional. */
  model?: string;
  /** Routing category, reused by routeModel when `model` is absent. Optional. */
  category?: string;
  /**
   * Privileged tools this agent may use, e.g. ["shell","filesystem"] (Layer 4).
   * Drives remote permission prompts. Absent/empty means chat-only (no prompt).
   */
  tools?: string[];
}

/** A multi-step workflow: an ordered chain of agent names. */
export interface WorkflowDef {
  /** Command name without the slash, e.g. "build-dashboard". */
  name: string;
  /** One-line description, shown by /agents. */
  description: string;
  /** Ordered agent ids; each stage's output feeds the next as context. */
  steps: string[];
}

export const AGENTS: Record<string, AgentDef> = {
  planner: {
    name: "planner",
    description: "Breaks a task into a concrete, ordered build plan",
    category: "reasoning",
    model: "claude",
    prompt: [
      "You are the Planner agent in a multi-agent build pipeline.",
      "Given a task, produce a concise, concrete, numbered plan another agent",
      "can implement directly. List the components/files to create, the key",
      "steps in order, and any important decisions or assumptions.",
      "Do NOT write the implementation code — output the plan only.",
    ].join(" "),
  },
  coder: {
    name: "coder",
    description: "Implements code from a plan",
    category: "coding",
    model: "deepseek-coder",
    tools: ["filesystem"],
    prompt: [
      "You are the Coder agent in a multi-agent build pipeline.",
      "You receive a plan from the Planner. Implement it as clean, working code.",
      "Produce complete files with paths, use idiomatic patterns, and keep it",
      "minimal but functional. Briefly note anything you intentionally stubbed.",
    ].join(" "),
  },
  reviewer: {
    name: "reviewer",
    description: "Reviews implemented code for bugs and quality",
    category: "coding",
    model: "deepseek-coder",
    prompt: [
      "You are the Reviewer agent in a multi-agent build pipeline.",
      "You receive a plan and an implementation. Review the code: find",
      "correctness bugs first, then clarity, security, and style issues.",
      "For each finding give the location, the problem, and a concrete fix.",
      "End with a one-line verdict: SHIP or NEEDS WORK.",
    ].join(" "),
  },
  writer: {
    name: "writer",
    description: "Writes clear prose, docs, or marketing copy",
    category: "writing",
    model: "claude",
    prompt: [
      "You are the Writer agent in a multi-agent build pipeline.",
      "You turn inputs (a plan, code, or a brief) into clear, well-structured",
      "prose: documentation, a README, or marketing copy as appropriate.",
      "Be concise, accurate, and audience-aware. Use Markdown headings.",
    ].join(" "),
  },
};

export const WORKFLOWS: Record<string, WorkflowDef> = {
  "build-dashboard": {
    name: "build-dashboard",
    description: "Plan, build, and review a dashboard UI",
    steps: ["planner", "coder", "reviewer"],
  },
  "build-api": {
    name: "build-api",
    description: "Plan, build, and review an API",
    steps: ["planner", "coder", "reviewer"],
  },
};

export function getAgent(name: string): AgentDef | null {
  return AGENTS[name.toLowerCase()] ?? null;
}

/** Privileged tools a single agent declares (Layer 4 permission model). */
export function getAgentTools(name: string): string[] {
  return getAgent(name)?.tools ?? [];
}

/** Union of privileged tools across every agent in a workflow. */
export function getWorkflowTools(name: string): string[] {
  const wf = getWorkflow(name);
  if (!wf) return [];
  const set = new Set<string>();
  for (const step of wf.steps) {
    for (const t of getAgentTools(step)) set.add(t);
  }
  return [...set];
}

export function getWorkflow(name: string): WorkflowDef | null {
  return WORKFLOWS[name.toLowerCase()] ?? null;
}

export function listAgents(): AgentDef[] {
  return Object.values(AGENTS);
}

export function listWorkflows(): WorkflowDef[] {
  return Object.values(WORKFLOWS);
}
