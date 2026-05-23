import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { streamText, type LanguageModel } from "ai";

/**
 * Provider layer. Maps a logical model name (from the router) to a concrete
 * provider + model and streams text back.
 *
 * SkillOS supports multiple LLM providers with runtime selection. The ACTIVE
 * provider is chosen by `SKILLOS_PROVIDER` (or auto-detected from whichever key
 * is set), and `/provider` switches it live. Each provider is described once in
 * the registry below: its env key, selectable models, and a logical→model map.
 *
 * Direct providers (openai/anthropic/google/groq/deepseek) and OpenRouter all
 * go through the Vercel AI SDK (`streamText`). Ollama uses its native streaming
 * API via `fetch` (no SDK). A built-in "mock" provider runs when nothing is
 * configured, so the full loop is demoable offline.
 */

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "deepseek"
  | "openrouter"
  | "ollama"
  | "mock";

/**
 * The user's preferred routing mode (from onboarding). It biases provider/model
 * selection: `local` forces local Ollama models; `best` picks higher-quality
 * (pricier) models; `fast`/`cheapest` pick lighter, cheaper ones. Mode only
 * affects OpenRouter tiers and the `local` override today.
 */
export type RouteMode = "fast" | "best" | "cheapest" | "local";

export interface Resolution {
  kind: ProviderKind;
  /** Provider-specific model id. */
  model: string;
  /** Human-readable label for `done` metadata, e.g. "anthropic:claude-3-5-sonnet-latest". */
  provider: string;
}

/** Logical names the router emits; every provider maps these to a real model. */
type Logical = "claude" | "gpt" | "gemini" | "deepseek-coder" | "default";

/** Static description of a provider in the registry. */
export interface ProviderDef {
  id: ProviderKind;
  label: string;
  /** Env var holding the API key; null for keyless providers (ollama/mock). */
  envKey: string | null;
  /** Whether a key is required to use this provider. */
  needsKey: boolean;
  /** A short list of selectable, concrete model ids (shown by `/models`). */
  models: string[];
  /** Logical name → concrete model for this provider. */
  logical: Record<Logical, string>;
  /** Default concrete model when a logical name has no mapping. */
  defaultModel: string;
}

// ---------------------------------------------------------------------------
// Registry — add a provider by adding an entry here (+ a factory in the switch).
// ---------------------------------------------------------------------------

