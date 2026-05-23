import type { Skill } from "../types.js";
import type { ProfileInput } from "../storage/repo.js";

/**
 * Server-driven onboarding flow (Layer 2).
 *
 * A small state machine that walks a fresh connection through three questions —
 * use-case → stack → mode — over the existing WebSocket protocol, then yields a
 * ProfileInput to persist. The gateway owns I/O; this module owns the logic, so
 * it's testable and protocol-agnostic.
 */

export type OnboardingStep =
  | "useCase"
  | "stack"
  | "mode"
  | "provider"
  | "apiKey"
  | "done";

export interface OnboardingState {
  step: OnboardingStep;
  /** Free-text business/use-case description (drives skill generation). */
  useCase: string;
  /** Primary category derived from the use-case answer. */
  userType: string;
  stacks: string[];
  mode: string;
  /** Chosen AI provider: "openrouter" | "ollama" | "skip". */
  provider: string;
  /** API key captured for a key-based provider (persisted to .env, not the DB). */
  apiKey: string;
}

/** Use-case options offered in step 1 (label -> primary category). */
export const USE_CASES: { key: string; label: string; category: string }[] = [
  { key: "1", label: "Coding", category: "coding" },
  { key: "2", label: "Writing", category: "writing" },
  { key: "3", label: "SEO", category: "marketing" },
  { key: "4", label: "Marketing", category: "marketing" },
  { key: "5", label: "Design", category: "ui" },
  { key: "6", label: "Research", category: "reasoning" },
  { key: "7", label: "Business", category: "business" },
];

export const STACKS = [
  "react",
  "node",
  "python",
  "php",
  "flutter",
] as const;

export const MODES: { key: string; label: string; value: string }[] = [
  { key: "1", label: "Fast", value: "fast" },
  { key: "2", label: "Best quality", value: "best" },
  { key: "3", label: "Cheapest", value: "cheapest" },
  { key: "4", label: "Local / private AI", value: "local" },
];

export const PROVIDERS: { key: string; label: string; value: string }[] = [
  { key: "1", label: "OpenRouter — paste an API key (many models, one key)", value: "openrouter" },
  { key: "2", label: "Ollama — local models, no key (must be running)", value: "ollama" },
  { key: "3", label: "Skip for now — demo with built-in mock responses", value: "skip" },
];

export function newOnboarding(): OnboardingState {
  return {
    step: "useCase",
    useCase: "",
    userType: "",
    stacks: [],
    mode: "best",
    provider: "skip",
    apiKey: "",
  };
}

/** The prompt text to show for the current step. */
export function promptFor(step: OnboardingStep): string {
  switch (step) {
    case "useCase":
      return [
        "Let's personalize SkillOS. (Type /onboarding any time to restart.)",
        "",
        "1) What will you use SkillOS for? Pick a number, or describe your",
        "   business in your own words (e.g. \"I run a printing business\").",
        ...USE_CASES.map((u) => `   ${u.key}. ${u.label}`),
      ].join("\n");
    case "stack":
      return [
        "2) Preferred stack? Comma-separated, or 'skip'.",
        `   Options: ${STACKS.join(", ")}`,
      ].join("\n");
    case "mode":
      return [
        "3) Preferred mode? Pick a number.",
        ...MODES.map((m) => `   ${m.key}. ${m.label}`),
      ].join("\n");
    case "provider":
      return [
        "4) Which AI provider should SkillOS use? Pick a number.",
        ...PROVIDERS.map((p) => `   ${p.key}. ${p.label}`),
      ].join("\n");
    case "apiKey":
      return [
        "5) Paste your OpenRouter API key, or type 'skip' to decide later.",
        "   (Stored locally in .env, which is gitignored. Heads-up: what you",
        "    type is visible in the terminal.)",
      ].join("\n");
    case "done":
      return "Onboarding complete.";
  }
}

/**
 * Apply a user's answer to the current step and advance. Returns the updated
 * state; when `state.step === "done"` the flow is finished.
 */
export function applyAnswer(
  state: OnboardingState,
  answer: string,
): OnboardingState {
  const text = answer.trim();
  switch (state.step) {
    case "useCase": {
      const byKey = USE_CASES.find((u) => u.key === text);
      const byLabel = USE_CASES.find(
        (u) => u.label.toLowerCase() === text.toLowerCase(),
      );
      const picked = byKey ?? byLabel;
      if (picked) {
        return {
          ...state,
          useCase: picked.label,
          userType: picked.category,
          step: "stack",
        };
      }
      // Free-text description: keep it, infer a coarse category.
      return {
        ...state,
        useCase: text,
        userType: inferCategory(text),
        step: "stack",
      };
    }
    case "stack": {
      const stacks =
        text.toLowerCase() === "skip" || text === ""
          ? []
          : text
              .split(/[\s,]+/)
              .map((s) => s.toLowerCase())
              .filter((s) => (STACKS as readonly string[]).includes(s));
      return { ...state, stacks, step: "mode" };
    }
    case "mode": {
      const byKey = MODES.find((m) => m.key === text);
      const byVal = MODES.find(
        (m) => m.value === text.toLowerCase() || m.label.toLowerCase() === text.toLowerCase(),
      );
      const mode = (byKey ?? byVal)?.value ?? "best";
      return { ...state, mode, step: "provider" };
    }
    case "provider": {
      const byKey = PROVIDERS.find((p) => p.key === text);
      const byVal = PROVIDERS.find((p) => p.value === text.toLowerCase());
      const provider = (byKey ?? byVal)?.value ?? "skip";
      // Only OpenRouter needs a key; others finish the flow here.
      const next = provider === "openrouter" ? "apiKey" : "done";
      return { ...state, provider, step: next };
    }
    case "apiKey": {
      const apiKey = text.toLowerCase() === "skip" ? "" : text;
      return { ...state, apiKey, step: "done" };
    }
    case "done":
      return state;
  }
}

/** Convert a finished onboarding state into a persistable profile input. */
export function toProfileInput(
  state: OnboardingState,
  activeSkills: string[],
): ProfileInput {
  return {
    userType: state.userType || "general",
    useCase: state.useCase,
    stacks: state.stacks,
    mode: state.mode,
    activeSkills,
  };
}

/** Coarse keyword → category inference for free-text use-case answers. */
function inferCategory(text: string): string {
  const t = text.toLowerCase();
  if (/(code|coding|develop|software|app|api|programming)/.test(t)) return "coding";
  if (/(seo|market|ads|campaign|brand|copy)/.test(t)) return "marketing";
  if (/(write|writing|blog|content|article|author)/.test(t)) return "writing";
  if (/(design|ui|ux|graphic|logo|banner)/.test(t)) return "ui";
  if (/(research|analy|study|paper)/.test(t)) return "reasoning";
  // "printing business", "shop", "store", etc. -> business
  return "business";
}

/**
 * Auto skill loading: pick which already-loaded skills are "active" for this
 * profile, based on use-case category and stack. Falls back to category match.
 */
export function selectActiveSkills(
  profile: { userType: string; stacks: string[] },
  available: Map<string, Skill>,
): string[] {
  const active = new Set<string>();
  const wantCategories = new Set<string>([profile.userType]);

  // Stack-driven category expansion (e.g. react/node imply coding skills).
  for (const stack of profile.stacks) {
    if (["react", "node", "python", "php", "flutter"].includes(stack)) {
      wantCategories.add("coding");
    }
  }

  for (const skill of available.values()) {
    if (wantCategories.has(skill.category)) active.add(skill.name);
  }
  return [...active];
}
