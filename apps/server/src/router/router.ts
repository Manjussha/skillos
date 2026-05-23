import type { Skill } from "../types.js";

/**
 * Rule-based model routing (Layer 1) + per-task routing overlay (Feature A).
 * Learned/AI routing is deliberately out of scope for v0.1 — see ROADMAP.md.
 *
 * Base precedence: explicit `/use` override > the skill's `bestModel` >
 * category rule > "default".
 *
 * Per-task routing (Feature A) layers user-pinned ROUTES on top: the user can
 * pin a SELECTOR (a category, a skill name, or "default") to a TARGET. A target
 * is either a logical model name (resolved by the active provider as before) or
 * a cross-provider PIN "<provider>:<model>" (e.g. anthropic:claude-3-5-sonnet,
 * cli:gemini) that forces THAT provider+model for the turn, regardless of the
 * globally-active provider. This is what lets each capability use its best
 * backend ("use all capabilities").
 */
const CATEGORY_MODEL: Record<string, string> = {
  coding: "deepseek-coder",
  reasoning: "claude",
  ui: "gemini",
  marketing: "claude",
  writing: "claude",
};

/** The routing categories a selector can name (mirrors CATEGORY_MODEL + business). */
export const ROUTE_CATEGORIES = [
  "coding",
  "writing",
  "marketing",
  "ui",
  "reasoning",
  "business",
] as const;

/** Logical model names SkillOS knows about (shown by `/models`). */
export const KNOWN_MODELS = [
  "claude",
  "gpt",
  "gemini",
  "deepseek-coder",
  "default",
] as const;

/** The live category → logical-model defaults (for `/route` to display). */
export function categoryDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of ROUTE_CATEGORIES) out[c] = CATEGORY_MODEL[c] ?? "default";
  return out;
}

/**
 * Base rule-based routing (unchanged signature so all existing callers keep
 * working). Yields a *logical* model name.
 */
export function routeModel(
  skill: Skill | null,
  override?: string | null,
): string {
  if (override) return override;
  if (skill?.bestModel) return skill.bestModel;
  if (skill) return CATEGORY_MODEL[skill.category] ?? "default";
  return "default";
}

/** A resolved route target, split into the logical model + an optional pin. */
export interface RouteTarget {
  /** Logical-or-concrete model name to pass to resolveProvider. */
  model: string;
  /**
   * Cross-provider pin, when the target was "<provider>:<model>". Forces a
   * specific backend for the turn (CLI pins use provider "cli"). Null otherwise.
   */
  pin: ProviderPin | null;
  /** Where this came from, for the `→ skill` info line / debugging. */
  source: "override" | "route:skill" | "route:category" | "bestModel" | "category" | "default";
}

/** A forced provider+model for a single turn (parsed from a "<provider>:<model>" target). */
export interface ProviderPin {
  provider: string;
  model: string;
  /** The raw "<provider>:<model>" string. */
  raw: string;
}

/**
 * Parse a route TARGET string into either a logical model (pin === null) or a
 * cross-provider pin. A pin looks like "<provider>:<model>", e.g.
 * "anthropic:claude-3-5-sonnet-latest", "openrouter:deepseek/deepseek-chat", or
 * a CLI pin "cli:gemini". Logical names (claude/gpt/gemini/deepseek-coder/
 * default) and anything without a ':' are NOT pins. ("auto"/"clear" never reach
 * here — they remove a route at set time.)
 */
export function parseRouteTarget(target: string): {
  model: string;
  pin: ProviderPin | null;
} {
  const t = target.trim();
  const idx = t.indexOf(":");
  if (idx > 0) {
    const provider = t.slice(0, idx).trim().toLowerCase();
    const model = t.slice(idx + 1).trim();
    if (provider && model) {
      return { model, pin: { provider, model, raw: t } };
    }
  }
  return { model: t, pin: null };
}

/**
 * Per-task routing resolution (Feature A). Computes the effective target for a
 * turn given the user's persisted routes, with precedence:
 *   `/use` override
 *   → route for the skill NAME
 *   → route for the skill's CATEGORY
 *   → skill.bestModel
 *   → category rule
 *   → "default".
 * Returns the logical/concrete model plus an optional cross-provider pin.
 *
 * `routes` is the user's { selector: target } map (from getRoutes). An empty map
 * reproduces exactly the base routeModel() behavior (no pins).
 */
export function resolveRoute(
  skill: Skill | null,
  override: string | null | undefined,
  routes: Record<string, string>,
): RouteTarget {
  // 1) Explicit /use override always wins (may itself be a pin or logical).
  if (override) {
    const { model, pin } = parseRouteTarget(override);
    return { model, pin, source: "override" };
  }
  // 2) Route pinned to the skill name.
  if (skill) {
    const bySkill = routes[skill.name];
    if (bySkill) {
      const { model, pin } = parseRouteTarget(bySkill);
      return { model, pin, source: "route:skill" };
    }
    // 3) Route pinned to the skill's category.
    const byCat = routes[skill.category];
    if (byCat) {
      const { model, pin } = parseRouteTarget(byCat);
      return { model, pin, source: "route:category" };
    }
  } else {
    // 2b) No skill → a "default" route still applies to free-text turns.
    const byDefault = routes["default"];
    if (byDefault) {
      const { model, pin } = parseRouteTarget(byDefault);
      return { model, pin, source: "route:category" };
    }
  }
  // 4) The skill's own bestModel.
  if (skill?.bestModel) {
    return { model: skill.bestModel, pin: null, source: "bestModel" };
  }
  // 5) Category rule.
  if (skill) {
    return {
      model: CATEGORY_MODEL[skill.category] ?? "default",
      pin: null,
      source: "category",
    };
  }
  // 6) Default.
  return { model: "default", pin: null, source: "default" };
}