export const PROVIDER_REGISTRY: Record<ProviderKind, ProviderDef> = {
  openai: {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    needsKey: true,
    models: ["gpt-4o", "gpt-4o-mini"],
    logical: {
      claude: "gpt-4o",
      gpt: "gpt-4o",
      gemini: "gpt-4o",
      "deepseek-coder": "gpt-4o-mini",
      default: "gpt-4o-mini",
    },
    defaultModel: "gpt-4o-mini",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic (Claude)",
    envKey: "ANTHROPIC_API_KEY",
    needsKey: true,
    models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
    logical: {
      claude: "claude-3-5-sonnet-latest",
      gpt: "claude-3-5-sonnet-latest",
      gemini: "claude-3-5-sonnet-latest",
      "deepseek-coder": "claude-3-5-haiku-latest",
      default: "claude-3-5-sonnet-latest",
    },
    defaultModel: "claude-3-5-sonnet-latest",
  },
  google: {
    id: "google",
    label: "Google (Gemini)",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    needsKey: true,
    models: ["gemini-1.5-pro", "gemini-1.5-flash"],
    logical: {
      claude: "gemini-1.5-pro",
      gpt: "gemini-1.5-pro",
      gemini: "gemini-1.5-pro",
      "deepseek-coder": "gemini-1.5-flash",
      default: "gemini-1.5-flash",
    },
    defaultModel: "gemini-1.5-flash",
  },
  groq: {
    id: "groq",
    label: "Groq",
    envKey: "GROQ_API_KEY",
    needsKey: true,
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    logical: {
      claude: "llama-3.3-70b-versatile",
      gpt: "llama-3.3-70b-versatile",
      gemini: "llama-3.3-70b-versatile",
      "deepseek-coder": "llama-3.1-8b-instant",
      default: "llama-3.3-70b-versatile",
    },
    defaultModel: "llama-3.3-70b-versatile",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    needsKey: true,
    models: ["deepseek-chat", "deepseek-reasoner"],
    logical: {
      claude: "deepseek-reasoner",
      gpt: "deepseek-chat",
      gemini: "deepseek-chat",
      "deepseek-coder": "deepseek-chat",
      default: "deepseek-chat",
    },
    defaultModel: "deepseek-chat",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter (many models, one key)",
    envKey: "OPENROUTER_API_KEY",
    needsKey: true,
    // The selectable list is the `best`-tier slugs; the actual model used also
    // honors `mode` tiers (see openrouterSlug). `/models` shows these.
    models: [
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o",
      "google/gemini-pro-1.5",
      "deepseek/deepseek-chat",
    ],
    // `logical` here is the `best` tier; resolveProvider swaps in the cheaper
    // tier for fast/cheapest modes via openrouterSlug.
    logical: {
      claude: "anthropic/claude-3.5-sonnet",
      gpt: "openai/gpt-4o",
      gemini: "google/gemini-pro-1.5",
      "deepseek-coder": "deepseek/deepseek-chat",
      default: "anthropic/claude-3.5-sonnet",
    },
    defaultModel: "anthropic/claude-3.5-sonnet",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (local, no key)",
    envKey: null,
    needsKey: false,
    models: ["llama3.1", "deepseek-coder"],
    logical: {
      claude: "llama3.1",
      gpt: "llama3.1",
      gemini: "llama3.1",
      "deepseek-coder": "deepseek-coder",
      default: "llama3.1",
    },
    defaultModel: "llama3.1",
  },
  mock: {
    id: "mock",
    label: "Mock (offline)",
    envKey: null,
    needsKey: false,
    models: ["mock"],
    logical: {
      claude: "mock",
      gpt: "mock",
      gemini: "mock",
      "deepseek-coder": "mock",
      default: "mock",
    },
    defaultModel: "mock",
  },
};

/**
 * Auto-detect priority: when no explicit/keyed `SKILLOS_PROVIDER` is set, pick
 * the first provider in this order whose key is present. OpenRouter stays ahead
 * of the direct providers to preserve today's behavior (one key, many models).
 */
const AUTO_PRIORITY: ProviderKind[] = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "groq",
  "deepseek",
];

// OpenRouter cheaper / faster tier — used for `fast` and `cheapest` modes.
const OPENROUTER_SLUGS_CHEAP: Record<Logical, string> = {
  claude: "anthropic/claude-3-haiku",
  gpt: "openai/gpt-4o-mini",
  gemini: "google/gemini-flash-1.5",
  "deepseek-coder": "deepseek/deepseek-chat",
  default: "openai/gpt-4o-mini",
};

function isLogical(s: string): s is Logical {
  return (
    s === "claude" ||
    s === "gpt" ||
    s === "gemini" ||
    s === "deepseek-coder" ||
    s === "default"
  );
}

/** True when a provider's key is present in the live environment. */
function hasKey(def: ProviderDef): boolean {
  if (!def.envKey) return false;
  return Boolean(process.env[def.envKey]);
}

/**
 * Resolve the active provider id from the live environment.
 *   - `SKILLOS_PROVIDER` if set AND usable (keyless, or its key is present);
 *   - else the first AUTO_PRIORITY provider whose key is set;
 *   - else `ollama` if `OLLAMA_BASE_URL` is configured;
 *   - else `mock` (offline).
 * This preserves today's behavior: with only OPENROUTER_API_KEY set, active is
 * openrouter; with nothing set, active is mock.
 */
export function activeProvider(): ProviderKind {
  const explicit = process.env.SKILLOS_PROVIDER as ProviderKind | undefined;
  if (explicit && PROVIDER_REGISTRY[explicit]) {
    const def = PROVIDER_REGISTRY[explicit];
    if (def.id === "ollama") {
      if (process.env.OLLAMA_BASE_URL) return "ollama";
    } else if (!def.needsKey || hasKey(def)) {
      return def.id;
    }
    // Explicit choice isn't usable (missing key/endpoint) — fall through.
  }
  for (const id of AUTO_PRIORITY) {
    if (hasKey(PROVIDER_REGISTRY[id])) return id;
  }
  if (process.env.OLLAMA_BASE_URL) return "ollama";
  return "mock";
}

