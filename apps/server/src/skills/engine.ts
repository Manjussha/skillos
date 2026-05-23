import { readdir, readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import matter from "gray-matter";
import type { Skill } from "../types.js";

/**
 * Resolve the top-level `skills/` directory. Override with SKILLS_DIR.
 * Defaults to <repo-root>/skills (the server runs from apps/server).
 */
export function skillsDir(): string {
  return process.env.SKILLS_DIR ?? resolve(process.cwd(), "../../skills");
}

/** Load every Markdown/JSON skill under `dir`, keyed by skill name. */
export async function loadSkills(dir: string): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  await walk(dir, skills);
  return skills;
}

async function walk(dir: string, out: Map<string, Skill>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory missing — no skills yet
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    const ext = extname(entry.name).toLowerCase();
    const skill =
      ext === ".md"
        ? await parseMarkdown(full)
        : ext === ".json"
          ? await parseJson(full)
          : null;
    if (skill) out.set(skill.name, skill);
  }
}

async function parseMarkdown(path: string): Promise<Skill | null> {
  const { data, content } = matter(await readFile(path, "utf8"));
  if (!data.name) return null;
  return normalize({ ...data, prompt: content.trim() }, path, "md");
}

async function parseJson(path: string): Promise<Skill | null> {
  const data = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (!data.name) return null;
  return normalize(data, path, "json");
}

function normalize(
  data: Record<string, unknown>,
  source: string,
  format: "md" | "json",
): Skill {
  return {
    name: String(data.name),
    description: String(data.description ?? ""),
    category: String(data.category ?? "general"),
    bestModel: String(data.bestModel ?? ""),
    tools: Array.isArray(data.tools) ? data.tools.map(String) : [],
    prompt: String(data.prompt ?? ""),
    source,
    format,
  };
}
