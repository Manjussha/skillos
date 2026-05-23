import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROVIDER_REGISTRY, type ProviderKind } from "../providers/provider.js";

/**
 * Persist a provider choice (from onboarding or the runtime `/provider` picker)
 * into the repo-root `.env` (gitignored) AND apply it to the live `process.env`.
 * Because `providers/provider.ts` reads `process.env` on every request, the new
 * key + active provider take effect immediately — no server restart needed.
 *
 * Generalized over all providers in the registry: writes the provider's `envKey`
 * (when a key is given) plus `SKILLOS_PROVIDER=<id>` so selection is sticky.
 * Keyless providers (ollama/mock) and "skip" write no key. Idempotent (upsert).
 */

const ENV_PATH = resolve(process.cwd(), "../../.env");

/** Upsert `KEY=value` lines in the .env file, preserving everything else. */
async function upsertEnv(vars: Record<string, string>): Promise<void> {
  let content = "";
  try {
    content = await readFile(ENV_PATH, "utf8");
  } catch {
    content = "";
  }
  const lines = content.length ? content.split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  // Trim a single trailing empty line, then end with exactly one newline.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  await writeFile(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

export interface ProviderApplied {
  applied: boolean;
  message: string;
}

/**
 * Apply a provider choice. `providerId` is a registry id (openai, anthropic,
 * google, groq, deepseek, openrouter, ollama, mock) or "skip" (alias for mock).
 * For key-based providers, `apiKey` is written to that provider's env var; for
 * ollama/mock/skip no key is written.
 */
export async function applyProviderChoice(
  providerId: string,
  apiKey: string,
): Promise<ProviderApplied> {
  const id = providerId === "skip" ? "mock" : (providerId as ProviderKind);
  const def = PROVIDER_REGISTRY[id];

  // Unknown provider id — leave the environment untouched.
  if (!def) {
    return {
      applied: false,
      message: `Unknown provider "${providerId}" — no change made.`,
    };
  }

  // Ollama: keyless; ensure an endpoint and make it the active provider.
  if (id === "ollama") {
    const base = process.env.OLLAMA_BASE_URL || "http://localhost:11434/api";
    process.env.OLLAMA_BASE_URL = base;
    process.env.SKILLOS_PROVIDER = "ollama";
    await upsertEnv({ OLLAMA_BASE_URL: base, SKILLOS_PROVIDER: "ollama" });
    return {
      applied: true,
      message: `Ollama selected (${base}) and active now. Make sure Ollama is running locally.`,
    };
  }

  // Mock / skip: clear the active provider so auto-detect falls back to offline
  // mock (unless a key happens to be set, which the user can switch to).
  if (id === "mock") {
    process.env.SKILLOS_PROVIDER = "mock";
    await upsertEnv({ SKILLOS_PROVIDER: "mock" });
    return {
      applied: false,
      message:
        "Using the built-in mock provider (offline). Re-run /provider to switch to a real provider anytime.",
    };
  }

  // Key-based provider. If a key is given, write it; always set the active id.
  const envKey = def.envKey!;
  const key = apiKey.trim();
  if (key) {
    process.env[envKey] = key;
    process.env.SKILLOS_PROVIDER = id;
    await upsertEnv({ [envKey]: key, SKILLOS_PROVIDER: id });
    return {
      applied: true,
      message: `${def.label} key saved to .env and active now — no restart needed.`,
    };
  }

  // No new key: switch to this provider only if it already has one in the env.
  if (process.env[envKey]) {
    process.env.SKILLOS_PROVIDER = id;
    await upsertEnv({ SKILLOS_PROVIDER: id });
    return {
      applied: true,
      message: `Switched to ${def.label} (existing key in .env) — active now.`,
    };
  }

  // Selected a key-based provider with no key available — guide the user.
  return {
    applied: false,
    message: `${def.label} needs an API key (${envKey}). Run /provider and paste one to activate it.`,
  };
}
