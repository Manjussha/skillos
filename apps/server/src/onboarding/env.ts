import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Persist a provider choice from onboarding into the repo-root `.env` (gitignored)
 * AND apply it to the live `process.env`. Because `providers/provider.ts` reads
 * `process.env` on every request, the new key takes effect immediately — no
 * server restart needed.
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

export async function applyProviderChoice(
  provider: string,
  apiKey: string,
): Promise<ProviderApplied> {
  if (provider === "openrouter" && apiKey.trim()) {
    const key = apiKey.trim();
    process.env.OPENROUTER_API_KEY = key;
    await upsertEnv({ OPENROUTER_API_KEY: key });
    return {
      applied: true,
      message:
        "OpenRouter key saved to .env and active now — no restart needed.",
    };
  }
  if (provider === "ollama") {
    const base = process.env.OLLAMA_BASE_URL || "http://localhost:11434/api";
    process.env.OLLAMA_BASE_URL = base;
    await upsertEnv({ OLLAMA_BASE_URL: base });
    return {
      applied: true,
      message: `Ollama selected (${base}). Make sure Ollama is running locally.`,
    };
  }
  return {
    applied: false,
    message:
      "No provider configured — using built-in mock responses. Re-run /onboarding to add a key anytime.",
  };
}
