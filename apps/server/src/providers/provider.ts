import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { streamText, type LanguageModel } from "ai";
import {
  CLI_PROVIDER_BRIDGES,
  isCliProviderId,
  isCliInstalled,
  runCliAsk,
  type CliProviderId,
} from "../bridges/registry.js";

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
 * go through the Vercel AI SDK (`streamText`). Ollama (local) uses its native
 * streaming API via `fetch` (no SDK); Ollama Cloud uses the OpenAI-compatible
 * SDK against ollama.com. Installed AI CLIs (Claude Code, Gemini, OpenCode, Kilo
 * Code) are also selectable as the ACTIVE provider — selecting one routes the
 * whole core loop through that CLI using ITS own auth (no SkillOS key); these
 * resolve to the `cli` kind and stream via the corresponding bridge. A built-in
 * "mock" provider runs when nothing is configured, so the loop is demoable
 * offline.
 */

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "deepseek"
  | "openrouter"
  | "ollama"
  | "ollama-cloud"
  | "mock"
  // Resolution-only kind: an installed AI CLI acting as the active provider.
  // It is NOT a PROVIDER_REGISTRY entry — the concrete CLI id is carried on the
  // Resolution (`cli`) and the picker offers CLIs from CLI_PROVIDER_BRIDGES.
  | "cli";

/**
 * The user's preferred routing mode (from onboarding). It biases provider/model
 * selection: `local` forces local Ollama models; `best` picks higher-quality
 * (pricier) models; `fast`/`cheapest` pick lighter, cheaper ones. Mode only
 * affects OpenRouter tiers and the `local` override today.
 */
export type RouteMode = "fast" | "best" | "cheapest" | "local";

/**
 * Registry-backed provider kinds (everything EXCEPT `cli`, which is a
 * resolution-only kind carried on the Resolution rather than the registry).
 */
export type RegistryKind = Exclude<ProviderKind, "cli">;

export interface Resolution {
  kind: ProviderKind;
  /** Provider-specific model id. For `cli`, this is the CLI id (e.g. "gemini"). */
  model: string;
  /** Human-readable label for `done` metadata, e.g. "anthropic:claude-3-5-sonnet-latest". */
  provider: string;
  /** Set when `kind === "cli"`: which installed CLI bridge answers the turn. */
  cliId?: CliProviderId;
}

/** Logical names the router emits; every provider maps these to a real model. */
type Logical = "claude" | "gpt" | "gemini" | "deepseek-coder" | "default";

