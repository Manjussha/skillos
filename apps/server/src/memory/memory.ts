import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  resolveProvider,
  streamCompletion,
  type RouteMode,
} from "../providers/provider.js";
import { recentMessages } from "../storage/repo.js";

/**
 * Cross-session memory (compress on close, recall on open).
 *
 * Each user gets a small Markdown "memory" doc that survives across connections.
 * On disconnect we compress the recent conversation (merged with prior memory)
 * into an updated doc; on the next connection we load it back so SkillOS
 * "remembers" prior context. The doc is plain Markdown — hackable and readable.
 *
 * Storage mirrors db.ts / skillsDir(): a repo-root `storage/memory/` dir,
 * one `<userId>.md` per user. Override the location with SKILLOS_MEMORY_DIR.
 * It holds private conversation data, so it's gitignored.
 */

/** Hard cap on the stored memory doc so it can't grow without bound. */
const MAX_MEMORY_CHARS = 2000;

/** Resolve the memory directory (repo-root storage/memory by default). */
export function memoryDir(): string {
  return (
    process.env.SKILLOS_MEMORY_DIR ??
    resolve(process.cwd(), "../../storage/memory")
  );
}

function memoryPath(userId: string): string {
  // userId is a DB-generated id (no path separators), safe to use as a filename.
  return join(memoryDir(), `${userId}.md`);
}

/** Read the user's memory doc, or null if none exists yet. */
export async function loadMemory(userId: string): Promise<string | null> {
  try {
    const text = await readFile(memoryPath(userId), "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Write (overwrite) the user's memory doc, creating the dir if needed. */
export async function saveMemory(userId: string, text: string): Promise<void> {
  await mkdir(memoryDir(), { recursive: true });
  await writeFile(memoryPath(userId), text, "utf8");
}

export interface CompressOptions {
  userId: string;
  mode: RouteMode;
  /** Existing memory to merge into (from loadMemory), or null. */
  priorMemory: string | null;
  /** How many recent messages to fold in. */
  take?: number;
}

/**
 * Produce the NEW memory text from (priorMemory + recent messages).
 *
 * If a real provider is configured we summarize via the model; otherwise (mock)
 * we build a deterministic dated digest of recent user turns — we deliberately
 * do NOT route through the mock LLM, whose text is just a canned echo. The
 * result is always bounded to MAX_MEMORY_CHARS.
 */
export async function compressSession(opts: CompressOptions): Promise<string> {
  const messages = await recentMessages(opts.userId, opts.take ?? 30);
  const prior = (opts.priorMemory ?? "").trim();

  // Nothing new and nothing prior — leave memory untouched (empty signals skip).
  if (messages.length === 0) return prior;

  const res = resolveProvider("default", opts.mode);

  if (res.kind !== "mock") {
    try {
      return await summarizeWithModel(res, prior, messages);
    } catch {
      // Fall back to the deterministic digest if the model call fails — memory
      // is best-effort and must never break the close path.
    }
  }
  return deterministicDigest(prior, messages);
}

/** A conversation row as returned by recentMessages (newest last). */
type Row = Awaited<ReturnType<typeof recentMessages>>[number];

async function summarizeWithModel(
  res: ReturnType<typeof resolveProvider>,
  prior: string,
  messages: Row[],
): Promise<string> {
  const convo = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(0, 4000);
  const system =
    "You maintain a compact long-term memory for a user across sessions.";
  const prompt = [
    "Merge the prior memory and the new conversation into an updated memory",
    "under ~200 words: key facts, decisions, preferences, and open threads.",
    "Output only the memory, as Markdown bullet points. No preamble.",
    "",
    "PRIOR MEMORY:",
    prior || "(none)",
    "",
    "NEW CONVERSATION:",
    convo,
  ].join("\n");

  let out = "";
  for await (const chunk of streamCompletion(res, system, prompt)) out += chunk;
  const body = out.trim() || prior;
  return bound(`# SkillOS memory\n\n${body}\n`);
}

/**
 * Deterministic, model-free digest used in offline/mock mode. A dated bullet
 * list of the user's recent commands/prompts, appended under any prior memory.
 */
function deterministicDigest(prior: string, messages: Row[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const header = "# SkillOS memory";
  // Strip a leading header from prior memory so we don't duplicate it.
  const priorBody = prior
    ? prior.replace(/^#\s*SkillOS memory\s*/i, "").trim()
    : "";

  // recentMessages spans sessions, so dedup the new bullets against what's
  // already recorded in prior memory — otherwise turns pile up on every close.
  const seen = new Set(
    priorBody
      .split(/\r?\n/)
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim()),
  );

  const bullets: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = m.content.trim();
    if (!t) continue;
    const line = t.length > 120 ? t.slice(0, 117) + "…" : t;
    if (seen.has(line) || bullets[bullets.length - 1] === line) continue;
    seen.add(line);
    bullets.push(line);
  }
  const recent = bullets.slice(-12);

  // Nothing new to add — keep prior memory as-is.
  if (recent.length === 0) {
    return bound((priorBody ? `${header}\n\n${priorBody}` : header) + "\n");
  }

  const section = [
    `## Session ${date}`,
    ...recent.map((b) => `- ${b}`),
  ].join("\n");

  const doc = [header, priorBody, section]
    .filter((p) => p && p.trim())
    .join("\n\n");
  return bound(doc + "\n");
}

/** Trim the doc to the byte/char budget, keeping the most recent tail. */
function bound(text: string): string {
  if (text.length <= MAX_MEMORY_CHARS) return text;
  // Keep the header + the tail (most recent context matters most).
  const head = "# SkillOS memory\n\n…(trimmed)…\n\n";
  const tail = text.slice(text.length - (MAX_MEMORY_CHARS - head.length));
  return head + tail;
}
