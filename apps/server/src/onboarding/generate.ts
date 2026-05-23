import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillsDir } from "../skills/engine.js";
import { resolveProvider, streamCompletion } from "../providers/provider.js";
import { routeModel } from "../router/router.js";

/**
 * Auto skill generation (Layer 2).
 *
 * Given a described domain ("I run a printing business"), ask the provider to
 * propose a few SkillOS skills, validate them against a quality gate, and write
 * them as Markdown under skills/<category>/ so the existing engine loads them on
 * next startup.
 *
 * Offline-safe: when no provider key is set, the mock provider returns prose,
 * not JSON. We try to parse JSON from the model first; if that fails we fall
 * back to a deterministic template so /generate-skills always produces valid,
 * reviewable skills.
 */

export interface GeneratedSkill {
  name: string;
  description: string;
  category: string;
  bestModel: string;
  tools: string[];
  prompt: string;
}

export interface GenerateResult {
  written: { name: string; path: string }[];
  rejected: { name?: string; reason: string }[];
  source: "model" | "fallback";
}

const VALID_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const KNOWN_CATEGORIES = [
  "coding",
  "writing",
  "marketing",
  "ui",
  "reasoning",
  "business",
  "general",
];

const SYSTEM = [
  "You design SkillOS skills. A skill is a focused system prompt with metadata.",
  "Given a business/domain description, output ONLY a JSON array (no prose, no",
  "markdown fences) of 2-4 skills. Each item must have exactly these fields:",
  '  name        kebab-case, lowercase, 2-40 chars, e.g. "quotation-generator"',
  '  description  one short sentence',
  '  category     one of: coding, writing, marketing, ui, reasoning, business, general',
  '  bestModel    one of: claude, gpt, gemini, deepseek-coder, default',
  '  tools        array of strings (use [] if none)',
  '  prompt       the system prompt defining the skill behavior (2+ sentences)',
  "Output valid JSON only.",
].join("\n");

/** Generate, validate, and write skills for a domain description. */
export async function generateSkills(
  description: string,
): Promise<GenerateResult> {
  const desc = description.trim();
  if (!desc) {
    return { written: [], rejected: [{ reason: "empty description" }], source: "fallback" };
  }

  const model = routeModel(null, null);
  const res = resolveProvider(model);

  let raw = "";
  try {
    for await (const chunk of streamCompletion(res, SYSTEM, desc)) raw += chunk;
  } catch {
    raw = "";
  }

  let candidates = parseSkillJson(raw);
  let source: "model" | "fallback" = "model";
  if (candidates.length === 0) {
    candidates = fallbackSkills(desc);
    source = "fallback";
  }

  const dir = skillsDir();
  const written: { name: string; path: string }[] = [];
  const rejected: { name?: string; reason: string }[] = [];

  for (const c of candidates) {
    const gate = validateSkill(c);
    if (!gate.ok) {
      const candidateName =
        c && typeof c === "object" && "name" in c
          ? String((c as { name?: unknown }).name ?? "")
          : undefined;
      rejected.push({ name: candidateName, reason: gate.reason });
      continue;
    }
    const skill = gate.skill;
    const categoryDir = join(dir, skill.category);
    await mkdir(categoryDir, { recursive: true });
    const path = join(categoryDir, `${skill.name}.md`);
    await writeFile(path, toMarkdown(skill), "utf8");
    written.push({ name: skill.name, path });
  }

  return { written, rejected, source };
}

/** Quality gate: required fields, valid name/category, non-trivial prompt. */
export function validateSkill(
  c: unknown,
): { ok: true; skill: GeneratedSkill } | { ok: false; reason: string } {
  if (!c || typeof c !== "object") return { ok: false, reason: "not an object" };
  const o = c as Record<string, unknown>;
  const name = String(o.name ?? "").trim().toLowerCase();
  if (!VALID_NAME.test(name)) {
    return { ok: false, reason: `invalid name "${o.name ?? ""}"` };
  }
  const description = String(o.description ?? "").trim();
  if (description.length < 5) return { ok: false, reason: "description too short" };
  const category = String(o.category ?? "general").trim().toLowerCase();
  if (!KNOWN_CATEGORIES.includes(category)) {
    return { ok: false, reason: `unknown category "${category}"` };
  }
  const prompt = String(o.prompt ?? "").trim();
  if (prompt.length < 30) return { ok: false, reason: "prompt too short" };
  const bestModel = String(o.bestModel ?? "").trim().toLowerCase();
  const tools = Array.isArray(o.tools) ? o.tools.map(String) : [];
  return {
    ok: true,
    skill: { name, description, category, bestModel, tools, prompt },
  };
}

/** Pull a JSON array of skills out of model output (tolerates code fences). */
function parseSkillJson(raw: string): unknown[] {
  if (!raw.trim()) return [];
  // Strip markdown fences if present.
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Serialize a validated skill to Markdown with YAML frontmatter. */
function toMarkdown(s: GeneratedSkill): string {
  const tools = `[${s.tools.map((t) => JSON.stringify(t)).join(", ")}]`;
  return [
    "---",
    `name: ${s.name}`,
    `description: ${s.description}`,
    `category: ${s.category}`,
    `bestModel: ${s.bestModel}`,
    `tools: ${tools}`,
    "generated: true",
    "---",
    "",
    s.prompt,
    "",
  ].join("\n");
}

/**
 * Deterministic fallback used when the provider can't return JSON (e.g. the
 * offline mock). Produces a generic but valid skill set for the described
 * domain so the feature is demoable without keys.
 */
function fallbackSkills(description: string): GeneratedSkill[] {
  const domain = description.replace(/^i\s+(run|own|have|am)\s+(a|an|the)?\s*/i, "").trim() || description;
  const slug = slugify(domain) || "domain";
  return [
    {
      name: `${slug}-quotation`.slice(0, 40),
      description: `Generate price quotations for a ${domain}.`,
      category: "business",
      bestModel: "claude",
      tools: [],
      prompt: `You generate clear, itemized price quotations for a ${domain}. Ask for the items/services and quantities if missing, then produce a professional quote with line items, subtotals, taxes if relevant, and a total. Keep it concise and client-ready.`,
    },
    {
      name: `${slug}-copy`.slice(0, 40),
      description: `Write marketing copy for a ${domain}.`,
      category: "marketing",
      bestModel: "claude",
      tools: [],
      prompt: `You are a marketing copywriter for a ${domain}. Given a product, promotion, or audience, write punchy, persuasive copy (headline + body + call to action). Match the tone to the audience and keep claims credible.`,
    },
    {
      name: `${slug}-faq`.slice(0, 40),
      description: `Answer common customer questions for a ${domain}.`,
      category: "writing",
      bestModel: "claude",
      tools: [],
      prompt: `You are a helpful customer-support writer for a ${domain}. Given a question or topic, produce a clear, friendly FAQ-style answer. Be accurate, anticipate follow-ups, and avoid jargon.`,
    },
  ];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 2)
    .join("-");
}