function openrouterSlug(logical: Logical, mode: RouteMode): string {
  if (mode === "best") return PROVIDER_REGISTRY.openrouter.logical[logical];
  return OPENROUTER_SLUGS_CHEAP[logical];
}

/**
 * Pick a concrete provider + model. The provider is whatever's active; the model
 * is derived from `logical`, which may be:
 *   - a logical name (claude/gpt/gemini/deepseek-coder/default) → mapped per
 *     provider (OpenRouter also honors `mode` tiers); or
 *   - a concrete model id for the active provider (e.g. via `/models`/`/use`) →
 *     used as-is.
 * The signature is unchanged so all callers keep working.
 */
export function resolveProvider(
  logical: string,
  mode: RouteMode = "best",
): Resolution {
  // `local` mode still prefers on-device Ollama when configured, regardless of
  // the active provider — privacy override, matching prior behavior.
  if (mode === "local" && process.env.OLLAMA_BASE_URL) {
    return resolveFor("ollama", logical, mode);
  }
  return resolveFor(activeProvider(), logical, mode);
}

/** Resolve a logical-or-concrete model for a specific provider id. */
function resolveFor(
  id: ProviderKind,
  logical: string,
  mode: RouteMode,
): Resolution {
  const def = PROVIDER_REGISTRY[id];
  let model: string;
  if (isLogical(logical)) {
    model =
      id === "openrouter"
        ? openrouterSlug(logical, mode)
        : def.logical[logical];
  } else {
    // A concrete model id for this provider — use as-is.
    model = logical;
  }
  return { kind: id, model, provider: `${id}:${model}` };
}

// ---------------------------------------------------------------------------
// Introspection helpers for the runtime pickers (`/provider`, `/models`).
// ---------------------------------------------------------------------------

export interface ProviderInfo {
  id: ProviderKind;
  label: string;
  needsKey: boolean;
  hasKey: boolean;
  active: boolean;
}

/** List all providers with live key/active status, for the `/provider` picker. */
export function providerInfo(): ProviderInfo[] {
  const active = activeProvider();
  return (Object.keys(PROVIDER_REGISTRY) as ProviderKind[]).map((id) => {
    const def = PROVIDER_REGISTRY[id];
    const keyed = id === "ollama" ? Boolean(process.env.OLLAMA_BASE_URL) : hasKey(def);
    return {
      id,
      label: def.label,
      needsKey: def.needsKey,
      hasKey: keyed,
      active: id === active,
    };
  });
}

/** The selectable model ids for a provider (defaults to the active provider). */
export function modelsFor(providerId?: ProviderKind): string[] {
  const id = providerId ?? activeProvider();
  return PROVIDER_REGISTRY[id].models;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Build an AI-SDK LanguageModel for a SDK-backed provider, reading keys live. */
function sdkModel(kind: ProviderKind, model: string): LanguageModel {
  switch (kind) {
    case "openai":
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(model);
    case "anthropic":
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(model);
    case "google":
      return createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      })(model);
    case "groq":
      return createGroq({ apiKey: process.env.GROQ_API_KEY })(model);
    case "deepseek":
      return createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(model);
    case "openrouter":
      return createOpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      })(model);
    default:
      throw new Error(`No SDK factory for provider "${kind}".`);
  }
}

export async function* streamCompletion(
  res: Resolution,
  system: string,
  prompt: string,
): AsyncGenerator<string> {
  switch (res.kind) {
    case "openai":
    case "anthropic":
    case "google":
    case "groq":
    case "deepseek":
    case "openrouter": {
      const result = streamText({ model: sdkModel(res.kind, res.model), system, prompt });
      for await (const delta of result.textStream) yield delta;
      return;
    }
    case "ollama":
      yield* streamOllama(res.model, system, prompt);
      return;
    case "mock":
      yield* streamMock(res.model, system, prompt);
      return;
  }
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
    `Set a provider key in .env (or run Ollama) for real output.`,
  ].join("\n");
  for (const token of text.split(/(\s+)/)) {
    yield token;
    await sleep(12);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