/** Static description of a provider in the registry. */
export interface ProviderDef {
  id: RegistryKind;
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

export const PROVIDER_REGISTRY: Record<RegistryKind, ProviderDef> = {
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
  "ollama-cloud": {
    id: "ollama-cloud",
    label: "Ollama Cloud (hosted, key)",
    envKey: "OLLAMA_API_KEY",
    needsKey: true,
    // Hosted Ollama exposes large open models behind an OpenAI-compatible API.
    models: ["gpt-oss:120b", "gpt-oss:20b"],
    logical: {
      claude: "gpt-oss:120b",
      gpt: "gpt-oss:120b",
      gemini: "gpt-oss:120b",
      "deepseek-coder": "gpt-oss:20b",
      default: "gpt-oss:20b",
    },
    defaultModel: "gpt-oss:20b",
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
const AUTO_PRIORITY: RegistryKind[] = [
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "groq",
  "deepseek",
  "ollama-cloud",
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

/** The raw active selection: a registry kind OR an installed CLI provider id. */
export type ActiveSelection = RegistryKind | CliProviderId;

/**
 * Resolve the active selection from the live environment. Like `activeProvider`,
 * but preserves the concrete CLI id when an installed AI CLI is the active
 * provider (so `resolveProvider` can route the loop through it).
 *   - `SKILLOS_PROVIDER` if it names an INSTALLED CLI → that CLI id;
 *   - `SKILLOS_PROVIDER` if a registry id that's usable (keyless, or key present);
 *   - else the first AUTO_PRIORITY provider whose key is set;
 *   - else `ollama` if `OLLAMA_BASE_URL` is configured;
 *   - else `mock` (offline).
 * A CLI selected but not installed at startup is NOT usable — we fall through to
 * auto-detect so the loop never points at a missing binary.
 */
export function activeSelection(): ActiveSelection {
  const explicit = process.env.SKILLOS_PROVIDER as string | undefined;
  if (explicit && isCliProviderId(explicit)) {
    if (isCliInstalled(explicit)) return explicit;
    // Selected CLI isn't installed (this process) — fall through to auto-detect.
  } else if (explicit && (PROVIDER_REGISTRY as Record<string, ProviderDef>)[explicit]) {
    const def = PROVIDER_REGISTRY[explicit as RegistryKind];
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

/**
 * Resolve the active provider KIND from the live environment. A CLI selection
 * collapses to the `cli` kind here; use `activeSelection()` when you need the
 * concrete CLI id. Preserves today's behavior for registry providers: with only
 * OPENROUTER_API_KEY set, active is openrouter; with nothing set, active is mock.
 */
export function activeProvider(): ProviderKind {
  const sel = activeSelection();
  return isCliProviderId(sel) ? "cli" : sel;
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
  const sel = activeSelection();
  // An installed AI CLI as the active provider: the whole loop streams through
  // that CLI (its own auth, no SkillOS key). Carry the CLI id on the Resolution;
  // `model` doubles as the CLI id for `done` metadata.
  if (isCliProviderId(sel)) {
    return { kind: "cli", model: sel, provider: `cli:${sel}`, cliId: sel };
  }
  return resolveFor(sel, logical, mode);
}

/** Resolve a logical-or-concrete model for a specific registry provider id. */
function resolveFor(
  id: RegistryKind,
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

/** Grouping for the unified `/provider` picker. */
export type ProviderGroup = "api" | "local" | "cli";

export interface ProviderInfo {
  /** Registry id OR a CLI provider id (for `group === "cli"`). */
  id: RegistryKind | CliProviderId;
  label: string;
  needsKey: boolean;
  /** Key present (registry providers) — always false for CLI providers. */
  hasKey: boolean;
  active: boolean;
  /** Which section of the picker this belongs to. */
  group: ProviderGroup;
  /** For CLI providers: whether the binary was detected installed at startup. */
  installed?: boolean;
}

/** Default order of the API-key registry providers in the picker. */
const API_ORDER: RegistryKind[] = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "deepseek",
  "openrouter",
];

/**
 * List ALL selectable backends with live status, for the unified `/provider`
 * picker. Three groups, in order: API providers, local/hosted (Ollama local +
 * Ollama Cloud), then installed CLI tools (their own auth, no key). The active
 * selection (registry kind OR CLI id) is marked. `mock` is intentionally NOT
 * listed here — "Skip (mock)" is offered separately by the picker UI.
 */
export function providerInfo(): ProviderInfo[] {
  const sel = activeSelection();
  const out: ProviderInfo[] = [];

  // 1) API providers.
  for (const id of API_ORDER) {
    const def = PROVIDER_REGISTRY[id];
    out.push({
      id,
      label: def.label,
      needsKey: def.needsKey,
      hasKey: hasKey(def),
      active: sel === id,
      group: "api",
    });
  }

  // 2) Local / hosted: Ollama (local, keyless) + Ollama Cloud (key).
  const ollama = PROVIDER_REGISTRY.ollama;
  out.push({
    id: "ollama",
    label: ollama.label,
    needsKey: ollama.needsKey,
    hasKey: Boolean(process.env.OLLAMA_BASE_URL),
    active: sel === "ollama",
    group: "local",
  });
  const cloud = PROVIDER_REGISTRY["ollama-cloud"];
  out.push({
    id: "ollama-cloud",
    label: cloud.label,
    needsKey: cloud.needsKey,
    hasKey: hasKey(cloud),
    active: sel === "ollama-cloud",
    group: "local",
  });

  // 3) Installed CLI tools (use their own login — no SkillOS key).
  for (const id of CLI_PROVIDER_BRIDGES) {
    out.push({
      id,
      label: CLI_LABELS[id],
      needsKey: false,
      hasKey: false,
      active: sel === id,
      group: "cli",
      installed: isCliInstalled(id),
    });
  }

  return out;
}

/** Human labels for the CLI provider options in the picker. */
const CLI_LABELS: Record<CliProviderId, string> = {
  "claude-code": "Claude Code",
  gemini: "Gemini",
  opencode: "OpenCode",
  "kilo-code": "Kilo Code",
};

/**
 * The selectable model ids for a provider (defaults to the active provider).
 * CLI providers have no SkillOS-side model list (the CLI picks its own model),
 * so this returns an empty list for them.
 */
export function modelsFor(providerId?: ProviderKind | RegistryKind): string[] {
  const id = providerId ?? activeProvider();
  if (id === "cli") return [];
  return PROVIDER_REGISTRY[id as RegistryKind].models;
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
    case "ollama-cloud":
      // Hosted Ollama exposes an OpenAI-compatible endpoint. Base URL overridable
      // via OLLAMA_CLOUD_URL; key read live from OLLAMA_API_KEY.
      return createOpenAI({
        baseURL: process.env.OLLAMA_CLOUD_URL ?? "https://ollama.com/v1",
        apiKey: process.env.OLLAMA_API_KEY,
      })(model);
    default:
      throw new Error(`No SDK factory for provider "${kind}".`);
  }
}

/** Generous default for a CLI-as-provider turn (CLIs cold-start + think). */
const CLI_PROVIDER_TIMEOUT_MS = Number(
  process.env.SKILLOS_CLI_TIMEOUT_MS ?? 120000,
);

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
    case "openrouter":
    case "ollama-cloud": {
      const result = streamText({ model: sdkModel(res.kind, res.model), system, prompt });
      for await (const delta of result.textStream) yield delta;
      return;
    }
    case "ollama":
      yield* streamOllama(res.model, system, prompt);
      return;
    case "cli":
      yield* streamCli(res.cliId ?? (res.model as CliProviderId), system, prompt);
      return;
    case "mock":
      yield* streamMock(res.model, system, prompt);
      return;
  }
}

/**
 * Stream a turn THROUGH an installed AI CLI (Claude Code / Gemini / OpenCode /
 * Kilo Code) acting as the active provider. The skill/system prompt is folded
 * into ONE combined prompt (CLIs take a single prompt string), then the bridge's
 * `ask` capability is run via `runCliAsk`, which spawns the CLI with its own auth
 * and streams stdout back. Honors a bounded timeout; on failure throws a clear
 * error so the caller surfaces it (never hangs).
 *
 * Bridge output arrives via a callback, so we adapt it to an async generator
 * with a small queue + a promise the consumer awaits between yields.
 */
async function* streamCli(
  cliId: CliProviderId,
  system: string,
  prompt: string,
): AsyncGenerator<string> {
  const combined = combinePrompt(system, prompt);

  // Callback → async-iterator bridge.
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let finished = false;
  let failure: string | null = null;

  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  const runPromise = runCliAsk(
    cliId,
    combined,
    (text) => {
      queue.push(text);
      wake();
    },
    CLI_PROVIDER_TIMEOUT_MS,
  ).then((r) => {
    if (!r.ok) failure = r.error ?? `${cliId} CLI failed.`;
    finished = true;
    wake();
  });

  for (;;) {
    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }
    if (finished) break;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }
  await runPromise; // ensure the run settled
  if (failure && queue.length === 0) {
    throw new Error(failure);
  }
}

/** Fold a system prompt + user prompt into a single CLI prompt string. */
function combinePrompt(system: string, prompt: string): string {
  const sys = system.trim();
  if (!sys) return prompt;
  return `${sys}\n\n---\n\n${prompt}`;
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
