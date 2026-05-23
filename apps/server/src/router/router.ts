import type { Skill } from "../types.js";

/**
 * Rule-based model routing (Layer 1). Learned/AI routing is deliberately
 * out of scope for v0.1 — see ROADMAP.md.
 *
 * Precedence: explicit `/use` override > the skill's `bestModel` >
 * category rule > "default".
 */
const CATEGORY_MODEL: Record<string, string> = {
  coding: "deepseek-coder",
  reasoning: "claude",
  ui: "gemini",
  marketing: "claude",
  writing: "claude",
};

/** Logical model names SkillOS knows about (shown by `/models`). */
export const KNOWN_MODELS = [
  "claude",
  "gpt",
  "gemini",
  "deepseek-coder",
  "default",
] as const;

export function routeModel(
  skill: Skill | null,
  override?: string | null,
): string {
  if (override) return override;
  if (skill?.bestModel) return skill.bestModel;
  if (skill) return CATEGORY_MODEL[skill.category] ?? "default";
  return "default";
}
