import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

/**
 * Provider layer. Maps a logical model name (from the router) to a concrete
 * provider + model and streams text back.
 *
 * v0.1 wires two providers per ROADMAP.md Layer 1:
 *   - OpenRouter (one key, many models) via the OpenAI-compatible endpoint
 *   - Ollama (local) via its native streaming API
 * A built-in "mock" provider runs when no key/endpoint is configured, so the
 * full loop is demoable offline. Other providers drop in by extending the maps.
 */

export type ProviderKind = "openrouter" | "ollama" | "mock";

/**
 * The user's preferred routing mode (from onboarding). It biases provider/model
 * selection: `local` forces local Ollama models; `best` picks higher-quality
 * (pricier) models; `fast`/`cheapest` pick lighter, cheaper ones.
 */
export type RouteMode = "fast" | "best" | "cheapest" | "local";

export interface Resolution {
  kind: ProviderKind;
  /** Provider-specific model id. */
  model: string;
  /** Human-readable label for `done` metadata, e.g. "openrouter:openai/gpt-4o-mini". */
  provider: string;
}

// Cheaper / faster tier — used for `fast` and `cheapest` modes.
const OPENROUTER_SLUGS: Record<string, string> = {
  claude: "anthropic/claude-3-haiku",
  gpt: "openai/gpt-4o-mini",
  gemini: "google/gemini-flash-1.5",
  "deepseek-coder": "deepseek/deepseek-chat",
  default: "openai/gpt-4o-mini",
};

// Higher-quality tier — used for `best` mode.
const OPENROUTER_SLUGS_BEST: Record<string, string> = {
  claude: "anthropic/claude-3.5-sonnet",
  gpt: "openai/gpt-4o",
  gemini: "google/gemini-pro-1.5",
  "deepseek-coder": "deepseek/deepseek-chat",
  default: "anthropic/claude-3.5-sonnet",
};

const OLLAMA_MODELS: Record<string, string> = {
  "deepseek-coder": "deepseek-coder",
  default: "llama3.1",
};

function openrouterSlug(logical: string, mode: RouteMode): string {
  const table = mode === "best" ? OPENROUTER_SLUGS_BEST : OPENROUTER_SLUGS;
  return table[logical] ?? table.default!;
}

/**
 * Pick a concrete provider + model for a logical model name, biased by the
 * user's mode. Precedence:
 *   - `local` mode → Ollama if configured (private, on-device);
 *   - else OpenRouter if a key is set (model tier chosen by mode);
 *   - else Ollama if configured;
 *   - else the offline mock provider.
 */
export function resolveProvider(
  logical: string,
  mode: RouteMode = "best",
): Resolution {
  if (mode === "local" && process.env.OLLAMA_BASE_URL) {
    const model = OLLAMA_MODELS[logical] ?? OLLAMA_MODELS.default!;
    return { kind: "ollama", model, provider: `ollama:${model}` };
  }
  if (process.env.OPENROUTER_API_KEY) {
    const model = openrouterSlug(logical, mode);
    return { kind: "openrouter", model, provider: `openrouter:${model}` };
  }
  if (process.env.OLLAMA_BASE_URL) {
    const model = OLLAMA_MODELS[logical] ?? OLLAMA_MODELS.default!;
    return { kind: "ollama", model, provider: `ollama:${model}` };
  }
  return { kind: "mock", model: logical, provider: "mock" };
}

export async function* streamCompletion(
  res: Resolution,
  system: string,
  prompt: string,
): AsyncGenerator<string> {
  switch (res.kind) {
    case "openrouter":
      yield* streamOpenRouter(res.model, system, prompt);
      return;
    case "ollama":
      yield* streamOllama(res.model, system, prompt);
      return;
    case "mock":
      yield* streamMock(res.model, system, prompt);
      return;
  }
}

async function* streamOpenRouter(
  model: string,
  system: string,
  prompt: string,
): AsyncGenerator<string> {
  const openrouter = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const result = streamText({ model: openrouter(model), system, prompt });
  for await (const delta of result.textStream) yield delta;
}

async function* streamOllama(
  model: string,
  system: string,
  prompt: string,
): AsyncGenerator<string> {
  const base = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/api";
  const resp = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Ollama request failed (${resp.status} ${resp.statusText})`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const obj = JSON.parse(line) as { message?: { content?: string } };
      const content = obj.message?.content;
      if (content) yield content;
    }
  }
}

async function* streamMock(
  model: string,
  system: string,
  prompt: string,
): AsyncGenerator<string> {
  const head = system.slice(0, 80) + (system.length > 80 ? "…" : "");
  const text = [
    `[mock provider · model "${model}"]`,
    ``,
    `No provider key configured, so this is a simulated stream.`,
    `Your prompt was: "${prompt}".`,
    `Active system prompt begins: "${head}".`,
    ``,
    `Set OPENROUTER_API_KEY in .env (or run Ollama) for real output.`,
  ].join("\n");
  for (const token of text.split(/(\s+)/)) {
    yield token;
    await sleep(12);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
