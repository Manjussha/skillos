// Multi-provider verification: exercises the compiled provider registry/resolver
// directly (no server needed). Proves active-provider auto-detection, explicit
// SKILLOS_PROVIDER selection, logical→model mapping, override resolution, and
// the /provider + /models introspection helpers.
//
// Run AFTER `npm run build` (it imports apps/server/dist/...).
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = resolve(
  process.cwd(),
  "apps/server/dist/providers/provider.js",
);
const { resolveProvider, providerInfo, modelsFor, activeProvider } =
  await import(pathToFileURL(mod).href);

// Provider keys we toggle between scenarios so leftover env can't taint a case.
const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_BASE_URL",
  "SKILLOS_PROVIDER",
];

function clearEnv() {
  for (const k of PROVIDER_KEYS) delete process.env[k];
}

let pass = 0;
let fail = 0;
function check(label, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  - ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL- ${label}${detail ? ` (${detail})` : ""}`);
  }
}

console.log("=== verify-providers ===\n");

// 1) No keys → mock (offline). smoke must still stream.
clearEnv();
{
  const r = resolveProvider("claude", "best");
  console.log(`[no keys] resolveProvider("claude","best") =>`, r);
  check('no keys → kind "mock"', r.kind === "mock", r.kind);
  check("no keys → activeProvider() mock", activeProvider() === "mock");
}

// 2) Only OPENROUTER_API_KEY → openrouter (preserves prior behavior), best tier
//    maps claude → anthropic/claude-3.5-sonnet, cheap tier differs.
clearEnv();
{
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  const best = resolveProvider("claude", "best");
  const cheap = resolveProvider("claude", "cheapest");
  console.log(`[openrouter] best =>`, best, ` cheapest =>`, cheap);
  check("openrouter key → kind openrouter", best.kind === "openrouter", best.kind);
  check(
    "openrouter best → sonnet slug",
    best.model === "anthropic/claude-3.5-sonnet",
    best.model,
  );
  check(
    "openrouter cheapest → haiku slug (mode tiers honored)",
    cheap.model === "anthropic/claude-3-haiku",
    cheap.model,
  );
}

// 3) ANTHROPIC_API_KEY + SKILLOS_PROVIDER=anthropic → anthropic, a claude model.
clearEnv();
{
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.SKILLOS_PROVIDER = "anthropic";
  const r = resolveProvider("claude", "best");
  console.log(`[anthropic] resolveProvider("claude","best") =>`, r);
  check("anthropic explicit → kind anthropic", r.kind === "anthropic", r.kind);
  check(
    "anthropic → a claude-* model",
    /^claude-/.test(r.model),
    r.model,
  );
}

// 4) Override resolution: a CONCRETE model id is used as-is for the active provider.
clearEnv();
{
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.SKILLOS_PROVIDER = "anthropic";
  const r = resolveProvider("claude-3-5-haiku-latest", "best");
  console.log(`[override-concrete] =>`, r);
  check(
    "concrete model id passed through unchanged",
    r.kind === "anthropic" && r.model === "claude-3-5-haiku-latest",
    r.model,
  );
}

// 5) Explicit provider whose key is MISSING → falls back to auto-detect.
clearEnv();
{
  process.env.SKILLOS_PROVIDER = "anthropic"; // no ANTHROPIC_API_KEY
  process.env.GROQ_API_KEY = "gsk-test"; // only groq has a key
  const r = resolveProvider("default", "best");
  console.log(`[explicit-missing-key] =>`, r);
  check(
    "explicit anthropic w/o key falls back to groq (keyed)",
    r.kind === "groq",
    r.kind,
  );
}

// 6) local mode prefers Ollama when OLLAMA_BASE_URL is set, regardless of active.
clearEnv();
{
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.SKILLOS_PROVIDER = "openai";
  process.env.OLLAMA_BASE_URL = "http://localhost:11434/api";
  const r = resolveProvider("deepseek-coder", "local");
  console.log(`[local mode] =>`, r);
  check("local mode → ollama", r.kind === "ollama", r.kind);
  check("local mode → deepseek-coder model", r.model === "deepseek-coder", r.model);
}

// 7) /models lists the ACTIVE provider's real models; /provider info marks active.
clearEnv();
{
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.SKILLOS_PROVIDER = "anthropic";
  const models = modelsFor();
  console.log(`[/models active=anthropic] =>`, models);
  check(
    "modelsFor() returns active provider's models",
    Array.isArray(models) &&
      models.includes("claude-3-5-sonnet-latest") &&
      models.includes("claude-3-5-haiku-latest"),
    models.join(", "),
  );
  const info = providerInfo();
  const active = info.find((p) => p.active);
  const anth = info.find((p) => p.id === "anthropic");
  console.log(
    `[providerInfo] active=${active?.id} anthropic.hasKey=${anth?.hasKey}`,
  );
  check("providerInfo active is anthropic", active?.id === "anthropic", active?.id);
  check("providerInfo anthropic.hasKey true", anth?.hasKey === true);
  check(
    "providerInfo lists all 8 providers",
    info.length === 8,
    String(info.length),
  );
}

clearEnv();
console.log(`\n=== verify-providers: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
